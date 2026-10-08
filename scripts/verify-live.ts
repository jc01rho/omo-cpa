#!/usr/bin/env bun
/** Live CPA tier proof. Reads the existing key but never prints it. */
import { loadSenpiValidate } from "./senpi-validate.ts";
import { generateFallbackChains } from "../src/chain.ts";
import type { FallbackChain } from "../src/chain.ts";
import { fetchCatalog, selectEndpoint } from "../src/endpoint.ts";
import {
  buildProviderRegistration,
  LAST_RESORT_PROVIDER_NAME,
  PROVIDER_NAME,
  readMigrationSource,
} from "../src/provider.ts";
import {
  loadOverrideStore,
  toOverrideMap,
} from "../src/tier.ts";
import { PRIMARY_FAMILIES } from "../src/tier-types.ts";
import type { CatalogModel, TierDecision } from "../src/tier-types.ts";

const { validateFallbackChains } = await loadSenpiValidate();

function requiredRoot(): string {
  const value = process.env["OMO_CPA_BASE_URL"]?.trim();
  if (!value) throw new Error("OMO_CPA_BASE_URL is required for live verification");
  return value;
}

const ROOT = requiredRoot();

function registryFor(catalog: CatalogModel[], decisions: TierDecision[]) {
  const tiers = new Map(decisions.map(({ id, tier }) => [id, tier]));
  const models = catalog.flatMap(({ id }) => {
    const tier = tiers.get(id);
    if (!tier) return [];
    return [{ provider: tier === "primary" ? PROVIDER_NAME : LAST_RESORT_PROVIDER_NAME, id }];
  });
  return {
    getAll: () => models,
    find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
  } as Parameters<typeof validateFallbackChains>[1];
}

function chainSettings(chains: FallbackChain[]): Record<string, string[]> {
  return Object.fromEntries(chains.map(({ target, entries }) => [target, entries]));
}

