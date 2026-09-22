import { homedir } from "node:os";
import { join } from "node:path";
import type { CpaConfig, ProviderConfig } from "./types.ts";

/** omo's model registry. Read-only: omo-cpa never writes to it. */
export const MODELS_JSON = join(homedir(), ".omo", "agent", "models.json");
/** omo's main config. Only ever read, and only as text (it is JSONC). */
export const OMO_JSONC = join(homedir(), ".omo", "omo.jsonc");

/** Providers that route to a CPA server. */
const CPA_PROVIDER = /^local-proxy(-anthropic|-gemini)?$/;

/** Strip the API-version suffix so every provider collapses to one server root. */
export function toRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/(v1beta|v1|v0)$/, "");
}

export interface LoadedConfig {
  config: CpaConfig | null;
  /** Inference key. Kept out of CpaConfig so it cannot leak into reports. */
  apiKey: string | null;
  managementKey: string | null;
  reason: string | null;
}

interface ModelsJsonProvider {
  baseUrl?: unknown;
  apiKey?: unknown;
  models?: unknown;
}

function extractIds(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  const ids: string[] = [];
  for (const m of models) {
    if (typeof m === "string") ids.push(m);
    else if (m && typeof m === "object") {
      const rec = m as Record<string, unknown>;
      const id = rec["id"] ?? rec["name"];
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

/**
 * Resolve the CPA endpoint from omo's own configuration, so the plugin always
 * targets whatever server omo is actually using. Env overrides win.
 */
export async function loadConfig(path: string = MODELS_JSON): Promise<LoadedConfig> {
  const envRoot = process.env["OMO_CPA_BASE_URL"]?.trim();
  const envKey = process.env["OMO_CPA_API_KEY"]?.trim();
  const managementKey = process.env["OMO_CPA_MANAGEMENT_KEY"]?.trim() || null;

  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    if (envRoot && envKey) {
      return {
        config: { root: toRoot(envRoot), providers: [], source: "env", hasApiKey: true, hasManagementKey: !!managementKey },
        apiKey: envKey, managementKey, reason: null,
      };
    }
    return { config: null, apiKey: null, managementKey, reason: `omo 모델 설정을 읽을 수 없음: ${path}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { config: null, apiKey: null, managementKey, reason: `models.json 파싱 실패: ${(e as Error).message}` };
  }

  const providersRaw = (parsed as { providers?: Record<string, ModelsJsonProvider> })?.providers;
  if (!providersRaw || typeof providersRaw !== "object") {
    return { config: null, apiKey: null, managementKey, reason: "models.json에 providers 항목이 없음" };
  }

  const providers: ProviderConfig[] = [];
  let apiKey: string | null = envKey || null;

  for (const [name, prov] of Object.entries(providersRaw)) {
    if (!CPA_PROVIDER.test(name)) continue;
    const baseUrl = typeof prov?.baseUrl === "string" ? prov.baseUrl : null;
    if (!baseUrl) continue;
    providers.push({ name, baseUrl, root: toRoot(baseUrl), declared: extractIds(prov?.models) });
    if (!apiKey && typeof prov?.apiKey === "string" && prov.apiKey) apiKey = prov.apiKey;
  }

  if (providers.length === 0) {
    return { config: null, apiKey, managementKey, reason: "local-proxy 계열 provider가 없음 — 이 omo는 CPA를 쓰지 않음" };
  }

  const root = envRoot ? toRoot(envRoot) : providers[0]!.root;

  return {
    config: { root, providers, source: path, hasApiKey: !!apiKey, hasManagementKey: !!managementKey },
    apiKey, managementKey, reason: null,
  };
}

/**
 * Textual scan of omo.jsonc for "provider/model" references. omo.jsonc is JSONC
 * with comments, so this deliberately scans text instead of parsing: it reports
 * line numbers, which is what a human needs in order to fix a routing chain.
 */
export async function scanOmoConfigRefs(path: string = OMO_JSONC): Promise<{ refs: import("./types.ts").ConfigRef[]; reason: string | null }> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return { refs: [], reason: `omo.jsonc를 읽을 수 없음: ${path}` };
  }
  return { refs: parseRefs(text), reason: null };
}

/** Pure: extract provider/model references with line numbers. */
export function parseRefs(text: string): import("./types.ts").ConfigRef[] {
  const out: import("./types.ts").ConfigRef[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    // Skip whole-line comments so commented-out routes are not reported.
    if (/^\s*\/\//.test(line)) return;
    for (const m of line.matchAll(/"(local-proxy(?:-anthropic|-gemini)?)\/([^"]+)"/g)) {
      out.push({ line: i + 1, provider: m[1]!, id: m[2]!, ref: `${m[1]}/${m[2]}` });
    }
  });
  return out;
}
