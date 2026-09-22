import type { CpaConfig } from "./types.ts";

/**
 * The CPA endpoint. The plugin owns its own models through `registerProvider`,
 * so it reads none of omo's configuration files: the tier split is derived from
 * the live catalog, and the key arrives from `/login` through the oauth
 * credential or from the environment for the standalone CLI.
 */
export const DEFAULT_BASE_URL = "http://152.69.234.237:8317";

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
 * Resolve the endpoint and keys from the environment alone. An absent key is
 * not an error here: the extension receives one from its oauth credential.
 */
export function loadConfig(apiKeyOverride?: string | null): LoadedConfig {
  const root = toRoot(process.env["OMO_CPA_BASE_URL"]?.trim() || DEFAULT_BASE_URL);
  const apiKey = apiKeyOverride?.trim() || process.env["OMO_CPA_API_KEY"]?.trim() || null;
  const managementKey = process.env["OMO_CPA_MANAGEMENT_KEY"]?.trim() || null;

  return {
    config: { root, providers: [], source: "env", hasApiKey: !!apiKey, hasManagementKey: !!managementKey },
    apiKey,
    managementKey,
    reason: apiKey ? null : "추론 키 없음 — /login cliproxyapi 또는 OMO_CPA_API_KEY",
  };
}
