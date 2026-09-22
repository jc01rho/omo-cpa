import { describe, expect, test } from "bun:test";
import { validateFallbackChains } from "/home/whrho/.nvm/versions/node/v24.14.0/lib/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/core/retry-fallback/validate.js";
import {
  generateFallbackChains,
  LAST_RESORT_CHAIN_LIMIT,
  PRIMARY_CHAIN_LIMIT,
} from "../src/chain.ts";
import type { FallbackChain } from "../src/chain.ts";
import type { CatalogModel, Tier, TierDecision } from "../src/tier-types.ts";

const providers = { primary: "cpa-primary", last: "cpa-last" } as const;

function model(
  id: string,
  overrides: Partial<Omit<CatalogModel, "id">> = {},
): CatalogModel {
  return {
    id,
    ownedBy: null,
    displayName: id,
    contextLength: null,
    maxTokens: null,
    inputModalities: null,
    outputModalities: null,
    thinking: null,
    ...overrides,
  };
}

function decision(id: string, tier: Tier, family: TierDecision["family"] = null): TierDecision {
  return {
    id,
    tier,
    family: tier === "primary" ? (family ?? "gpt") : null,
    reason: `test ${tier}`,
    overridden: false,
  };
}

type ModelSpec = readonly [
  id: string,
  tier: Tier,
  overrides?: Partial<Omit<CatalogModel, "id">>,
  family?: TierDecision["family"],
];

function input(
  specs: readonly ModelSpec[],
  targets: Iterable<string>,
) {
  return {
    catalog: specs.map(([id, , overrides]) => model(id, overrides)),
    decisions: specs.map(([id, tier, , family]) => decision(id, tier, family)),
    providers,
    targets,
  };
}

function chainFor(chains: readonly FallbackChain[], id: string): FallbackChain {
  const chain = chains.find((candidate) => candidate.target.endsWith(`/${id}`));
  expect(chain).toBeDefined();
  if (!chain) throw new Error(`missing chain for ${id}`);
  return chain;
}

function settingsObject(chains: readonly FallbackChain[]): Record<string, string[]> {
  return Object.fromEntries(chains.map(({ target, entries }) => [target, entries]));
}

function registryFor(
  catalog: readonly CatalogModel[],
  decisions: readonly TierDecision[],
  providerNames = providers,
) {
  const tierById = new Map(decisions.map(({ id, tier }) => [id, tier]));
  const models = catalog.flatMap(({ id }) => {
    const tier = tierById.get(id);
    return tier ? [{ provider: providerNames[tier], id }] : [];
  });
  return {
    getAll: () => models,
    find: (provider: string, id: string) =>
      models.find((candidate) => candidate.provider === provider && candidate.id === id),
  } as Parameters<typeof validateFallbackChains>[1];
}

