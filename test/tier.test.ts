import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTierReport,
  classify,
  clearOverride,
  emptyOverrideStore,
  familyFromDisplayName,
  familyFromId,
  hasFreeMarker,
  isChatCapable,
  isForbiddenOverridePath,
  loadOverrideStore,
  matchesFamilyById,
  parseTierCommand,
  saveOverrideStore,
  setOverride,
  toOverrideMap,
} from "../src/tier.ts";
import type { CatalogModel, PrimaryFamily, Tier, TierDecision } from "../src/tier-types.ts";

/** Local alias so the table below reads as a column of family names. */
type PrimaryFamilyName = PrimaryFamily;

/**
 * Fixture builder. Every enrichment field defaults to null because CPA really
 * does omit them for part of the catalog, and a classifier that only works on
 * fully-populated records would be a classifier that does not work.
 */
function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    ownedBy: null,
    displayName: null,
    contextLength: null,
    maxTokens: null,
    inputModalities: null,
    outputModalities: null,
    thinking: null,
    ...extra,
  };
}

function decisionFor(decisions: TierDecision[], id: string): TierDecision {
  const hit = decisions.find((d) => d.id === id);
  if (!hit) throw new Error(`no decision for ${id}`);
  return hit;
}

function tierOf(models: CatalogModel[], id: string): Tier {
  return decisionFor(classify(models), id).tier;
}

// ---------------------------------------------------------------------------
// id-side matching must not contradict senpi's own matchesFamily.
// Source: @code-yeongyu/senpi/dist/core/retry-fallback/expansion.js
//   candidates = [id, withoutNamespace(id)]
//   match when candidate === family || candidate.startsWith(family + "-")
// ---------------------------------------------------------------------------
describe("matchesFamilyById — senpi parity", () => {
  test("dash-suffixed variant matches", () => {
    expect(matchesFamilyById("gpt-5.5", "gpt")).toBe(true);
  });

  test("bare exact id matches", () => {
    expect(matchesFamilyById("glm", "glm")).toBe(true);
  });

  test("case is normalised", () => {
    expect(matchesFamilyById("GPT-5.6-Luna", "gpt")).toBe(true);
  });

  // The whole point of senpi's conservative rule.
  test("never matches an arbitrary substring", () => {
    expect(matchesFamilyById("not-claude-fable-5", "claude")).toBe(false);
  });

  test("a family name glued to more characters does not match", () => {
    // `gptreal` is a real catalog id. It is NOT a dash-variant of `gpt`.
    expect(matchesFamilyById("gptreal", "gpt")).toBe(false);
  });

  test("strips a slash namespace", () => {
    expect(matchesFamilyById("deepseek/deepseek-v4-flash", "deepseek")).toBe(true);
  });

  test("strips a dot namespace like Bedrock's", () => {
    expect(matchesFamilyById("global.anthropic.claude-opus-5", "claude")).toBe(true);
  });

  /**
   * Documented quirk, verified in senpi's source: withoutNamespace cuts at the
   * LAST "." or "/", so the dot inside the version "5.3" wins and the candidate
   * becomes "3-flash". This is precisely why this model needs a displayName
   * rescue rather than an id match.
   */
  test("version dots defeat the id match (why displayName rescue exists)", () => {
    expect(matchesFamilyById("z-ai/glm-5.3-flash", "glm")).toBe(false);
  });

  test("a family name as a trailing word does not match", () => {
    expect(matchesFamilyById("ai-muse", "muse")).toBe(false);
  });
});

describe("familyFromId", () => {
  test("returns the matched family", () => {
    expect(familyFromId("claude-sonnet-5")).toBe("claude");
  });
  test("returns null when nothing matches", () => {
    expect(familyFromId("higher-coding")).toBeNull();
  });
});

