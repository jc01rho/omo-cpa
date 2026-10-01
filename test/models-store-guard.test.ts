import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneUnrestorableStoreEntries } from "../src/provider.ts";
import omoCpa from "../src/extension.ts";

/**
 * senpi replays every persisted catalog entry through `entry.models.filter(...)`
 * before it calls `refreshModels`, so one entry whose `models` is not an array
 * aborts the refresh for that whole provider. The entry is durable, so every
 * later boot repeats it and the provider stays at whatever `models.json` declares.
 */
function freshStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "omo-cpa-store-")), "models-store.json");
}

function writeStore(content: unknown): string {
  const path = freshStorePath();
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return path;
}

test("an own entry without a models array is dropped so senpi's restore cannot throw", () => {
  const path = writeStore({
    cliproxyapi: { kind: "catalog", tier: "primary", idCount: 59, stats: {}, mergedAt: 1 },
    "cliproxyapi-last": { models: [{ id: "higher-coding" }], kind: "catalog", tier: "last", idCount: 1, mergedAt: 2 },
    "glm-zcode": { models: [] },
  });

  expect(pruneUnrestorableStoreEntries(path)).toEqual(["cliproxyapi"]);

  const after = JSON.parse(readFileSync(path, "utf8")) as Record<string, { models: unknown[] }>;
  expect(Object.keys(after).sort()).toEqual(["cliproxyapi-last", "glm-zcode"]);
  expect(after["cliproxyapi-last"]!.models.filter(Boolean)).toHaveLength(1);
});

test("every unusable shape is dropped: string models, non-object entry, absent models key", () => {
  const path = writeStore({
    cliproxyapi: { models: "higher-coding", kind: "catalog" },
    "cliproxyapi-last": "catalog",
  });

  expect(pruneUnrestorableStoreEntries(path).sort()).toEqual(["cliproxyapi", "cliproxyapi-last"]);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
});

test("a healthy store is left byte-identical and reports nothing removed", () => {
  const path = writeStore({
    cliproxyapi: { models: [], kind: "catalog", tier: "primary", idCount: 59, mergedAt: 1 },
    "cliproxyapi-last": { models: [{ id: "higher-coding" }], kind: "catalog", tier: "last", idCount: 1, mergedAt: 2 },
    "glm-zcode": { models: [], kind: "catalog", idCount: 10, mergedAt: 3 },
  });
  const before = readFileSync(path, "utf8");

  expect(pruneUnrestorableStoreEntries(path)).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("another plugin's broken entry is not ours to delete", () => {
  const path = writeStore({ "glm-zcode": { kind: "catalog", idCount: 10, mergedAt: 3 } });

  expect(pruneUnrestorableStoreEntries(path)).toEqual([]);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "glm-zcode": { kind: "catalog", idCount: 10, mergedAt: 3 } });
});

test("a missing, empty, or corrupt store is not an error", () => {
  expect(pruneUnrestorableStoreEntries(join(tmpdir(), "omo-cpa-absent-store.json"))).toEqual([]);
  expect(pruneUnrestorableStoreEntries(writeStore(""))).toEqual([]);
  expect(pruneUnrestorableStoreEntries(writeStore("{ not json"))).toEqual([]);
  expect(pruneUnrestorableStoreEntries(writeStore([{ cliproxyapi: {} }]))).toEqual([]);
});

test("loading the extension clears our own legacy entry before a refresh could read it", () => {
  const path = writeStore({ cliproxyapi: { kind: "catalog", tier: "primary", idCount: 59, mergedAt: 1 } });
  const pi = { on: () => {}, registerCommand: () => {}, registerProvider: () => {}, sendMessage: () => {} };

  omoCpa(pi, { modelsStorePath: path });

  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
});
