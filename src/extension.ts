/**
 * omo extension entry.
 *
 * CPA is now a first-class omo provider registered entirely in code. On load,
 * `registerCpaProvider` calls `pi.registerProvider("local-proxy", ...)` with
 * an `oauth` block so `/login local-proxy` stores the key in
 * `~/.omo/agent/auth.json` (omo-owned), and `refreshModels` fetches the real
 * catalog from the CPA server and persists it via `context.publish({ persist })`.
 * `models.json` is read at most once, read-only, to migrate the existing key
 * and any curated per-model values into the plugin's own cache; it is never
 * written to and no longer required.
 *
 * The existing `/cpa` report, health circuit breaker, secret redaction, and
 * fail-open handlers are preserved. The "model drift guard" is reframed:
 * absence from `/v1/models` is no longer treated as "dead" for the four alias
 * models that resolve via upstream mapping — see `src/provider.ts`'s
 * DECLARED_OVERRIDES and the probe-based "declared but neither listed nor
 * callable" check documented in README.
 *
 * Contract notes verified against senpi's extension type definitions:
 * - `model_select` CANNOT change the model (its result only carries a system
 *   prompt), so a dead model is reported there and substituted on the wire.
 * - `before_provider_request` returns `unknown`; a returned value REPLACES the
 *   payload, which is where a wire-level model swap is possible.
 * - `after_provider_response` carries only `{status, headers}` with no provider
 *   identity, so CPA attribution uses the preceding request (see HealthTracker).
 *
 * The extension is fail-open by design: every handler swallows its own errors so
 * a plugin bug can never take down a session.
 */
import {
  buildProviderRegistration,
  LAST_RESORT_PROVIDER_NAME,
  loadProviderData,
  migrateConfigBackground,
  PROVIDER_NAME,
  registerCpaProvider,
} from "./provider.ts";
import type { ProviderData, TieredProviderData } from "./provider.ts";
import { generateFallbackChains } from "./chain.ts";
import {
  clearOverride,
  loadOverrideStore,
  OVERRIDES_FILE,
  parseTierCommand,
  saveOverrideStore,
  setOverride,
  toOverrideMap,
} from "./tier.ts";
import { loadConfig, scanOmoConfigRefs } from "./config.ts";
import { getCatalog } from "./catalog.ts";
import { computeDrift } from "./drift.ts";
import { HealthTracker } from "./health.ts";
import { fetchUsage } from "./usage.ts";
import { renderReport, renderStatusLine } from "./render.ts";
import { redact } from "./redact.ts";
import type { ConfigRef, CpaConfig, DriftReport } from "./types.ts";

const STATUS_KEY = "omo-cpa";

interface State {
  config: CpaConfig | null;
  apiKey: string | null;
  managementKey: string | null;
  configReason: string | null;
  drift: DriftReport | null;
  driftReason: string | null;
  refs: ConfigRef[];
  deadIds: Set<string>;
  health: HealthTracker;
  lastRequestWasCpa: boolean;
  substitutionEnabled: boolean;
}

export interface OmoCpaOptions {
  overridePath?: string;
  loadProviderData?: () => Promise<ProviderData>;
}