describe("generateFallbackChains", () => {
  test("1. every primary entry precedes every last-resort entry", () => {
    const generated = generateFallbackChains(input([
      ["gpt-target", "primary"],
      ["claude-strong", "primary"],
      ["cheap-a", "last"],
      ["cheap-b", "last"],
    ], ["gpt-target"]));

    const entries = chainFor(generated, "gpt-target").entries;
    const firstLast = entries.findIndex((entry) => entry.startsWith(`${providers.last}/`));
    expect(firstLast).toBeGreaterThan(0);
    expect(entries.slice(0, firstLast).every((entry) => entry.startsWith(`${providers.primary}/`))).toBe(true);
    expect(entries.slice(firstLast).every((entry) => entry.startsWith(`${providers.last}/`))).toBe(true);
  });

  test("2. the last-resort tail is non-empty whenever an eligible last-resort model exists", () => {
    const generated = generateFallbackChains(input([
      ["gpt-target", "primary"],
      ["cheap-only", "last"],
    ], ["gpt-target"]));

    expect(chainFor(generated, "gpt-target").entries).toContain(`${providers.last}/cheap-only`);
  });

  test("3. no chain entry self-references its target", () => {
    const generated = generateFallbackChains(input([
      ["gpt-a", "primary"],
      ["gpt-b", "primary"],
      ["cheap-a", "last"],
    ], ["gpt-a", "gpt-b", "cheap-a"]));

    for (const { target, entries } of generated) expect(entries).not.toContain(target);
  });

  test("4. duplicate catalog rows never create duplicate chain entries", () => {
    const generated = generateFallbackChains(input([
      ["gpt-target", "primary"],
      ["gpt-backup", "primary"],
      ["gpt-backup", "primary"],
      ["cheap-a", "last"],
      ["cheap-a", "last"],
    ], ["gpt-target"]));

    const entries = chainFor(generated, "gpt-target").entries;
    expect(new Set(entries).size).toBe(entries.length);
  });

  test("5. entries are provider-qualified and pass senpi's real validator with zero warnings", () => {
    const args = input([
      ["gpt-target", "primary"],
      ["claude-backup", "primary"],
      ["free-model", "last"],
    ], ["gpt-target", "claude-backup", "free-model"]);
    const generated = generateFallbackChains(args);

    for (const { entries } of generated) {
      expect(entries.every((entry) => entry.includes("/") && !entry.startsWith("/"))).toBe(true);
    }
    expect(validateFallbackChains(settingsObject(generated), registryFor(args.catalog, args.decisions))).toEqual([]);
  });

  test("6. output is deterministic and independent of input enumeration order", () => {
    const specs = [
      ["z-primary", "primary"],
      ["a-primary", "primary"],
      ["z-last", "last"],
      ["a-last", "last"],
    ] as const;
    const forward = generateFallbackChains(input(specs, ["z-primary", "a-last"]));
    const reversed = generateFallbackChains(input([...specs].reverse(), ["a-last", "z-primary"]));

    expect(reversed).toEqual(forward);
  });

  test("7. sections are capped and rank capable, large-context models before weaker models", () => {
    const primarySpecs: ModelSpec[] = Array.from({ length: PRIMARY_CHAIN_LIMIT + 4 }, (_, index) => [
      `p-${index.toString().padStart(2, "0")}`,
      "primary",
      { contextLength: 10_000 + index, maxTokens: 1_000 + index, thinking: false },
    ]);
    const lastSpecs: ModelSpec[] = Array.from({ length: LAST_RESORT_CHAIN_LIMIT + 4 }, (_, index) => [
      `l-${index.toString().padStart(2, "0")}`,
      "last",
      { contextLength: 1_000 + index, maxTokens: 100 + index, thinking: false },
    ]);
    primarySpecs.push(["p-best", "primary", { contextLength: 1_000_000, maxTokens: 100_000, thinking: true }]);
    lastSpecs.push(["l-best", "last", { contextLength: 500_000, maxTokens: 50_000, thinking: true }]);
    const generated = generateFallbackChains(input([
      ["target", "primary"],
      ...primarySpecs,
      ...lastSpecs,
    ], ["target"]));
    const entries = chainFor(generated, "target").entries;

    expect(entries).toHaveLength(PRIMARY_CHAIN_LIMIT + LAST_RESORT_CHAIN_LIMIT);
    expect(entries[0]).toBe(`${providers.primary}/p-best`);
    expect(entries[PRIMARY_CHAIN_LIMIT]).toBe(`${providers.last}/l-best`);
  });

  test("9. every present primary family appears before the first last-resort entry", () => {
    const families = ["muse", "gpt", "claude", "gemini", "glm", "deepseek", "grok"] as const;
    const specs: ModelSpec[] = [
      ["target", "primary", { contextLength: 200_000 }, "claude"],
    ];
    // The two huge families ship far more than PRIMARY_CHAIN_LIMIT models, exactly the
    // shape of the live catalog where gemini/muse monopolise a flat top-14.
    for (const family of families) {
      const huge = family === "gemini" || family === "muse";
      const count = huge ? 3 : 2;
      for (let n = 0; n < count; n++) {
        specs.push([
          `${family}-${n}`,
          "primary",
          { contextLength: huge ? 1_048_576 - n : 32_000 },
          family,
        ]);
      }
    }
    specs.push(["junk-free", "last", { contextLength: 8_000 }]);
    const generated = generateFallbackChains(input(specs, ["target"]));
    const entries = chainFor(generated, "target").entries;
    const firstLast = entries.findIndex((entry) => entry.startsWith(`${providers.last}/`));
    const primarySection = entries.slice(0, firstLast === -1 ? entries.length : firstLast);
    for (const family of families) {
      if (family === "claude") continue;
      expect(primarySection.some((entry) => entry.includes(`/${family}-`))).toBe(true);
    }
    expect(entries.at(-1)).toBe(`${providers.last}/junk-free`);
    // After one seat per family the remaining budget follows capability order, so the
    // strongest leftover (a huge-context gemini) comes before a far weaker one.
    const geminiFirst = primarySection.indexOf(`${providers.primary}/gemini-0`);
    const geminiNext = primarySection.indexOf(`${providers.primary}/gemini-1`);
    expect(geminiFirst).toBeGreaterThanOrEqual(0);
    expect(geminiNext).toBeGreaterThan(geminiFirst);
    expect(primarySection.indexOf(`${providers.primary}/gemini-1`)).toBeLessThan(
      primarySection.indexOf(`${providers.primary}/glm-1`),
    );
  });

  test("8a. zero primaries produces a tail-only chain", () => {
    const generated = generateFallbackChains(input([
      ["cheap-target", "last"],
      ["cheap-backup", "last"],
    ], ["cheap-target"]));

    expect(chainFor(generated, "cheap-target").entries).toEqual([`${providers.last}/cheap-backup`]);
  });

  test("8b. zero last-resort models produces a primary-only chain without an empty tail artifact", () => {
    const generated = generateFallbackChains(input([
      ["gpt-target", "primary"],
      ["claude-backup", "primary"],
    ], ["gpt-target"]));

    expect(chainFor(generated, "gpt-target").entries).toEqual([`${providers.primary}/claude-backup`]);
  });

  test("8c. an empty catalog produces no chains", () => {
    expect(generateFallbackChains({ catalog: [], decisions: [], providers, targets: ["missing"] })).toEqual([]);
  });

  test("8d. a single-model catalog produces an empty, non-self-referencing chain", () => {
    const args = input([["only", "primary"]], ["only"]);
    const generated = generateFallbackChains(args);

    expect(generated).toEqual([{ target: `${providers.primary}/only`, entries: [] }]);
    expect(validateFallbackChains(settingsObject(generated), registryFor(args.catalog, args.decisions))).toEqual([]);
  });
});
