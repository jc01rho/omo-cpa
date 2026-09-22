import type { HealthSnapshot, HealthState } from "./types.ts";

/**
 * Circuit breaker for the CPA endpoint.
 *
 * Attribution caveat: omo's `after_provider_response` event carries only a
 * status and headers - no provider identity. The extension therefore records
 * the provider of the most recent `before_provider_request` and attributes the
 * next response to it. Requests are sequential within a session, so this holds
 * in practice, but it is a heuristic and the report says so.
 */
export class HealthTracker {
  private consecutiveFailures = 0;
  private lastStatus: number | null = null;
  private retryAt: number | null = null;
  private updatedAt = 0;
  private lastDetail = "아직 요청 없음";
  private state: HealthState = "unknown";

  constructor(private readonly downThreshold = 3) {}

  /** Record a completed provider response attributed to CPA. */
  record(status: number, headers: Record<string, string> = {}, now = Date.now()): HealthSnapshot {
    this.lastStatus = status;
    this.updatedAt = now;

    if (status === 429) {
      this.consecutiveFailures++;
      this.retryAt = parseRetryAfter(headers, now);
      this.state = "rate_limited";
      this.lastDetail = this.retryAt
        ? `요청 제한 (HTTP 429) · ${new Date(this.retryAt).toTimeString().slice(0, 5)} 재시도`
        : "요청 제한 (HTTP 429)";
      return this.snapshot();
    }

    if (status >= 500) {
      this.consecutiveFailures++;
      this.state = this.consecutiveFailures >= this.downThreshold ? "down" : "degraded";
      this.lastDetail = `서버 오류 (HTTP ${status}) · 연속 ${this.consecutiveFailures}회`;
      return this.snapshot();
    }

    if (status >= 400) {
      // A 4xx is usually the request's fault, not the server's: do not trip the breaker.
      this.state = this.consecutiveFailures > 0 ? this.state : "ok";
      this.lastDetail = `요청 거부 (HTTP ${status}) — 서버 상태와 무관할 수 있음`;
      return this.snapshot();
    }

    this.consecutiveFailures = 0;
    this.retryAt = null;
    this.state = "ok";
    this.lastDetail = `정상 (HTTP ${status})`;
    return this.snapshot();
  }

  /** Record a transport-level failure (no HTTP status at all). */
  recordFailure(message: string, now = Date.now()): HealthSnapshot {
    this.consecutiveFailures++;
    this.lastStatus = null;
    this.updatedAt = now;
    this.state = this.consecutiveFailures >= this.downThreshold ? "down" : "degraded";
    this.lastDetail = `연결 실패 · 연속 ${this.consecutiveFailures}회 · ${message}`;
    return this.snapshot();
  }

  snapshot(): HealthSnapshot {
    return {
      state: this.state,
      detail: this.lastDetail,
      consecutiveFailures: this.consecutiveFailures,
      lastStatus: this.lastStatus,
      retryAt: this.retryAt,
      updatedAt: this.updatedAt,
    };
  }
}

/** Parse Retry-After (seconds or HTTP date). Returns null when absent/unparseable. */
export function parseRetryAfter(headers: Record<string, string>, now = Date.now()): number | null {
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return now + secs * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? date : null;
}
