/** Shared shapes. No secret ever enters these types. */

export interface ProviderConfig {
  /** omo provider name, e.g. "local-proxy". */
  name: string;
  /** baseUrl as configured in models.json, e.g. http://host:8317/v1 */
  baseUrl: string;
  /** CPA server root with the API suffix stripped, e.g. http://host:8317 */
  root: string;
  /** Model ids omo declares for this provider. */
  declared: string[];
}

export interface CpaConfig {
  /** CPA server root shared by every local-proxy* provider. */
  root: string;
  providers: ProviderConfig[];
  /** Where the config was read from (for the report). */
  source: string;
  /** True when an inference key was found. The key itself is never stored here. */
  hasApiKey: boolean;
  /** True when a management key was supplied via env. */
  hasManagementKey: boolean;
}

export type CatalogResult =
  | { ok: true; models: string[]; fetchedAt: number; source: "network" | "cache" }
  | { ok: false; reason: string; models: string[] | null; fetchedAt: number | null };

export interface Substitute {
  id: string;
  score: number;
  why: string;
}

export interface DeadModel {
  provider: string;
  id: string;
  ref: string;
  substitute: Substitute | null;
}

export interface DriftReport {
  /** Number of declared model ids compared. */
  checked: number;
  /** Number of models the CPA server actually serves. */
  live: number;
  dead: DeadModel[];
  healthy: number;
}

/** A textual reference found in omo.jsonc (routing/fallback chains). */
export interface ConfigRef {
  line: number;
  provider: string;
  id: string;
  ref: string;
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
  status: "ok" | "error" | "unknown";
  detail: string | null;
  windows: UsageWindow[];
}

export interface UsageWindow {
  label: string;
  remainingPercent: number | null;
  resetsAt: number | null;
  note: string | null;
}
