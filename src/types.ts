/** Shared shapes. No secret ever enters these types. */

export interface ProviderConfig {
  /** omo provider name, e.g. "cliproxyapi". */
  name: string;
  /** CPA server root with the API suffix stripped, e.g. http://host:8317 */
  root: string;
}

export interface CpaConfig {
  /** CPA server root shared by every cliproxyapi* provider. */
  root: string;
  providers: ProviderConfig[];
  /** Where the config was read from (for the report). */
  source: string;
  /** True when an inference key was found. The key itself is never stored here. */
  hasApiKey: boolean;
  /** True when a management key was supplied via env. */
  hasManagementKey: boolean;
}

export type HealthState = "ok" | "degraded" | "down" | "rate_limited" | "unknown";

export interface HealthSnapshot {
  state: HealthState;
  /** Human-readable reason. Never a fabricated number. */
  detail: string;
  consecutiveFailures: number;
  lastStatus: number | null;
  retryAt: number | null;
  updatedAt: number;
}

export type UsageResult =
  | { supported: false; reason: string }
  | { supported: true; accounts: UsageAccount[] };

export interface UsageAccount {
  provider: string;
  label: string;
  /** `off` = the credential is disabled server-side, not an error. */
  status: "ok" | "error" | "off";
  detail: string | null;
  /** Plan / active limit / credits summary from the same snapshot. */
  meta: string | null;
  windows: UsageWindow[];
  /** Per-model watermarks, for credentials whose quota is model-scoped. */
  models: UsageModelQuota[];
  /**
   * Oldest snapshot instant behind the rows this account renders.
   * Null when the credential carries no watermark at all.
   */
  observedAt: number | null;
}

export interface UsageModelQuota {
  id: string;
  windows: UsageWindow[];
  observedAt: number | null;
}

export interface UsageWindow {
  label: string;
  remainingPercent: number | null;
  resetsAt: number | null;
  note: string | null;
}
