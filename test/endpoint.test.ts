import { describe, expect, test } from "bun:test";
import {
  fetchCatalog,
  mergeCatalogs,
  normalizeAnthropicId,
  normalizeGeminiId,
  normalizeOpenAIId,
  selectEndpoint,
} from "../src/endpoint.ts";
import type { CatalogModel } from "../src/tier-types.ts";

const openaiList = (...models: Array<Record<string, unknown>>) => ({ data: models });
const anthropicList = (...models: Array<Record<string, unknown>>) => ({ data: models });
const geminiList = (...models: Array<Record<string, unknown>>) => ({ models });

function catalogModel(id: string, displayName: string | null = null): CatalogModel {
  return {
    id,
    ownedBy: null,
    displayName,
    contextLength: null,
    maxTokens: null,
    inputModalities: null,
    outputModalities: null,
    thinking: null,
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("id normalization", () => {
  test("keeps the OpenAI catalog id unchanged", () => {
    expect(normalizeOpenAIId("openai/gpt-5")).toBe("openai/gpt-5");
  });

  test("strips only Gemini's leading models/ prefix", () => {
    expect(normalizeGeminiId("models/google/gemini-2.5-pro")).toBe("google/gemini-2.5-pro");
    expect(normalizeGeminiId("gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });

  test("recovers CPA's mangled Anthropic id segment-by-segment", () => {
    expect(normalizeAnthropicId("claude-fable-5-dd-0.2-noia/sbal-noia"))
      .toBe("aion-labs/aion-2.0");
  });

  test("leaves an Anthropic id without the bug prefix unchanged", () => {
    expect(normalizeAnthropicId("claude-3-7-sonnet")).toBe("claude-3-7-sonnet");
  });
});

describe("mergeCatalogs", () => {
  test("uses OpenAI ids as the catalog and enriches them from both other formats", () => {
    const result = mergeCatalogs(
      openaiList({ id: "claude-opus", owned_by: "anthropic" }),
      anthropicList({
        id: "claude-fable-5-dd-supo-edualc",
        display_name: "Claude Opus",
        context_length: 200_000,
        max_tokens: 32_000,
        thinking: true,
      }),
      geminiList({
        name: "models/claude-opus",
        displayName: "Claude Opus (Gemini view)",
        supportedInputModalities: ["TEXT", "IMAGE"],
        supportedOutputModalities: ["TEXT"],
      }),
    );

    expect(result.models).toEqual([{
      id: "claude-opus",
      ownedBy: "anthropic",
      displayName: "Claude Opus",
      contextLength: 200_000,
      maxTokens: 32_000,
      inputModalities: ["TEXT", "IMAGE"],
      outputModalities: ["TEXT"],
      thinking: true,
    }]);
  });

  test("keeps every missing enrichment null", () => {
    const result = mergeCatalogs(openaiList({ id: "plain", owned_by: "cpa" }), null, null);
    expect(result.models).toEqual([{
      id: "plain",
      ownedBy: "cpa",
      displayName: null,
      contextLength: null,
      maxTokens: null,
      inputModalities: null,
      outputModalities: null,
      thinking: null,
    }]);
  });

  test("discards Anthropic metadata when its recovered id is absent from OpenAI", () => {
    const result = mergeCatalogs(
      openaiList({ id: "known" }),
      anthropicList({
        id: "claude-fable-5-dd-nwonknu",
        context_length: 123_456,
      }),
      null,
    );

    expect(result.models[0]?.contextLength).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({
      kind: "discarded-metadata",
      endpoint: "anthropic",
      modelId: "unknown",
    }));
  });

  test("prefers the smaller context candidate and exposes the disagreement", () => {
    const result = mergeCatalogs(
      openaiList({ id: "lower-coding" }),
      anthropicList({
        id: "claude-fable-5-dd-gnidoc-rewol",
        context_length: 1_000_000,
        max_input_tokens: 193_000,
      }),
      null,
    );

    expect(result.models[0]?.contextLength).toBe(193_000);
    expect(result.issues).toContainEqual(expect.objectContaining({
      kind: "metadata-disagreement",
      field: "contextLength",
      modelId: "lower-coding",
      values: [1_000_000, 193_000],
      chosen: 193_000,
    }));
  });

  test("clamps an output limit that consumes the whole context window", () => {
    const result = mergeCatalogs(
      openaiList({ id: "grok-4.7" }),
      anthropicList({
        id: "claude-fable-5-dd-7.4-korg",
        context_length: 500_000,
        max_tokens: 500_000,
      }),
      null,
    );

    const model = result.models[0];
    if (!model || model.maxTokens === null || model.contextLength === null) {
      throw new Error("expected merged token limits");
    }
    expect(model.maxTokens).toBeLessThan(model.contextLength);
    expect(model.maxTokens).toBeLessThanOrEqual(65_536);
    expect(result.issues).toContainEqual(expect.objectContaining({
      kind: "max-tokens-clamped",
      modelId: "grok-4.7",
      from: 500_000,
      to: model.maxTokens,
    }));
  });
});

describe("selectEndpoint", () => {
  test("routes a Claude model through Anthropic with its required header", () => {
    expect(selectEndpoint(catalogModel("claude-3-7-sonnet"))).toEqual({
      endpoint: "anthropic",
      baseUrlSuffix: "",
      headers: { "anthropic-version": "2023-06-01" },
    });
  });

  test("uses display metadata when an opaque id identifies a Claude model", () => {
    expect(selectEndpoint(catalogModel("fable", "claude-fable-5"))).toEqual({
      endpoint: "anthropic",
      baseUrlSuffix: "",
      headers: { "anthropic-version": "2023-06-01" },
    });
  });

  test("routes a Gemini model through Gemini", () => {
    expect(selectEndpoint(catalogModel("google/gemini-2.5-pro"))).toEqual({
      endpoint: "gemini",
      baseUrlSuffix: "/v1beta",
      headers: {},
    });
  });

  test("routes every other model through OpenAI", () => {
    expect(selectEndpoint(catalogModel("openai/gpt-5"))).toEqual({
      endpoint: "openai",
      baseUrlSuffix: "/v1",
      headers: {},
    });
  });
});

describe("fetchCatalog", () => {
  test("starts all three list requests concurrently and merges successful responses", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const resolvers: Array<(response: Response) => void> = [];
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Promise<Response>((resolve) => resolvers.push(resolve));
    }) as typeof fetch;

    const pending = fetchCatalog("http://cpa.test/", "secret", { fetchImpl });
    await Promise.resolve();
    expect(calls).toHaveLength(3);

    const openaiCall = calls.findIndex((call) =>
      call.url.endsWith("/v1/models") && !new Headers(call.init?.headers).has("anthropic-version"));
    const anthropicCall = calls.findIndex((call) =>
      new Headers(call.init?.headers).get("anthropic-version") === "2023-06-01");
    const geminiCall = calls.findIndex((call) => call.url.endsWith("/v1beta/models"));
    resolveCall(resolvers, openaiCall, json(openaiList({ id: "gemini-pro" })));
    resolveCall(resolvers, anthropicCall, json(anthropicList({
      id: "claude-fable-5-dd-orp-inimeg",
      context_length: 100_000,
    })));
    resolveCall(resolvers, geminiCall, json(geminiList({
      name: "models/gemini-pro",
      supportedInputModalities: ["TEXT"],
    })));

    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.failures).toEqual({});
    expect(result.models[0]).toMatchObject({
      id: "gemini-pro",
      contextLength: 100_000,
      inputModalities: ["TEXT"],
    });
  });

  test("returns the OpenAI catalog when only Anthropic fails, recording why", async () => {
    const result = await fetchCatalog("http://cpa.test", "secret", {
      fetchImpl: fixtureFetch({ anthropicStatus: 503 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.contextLength).toBeNull();
    expect(result.failures.anthropic).toContain("HTTP 503");
    expect(result.failures.gemini).toBeUndefined();
  });

  test("returns the OpenAI catalog when only Gemini fails, recording why", async () => {
    const result = await fetchCatalog("http://cpa.test", "secret", {
      fetchImpl: fixtureFetch({ geminiStatus: 502 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.inputModalities).toBeNull();
    expect(result.failures.gemini).toContain("HTTP 502");
    expect(result.failures.anthropic).toBeUndefined();
  });

  test("returns the OpenAI catalog when both optional formats fail", async () => {
    const result = await fetchCatalog("http://cpa.test", "secret", {
      fetchImpl: fixtureFetch({ anthropicStatus: 500, geminiStatus: 504 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.models).toHaveLength(1);
    expect(result.failures).toEqual({
      anthropic: "anthropic model list failed (HTTP 500)",
      gemini: "gemini model list failed (HTTP 504)",
    });
  });

  test("surfaces an OpenAI failure without fabricating a catalog", async () => {
    const result = await fetchCatalog("http://cpa.test", "secret", {
      fetchImpl: fixtureFetch({ openaiStatus: 401 }),
    });
    expect(result).toEqual({
      ok: false,
      reason: "openai model list failed (HTTP 401)",
      models: null,
      failures: { openai: "openai model list failed (HTTP 401)" },
    });
  });
});

function resolveCall(
  resolvers: Array<(response: Response) => void>,
  index: number,
  response: Response,
): void {
  const resolve = resolvers[index];
  if (!resolve) throw new Error(`missing fetch resolver at index ${index}`);
  resolve(response);
}

function fixtureFetch(statuses: {
  openaiStatus?: number;
  anthropicStatus?: number;
  geminiStatus?: number;
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.endsWith("/v1beta/models")) {
      const status = statuses.geminiStatus ?? 200;
      return status === 200
        ? json(geminiList({ name: "models/plain", supportedInputModalities: ["TEXT"] }))
        : json({ error: "gemini unavailable" }, status);
    }
    if (headers.has("anthropic-version")) {
      const status = statuses.anthropicStatus ?? 200;
      return status === 200
        ? json(anthropicList({ id: "claude-fable-5-dd-nialp", context_length: 100_000 }))
        : json({ error: "anthropic unavailable" }, status);
    }
    const status = statuses.openaiStatus ?? 200;
    return status === 200
      ? json(openaiList({ id: "plain", owned_by: "cpa" }))
      : json({ error: "openai unavailable" }, status);
  }) as typeof fetch;
}
