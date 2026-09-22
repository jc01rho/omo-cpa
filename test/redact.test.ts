import { describe, expect, test } from "bun:test";
import { keyPresence, redact } from "../src/redact.ts";
import { displayWidth, pad } from "../src/render.ts";

describe("redact", () => {
  test("removes senpi inference keys", () => {
    expect(redact("key=senpi-abc123XYZ")).toBe("key=<REDACTED>");
  });
  test("removes bearer tokens", () => {
    expect(redact("Authorization: Bearer abcdef123456")).toContain("<REDACTED>");
  });
  test("removes JWTs", () => {
    expect(redact("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig")).toBe("<REDACTED>");
  });
  test("leaves ordinary text alone", () => {
    expect(redact("모델 3종이 없습니다")).toBe("모델 3종이 없습니다");
  });
});

describe("keyPresence", () => {
  test("never returns the key", () => {
    const out = keyPresence("senpi-supersecret");
    expect(out).not.toContain("supersecret");
    expect(out).toContain("설정됨");
  });
  test("reports absence", () => expect(keyPresence(null)).toBe("없음"));
});

describe("displayWidth", () => {
  test("counts Korean as double width", () => expect(displayWidth("가나")).toBe(4));
  test("counts ascii as single", () => expect(displayWidth("ab")).toBe(2));
  test("pad aligns mixed text", () => expect(displayWidth(pad("가a", 10))).toBe(10));
});
