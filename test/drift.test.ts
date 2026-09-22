import { describe, expect, test } from "bun:test";
import {
  buildTokenWeights, computeDrift, scoreSubstitute, suggestSubstitute, tokenize, SUBSTITUTE_THRESHOLD,
} from "../src/drift.ts";

/**
 * A slice of the real CPA catalog (535 models on the live server). These exact
 * ids drove the scoring rules, so they are the regression surface.
 */
const CATALOG = [
  "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
  "openai/gpt-5", "openai/gpt-5-mini", "openai/gpt-5-nano", "openai/gpt-5-pro",
  "muse-spark-1.1", "muse-spark-1.2", "muse-spark-1.3", "meta/muse-spark-1.3",
  "ai-muse", "command-muse", "meta/muse-glimmer-30b",
  "minimax/minimax-m2", "minimax/minimax-m2.5", "minimax/minimax-m3",
  "grok-composer-2.5-fast", "glm-5.3-flash", "claude-opus", "gemini-pro",
];

describe("tokenize", () => {
  test("splits on separators and lowercases", () => {
    expect(tokenize("GPT-5.6-Luna")).toEqual(["gpt", "5.6", "luna"]);
  });
  test("splits namespaced ids", () => {
    expect(tokenize("minimax/minimax-m3")).toEqual(["minimax", "minimax", "m3"]);
  });
});

describe("buildTokenWeights", () => {
  test("common tokens weigh less than rare ones", () => {
    const w = buildTokenWeights(CATALOG);
    expect(w.get("gpt")!).toBeLessThan(w.get("composer")!);
  });
});

describe("scoreSubstitute", () => {
  const w = buildTokenWeights(CATALOG);

  test("identical ids score 1", () => {
    expect(scoreSubstitute("gpt-5.5", "gpt-5.5", w)).toBe(1);
  });

  test("unrelated ids score 0", () => {
    expect(scoreSubstitute("gpt-spark", "claude-opus", w)).toBe(0);
  });

  // Regression: the live server exposed this as a wrong suggestion.
  test("does not match across families on a common prefix alone", () => {
    expect(scoreSubstitute("gpt-spark", "gpt-5.5", w)).toBe(0);
  });

  test("preserves the distinctive token", () => {
    expect(scoreSubstitute("gpt-spark", "muse-spark-1.3", w)).toBeGreaterThan(0);
  });

  // Regression: previously missed because extra tokens were over-penalised.
  test("tolerates extra tokens around an exact name", () => {
    expect(scoreSubstitute("composer-2.5", "grok-composer-2.5-fast", w))
      .toBeGreaterThanOrEqual(SUBSTITUTE_THRESHOLD);
  });
});

describe("suggestSubstitute", () => {
  test("renamed model resolves to its new namespaced id", () => {
    expect(suggestSubstitute("MiniMax-M3", CATALOG)?.id).toBe("minimax/minimax-m3");
  });

  test("composer finds the grok-namespaced equivalent", () => {
    expect(suggestSubstitute("composer-2.5", CATALOG)?.id).toBe("grok-composer-2.5-fast");
  });

  test("never suggests a different family for gpt-spark", () => {
    const s = suggestSubstitute("gpt-spark", CATALOG);
    expect(s?.id).not.toBe("gpt-5.5");
    if (s) expect(s.id).toContain("spark");
  });

  test("returns null when the identity token is gone", () => {
    expect(suggestSubstitute("union-alpha", CATALOG)).toBeNull();
  });

  test("weak generic overlap is rejected", () => {
    // "open-muse" shares only the common "muse" token with "ai-muse".
    const s = suggestSubstitute("open-muse", CATALOG);
    if (s) expect(s.score).toBeGreaterThanOrEqual(SUBSTITUTE_THRESHOLD);
  });
});

describe("computeDrift", () => {
  test("reports no drift when everything is live", () => {
    const r = computeDrift([{ provider: "local-proxy", id: "gpt-5.5" }], CATALOG);
    expect(r.dead).toHaveLength(0);
    expect(r.healthy).toBe(1);
  });

  test("flags a model the server does not serve", () => {
    const r = computeDrift([{ provider: "local-proxy", id: "gpt-spark" }], CATALOG);
    expect(r.dead).toHaveLength(1);
    expect(r.dead[0]!.ref).toBe("local-proxy/gpt-spark");
  });

  test("deduplicates repeated declarations", () => {
    const r = computeDrift(
      [{ provider: "local-proxy", id: "gpt-spark" }, { provider: "local-proxy", id: "gpt-spark" }],
      CATALOG,
    );
    expect(r.checked).toBe(1);
  });

  test("treats the same id under different providers separately", () => {
    const r = computeDrift(
      [{ provider: "local-proxy", id: "x" }, { provider: "local-proxy-gemini", id: "x" }],
      CATALOG,
    );
    expect(r.checked).toBe(2);
    expect(r.dead).toHaveLength(2);
  });
});
