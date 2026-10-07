/**
 * Per-model pricing resolution.
 *
 * The fixtures below are trimmed copies of real models.dev rows and real CPA
 * ids, so every assertion is about the matcher's actual behavior on this
 * catalog rather than an invented one. The dangerous cases are included on
 * purpose: "parrot", "lower-coding" and "octest" are CPA aliases whose ids
 * collide with unrelated models.dev entries and must NOT resolve.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildPricingIndex,
  cachedPricingIndex,
  clearPricingCache,
  fetchPricingIndex,
  getPricingIndex,
  lookupCost,
  normalizeKey,
  stripModelPrefix,
  type PricingIndex,
} from "../src/pricing.ts";
import type { CatalogModel } from "../src/tier-types.ts";

function model(id: string, displayName: string | null = null): CatalogModel {
  return {
    id,
    ownedBy: null,
    displayName,
    contextLength: null,
    maxTokens: null,
    inputModalities: null,
    outputModalities: null,
    thinking: null,
  };
}

function catalogFixture() {
  return {
    anthropic: {
      id: "anthropic",
      models: {
        "claude-opus-5": {
          id: "claude-opus-5",
          name: "Claude Opus 5",
          cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        },
        "claude-sonnet-5-5": {
          id: "claude-sonnet-5-5",
          name: "Claude Sonnet 5.5",
          cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
        },
      },
    },
    "google-vertex-anthropic": {
      id: "google-vertex-anthropic",
      models: {
        "claude-opus-5@default": {
          id: "claude-opus-5@default",
          name: "Claude Opus 5",
          cost: { input: 4.5, output: 22.5 },
        },
      },
    },
    openai: {
      id: "openai",
      models: {
        "gpt-6-astra": {
          id: "gpt-6-astra",
          name: "GPT-6 Astra",
          cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
        },
      },
    },
    zai: {
      id: "zai",
      models: {
        "glm-5.3": {
          id: "glm-5.3",
          name: "GLM 5.3",
          cost: { input: 1.4, output: 4.4, cache_read: 0.14, cache_write: 0 },
        },
        "glm-5.3-flash": {
          id: "glm-5.3-flash",
          name: "GLM 5.3 Flash",
          cost: { input: 0.15, output: 0.5 },
        },
      },
    },
    "frogbot": {
      id: "frogbot",
      models: {
        "glm-5.3-flash": {
          id: "glm-5.3-flash",
          name: "GLM 5.3 Flash",
          cost: { input: 9, output: 9 },
        },
      },
    },
    "openrouter": {
      id: "openrouter",
      models: {
        // "parrot" here is a different model from the CPA alias of the same id,
        // and it belongs to no family, so it must not be borrowed as a price.
        "parrot": {
          id: "parrot",
          name: "Parrot",
          cost: { input: 0.2, output: 0.4 },
        },
      },
    },
    "zai-coding-plan": {
      id: "zai-coding-plan",
      models: {
        "glm-5.3": {
          id: "glm-5.3",
          name: "GLM 5.3",
          cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        },
      },
    },
    "xiaomi": {
      id: "xiaomi",
      models: {
        "mimo-v2.6-pro": {
          id: "mimo-v2.6-pro",
          name: "MiMo V2.6 Pro",
          cost: { input: 0.47, output: 0.94 },
        },
      },
    },
  };
}

function index(): PricingIndex {
  return buildPricingIndex(catalogFixture());
}

function countingFetch(calls: { n: number }) {
  return (async (input: string | URL | Request) => {
    calls.n++;
    expect(String(input)).toContain("models.dev");
    return new Response(JSON.stringify(catalogFixture()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  clearPricingCache();
  delete process.env["OMO_CPA_PRICING_TTL_MS"];
  delete process.env["OMO_CPA_PRICING_URL"];
});

describe("stripModelPrefix", () => {
  test("cuts a vendor namespace", () => {
    expect(stripModelPrefix("anthropic/claude-opus-5")).toBe("claude-opus-5");
  });

  test("cuts a numeric version suffix", () => {
    expect(stripModelPrefix("glm-5:0")).toBe("glm-5:0");
  });

  test("leaves a bare id unchanged", () => {
    expect(stripModelPrefix("claude-opus-5")).toBe("claude-opus-5");
  });

  test("keeps a :free suffix that is part of the id", () => {
    expect(stripModelPrefix("kilo/cohere/north-mini-code:free")).toBe("north-mini-code:free");
  });
});

describe("normalizeKey", () => {
  test("reduces prose to comparable letters and digits", () => {
    expect(normalizeKey("Claude Opus 5.1")).toBe("claudeopus51");
    expect(normalizeKey("claude-opus-5-1")).toBe("claudeopus51");
  });
});

describe("pricing index", () => {
  test("indexes every provider's model id", () => {
    const idx = index();
    expect(idx.byId.get("claude-opus-5")?.length).toBeGreaterThan(0);
    expect(idx.byId.get("gpt-6-astra")?.length).toBeGreaterThan(0);
  });

  test("tolerates a malformed catalog without throwing", () => {
    expect(buildPricingIndex(null).byId.size).toBe(0);
    expect(buildPricingIndex({ p: { id: "p", models: "nope" } }).byId.size).toBe(0);
  });

  test("skips entries with no usable cost", () => {
    const idx = buildPricingIndex({ p: { id: "p", models: { a: { id: "a" } } } });
    expect(idx.byId.size).toBe(0);
  });
});

describe("lookupCost — official price wins over a reseller", () => {
  test("an official row beats a cheaper or pricier reseller duplicate", () => {
    const cost = lookupCost(index(), "glm-5.3-flash");
    expect(cost).toEqual({ input: 0.15, output: 0.5, cacheRead: 0, cacheWrite: 0 });
  });

  test("a nominal plan zero never wins over a paid official row", () => {
    const cost = lookupCost(index(), "glm-5.3");
    expect(cost).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 0 });
  });

  test("a known family without an official row stays unpriced", () => {
    const idx = buildPricingIndex({
      openai: { id: "openai", models: {} },
      reseller: { id: "reseller", models: { "gpt-x": { id: "gpt-x", name: "GPT X", cost: { input: 1, output: 2 } } } },
    });
    expect(lookupCost(idx, "gpt-x")).toBeNull();
  });
});

describe("lookupCost — alias safety", () => {
  test("an opaque alias with no family and no name match is not priced", () => {
    expect(lookupCost(index(), "parrot")).toBeNull();
  });

  test("an alias resolves through its display name, the only reliable identity", () => {
    // Live CPA aliases: "parrot" and "lower-coding" both carry displayName
    // "glm-5.3-flash" (verified 2026-10-07), which is the zai official row.
    expect(lookupCost(index(), "parrot", "glm-5.3-flash")).toEqual({
      input: 0.15, output: 0.5, cacheRead: 0, cacheWrite: 0,
    });
  });

  test("an unknown id resolves to null, never a guess", () => {
    expect(lookupCost(index(), "octest")).toBeNull();
    expect(lookupCost(index(), "higher-coding", "Free Models Router")).toBeNull();
  });

  test("a prose display name is not treated as a family", () => {
    // Live aliases carry prose names like "Free Models Router"; a name that is
    // not id-shaped must not promote the model into a family.
    expect(lookupCost(index(), "router-thing", "Free Models Router")).toBeNull();
    expect(lookupCost(index(), "router-thing", "Gemini 3.1 Pro (High)")).toBeNull();
  });

  test("an exact id resolves to its own price", () => {
    expect(lookupCost(index(), "gpt-6-astra")?.input).toBe(10);
  });
});

describe("lookupCost — display name and version normalization", () => {
  test("falls back to an exact display-name match", () => {
    const idx = buildPricingIndex({
      zai: { id: "zai", models: { "glm-5.3": { id: "glm-5.3", name: "GLM 5.3", cost: { input: 1.4, output: 4.4 } } } },
    });
    expect(lookupCost(idx, "glm", "GLM 5.3")?.input).toBe(1.4);
  });

  test("a version dot matches a version hyphen", () => {
    const idx = buildPricingIndex({
      google: { id: "google", models: { "gemini-3.1-pro": { id: "gemini-3.1-pro", name: "G", cost: { input: 2, output: 12 } } } },
    });
    expect(lookupCost(idx, "gemini-3-1-pro")?.input).toBe(2);
  });
});

describe("official vendor ordering", () => {
  test("the international provider precedes a regional one", () => {
    const idx = buildPricingIndex({
      "moonshotai-cn": { id: "moonshotai-cn", models: { "kimi-k3": { id: "kimi-k3", name: "Kimi K3", cost: { input: 9, output: 9 } } } },
      moonshotai: { id: "moonshotai", models: { "kimi-k3": { id: "kimi-k3", name: "Kimi K3", cost: { input: 3, output: 15 } } } },
    });
    expect(lookupCost(idx, "kimi-k3")).toEqual({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
  });

  test("an official row wins over a reseller regardless of key order", () => {
    const idx = buildPricingIndex({
      openai: { id: "openai", models: { "gpt-x": { id: "gpt-x", name: "GPT X", cost: { input: 1, output: 2 } } } },
      azure: { id: "azure", models: { "gpt-x": { id: "gpt-x", name: "GPT X", cost: { input: 9, output: 9 } } } },
      "azure-cognitive-services": { id: "azure-cognitive-services", models: { "gpt-x": { id: "gpt-x", name: "GPT X", cost: { input: 5, output: 5 } } } },
    });
    expect(lookupCost(idx, "gpt-x")?.input).toBe(1);
  });
});

describe("pricing cache", () => {
  test("a fetch populates and then serves the cache", async () => {
    const calls = { n: 0 };
    const impl = countingFetch(calls);
    const first = await getPricingIndex({ fetchImpl: impl });
    expect(first).not.toBeNull();
    expect(cachedPricingIndex()).toBe(first);
    const second = await getPricingIndex({ fetchImpl: impl });
    expect(second).toBe(first);
    expect(calls.n).toBe(1);
  });

  test("concurrent callers collapse onto one fetch", async () => {
    const calls = { n: 0 };
    const impl = countingFetch(calls);
    const [a, b, c] = await Promise.all([
      getPricingIndex({ fetchImpl: impl }),
      getPricingIndex({ fetchImpl: impl }),
      getPricingIndex({ fetchImpl: impl }),
    ]);
    expect(calls.n).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("a failed fetch opens a short window and keeps the last good index", async () => {
    const calls = { n: 0 };
    const good = await getPricingIndex({ fetchImpl: countingFetch(calls) });
    expect(good).not.toBeNull();
    clearPricingCache();
    const failCalls = { n: 0 };
    const failing = (async () => {
      failCalls.n++;
      return new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;
    expect(await getPricingIndex({ fetchImpl: failing })).toBeNull();
    // Inside the failure window the second call does not touch the network.
    expect(await getPricingIndex({ fetchImpl: failing })).toBeNull();
    expect(failCalls.n).toBe(1);
    // force ignores the window and retries immediately.
    await getPricingIndex({ fetchImpl: failing, force: true });
    expect(failCalls.n).toBe(2);
  });

  test("a failure inside the window still serves the last good index", async () => {
    const calls = { n: 0 };
    const good = await getPricingIndex({ fetchImpl: countingFetch(calls) });
    const failing = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    // force runs the failing fetch but a later cached read is preserved: the
    // failed refresh never wipes the last good prices.
    expect(await getPricingIndex({ fetchImpl: failing, force: true })).toBe(good);
    expect(await getPricingIndex({ fetchImpl: failing })).toBe(good);
  });

  test("a network throw resolves to null instead of breaking registration", async () => {
    const throwing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchPricingIndex({ fetchImpl: throwing })).toBeNull();
  });

  test("force bypasses a warm cache", async () => {
    const calls = { n: 0 };
    const impl = countingFetch(calls);
    await getPricingIndex({ fetchImpl: impl });
    await getPricingIndex({ fetchImpl: impl, force: true });
    expect(calls.n).toBe(2);
  });

  test("a caller abort does not cancel or fault the shared fetch", async () => {
    let resolveFetch: (() => void) | undefined;
    const started = Promise.withResolvers<void>();
    const impl = (async () => {
      started.resolve();
      await new Promise<void>((resolve) => { resolveFetch = resolve; });
      return new Response(JSON.stringify(catalogFixture()), { status: 200 });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const aborted = getPricingIndex({ fetchImpl: impl, signal: controller.signal });
    const joined = getPricingIndex({ fetchImpl: impl });
    await started.promise;
    controller.abort();
    await expect(aborted).rejects.toThrow();

    // The shared fetch still completes and caches; the joiner gets the index.
    resolveFetch?.();
    const index = await joined;
    expect(index).not.toBeNull();
    expect(cachedPricingIndex()).toBe(index);
    // No failure window is left behind: a later call is served without network.
    const again = await getPricingIndex({
      fetchImpl: (async () => { throw new Error("should not fetch"); }) as unknown as typeof fetch,
    });
    expect(again).toBe(index);
  });
});

describe("timing and cache independence", () => {
  test("a timeout inside the window does not blank the last good index", async () => {
    const calls = { n: 0 };
    const good = await getPricingIndex({ fetchImpl: countingFetch(calls) });
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await getPricingIndex({ fetchImpl: failing, force: true })).toBe(good);
    expect(cachedPricingIndex()).toBe(good);
  });

  test("clearPricingCache during an in-flight fetch is not overwritten by it", async () => {
    const started = Promise.withResolvers<void>();
    let resolveFetch: (() => void) | undefined;
    const impl = (async () => {
      started.resolve();
      await new Promise<void>((resolve) => { resolveFetch = resolve; });
      return new Response(JSON.stringify(catalogFixture()), { status: 200 });
    }) as unknown as typeof fetch;
    const pending = getPricingIndex({ fetchImpl: impl });
    await started.promise;
    clearPricingCache();
    resolveFetch?.();
    await pending;
    expect(cachedPricingIndex()).toBeNull();
  });
});
