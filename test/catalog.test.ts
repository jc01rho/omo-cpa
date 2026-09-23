/**
 * The catalog cache exists to stop one refresh round from fanning out into
 * repeated `/v1/models` requests: two providers each own a `refreshModels`,
 * and every uncached fetch hits four list endpoints.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { clearCatalogCache, getCatalog } from "../src/catalog.ts";

const ROOT = "http://cache-test:8317";
const KEY = "senpi-cache-test";

/** Counts list requests and answers all four formats plausibly. */
function countingFetch() {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const body = url.includes("client_version=cpa")
      ? { models: [{ slug: "gpt-5.6-sol", max_context_window: 200_000 }] }
      : url.includes("/v1beta/models")
      ? { models: [{ name: "models/gpt-5.6-sol" }] }
      : { data: [{ id: "gpt-5.6-sol", owned_by: "openai" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { urls, impl };
}

afterEach(() => {
  clearCatalogCache();
  delete process.env["OMO_CPA_CATALOG_TTL_MS"];
});

describe("catalog cache", () => {
  test("one uncached call fans out to the four list endpoints", async () => {
    const { urls, impl } = countingFetch();
    const result = await getCatalog(ROOT, KEY, { fetchImpl: impl });
    expect(result.ok).toBe(true);
    expect(urls).toHaveLength(4);
    expect(result.ok && result.models[0]?.contextLength).toBe(200_000);
  });

  test("a second call inside the TTL issues no request at all", async () => {
    const { urls, impl } = countingFetch();
    await getCatalog(ROOT, KEY, { fetchImpl: impl });
    const before = urls.length;
    await getCatalog(ROOT, KEY, { fetchImpl: impl });
    expect(urls.length).toBe(before);
  });

  test("concurrent callers collapse onto a single fetch round", async () => {
    const { urls, impl } = countingFetch();
    // This is the real shape: both providers refresh at once on session start.
    const [a, b, c] = await Promise.all([
      getCatalog(ROOT, KEY, { fetchImpl: impl }),
      getCatalog(ROOT, KEY, { fetchImpl: impl }),
      getCatalog(ROOT, KEY, { fetchImpl: impl }),
    ]);
    expect(urls).toHaveLength(4);
    expect(a.ok && b.ok && c.ok).toBe(true);
  });

  test("force refetches even while the cached copy is fresh", async () => {
    const { urls, impl } = countingFetch();
    await getCatalog(ROOT, KEY, { fetchImpl: impl });
    await getCatalog(ROOT, KEY, { fetchImpl: impl, force: true });
    expect(urls).toHaveLength(8);
  });

  test("a zero TTL disables reuse", async () => {
    process.env["OMO_CPA_CATALOG_TTL_MS"] = "0";
    const { urls, impl } = countingFetch();
    await getCatalog(ROOT, KEY, { fetchImpl: impl });
    await getCatalog(ROOT, KEY, { fetchImpl: impl });
    expect(urls).toHaveLength(8);
  });

  test("a different key never reuses another key's catalog", async () => {
    const { urls, impl } = countingFetch();
    await getCatalog(ROOT, KEY, { fetchImpl: impl });
    await getCatalog(ROOT, "senpi-other", { fetchImpl: impl });
    expect(urls).toHaveLength(8);
  });

  test("a failed fetch is not cached, so the next call retries", async () => {
    let attempt = 0;
    const impl = (async (input: string | URL | Request) => {
      attempt++;
      // Fail the OpenAI identity source on the first round only.
      if (attempt <= 4) return new Response("nope", { status: 500 });
      const url = String(input);
      const body = url.includes("client_version=cpa")
        ? { models: [{ slug: "gpt-5.6-sol", max_context_window: 200_000 }] }
        : url.includes("/v1beta/models")
        ? { models: [{ name: "models/gpt-5.6-sol" }] }
        : { data: [{ id: "gpt-5.6-sol", owned_by: "openai" }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const first = await getCatalog(ROOT, KEY, { fetchImpl: impl });
    expect(first.ok).toBe(false);
    const second = await getCatalog(ROOT, KEY, { fetchImpl: impl });
    expect(second.ok).toBe(true);
  });
});
