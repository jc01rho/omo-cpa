/**
 * Secret hygiene. omo-cpa reads an inference key and (optionally) a management
 * key; neither may ever reach the screen, a log line, or JSON output.
 */

const SECRET_PATTERNS: RegExp[] = [
  /\bsenpi-[A-Za-z0-9_-]{4,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

/** Replace anything that looks like a credential with a fixed marker. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "<REDACTED>");
  return out;
}

/** Render a key as a non-reversible presence indicator. Never returns the key. */
export function keyPresence(key: string | undefined | null): string {
  if (!key) return "없음";
  return `설정됨 (${key.length}자)`;
}
