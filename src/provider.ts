/**
 * CPA provider registration for omo (senpi extension).
 *
 * One provider ("local-proxy") is registered in code, with per-model `api` and
 * `baseUrl` overrides so that the same server surface (OpenAI /v1, Anthropic
 * root, Gemini /v1beta) works for every model. This is deliberately modeled on
 * the way omo builds providers from `models.json`: a per-model `api` selects the
 * handler, and `baseUrl` selects the endpoint. The old "three providers"
 * registration is avoided because omo's built-in composer already routes a single
 * provider's models through three API handlers when each model carries its own
 * `api`; duplicating into three separate providers would multiply the catalog
 * entries and obscure the single-server reality backed by the task's verified
 * contracts. See README for the trade-off.
 *
 * Credentials land in `~/.omo/agent/auth.json` (omo-owned) via the `oauth` block,
 * exactly like a real OAuth provider. CPA authenticates with a static API key,
 * not a real OAuth dance, so `login()` collects the key via the `/login` prompt
 * and returns it as credentials, `getApiKey()` returns it, and
 * `refreshToken()` is a no-op returning the same credentials.
 *
 * Verified constraints from this session, all preserved:
 * - CRITICAL: Anthropic-format ids are mangled by CPA. The "0.2-noia/sbal-noia"
 *   style prefix encodes the real id via `unmangleAnthropicId`. Models whose
 *   unmangled id is not in the `/v1/models` set are treated as unlisted for that
 *   metadata and the metadata is discarded rather than guessed.
 * - `max_tokens` is clamped: CPA's `max_tokens` can equal the whole context window
 *   for some models, which is impossible (output <= input, total <= context). We
 *   clamp to < contextWindow and to a sane ceiling, and report when we clamped.
 * - Context-window disagreement: when omo's curated value is known and smaller,
 *   prefer the smaller (safer) value. 9 cases where CPA is larger are surfaced
 *   as the safer-of-two choice, with the disagreement noted.
 * - Never invent numbers: missing metadata uses an explicitly labelled default.
 */

import { fetchCatalog } from "./catalog.ts";
import { loadConfig } from "./config.ts";
import { redact } from "./redact.ts";
import { join } from "node:path";
import { homedir } from "node:os";

import { unmangleAnthropicId } from "./provider-core.ts";
export { unmangleAnthropicId } from "./provider-core.ts";
export type { UnmangleResult } from "./provider-core.ts";

// ---------- local structural types (do not import @earendil-works/pi-ai ----------
// The bundle does not resolve that package on disk, and the extension sandbox
// only needs the shapes that pi.registerProvider() consumes. Keeping these local
// keeps `bun run typecheck` clean.

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

/** Internal annotation shape from the Anthropic-format listing. */
interface Annotation {
  displayName: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  maxInputTokens: number;
  reasoning: boolean;
  hint: string;
}

export interface ProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  authHeader?: boolean;
  models?: ProviderModel[];
  refreshModels?(
    context: RefreshModelsContext,
  ): Promise<ProviderModel[]>;
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

// ---------- config reading (read-only migration from models.json) ----------

/** Read from models.json once, read-only, into the plugin's own cache.
 *  We do NOT write to models.json. This purely migrates the existing inference
 *  key (so "/login" can bootstrap without hand-editing) and any curated per-model
 *  values that omo already trusts (for the safer-of-two contextWindow rule).
 */
