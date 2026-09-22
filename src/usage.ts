import type { UsageAccount, UsageResult, UsageWindow } from "./types.ts";

/**
 * CPA account usage via the management API.
 *
 * The management API is protected by a key that is separate from the inference
 * key omo uses. Without it every endpoint answers 401, so this module reports
 * "unsupported" with the reason instead of guessing at numbers.
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
    return { supported: false, reason: "관리 API 응답 형식을 알 수 없어 사용량을 표시하지 않음" };
  }
  return { supported: true, accounts };
}

/**
 * Parse the auth-files payload into account rows.
 * Returns null when the shape is unrecognised, so the caller can say so rather
 * than render an empty-but-confident table.
 */
export function parseAuthFiles(body: unknown): UsageAccount[] | null {
  const list = Array.isArray(body)
    ? body
    : Array.isArray((body as { auth_files?: unknown })?.auth_files)
      ? ((body as { auth_files: unknown[] }).auth_files)
      : Array.isArray((body as { data?: unknown })?.data)
        ? ((body as { data: unknown[] }).data)
        : null;
  if (!list) return null;

  const out: UsageAccount[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const provider = str(rec["type"]) ?? str(rec["provider"]) ?? "unknown";
    const label = str(rec["label"]) ?? str(rec["name"]) ?? str(rec["email"]) ?? str(rec["index"]) ?? "(이름 없음)";
    const status = rec["disabled"] === true || rec["unavailable"] === true ? "error" : "ok";
    const detail = str(rec["status_message"]) ?? str(rec["error"]) ?? null;
    out.push({ provider, label, status, detail, windows: parseQuota(rec["quota"]) });
  }
  return out;
}

function parseQuota(quota: unknown): UsageWindow[] {
  if (!quota || typeof quota !== "object") return [];
  const rec = quota as Record<string, unknown>;
  const windows: UsageWindow[] = [];
  for (const [label, value] of Object.entries(rec)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const remaining = num(v["remaining_percent"]) ?? num(v["remainingPercent"]);
    const resets = num(v["resets_at"]) ?? num(v["resetsAt"]);
    if (remaining === null && resets === null) continue;
    windows.push({ label, remainingPercent: remaining, resetsAt: resets, note: null });
  }
  return windows;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
