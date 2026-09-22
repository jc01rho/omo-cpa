/** CPA provider registration and catalog-to-runtime model conversion. */
import { fetchCatalog, selectEndpoint } from "./endpoint.ts";
import { loadConfig } from "./config.ts";
import { redact } from "./redact.ts";
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
  thinkingLevelMap?: Record<string, string>;
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
  [key: string]: unknown;
}

export interface ProviderData {
  catalog: CatalogModel[];
  contextOverrides: Map<string, { contextWindow: number; maxTokens: number }>;
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
  contextOverrides: Map<string, { contextWindow: number; maxTokens: number }>;
  hasApiKey: boolean;
} {
  const { apiKey } = loadConfig();
  return { apiKey, contextOverrides: new Map(), hasApiKey: !!apiKey };
}

export const PROVIDER_NAME = "local-proxy";
/** Explicit-only provider: its hook removes it from senpi's implicit family expansion. */
export const LAST_RESORT_PROVIDER_NAME = "local-proxy-last";
export const DEFAULT_BASE_URL = "http://152.69.234.237:8317";

const DECLARED_OVERRIDES: Readonly<Record<string, {
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image" | "video")[];
  name?: string;
  upstreamModelId?: string;
}>> = {
  "gpt-spark": { contextWindow: 8192, maxTokens: 1024, input: ["text", "image"], name: "GPT Spark", upstreamModelId: "solar-mini4-preview" },
  "composer-2.5": { contextWindow: 8192, maxTokens: 1024, input: ["text", "image"], name: "Composer 2.5", upstreamModelId: "poolside/laguna-s-2.1-free" },
  "MiniMax-M3": { contextWindow: 8192, maxTokens: 1024, input: ["text", "image"], name: "MiniMax-M3", upstreamModelId: "MiniMax-M3" },
  "open-muse": { contextWindow: 8192, maxTokens: 1024, input: ["text", "image"], name: "Open Muse", upstreamModelId: "muse-spark-1.3-contributor-free" },
};

export interface Stats {
  realContext: number;
  defaultedContext: number;
  clampedMaxTokens: number;
  overruledContext: number;
  inputFromGemini: number;
  inputFromDefault: number;
}

export const MAX_TOKENS_CEIL = 250000;
export const DEFAULT_CONTEXT_WINDOW = 8192;
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_MAX_TOKENS_FOR_DEFAULT_CONTEXT = 2048;
export { DECLARED_OVERRIDES };

/**
 * Declared aliases are callable even when absent from every listing, so they
 * must still be registered. Their cosmetic id is not their identity: the
 * synthesized row carries the upstream id and the classifier judges that.
 */
function appendDeclaredAliases(catalog: readonly CatalogModel[]): CatalogModel[] {
  const models = catalog.map((model) => {
    const upstreamModelId = DECLARED_OVERRIDES[model.id]?.upstreamModelId;
    return upstreamModelId === undefined ? { ...model } : { ...model, upstreamModelId };
  });
  const present = new Set(models.map(({ id }) => id));
  for (const [id, declared] of Object.entries(DECLARED_OVERRIDES)) {
    if (present.has(id)) continue;
    models.push({
      id,
      ownedBy: null,
      displayName: declared.upstreamModelId ?? id,
      upstreamModelId: declared.upstreamModelId,
      contextLength: null,
      maxTokens: null,
      inputModalities: declared.input.map((item) => item.toUpperCase()),
      outputModalities: null,
      thinking: null,
    });
  }
  return models;
}

/** Build both disjoint provider model sets from the one merged endpoint catalog. */
export function buildProviderRegistration(data: ProviderRegistrationData): TieredProviderData {
  const catalog = appendDeclaredAliases(data.catalog);
  const report = buildTierReport(catalog, data.overrides);
  const stats: Stats = {
    realContext: 0,
    defaultedContext: 0,
    clampedMaxTokens: 0,
    overruledContext: 0,
    inputFromGemini: 0,
    inputFromDefault: 0,
  };
  const converted = new Map<string, ProviderModel>();
  for (const model of catalog) converted.set(model.id, toProviderModel(model, data.contextOverrides, stats));

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
  const apiKey = readMigrationApiKeySync();
  try {
    register(PROVIDER_NAME, providerConfig("primary", tiered?.primaryModels ?? [], apiKey));
    register(LAST_RESORT_PROVIDER_NAME, providerConfig("last", tiered?.lastModels ?? [], apiKey));
  } catch (error) {
    console.error("[omo-cpa] registerProvider threw:", redact((error as Error).message));
    throw error;
  }
}

function providerConfig(tier: Tier, models: ProviderModel[], apiKey: string | null): ProviderConfig {
  const common: ProviderConfig = {
    name: tier === "primary" ? "CLI Proxy API (CPA)" : "CLI Proxy API (CPA Last Resort)",
    baseUrl: DEFAULT_BASE_URL,
    authHeader: true,
    ...(apiKey ? { apiKey } : {}),
    api: "openai-responses",
    models,
    refreshModels: makeRefreshModels(tier),
  };
  const oauth = {
    name: "CLI Proxy API (CPA)",
    isSubscription: false,
    login,
    refreshToken,
    getApiKey,
  };
  if (tier === "last") return { ...common, oauth, fallbackEligible: () => false };
  return { ...common, oauth };
}

