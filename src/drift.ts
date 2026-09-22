import type { DeadModel, DriftReport, Substitute } from "./types.ts";

/** Split a model id into comparable lowercase tokens. */
export function tokenize(id: string): string[] {
  return id.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
}

/**
 * Token weights derived from the live catalog.
 *
 * A token shared by hundreds of models ("gpt", "openai") says almost nothing
 * about identity; a token carried by a handful ("spark", "composer") is the
 * model's actual name. Weighting by rarity (an IDF-style measure computed from
 * the catalog itself, not a hand-tuned list) is what stops "gpt-spark" from
 * being matched to "gpt-5.5" purely because both start with "gpt".
 */
export function buildTokenWeights(live: readonly string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const id of live) {
    for (const t of new Set(tokenize(id))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = Math.max(1, live.length);
  const weights = new Map<string, number>();
  for (const [t, count] of df) weights.set(t, Math.log(n / count) / Math.log(n));
  return weights;
}

/** Weight for a token unseen in the catalog: maximally distinctive. */
const UNSEEN_WEIGHT = 1;

function weightOf(token: string, weights: Map<string, number> | null): number {
  if (!weights) return 1;
  return weights.get(token) ?? UNSEEN_WEIGHT;
}

/**
 * Score how plausible `candidate` is as a stand-in for `dead`, in [0, 1].
 *
 * Rules that matter in practice:
 * - The dead model's single most distinctive token MUST survive in the
 *   candidate. Losing it means a different model family, so the score is 0.
 * - Matching is weighted by token rarity, so shared boilerplate cannot carry
 *   a match on its own.
 * - Extra tokens in the candidate dilute but do not disqualify, which lets
 *   "composer-2.5" reach "grok-composer-2.5-fast".
 */
export function scoreSubstitute(
  dead: string,
  candidate: string,
  weights: Map<string, number> | null = null,
): number {
  const a = tokenize(dead);
  const b = tokenize(candidate);
  if (a.length === 0 || b.length === 0) return 0;

  const setB = new Set(b);
  const shared = a.filter((t) => setB.has(t));
  if (shared.length === 0) return 0;

  // The identity token of the dead model must be preserved.
  let keyToken = a[0]!;
  let keyWeight = -1;
  for (const t of a) {
    const w = weightOf(t, weights);
    if (w > keyWeight) { keyWeight = w; keyToken = t; }
  }
  if (!setB.has(keyToken)) return 0;

  const total = a.reduce((s, t) => s + weightOf(t, weights), 0);
  if (total === 0) return 0;
  const matched = shared.reduce((s, t) => s + weightOf(t, weights), 0);
  const coverage = matched / total;

  // Dilution: unmatched tokens the candidate adds, weighted the same way.
  const extra = b.filter((t) => !a.includes(t)).reduce((s, t) => s + weightOf(t, weights), 0);
  const dilution = extra / (total + extra);

  return Math.max(0, Math.min(1, coverage * (1 - 0.35 * dilution)));
}

/** Minimum score before a substitute is offered at all. */
export const SUBSTITUTE_THRESHOLD = 0.5;

export function suggestSubstitute(
  dead: string,
  live: readonly string[],
  weights: Map<string, number> | null = null,
): Substitute | null {
  const w = weights ?? buildTokenWeights(live);
  let best: Substitute | null = null;
  for (const candidate of live) {
    if (candidate === dead) continue;
    const score = scoreSubstitute(dead, candidate, w);
    if (score < SUBSTITUTE_THRESHOLD) continue;
    if (!best || score > best.score) {
      best = { id: candidate, score, why: `이름 ${Math.round(score * 100)}% 일치` };
    }
  }
  return best;
}

/** Compare what omo declares against what the server actually serves. */
export function computeDrift(
  declared: readonly { provider: string; id: string }[],
  live: readonly string[],
): DriftReport {
  const liveSet = new Set(live);
  const weights = buildTokenWeights(live);
  const dead: DeadModel[] = [];
  let healthy = 0;

  const seen = new Set<string>();
  for (const d of declared) {
    const ref = `${d.provider}/${d.id}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    if (liveSet.has(d.id)) {
      healthy++;
      continue;
    }
    dead.push({ provider: d.provider, id: d.id, ref, substitute: suggestSubstitute(d.id, live, weights) });
  }

  return { checked: seen.size, live: live.length, dead, healthy };
}
