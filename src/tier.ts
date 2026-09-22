/**
 * CPA model tier classification.
 *
 * The user's rule: muse / gpt / claude / gemini / glm / deepseek / grok are the
 * real workhorses. Everything else is a free, low-cost or low-capability pool
 * that may only be reached as a last resort.
 *
 * Classifying on the model id alone is provably wrong: CPA republishes the same
 * backends under opaque aliases (`fable`, `mengmota`, `gptreal`), and for those
 * the displayName is the only true identity signal. It also ships ids that read
 * strong but are not (`higher-coding` is `Dots Studio: Dots3-Note Preview (free)`).
 *
 * Nothing here is hardcoded to a model list: the live catalog was measured at
 * 530 models, then 97, then 98 within eleven hours. Every function below is a
 * pure function of the catalog it is handed.
 */

import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PRIMARY_FAMILIES } from "./tier-types.ts";
import type { CatalogModel, PrimaryFamily, Tier, TierDecision } from "./tier-types.ts";

/**
 * Strips a provider-side namespace, byte-for-byte as senpi does it: the cut is
 * the LAST "." or "/". Bedrock's `global.anthropic.claude-opus-5` reduces to
 * `claude-opus-5`.
 *
 * Note the consequence, which is load-bearing rather than accidental: for
 * `z-ai/glm-5.3-flash` the dot inside the version "5.3" is the last separator,
 * so the candidate is `3-flash` and the id-side match fails. That model is
 * rescued by its displayName instead. Deviating here to "fix" it would make
 * this plugin disagree with the router it feeds.
 */
function withoutNamespace(modelId: string): string {
  const cut = Math.max(modelId.lastIndexOf("."), modelId.lastIndexOf("/"));
  return cut === -1 ? modelId : modelId.slice(cut + 1);
}

/**
 * Conservative family match on the id, with the same semantics as senpi's
 * `matchesFamily`: exact id or a dash-suffixed variant, on either the raw id or
 * the namespace-stripped one. Never an arbitrary substring, so `claude-fable-5`
 * cannot be captured by `not-claude-fable-5`.
 */
export function matchesFamilyById(modelId: string, family: string): boolean {
  const lower = modelId.toLowerCase();
  const fam = family.toLowerCase();
  const candidates = [lower, withoutNamespace(lower)];
  return candidates.some((id) => id === fam || id.startsWith(`${fam}-`));
}

/** First primary family whose id-side rule the model id satisfies, else null. */
export function familyFromId(modelId: string): PrimaryFamily | null {
  for (const family of PRIMARY_FAMILIES) {
    if (matchesFamilyById(modelId, family)) return family;
  }
  return null;
}

/** Lowercased alphanumeric words. "Z.ai" -> ["z","ai"], "Dots3-Note" -> ["dots3","note"]. */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length > 0);
}

/**
 * Family match on the displayName, which for a large part of the catalog is the
 * only true identity signal (`fable` is `claude-fable-5`, `gptreal` is
 * `GPT 5.6 Sol`).
 *
 * displayNames are prose, so the id rule is too strict here; but "contains the
 * word" is far too loose and would promote `Qwen 3 (claude-compatible API)`.
 * The rule adopted: the family must be the HEAD word of the name, or the head
 * word after a vendor prefix (`Z.ai: GLM 5.3 Flash`, `Meta: Muse Spark 1.3`).
 * A model's own name leads its title; a family mentioned anywhere else is
 * commentary, not identity.
 */
export function familyFromDisplayName(displayName: string | null): PrimaryFamily | null {
  if (!displayName) return null;
  for (const segment of displayName.split(":")) {
    const head = tokenize(segment)[0];
    if (!head) continue;
    for (const family of PRIMARY_FAMILIES) {
      if (head === family) return family;
    }
  }
  return null;
}

/**
 * Free / zero-cost marker. Matched as a whole word only, so `freeform-writer-7b`
 * and "Freedom Model 2" are untouched. Covers the literal `:free` id suffix
 * (24+ models carry it), `openrouter/free`-style segments, and `(free)` or a
 * bare `free` inside the displayName.
 */
export function hasFreeMarker(m: CatalogModel): boolean {
  if (tokenize(m.id).includes("free")) return true;
  return m.displayName ? tokenize(m.displayName).includes("free") : false;
}

