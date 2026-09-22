import { describe, expect, test } from "bun:test";
import { HealthTracker, parseRetryAfter } from "../src/health.ts";

describe("HealthTracker", () => {
  test("starts unknown", () => {
    expect(new HealthTracker().snapshot().state).toBe("unknown");
  });

  test("200 is ok and clears failures", () => {
    const h = new HealthTracker();
    h.record(500);
    expect(h.record(200).state).toBe("ok");
    expect(h.snapshot().consecutiveFailures).toBe(0);
  });

  test("trips to down only after the threshold", () => {
    const h = new HealthTracker(3);
    expect(h.record(500).state).toBe("degraded");
    expect(h.record(502).state).toBe("degraded");
    expect(h.record(503).state).toBe("down");
  });

  test("429 is rate_limited and records retry time", () => {
    const h = new HealthTracker();
    const snap = h.record(429, { "retry-after": "60" }, 1_000_000);
    expect(snap.state).toBe("rate_limited");
    expect(snap.retryAt).toBe(1_060_000);
  });

  test("4xx does not trip the breaker", () => {
    const h = new HealthTracker();
    const snap = h.record(400);
    expect(snap.state).not.toBe("down");
    expect(snap.consecutiveFailures).toBe(0);
  });

  test("transport failure escalates", () => {
    const h = new HealthTracker(2);
    expect(h.recordFailure("ECONNREFUSED").state).toBe("degraded");
    expect(h.recordFailure("ECONNREFUSED").state).toBe("down");
  });
});

describe("parseRetryAfter", () => {
  test("seconds", () => expect(parseRetryAfter({ "retry-after": "30" }, 1000)).toBe(31000));
  test("absent", () => expect(parseRetryAfter({}, 1000)).toBeNull());
  test("garbage", () => expect(parseRetryAfter({ "retry-after": "soon" }, 1000)).toBeNull());
});