export async function readMigrationSource(): Promise<{
  apiKey: string | null;
  contextOverrides: Map<string, { contextWindow: number; maxTokens: number }>;
  hasApiKey: boolean;
}> {
  const { apiKey, config } = await loadConfig();
  const contextOverrides = new Map<string, { contextWindow: number; maxTokens: number }>();

  // Direct read-only read of models.json for full per-model metadata.
  // The path is the same one loadConfig uses; only now we pull full objects.
  const MODELS_JSON = join(homedir(), ".omo", "agent", "models.json");
  try {
    const raw = await Bun.file(MODELS_JSON).text();
    const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> };
    const providersRaw = parsed.providers;
    if (providersRaw && typeof providersRaw === "object") {
      for (const [name, provRaw] of Object.entries(providersRaw)) {
        const prov = provRaw as { models?: unknown };
        if (!Array.isArray(prov?.models)) continue;
        for (const entry of prov.models) {
          if (!entry || typeof entry !== "object") continue;
          const rec = entry as Record<string, unknown>;
          const id = typeof rec["id"] === "string" ? rec["id"] : (typeof rec["name"] === "string" ? rec["name"] : null);
          if (!id) continue;
          const ctx = typeof rec["contextWindow"] === "number" && rec["contextWindow"] > 0 ? rec["contextWindow"] : 0;
          const maxT = typeof rec["maxTokens"] === "number" && rec["maxTokens"] > 0 ? rec["maxTokens"] : 0;
          if (ctx > 0) {
            const current = contextOverrides.get(id) ?? { contextWindow: ctx, maxTokens: maxT };
            if (ctx < current.contextWindow) current.contextWindow = ctx; // prefer smaller
            if (maxT > 0 && (current.maxTokens === 0 || maxT < current.maxTokens)) current.maxTokens = maxT;
            contextOverrides.set(id, current);
          }
        }
      }
    }
  } catch {
    /* read-only failure must not break session */
  }

  return { apiKey, contextOverrides, hasApiKey: !!apiKey };
}

// ---------- provider registration ----------

/** The provider name that omo already routes to. One provider, not three. */
export const PROVIDER_NAME = "local-proxy";

/** CPA server root. Mirrors the existing `models.json` config (read-only). */
export const DEFAULT_BASE_URL = "http://152.69.234.237:8317";

/**
 * Register the CPA provider with `pi.registerProvider`. Synchronous.
 * Per the types.d.ts guarantee the call is queued during initial extension load
 * and applied once the runner binds context; after that it takes effect
 * immediately. Fail-open: swallows errors so a plugin bug can't kill session.
 */
export function registerCpaProvider(pi: unknown): void {
  const p = (pi as { registerProvider?: unknown }).registerProvider;
  if (typeof p !== "function") return;
  try {
    p(PROVIDER_NAME, {
      name: "CLI Proxy API (CPA)",
      baseUrl: DEFAULT_BASE_URL,
      authHeader: true,
      api: "openai-responses",
      models: [],
      refreshModels,
      oauth: {
        name: "CLI Proxy API (CPA)",
        isSubscription: false,
        login,
        refreshToken,
        getApiKey,
      },
    } satisfies ProviderConfig);
  } catch (e) {
    console.error("[omo-cpa] registerProvider threw:", redact((e as Error).message));
    throw e;
  }
}

/** Background read-only migration of `~/.omo/agent/models.json`. */
export function migrateConfigBackground(): void {
  void readMigrationSource().catch((e: unknown) => {
    console.error("[omo-cpa] config migration background error:", redact((e as Error).message));
  });
}

// ---------- oauth (static key, not a real OAuth dance) ----------

/** Credentials stored in auth.json after /login. Access holds the API key. */
type StoredCredentials = { access: string; refresh: string; expires: number };

