/** CPA provider registration and catalog-to-runtime model conversion. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { selectEndpoint } from "./endpoint.ts";
import { getCatalog } from "./catalog.ts";
import { DEFAULT_BASE_URL, loadConfig, toRoot } from "./config.ts";
import { redact } from "./redact.ts";
import { getPricingIndex, resolveCatalogCosts, ZERO_COST } from "./pricing.ts";
import type { ModelCost } from "./pricing.ts";
import { buildTierReport, loadOverrideStore, toOverrideMap } from "./tier.ts";
import type { OverrideMap, TierReport } from "./tier.ts";
import type { CatalogModel, Tier } from "./tier-types.ts";

import { unmangleAnthropicId } from "./provider-core.ts";
export { unmangleAnthropicId } from "./provider-core.ts";
export type { UnmangleResult } from "./provider-core.ts";

export interface ProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image" | "video")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  api?: string;
  baseUrl?: string;
  upstreamModelId?: string;
  thinkingLevelMap?: Record<string, string | null>;
}

export interface ProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  authHeader?: boolean;
  apiKey?: string;
  models?: ProviderModel[];
  refreshModels?(context: RefreshModelsContext): Promise<ProviderModel[]>;
  fallbackEligible?(): boolean;
  oauth?: {
    name: string;
    isSubscription?: boolean;
    login(callbacks: LoginCallbacks): Promise<Credentials>;
    refreshToken(credentials: Credentials, _signal: AbortSignal): Promise<Credentials>;
    getApiKey(credentials: Credentials): string;
  };
}

export interface RefreshModelsContext {
  credential: unknown | undefined;
  signal: AbortSignal;
  allowNetwork?: boolean;
  force?: boolean;
  publish(entry: { persisted?: string; persist?: unknown }): Promise<void>;
}

export interface LoginCallbacks {
  signal?: AbortSignal;
  onPrompt?(prompt: { message: string; placeholder?: string }): Promise<string>;
  onAuth?(event: { url: string }): void | Promise<void>;
  onProgress?(message: string): void;
  onManualCodeInput?: () => Promise<string>;
}

export interface Credentials {
  access: string;
  refresh: string;
  expires: number;
  baseUrl?: string;
  [key: string]: unknown;
}

export interface ProviderData {
  catalog: CatalogModel[];
  contextOverrides: Map<string, { contextWindow: number; maxTokens: number }>;
  /** Per-model price by id, when the pricing catalog resolved one. */
  costs?: ReadonlyMap<string, ModelCost>;
  baseUrl?: string;
}

export interface ProviderRegistrationData extends ProviderData {
  overrides: OverrideMap;
}

export interface TieredProviderData {
  catalog: CatalogModel[];
  report: TierReport;
  primaryModels: ProviderModel[];
  lastModels: ProviderModel[];
  stats: Stats;
}

/**
 * Resolve the inference key. The plugin is independent of omo's `models.json`:
 * the key comes from `/login` (delivered through the oauth credential) or from
 * `OMO_CPA_API_KEY`. `contextOverrides` stays in the shape callers expect and is
 * always empty, since curated limits used to come from that file.
 */
export function readMigrationSource(): {
  apiKey: string | null;
  baseUrl: string;
  contextOverrides: Map<string, { contextWindow: number; maxTokens: number }>;
  hasApiKey: boolean;
} {
  const connection = readConnectionSync();
  return {
    apiKey: connection.apiKey || null,
    baseUrl: connection.baseUrl,
    contextOverrides: new Map(),
    hasApiKey: connection.apiKey.length > 0,
  };
}

export const PROVIDER_NAME = "cliproxyapi";
/** Explicit-only provider: its hook removes it from senpi's implicit family expansion. */
export const LAST_RESORT_PROVIDER_NAME = "cliproxyapi-last";
export { DEFAULT_BASE_URL };

/**
 * Stable, real CPA models used as the persisted last-resort chain tail.
 * They are synthesized when a volatile catalog temporarily omits them so
 * startup validation never sees an unknown selector.
 */
export const STABLE_LAST_RESORT_IDS = [
  "higher-coding",
  "lower-coding",
] as const;

export interface Stats {
  realContext: number;
  defaultedContext: number;
  clampedMaxTokens: number;
  overruledContext: number;
  inputFromGemini: number;
  inputFromCodex: number;
  inputFromDefault: number;
}

export const MAX_TOKENS_CEIL = 250000;
export const DEFAULT_CONTEXT_WINDOW = 8192;
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_MAX_TOKENS_FOR_DEFAULT_CONTEXT = 2048;

