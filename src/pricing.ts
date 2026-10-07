/**
 * Per-model call pricing, resolved from the models.dev catalog.
 *
 * CPA's four list endpoints carry no price at all: the OpenAI, Anthropic and
 * Gemini lists expose only identity and limits, and the Codex variant adds
 * client configuration. The management API exposes usage and model
 * definitions, never a price (verified 2026-10-07 against "/v1/models",
 * "/v1/models?client_version=cpa", "/v1beta/models",
 * "/v0/management/config" and "/v0/management/model-definitions/*").
 * So the plugin cannot read a price off the server it is registering.
 *
 * models.dev is the source instead. It is the same catalog the user's own
 * cpa-usage-keeper treats as its default pricing source, and its "cost" shape
 * (USD per one million tokens: input / output / cache_read / cache_write) is
 * exactly the shape omo stores in models.json and reads in cache-stats
 * ("cost.cacheRead / 1_000_000"). No unit conversion is needed.
 *
 * Matching is deliberately conservative, because a plausible-but-wrong price
 * is worse than no price: measured on the live 82-model catalog, exact-id
 * matching restricted to a family's official vendor resolved every paid
 * workhorse (claude / gpt / gemini / glm / grok / kimi), while the looser
 * suffix-and-name matching a reseller-friendly index would allow produced real
 * mis-matches ("parrot" and "lower-coding" landed on glm-5.3-flash, "octest"
 * on a mimo route, "mistral-large-4" on a Cortecs reseller). An unresolved id
 * keeps the zero cost the plugin has always published: a missing value stays
 * missing, matching this repo's rule for every other metadata field.
 */
import type { CatalogModel } from "./tier-types.ts";

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const DEFAULT_PRICING_TTL_MS = 6 * 60 * 60 * 1000;

interface PricingEntry {
  provider: string;
  modelId: string;
  status: string | null;
  cost: ModelCost;
}

export interface PricingIndex {
  /** Lowercased id / canonical id -> entries offering it. */
  byId: Map<string, PricingEntry[]>;
  /** Normalized display name -> entries carrying that name. */
  byName: Map<string, PricingEntry[]>;
}

const OFFICIAL_PROVIDERS: Record<string, string[]> = {
  openai: ["openai", "azure", "azure-cognitive-services"],
  anthropic: ["anthropic", "google-vertex-anthropic"],
  deepseek: ["deepseek", "siliconflow-cn", "siliconflow"],
  glm: ["zai", "zhipuai", "zai-coding-plan", "zhipuai-coding-plan"],
  qwen: ["alibaba-cn", "alibaba", "aliyun-bailian"],
  google: ["google", "google-vertex"],
  xai: ["xai"],
  minimax: ["minimax-cn", "minimax", "minimax-cn-coding-plan", "minimax-coding-plan"],
  moonshot: ["moonshotai-cn", "moonshotai", "kimi-for-coding"],
  mistral: ["mistral"],
};

const FAMILY_PATTERNS: Array<[RegExp, string]> = [
  [/^(gpt|chatgpt|o1|o3|o4)/, "openai"],
  [/^claude/, "anthropic"],
  [/^deepseek/, "deepseek"],
  [/^glm/, "glm"],
  [/^qwen/, "qwen"],
  [/^gemini/, "google"],
  [/^grok/, "xai"],
  [/^minimax/, "minimax"],
  [/^(moonshot|kimi)/, "moonshot"],
  [/^(mistral|devstral|codestral|magistral|ministral|mixtral|pixtral|voxtral)/, "mistral"],
];

/** Subscription plans publish a nominal zero; it must never win a comparison. */
function isPlanZero(entry: PricingEntry): boolean {
  if (entry.cost.input !== 0 || entry.cost.output !== 0) return false;
  const provider = entry.provider.toLowerCase();
  return /coding-plan|token-plan/.test(provider) || provider === "kimi-for-coding";
}

/**
 * Cut a provider namespace: "kilo/xiaomi/mimo" -> "mimo". A ":free" suffix is
 * part of the model id on both sides, so it stays.
 */
