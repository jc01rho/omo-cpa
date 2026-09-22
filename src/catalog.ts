import { homedir } from "node:os";
import { join } from "node:path";
import type { CatalogResult } from "./types.ts";

const CACHE_DIR = join(homedir(), ".cache", "omo-cpa");
const CACHE_FILE = join(CACHE_DIR, "catalog.json");

/** Default freshness window. A model list does not churn minute to minute. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface CacheShape {
  models: string[];
  fetchedAt: number;
  root: string;
}

/** Fetch the model list the CPA server actually serves right now. */
export async function fetchCatalog(
  root: string,
  apiKey: string,
  timeoutMs = 8000,
): Promise<CatalogResult> {
  try {
    const res = await fetch(`${root}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, reason: `모델 목록 조회 실패 (HTTP ${res.status})`, models: null, fetchedAt: null };
    }
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body?.data)) {
      // Do not invent a catalog from an unparseable response.
      return { ok: false, reason: "모델 목록 응답을 해석할 수 없음 (data 배열 없음)", models: null, fetchedAt: null };
    }
    const models = body.data
      .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : null))
      .filter((id): id is string => typeof id === "string");
    if (models.length === 0) {
      return { ok: false, reason: "모델 목록이 비어 있음", models: null, fetchedAt: null };
    }
    return { ok: true, models, fetchedAt: Date.now(), source: "network" };
  } catch (e) {
    const err = e as Error;
    const reason = err.name === "TimeoutError" || err.name === "AbortError"
      ? `모델 목록 조회 시간 초과 (${timeoutMs}ms)`
      : `모델 목록 조회 오류: ${err.message}`;
    return { ok: false, reason, models: null, fetchedAt: null };
  }
}

export async function readCache(root: string, ttlMs = DEFAULT_TTL_MS): Promise<CacheShape | null> {
  try {
    const c = (await Bun.file(CACHE_FILE).json()) as CacheShape;
    if (c.root !== root) return null;
    if (!Array.isArray(c.models) || typeof c.fetchedAt !== "number") return null;
    if (Date.now() - c.fetchedAt > ttlMs) return null;
    return c;
  } catch {
    return null;
  }
}

export async function writeCache(root: string, models: string[]): Promise<void> {
  try {
    await Bun.write(CACHE_FILE, JSON.stringify({ root, models, fetchedAt: Date.now() } satisfies CacheShape));
  } catch {
    // A cache write failure must never affect a session.
  }
}

/** Cache-first catalog read. Falls back to a stale cache with an explicit reason. */
export async function getCatalog(
  root: string,
  apiKey: string,
  opts: { ttlMs?: number; timeoutMs?: number; force?: boolean } = {},
): Promise<CatalogResult> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (!opts.force) {
    const cached = await readCache(root, ttlMs);
    if (cached) return { ok: true, models: cached.models, fetchedAt: cached.fetchedAt, source: "cache" };
  }
  const fresh = await fetchCatalog(root, apiKey, opts.timeoutMs);
  if (fresh.ok) {
    await writeCache(root, fresh.models);
    return fresh;
  }
  // Network failed: surface a stale cache, but say so instead of pretending.
  const stale = await readCache(root, Number.POSITIVE_INFINITY);
  if (stale) {
    const ageMin = Math.round((Date.now() - stale.fetchedAt) / 60000);
    return { ok: false, reason: `${fresh.reason} · ${ageMin}분 전 캐시 사용`, models: stale.models, fetchedAt: stale.fetchedAt };
  }
  return fresh;
}