/** Keep the stable last-resort tail even when a volatile catalog omits it. */
function appendStableLastResorts(catalog: readonly CatalogModel[]): CatalogModel[] {
  const models = [...catalog];
  const present = new Set(models.map(({ id }) => id));
  for (const id of STABLE_LAST_RESORT_IDS) {
    if (present.has(id)) continue;
    models.push({
      id,
      ownedBy: null,
      displayName: id,
      contextLength: 196_608,
      maxTokens: 65_536,
      inputModalities: ["TEXT", "IMAGE"],
      outputModalities: ["TEXT"],
      thinking: true,
    });
  }
  return models;
}

/** Build both disjoint provider model sets from the one merged endpoint catalog. */
export function buildProviderRegistration(data: ProviderRegistrationData): TieredProviderData {
  const catalog = appendStableLastResorts(data.catalog);
  const report = buildTierReport(catalog, data.overrides);
  const baseUrl = toRoot(data.baseUrl ?? DEFAULT_BASE_URL);
  const stats: Stats = {
    realContext: 0,
    defaultedContext: 0,
    clampedMaxTokens: 0,
    overruledContext: 0,
    inputFromGemini: 0,
    inputFromCodex: 0,
    inputFromDefault: 0,
  };
  const converted = new Map<string, ProviderModel>();
  for (const model of catalog) {
    converted.set(model.id, toProviderModel(model, data.contextOverrides, stats, baseUrl, data.costs?.get(model.id)));
  }

  const select = (ids: readonly { id: string }[]): ProviderModel[] => ids.flatMap(({ id }) => {
    const model = converted.get(id);
    return model ? [model] : [];
  });

  return {
    catalog,
    report,
    primaryModels: select(report.primary),
    // Chat-unfit models remain explicitly selectable, but never enter primary or a chain.
    lastModels: select([...report.last, ...report.chatUnfit]),
    stats,
  };
}

/** Register both providers synchronously. A supplied snapshot takes effect immediately. */
export function registerCpaProvider(pi: unknown, data?: ProviderRegistrationData): void {
  const register = (pi as { registerProvider?: unknown }).registerProvider;
  if (typeof register !== "function") return;
  const tiered = data ? buildProviderRegistration(data) : null;
  const connection = readConnectionSync();
  const baseUrl = toRoot(data?.baseUrl ?? connection.baseUrl);
  try {
    register(PROVIDER_NAME, providerConfig("primary", tiered?.primaryModels ?? [], connection.apiKey, baseUrl));
    register(LAST_RESORT_PROVIDER_NAME, providerConfig("last", tiered?.lastModels ?? [], connection.apiKey, baseUrl));
  } catch (error) {
    console.error("[omo-cpa] registerProvider threw:", redact((error as Error).message));
    throw error;
  }
}

function providerConfig(tier: Tier, models: ProviderModel[], apiKey: string | null, baseUrl: string): ProviderConfig {
  const common: ProviderConfig = {
    name: tier === "primary" ? "CLI Proxy API (CPA)" : "CLI Proxy API (CPA Last Resort)",
    baseUrl,
    authHeader: true,
    ...(apiKey ? { apiKey } : {}),
    api: "openai-responses",
    models,
    refreshModels: makeRefreshModels(tier, models, { apiKey: apiKey ?? "", baseUrl }),
  };
  // Only the primary provider has oauth: one /login covers both tiers.
  // The last-resort provider borrows the credential stored for 'cliproxyapi'
  // from auth.json instead of requiring a second login.
  if (tier === "last") return { ...common, fallbackEligible: () => false };
  const oauth = {
    name: "CLI Proxy API (CPA)",
    isSubscription: false,
    login,
    refreshToken,
    getApiKey,
  };
  return { ...common, oauth };
}