export function stripModelPrefix(modelId: string): string {
  const trimmed = modelId.trim();
  if (trimmed === "" || /^ft:/i.test(trimmed)) return trimmed;
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

// models.dev writes a version dot where some ids carry a hyphen ("gemini-3.1"
// vs "gemini-3-1"). Keying both sides through this makes the two comparable.
function dotToDash(id: string): string {
  return id.replace(/\.(\d)/g, "-$1");
}

export function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Resolve a family from a live displayName that is itself already an id
 * ("glm-5.3-flash", "deepseek/deepseek-v4.1-flash"). Prose names are skipped:
 * "Free Models Router" is a router, not a vendor family, and matching it would
 * hand an opaque alias an unrelated price.
 */
function familyFromNameToken(displayName: string): string {
  const token = stripModelPrefix(displayName.trim());
  if (!token || /^ft:/i.test(token)) return "";
  const looksLikeId = /^[a-z0-9][a-z0-9._\-]*$/i.test(token) && /[.\-]/.test(token);
  if (!looksLikeId) return "";
  return familyOf(token, null);
}

function familyOf(modelId: string, displayName: string | null): string {
  const identity = (stripModelPrefix(modelId) || modelId).toLowerCase();
  for (const [pattern, family] of FAMILY_PATTERNS) {
    if (pattern.test(identity)) return family;
  }
  const fromName = displayName ? familyFromNameToken(displayName) : "";
  return fromName;
}

function candidateKeys(modelId: string): string[] {
  const stripped = stripModelPrefix(modelId);
  const keys = new Set<string>([modelId, stripped, dotToDash(modelId), dotToDash(stripped)]);
  return [...keys].map((k) => k.trim().toLowerCase()).filter((k) => k.length > 0);
}

function readCost(value: unknown): ModelCost | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const input = raw["input"];
  const output = raw["output"];
  if (typeof input !== "number" || typeof output !== "number") return null;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  const cacheRead = raw["cache_read"];
  const cacheWrite = raw["cache_write"];
  return {
    input,
    output,
    cacheRead: typeof cacheRead === "number" && cacheRead >= 0 ? cacheRead : 0,
    cacheWrite: typeof cacheWrite === "number" && cacheWrite >= 0 ? cacheWrite : 0,
  };
}

function push(map: Map<string, PricingEntry[]>, key: string, entry: PricingEntry): void {
  const existing = map.get(key);
  if (existing) existing.push(entry);
  else map.set(key, [entry]);
}

/**
 * Build the lookup index from a parsed models.dev catalog. Pure: no network,
 * no cache, so it can be tested against a fixture.
 */
