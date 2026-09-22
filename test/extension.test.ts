import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import omoCpa from "../src/extension.ts";
import { loadOverrideStore } from "../src/tier.ts";
import type { ProviderConfig } from "../src/provider.ts";
import type { CatalogModel } from "../src/tier-types.ts";

/** Minimal stand-in for the omo extension API. */
function mockPi() {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const notes: { msg: string; level: string }[] = [];
  const messages: unknown[] = [];
  const registered: Array<{ name: string; config: ProviderConfig }> = [];
  const pi = {
    on: (evt: string, fn: Function) => { handlers.set(evt, fn); },
    registerCommand: (name: string, opts: any) => { commands.set(name, opts); },
    registerProvider: (name: string, config: ProviderConfig) => { registered.push({ name, config }); },
    sendMessage: (message: unknown) => { messages.push(message); },
  };
  const ctx = { ui: { notify: (msg: string, level = "info") => notes.push({ msg, level }), setStatus: () => {} } };
  return { pi, ctx, handlers, commands, notes, messages, registered };
}

function catalogModel(id: string): CatalogModel {
  return {
    id,
    ownedBy: null,
    displayName: id,
    contextLength: 100_000,
    maxTokens: 8_000,
    inputModalities: ["TEXT"],
    outputModalities: ["TEXT"],
    thinking: false,
  };
}

const tempPaths: string[] = [];
afterAll(async () => {
  await Promise.all(tempPaths.map((path) => rm(path, { recursive: true, force: true })));
});

describe("extension registration", () => {
  test("registers the documented hooks and the /cpa command", () => {
    const { pi, handlers, commands } = mockPi();
    omoCpa(pi);
    for (const evt of ["session_start", "model_select", "before_provider_request", "after_provider_response"]) {
      expect(handlers.has(evt)).toBe(true);
    }
    expect(commands.has("cpa")).toBe(true);
  });
});

describe("/cpa tier", () => {
  test("promote persists the override and immediately re-registers the model in primary", async () => {
    const dir = join(tmpdir(), `omo-cpa-extension-${crypto.randomUUID()}`);
    tempPaths.push(dir);
    const overridePath = join(dir, "tier-overrides.json");
    const { pi, ctx, commands, registered } = mockPi();
    omoCpa(pi, {
      overridePath,
      loadProviderData: async () => ({
        catalog: [catalogModel("gpt-5.6"), catalogModel("cheap-model")],
        contextOverrides: new Map(),
      }),
    });

    const command = commands.get("cpa");
    await command.handler("tier promote cheap-model", ctx);

    const latestPrimary = [...registered].reverse().find(({ name }) => name === "local-proxy");
    expect(latestPrimary?.config.models?.map(({ id }) => id)).toContain("cheap-model");
    expect((await loadOverrideStore(overridePath)).overrides["cheap-model"]?.tier).toBe("primary");
  });
});

describe("/cpa chains", () => {
  test("previews current and generated chains without persisting until apply is explicit", async () => {
    const dir = join(tmpdir(), `omo-cpa-chains-${crypto.randomUUID()}`);
    tempPaths.push(dir);
    const { pi, commands, messages } = mockPi();
    const writes: Array<{ target: string; entries: readonly string[] }> = [];
    const ctx = {
      ui: { notify: () => {}, setStatus: () => {} },
      sessionSettings: {
        getRetryFallbackSettings: () => ({ fallbackChains: { "manual/model": ["manual/backup"] } }),
        setFallbackChain: async (target: string, entries: readonly string[]) => { writes.push({ target, entries }); },
      },
    };
    omoCpa(pi, {
      overridePath: join(dir, "tier-overrides.json"),
      loadProviderData: async () => ({
        catalog: [
          catalogModel("gpt-5.6"),
          catalogModel("claude-sonnet-5"),
          catalogModel("cheap-model"),
          { ...catalogModel("gpt-image-2"), outputModalities: ["IMAGE"] },
        ],
        contextOverrides: new Map(),
      }),
    });
    const command = commands.get("cpa");

    await command.handler("chains", ctx);
    expect(writes).toEqual([]);
    expect(JSON.stringify(messages.at(-1))).toContain("manual/model");

    await command.handler("chains apply", ctx);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.flatMap(({ entries }) => entries).some((entry) => entry.includes("gpt-image-2"))).toBe(false);
  });
});

describe("fail-open behaviour", () => {
  test("handlers swallow malformed events", () => {
    const { pi, ctx, handlers } = mockPi();
    omoCpa(pi);
    expect(() => handlers.get("model_select")!({}, ctx)).not.toThrow();
    expect(() => handlers.get("before_provider_request")!({})).not.toThrow();
    expect(() => handlers.get("after_provider_response")!({}, ctx)).not.toThrow();
    expect(() => handlers.get("model_select")!(null, null)).not.toThrow();
  });

  test("before_provider_request returns undefined when substitution is off", () => {
    const { pi, handlers } = mockPi();
    omoCpa(pi);
    const out = handlers.get("before_provider_request")!({
      model: { provider: "local-proxy", id: "gpt-spark" },
      payload: { model: "gpt-spark" },
    });
    expect(out).toBeUndefined();
  });

  test("non-CPA providers are ignored by the health tracker", () => {
    const { pi, ctx, handlers } = mockPi();
    omoCpa(pi);
    handlers.get("before_provider_request")!({ model: { provider: "anthropic" }, payload: {} });
    expect(() => handlers.get("after_provider_response")!({ status: 500 }, ctx)).not.toThrow();
  });
});