function makeRefreshModels(tier: Tier, registeredModels: ProviderModel[], connection: StoredConnection): (context: RefreshModelsContext) => Promise<ProviderModel[]> {
  let currentConnection = connection;
  let generation = 0;
  return async (context) => {
    const requestGeneration = ++generation;
    context.signal.throwIfAborted();
    const migration = readMigrationSource();
    // readMigrationSource already resolves the shared primary credential and
    // environment overrides for both tiers; do not bypass those for last.
    const apiKey = credentialApiKey(context.credential) ?? migration.apiKey;
    const baseUrl = credentialBaseUrl(context.credential) ?? migration.baseUrl;
    if (currentConnection.apiKey !== (apiKey ?? "") || currentConnection.baseUrl !== baseUrl) {
      registeredModels.splice(0);
      currentConnection = { apiKey: apiKey ?? "", baseUrl };
    }
    if (!apiKey) {
      await publishBestEffort(context, { kind: "catalog-empty", tier, reason: "추론 키 없음" }, registeredModels);
      return [];
    }
    // Reuse an existing snapshot during senpi's restore phase. Its CLI model
    // listing only runs this phase, so a cold CPA registration must still load
    // its catalog, as it did before snapshot preservation was introduced.
    if (context.allowNetwork === false && registeredModels.length > 0) return [...registeredModels];
    // Both providers refresh independently; the shared cache keeps that from
    // multiplying into a second fan-out of list requests. Pricing starts in
    // parallel and is awaited only after the catalog, so a slow or unreachable
    // pricing catalog cannot delay the model list that matters. The catch keeps
    // an abort that lands after an early return (catalog failure, superseded
    // generation) from surfacing as an unhandled rejection.
    const pricingPending = getPricingIndex({ force: context.force === true, signal: context.signal })
      .catch(() => null);
    const fetched = await getCatalog(baseUrl, apiKey, { timeoutMs: 15_000, force: context.force });
    context.signal.throwIfAborted();
    if (requestGeneration !== generation) return [...registeredModels];
    if (!fetched.ok) {
      await publishBestEffort(context, { kind: "catalog-stale", tier, reason: fetched.reason, idCount: registeredModels.length }, registeredModels);
      return [...registeredModels];
    }
    const store = await loadOverrideStore();
    const pricing = await pricingPending;
    // An abort while pricing was pending must not publish a half-refreshed list.
    context.signal.throwIfAborted();
    if (requestGeneration !== generation) return [...registeredModels];
    const built = buildProviderRegistration({
      catalog: fetched.models,
      contextOverrides: migration.contextOverrides,
      overrides: toOverrideMap(store),
      costs: pricing ? resolveCatalogCosts(pricing, fetched.models) : undefined,
      baseUrl,
    });
    const models = tier === "primary" ? built.primaryModels : built.lastModels;
    await publishBestEffort(context, {
      kind: "catalog",
      tier,
      idCount: models.length,
      stats: built.stats,
      mergedAt: Date.now(),
    }, models);
    context.signal.throwIfAborted();
    if (requestGeneration !== generation) return [...registeredModels];
    // registerProvider stores a shallow copy. Preserve this array's identity so
    // the next senpi recomposition starts with these models, not the initial [].
    registeredModels.splice(0, registeredModels.length, ...models);
    return [...registeredModels];
  };
}

export interface StoredConnection {
  apiKey: string;
  baseUrl: string;
}

/**
 * Drop our own stored catalog entry when senpi cannot restore it.
 *
 * senpi replays the persisted payload through `entry.models.filter(...)` before
 * it calls `refreshModels`, so an entry without a `models` array throws there:
 * the provider keeps only what `models.json` declares for that whole session,
 * and because the entry stays on disk every later boot repeats it. Removing it
 * costs one catalog fetch. Other providers' entries are never touched.
 */
export function pruneUnrestorableStoreEntries(
  path: string | undefined = defaultModelsStorePath(),
  providerIds: readonly string[] = [PROVIDER_NAME, LAST_RESORT_PROVIDER_NAME],
): string[] {
  try {
    if (!path || !existsSync(path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const store = parsed as Record<string, unknown>;
    const removed = providerIds.filter((id) => Object.hasOwn(store, id) && !hasRestorableModels(store[id]));
    if (removed.length === 0) return [];
    for (const id of removed) delete store[id];
    writeFileSync(path, JSON.stringify(store, null, 2));
    return [...removed];
  } catch {
    return [];
  }
}

function hasRestorableModels(entry: unknown): boolean {
  return typeof entry === "object" && entry !== null && Array.isArray((entry as { models?: unknown }).models);
}

function defaultModelsStorePath(): string {
  const override = process.env["CODING_AGENT_DIR"]?.trim();
  return join(override && override.length > 0 ? override : join(homedir(), ".omo", "agent"), "models-store.json");
}

/** Read the connection that omo stored after `/login cliproxyapi`. */
export function readStoredPrimaryConnection(
  path = join(homedir(), ".omo", "agent", "auth.json"),
): StoredConnection | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const credential = parsed[PROVIDER_NAME];
    const apiKey = credentialApiKey(credential);
    const baseUrl = credentialBaseUrl(credential);
    return apiKey && baseUrl ? { apiKey, baseUrl } : null;
  } catch {
    return null;
  }
}

