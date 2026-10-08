import { afterEach, beforeEach, expect, test } from "bun:test";
import { clearCatalogCache } from "../src/catalog.ts";
import { registerCpaProvider } from "../src/provider.ts";
import { clearPricingCache } from "../src/pricing.ts";
import type { ProviderConfig, RefreshModelsContext } from "../src/provider.ts";

let ids: string[];
let status: number;
let requests: number;
let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let entered: ReturnType<typeof Promise.withResolvers<void>>;
let server: ReturnType<typeof Bun.serve>;
let configs: ProviderConfig[];
let oldKey: string | undefined;
let oldBase: string | undefined;
let pricingServer: ReturnType<typeof Bun.serve>;
let oldPricingUrl: string | undefined;

beforeEach(() => {
  clearCatalogCache();
  clearPricingCache();
  // Pricing must never reach the real network from a test. An empty catalog is
  // enough: these tests are about catalog refresh behavior, not price values.
  pricingServer = Bun.serve({ port: 0, fetch: () => Response.json({}) });
  oldPricingUrl = process.env["OMO_CPA_PRICING_URL"];
  process.env["OMO_CPA_PRICING_URL"] = pricingServer.url.href;
  ids = ["gpt-6-sol", "maxrouter-gpt-6-astra"];
  status = 200;
  requests = 0;
  gate = undefined;
  entered = Promise.withResolvers<void>();
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests++;
      entered.resolve();
      await gate?.promise;
      if (status !== 200) return new Response("unavailable", { status });
      const url = new URL(request.url);
      return Response.json(url.search
        ? { models: ids.map((slug) => ({ slug })) }
        : url.pathname.includes("v1beta")
          ? { models: ids.map((id) => ({ name: `models/${id}` })) }
          : { data: ids.map((id) => ({ id })) });
    },
  });
  oldKey = process.env["OMO_CPA_API_KEY"];
  oldBase = process.env["OMO_CPA_BASE_URL"];
  process.env["OMO_CPA_API_KEY"] = "senpi-refresh-test";
  process.env["OMO_CPA_BASE_URL"] = server.url.origin;
  configs = [];
  registerCpaProvider({ registerProvider: (_id: string, config: ProviderConfig) => configs.push(config) });
});

afterEach(() => {
  gate?.resolve();
  server.stop(true);
  pricingServer.stop(true);
  if (oldPricingUrl === undefined) delete process.env["OMO_CPA_PRICING_URL"];
  else process.env["OMO_CPA_PRICING_URL"] = oldPricingUrl;
  clearCatalogCache();
  clearPricingCache();
  if (oldKey === undefined) delete process.env["OMO_CPA_API_KEY"];
  else process.env["OMO_CPA_API_KEY"] = oldKey;
  if (oldBase === undefined) delete process.env["OMO_CPA_BASE_URL"];
  else process.env["OMO_CPA_BASE_URL"] = oldBase;
});

function context(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    credential: { access: "senpi-refresh-test", baseUrl: server.url.origin },
    signal: AbortSignal.timeout(3000),
    allowNetwork: true,
    publish: async () => {},
    ...overrides,
  };
}

async function refresh(overrides: Partial<RefreshModelsContext> = {}) {
  return (await Promise.all(configs.map((config) => {
    if (!config.refreshModels) throw new Error("Missing refresh hook");
    return config.refreshModels(context(overrides));
  }))).flat();
}

const registeredIds = () => configs.flatMap((config) => config.models ?? []).map(({ id }) => id);

test("keeps the registration snapshot populated while a refresh is pending", async () => {
  await refresh();
  const before = registeredIds();
  // senpi shallow-copies the registration, then recomposes from that copy.
  const registered = configs.map((config) => ({ ...config }));
  gate = Promise.withResolvers<void>();
  entered = Promise.withResolvers<void>();
  const pending = refresh({ force: true });
  try {
    await entered.promise;
    expect(before).toContain("maxrouter-gpt-6-astra");
    expect(registered.flatMap((config) => config.models ?? []).map(({ id }) => id)).toEqual(before);
  } finally {
    gate.resolve();
    await pending;
  }
});

test("retains models on a failed refresh", async () => {
  const before = await refresh();
  status = 503;
  const after = await refresh({ force: true });
  expect(after).toEqual(before);
  expect(registeredIds()).toContain("maxrouter-gpt-6-astra");
});

// A cold process has no registration snapshot, so a failed fetch used to return
// nothing even though the store still held the last usable catalog. Every
// fallback chain key then validated as an unknown selector at session start.
test("restores the persisted catalog when a cold fetch fails", async () => {
  await refresh();
  const primary = configs[0];
  if (!primary) throw new Error("primary provider was not registered");
  const primaryIds = (primary.models ?? []).map(({ id }) => id);
  expect(primaryIds.length).toBeGreaterThan(0);
  status = 503;
  const stored = { models: (primary.models ?? []).map((model) => ({ ...model })), tier: "primary" };
  const after = await primary.refreshModels!({
    ...context({ credential: { access: "senpi-fresh", baseUrl: server.url.origin } }),
    stored,
  });
  expect(after.map(({ id }) => id)).toEqual(primaryIds);
});

test("ignores a stored catalog tagged for the other tier", async () => {
  const before = await refresh();
  const primary = configs[0];
  if (!primary) throw new Error("primary provider was not registered");
  status = 503;
  const after = await primary.refreshModels!({
    ...context({ credential: { access: "senpi-fresh", baseUrl: server.url.origin } }),
    stored: { models: before.map((model) => ({ ...model })), tier: "last" },
  });
  expect(after).toEqual([]);
});

