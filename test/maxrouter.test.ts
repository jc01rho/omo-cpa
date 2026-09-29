import { describe, expect, test } from "bun:test";
import { generateFallbackChains } from "../src/chain.ts";
import { buildProviderRegistration } from "../src/provider.ts";
import { buildTierReport } from "../src/tier.ts";
import type { CatalogModel } from "../src/tier-types.ts";

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id, ownedBy: "maxrouter", displayName: id,
    contextLength: 1_000_000, maxTokens: 128_000,
    inputModalities: null, outputModalities: null, thinking: true,
    ...extra,
  };
}

describe("provider-prefixed Claude and GPT routing", () => {
  test.each([
    ["maxrouter-claude-haiku-4-5", "claude", "anthropic-messages"],
    ["maxrouter-claude-opus-5", "claude", "anthropic-messages"],
    ["maxrouter-claude-sonnet-5", "claude", "anthropic-messages"],
    ["maxrouter-gpt-5.6-terra", "gpt", "openai-responses"],
    ["maxrouter-gpt-6-astra", "gpt", "openai-responses"],
    ["maxrouter-gpt-6-luna", "gpt", "openai-responses"],
    ["maxrouter-gpt-6-sol", "gpt", "openai-responses"],
    ["another-gpt-6-astra", "gpt", "openai-responses"],
    ["vendor-claude-opus-5", "claude", "anthropic-messages"],
    ["vendor/gpt-5.6", "gpt", "openai-responses"],
  ] as const)("registers %s as a primary with its family and wire protocol", (id, family, api) => {
    // Given
    const catalog = [model(id)];
    // When
    const built = buildProviderRegistration({ catalog, contextOverrides: new Map(), overrides: {} });
    // Then
    expect(built.primaryModels.find((entry) => entry.id === id)?.api).toBe(api);
    expect(built.report.primary.find((entry) => entry.id === id)?.family).toBe(family);
    expect(built.lastModels.some((entry) => entry.id === id)).toBe(false);
  });

  test("does not promote a provider name or glued family lookalikes", () => {
    // Given
    const catalog = [model("maxrouter-new-chat"), model("not-maxrouter-new-chat"), model("vendor-mygpt-6"), model("vendor-claudelike-5")];
    // When
    const report = buildTierReport(catalog);
    // Then
    expect(report.primary).toEqual([]);
    expect(report.last.map(({ id }) => id)).toEqual(catalog.map(({ id }) => id));
  });

  test("keeps prefixed free and non-chat models out of primary", () => {
    const catalog = [model("maxrouter-gpt-6-free"), model("vendor-claude-image", { outputModalities: ["IMAGE"] })];
    const report = buildTierReport(catalog);
    expect(report.primary).toEqual([]);
    expect(report.last.map(({ id }) => id)).toEqual(["maxrouter-gpt-6-free"]);
    expect(report.chatUnfit.map(({ id }) => id)).toEqual(["vendor-claude-image"]);
  });

  test("preserves explicit demotion and excludes non-chat models", () => {
    // Given
    const catalog = [model("maxrouter-gpt-6-astra"), model("maxrouter-image", { outputModalities: ["IMAGE"] })];
    // When
    const report = buildTierReport(catalog, { "maxrouter-gpt-6-astra": "last" });
    // Then
    expect(report.primary).toEqual([]);
    expect(report.last.map(({ id }) => id)).toEqual(["maxrouter-gpt-6-astra"]);
    expect(report.chatUnfit.map(({ id }) => id)).toEqual(["maxrouter-image"]);
  });

  test("uses MaxRouter primaries before last resorts in generated chains", () => {
    // Given
    const catalog = [model("maxrouter-gpt-6-astra"), model("maxrouter-claude-opus-5"), model("cheap-chat")];
    const report = buildTierReport(catalog);
    // When
    const chains = generateFallbackChains({
      catalog, decisions: [...report.primary, ...report.last],
      providers: { primary: "cliproxyapi", last: "cliproxyapi-last" },
      targets: ["maxrouter-gpt-6-astra"],
    });
    // Then
    expect(chains).toEqual([{
      target: "cliproxyapi/maxrouter-gpt-6-astra",
      entries: ["cliproxyapi/maxrouter-claude-opus-5", "cliproxyapi-last/cheap-chat"],
    }]);
  });
});