/** Backward-compatible helper for callers that only need the inference key. */
export function readStoredPrimaryCredential(path?: string): string | null {
  return readStoredPrimaryConnection(path)?.apiKey ?? null;
}

async function publishBestEffort(
  context: RefreshModelsContext,
  persist: Record<string, unknown>,
  models: ProviderModel[],
): Promise<void> {
  try {
    // senpi restores a stored entry with `entry.models.filter(...)`, so every
    // published payload must carry a models array; one without it makes the
    // next cold start throw inside the restore and drop the whole catalog.
    await context.publish({ persist: { models, ...persist } });
  } catch {
    // Registry persistence is best-effort; the in-memory return remains usable.
  }
}

/** Load the live merged catalog for commands that must re-register immediately. */
export async function loadProviderData(options: {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  force?: boolean;
} = {}): Promise<ProviderData> {
  const migration = readMigrationSource();
  const apiKey = options.apiKey ?? migration.apiKey;
  const baseUrl = toRoot(options.baseUrl ?? migration.baseUrl);
  if (!apiKey) throw new Error("CPA 추론 키가 없습니다. /login cliproxyapi 또는 OMO_CPA_API_KEY를 설정하세요");
  const result = await getCatalog(baseUrl, apiKey, {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.force ? { force: true } : {}),
  });
  if (!result.ok) throw new Error(result.reason);
  // The same injected fetch/timeout applies here so a caller that stubs the
  // network never reaches out for pricing either.
  const pricing = await getPricingIndex({
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.force ? { force: true } : {}),
  });
  return {
    catalog: result.models,
    contextOverrides: migration.contextOverrides,
    ...(pricing ? { costs: resolveCatalogCosts(pricing, result.models) } : {}),
    baseUrl,
  };
}

function toProviderModel(
  model: CatalogModel,
  contextOverrides: Map<string, { contextWindow: number; maxTokens: number }>,
  stats: Stats,
  baseUrl: string,
  cost: ModelCost | undefined,
): ProviderModel {
  const stableLast = STABLE_LAST_RESORT_IDS.includes(model.id as typeof STABLE_LAST_RESORT_IDS[number]);
  // Mistral models (e.g. mistral-large-4) support reasoning_effort high/none,
  // but CPA's /v1/models does not advertise a thinking flag for them. Force
  // reasoning support so omo exposes the thinking level.
  const isMistral = /mistral/i.test(model.id) || /mistral/i.test(model.upstreamModelId ?? "");
  const curated = contextOverrides.get(model.id);
  let contextWindow: number;
  if (stableLast) {
    contextWindow = 196_608;
    stats.realContext++;
  } else if (model.contextLength && curated?.contextWindow) {
    contextWindow = Math.min(model.contextLength, curated.contextWindow);
    if (contextWindow !== model.contextLength || contextWindow !== curated.contextWindow) stats.overruledContext++;
    stats.realContext++;
  } else if (model.contextLength) {
    contextWindow = model.contextLength;
    stats.realContext++;
  } else if (curated?.contextWindow) {
    contextWindow = curated.contextWindow;
    stats.realContext++;
  } else {
    contextWindow = DEFAULT_CONTEXT_WINDOW;
    stats.defaultedContext++;
  }
  contextWindow = Math.min(contextWindow, 2_000_000);

  const reportedMax = stableLast ? 65_536 : curated?.maxTokens || model.maxTokens || 0;
  let maxTokens = reportedMax > 0
    ? Math.min(reportedMax, contextWindow - 1, MAX_TOKENS_CEIL)
    : contextWindow <= DEFAULT_CONTEXT_WINDOW ? DEFAULT_MAX_TOKENS_FOR_DEFAULT_CONTEXT : DEFAULT_MAX_TOKENS;
  if (maxTokens < reportedMax) stats.clampedMaxTokens++;
  if (maxTokens <= 0) maxTokens = 1;

  const input = stableLast ? ["text", "image"] as const : inputModalities(model.inputModalities, undefined);
  // Provenance counts describe what the LISTS declared, so the two
  // synthesized last-resort models (which declare text+image locally) are
  // left out rather than inflating a source they did not come from.
  if (!stableLast) {
    if (model.inputModalities) {
      if (model.inputModalitiesSource === "codex") stats.inputFromCodex++;
      else stats.inputFromGemini++;
    } else stats.inputFromDefault++;
  }

  const endpoint = selectEndpoint(model);
  const api = endpoint.endpoint === "anthropic"
    ? "anthropic-messages"
    : endpoint.endpoint === "gemini" ? "google-generative-ai" : "openai-responses";

  return {
    id: model.id,
    name: (model.displayName?.replace(/^\*/, "") || model.id),
    reasoning: stableLast || isMistral || model.thinking === true,
    input: [...input],
    cost: cost ? { ...cost } : { ...ZERO_COST },
    contextWindow,
    maxTokens,
    api,
    baseUrl: `${baseUrl}${endpoint.baseUrlSuffix}`,
    upstreamModelId: model.upstreamModelId,
    thinkingLevelMap: model.id.startsWith("gpt-5.6") ? {
      off: "none", minimal: "minimal", low: "low", medium: "medium",
      high: "high", xhigh: "xhigh", max: "max",
    } : STABLE_LAST_RESORT_IDS.includes(model.id as typeof STABLE_LAST_RESORT_IDS[number]) ? {
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    } : isMistral ? {
      // Mistral only accepts reasoning_effort "high" or "none". Expose only
      // "high" so omo never sends an unsupported intermediate level.
      off: null, minimal: null, low: null, medium: null,
      high: "high",
      xhigh: null, max: null,
    } : undefined,
  };
}

