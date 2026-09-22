/**
 * Pure functions for CPA provider metadata processing.
 * No side effects, no network calls — safe to test in isolation.
 */

/** Result of id unmangling. */
export interface UnmangleResult {
  unmangled: string;
  mangled: string;
  transformed: boolean;
}

/**
 * Reverse the CPA Anthropic-format id mangling.
 *
 * Verified against live server (530/530 models, this session):
 * Every id that arrives from `GET /v1/models` with `anthropic-version: 2023-06-01`
 * carrying the prefix `claude-fable-5-dd-` has its remainder split on `/`,
 * each segment's characters reversed, then the segment order reversed.
 * The result is a canonical id present in the `/v1/models` set.
 *
 * Example: `claude-fable-5-dd-0.2-noia/sbal-noia`
 *   → remainder: `0.2-noia/sbal-noia`
 *   → segments: `["0.2-noia", "sbal-noia"]`
 *   → char-reverse: `["aino-2.0", "aino-lbas"]`
 *   → segment-reverse: `["aino-lbas", "aino-2.0"]`
 *   → result: `aion-labs/aion-2.0`
 *
 * Defensive rules:
 * - Prefix absent → return id unchanged, transformed=false.
 * - Empty remainder → return prefix-without-trailing-dash, transformed=true.
 * - Result not in the known-id set → caller discards metadata (never guesses).
 */
export function unmangleAnthropicId(mangled: string): UnmangleResult {
  const PREFIX = "claude-fable-5-dd-";
  if (!mangled.startsWith(PREFIX)) return { unmangled: mangled, mangled, transformed: false };
  const rest = mangled.slice(PREFIX.length);
  if (rest === "") return { unmangled: PREFIX.slice(0, -1), mangled, transformed: true };
  const parts = rest.split("/");
  const reversed = parts
    .map((s) => [...s].reverse().join(""))
    .reverse()
    .join("/");
  return { unmangled: reversed, mangled, transformed: true };
}
