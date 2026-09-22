import { describe, expect, test } from "bun:test";
import omoCpa from "../src/extension.ts";

/** Minimal stand-in for the omo extension API. */
function mockPi() {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const notes: { msg: string; level: string }[] = [];
  const pi = {
    on: (evt: string, fn: Function) => { handlers.set(evt, fn); },
    registerCommand: (name: string, opts: any) => { commands.set(name, opts); },
    sendMessage: () => {},
  };
  const ctx = { ui: { notify: (msg: string, level = "info") => notes.push({ msg, level }), setStatus: () => {} } };
  return { pi, ctx, handlers, commands, notes };
}

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