function inputModalities(
  raw: string[] | null,
  fallback: ("text" | "image" | "video")[] | undefined,
): ("text" | "image" | "video")[] {
  if (raw) {
    const supported = raw
      .map((item) => item.toLowerCase())
      .filter((item): item is "text" | "image" | "video" => item === "text" || item === "image" || item === "video");
    if (supported.length > 0) return [...new Set(supported)];
  }
  return fallback ? [...fallback] : ["text"];
}

function credentialApiKey(credential: unknown): string | null {
  if (!credential || typeof credential !== "object") return null;
  const access = (credential as { access?: unknown }).access;
  return typeof access === "string" && access.length > 0 ? access : null;
}

function credentialBaseUrl(credential: unknown): string | null {
  if (!credential || typeof credential !== "object") return null;
  const value = (credential as { baseUrl?: unknown }).baseUrl;
  return typeof value === "string" && value.length > 0 ? toRoot(value) : null;
}

/** Synchronous because provider registration itself is synchronous and in-memory. */
function readConnectionSync(): StoredConnection {
  const stored = readStoredPrimaryConnection();
  const loaded = loadConfig();
  return {
    apiKey: process.env["OMO_CPA_API_KEY"]?.trim() || stored?.apiKey || "",
    baseUrl: toRoot(process.env["OMO_CPA_BASE_URL"]?.trim() || stored?.baseUrl || loaded.config?.root || DEFAULT_BASE_URL),
  };
}

/** Kept for call-site compatibility; there is no longer a file to migrate. */
export function migrateConfigBackground(): void {
  // The plugin reads no omo-owned configuration, so there is nothing to do.
}

export async function login(callbacks: LoginCallbacks): Promise<Credentials> {
  const prompt = async (message: string, placeholder: string): Promise<string> => {
    if (typeof callbacks.onPrompt === "function") {
      return callbacks.onPrompt({ message, placeholder });
    }
    if (typeof callbacks.onManualCodeInput === "function") return callbacks.onManualCodeInput();
    throw new Error("CPA /login: 입력 콜백이 없어 건너뜁니다 — OMO_CPA_API_KEY를 대신 설정하세요");
  };
  const rawBaseUrl = (await prompt(
    "CPA BASE URL을 입력하세요 (포트 포함)",
    "http://host:8317",
  )).trim();
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new Error("CPA BASE URL 형식이 올바르지 않습니다");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.port) {
    throw new Error("CPA BASE URL은 http(s)와 명시적 포트를 포함해야 합니다");
  }
  const baseUrl = toRoot(parsed.toString());
  const key = (await prompt(
    "CPA 추론 키(Inference Key)를 입력하세요",
    "senpi-... (CPA 추론 키)",
  )).trim();
  if (!key) throw new Error("빈 키");
  if (!key.startsWith("senpi-")) console.warn("[omo-cpa] 수집된 키가 senpi- 프리픽스와 다릅니다");
  return {
    access: key,
    refresh: key,
    expires: Date.now() + 1000 * 60 * 60 * 24 * 365,
    baseUrl,
  };
}

export async function refreshToken(credentials: Credentials, _signal: AbortSignal): Promise<Credentials> {
  return credentials;
}

export function getApiKey(credentials: Credentials): string {
  return credentials.access;
}
