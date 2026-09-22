/**
 * omo extension entry.
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

export default function omoCpa(pi: any): void {
  const state: State = {
    config: null, apiKey: null, managementKey: null, configReason: null,
    drift: null, driftReason: null, refs: [], deadIds: new Set(),
    health: new HealthTracker(),
    lastRequestWasCpa: false,
    substitutionEnabled: process.env["OMO_CPA_SUBSTITUTE"] === "1",
  };

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

  pi.registerCommand("cpa", {
    description: "CPA 상태·모델 드리프트·계정 사용량 점검",
    argumentHint: "[refresh]",
    handler: async (args: string, ctx: any) => {
      try {
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

        pi.sendMessage({
          customType: "omo-cpa-report",
          content: redact(report),
          display: "block",
        });
        setStatus(ctx);
      } catch (e) {
        notify(ctx, `/cpa 실패: ${redact((e as Error).message)}`, "error");
      }
    },
  });
}