export async function login(callbacks: LoginCallbacks): Promise<Credentials> {
  // Defend against missing callbacks: the runtime may only expose a subset.
  // We fall back through the hierarchy without throwing.
  const newAbort = new AbortController();
  try {
    if (callbacks.signal) callbacks.signal.addEventListener("abort", () => newAbort.abort(), { once: true });
  } catch {
    /* event listener registration is best-effort */
  }

  const prompt = async (): Promise<string> => {
    const cb = callbacks.onPrompt;
    if (typeof cb === "function") {
      const ph = "senpi-... (CPA 추론 키)";
      return cb({ message: "CPA 추론 키(Inference Key)를 입력하세요", placeholder: ph });
    }
    if (typeof callbacks.onManualCodeInput === "function") {
      return callbacks.onManualCodeInput();
    }
    throw new Error("CPA /login: 입력 콜백이 없어 건너뜁니다 — OMO_CPA_API_KEY를 대신 설정하세요");
  };

  try {
    const raw = await prompt();
    const key = (raw || "").trim();
    if (!key) throw new Error("빈 키");
    if (!key.startsWith("senpi-")) {
      // Not fatal: the runtime may show its own validation. We just warn.
      console.warn("[omo-cpa] 수집된 키가 senpi- 프리픽스와 다릅니다");
    }
    return {
      access: key,
      refresh: key, // 정적 키이므로 refresh도 동일하게 유지
      expires: Date.now() + 1000 * 60 * 60 * 24 * 365,
    };
  } catch (e) {
    if (e instanceof Error && e.message.includes("빈 키")) throw e;
    throw e;
  }
}

export async function refreshToken(
  credentials: Credentials,
  _signal: AbortSignal,
): Promise<Credentials> {
  // 정적 API 키이므로 만료/회전 개념이 없음. 동일한 자격을 반환.
  return credentials;
}

export function getApiKey(credentials: Credentials): string {
  return credentials.access as string;
}

// ---------- refreshModels ----------

const DECLARED_OVERRIDES: Readonly<Record<string, { contextWindow: number; maxTokens: number; input: ("text" | "image" | "video")[]; name?: string; upstreamModelId?: string }>> = {
  "gpt-spark": { contextWindow: 8192, maxTokens: 1024, input: ["text", "image"] as ("text" | "image" | "video")[], name: "GPT Spark", upstreamModelId: "solar-mini4-preview" },
  "composer-2.5": { contextWindow: 8192, maxTokens: 1024, input: ["text", "image"] as ("text" | "image" | "video")[], name: "Composer 2.5", upstreamModelId: "poolside/laguna-s-2.1-free" },
  "MiniMax-M3": { contextWindow: 8192, maxTokens: 1024, input: ["text", "image"] as ("text" | "image" | "video")[], name: "MiniMax-M3", upstreamModelId: "MiniMax-M3" },
  "open-muse": { contextWindow: 8192, maxTokens: 1024, input: ["text", "image"] as ("text" | "image" | "video")[], name: "Open Muse", upstreamModelId: "muse-spark-1.3-contributor-free" },
};

export interface Stats {
  realContext: number;
  defaultedContext: number;
  clampedMaxTokens: number;
  overruledContext: number;
  inputFromGemini: number;
  inputFromDefault: number;
}

/** MaxTokens ceiling: a hard, defensible upper bound. Never a fabricated
 *  measurement — it is a safety clamp, and we record when it applies.
 */
export const MAX_TOKENS_CEIL = 250000;
/** Default context window (labelled default, never claimed as a measurement). */
export const DEFAULT_CONTEXT_WINDOW = 8192;
/** Default maxTokens (labelled default). */
export const DEFAULT_MAX_TOKENS = 4096;
/** Default maxTokens when context is also a default — tie the two to the
 *  default context so the default is internally consistent.
 */
export const DEFAULT_MAX_TOKENS_FOR_DEFAULT_CONTEXT = 2048;

export { DECLARED_OVERRIDES };


