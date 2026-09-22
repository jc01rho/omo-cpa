/**
 * Shared vocabulary for CPA tiering. Owned by no single module so the
 * classifier, the endpoint router, and the chain generator can be built and
 * tested independently.
 */

/** Which pool a model belongs to. */
export type Tier = "primary" | "last";

/** The seven families the user designated as primary workhorses. */
export const PRIMARY_FAMILIES = ["muse", "gpt", "claude", "gemini", "glm", "deepseek", "grok"] as const;
export type PrimaryFamily = (typeof PRIMARY_FAMILIES)[number];

/** CPA's three wire formats. One catalog, three shapes. */
export type Endpoint = "openai" | "anthropic" | "gemini";

/**
 * One model as CPA describes it, after merging the three list formats.
 * Every enrichment field is nullable: CPA omits them for part of the catalog
 * and a missing value must stay missing rather than become a guess.
 */
export interface CatalogModel {
  id: string;
  ownedBy: string | null;
  /** CPA's human-readable name. Often the ONLY reliable identity signal: the
   * id `fable` has displayName `claude-fable-5`, `mengmota` is `claude-opus-5`. */
  displayName: string | null;
  contextLength: number | null;
  maxTokens: number | null;
  inputModalities: string[] | null;
  outputModalities: string[] | null;
  thinking: boolean | null;
}

/** Why a model landed in its tier. Shown to the user, so it must be specific. */
export interface TierDecision {
  id: string;
  tier: Tier;
  /** Matched primary family, when one was matched. */
  family: PrimaryFamily | null;
  /** Human-readable justification, e.g. "family claude via displayName". */
  reason: string;
  /** True when a user override decided this, not the automatic rule. */
  overridden: boolean;
}
