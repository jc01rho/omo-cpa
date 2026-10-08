import type { CatalogModel, Endpoint } from "./tier-types.ts";

type CatalogListEndpoint = Endpoint | "codex";

const ANTHROPIC_BUG_PREFIX = "claude-fable-5-dd-";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_SANE_OUTPUT_TOKENS = 250_000;

export interface CatalogIssue {
  kind: "discarded-metadata" | "metadata-disagreement" | "max-tokens-clamped";
  endpoint: CatalogListEndpoint;
  modelId: string;
  field?: "contextLength" | "maxTokens";
  values?: number[];
  chosen?: number;
  from?: number;
  to?: number | null;
  reason: string;
}

export interface CatalogMergeResult {
  models: CatalogModel[];
  issues: CatalogIssue[];
}

export interface EndpointSelection {
  endpoint: Endpoint;
  baseUrlSuffix: "/v1" | "" | "/v1beta";
  headers: Record<string, string>;
}

export type CatalogFetchResult =
  | {
      ok: true;
      models: CatalogModel[];
      issues: CatalogIssue[];
      failures: Partial<Record<CatalogListEndpoint, string>>;
    }
  | {
      ok: false;
      reason: string;
      models: null;
      failures: Partial<Record<CatalogListEndpoint, string>>;
    };

export interface FetchCatalogOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** OpenAI already exposes the canonical catalog id. */
export function normalizeOpenAIId(id: string): string {
  return id;
}

/** Normalize a model name from Gemini's `models/<id>` list representation. */
export function normalizeGeminiId(id: string): string {
  return id.startsWith("models/") ? id.slice("models/".length) : id;
}

/**
 * Undo CPA's Anthropic-list id corruption. Unmangled ids are deliberately
 * returned unchanged because CPA may fix the server bug independently.
 */
export function normalizeAnthropicId(id: string): string {
  if (!id.startsWith(ANTHROPIC_BUG_PREFIX)) return id;
  return id
    .slice(ANTHROPIC_BUG_PREFIX.length)
    .split("/")
    .map((segment) => [...segment].reverse().join(""))
    .reverse()
    .join("/");
}

