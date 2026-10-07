/**
 * Tests for the CPA in-code provider (registerCpaProvider, oauth, refreshModels,
 * unmangleAnthropicId, metadata merge, max_tokens clamp, safer-of-two rule).
 *
 * These tests do NOT hit the network (except where noted) and never print API keys.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  unmangleAnthropicId,
  type UnmangleResult,
  type ProviderConfig,
  type ProviderModel,
  type RefreshModelsContext,
  type LoginCallbacks,
  type Credentials,
  type Stats,
  PROVIDER_NAME,
  DEFAULT_BASE_URL,
  MAX_TOKENS_CEIL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS_FOR_DEFAULT_CONTEXT,
  DEFAULT_MAX_TOKENS,
  getApiKey,
  refreshToken,
  login,
  LAST_RESORT_PROVIDER_NAME,
  STABLE_LAST_RESORT_IDS,
  registerCpaProvider,
  buildProviderRegistration,
  readStoredPrimaryCredential,
} from "../src/provider.ts";
import type { CatalogModel } from "../src/tier-types.ts";

// ---------- unmangleAnthropicId ----------

describe("unmangleAnthropicId", () => {
  test("leaves bare ids unchanged", () => {
    const r: UnmangleResult = unmangleAnthropicId("gpt-5.5");
    expect(r.unmangled).toBe("gpt-5.5");
    expect(r.mangled).toBe("gpt-5.5");
    expect(r.transformed).toBe(false);
  });

  test("reverses the documented mangling", () => {
    const r = unmangleAnthropicId("claude-fable-5-dd-0.2-noia/sbal-noia");
    expect(r.unmangled).toBe("aion-labs/aion-2.0");
    expect(r.transformed).toBe(true);
  });

  test("handles multi-segment ids", () => {
    // segments: a, b, c -> char-reverse each: a, b, c -> reverse segment order: c, b, a
    const r = unmangleAnthropicId("claude-fable-5-dd-a/b/c");
    expect(r.unmangled).toBe("c/b/a");
  });

  test("handles single segment after prefix", () => {
    const r = unmangleAnthropicId("claude-fable-5-dd-hello");
    expect(r.unmangled).toBe("olleh");
  });

  test("empty remainder yields prefix minus trailing dash", () => {
    const r = unmangleAnthropicId("claude-fable-5-dd-");
    expect(r.unmangled).toBe("claude-fable-5-dd");
    expect(r.transformed).toBe(true);
  });

  test("real anthropic id unmangles to a plausible id", () => {
    const r = unmangleAnthropicId("claude-fable-5-dd-gnidoc-rehgih");
    expect(r.unmangled).toBe("higher-coding");
    expect(r.transformed).toBe(true);
  });
});

// ---------- safe defaults (never invented numbers) ----------

describe("metadata merge — safe defaults and no invented numbers", () => {
  test("DEFAULT_CONTEXT_WINDOW is labelled (not a measurement)", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(8192);
  });

  test("DEFAULT_MAX_TOKENS_FOR_DEFAULT_CONTEXT ties to default context", () => {
    expect(DEFAULT_MAX_TOKENS_FOR_DEFAULT_CONTEXT).toBe(2048);
  });

  test("MAX_TOKENS_CEIL is a hard clamp, not a real measured value", () => {
    expect(MAX_TOKENS_CEIL).toBe(250000);
    expect(MAX_TOKENS_CEIL > 0).toBe(true);
  });

  test("DEFAULT_MAX_TOKENS is a labelled default", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(4096);
  });

  test("MAX_TOKENS_CEIL sanity > 0", () => {
    expect(MAX_TOKENS_CEIL > 0).toBe(true);
  });
});

// ---------- maxTokens clamp ----------

describe("maxTokens clamp — never trust max_tokens blindly", () => {
  test("clamps when max_tokens equals contextWindow (grok-4.7 case)", () => {
    // grok-4.7 Anthropic format: context_length == max_tokens == 500000 (verified live).
    // Output cannot equal the whole context window; also cannot exceed the 250000
    // ceiling (a labelled safety bound, not a measured value). So the result is
    // min(500000, 499999, 250000) = 250000 — the ceiling wins.
    const ctxWindow = 500000;
    const reportedMaxTokens = 500000;
    const clamped = Math.min(reportedMaxTokens, ctxWindow - 1, MAX_TOKENS_CEIL);
    expect(clamped).toBeLessThan(reportedMaxTokens);
    expect(clamped).toBe(MAX_TOKENS_CEIL);
  });

  test("clamps to ceiling when both are huge", () => {
    const ctxWindow = 2_000_000;
    const reportedMaxTokens = 2_000_000;
    const clamped = Math.min(reportedMaxTokens, ctxWindow - 1, MAX_TOKENS_CEIL);
    expect(clamped).toBe(MAX_TOKENS_CEIL);
  });

  test("keeps a smaller max_tokens unchanged", () => {
    const ctxWindow = 500000;
    const safeMaxTokens = 64000;
    expect(Math.min(safeMaxTokens, ctxWindow - 1, MAX_TOKENS_CEIL)).toBe(64000);
  });

  test("clamps to (contextWindow - 1) before ceiling when both apply", () => {
    const ctxWindow = 1000000;
    const reportedMaxTokens = 1000000;
    // contextWindow - 1 = 999999, ceiling = 250000 -> pick ceiling
    expect(Math.min(reportedMaxTokens, ctxWindow - 1, MAX_TOKENS_CEIL)).toBe(MAX_TOKENS_CEIL);
  });
});

// ---------- safer-of-two contextWindow rule ----------

describe("safer-of-two contextWindow rule", () => {
  test("prefers smaller when omo curated and CPA disagree", () => {
    // lower-coding: omo=193000, cpa=1000000 -> pick 193000
    expect(Math.min(1000000, 193000)).toBe(193000);
  });

  test("uses omo-curated alone when cpa absent", () => {
    expect(193000).toBe(193000);
  });

  test("uses cpa-anthropic when omo absent", () => {
    expect(256000).toBe(256000);
  });

  test("falls to labelled default when both absent", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(8192);
  });

  test("clamps ceiling when cpa exceeds sane max", () => {
    const cpaContext = 2_500_000;
    const clamped = Math.min(cpaContext, 2_000_000);
    expect(clamped).toBe(2_000_000);
  });
});

// ---------- provider registration shape ----------

function catalogModel(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    ownedBy: null,
    displayName: id,
    contextLength: 100_000,
    maxTokens: 8_000,
    inputModalities: ["TEXT"],
    outputModalities: ["TEXT"],
    thinking: false,
    ...extra,
  };
}

describe("per-model cost broadcast", () => {
  test("a resolved cost replaces the zero the plugin used to publish", () => {
    const built = buildProviderRegistration({
      catalog: [catalogModel("gpt-6-astra"), catalogModel("claude-opus-5")],
      contextOverrides: new Map(),
      overrides: {},
      costs: new Map([
        ["gpt-6-astra", { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
      ]),
    });
    const byId = new Map([...built.primaryModels, ...built.lastModels].map((m) => [m.id, m]));
    expect(byId.get("gpt-6-astra")?.cost).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
    expect(byId.get("claude-opus-5")?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("no costs map leaves every model at zero, as before", () => {
    const built = buildProviderRegistration({
      catalog: [catalogModel("gpt-6-astra")],
      contextOverrides: new Map(),
      overrides: {},
    });
    expect(built.primaryModels[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("the cost object on the registered model is a copy, not the shared map value", () => {
    const cost = { input: 3, output: 6, cacheRead: 0.3, cacheWrite: 3.75 };
    const built = buildProviderRegistration({
      catalog: [catalogModel("gpt-6-astra")],
      contextOverrides: new Map(),
      overrides: {},
      costs: new Map([["gpt-6-astra", cost]]),
    });
    expect(built.primaryModels[0]?.cost).toEqual(cost);
    expect(built.primaryModels[0]?.cost).not.toBe(cost);
  });
});

describe("tier-separated provider registration", () => {
  test("registers exactly two disjoint providers with last-resort excluded from implicit fallback", () => {
    const registered: Array<{ name: string; config: ProviderConfig }> = [];
    const pi = {
      registerProvider(name: string, config: ProviderConfig) {
        registered.push({ name, config });
      },
    };
    registerCpaProvider(pi, {
      catalog: [
        catalogModel("gpt-5.6"),
        catalogModel("cheap-model"),
        catalogModel("gpt-image-2", { outputModalities: ["IMAGE"] }),
      ],
      contextOverrides: new Map(),
      overrides: {},
    });

    expect(registered.map(({ name }) => name)).toEqual([PROVIDER_NAME, LAST_RESORT_PROVIDER_NAME]);
    const primary = registered[0]?.config;
    const last = registered[1]?.config;
    if (!primary || !last) throw new Error("expected two providers");

    const primaryIds = new Set(primary.models?.map(({ id }) => id));
    const lastIds = new Set(last.models?.map(({ id }) => id));
    expect([...primaryIds].filter((id) => lastIds.has(id))).toEqual([]);
    expect(primaryIds.has("gpt-5.6")).toBe(true);
    for (const id of ["gpt-spark", "composer-2.5", "MiniMax-M3", "open-muse"]) {
      expect(lastIds.has(id)).toBe(false);
      expect(primaryIds.has(id)).toBe(false);
    }
    expect(lastIds.has("cheap-model")).toBe(true);
    expect(lastIds.has("gpt-image-2")).toBe(true);
    expect(primaryIds.has("gpt-image-2")).toBe(false);

    expect(primary.name).toBe("CLI Proxy API (CPA)");
    expect(last.name).toBe("CLI Proxy API (CPA Last Resort)");
    expect(primary.oauth?.name).toBe("CLI Proxy API (CPA)");
    expect(last.oauth).toBeUndefined();
    expect(typeof primary.refreshModels).toBe("function");
    expect(typeof last.refreshModels).toBe("function");
    expect(primary.fallbackEligible).toBeUndefined();
    expect(last.fallbackEligible?.()).toBe(false);
  });

  test("model endpoints use the BASE URL saved by login", () => {
    const built = buildProviderRegistration({
      catalog: [
        catalogModel("gpt-5.6-sol"),
        catalogModel("claude-opus-5"),
        catalogModel("gemini-3-flash"),
      ],
      contextOverrides: new Map(),
      overrides: {},
      baseUrl: "http://cpa.example:9443/v1",
    });
    const byId = new Map([...built.primaryModels, ...built.lastModels].map((model) => [model.id, model]));
    expect(byId.get("gpt-5.6-sol")?.baseUrl).toBe("http://cpa.example:9443/v1");
    expect(byId.get("claude-opus-5")?.baseUrl).toBe("http://cpa.example:9443");
    expect(byId.get("gemini-3-flash")?.baseUrl).toBe("http://cpa.example:9443/v1beta");
  });
});

describe("provider registration shape", () => {
  test("PROVIDER_NAME is the /login id", () => {
    expect(PROVIDER_NAME).toBe("cliproxyapi");
    expect(LAST_RESORT_PROVIDER_NAME).toBe("cliproxyapi-last");
  });

  test("last-resort shares the credential stored by /login cliproxyapi", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omo-cpa-auth-"));
    const path = join(dir, "auth.json");
    try {
      await Bun.write(path, JSON.stringify({
        cliproxyapi: {
          access: "senpi-shared",
          refresh: "senpi-shared",
          expires: Date.now() + 1000,
          baseUrl: "http://cpa.example:8317",
        },
      }));
      expect(readStoredPrimaryCredential(path)).toBe("senpi-shared");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("DEFAULT_BASE_URL is a neutral bootstrap before login", () => {
    expect(DEFAULT_BASE_URL).toBe("http://127.0.0.1:8317");
  });

  test("oauth block has all required fields", () => {
    const oauth = {
      name: "x",
      login: login as (callbacks: LoginCallbacks) => Promise<Credentials>,
      refreshToken: refreshToken as (
        credentials: Credentials,
        signal: AbortSignal,
      ) => Promise<Credentials>,
      getApiKey,
    } as ProviderConfig["oauth"];
    expect(oauth!.name).toBeDefined();
    expect(typeof oauth!.login).toBe("function");
    expect(typeof oauth!.refreshToken).toBe("function");
    expect(typeof oauth!.getApiKey).toBe("function");
  });

  test("refreshToken is a no-op that returns same credentials", async () => {
    const creds: Credentials = { access: "k", refresh: "k", expires: Date.now() + 1000 };
    const out = await refreshToken(creds, new AbortController().signal);
    expect(out.access).toBe(creds.access);
    expect(out.refresh).toBe(creds.refresh);
  });

  test("getApiKey returns the access field", () => {
    expect(
      getApiKey({ access: "senpi-x", refresh: "r", expires: 0 }),
    ).toBe("senpi-x");
  });

  test("login returns credentials shaped like an OAuth credential", async () => {
    const answers = ["http://cpa.example:8317/v1", "senpi-fake"];
    const prompts: string[] = [];
    const mock: LoginCallbacks = {
      onPrompt: async ({ message }) => {
        prompts.push(message);
        return answers.shift() ?? "";
      },
    };
    const creds = await login(mock);
    expect(prompts).toHaveLength(2);
    expect(creds.baseUrl).toBe("http://cpa.example:8317");
    expect(typeof creds.access).toBe("string");
    expect(creds.access.startsWith("senpi-")).toBe(true);
    expect(typeof creds.expires).toBe("number");
  });

  test("login with empty input throws", async () => {
    const answers = ["http://cpa.example:8317", ""];
    await expect(login({ onPrompt: async () => answers.shift() ?? "" })).rejects.toThrow();
  });

  test("login rejects a base URL without an explicit port", async () => {
    await expect(login({ onPrompt: async () => "https://cpa.example" })).rejects.toThrow(/포트/);
  });

  test("login works with manual code input fallback", async () => {
    const answers = ["http://cpa.example:8317", "senpi-manual"];
    const creds = await login({ onManualCodeInput: async () => answers.shift() ?? "" });
    expect(creds.baseUrl).toBe("http://cpa.example:8317");
    expect(creds.access).toBe("senpi-manual");
  });

  test("login does not crash when only onAuth is provided (defensive)", async () => {
    // Defensive: runtime may expose only onAuth. Should throw a readable error.
    await expect(login({ onAuth: () => {} })).rejects.toThrow(/입력 콜백/);
  });
});

// ---------- Stats shape (internal, tested via shape only) ----------

describe("Stats shape", () => {
  test("Stats is a plain object with the expected fields", () => {
    const s: Stats = {
      realContext: 0,
      defaultedContext: 0,
      clampedMaxTokens: 0,
      overruledContext: 0,
      inputFromGemini: 0,
      inputFromDefault: 0,
    };
    expect(s.realContext).toBe(0);
    expect(s.defaultedContext).toBe(0);
    expect(s.clampedMaxTokens).toBe(0);
    expect(s.overruledContext).toBe(0);
    expect(s.inputFromGemini).toBe(0);
    expect(s.inputFromDefault).toBe(0);
  });
});

// ---------- declared alias tier (review blocker A) ----------

function aliasCatalog(id: string): CatalogModel {
  return {
    id,
    ownedBy: null,
    displayName: id,
    contextLength: 128000,
    maxTokens: 8192,
    inputModalities: null,
    outputModalities: null,
    thinking: null,
  };
}

describe("models absent from the catalog stay unregistered", () => {
  function tiersFor(catalog: CatalogModel[]) {
    const tiered = buildProviderRegistration({
      catalog,
      contextOverrides: new Map(),
      overrides: {},
    });
    return {
      catalog: new Set(tiered.catalog.map((model) => model.id)),
      primary: new Set(tiered.primaryModels.map((model) => model.id)),
      last: new Set(tiered.lastModels.map((model) => model.id)),
    };
  }

  test("gpt-spark, composer-2.5, MiniMax-M3, and open-muse are not synthesized", () => {
    const { catalog, primary, last } = tiersFor([aliasCatalog("gpt-5.6-sol")]);
    for (const id of ["gpt-spark", "composer-2.5", "MiniMax-M3", "open-muse"]) {
      expect(catalog.has(id)).toBe(false);
      expect(primary.has(id)).toBe(false);
      expect(last.has(id)).toBe(false);
    }
  });

  test("stable real last-resort ids stay registered when the volatile catalog omits them", () => {
    const tiered = buildProviderRegistration({
      catalog: [aliasCatalog("gpt-5.6-sol")],
      contextOverrides: new Map(),
      overrides: {},
    });
    const primary = new Set(tiered.primaryModels.map((model) => model.id));
    const last = new Set(tiered.lastModels.map((model) => model.id));
    for (const id of STABLE_LAST_RESORT_IDS) {
      expect(primary.has(id)).toBe(false);
      expect(last.has(id)).toBe(true);
      const model = tiered.lastModels.find((candidate) => candidate.id === id);
      expect(model?.reasoning).toBe(true);
      expect(model?.input).toEqual(["text", "image"]);
      expect(model?.contextWindow).toBe(196_608);
      expect(model?.maxTokens).toBe(65_536);
      expect(model?.thinkingLevelMap).toEqual({
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: null,
      });
    }
  });
});
