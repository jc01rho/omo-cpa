/**
 * Shared catalog cache.
 *
 * Two providers are registered (primary and last-resort) and each one owns a
 * `refreshModels`, while `/cpa` can ask for the catalog too. Every uncached
 * call fans out to four list endpoints, so without this layer one refresh
 * round produced eight or more list requests against the CPA server.
 *
 * The cache is process-wide and does two things:
 *  - serves a result younger than the TTL without touching the network
 *  - collapses concurrent callers onto one in-flight request
 *
 * Only a successful fetch is cached; a failure must stay retryable.
 */
import { fetchCatalog as fetchCatalogUncached } from "./endpoint.ts";
import type { CatalogFetchResult, FetchCatalogOptions } from "./endpoint.ts";

/** A model list does not churn minute to minute. */
export const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  result: CatalogFetchResult;
  fetchedAt: number;
}

let cached: (CacheEntry & { key: string }) | null = null;
let inFlight: { key: string; token: symbol; promise: Promise<CatalogFetchResult> } | null = null;

function ttl(): number {
  const raw = process.env["OMO_CPA_CATALOG_TTL_MS"];
  if (raw === undefined) return DEFAULT_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_MS;
}

/** Distinct servers and credentials must never share a cached catalog. */
function cacheKey(root: string, apiKey: string): string {
  return `${root}\u0000${apiKey}`;
}

export interface CachedCatalogOptions extends FetchCatalogOptions {
  /** Bypass the cached copy and refetch. Still collapses concurrent callers. */
  force?: boolean;
}

/** Age of the cached catalog in ms, or null when nothing is cached. */
export function cachedCatalogAge(now = Date.now()): number | null {
  return cached ? now - cached.fetchedAt : null;
}

/** Drop the cached catalog. Used by tests and by an explicit refresh. */
export function clearCatalogCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * Fetch the merged catalog, reusing a recent result and joining an in-flight
 * request when one is already running for the same server and key.
 */
export async function getCatalog(
  root: string,
  apiKey: string,
  options: CachedCatalogOptions = {},
): Promise<CatalogFetchResult> {
  const { force = false, ...fetchOptions } = options;
  const key = cacheKey(root, apiKey);
  const now = Date.now();

  if (!force && cached && cached.key === key && now - cached.fetchedAt < ttl()) {
    return cached.result;
  }
  if (inFlight && inFlight.key === key) return inFlight.promise;

  const token = Symbol("catalog-fetch");
  const promise = (async () => {
    try {
      const result = await fetchCatalogUncached(root, apiKey, fetchOptions);
      // A failure stays uncached so the next caller can retry immediately.
      if (result.ok) cached = { key, result, fetchedAt: Date.now() };
      return result;
    } finally {
      // Only clear the slot this call owns, so a newer fetch is not orphaned.
      if (inFlight?.token === token) inFlight = null;
    }
  })();

  inFlight = { key, token, promise };
  return promise;
}