/** Merge all available list representations around the authoritative OpenAI ids. */
export function mergeCatalogs(
  openaiResponse: unknown,
  anthropicResponse: unknown = null,
  geminiResponse: unknown = null,
  codexResponse: unknown = null,
): CatalogMergeResult {
  const issues: CatalogIssue[] = [];
  const models: CatalogModel[] = [];
  const byId = new Map<string, CatalogModel>();

  for (const record of recordsAt(openaiResponse, "data")) {
    const rawId = stringAt(record, "id");
    if (!rawId) continue;
    const id = normalizeOpenAIId(rawId);
    if (byId.has(id)) continue;
    const model: CatalogModel = {
      id,
      ownedBy: stringAt(record, "owned_by"),
      displayName: null,
      contextLength: null,
      maxTokens: null,
      inputModalities: null,
      outputModalities: null,
      thinking: null,
    };
    byId.set(id, model);
    models.push(model);

    // CPA can enrich the identity record itself with window and output limits.
    model.contextLength = readRecordContextLength(id, "openai", record, issues);
    model.maxTokens = chooseSaferLimit(
      id,
      "maxTokens",
      [numberAt(record, "max_tokens"), numberAt(record, "max_completion_tokens")],
      issues,
      "openai",
    );
  }

  for (const record of recordsAt(anthropicResponse, "data")) {
    const rawId = stringAt(record, "id");
    if (!rawId) continue;
    const id = normalizeAnthropicId(rawId);
    const model = byId.get(id);
    if (!model) {
      issues.push({
        kind: "discarded-metadata",
        endpoint: "anthropic",
        modelId: id,
        reason: `Anthropic metadata discarded because recovered id ${id} is absent from the OpenAI catalog`,
      });
      continue;
    }

    model.displayName = stringAt(record, "display_name") ?? model.displayName;
    const enrichedContextLength = readRecordContextLength(id, "anthropic", record, issues);
    if (enrichedContextLength !== null) model.contextLength = enrichedContextLength;
    model.maxTokens = chooseSaferLimit(
      id,
      "maxTokens",
      [numberAt(record, "max_tokens"), numberAt(record, "max_completion_tokens")],
      issues,
      "anthropic",
    );
    model.thinking = booleanAt(record, "thinking") ?? booleanAt(record, "extended_thinking");
    clampOutputLimit(model, issues);
  }

  for (const record of recordsAt(geminiResponse, "models")) {
    const rawId = stringAt(record, "name");
    if (!rawId) continue;
    const id = normalizeGeminiId(rawId);
    const model = byId.get(id);
    if (!model) {
      issues.push({
        kind: "discarded-metadata",
        endpoint: "gemini",
        modelId: id,
        reason: `Gemini metadata discarded because id ${id} is absent from the OpenAI catalog`,
      });
      continue;
    }

    model.displayName ??= stringAt(record, "displayName");
    model.inputModalities = stringArrayAt(record, "supportedInputModalities");
    model.outputModalities = stringArrayAt(record, "supportedOutputModalities");
    if (model.inputModalities !== null) model.inputModalitiesSource = "gemini";
  }

  // Codex exposes the maximum window under `models[].slug`, not `data[].id`,
  // and it is the only list that declares INPUT modalities for the models the
  // Gemini list omits (measured 2026-10-08 on the live 84-model catalog: 33
  // carry `supportedInputModalities`, all 84 carry `input_modalities`, and
  // wherever both speak the text/image set agrees, and Gemini additionally
  // reports video/audio). Gemini wins when it speaks; Codex fills the gap,
  // instead of a vision model staying unknown and being registered as
  // text-only. It enriches only IDs already present in the canonical OpenAI list.
  for (const record of recordsAt(codexResponse, "models")) {
    const id = stringAt(record, "slug");
    if (!id) continue;
    const model = byId.get(id);
    if (!model) continue;
    model.contextLength = readRecordContextLength(id, "codex", record, issues) ?? model.contextLength;
    model.maxTokens = numberAt(record, "max_tokens") ?? model.maxTokens;
    const codexInput = stringArrayAt(record, "input_modalities");
    if (model.inputModalities === null && codexInput !== null) {
      model.inputModalities = codexInput;
      model.inputModalitiesSource = "codex";
    }
    clampOutputLimit(model, issues, "codex");
  }

  return { models, issues };
}

/** Choose the wire protocol from model identity, preferring enriched display metadata. */
export function selectEndpoint(model: CatalogModel): EndpointSelection {
  const identity = `${model.id} ${model.displayName ?? ""}`.toLowerCase();
  if (hasFamily(identity, "claude")) {
    return {
      endpoint: "anthropic",
      baseUrlSuffix: "",
      headers: { "anthropic-version": ANTHROPIC_VERSION },
    };
  }
  if (hasFamily(identity, "gemini")) {
    return { endpoint: "gemini", baseUrlSuffix: "/v1beta", headers: {} };
  }
  return { endpoint: "openai", baseUrlSuffix: "/v1", headers: {} };
}

/** Fetch the four list formats concurrently; OpenAI is the required identity source. */
export async function fetchCatalog(
  root: string,
  apiKey: string,
  options: FetchCatalogOptions = {},
): Promise<CatalogFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = root.replace(/\/+$/, "");

  const [openai, anthropic, gemini, codex] = await Promise.all([
    fetchList(fetchImpl, `${base}/v1/models`, apiKey, "openai", timeoutMs),
    fetchList(fetchImpl, `${base}/v1/models`, apiKey, "anthropic", timeoutMs),
    fetchList(fetchImpl, `${base}/v1beta/models`, apiKey, "gemini", timeoutMs),
    fetchList(fetchImpl, `${base}/v1/models?client_version=cpa`, apiKey, "codex", timeoutMs),
  ]);

  if (!openai.ok) {
    return {
      ok: false,
      reason: openai.reason,
      models: null,
      failures: { openai: openai.reason },
    };
  }

  const failures: Partial<Record<CatalogListEndpoint, string>> = {};
  if (!anthropic.ok) failures.anthropic = anthropic.reason;
  if (!gemini.ok) failures.gemini = gemini.reason;
  if (!codex.ok) failures.codex = codex.reason;

  const merged = mergeCatalogs(
    openai.body,
    anthropic.ok ? anthropic.body : null,
    gemini.ok ? gemini.body : null,
    codex.ok ? codex.body : null,
  );
  if (merged.models.length === 0) {
    const reason = "openai model list contained no valid model ids";
    return { ok: false, reason, models: null, failures: { openai: reason } };
  }

  return { ok: true, ...merged, failures };
}