describe("classify — id-side primaries", () => {
  test("a plain family id is primary and reports its family", () => {
    const d = decisionFor(classify([model("claude-haiku-4.5")]), "claude-haiku-4.5");
    expect(d.tier).toBe("primary");
    expect(d.family).toBe("claude");
    expect(d.overridden).toBe(false);
    expect(d.reason).toContain("claude");
  });

  test("all seven families are recognised from the id", () => {
    const ids = [
      "muse-spark-1.3", "gpt-5.5", "claude-sonnet-5", "gemini-3-flash",
      "glm-5.3", "deepseek-v4.1-flash", "grok-4.7",
    ];
    for (const id of ids) expect(tierOf([model(id)], id)).toBe("primary");
  });

  test("an unmatched model defaults to the last-resort pool", () => {
    const d = decisionFor(classify([model("craxqwen")]), "craxqwen");
    expect(d.tier).toBe("last");
    expect(d.family).toBeNull();
  });

  test("empty catalog yields no decisions and does not throw", () => {
    expect(classify([])).toEqual([]);
  });

  test("one decision per input model, order preserved", () => {
    const ds = classify([model("gpt-5.5"), model("parrot"), model("grok-4.7")]);
    expect(ds.map((d) => d.id)).toEqual(["gpt-5.5", "parrot", "grok-4.7"]);
  });
});

