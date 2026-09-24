import type { UsageAccount, UsageModelQuota, UsageResult, UsageWindow } from "./types.ts";

/**
 * CPA account usage via the management API.
 *
 * The management API is protected by a key that is separate from the inference
 * key omo uses. Without it every endpoint answers 401, so this module reports
 * "unsupported" with the reason instead of guessing at numbers.
 *
 * GET /v0/management/auth-files answers `{files:[…], observed_at}`. Each entry
 * carries the credential's identity plus an upstream header snapshot under
 * `quota.signals` (and per-model snapshots under `model_quotas.<id>.signals`):
 * flat `Header-Name: "value"` pairs such as
 * `{"X-Codex-Primary-Used-Percent":"39","X-Codex-Primary-Window-Minutes":"10080"}`.
 * Those watermarks are what the report renders; nothing is inferred when the
 * snapshot is empty.
 */
export async function fetchUsage(
  root: string,
  managementKey: string | null,
  timeoutMs = 10000,
): Promise<UsageResult> {
  if (!managementKey) {
    return {
      supported: false,
      reason: "Management 키 없음 · OMO_CPA_MANAGEMENT_KEY를 설정하면 계정별 사용량이 켜집니다",
    };
  }

  let res: Response;
  try {
    res = await fetch(`${root}/v0/management/auth-files`, {
      headers: { Authorization: `Bearer ${managementKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as Error;
    const reason = err.name === "TimeoutError" || err.name === "AbortError"
      ? `관리 API 시간 초과 (${timeoutMs}ms)`
      : `관리 API 오류: ${err.message}`;
    return { supported: false, reason };
  }

  if (res.status === 401 || res.status === 403) {
    return { supported: false, reason: `Management 키가 거부됨 (HTTP ${res.status})` };
  }
  if (!res.ok) {
    return { supported: false, reason: `관리 API 오류 (HTTP ${res.status})` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { supported: false, reason: "관리 API 응답을 해석할 수 없음" };
  }

  const accounts = parseAuthFiles(body);
  if (accounts === null) {
    return {
      supported: false,
      reason: "관리 API 응답 형식을 알 수 없어 사용량을 표시하지 않음 (files/auth_files/data 배열 없음)",
    };
  }
  return { supported: true, accounts, observedAt: newestObservation(body) };
}

/**
 * Parse the auth-files payload into account rows.
 * Returns null when the shape is unrecognised, so the caller can say so rather
 * than render an empty-but-confident table.
 */
export function parseAuthFiles(body: unknown): UsageAccount[] | null {
  const files = authFileList(body);
  if (files === null) return null;

  const out: UsageAccount[] = [];
  for (const item of files) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const signals = signalMap(rec["quota"]);
    // The server reports `active`, `disabled`, or `error`. `status_message` is
    // empty for healthy credentials, so any non-empty one is the error detail.
    const status = (str(rec["status"]) ?? "").toLowerCase();
    const disabled = rec["disabled"] === true || rec["unavailable"] === true || status === "disabled";
    const detail = disabled ? null : str(rec["status_message"]);
    out.push({
      provider: str(rec["provider"]) ?? str(rec["type"]) ?? "unknown",
      label: str(rec["label"]) ?? str(rec["email"]) ?? str(rec["account"]) ?? str(rec["name"]) ?? "(이름 없음)",
      status: disabled ? "off" : status === "error" || detail ? "error" : "ok",
      detail,
      meta: accountMeta(signals),
      windows: deriveWindows(signals),
      models: parseModelQuotas(rec["model_quotas"]),
    });
  }
  return out;
}

/** `{files:[…]}` is the documented envelope; the bare-array and `data` shapes are kept for older builds. */
function authFileList(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return null;
  const rec = body as Record<string, unknown>;
  for (const key of ["files", "auth_files", "data"]) {
    if (Array.isArray(rec[key])) return rec[key] as unknown[];
  }
  return null;
}

/**
 * When the newest credential watermark was captured.
 *
 * The envelope's own `observed_at` is the moment the listing was generated, so
 * it is always "now" and says nothing. Each file's `quota.observed_at` is when
 * that credential's upstream snapshot was taken, which is what can go stale.
 */
function newestObservation(body: unknown): number | null {
  const files = authFileList(body);
  if (files === null) return null;
  let newest: number | null = null;
  for (const item of files) {
    if (!item || typeof item !== "object") continue;
    const raw = str((((item as Record<string, unknown>)["quota"] ?? {}) as Record<string, unknown>)["observed_at"]);
    if (raw === null) continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

/** Reads the `{signals:{…}}` envelope, keeping only string values. */
function signalMap(container: unknown): Record<string, string> {
  if (!container || typeof container !== "object") return {};
  const signals = (container as Record<string, unknown>)["signals"];
  if (!signals || typeof signals !== "object") return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(signals as Record<string, unknown>)) {
    const text = str(value);
    if (text !== null) out[name] = text;
  }
  return out;
}

function parseModelQuotas(raw: unknown): UsageModelQuota[] {
  if (!raw || typeof raw !== "object") return [];
  const out: UsageModelQuota[] = [];
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const windows = deriveWindows(signalMap(value));
    if (windows.length > 0) out.push({ id, windows });
  }
  return out;
}

type WindowField =
  | "used-percent"
  | "utilization"
  | "window-minutes"
  | "reset-at"
  | "reset-after-seconds"
  | "reset"
  | "limit-name"
  | "disabled-reason"
  | "limit-reached"
  | "allowed"
  | "status";

/** Longest suffix first, so `-reset-at` is not read as a window named `…-reset`. */
const WINDOW_FIELDS: WindowField[] = [
  "used-percent",
  "reset-after-seconds",
  "window-minutes",
  "disabled-reason",
  "limit-reached",
  "utilization",
  "limit-name",
  "reset-at",
  "allowed",
  "status",
  "reset",
];

/**
 * Fields that mean "this window cannot serve", independent of its utilization.
 * Upstreams keep reporting the utilization they measured, so a rejected window
 * with 43% utilization must still read as exhausted.
 */
const REJECTION_FIELDS = new Set<WindowField>(["status", "limit-reached", "allowed", "disabled-reason"]);

/** Provider-owned prefixes that carry no display value once the window name is known. */
const NAMESPACE_PREFIXES = ["x-codex-", "anthropic-ratelimit-unified-"];

/** Anthropic reports windows by name instead of by length. */
const NAMED_WINDOWS: Record<string, string> = {
  "": "통합",
  "overage": "overage",
  "primary": "주",
  "secondary": "보조",
  "3h": "3시간",
  "5h": "5시간",
  "7d": "7일",
  "7d_oi": "7일(추가)",
  "code-review": "코드 리뷰",
};

/**
 * Turn one header snapshot into displayable windows.
 *
 * A window is rendered only when the snapshot carries a percentage for it — a
 * bare reset watermark with no utilization would otherwise print as "n/a" and
 * read like a real allowance.
 */
export function deriveWindows(signals: Record<string, string>): UsageWindow[] {
  type Group = {
    remaining: number | null;
    minutes: number | null;
    absolute: number | null;
    relative: number | null;
    rejected: boolean;
  };
  const groups = new Map<string, Group>();
  const limitNames = new Map<string, string>();
  // Signals whose own name is just the provider namespace apply to every window
  // of that snapshot (a credential-wide "limit reached" flag).
  let namespaceRejected = false;

  for (const [name, value] of Object.entries(signals)) {
    const split = splitSignal(name);
    if (split === null) continue;
    if (split.field === "limit-name") {
      limitNames.set(split.key, value);
      continue;
    }
    if (REJECTION_FIELDS.has(split.field)) {
      if (!isWindowRejected(split.field, value)) continue;
      if (isNamespaceWide(split.key)) {
        namespaceRejected = true;
      } else {
        const group = groups.get(split.key) ?? blankGroup();
        group.rejected = true;
        groups.set(split.key, group);
      }
      continue;
    }
    const group = groups.get(split.key) ?? blankGroup();
    if (split.field === "used-percent") {
      const used = num(value);
      if (used !== null) group.remaining = clamp(100 - used);
    } else if (split.field === "utilization") {
      // Anthropic's utilization is a 0..1 fraction of the allowance.
      const fraction = num(value);
      if (fraction !== null && fraction >= 0) group.remaining = clamp((1 - fraction) * 100);
    } else if (split.field === "window-minutes") {
      group.minutes = num(value);
    } else if (split.field === "reset-after-seconds") {
      // A relative watermark: seconds from the moment the upstream answered.
      const seconds = num(value);
      if (seconds !== null && seconds > 0) group.relative = seconds;
    } else {
      group.absolute = epochSecondsToMs(value);
    }
    groups.set(split.key, group);
  }

  const out: UsageWindow[] = [];
  for (const [key, group] of groups) {
    const rejected = group.rejected || namespaceRejected;
    // A zero-length window is an unused slot (Codex reports one when no
    // secondary limit applies), not an allowance or a spent limit.
    if (group.minutes !== null && group.minutes <= 0) continue;
    // Without a percentage there is normally nothing to show — except a window
    // the upstream refused, which is spent whether or not it reported a value.
    if (group.remaining === null && !rejected) continue;
    const limit = matchLimitName(key, limitNames);
    // An absolute instant is authoritative; the relative one is a fallback.
    const resetsAt = group.absolute ??
      (group.relative !== null ? Date.now() + group.relative * 1000 : null);
    out.push({
      label: windowLabel(key, group.minutes, limit),
      // Never report an allowance the upstream has already refused.
      remainingPercent: rejected ? 0 : round2(group.remaining ?? 0),
      resetsAt,
      note: rejected ? "한도 도달" : limit?.name ?? null,
    });
  }
  return out;
}

function blankGroup(): { remaining: number | null; minutes: number | null; absolute: number | null; relative: number | null; rejected: boolean } {
  return { remaining: null, minutes: null, absolute: null, relative: null, rejected: false };
}

/**
 * Whether a rejection-shaped field actually says "refused".
 * `status` uses "allowed*" for healthy; the boolean flags carry an explicit
 * true/false, so `limit-reached=false` means the window is fine; and an empty
 * disabled-reason is the absence of a reason.
 */
function isWindowRejected(field: WindowField, value: string): boolean {
  const text = value.trim().toLowerCase();
  if (text === "") return false;
  if (field === "status") return !text.startsWith("allowed");
  if (field === "allowed") return text === "false" || text === "0" || text === "no";
  if (field === "limit-reached") return text === "true" || text === "1" || text === "yes";
  return true;
}

function stripNamespace(key: string): string {
  for (const prefix of NAMESPACE_PREFIXES) {
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  }
  return key;
}

/**
 * `X-Codex-Limit-Reached` names no window, so it speaks for the credential.
 * The key keeps the namespace without its trailing dash (`x-codex`).
 */
function isNamespaceWide(key: string): boolean {
  return NAMESPACE_PREFIXES.some((prefix) => key === prefix.slice(0, -1));
}

function splitSignal(name: string): { key: string; field: WindowField } | null {
  const lower = name.toLowerCase();
  for (const field of WINDOW_FIELDS) {
    if (lower.endsWith(`-${field}`)) {
      return { key: lower.slice(0, lower.length - field.length - 1), field };
    }
  }
  return null;
}

/**
 * Codex namespaces an extra limit by a short id (`x-codex-additional-<id>-primary-…`)
 * and carries its human name in a sibling `…-limit-name` signal.
 */
function matchLimitName(
  key: string,
  limitNames: Map<string, string>,
): { name: string; rest: string } | null {
  let best: { name: string; rest: string } | null = null;
  for (const [limitKey, name] of limitNames) {
    if (!key.startsWith(`${limitKey}-`)) continue;
    const rest = key.slice(limitKey.length + 1);
    if (best === null || rest.length < best.rest.length) best = { name, rest };
  }
  return best;
}

function windowLabel(
  key: string,
  minutes: number | null,
  limit: { name: string; rest: string } | null,
): string {
  const scope = stripNamespace(limit === null ? key : limit.rest);
  const base = minutes !== null ? minutesLabel(minutes) : NAMED_WINDOWS[scope] ?? scope.replace(/-/g, " ");
  return limit === null ? base : `${limit.name} ${base}`;
}

function minutesLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}일`;
  if (minutes % 60 === 0) return `${minutes / 60}시간`;
  return `${minutes}분`;
}

/** Compact scalar summary: plan, active limit, credits, unified rate-limit status. */
function accountMeta(signals: Record<string, string>): string | null {
  const read = signalReader(signals);
  const parts: string[] = [];
  const plan = read("X-Codex-Plan-Type");
  if (plan !== null) parts.push(`요금제 ${plan}`);
  const activeLimit = read("X-Codex-Active-Limit");
  if (activeLimit !== null) parts.push(`한도 ${activeLimit}`);
  if ((read("X-Codex-Credits-Has-Credits") ?? "").toLowerCase() === "true") {
    parts.push(`크레딧 ${read("X-Codex-Credits-Balance") ?? "?"}`);
  }
  const unified = read("Anthropic-Ratelimit-Unified-Status");
  if (unified !== null) parts.push(`통합 ${unified}`);
  const overage = read("Anthropic-Ratelimit-Unified-Overage-Status");
  if (overage !== null) parts.push(`overage ${overage}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Header names are case-insensitive; the API returns them canonicalized. */
function signalReader(signals: Record<string, string>): (name: string) => string | null {
  const byLower = new Map<string, string>();
  for (const [name, value] of Object.entries(signals)) byLower.set(name.toLowerCase(), value);
  return (name) => byLower.get(name.toLowerCase()) ?? null;
}

function epochSecondsToMs(value: string): number | null {
  const seconds = num(value);
  // Watermarks are epoch seconds; a non-positive value means "no window".
  if (seconds === null || seconds <= 0) return null;
  return seconds * 1000;
}

function clamp(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