/**
 * Words denoting a non-text generator or a classifier. Two kinds live here:
 *
 *  - capability nouns (`image`, `music`, `embedding`, `rerank`, `tts`, ...)
 *  - names of model families that ARE a non-text modality (`lyria` = music)
 *
 * The second kind is reluctant but necessary, and it is not the "hardcoded
 * model list" the brief forbids: it names a MODALITY FAMILY, not a catalog
 * entry, so it keeps working as `lyria-3` becomes `lyria-4`. It exists because
 * measurement forced it — only 28 of 98 live models carry outputModalities, and
 * `google/lyria-3-*` (music) carries none, no capability noun in its id, and no
 * other machine-readable signal. Without this it lands in the chat fallback
 * TAIL, firing precisely when every real model is already down.
 */
const NON_CHAT_MARKERS = new Set([
  // capability nouns
  "image", "images", "music", "audio", "video", "speech", "voice", "tts", "stt",
  "embed", "embedding", "embeddings", "rerank", "reranker", "moderation",
  "transcription", "transcribe", "diffusion", "upscale", "upscaler",
  // non-text generator / classifier families
  "lyria", "imagen", "veo", "sora", "whisper", "dalle", "guard",
]);

/**
 * Multi-word markers, matched on adjacent token pairs so a single innocuous
 * word cannot trigger them. `content safety` is a classifier that emits a
 * label, never a conversational turn.
 */
const NON_CHAT_BIGRAMS = new Set(["content safety", "text embedding", "image generation"]);

function markerWords(m: CatalogModel): string[] {
  return [...tokenize(m.id), ...(m.displayName ? tokenize(m.displayName) : [])];
}

/** The non-text marker present in a model's name, if any. */
function nonChatNameMarker(m: CatalogModel): string | null {
  const words = markerWords(m);
  const single = words.find((w) => NON_CHAT_MARKERS.has(w));
  if (single) return single;
  for (let i = 0; i + 1 < words.length; i++) {
    const pair = `${words[i]} ${words[i + 1]}`;
    if (NON_CHAT_BIGRAMS.has(pair)) return pair;
  }
  return null;
}

/**
 * Whether a model can carry a chat turn.
 *
 * Two independent signals, because neither alone is sufficient on the live
 * catalog (measured: only 28 of 98 models declare outputModalities at all):
 *
 *  1. declared output modality without "text"  -> not chat-capable
 *  2. a non-text generator/classifier name     -> not chat-capable
 *
 * Rule 2 applies even when the modality list DOES contain text: the live
 * `gemini-3.1-flash-image` declares text+image, but its text is a caption, not
 * a conversation. For a fallback chain, wrongly excluding an ambiguous model
 * costs one candidate; wrongly including one that cannot converse breaks the
 * turn at the worst possible moment.
 *
 * Two things are deliberately NOT signals:
 *  - the word "preview": `gemini-3-pro-preview` is a legitimate primary, and
 *    `lyria-3-pro-preview` being a preview is a coincidence, not a rule.
 *  - INPUT modality: a vision model that replies in text is a chat model.
 */
export function isChatCapable(m: CatalogModel): boolean {
  if (nonChatNameMarker(m)) return false;
  const out = m.outputModalities;
  if (out && out.length > 0) return out.some((x) => x.toLowerCase() === "text");
  // Null modalities are the common case (70 of 98) and must never be a blanket
  // exclusion, or the whole catalog would be unroutable.
  return true;
}

/**
 * Why a model is unfit for chat, naming WHICH signal fired so the reason is
 * actionable: a declared modality is machine-truth, a name marker is inference.
 */
function nonChatReason(m: CatalogModel): string {
  const named = nonChatNameMarker(m);
  if (named) return `non-text model family "${named}" in its name — unfit for a chat chain`;
  const out = m.outputModalities;
  const declared = out && out.length > 0 ? out.map((x) => x.toLowerCase()).join("/") : "unknown";
  return `output modality ${declared} has no text — unfit for a chat chain`;
}

/** id -> forced tier. The pure classifier's only external input. */
export type OverrideMap = Record<string, Tier>;

/**
 * Classify a whole catalog. Pure, synchronous, order-preserving, no I/O.
 * `overrides` is a plain map so the classifier never has to know that a store,
 * a file, or a user exists.
 */
export function classify(
  models: CatalogModel[],
  overrides: OverrideMap = {},
  upstreamByAlias: Readonly<Record<string, string>> = {},
): TierDecision[] {
  return models.map((m) => classifyOne(m, overrides[m.id], upstreamByAlias[m.id] ?? m.upstreamModelId));
}

function decide(id: string, tier: Tier, family: PrimaryFamily | null, reason: string, overridden: boolean): TierDecision {
  // Invariant: `family` is non-null only for a model actually usable as that
  // family right now. A demoted gpt-image model reports family null so that a
  // consumer grouping by family cannot route a chat turn into an image endpoint.
  return { id, tier, family: tier === "primary" ? family : null, reason, overridden };
}

