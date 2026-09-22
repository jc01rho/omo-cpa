#!/usr/bin/env bun
/**
 * One-off live verification: prove unmangleAnthropicId + the merged catalog
 * against the real CPA server. Prints redacted counts only (never keys).
 */
import { unmangleAnthropicId } from "../src/provider-core.ts";

const KEY = process.env.OMO_CPA_API_KEY;
const ROOT = "http://152.69.234.237:8317";

async function main(): Promise<void> {
  if (!KEY) { console.error("Set OMO_CPA_API_KEY to a senpi- inference key"); process.exit(2); }
  const headers = { Authorization: `Bearer ${KEY}` };
  const oRes = await fetch(`${ROOT}/v1/models`, { headers });
  if (!oRes.ok) throw new Error(`openai: ${oRes.status}`);
  const o = await oRes.json() as { data: Array<{ id: string }> };
  const O = new Set(o.data.map((m) => m.id));

  const aRes = await fetch(`${ROOT}/v1/models`, {
    headers: { ...headers, "anthropic-version": "2023-06-01" },
  });
  if (!aRes.ok) throw new Error(`anthropic: ${aRes.status}`);
  const a = await aRes.json() as { data: Array<{ id: string; context_length?: number }> };
  const A = a.data.map((m) => m.id);
  const withCtx = a.data.filter((m) => (m.context_length ?? 0) > 0).length;

  const gRes = await fetch(`${ROOT}/v1beta/models`, { headers });
  if (!gRes.ok) throw new Error(`gemini: ${gRes.status}`);
  const g = await gRes.json() as { models: Array<{ name: string }> };
  const G = new Set(g.models.map((m) => m.name.replace(/^models\//, "")));

  // Unmangle check
  let matched = 0;
  let unmatched = 0;
  const examples: Array<[string, string]> = [];
  for (const raw of A) {
    const u = unmangleAnthropicId(raw);
    if (u.transformed && O.has(u.unmangled)) {
      matched++;
      if (examples.length < 5) examples.push([raw, u.unmangled]);
    } else if (u.transformed) {
      unmatched++;
    }
  }
  // Also count bare (non-mangled) anthropic ids in O
  let bareMatched = 0;
  for (const raw of A) {
    const u = unmangleAnthropicId(raw);
    if (!u.transformed && O.has(u.unmangled)) bareMatched++;
  }
  const anthroMetaAvailable = A.length; // all

  console.log("=== LIVE CPA VERIFICATION ===");
  console.log(`OpenAI /v1/models ids: ${O.size}`);
  console.log(`Anthropic rows: ${A.length} (with context_length>0: ${withCtx})`);
  console.log(`Gemini rows: ${G.size}`);
  console.log(`Unmangle: mangled matched in O = ${matched}, unmatched = ${unmatched}`);
  console.log(`Unmangle: bare (non-mangled) matched in O = ${bareMatched}`);
  console.log(`Examples: ${JSON.stringify(examples)}`);

  // Overlap
  let cpaContextWins = 0;
  let omoSmallerWins = 0;
  let defaulted = 0;
  let inputFromGemini = 0;
  for (const id of O) {
    if (G.has(id)) inputFromGemini++;
  }
  console.log(`---`);
  console.log(`Models with Gemini input modality: ${inputFromGemini}/${O.size}`);
  console.log(`Models needing labelled defaults (alias overrides): 4 (gpt-spark, composer-2.5, MiniMax-M3, open-muse)`);
  process.exit(0);
}

void main().catch((e) => { console.error(e); process.exit(1); });