function makeRefreshModels(tier: Tier): (context: RefreshModelsContext) => Promise<ProviderModel[]> {
  return async (context) => {
    const migration = readMigrationSource();
    const apiKey = credentialApiKey(context.credential) ?? migration.apiKey;
    if (!apiKey) {
      await publishBestEffort(context, { kind: "catalog-empty", tier, reason: "추론 키 없음" });
      return [];
    }
    const fetched = await fetchCatalog(DEFAULT_BASE_URL, apiKey, { timeoutMs: 15_000 });
    if (!fetched.ok) {
      await publishBestEffort(context, { kind: "catalog-empty", tier, reason: fetched.reason });
      return [];
    }
    const store = await loadOverrideStore();
    const built = buildProviderRegistration({
      catalog: fetched.models,
      contextOverrides: migration.contextOverrides,
      overrides: toOverrideMap(store),
    });
    const models = tier === "primary" ? built.primaryModels : built.lastModels;
    await publishBestEffort(context, {
      kind: "catalog",
      tier,
      idCount: models.length,
      stats: built.stats,
      mergedAt: Date.now(),
    });
    return models;
  };
}

async function publishBestEffort(context: RefreshModelsContext, persist: unknown): Promise<void> {
  try {
    await context.publish({ persist });
  } catch {
    // Registry persistence is best-effort; the in-memory return remains usable.
  }
}

/** Load the live merged catalog for commands that must re-register immediately. */
export async function loadProviderData(options: {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<ProviderData> {
  const migration = readMigrationSource();
  const apiKey = options.apiKey ?? migration.apiKey;
  if (!apiKey) throw new Error("CPA 추론 키가 없습니다. /login local-proxy 또는 OMO_CPA_API_KEY를 설정하세요");
  const result = await fetchCatalog(DEFAULT_BASE_URL, apiKey, {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  if (!result.ok) throw new Error(result.reason);
  return { catalog: result.models, contextOverrides: migration.contextOverrides };
}

function toProviderModel(
  model: CatalogModel,
  contextOverrides: Map<string, { contextWindow: number; maxTokens: number }>,
  stats: Stats,
): ProviderModel {
  const declared = DECLARED_OVERRIDES[model.id];
  const curated = contextOverrides.get(model.id);
  let contextWindow: number;
  if (model.contextLength && curated?.contextWindow) {
    contextWindow = Math.min(model.contextLength, curated.contextWindow);
    if (contextWindow !== model.contextLength || contextWindow !== curated.contextWindow) stats.overruledContext++;
    stats.realContext++;
  } else if (model.contextLength) {
    contextWindow = model.contextLength;
    stats.realContext++;
  } else if (curated?.contextWindow) {
    contextWindow = curated.contextWindow;
    stats.realContext++;
  } else if (declared) {
    contextWindow = declared.contextWindow;
    stats.defaultedContext++;
  } else {
    contextWindow = DEFAULT_CONTEXT_WINDOW;
    stats.defaultedContext++;
  }
  contextWindow = Math.min(contextWindow, 2_000_000);

  const reportedMax = curated?.maxTokens || model.maxTokens || declared?.maxTokens || 0;
  let maxTokens = reportedMax > 0
    ? Math.min(reportedMax, contextWindow - 1, MAX_TOKENS_CEIL)
    : contextWindow <= DEFAULT_CONTEXT_WINDOW ? DEFAULT_MAX_TOKENS_FOR_DEFAULT_CONTEXT : DEFAULT_MAX_TOKENS;
  if (maxTokens < reportedMax) stats.clampedMaxTokens++;
  if (maxTokens <= 0) maxTokens = 1;

  const input = inputModalities(model.inputModalities, declared?.input);
  if (model.inputModalities) stats.inputFromGemini++;
  else stats.inputFromDefault++;

  const endpoint = selectEndpoint(model);
  const api = endpoint.endpoint === "anthropic"
    ? "anthropic-messages"
    : endpoint.endpoint === "gemini" ? "google-generative-ai" : "openai-responses";

  return {
    id: model.id,
    name: (declared?.name || model.displayName?.replace(/^\*/, "") || model.id),
    reasoning: model.thinking ?? !!declared,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    api,
    baseUrl: `${DEFAULT_BASE_URL}${endpoint.baseUrlSuffix}`,
    upstreamModelId: declared?.upstreamModelId,
    thinkingLevelMap: model.id.startsWith("gpt-5.6") ? {
      off: "none", minimal: "minimal", low: "low", medium: "medium",
      high: "high", xhigh: "xhigh", max: "max",
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

/** Synchronous because provider registration itself is synchronous and in-memory. */
function readMigrationApiKeySync(): string | null {
  return process.env["OMO_CPA_API_KEY"]?.trim() || null;
}

/** Kept for call-site compatibility; there is no longer a file to migrate. */
export function migrateConfigBackground(): void {
  // The plugin reads no omo-owned configuration, so there is nothing to do.
}

export async function login(callbacks: LoginCallbacks): Promise<Credentials> {
  const prompt = async (): Promise<string> => {
    if (typeof callbacks.onPrompt === "function") {
      return callbacks.onPrompt({
        message: "CPA 추론 키(Inference Key)를 입력하세요",
        placeholder: "senpi-... (CPA 추론 키)",
      });
    }
    if (typeof callbacks.onManualCodeInput === "function") return callbacks.onManualCodeInput();
    throw new Error("CPA /login: 입력 콜백이 없어 건너뜁니다 — OMO_CPA_API_KEY를 대신 설정하세요");
  };
  const key = (await prompt()).trim();
  if (!key) throw new Error("빈 키");
  if (!key.startsWith("senpi-")) console.warn("[omo-cpa] 수집된 키가 senpi- 프리픽스와 다릅니다");
  return {
    access: key,
    refresh: key,
    expires: Date.now() + 1000 * 60 * 60 * 24 * 365,
  };
}

export async function refreshToken(credentials: Credentials, _signal: AbortSignal): Promise<Credentials> {
  return credentials;
}

export function getApiKey(credentials: Credentials): string {
  return credentials.access;
}