test("a failed cold refresh never persists an empty catalog", async () => {
  status = 503;
  const persisted: unknown[] = [];
  const after = await refresh({
    publish: async (entry) => {
      persisted.push((entry as { persist?: unknown }).persist);
    },
  });
  expect(after).toEqual([]);
  const wiped = persisted.some(
    (entry) => Array.isArray((entry as { models?: unknown[] })?.models) && (entry as { models: unknown[] }).models.length === 0,
  );
  expect(wiped).toBe(false);
});

test("retains missing IDs while accepting newly listed IDs", async () => {
  await refresh();
  ids = ["gpt-6-sol", "gpt-6-new"];
  const after = await refresh({ force: true });
  expect(after.map(({ id }) => id)).toContain("maxrouter-gpt-6-astra");
  expect(after.map(({ id }) => id)).toContain("gpt-6-new");
});

test("restore-only refresh does not access the network", async () => {
  const before = await refresh();
  const count = requests;
  const after = await refresh({ allowNetwork: false });
  expect(after).toEqual(before);
  expect(requests).toBe(count);
});

test("cold CLI restore phase loads the catalog before any network phase", async () => {
  const models = await refresh({ allowNetwork: false });
  expect(models.map(({ id }) => id)).toContain("maxrouter-gpt-6-astra");
  expect(registeredIds()).toContain("maxrouter-gpt-6-astra");
  expect(requests).toBe(4);
});

test("force bypasses a fresh cache", async () => {
  await refresh();
  const count = requests;
  ids.push("gpt-6-new");
  const after = await refresh({ force: true });
  expect(requests).toBe(count + 4);
  expect(after.map(({ id }) => id)).toContain("gpt-6-new");
});

test("does not retain another credential's models when its fetch fails", async () => {
  await refresh();
  status = 503;
  const after = await refresh({ credential: { access: "senpi-other", baseUrl: server.url.origin } });
  expect(after).toEqual([]);
  expect(registeredIds()).toEqual([]);
});

test("a cancelled refresh cannot mutate the registration snapshot", async () => {
  await refresh();
  const before = registeredIds();
  const controller = new AbortController();
  const published = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  ids.push("gpt-6-new");
  const pending = refresh({
    force: true,
    signal: controller.signal,
    publish: async () => { published.resolve(); await release.promise; },
  });
  try {
    await published.promise;
    controller.abort();
  } finally {
    release.resolve();
    await expect(pending).rejects.toThrow();
  }
  expect(registeredIds()).toEqual(before);
});

test("a hanging pricing host cannot delay or abort a catalog refresh", async () => {
  const pricing = Bun.serve({
    port: 0,
    fetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return Response.json({});
    },
  });
  const saved = process.env["OMO_CPA_PRICING_URL"];
  process.env["OMO_CPA_PRICING_URL"] = pricing.url.href;
  clearPricingCache();
  const started = Date.now();
  try {
    // A caller deadline well past pricing's 3s cap, so this measures the cap
    // itself rather than racing the caller's own abort.
    const models = await refresh({ force: true, signal: AbortSignal.timeout(10_000) });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(models.map(({ id }) => id)).toContain("gpt-6-sol");
  } finally {
    pricing.stop(true);
    clearPricingCache();
    if (saved === undefined) delete process.env["OMO_CPA_PRICING_URL"];
    else process.env["OMO_CPA_PRICING_URL"] = saved;
  }
});

test("an abort after an early return surfaces no unhandled rejection", async () => {
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(String((reason as { name?: string })?.name ?? reason));
  };
  process.on("unhandledRejection", onUnhandled);

  // Hold the pricing fetch open so it is guaranteed still pending when the
  // refresh is aborted, instead of racing a fixed delay.
  const gate = Promise.withResolvers<void>();
  const pricing = Bun.serve({
    port: 0,
    fetch: async () => {
      await gate.promise;
      return Response.json({});
    },
  });
  const saved = process.env["OMO_CPA_PRICING_URL"];
  process.env["OMO_CPA_PRICING_URL"] = pricing.url.href;
  clearPricingCache();
  const controller = new AbortController();
  try {
    // The catalog fails, so refresh returns before pricing is awaited.
    status = 503;
    await refresh({ signal: controller.signal });
    controller.abort();
    // One macrotask flushes the abort rejection and any unhandled event it
    // would raise; the gated fetch is still pending at this point.
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    gate.resolve();
    process.off("unhandledRejection", onUnhandled);
    pricing.stop(true);
    clearPricingCache();
    if (saved === undefined) delete process.env["OMO_CPA_PRICING_URL"];
    else process.env["OMO_CPA_PRICING_URL"] = saved;
  }
});

test("an older publication cannot overwrite a newer refresh", async () => {
  await refresh();
  const published = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const older = refresh({
    force: true,
    publish: async () => { published.resolve(); await release.promise; },
  });
  try {
    await published.promise;
    ids.push("gpt-6-new");
    await refresh({ force: true });
  } finally {
    release.resolve();
    await older;
  }
  expect(registeredIds()).toContain("gpt-6-new");
});

test("a failed first fetch does not invent a usable catalog", async () => {
  status = 503;
  expect(await refresh()).toEqual([]);
  expect(registeredIds()).toEqual([]);
});

test("published store entries carry a models array for senpi's restore path", async () => {
  const persisted: Record<string, unknown>[] = [];
  await refresh({
    publish: async (publication) => {
      persisted.push(publication.persist as Record<string, unknown>);
    },
  });
  expect(persisted.length).toBe(2);
  for (const entry of persisted) {
    expect(Array.isArray(entry["models"])).toBe(true);
    expect((entry["models"] as unknown[]).length).toBeGreaterThan(0);
  }
});
