import type { CpaConfig } from "./types.ts";
import { MANAGEMENT_KEY_FILE, readManagementKey } from "./management-key.ts";

/**
 * The CPA endpoint. The plugin owns its own models through `registerProvider`,
 * so it reads none of omo's routing configuration: the tier split is derived
 * from the live catalog, and the inference key arrives from `/login` or the
 * environment. The management key may also be read from its separate secret file.
 */
export const DEFAULT_BASE_URL = "http://127.0.0.1:8317";

/** Strip the API-version suffix so every form collapses to one server root. */
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

/**
 * Resolve endpoint and keys. An absent inference key is not an error here: the
 * extension receives one from its oauth credential.
 */
export function loadConfig(
  apiKeyOverride?: string | null,
  baseUrlOverride?: string | null,
  managementKeyPath = MANAGEMENT_KEY_FILE,
): LoadedConfig {
  const root = toRoot(baseUrlOverride?.trim() || process.env["OMO_CPA_BASE_URL"]?.trim() || DEFAULT_BASE_URL);
  const apiKey = apiKeyOverride?.trim() || process.env["OMO_CPA_API_KEY"]?.trim() || null;
  const managementKey = process.env["OMO_CPA_MANAGEMENT_KEY"]?.trim() || readManagementKey(managementKeyPath);

  return {
    config: { root, providers: [], source: "env", hasApiKey: !!apiKey, hasManagementKey: !!managementKey },
    apiKey,
    managementKey,
    reason: apiKey ? null : "추론 키 없음 — /login cliproxyapi 또는 OMO_CPA_API_KEY",
  };
}