export function buildPricingIndex(catalog: unknown): PricingIndex {
  const byId = new Map<string, PricingEntry[]>();
  const byName = new Map<string, PricingEntry[]>();
  if (!catalog || typeof catalog !== "object") return { byId, byName };

  for (const providerCatalog of Object.values(catalog as Record<string, unknown>)) {
    if (!providerCatalog || typeof providerCatalog !== "object") continue;
    const providerId = String((providerCatalog as Record<string, unknown>)["id"] ?? "").trim();
    const models = (providerCatalog as Record<string, unknown>)["models"];
    if (!providerId || !models || typeof models !== "object") continue;
    for (const [key, raw] of Object.entries(models as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      const cost = readCost(record["cost"]);
      if (!cost) continue;
      const modelId = typeof record["id"] === "string" && record["id"].length > 0 ? record["id"] : key;
      const status = typeof record["status"] === "string" ? record["status"] : null;
      const entry: PricingEntry = { provider: providerId, modelId, status, cost };
      const ids = new Set<string>([modelId, key]);
      const canonical = record["canonical_model_id"];
      if (typeof canonical === "string" && canonical.includes("/")) {
        ids.add(canonical.slice(canonical.lastIndexOf("/") + 1));
      }
      for (const id of ids) {
        const lower = id.trim().toLowerCase();
        for (const variant of new Set([lower, dotToDash(lower)])) {
          if (variant.length > 0) push(byId, variant, entry);
        }
      }
      const name = record["name"];
      if (typeof name === "string" && name.trim().length > 0) push(byName, normalizeKey(name), entry);
    }
  }
  return { byId, byName };
}

function choose(modelId: string, displayName: string | null, candidates: PricingEntry[]): PricingEntry | null {
  const unique = new Map<string, PricingEntry>();
  for (const entry of candidates) unique.set(entry.provider + "\u0000" + entry.modelId, entry);
  let list = [...unique.values()];
  if (list.some((e) => !isPlanZero(e))) list = list.filter((e) => !isPlanZero(e));

  // A price is only trusted when the model's vendor family is identifiable AND
  // that family's official catalog carries the row. An opaque CPA alias (say
  // "parrot" over a GLM backend) has no family of its own, and its id can
  // collide with an unrelated reseller's row; borrowing that number would put
  // a wrong price on the wire, so the model stays at zero instead.
  const family = familyOf(modelId, displayName);
  const official = family ? OFFICIAL_PROVIDERS[family] : undefined;
  if (!official) return null;
  const scoped = list.filter((e) => official.includes(e.provider.toLowerCase()));
  if (scoped.length === 0) return null;
  list = scoped;
  const priority = (entry: PricingEntry): number => {
    const rank = official.indexOf(entry.provider.toLowerCase());
    return rank === -1 ? official.length : rank;
  };
  list.sort((a, b) =>
    priority(a) - priority(b) ||
    (a.status === "deprecated" ? 1 : 0) - (b.status === "deprecated" ? 1 : 0) ||
    (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) ||
    (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0));
  return list[0] ?? null;
}

/**
 * Resolve one model's price. Exact-id keys win over an exact display-name key;
 * nothing here does fuzzy matching, so an unknown alias resolves to null.
 */
export function lookupCost(index: PricingIndex, modelId: string, displayName: string | null = null): ModelCost | null {
  for (const key of candidateKeys(modelId)) {
    const hits = index.byId.get(key);
    if (hits && hits.length > 0) {
      const chosen = choose(modelId, displayName, hits);
      if (chosen) return chosen.cost;
    }
  }
  if (displayName && displayName.trim().length > 0) {
    const hits = index.byName.get(normalizeKey(displayName));
    if (hits && hits.length > 0) {
      const chosen = choose(modelId, displayName, hits);
      if (chosen) return chosen.cost;
    }
  }
  return null;
}
export function resolveCatalogCosts(
  index: PricingIndex,
  models: readonly CatalogModel[],
): Map<string, ModelCost> {
  const costs = new Map<string, ModelCost>();
  for (const model of models) {
    const cost = lookupCost(index, model.id, model.displayName);
    if (cost) costs.set(model.id, cost);
  }
  return costs;
}

// Pricing is best-effort: a fetch failure leaves every model at the zero cost
// it had before and never blocks registration. A failure is remembered for a
// short window so an offline host does not re-attempt on every refresh.
export const DEFAULT_PRICING_TIMEOUT_MS = 3_000;
export const DEFAULT_PRICING_FAILURE_TTL_MS = 60_000;

interface CacheEntry {
  index: PricingIndex;
  fetchedAt: number;
}

let cached: CacheEntry | null = null;
let failureAt: number | null = null;
let inFlight: { token: symbol; promise: Promise<PricingIndex | null> } | null = null;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function pricingTtl(): number {
  return envMs("OMO_CPA_PRICING_TTL_MS", DEFAULT_PRICING_TTL_MS);
}

function failureTtl(): number {
  return envMs("OMO_CPA_PRICING_FAILURE_TTL_MS", DEFAULT_PRICING_FAILURE_TTL_MS);
}

function pricingUrl(): string {
  return process.env["OMO_CPA_PRICING_URL"]?.trim() || MODELS_DEV_URL;
}

/** The catalog currently held in memory, or null when nothing is cached yet. */
export function cachedPricingIndex(): PricingIndex | null {
  return cached?.index ?? null;
}

/** Drop the cached catalog. Used by tests and by an explicit refresh. */
export function clearPricingCache(): void {
  cached = null;
  failureAt = null;
  inFlight = null;
}

export interface FetchPricingOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Caller's abort signal, combined with the timeout so an aborted refresh cancels this fetch too. */
  signal?: AbortSignal;
}

export interface CachedPricingOptions extends FetchPricingOptions {
  force?: boolean;
}

/** Fetch and index the catalog. Returns null on any failure, including abort. */
export async function fetchPricingIndex(
  options: FetchPricingOptions = {},
): Promise<PricingIndex | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PRICING_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  try {
    const response = await fetchImpl(pricingUrl(), { signal });
    if (!response.ok) return null;
    return buildPricingIndex(await response.json());
  } catch {
    return null;
  }
}

/**
 * Serve a fresh index, the last good one while a failure window is open, or
 * null. A fetch already in flight is joined rather than duplicated.
 */
export async function getPricingIndex(
  options: CachedPricingOptions = {},
): Promise<PricingIndex | null> {
  const { force = false, ...fetchOptions } = options;
  const now = Date.now();
  if (!force && cached && now - cached.fetchedAt < pricingTtl()) return cached.index;
  if (!force && failureAt !== null && now - failureAt < failureTtl()) return cached?.index ?? null;
  if (inFlight) return inFlight.promise;
  const token = Symbol("pricing-fetch");
  const promise = (async () => {
    const index = await fetchPricingIndex(fetchOptions);
    if (index) {
      cached = { index, fetchedAt: Date.now() };
      failureAt = null;
    } else {
      failureAt = Date.now();
    }
    return index ?? cached?.index ?? null;
  })().finally(() => {
    // Only clear the slot this call owns, so a newer fetch is not orphaned.
    if (inFlight?.token === token) inFlight = null;
  });
  inFlight = { token, promise };
  return promise;
}
