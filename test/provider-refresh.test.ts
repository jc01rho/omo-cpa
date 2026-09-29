import { afterEach, beforeEach, expect, test } from "bun:test";
import { clearCatalogCache } from "../src/catalog.ts";
import { registerCpaProvider } from "../src/provider.ts";
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

beforeEach(() => {
  clearCatalogCache();
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
  clearCatalogCache();
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