// ---------------------------------------------------------------------------
// displayName-side matching. Liberal enough for prose like "Z.ai: GLM 5.3
// Flash", strict enough never to fire on an incidental substring.
// ---------------------------------------------------------------------------
describe("familyFromDisplayName", () => {
  test("plain hyphenated name", () => {
    expect(familyFromDisplayName("claude-opus-5")).toBe("claude");
  });

  test("vendor-prefixed prose name", () => {
    expect(familyFromDisplayName("Z.ai: GLM 5.3 Flash")).toBe("glm");
  });

  test("spaced name with a version", () => {
    expect(familyFromDisplayName("GPT 5.6 Sol")).toBe("gpt");
  });

  test("null displayName yields null", () => {
    expect(familyFromDisplayName(null)).toBeNull();
  });

  // --- the dangerous cases: these must NOT fire -----------------------------
  test("does not fire on a substring inside a longer word", () => {
    // "Amuse" contains "muse"; it is not the muse family.
    expect(familyFromDisplayName("Amuse Spark 2")).toBeNull();
  });

  test("does not fire on grok inside grokipedia", () => {
    expect(familyFromDisplayName("Grokipedia Search")).toBeNull();
  });

  test("does not fire on a family named as a mere qualifier", () => {
    expect(familyFromDisplayName("Qwen 3 (claude-compatible API)")).toBeNull();
  });

  test("does not fire on a negated lookalike", () => {
    expect(familyFromDisplayName("not-claude-fable-5")).toBeNull();
  });

  test("does not fire on a free clone that merely mentions a family", () => {
    expect(familyFromDisplayName("OpenGPT Clone by SomeoneElse")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MEASURED EVIDENCE — id looks like junk, displayName proves it is primary.
// Each of these is a live-catalog observation, pinned as a named case.
// ---------------------------------------------------------------------------
describe("classify — displayName rescues (measured)", () => {
  const cases: [string, string, PrimaryFamilyName][] = [
    ["fable", "claude-fable-5", "claude"],
    ["cc-opus-5", "claude-opus-5", "claude"],
    ["mengmota", "claude-opus-5", "claude"],
    ["cc-sonnet-5", "claude-sonnet-5", "claude"],
    ["opus", "claude-opus-5", "claude"],
    ["sonnet", "claude-sonnet-5", "claude"],
    ["gptreal", "GPT 5.6 Sol", "gpt"],
    ["cline-glm53flash", "Z.ai: GLM 5.3 Flash", "glm"],
    ["z-ai/glm-5.3-flash", "Z.ai: GLM 5.3 Flash", "glm"],
    ["ollama-deepseek-v4.1-flash", "Deepseek-V4.1-Flash", "deepseek"],
    ["opne-muse", "Meta: Muse Spark 1.3 Contributor", "muse"],
  ];

  for (const [id, displayName, family] of cases) {
    test(`${id} → "${displayName}" is rescued to primary (${family})`, () => {
      const d = decisionFor(classify([model(id, { displayName })]), id);
      expect(d.tier).toBe("primary");
      expect(d.family).toBe(family);
      expect(d.reason).toContain("displayName");
    });
  }

  test("gptreal would be last-resort without its displayName", () => {
    // Proves the rescue is doing the work, not an accidental id match.
    expect(tierOf([model("gptreal")], "gptreal")).toBe("last");
  });

  test("the typo'd id opne-muse is rescued by displayName, not by its id", () => {
    expect(familyFromId("opne-muse")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MEASURED EVIDENCE — id looks primary, displayName proves it is not.
// omo currently routes real work to these two. This is the user's complaint.
// ---------------------------------------------------------------------------
describe("classify — demotions (measured)", () => {
  test("higher-coding is a free preview, not a strong model", () => {
    const d = decisionFor(
      classify([model("higher-coding", { displayName: "Dots Studio: Dots3-Note Preview (free)" })]),
      "higher-coding",
    );
    expect(d.tier).toBe("last");
    expect(d.reason).toMatch(/free/i);
  });

  test("lower-coding is a preview with no primary family", () => {
    const d = decisionFor(classify([model("lower-coding", { displayName: "Hy4 preview" })]), "lower-coding");
    expect(d.tier).toBe("last");
    expect(d.family).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Free / low-cost markers.
// ---------------------------------------------------------------------------
describe("hasFreeMarker", () => {
  test("literal :free id suffix", () => {
    expect(hasFreeMarker(model("qwen/qwen3.8-27b:free"))).toBe(true);
  });
  test("a whole path segment named free", () => {
    expect(hasFreeMarker(model("openrouter/free"))).toBe(true);
  });
  test("(free) inside the displayName", () => {
    expect(hasFreeMarker(model("x", { displayName: "Dots Studio: Dots3-Note Preview (free)" }))).toBe(true);
  });
  test("free as a bare word in the displayName", () => {
    expect(hasFreeMarker(model("x", { displayName: "Ling 3.0 Flash free" }))).toBe(true);
  });
  test("does not fire on freeform / freedom", () => {
    expect(hasFreeMarker(model("freeform-writer-7b", { displayName: "Freedom Model 2" }))).toBe(false);
  });
});

describe("classify — free models are last-resort", () => {
  test(":free suffix sends a model to the last-resort pool", () => {
    const d = decisionFor(classify([model("qwen/qwen3.8-27b:free")]), "qwen/qwen3.8-27b:free");
    expect(d.tier).toBe("last");
    expect(d.reason).toMatch(/free/i);
  });

  /**
   * Judgement call, pinned deliberately: a :free variant of a PRIMARY family is
   * still demoted. The user described the last-resort pool as "free / low-cost"
   * models, and a free tier is rate-limited and weaker than the paid model of
   * the same name. Demoting risks a weaker route; promoting risks silently
   * putting real work on a throttled endpoint.
   */
  test("a free variant of a primary family is still demoted", () => {
    const d = decisionFor(classify([model("z-ai/glm-5.2:free")]), "z-ai/glm-5.2:free");
    expect(d.tier).toBe("last");
    expect(d.reason).toMatch(/free/i);
  });
});

// ---------------------------------------------------------------------------
// Non-chat modalities. Decided on OUTPUT MODALITY, never on the word
// "preview" — that would demote legitimate previews.
// ---------------------------------------------------------------------------
describe("isChatCapable", () => {
  test("text output is chat-capable", () => {
    expect(isChatCapable(model("gpt-5.5", { outputModalities: ["text"] }))).toBe(true);
  });
  test("audio-only output is not", () => {
    expect(isChatCapable(model("google/lyria-3-pro-preview", { outputModalities: ["audio"] }))).toBe(false);
  });
  test("image-only output is not", () => {
    expect(isChatCapable(model("gpt-image-2", { outputModalities: ["image"] }))).toBe(false);
  });
  test("image input with text output stays chat-capable", () => {
    expect(isChatCapable(model("gemini-3-pro-preview", {
      inputModalities: ["text", "image"], outputModalities: ["text"],
    }))).toBe(true);
  });
  test("unknown modality is assumed chat-capable", () => {
    expect(isChatCapable(model("mystery-model"))).toBe(true);
  });
});

describe("classify — music models never enter a chat chain", () => {
  for (const id of ["google/lyria-3-clip-preview", "google/lyria-3-pro-preview"]) {
    test(`${id} is last-resort on output modality`, () => {
      const d = decisionFor(classify([model(id, { outputModalities: ["audio"] })]), id);
      expect(d.tier).toBe("last");
      expect(d.reason).toMatch(/modal|chat/i);
    });
  }
});

// ---------------------------------------------------------------------------
// MEASURED on the live server: only 28 of 98 models carry outputModalities at
// all; the other 70 are null. A modality-only rule therefore passes every one
// of those 70 straight through. Observed consequence: both Lyria MUSIC models
// landed in a generated chat fallback TAIL — i.e. they fire exactly when
// everything else is already broken. These cases pin the null-modality path.
// ---------------------------------------------------------------------------
describe("isChatCapable — null outputModalities must not be a free pass", () => {
  test("lyria music models are excluded even with null modalities", () => {
    // Reproduced exactly as CPA returns them: no modality metadata at all.
    expect(isChatCapable(model("google/lyria-3-clip-preview", {
      displayName: "Google: Lyria 3 Clip Preview",
    }))).toBe(false);
    expect(isChatCapable(model("google/lyria-3-pro-preview", {
      displayName: "Google: Lyria 3 Pro Preview",
    }))).toBe(false);
  });

  test("gpt-image family is excluded even with null modalities", () => {
    for (const [id, name] of [
      ["gpt-image-1.5", "GPT Image 1.5"],
      ["gpt-image-2", "GPT Image 2"],
      ["gpt-image-2.5", "GPT Image 2.5"],
      ["gpt-image-2.5-flare", "GPT Image 2.5 Flare"],
      ["gpt-image-2.5-sunburst", "GPT Image 2.5 Sunburst"],
    ] as const) {
      expect(isChatCapable(model(id, { displayName: name }))).toBe(false);
    }
  });

  /**
   * Judgement, pinned: a content-safety model is a CLASSIFIER. It emits a
   * safety label, not a conversational turn. Routing a chat turn to it is a
   * hard failure, so it is excluded from the chain outright rather than merely
   * demoted — "last" would still let it fire in the tail.
   */
  test("a content-safety classifier is not chat-capable", () => {
    expect(isChatCapable(model("nvidia/nemotron-3.5-content-safety:free", {
      displayName: "NVIDIA: Nemotron 3.5 Content Safety (free)",
    }))).toBe(false);
  });

  /**
   * The other direction, and the reason this can never be a blanket exclusion:
   * 70 of 98 live models have null modalities and most are ordinary chat
   * models. Reproduced exactly as CPA returns it.
   */
  test("an ordinary chat model with null modalities stays chat-capable", () => {
    expect(isChatCapable(model("gpt-5.6-luna", { displayName: "GPT 5.6 Luna" }))).toBe(true);
  });

  test("null modalities alone never exclude anything", () => {
    for (const id of ["gpt-5.5", "claude-sonnet-5", "grok-4.7", "parrot", "wb2"]) {
      expect(isChatCapable(model(id))).toBe(true);
    }
  });

  /**
   * Judgement, pinned: a non-text generator name wins even when the modality
   * list DOES contain text. The live `gemini-3.1-flash-image` declares both
   * text and image output, but it is an image generator whose text is a
   * caption, not a conversational turn. For a fallback chain, wrongly
   * excluding an ambiguous model is the cheap error; wrongly including one
   * that cannot hold a conversation is the expensive one.
   */
  test("an image-generator name is excluded despite declaring text output", () => {
    expect(isChatCapable(model("gemini-3.1-flash-image", {
      displayName: "Gemini 3.1 Flash Image",
      inputModalities: ["text", "image"],
      outputModalities: ["text", "image"],
    }))).toBe(false);
  });

  test("a vision chat model that merely ACCEPTS images stays chat-capable", () => {
    // Input modality must never be a disqualifier.
    expect(isChatCapable(model("gemini-3-pro-preview", {
      displayName: "Gemini 3 Pro (Preview)",
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
    }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tier "last" IS the chain tail, so demotion alone cannot keep a music model
// out of a chat chain. Chat-unfit models are reported in their own bucket.
// ---------------------------------------------------------------------------
describe("buildTierReport — chat-unfit models leave the chain entirely", () => {
  const live = [
    model("gpt-5.5", { displayName: "GPT 5.5", outputModalities: ["text"] }),
    model("gpt-5.6-luna", { displayName: "GPT 5.6 Luna" }),
    model("parrot", { displayName: "Parrot" }),
    model("google/lyria-3-pro-preview", { displayName: "Google: Lyria 3 Pro Preview" }),
    model("gpt-image-2", { displayName: "GPT Image 2" }),
    model("nvidia/nemotron-3.5-content-safety:free", { displayName: "NVIDIA: Nemotron 3.5 Content Safety (free)" }),
  ];

  test("neither pool contains a chat-unfit model", () => {
    const r = buildTierReport(live);
    const routable = [...r.primary, ...r.last].map((d) => d.id);
    expect(routable).not.toContain("google/lyria-3-pro-preview");
    expect(routable).not.toContain("gpt-image-2");
    expect(routable).not.toContain("nvidia/nemotron-3.5-content-safety:free");
  });

  test("they are reported in chatUnfit rather than silently dropped", () => {
    const r = buildTierReport(live);
    expect(r.chatUnfit.map((d) => d.id).sort()).toEqual([
      "google/lyria-3-pro-preview",
      "gpt-image-2",
      "nvidia/nemotron-3.5-content-safety:free",
    ]);
  });

  test("the real chat models still route", () => {
    const r = buildTierReport(live);
    expect(r.primary.map((d) => d.id)).toEqual(["gpt-5.5", "gpt-5.6-luna"]);
    expect(r.last.map((d) => d.id)).toEqual(["parrot"]);
  });

  test("decisions still accounts for every input model", () => {
    const r = buildTierReport(live);
    expect(r.decisions).toHaveLength(live.length);
    expect(r.primary.length + r.last.length + r.chatUnfit.length).toBe(live.length);
  });

  test("an explicit user promotion still overrides chat-unfit", () => {
    // The user remains the final authority on their own routing.
    const r = buildTierReport(live, { "gpt-image-2": "primary" });
    expect(r.primary.map((d) => d.id)).toContain("gpt-image-2");
    expect(r.chatUnfit.map((d) => d.id)).not.toContain("gpt-image-2");
  });
});

describe("classify — image models are unfit for a chat chain", () => {
  const imageIds = [
    "gpt-image-1.5", "gpt-image-2", "gpt-image-2.5",
    "gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
  ];

  for (const id of imageIds) {
    test(`${id} is last-resort despite matching the gpt family`, () => {
      // It really does match the gpt family by id — that is the trap.
      expect(familyFromId(id)).toBe("gpt");
      const d = decisionFor(classify([model(id, { outputModalities: ["image"] })]), id);
      expect(d.tier).toBe("last");
      expect(d.reason).toMatch(/modal|chat/i);
    });
  }

  test("an image model with no modality metadata is still caught by its name", () => {
    // CPA omits modality fields for part of the catalog; the capability word in
    // the id is the fallback signal. Still a capability rule, not a model list.
    const d = decisionFor(classify([model("gemini-3.1-flash-image")]), "gemini-3.1-flash-image");
    expect(d.tier).toBe("last");
  });
});

describe("classify — 'preview' is never itself a junk marker", () => {
  test("gemini-3-pro-preview stays primary", () => {
    const d = decisionFor(classify([model("gemini-3-pro-preview")]), "gemini-3-pro-preview");
    expect(d.tier).toBe("primary");
    expect(d.family).toBe("gemini");
  });

  test("other legitimate previews stay primary too", () => {
    for (const id of ["gemini-3-flash-preview", "gemini-3.1-pro-preview"]) {
      expect(tierOf([model(id)], id)).toBe("primary");
    }
  });
});

describe("classify — degenerate catalogs", () => {
  test("an all-primary catalog does not crash", () => {
    const ds = classify([model("gpt-5.5"), model("claude-sonnet-5"), model("grok-4.7")]);
    expect(ds.every((d) => d.tier === "primary")).toBe(true);
  });

  test("an all-last-resort catalog does not crash", () => {
    const ds = classify([model("parrot"), model("wb2"), model("octest")]);
    expect(ds.every((d) => d.tier === "last")).toBe(true);
  });

  test("every decision carries a non-empty, specific reason", () => {
    const ds = classify([
      model("gpt-5.5"),
      model("fable", { displayName: "claude-fable-5" }),
      model("parrot"),
      model("qwen/q:free"),
    ]);
    for (const d of ds) expect(d.reason.length).toBeGreaterThan(0);
    expect(new Set(ds.map((d) => d.reason)).size).toBeGreaterThan(1);
  });

  test("family is non-null exactly when the tier is primary", () => {
    const ds = classify([
      model("gpt-5.5"),
      model("gpt-image-2", { outputModalities: ["image"] }),
      model("z-ai/glm-5.2:free"),
      model("parrot"),
    ]);
    for (const d of ds) {
      if (d.tier === "primary") expect(d.family).not.toBeNull();
      else expect(d.family).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Overrides — the pure half. Both directions must work.
// ---------------------------------------------------------------------------
describe("classify — user overrides", () => {
  test("promotes a last-resort model to primary", () => {
    const catalog = [model("upstage/solar-pro4")];
    expect(tierOf(catalog, "upstage/solar-pro4")).toBe("last");

    const d = decisionFor(classify(catalog, { "upstage/solar-pro4": "primary" }), "upstage/solar-pro4");
    expect(d.tier).toBe("primary");
    expect(d.overridden).toBe(true);
    expect(d.reason).toMatch(/override/i);
  });

  test("demotes a primary model to last-resort", () => {
    const catalog = [model("gpt-5.5")];
    expect(tierOf(catalog, "gpt-5.5")).toBe("primary");

    const d = decisionFor(classify(catalog, { "gpt-5.5": "last" }), "gpt-5.5");
    expect(d.tier).toBe("last");
    expect(d.overridden).toBe(true);
    expect(d.reason).toMatch(/override/i);
  });

  test("an override beats even the non-chat modality rule", () => {
    // The user is the final authority on their own routing.
    const d = decisionFor(
      classify([model("gpt-image-2", { outputModalities: ["image"] })], { "gpt-image-2": "primary" }),
      "gpt-image-2",
    );
    expect(d.tier).toBe("primary");
    expect(d.overridden).toBe(true);
  });

  test("an override for another model does not disturb its neighbours", () => {
    const ds = classify([model("gpt-5.5"), model("parrot")], { parrot: "primary" });
    expect(decisionFor(ds, "gpt-5.5").overridden).toBe(false);
    expect(decisionFor(ds, "parrot").overridden).toBe(true);
  });

  test("no overrides behaves exactly like the automatic rule", () => {
    const catalog = [model("gpt-5.5"), model("parrot")];
    expect(classify(catalog, {})).toEqual(classify(catalog));
  });
});

describe("buildTierReport", () => {
  const catalog = [
    model("gpt-5.5"),
    model("fable", { displayName: "claude-fable-5" }),
    model("parrot"),
    model("qwen/q:free"),
  ];

  test("splits the catalog into the two pools", () => {
    const r = buildTierReport(catalog);
    expect(r.primary.map((d) => d.id)).toEqual(["gpt-5.5", "fable"]);
    expect(r.last.map((d) => d.id)).toEqual(["parrot", "qwen/q:free"]);
    expect(r.decisions).toHaveLength(4);
  });

  // The catalog went 530 -> 97 -> 98 models in eleven hours. An override for a
  // model that is momentarily absent must survive, not be silently discarded.
  test("retains an override for a model absent from the catalog, marked inactive", () => {
    const r = buildTierReport(catalog, { "model-that-vanished": "primary" });
    expect(r.inactiveOverrides).toHaveLength(1);
    expect(r.inactiveOverrides[0]!.id).toBe("model-that-vanished");
    expect(r.inactiveOverrides[0]!.tier).toBe("primary");
    expect(r.inactiveOverrides[0]!.reason).toMatch(/catalog|absent|없/i);
    // and it must not have been invented as a decision
    expect(r.decisions.find((d) => d.id === "model-that-vanished")).toBeUndefined();
  });

  test("an active override is not reported as inactive", () => {
    const r = buildTierReport(catalog, { parrot: "primary" });
    expect(r.inactiveOverrides).toHaveLength(0);
    expect(r.primary.map((d) => d.id)).toContain("parrot");
  });

  test("empty catalog with overrides reports them all as inactive", () => {
    const r = buildTierReport([], { a: "primary", b: "last" });
    expect(r.decisions).toEqual([]);
    expect(r.primary).toEqual([]);
    expect(r.last).toEqual([]);
    expect(r.inactiveOverrides).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Overrides — the persistent half.
// ---------------------------------------------------------------------------
describe("override store — pure mutations", () => {
  test("emptyOverrideStore has no entries", () => {
    expect(toOverrideMap(emptyOverrideStore())).toEqual({});
  });

  test("setOverride records a promotion without mutating the input", () => {
    const before = emptyOverrideStore();
    const after = setOverride(before, "solar", "primary");
    expect(toOverrideMap(after)).toEqual({ solar: "primary" });
    expect(toOverrideMap(before)).toEqual({});
  });

  test("setOverride records a demotion and can flip an existing entry", () => {
    const s = setOverride(setOverride(emptyOverrideStore(), "gpt-5.5", "last"), "gpt-5.5", "primary");
    expect(toOverrideMap(s)).toEqual({ "gpt-5.5": "primary" });
  });

  test("clearOverride removes one entry and leaves the rest", () => {
    const s = setOverride(setOverride(emptyOverrideStore(), "a", "primary"), "b", "last");
    expect(toOverrideMap(clearOverride(s, "a"))).toEqual({ b: "last" });
  });

  test("clearing an unknown id is a no-op, not an error", () => {
    const s = setOverride(emptyOverrideStore(), "a", "primary");
    expect(toOverrideMap(clearOverride(s, "nope"))).toEqual({ a: "primary" });
  });
});

describe("override store — persistence", () => {
  const dir = join(tmpdir(), `omo-cpa-tier-test-${process.pid}-${Date.now()}`);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a missing file degrades to no overrides", async () => {
    const store = await loadOverrideStore(join(dir, "does-not-exist.json"));
    expect(toOverrideMap(store)).toEqual({});
  });

  test("round-trips through disk", async () => {
    const path = join(dir, "roundtrip.json");
    const store = setOverride(setOverride(emptyOverrideStore(), "solar", "primary"), "gpt-5.5", "last");
    expect(await saveOverrideStore(store, path)).toBe(true);

    const loaded = await loadOverrideStore(path);
    expect(toOverrideMap(loaded)).toEqual({ solar: "primary", "gpt-5.5": "last" });
  });

  test("a persisted override actually changes classification", async () => {
    const path = join(dir, "applied.json");
    await saveOverrideStore(setOverride(emptyOverrideStore(), "parrot", "primary"), path);
    const loaded = await loadOverrideStore(path);
    expect(tierOf([model("parrot")], "parrot")).toBe("last");
    const d = decisionFor(classify([model("parrot")], toOverrideMap(loaded)), "parrot");
    expect(d.tier).toBe("primary");
  });

  test("a corrupt file degrades to no overrides and never throws", async () => {
    const path = join(dir, "corrupt.json");
    await Bun.write(path, "{ this is not json at all ———");
    const store = await loadOverrideStore(path);
    expect(toOverrideMap(store)).toEqual({});
  });

  test("a structurally wrong file degrades to no overrides", async () => {
    const path = join(dir, "wrong-shape.json");
    await Bun.write(path, JSON.stringify(["not", "an", "object"]));
    expect(toOverrideMap(await loadOverrideStore(path))).toEqual({});
  });

  test("unparseable entries are skipped, valid neighbours survive", async () => {
    const path = join(dir, "partial.json");
    await Bun.write(path, JSON.stringify({
      version: 1,
      overrides: {
        good: { tier: "primary", setAt: 1 },
        bogusTier: { tier: "legendary", setAt: 1 },
        notAnObject: 42,
      },
    }));
    expect(toOverrideMap(await loadOverrideStore(path))).toEqual({ good: "primary" });
  });
});

// ---------------------------------------------------------------------------
// The user's own config tree is READ-ONLY for this plugin, without exception.
// ---------------------------------------------------------------------------
describe("override store — never writes to user-owned config", () => {
  const forbidden = [
    join(homedir(), ".omo", "omo.jsonc"),
    join(homedir(), ".omo", "agent", "models.json"),
    join(homedir(), ".omo", "agent", "auth.json"),
    join(homedir(), ".omo", "agent", "settings.json"),
  ];

  for (const path of forbidden) {
    test(`refuses ${path}`, () => {
      expect(isForbiddenOverridePath(path)).toBe(true);
    });
  }

  test("the whole ~/.omo tree is refused, not just the four named files", () => {
    expect(isForbiddenOverridePath(join(homedir(), ".omo", "anything", "else.json"))).toBe(true);
  });

  test("the plugin's own cache dir is allowed", () => {
    expect(isForbiddenOverridePath(join(homedir(), ".cache", "omo-cpa", "tier-overrides.json"))).toBe(false);
  });

  test("saveOverrideStore refuses and creates nothing", async () => {
    // A path that must never come into existence.
    const probe = join(homedir(), ".omo", "agent", "__omo_cpa_probe_never_create__.json");
    const ok = await saveOverrideStore(setOverride(emptyOverrideStore(), "x", "primary"), probe);
    expect(ok).toBe(false);
    expect(await Bun.file(probe).exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// /cpa subcommand parsing. Pure, so the extension can wire it in one line.
// ---------------------------------------------------------------------------
describe("parseTierCommand", () => {
  test("promote", () => {
    expect(parseTierCommand(["tier", "promote", "solar-pro4"]))
      .toEqual({ kind: "set", id: "solar-pro4", tier: "primary" });
  });
  test("demote", () => {
    expect(parseTierCommand(["tier", "demote", "higher-coding"]))
      .toEqual({ kind: "set", id: "higher-coding", tier: "last" });
  });
  test("reset", () => {
    expect(parseTierCommand(["tier", "reset", "solar-pro4"]))
      .toEqual({ kind: "clear", id: "solar-pro4" });
  });
  test("bare tier lists", () => {
    expect(parseTierCommand(["tier"])).toEqual({ kind: "list" });
  });
  test("a missing model id is an actionable error, not a crash", () => {
    const r = parseTierCommand(["tier", "promote"]);
    expect(r?.kind).toBe("error");
    // The message must actually tell the user what to type.
    if (r?.kind === "error") expect(r.message).toContain("/cpa tier");
  });
  test("an unknown subcommand is an error", () => {
    expect(parseTierCommand(["tier", "yeet", "x"])?.kind).toBe("error");
  });
  test("not a tier command at all", () => {
    expect(parseTierCommand(["status"])).toBeNull();
    expect(parseTierCommand([])).toBeNull();
  });
});