export default function omoCpa(pi: any, options: OmoCpaOptions = {}): void {
  const state: State = {
    config: null, apiKey: null, managementKey: null, configReason: null,
    drift: null, driftReason: null, refs: [], deadIds: new Set(),
    health: new HealthTracker(),
    lastRequestWasCpa: false,
    substitutionEnabled: process.env["OMO_CPA_SUBSTITUTE"] === "1",
  };

  /** Register the in-code CPA provider + oauth + /cpa command.
   *  Fail-open: a malformed `pi` (missing registerProvider) is silently ignored,
   *  and the built-in /cpa command (below) remains the only surface.
   */
  function registerProviderSafely(): void {
    try {
      registerCpaProvider(pi as unknown);
    } catch {
      // If registerProvider itself throws synchronously, swallow it.
    }
    // Background migration: read models.json read-only to cache existing key
    // and curated per-model values. Never writes to models.json.
    migrateConfigBackground();
  }

  // Run registration immediately so `/login` and the model catalog are available
  // as soon as omo's runner binds context. This is safe per the types.d.ts guarantee:
  // "During initial extension load this call is queued and applied once the runner
  // has bound its context. After that it takes effect immediately."
  registerProviderSafely();

  /** Load config + catalog and recompute drift. Never throws. */
  async function refresh(force = false): Promise<void> {
    try {
      const loaded = await loadConfig();
      state.config = loaded.config;
      state.apiKey = loaded.apiKey;
      state.managementKey = loaded.managementKey;
      state.configReason = loaded.reason;
      if (!loaded.config || !loaded.apiKey) {
        state.driftReason = loaded.reason ?? "추론 키를 찾을 수 없음";
        return;
      }

      const catalog = await getCatalog(loaded.config.root, loaded.apiKey, { force });
      const models = catalog.models;
      if (!models) {
        state.drift = null;
        state.driftReason = catalog.ok ? "모델 목록 없음" : catalog.reason;
        return;
      }
      if (!catalog.ok) state.driftReason = catalog.reason;
      else state.driftReason = null;

      const declared = loaded.config.providers.flatMap((p) =>
        p.declared.map((id) => ({ provider: p.name, id })),
      );
      state.drift = computeDrift(declared, models);
      state.deadIds = new Set(state.drift.dead.map((d) => d.id));

      const scan = await scanOmoConfigRefs();
      state.refs = scan.refs;
    } catch (e) {
      state.driftReason = `점검 실패: ${redact((e as Error).message)}`;
    }
  }

  function setStatus(ctx: any): void {
    try {
      ctx?.ui?.setStatus?.(STATUS_KEY, renderStatusLine(state.drift, state.health.snapshot()));
    } catch { /* status is cosmetic */ }
  }

  function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info"): void {
    try {
      ctx?.ui?.notify?.(message, level);
    } catch { /* never let a notification failure propagate */ }
  }

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    // Never block session startup on the network.
    void (async () => {
      await refresh();
      setStatus(ctx);
      const dead = state.drift?.dead ?? [];
      if (dead.length > 0) {
        const names = dead.map((d) => d.id).join(", ");
        const inChains = state.refs.filter((r) => state.deadIds.has(r.id)).length;
        notify(
          ctx,
          `CPA에 없는 모델 ${dead.length}종: ${names}` +
            (inChains > 0 ? ` · omo.jsonc ${inChains}곳에서 참조 중 — /cpa 로 확인` : " — /cpa 로 확인"),
          "warning",
        );
      } else if (state.driftReason) {
        notify(ctx, `CPA 모델 점검 불가 · ${state.driftReason}`, "info");
      }
    })();
  });

  pi.on("model_select", (event: any, ctx: any) => {
    try {
      const id = event?.model?.id;
      if (typeof id === "string" && state.deadIds.has(id)) {
        // model_select cannot replace the model; warn and let the wire hook act.
        notify(ctx, `${id} 는 CPA에 없는 모델입니다 — 요청이 실패할 수 있습니다 (/cpa)`, "warning");
      }
      setStatus(ctx);
    } catch { /* fail open */ }
    return undefined;
  });

  pi.on("before_provider_request", (event: any) => {
    try {
      const provider = event?.model?.provider;
      state.lastRequestWasCpa = typeof provider === "string" && provider.startsWith("local-proxy");

      if (!state.substitutionEnabled || !state.lastRequestWasCpa) return undefined;

      const payload = event?.payload;
      if (!payload || typeof payload !== "object") return undefined;
      const wireModel = (payload as { model?: unknown }).model;
      if (typeof wireModel !== "string" || !state.deadIds.has(wireModel)) return undefined;

      const sub = state.drift?.dead.find((d) => d.id === wireModel)?.substitute;
      if (!sub) return undefined;

      // Returning a value replaces the payload for this request only.
      return { ...(payload as Record<string, unknown>), model: sub.id };
    } catch {
      return undefined;
    }
  });

  pi.on("after_provider_response", (event: any, ctx: any) => {
    try {
      if (!state.lastRequestWasCpa) return;
      state.lastRequestWasCpa = false;
      const status = typeof event?.status === "number" ? event.status : null;
      if (status === null) return;
      const before = state.health.snapshot().state;
      const after = state.health.record(status, event?.headers ?? {}).state;
      setStatus(ctx);
      if (before !== after && (after === "down" || after === "rate_limited")) {
        notify(ctx, `CPA ${state.health.snapshot().detail}`, "error");
      }
    } catch { /* fail open */ }
  });

  const overridePath = options.overridePath ?? OVERRIDES_FILE;
  const providerDataLoader = options.loadProviderData ?? loadProviderData;

  async function loadTieredProviderData(): Promise<TieredProviderData> {
    const [data, store] = await Promise.all([
      providerDataLoader(),
      loadOverrideStore(overridePath),
    ]);
    return buildProviderRegistration({ ...data, overrides: toOverrideMap(store) });
  }

  function sendBlock(content: string, customType: string): void {
    pi.sendMessage({ customType, content: redact(content), display: "block" });
  }

  function renderTierSummary(tiered: TieredProviderData): string {
    const { report } = tiered;
    const activeOverrides = report.decisions.filter(({ overridden }) => overridden);
    const row = (label: string, ids: readonly { id: string }[]) =>
      `${label} (${ids.length})${ids.length > 0 ? `\n  ${ids.map(({ id }) => id).join("\n  ")}` : " · 없음"}`;
    return [
      "CPA 모델 tier",
      row("primary", report.primary),
      row("last-resort", report.last),
      row("chat-unfit (명시 선택만 가능, 체인 제외)", report.chatUnfit),
      row("활성 override", activeOverrides),
      row("비활성 override", report.inactiveOverrides),
    ].join("\n\n");
  }

  async function handleTierCommand(command: NonNullable<ReturnType<typeof parseTierCommand>>, ctx: any): Promise<void> {
    if (command.kind === "error") {
      notify(ctx, command.message, "warning");
      return;
    }
    if (command.kind === "list") {
      sendBlock(renderTierSummary(await loadTieredProviderData()), "omo-cpa-tier");
      return;
    }

    const store = await loadOverrideStore(overridePath);
    const next = command.kind === "set"
      ? setOverride(store, command.id, command.tier, "/cpa tier")
      : clearOverride(store, command.id);
    if (!await saveOverrideStore(next, overridePath)) {
      notify(ctx, `tier 설정을 저장하지 못했습니다: ${overridePath} (권한과 경로를 확인하세요)`, "error");
      return;
    }

    const data = await providerDataLoader();
    const tiered = buildProviderRegistration({ ...data, overrides: toOverrideMap(next) });
    registerCpaProvider(pi, { ...data, overrides: toOverrideMap(next) });
    const action = command.kind === "set"
      ? `${command.id} → ${command.tier}`
      : `${command.id} override 해제`;
    notify(ctx, `CPA tier 적용 완료: ${action} · primary ${tiered.report.primary.length}, last ${tiered.report.last.length}`, "info");
  }

  async function handleChainsCommand(args: string[], ctx: any): Promise<void> {
    const action = args[1];
    if (action !== undefined && action !== "apply") {
      notify(ctx, `알 수 없는 하위 명령 "${action}". 사용법: /cpa chains [apply]`, "warning");
      return;
    }
    const settings = ctx?.sessionSettings;
    if (!settings || typeof settings.getRetryFallbackSettings !== "function") {
      notify(ctx, "현재 세션은 fallback 설정 API를 제공하지 않습니다", "error");
      return;
    }
    const tiered = await loadTieredProviderData();
    const chains = generateFallbackChains({
      catalog: tiered.catalog,
      decisions: [...tiered.report.primary, ...tiered.report.last],
      providers: { primary: PROVIDER_NAME, last: LAST_RESORT_PROVIDER_NAME },
      targets: tiered.report.primary.map(({ id }) => id),
    });
    const current = settings.getRetryFallbackSettings()?.fallbackChains ?? {};
    sendBlock([
      "현재 fallback chains (변경 전)",
      JSON.stringify(current, null, 2),
      "",
      action === "apply" ? "적용할 CPA chains" : "CPA chains 미리보기 (/cpa chains apply 로 명시 적용)",
      JSON.stringify(Object.fromEntries(chains.map(({ target, entries }) => [target, entries])), null, 2),
    ].join("\n"), "omo-cpa-chains");
    if (action !== "apply") return;
    if (typeof settings.setFallbackChain !== "function") {
      notify(ctx, "현재 세션은 fallback chain 쓰기 API를 제공하지 않습니다", "error");
      return;
    }
    for (const { target, entries } of chains) await settings.setFallbackChain(target, entries);
    notify(ctx, `CPA fallback chain ${chains.length}개를 명시적으로 적용했습니다`, "info");
  }

  pi.registerCommand("cpa", {
    description: "CPA 상태·tier·fallback chain·계정 사용량 점검",
    argumentHint: "[refresh|tier ...|chains [apply]]",
    handler: async (args: string, ctx: any) => {
      try {
        const words = args.trim().split(/\s+/).filter(Boolean);
        const tierCommand = parseTierCommand(words);
        if (tierCommand) {
          await handleTierCommand(tierCommand, ctx);
          return;
        }
        if (words[0] === "chains") {
          await handleChainsCommand(words, ctx);
          return;
        }

        const force = args.trim() === "refresh";
        if (force || !state.config) await refresh(force);

        if (!state.config) {
          notify(ctx, `CPA 설정을 찾을 수 없음 · ${state.configReason ?? "이유 불명"}`, "error");
          return;
        }

        const usage = await fetchUsage(state.config.root, state.managementKey);
        const report = renderReport({
          config: state.config,
          drift: state.drift,
          driftReason: state.driftReason,
          health: state.health.snapshot(),
          usage,
          refs: state.refs,
          substitutionEnabled: state.substitutionEnabled,
        });

        sendBlock(report, "omo-cpa-report");
        setStatus(ctx);
      } catch (e) {
        notify(ctx, `/cpa 실패: ${redact((e as Error).message)}`, "error");
      }
    },
  });
}
