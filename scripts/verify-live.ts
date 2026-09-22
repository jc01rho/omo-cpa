#!/usr/bin/env bun
/** Live CPA tier proof. Reads the existing key but never prints it. */
import { validateFallbackChains } from "/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/core/retry-fallback/validate.js";
import { generateFallbackChains } from "../src/chain.ts";
import type { FallbackChain } from "../src/chain.ts";
import { fetchCatalog, selectEndpoint } from "../src/endpoint.ts";
import {
  buildProviderRegistration,
  LAST_RESORT_PROVIDER_NAME,
  PROVIDER_NAME,
  readMigrationSource,
} from "../src/provider.ts";
import { loadOverrideStore, toOverrideMap } from "../src/tier.ts";
import type { CatalogModel, TierDecision } from "../src/tier-types.ts";

const ROOT = "http://152.69.234.237:8317";

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
  if (!migration.apiKey) throw new Error("missing local-proxy inference key");
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
  const targets = report.primary.slice(0, 3).map(({ id }) => id);
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
  let chatUnfitLeaks = 0;
  let orderViolations = 0;
  let tailsPresent = 0;
  for (const chain of chains) {
    const firstLast = chain.entries.findIndex((entry) => entry.startsWith(`${LAST_RESORT_PROVIDER_NAME}/`));
    if (firstLast >= 0) tailsPresent++;
    if (firstLast >= 0 && chain.entries.slice(firstLast).some((entry) => entry.startsWith(`${PROVIDER_NAME}/`))) {
      orderViolations++;
    }
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
  console.log(`catalog: ${result.models.length} live + ${tiered.catalog.length - result.models.length} declared aliases`);
  console.log(`tiers: primary=${report.primary.length} last=${report.last.length} chatUnfit=${report.chatUnfit.length}`);
  console.log(`endpoints: openai=${distribution.openai} anthropic=${distribution.anthropic} gemini=${distribution.gemini}`);
  console.log(`optional endpoint failures: ${JSON.stringify(result.failures)}`);
  console.log(`chains checked: ${chains.length}; chatUnfit leaks=${chatUnfitLeaks}; order violations=${orderViolations}; tails present=${tailsPresent}/${chains.length}`);
  if (sample) {
    console.log(`sample target: ${sample.target}`);
    console.log(`sample primary entries: ${JSON.stringify(boundary < 0 ? sample.entries : sample.entries.slice(0, boundary))}`);
    console.log(`sample last-resort entries: ${JSON.stringify(boundary < 0 ? [] : sample.entries.slice(boundary))}`);
  }
  console.log(`senpi validateFallbackChains warnings: ${warnings.length}`);
  for (const warning of warnings) console.log(`warning: ${warning}`);
  if (warnings.length > 0 || chatUnfitLeaks > 0 || orderViolations > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`live verification failed: ${message}`);
  process.exit(1);
});
