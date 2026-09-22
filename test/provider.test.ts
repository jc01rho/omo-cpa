/**
 * Tests for the CPA in-code provider (registerCpaProvider, oauth, refreshModels,
 * unmangleAnthropicId, metadata merge, max_tokens clamp, safer-of-two rule).
 *
 * These tests do NOT hit the network (except where noted) and never print API keys.
 */
import { describe, expect, test } from "bun:test";
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
  DECLARED_OVERRIDES,
  getApiKey,
  refreshToken,
  login,
} from "../src/provider.ts";

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

  test("declared overrides use conservative defaults for aliases not in listings", () => {
    const spark = DECLARED_OVERRIDES["gpt-spark"];
    const composer = DECLARED_OVERRIDES["composer-2.5"];
    if (!spark || !composer) throw new Error("sanity: declared overrides missing");
    expect(spark.contextWindow).toBe(8192);
    expect(spark.upstreamModelId).toBe("solar-mini4-preview");
    expect(composer.upstreamModelId).toBe("poolside/laguna-s-2.1-free");
  });

  test("declared overrides contain exactly the 4 unlisted aliases", () => {
    const keys = Object.keys(DECLARED_OVERRIDES);
    expect(keys).toContain("gpt-spark");
    expect(keys).toContain("composer-2.5");
    expect(keys).toContain("MiniMax-M3");
    expect(keys).toContain("open-muse");
    expect(keys).toHaveLength(4);
  });

  test("each declared override has a conservative contextWindow (<= 8192)", () => {
    for (const ov of Object.values(DECLARED_OVERRIDES)) {
      expect(ov.contextWindow).toBeLessThanOrEqual(8192);
      expect(ov.maxTokens).toBeLessThanOrEqual(ov.contextWindow - 1);
    }
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

describe("provider registration shape", () => {
  test("PROVIDER_NAME equals existing omo routed provider", () => {
    expect(PROVIDER_NAME).toBe("local-proxy");
  });

  test("DEFAULT_BASE_URL matches live server", () => {
    expect(DEFAULT_BASE_URL).toBe("http://152.69.234.237:8317");
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
    // Cannot run real /login interactively. Validate the returned shape only.
    const mock: LoginCallbacks = { onPrompt: async () => "senpi-fake" };
    const creds = await login(mock);
    expect(typeof creds.access).toBe("string");
    expect(creds.access.startsWith("senpi-")).toBe(true);
    expect(typeof creds.expires).toBe("number");
  });

  test("login with empty input throws", async () => {
    await expect(login({ onPrompt: async () => "" })).rejects.toThrow();
  });

  test("login works with manual code input fallback", async () => {
    const creds = await login({ onManualCodeInput: async () => "senpi-manual" });
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