function hasFamily(identity: string, family: "claude" | "gemini"): boolean {
  return new RegExp(`(^|[/_.\\s-])${family}(?=$|[/_.\\s-])`).test(identity);
}

/**
 * Read a model's context window from one list record. An explicit
 * `max_context_window` is the provider's authoritative ceiling and wins over
 * any coexisting `context_window`, `context_length`, or `max_input_tokens`.
 */
function readRecordContextLength(
  modelId: string,
  endpoint: CatalogListEndpoint,
  record: Record<string, unknown>,
  issues: CatalogIssue[],
): number | null {
  const explicitMaximum = numberAt(record, "max_context_window");
  const candidates = [
    numberAt(record, "context_window"),
    numberAt(record, "context_length"),
    numberAt(record, "max_input_tokens"),
  ];
  if (explicitMaximum === null) {
    return chooseSaferLimit(modelId, "contextLength", candidates, issues, endpoint);
  }
  return explicitMaximum;
}

function chooseSaferLimit(
  modelId: string,
  field: "contextLength" | "maxTokens",
  candidates: Array<number | null>,
  issues: CatalogIssue[],
  endpoint: CatalogListEndpoint = "anthropic",
): number | null {
  const values = [...new Set(candidates.filter((value): value is number => value !== null))];
  if (values.length === 0) return null;
  const chosen = Math.min(...values);
  if (values.length > 1) {
    issues.push({
      kind: "metadata-disagreement",
      endpoint,
      modelId,
      field,
      values,
      chosen,
      reason: `${field} candidates disagree (${values.join(", ")}); chose safer value ${chosen}`,
    });
  }
  return chosen;
}

function clampOutputLimit(model: CatalogModel, issues: CatalogIssue[], endpoint: CatalogListEndpoint = "anthropic"): void {
  if (model.maxTokens === null || model.contextLength === null || model.maxTokens < model.contextLength) return;

  const from = model.maxTokens;
  const belowContext = model.contextLength - 1;
  const to = belowContext > 0
    ? Math.min(MAX_SANE_OUTPUT_TOKENS, belowContext)
    : null;
  model.maxTokens = to !== null && to < model.contextLength ? to : null;
  issues.push({
    kind: "max-tokens-clamped",
    endpoint,
    modelId: model.id,
    field: "maxTokens",
    from,
    to: model.maxTokens,
    reason: `maxTokens ${from} was not below contextLength ${model.contextLength}; clamped to ${model.maxTokens ?? "null"}`,
  });
}

type ListFetchResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: string };

async function fetchList(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  endpoint: CatalogListEndpoint,
  timeoutMs: number,
): Promise<ListFetchResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (endpoint === "anthropic") headers["anthropic-version"] = ANTHROPIC_VERSION;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, reason: `${endpoint} model list failed (${errorMessage(error)})` };
  }

  if (!response.ok) {
    return { ok: false, reason: `${endpoint} model list failed (HTTP ${response.status})` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { ok: false, reason: `${endpoint} model list returned invalid JSON (${errorMessage(error)})` };
  }

  const listKey = endpoint === "gemini" || endpoint === "codex" ? "models" : "data";
  if (recordsAt(body, listKey).length === 0) {
    return { ok: false, reason: `${endpoint} model list response has no ${listKey} records` };
  }
  return { ok: true, body };
}

function recordsAt(value: unknown, key: string): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  const records = (value as Record<string, unknown>)[key];
  if (!Array.isArray(records)) return [];
  return records.filter((record): record is Record<string, unknown> =>
    record !== null && typeof record === "object" && !Array.isArray(record));
}

function stringAt(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberAt(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function booleanAt(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function stringArrayAt(record: Record<string, unknown>, key: string): string[] | null {
  const value = record[key];
  if (!Array.isArray(value)) return null;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? strings : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