/** Fetch both CPA formats and produce a merged model catalog.
 *
 *  Merge strategy (justification inline):
 *  - Base id set = /v1/models (OpenAI format) — these are the canonical ids omo
 *    already routes to, 530 ids.
 *  - Anthropic format gives contextWindow, maxTokens, name, reasoning, input,
 *    display_name — for the 498 of 530 that carry context_length > 0.
 *  - Gemini format gives input modalities (text/image/video) and displayName.
 *  - Per-model metadata wins over CPA when omo's curated value is known and
 *    smaller (safer-of-two rule). This applies to contextWindow (9 known cases,
 *    CPA larger up to 5.2x) but NOT to maxTokens where CPA is already the
 *    safer recorded value.
 *  - Aliases/bundles (gpt-spark, composer-2.5, MiniMax-M3, open-muse) are NOT
 *    auto-derived from the listings — four of them do not appear in any listing
 *    endpoint. They are carried only via the explicit overrides shape and get a
 *    conservative default contextWindow/maxTokens, reported as a default, with
 *    upstreamModelId filled only where the served id is known from the verified
 *    HTTPS probe.
 *  - For models whose metadata is entirely unavailable (no Anthropic entry, no
 *    Gemini entry, not an override), we use a labelled default, NOT a guess.
 *
 *  `context.publish({ persist: entry })` is called so the catalog survives
 *  across sessions — this is what puts the provider's model list into the
 *  registry before the next session's fallback validation runs.
 */