/**
 * Rule order, strongest signal first:
 *   0. user override            -> wins outright (the user owns their routing)
 *   1. non-chat output modality -> last  (an image model is never a chat fallback)
 *   2. free / zero-cost marker  -> last  (the user's "free pool" definition)
 *   3. family via id            -> primary (senpi semantics)
 *   4. family via displayName   -> primary (the alias rescue)
 *   5. otherwise                -> last
 *
 * A declared alias is the exception to rule 3: its own id is a cosmetic label
 * (`gpt-spark` merely looks like gpt) and its real identity is the upstream id.
 * Such an alias is classified exactly as if the upstream id were the model, so
 * a free upstream stays last and a genuine primary-family upstream stays primary.
 */
function classifyOne(m: CatalogModel, override: Tier | undefined, upstreamId?: string): TierDecision {
  if (override) {
    // The family is still reported when we can name it, so the user can see
    // what they promoted; it is suppressed for a demotion by `decide`.
    const known = familyFromId(m.id) ?? familyFromDisplayName(m.displayName);
    const verb = override === "primary" ? "promoted to primary" : "demoted to last-resort";
    return decide(m.id, override, known, `user override: ${verb}`, true);
  }
  if (!isChatCapable(m)) {
    return decide(m.id, "last", null, nonChatReason(m), false);
  }
  const identity: CatalogModel = upstreamId === undefined ? m : { ...m, id: upstreamId, displayName: upstreamId };
  if (hasFreeMarker(identity)) {
    return decide(m.id, "last", null, "free / zero-cost marker", false);
  }
  const byId = familyFromId(identity.id);
  if (byId) {
    const via = upstreamId === undefined ? "id" : `upstream ${upstreamId}`;
    return decide(m.id, "primary", byId, `family ${byId} via ${via}`, false);
  }

  const byName = familyFromDisplayName(identity.displayName);
  if (byName) {
    return decide(m.id, "primary", byName, `family ${byName} via displayName "${identity.displayName}"`, false);
  }
  return decide(m.id, "last", null, upstreamId === undefined ? "no primary family matched" : `upstream ${upstreamId} matches no primary family`, false);
}

/** An override whose model id is not in the current catalog. Kept, not dropped. */
export interface InactiveOverride {
  id: string;
  tier: Tier;
  reason: string;
}

export interface TierReport {
  /** Every input model, in catalog order. primary + last + chatUnfit. */
  decisions: TierDecision[];
  /** Routable primary workhorses. */
  primary: TierDecision[];
  /** Routable last-resort pool. This IS the chain tail. */
  last: TierDecision[];
  /**
   * Models that cannot hold a conversation at all (music, image, embedding,
   * classifiers). Excluded from BOTH pools: tier `last` is the chain tail, so
   * demoting a music model would still let it fire once everything else is
   * down. Reported rather than dropped so the exclusion stays visible.
   */
  chatUnfit: TierDecision[];
  /** Overrides retained but not currently applicable. */
  inactiveOverrides: InactiveOverride[];
}

/**
 * Classify and split into the two pools, reporting overrides that currently
 * match nothing. The catalog is volatile — measured at 530, then 97, then 98
 * models within eleven hours, with one owner going 449 -> 14 -> 8 — so an
 * override for a momentarily absent model is far more likely to be a live
 * preference than a mistake. Dropping it would quietly undo the user's choice.
 */
export function buildTierReport(
  models: CatalogModel[],
  overrides: OverrideMap = {},
  upstreamByAlias: Readonly<Record<string, string>> = {},
): TierReport {
  const decisions = classify(models, overrides, upstreamByAlias);
  const present = new Set(models.map((m) => m.id));
  const inactiveOverrides: InactiveOverride[] = Object.entries(overrides)
    .filter(([id]) => !present.has(id))
    .map(([id, tier]) => ({ id, tier, reason: "현재 카탈로그에 없는 모델 — 설정은 보존됨 (비활성)" }));

  // An explicit user override keeps a model routable even when the automatic
  // rule considers it unfit: the user is the final authority on their routing.
  const byId = new Map(models.map((m) => [m.id, m]));
  const unfit = (d: TierDecision): boolean => {
    if (d.overridden) return false;
    const m = byId.get(d.id);
    return m ? !isChatCapable(m) : false;
  };

  return {
    decisions,
    primary: decisions.filter((d) => d.tier === "primary" && !unfit(d)),
    last: decisions.filter((d) => d.tier === "last" && !unfit(d)),
    chatUnfit: decisions.filter(unfit),
    inactiveOverrides,
  };
}

// ===========================================================================
// Persistent override store. Strictly separate from the pure classifier above.
// ===========================================================================

