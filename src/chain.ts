import type { CatalogModel, Tier, TierDecision } from "./tier-types.ts";

/** Two alternatives per primary family leaves useful redundancy without a wall. */
export const PRIMARY_CHAIN_LIMIT = 14;
/** Six last resorts keep the escape lane diverse while bounding worst-case retries. */
export const LAST_RESORT_CHAIN_LIMIT = 6;

export type TierProviderNames = Readonly<Record<Tier, string>>;

export interface GenerateFallbackChainsInput {
  catalog: readonly CatalogModel[];
  decisions: readonly TierDecision[];
  providers: TierProviderNames;
  /** Catalog model ids for which setFallbackChain-compatible output is wanted. */
  targets: Iterable<string>;
}

/** Can be handed directly to sessionSettings.setFallbackChain(target, entries). */
export interface FallbackChain {
  target: string;
  entries: string[];
}

interface TieredCatalogModel {
  model: CatalogModel;
  tier: Tier;
}

function descendingNullable(left: number | null, right: number | null): number {
  return (right ?? -1) - (left ?? -1);
}

function lexical(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Rank only from catalog evidence, never from a guessed vendor-name hierarchy.
 * Larger context and output limits come first, then explicit reasoning support
 * and modality breadth. Stable display-name/id tie-breaks make config diffable.
 * The same capability ordering puts the least-limited junk models first.
 */
function compareCapability(left: CatalogModel, right: CatalogModel): number {
  const context = descendingNullable(left.contextLength, right.contextLength);
  if (context !== 0) return context;

  const output = descendingNullable(left.maxTokens, right.maxTokens);
  if (output !== 0) return output;

  const thinking = Number(right.thinking === true) - Number(left.thinking === true);
  if (thinking !== 0) return thinking;

  const leftModalities = (left.inputModalities?.length ?? 0) + (left.outputModalities?.length ?? 0);
  const rightModalities = (right.inputModalities?.length ?? 0) + (right.outputModalities?.length ?? 0);
  if (leftModalities !== rightModalities) return rightModalities - leftModalities;

  const displayName = lexical(left.displayName ?? "", right.displayName ?? "");
  return displayName !== 0 ? displayName : lexical(left.id, right.id);
}

function qualify(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/**
 * Fill the primary section so every family that is present gets a seat before any
 * family gets a second one, then spend the remaining budget in capability order.
 * A flat top-N lets the two families with the largest context window take every
 * seat, so a single upstream outage skips the other five families entirely.
 * Models without a family keep the plain capability order, which is what the
 * truncation tests describe.
 */
function selectPrimary(
  rankedPrimary: readonly CatalogModel[],
  familyOf: ReadonlyMap<string, TierDecision["family"]>,
  targetId: string,
): string[] {
  const candidates = rankedPrimary.filter(({ id }) => id !== targetId);
  const grouped = candidates.some(({ id }) => familyOf.get(id));
  if (!grouped) return candidates.slice(0, PRIMARY_CHAIN_LIMIT).map(({ id }) => id);

  const buckets = new Map<string, string[]>();
  const none: string[] = [];
  for (const { id } of candidates) {
    const family = familyOf.get(id);
    if (!family) { none.push(id); continue; }
    const bucket = buckets.get(family);
    if (bucket) bucket.push(id);
    else buckets.set(family, [id]);
  }
  const chosen: string[] = [];
  const seen = new Set<string>();
  const families = [...buckets.keys()].sort();
  let round = 0;
  while (chosen.length < PRIMARY_CHAIN_LIMIT) {
    let advanced = false;
    for (const family of families) {
      const id = buckets.get(family)?.[round];
      if (!id || seen.has(id)) continue;
      chosen.push(id);
      seen.add(id);
      advanced = true;
      if (chosen.length >= PRIMARY_CHAIN_LIMIT) break;
    }
    if (!advanced) break;
    round++;
  }
  for (const id of none) {
    if (chosen.length >= PRIMARY_CHAIN_LIMIT) break;
    if (seen.has(id)) continue;
    chosen.push(id);
    seen.add(id);
  }
  return chosen;
}

function tierDecisionsById(decisions: readonly TierDecision[]): Map<string, Tier> {
  const tiers = new Map<string, Tier>();
  for (const { id, tier } of decisions) {
    const existing = tiers.get(id);
    // A classifier should emit one row per id. If duplicated input disagrees,
    // primary wins deterministically rather than accidentally demoting a model.
    if (existing === undefined || tier === "primary") tiers.set(id, tier);
  }
  return tiers;
}

function tieredCatalog(
  catalog: readonly CatalogModel[],
  decisions: readonly TierDecision[],
): TieredCatalogModel[] {
  const tierById = tierDecisionsById(decisions);
  const rowsById = new Map<string, CatalogModel[]>();

  for (const model of catalog) {
    if (!tierById.has(model.id)) continue;
    const rows = rowsById.get(model.id);
    if (rows) rows.push(model);
    else rowsById.set(model.id, [model]);
  }

  const tiered: TieredCatalogModel[] = [];
  for (const [id, rows] of rowsById) {
    const model = [...rows].sort(compareCapability)[0];
    const tier = tierById.get(id);
    if (model && tier) tiered.push({ model, tier });
  }
  return tiered;
}

/**
 * Build explicit, provider-qualified fallback chains with the last-resort lane
 * appended only after every selected primary alternative. Unknown targets are
 * omitted so every emitted selector resolves against the supplied catalog.
 */
export function generateFallbackChains(input: GenerateFallbackChainsInput): FallbackChain[] {
  const models = tieredCatalog(input.catalog, input.decisions);
  if (models.length === 0) return [];

  const rankedPrimary = models
    .filter(({ tier }) => tier === "primary")
    .map(({ model }) => model)
    .sort(compareCapability);
  const familyOf = new Map(input.decisions.map((d) => [d.id, d.family]));
  const rankedLast = models
    .filter(({ tier }) => tier === "last")
    .map(({ model }) => model)
    .sort(compareCapability);
  const modelById = new Map(models.map((entry) => [entry.model.id, entry]));
  const targets = [...new Set(input.targets)]
    .flatMap((id) => {
      const target = modelById.get(id);
      return target ? [target] : [];
    })
    .sort((left, right) => lexical(left.model.id, right.model.id));

  return targets.map((target) => {
    const targetId = target.model.id;
    const primaryEntries = selectPrimary(rankedPrimary, familyOf, targetId)
      .map((id) => qualify(input.providers.primary, id));
    const lastEntries = rankedLast
      .filter(({ id }) => id !== targetId)
      .slice(0, LAST_RESORT_CHAIN_LIMIT)
      .map(({ id }) => qualify(input.providers.last, id));

    return {
      target: qualify(input.providers[target.tier], targetId),
      entries: [...primaryEntries, ...lastEntries],
    };
  });
}