async function main(): Promise<void> {
  const migration = await readMigrationSource();
  if (!migration.apiKey) throw new Error("missing cliproxyapi inference key");
  const result = await fetchCatalog(ROOT, migration.apiKey, { timeoutMs: 20_000 });
  if (!result.ok) throw new Error(result.reason);

  const store = await loadOverrideStore();
  const tiered = buildProviderRegistration({
    catalog: result.models,
    contextOverrides: migration.contextOverrides,
    overrides: toOverrideMap(store),
  });
  const report = tiered.report;
  const routable = [...report.primary, ...report.last];
  const providers = { primary: PROVIDER_NAME, last: LAST_RESORT_PROVIDER_NAME } as const;
  const targets = report.primary.map(({ id }) => id);
  const chains = generateFallbackChains({
    catalog: tiered.catalog,
    decisions: routable,
    providers,
    targets,
  });

  const distribution = { openai: 0, anthropic: 0, gemini: 0 };
  for (const model of result.models) distribution[selectEndpoint(model).endpoint]++;

  const routableIds = new Set(routable.map(({ id }) => id));
  const chatUnfitIds = new Set(report.chatUnfit.map(({ id }) => id));
  const familyById = new Map(report.primary.map(({ id, family }) => [id, family]));
  const familyModelCounts = new Map(PRIMARY_FAMILIES.map((family) => [
    family,
    report.primary.filter((decision) => decision.family === family).length,
  ]));
  const presentFamilies = new Set(report.primary.flatMap(({ family }) => family ? [family] : []));
  const familyCounts: number[] = [];
  const requiredFamilyCounts: number[] = [];
  let singletonFamilyTargets = 0;
  let chatUnfitLeaks = 0;
  let orderViolations = 0;
  let familyCoverageViolations = 0;
  let tailsPresent = 0;
  for (const chain of chains) {
    const firstLast = chain.entries.findIndex((entry) => entry.startsWith(`${LAST_RESORT_PROVIDER_NAME}/`));
    if (firstLast >= 0) tailsPresent++;
    if (firstLast >= 0 && chain.entries.slice(firstLast).some((entry) => entry.startsWith(`${PROVIDER_NAME}/`))) {
      orderViolations++;
    }
    const primaryEntries = firstLast < 0 ? chain.entries : chain.entries.slice(0, firstLast);
    const chainFamilies = new Set(primaryEntries.flatMap((entry) => {
      const family = familyById.get(entry.slice(entry.indexOf("/") + 1));
      return family ? [family] : [];
    }));
    const targetId = chain.target.slice(chain.target.indexOf("/") + 1);
    const targetFamily = familyById.get(targetId);
    const requiredFamilies = new Set(presentFamilies);
    if (targetFamily && familyModelCounts.get(targetFamily) === 1) {
      requiredFamilies.delete(targetFamily);
      singletonFamilyTargets++;
    }
    familyCounts.push(chainFamilies.size);
    requiredFamilyCounts.push(requiredFamilies.size);
    if ([...requiredFamilies].some((family) => !chainFamilies.has(family))) familyCoverageViolations++;
    for (const entry of chain.entries) {
      const id = entry.slice(entry.indexOf("/") + 1);
      if (chatUnfitIds.has(id) || !routableIds.has(id)) chatUnfitLeaks++;
    }
  }

  const warnings = validateFallbackChains(
    chainSettings(chains),
    registryFor(tiered.catalog, routable),
  );
  const sample = chains[0];
  const boundary = sample?.entries.findIndex((entry) => entry.startsWith(`${LAST_RESORT_PROVIDER_NAME}/`)) ?? -1;

  console.log("=== LIVE CPA TIER VERIFICATION ===");
  console.log(`catalog: ${result.models.length} live; synthesized aliases=${tiered.catalog.length - result.models.length}`);
  console.log(`tiers: primary=${report.primary.length} last=${report.last.length} chatUnfit=${report.chatUnfit.length}`);
  console.log(`endpoints: openai=${distribution.openai} anthropic=${distribution.anthropic} gemini=${distribution.gemini}`);
  const modalitySources = { gemini: 0, codex: 0, silent: 0 };
  for (const model of result.models) {
    if (model.inputModalities === null) modalitySources.silent++;
    else if (model.inputModalitiesSource === "codex") modalitySources.codex++;
    else modalitySources.gemini++;
  }
  const registered = [...tiered.primaryModels, ...tiered.lastModels];
  const imageCapable = registered.filter((model) => model.input.includes("image")).length;
  console.log(`input modalities: gemini=${modalitySources.gemini} codex=${modalitySources.codex} silent=${modalitySources.silent}`);
  console.log(`image-capable registered: ${imageCapable}/${registered.length}`);
  console.log(`optional endpoint failures: ${JSON.stringify(result.failures)}`);
  const minimumFamilyCount = familyCounts.length === 0 ? 0 : Math.min(...familyCounts);
  const maximumFamilyCount = familyCounts.length === 0 ? 0 : Math.max(...familyCounts);
  const minimumRequiredFamilies = requiredFamilyCounts.length === 0 ? 0 : Math.min(...requiredFamilyCounts);
  const maximumRequiredFamilies = requiredFamilyCounts.length === 0 ? 0 : Math.max(...requiredFamilyCounts);
  console.log(`primary families present=${presentFamilies.size}/${PRIMARY_FAMILIES.length} (${[...presentFamilies].sort().join(",")})`);
  console.log(`families per chain=${minimumFamilyCount}-${maximumFamilyCount}; required=${minimumRequiredFamilies}-${maximumRequiredFamilies}; singleton-family targets=${singletonFamilyTargets}; coverage violations=${familyCoverageViolations}`);
  console.log(`chains checked: ${chains.length}; chatUnfit leaks=${chatUnfitLeaks}; order violations=${orderViolations}; tails present=${tailsPresent}/${chains.length}`);
  if (sample) {
    console.log(`sample target: ${sample.target}`);
    console.log(`sample primary entries: ${JSON.stringify(boundary < 0 ? sample.entries : sample.entries.slice(0, boundary))}`);
    console.log(`sample last-resort entries: ${JSON.stringify(boundary < 0 ? [] : sample.entries.slice(boundary))}`);
  }
  console.log(`senpi validateFallbackChains warnings: ${warnings.length}`);
  for (const warning of warnings) console.log(`warning: ${warning}`);
  if (
    warnings.length > 0
    || chatUnfitLeaks > 0
    || orderViolations > 0
    || familyCoverageViolations > 0
  ) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`live verification failed: ${message}`);
  process.exit(1);
});