/** The plugin's own cache dir, matching the convention in src/catalog.ts. */
const CACHE_DIR = join(homedir(), ".cache", "omo-cpa");
export const OVERRIDES_FILE = join(CACHE_DIR, "tier-overrides.json");

/** One recorded user decision. */
export interface OverrideEntry {
  tier: Tier;
  /** Epoch ms, so the UI can show when a choice was made. */
  setAt: number;
  note?: string;
}

export interface OverrideStore {
  version: 1;
  overrides: Record<string, OverrideEntry>;
}

export function emptyOverrideStore(): OverrideStore {
  return { version: 1, overrides: {} };
}

/** Project the store down to what the pure classifier consumes. */
export function toOverrideMap(store: OverrideStore): OverrideMap {
  const out: OverrideMap = {};
  for (const [id, entry] of Object.entries(store.overrides)) out[id] = entry.tier;
  return out;
}

/** Immutable insert/replace. */
export function setOverride(store: OverrideStore, id: string, tier: Tier, note?: string): OverrideStore {
  const entry: OverrideEntry = { tier, setAt: Date.now(), ...(note === undefined ? {} : { note }) };
  return { version: 1, overrides: { ...store.overrides, [id]: entry } };
}

/** Immutable delete. Removing an absent id is a no-op, never an error. */
export function clearOverride(store: OverrideStore, id: string): OverrideStore {
  if (!(id in store.overrides)) return store;
  const next = { ...store.overrides };
  delete next[id];
  return { version: 1, overrides: next };
}

/**
 * omo's own configuration tree is user-owned and read-only for this plugin.
 * The guard covers the entire `~/.omo` directory rather than a list of four
 * filenames: a list would silently stop protecting anything omo adds later.
 */
export function isForbiddenOverridePath(path: string): boolean {
  const omoRoot = resolve(join(homedir(), ".omo"));
  const target = resolve(path);
  return target === omoRoot || target.startsWith(omoRoot + sep);
}

/**
 * Defensive parse. Anything unrecognised is dropped entry-by-entry rather than
 * failing the whole file: one bad line written by a future version must not
 * cost the user every preference they have set.
 */
function parseStore(raw: unknown): OverrideStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyOverrideStore();
  const bag = (raw as { overrides?: unknown }).overrides;
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return emptyOverrideStore();

  const overrides: Record<string, OverrideEntry> = {};
  for (const [id, value] of Object.entries(bag as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const rec = value as { tier?: unknown; setAt?: unknown; note?: unknown };
    if (rec.tier !== "primary" && rec.tier !== "last") continue;
    overrides[id] = {
      tier: rec.tier,
      setAt: typeof rec.setAt === "number" ? rec.setAt : 0,
      ...(typeof rec.note === "string" ? { note: rec.note } : {}),
    };
  }
  return { version: 1, overrides };
}

/**
 * Load persisted overrides. A missing, unreadable, corrupt or structurally
 * wrong file degrades to "no overrides" and never throws: a broken preferences
 * file must not be able to take a session down.
 */
export async function loadOverrideStore(path: string = OVERRIDES_FILE): Promise<OverrideStore> {
  try {
    return parseStore(await Bun.file(path).json());
  } catch {
    return emptyOverrideStore();
  }
}

/** Persist overrides. Returns false instead of throwing when it cannot write. */
export async function saveOverrideStore(store: OverrideStore, path: string = OVERRIDES_FILE): Promise<boolean> {
  if (isForbiddenOverridePath(path)) return false;
  try {
    await Bun.write(path, `${JSON.stringify(store, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

// ===========================================================================
// /cpa subcommand parsing. Pure, so wiring it into the extension is one call.
// ===========================================================================

export type TierCommand =
  | { kind: "list" }
  | { kind: "set"; id: string; tier: Tier }
  | { kind: "clear"; id: string }
  | { kind: "error"; message: string };

const TIER_USAGE = "사용법: /cpa tier [promote|demote|reset] <model-id>";

/**
 * Parse the `tier` subcommand of /cpa. Returns null when the args are not a
 * tier command at all, so the caller can fall through to its other subcommands.
 */
export function parseTierCommand(args: string[]): TierCommand | null {
  const [head, action, id] = args;
  if (head !== "tier") return null;
  if (action === undefined) return { kind: "list" };

  if (action === "promote" || action === "demote" || action === "reset") {
    if (!id) return { kind: "error", message: `모델 id가 필요합니다. ${TIER_USAGE}` };
    if (action === "reset") return { kind: "clear", id };
    return { kind: "set", id, tier: action === "promote" ? "primary" : "last" };
  }
  return { kind: "error", message: `알 수 없는 하위 명령 "${action}". ${TIER_USAGE}` };
}