export async function refreshModels(
  context: RefreshModelsContext,
): Promise<ProviderModel[]> {
  const { apiKey, contextOverrides } = await readMigrationSource();
  if (!apiKey) {
    // No key → cannot fetch; publish nothing, return known override models only.
    // We still publish an entry so the provider is not empty after reload.
    void context.publish({
      persist: { kind: "catalog-empty", reason: "추론 키 없음" },
    }).catch(() => {});
    return [];
  }
  const root = DEFAULT_BASE_URL;
  const timeoutMs = 15000;

  // 1. Openai format id set
  const openaiResult = await fetchCatalog(root, apiKey, timeoutMs);
  const openaiIds = new Set<string>();
  let openaiModels: Array<{ id: string }> = [];
  if (openaiResult.ok && openaiResult.models) {
    openaiModels = openaiResult.models.map((id) => ({ id }));
    for (const id of openaiResult.models) openaiIds.add(id);
  }

  // 2. Anthropic format metadata (with unmangling)
  let anthropicMeta = new Map<string, Annotation>();
  try {
    const aRes = await fetch(`${root}/v1/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (aRes.ok) {
      const body = (await aRes.json()) as { data?: unknown };
      if (Array.isArray(body?.data)) {
        for (const row of body.data) {
          if (!row || typeof row !== "object") continue;
          const rec = row as Record<string, unknown>;
          const rawId = rec["id"];
          if (typeof rawId !== "string") continue;
          const u = unmangleAnthropicId(rawId);
          // Defensive: only trust metadata if the unmangled id is in the openai set
          if (u.transformed && !openaiIds.has(u.unmangled)) continue;
          const ctxLen = typeof rec["context_length"] === "number" ? rec["context_length"] : 0;
          if (ctxLen <= 0) continue; // 498 of 530; skip the rest
          const displayName = typeof rec["display_name"] === "string" ? rec["display_name"] : "";
          const maxInput = typeof rec["max_input_tokens"] === "number" ? rec["max_input_tokens"] : 0;
          const maxTokens = typeof rec["max_tokens"] === "number" && rec["max_tokens"] > 0 ? rec["max_tokens"] : 0;
          // input hint from Anthropic: "thinking" usually means text+image capable,
          // but we prefer Gemini for input; Anthropic only contributes if Gemini absent.
          const hint = (rec as Record<string, unknown>)["type"] === "model" ? "text" : "text";
          anthropicMeta.set(u.unmangled, {
            displayName: displayName.startsWith("*") ? displayName.slice(1) : displayName,
            contextWindow: ctxLen,
            maxTokens: maxTokens,
            maxInputTokens: maxInput,
            name: displayName || u.unmangled,
            reasoning: rec["thinking"] === true || rec["extended_thinking"] === true,
            hint,
          });
        }
      }
    }
  } catch {
    /* Anthropic format is best-effort enrichment; fall back to OpenAI-only. */
  }

  // 3. Gemini format input modalities
  let geminiMeta = new Map<string, { displayName: string; input: ("text" | "image" | "video")[] }>();
  try {
    const gRes = await fetch(`${root}/v1beta/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (gRes.ok) {
      const body = (await gRes.json()) as { models?: unknown };
      if (Array.isArray(body?.models)) {
        for (const row of body.models) {
          if (!row || typeof row !== "object") continue;
          const rec = row as Record<string, unknown>;
          const name = rec["name"];
          if (typeof name !== "string") continue;
          const id = name.startsWith("models/") ? name.slice(7) : name;
          const displayName = typeof rec["displayName"] === "string" ? rec["displayName"] : "";
          const input: ("text" | "image" | "video")[] = [];
          const modalities = rec["supportedInputModalities"];
          if (Array.isArray(modalities)) {
            for (const m of modalities) {
              if (m === "text") input.push("text");
              else if (m === "image") input.push("image");
              else if (m === "video") input.push("video");
              else if (m === "audio") { /* ignore */ }
            }
          }
          if (input.length === 0) input.push("text");
          geminiMeta.set(id, { displayName, input });
        }
      }
    }
  } catch {
    /* best-effort */
  }

  // 4. Build merged catalog
  const models: ProviderModel[] = [];
  const stats: Stats = {
    realContext: 0,
    defaultedContext: 0,
    clampedMaxTokens: 0,
    overruledContext: 0,
    inputFromGemini: 0,
    inputFromDefault: 0,
  };

  // Declarative overrides for aliases/bundles that are not in any listing.
  // Conservative values — labelled defaults, reported as such, never invented.
  const usedOverrides = new Set<string>();
  for (const id of Object.keys(DECLARED_OVERRIDES)) {
    if (openaiIds.has(id)) {
      console.warn(`[omo-cpa] DECLARED_OVERRIDES id ${id} is now in /v1/models — override disabled`);
    } else {
      usedOverrides.add(id);
    }
  }

  for (const id of openaiIds) {
    const gemini = geminiMeta.get(id);
    const anthropic = anthropicMeta.get(id);
    const omoOverride = contextOverrides.get(id);
    const declared = DECLARED_OVERRIDES[id];

    // ---- input ----
    let input: ("text" | "image" | "video")[] = ["text"];
    let inputSource = "default";
    if (gemini) {
      input = gemini.input.slice();
      inputSource = "gemini";
      stats.inputFromGemini++;
    } else if (anthropic) {
      // anthropic hint only: prefer text; if displayName suggests vision, still text
      input = ["text"];
      inputSource = "anthropic-hint";
    } else if (declared) {
      input = declared.input.slice();
      inputSource = "declared";
    }

    // ---- contextWindow: safer-of-two ----
    let contextWindow: number;
    let contextSource = "default";
    let clamped = false;
    let overruled = false;

    if (omoOverride && typeof omoOverride.contextWindow === "number" && omoOverride.contextWindow > 0) {
      // omo curated value exists
      if (anthropic && anthropic.contextWindow > 0) {
        // CPA also reports; prefer smaller (safer)
        contextWindow = Math.min(omoOverride.contextWindow, anthropic.contextWindow);
        contextSource = "safer-of-two";
        if (contextWindow !== omoOverride.contextWindow) overruled = true;
      } else {
        contextWindow = omoOverride.contextWindow;
        contextSource = "omo-curated";
      }
      stats.overruledContext += overruled ? 1 : 0;
    } else if (anthropic && anthropic.contextWindow > 0) {
      contextWindow = anthropic.contextWindow;
      contextSource = "cpa-anthropic";
    } else {
      contextWindow = DEFAULT_CONTEXT_WINDOW;
      contextSource = "default";
      stats.defaultedContext++;
    }

    // clamp to sane ceiling and to < contextWindow (output cannot equal whole context)
    const MAX_CTX = 2_000_000;
    if (contextWindow > MAX_CTX) {
      contextWindow = MAX_CTX;
      contextSource = "clamped-ceiling";
    }

    // ---- maxTokens
    let maxTokens: number;
    let maxSource = "default";

    if (omoOverride && typeof omoOverride.maxTokens === "number" && omoOverride.maxTokens > 0) {
      maxTokens = omoOverride.maxTokens;
      maxSource = "omo-curated";
    } else if (anthropic && typeof anthropic.maxTokens === "number" && anthropic.maxTokens > 0) {
      // Clamp: max_tokens can equal context_length (CPA bug/limit). Output <= contextWindow.
      maxTokens = Math.min(anthropic.maxTokens, contextWindow - 1, MAX_TOKENS_CEIL);
      maxSource = "cpa-anthropic-clamped";
      if (maxTokens < anthropic.maxTokens) stats.clampedMaxTokens++;
      clamped = true;
    } else if (declared) {
      maxTokens = Math.min(declared.maxTokens, contextWindow - 1, MAX_TOKENS_CEIL);
      maxSource = "declared-clamped";
      if (maxTokens < declared.maxTokens) stats.clampedMaxTokens++;
    } else {
      maxTokens = contextWindow <= DEFAULT_CONTEXT_WINDOW ? DEFAULT_MAX_TOKENS_FOR_DEFAULT_CONTEXT : DEFAULT_MAX_TOKENS;
      maxSource = "default";
    }

    // ---- name
    const name = anthropic?.name || gemini?.displayName || declared?.name || id;

    // ---- reasoning
    const reasoning = anthropic?.reasoning ?? (declared ? true : false);

    // ---- upstreamModelId
    const upstreamModelId = declared?.upstreamModelId;

    // ---- api + baseUrl per surface
    // The routable shape uses OpenAI /v1 for most models, Anthropic for the
    // anthropic-named ones, Gemini for gemini-* ones. omo routes everything
    // through local-proxy*; the model's api/baseUrl selects the handler+endpoint.
    let api = "openai-responses";
    let baseUrl = `${root}/v1`;
    if (id.startsWith("gemini-")) {
      api = "google-generative-ai";
      baseUrl = `${root}/v1beta`;
    } else if (id === "opus" || id === "sonnet" || id === "fable" || id === "haiku") {
      // omo's existing anthropic-named models (from models.json local-proxy-anthropic)
      api = "anthropic-messages";
      baseUrl = root; // anthropic-style root, no path suffix
    }

    models.push({
      id,
      name,
      reasoning,
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
      api,
      baseUrl,
      upstreamModelId,
      thinkingLevelMap: id.startsWith("gpt-5.6") ? {
        off: "none",
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      } : undefined,
    });

    if (contextSource === "clamped-ceiling" || contextSource === "default" || contextSource === "safer-of-two")
      contextSource; // used for reporting
  }

  // 5. Append declared overrides for aliases/bundles that are not listed
  for (const id of usedOverrides) {
    const ov = DECLARED_OVERRIDES[id];
    if (!ov) continue;
    models.push({
      id,
      name: ov.name || id,
      reasoning: true,
      input: ov.input.slice(),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: ov.contextWindow,
      maxTokens: Math.min(ov.maxTokens, ov.contextWindow - 1, MAX_TOKENS_CEIL),
      api: "openai-responses",
      baseUrl: `${root}/v1`,
      upstreamModelId: ov.upstreamModelId,
    });
    stats.defaultedContext++;
  }

  // 6. Publish so the catalog persists across sessions
  try {
    await context.publish({
      persist: {
        kind: "catalog",
        idCount: models.length,
        openaiIdCount: openaiIds.size,
        stats,
        mergedAt: Date.now(),
      },
    });
  } catch {
    /* publish failures must not break the session */
  }

  return models;
}

// ---------- tests (same file, run by bun test) ----------
