/**
 * omo extension entry.
 *
 * CPA is registered as two in-memory providers: `cliproxyapi` for primary
 * workhorses and `cliproxyapi-last` for explicit last-resort routing. The latter
 * opts out of senpi's implicit family expansion. Both refresh from the same
 * three-format catalog; `/login cliproxyapi` remains available through oauth.
 * The plugin ignores omo's model and routing configuration. It only reads the
 * oauth credential that omo stores after `/login cliproxyapi`. The optional
 * management key is stored separately in a user-only file, never in omo config.
 *
 * The existing `/cpa` report, health circuit breaker, secret redaction, and
 * fail-open handlers are preserved. Declared overrides only enrich models that
 * are present in the live catalog; absent aliases are never synthesized.
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
  pruneUnrestorableStoreEntries,
  PROVIDER_NAME,
  readStoredPrimaryConnection,
  registerCpaProvider,
  STABLE_LAST_RESORT_IDS,
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
import { loadConfig } from "./config.ts";
import { clearManagementKey, MANAGEMENT_KEY_FILE, readManagementKey, saveManagementKey } from "./management-key.ts";
import { HealthTracker } from "./health.ts";
import { fetchUsage } from "./usage.ts";
import { renderReport, renderStatusLine } from "./render.ts";
import type { TierCounts } from "./render.ts";
import { redact } from "./redact.ts";
import type { CpaConfig } from "./types.ts";

const STATUS_KEY = "omo-cpa";

interface State {
  config: CpaConfig | null;
  apiKey: string | null;
  managementKey: string | null;
  configReason: string | null;
  tiers: TierCounts | null;
  tierReason: string | null;
  health: HealthTracker;
  lastRequestWasCpa: boolean;
}

export interface OmoCpaOptions {
  overridePath?: string;
  managementKeyPath?: string;
  modelsStorePath?: string;
  loadProviderData?: (force?: boolean) => Promise<ProviderData>;
}

export default function omoCpa(pi: any, options: OmoCpaOptions = {}): void {
  const state: State = {
    config: null, apiKey: null, managementKey: null, configReason: null,
    tiers: null, tierReason: null,
    health: new HealthTracker(),
    lastRequestWasCpa: false,
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
    migrateConfigBackground();
  }

  pruneUnrestorableStoreEntries(options.modelsStorePath);

  // Run registration immediately so `/login` and the model catalog are available
  // as soon as omo's runner binds context. This is safe per the types.d.ts guarantee:
  // "During initial extension load this call is queued and applied once the runner
  // has bound its context. After that it takes effect immediately."
  registerProviderSafely();

  /** Load the live catalog and recompute tier sizes. Never throws. */
  async function refresh(force = false): Promise<void> {
    try {
      const stored = readStoredPrimaryConnection();
      const loaded = loadConfig(stored?.apiKey, stored?.baseUrl, managementKeyPath);
      state.config = loaded.config;
      state.apiKey = loaded.apiKey;
      state.managementKey = loaded.managementKey;
      state.configReason = loaded.reason;

      const { report } = await loadTieredProviderData(force);
      state.tiers = {
        primary: report.primary.length,
        last: report.last.length,
        chatUnfit: report.chatUnfit.length,
      };
      state.tierReason = null;
    } catch (e) {
      state.tierReason = `점검 실패: ${redact((e as Error).message)}`;
    }
  }

  function setStatus(ctx: any): void {
    try {
      ctx?.ui?.setStatus?.(STATUS_KEY, renderStatusLine(state.tiers, state.health.snapshot()));
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
      // The tier split is derived from the live catalog, so a model omo declares
      // elsewhere is not this plugin's business: no drift warning is emitted.
      if (!state.tiers && state.tierReason) {
        notify(ctx, `CPA 모델 목록 불러오기 실패 · ${state.tierReason}`, "info");
      }
    })();
  });

  pi.on("model_select", (_event: any, ctx: any) => {
    try {
      setStatus(ctx);
    } catch { /* fail open */ }
    return undefined;
  });

  pi.on("before_provider_request", (event: any) => {
    try {
      const provider = event?.model?.provider;
      state.lastRequestWasCpa = provider === PROVIDER_NAME || provider === LAST_RESORT_PROVIDER_NAME;
    } catch { /* fail open */ }
    return undefined;
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
  const managementKeyPath = options.managementKeyPath;
  const providerDataLoader = options.loadProviderData
    ?? ((force?: boolean) => loadProviderData(force ? { force: true } : {}));

  async function loadTieredProviderData(force = false): Promise<TieredProviderData> {
    const [data, store] = await Promise.all([
      providerDataLoader(force),
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
    const row = (label: string, entries: readonly string[]) =>
      `${label} (${entries.length})${entries.length > 0 ? `\n  ${entries.join("\n  ")}` : " · 없음"}`;
    return [
      "CPA 모델 tier",
      row("primary", report.primary.map(({ id }) => id)),
      row("last-resort", report.last.map(({ id }) => id)),
      row("chat-unfit (명시 선택만 가능, 체인 제외)", report.chatUnfit.map(({ id }) => id)),
      row("활성 override", activeOverrides.map(({ id, tier }) => `${id} → ${tier}`)),
      row("비활성 override", report.inactiveOverrides.map(({ id, tier }) => `${id} → ${tier}`)),
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
    const stableIds = new Set<string>(STABLE_LAST_RESORT_IDS);
    const stableLast = tiered.report.last.filter(({ id }) => stableIds.has(id));
    const chains = generateFallbackChains({
      catalog: tiered.catalog,
      decisions: [
        ...tiered.report.primary,
        ...(stableLast.length > 0 ? stableLast : tiered.report.last),
      ],
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

  async function handleManagementCommand(action: string | undefined, ctx: any): Promise<void> {
    if (action === undefined || action === "status") {
      const configured = !!(process.env["OMO_CPA_MANAGEMENT_KEY"]?.trim() || readManagementKey(managementKeyPath));
      notify(ctx, `Management Key ${configured ? "설정됨" : "미설정"}${configured ? "" : " · /cpa management set 으로 등록"}`);
      return;
    }
    if (action === "set") {
      if (ctx?.hasUI !== true || typeof ctx?.ui?.input !== "function") {
        notify(ctx, "이 모드에서는 비밀 입력 UI를 사용할 수 없습니다. OMO_CPA_MANAGEMENT_KEY 환경변수를 설정하세요.", "error");
        return;
      }
      const key = await ctx.ui.input("CPA Management Key 입력", "입력 중 화면에 표시될 수 있습니다");
      if (key === undefined) {
        notify(ctx, "Management Key 입력을 취소했습니다");
        return;
      }
      if (!key.trim()) {
        notify(ctx, "Management Key가 비어 있습니다. 기존 키는 유지했습니다.", "warning");
        return;
      }
      try {
        saveManagementKey(key, managementKeyPath);
        const loaded = loadConfig(state.apiKey, state.config?.root, managementKeyPath);
        state.managementKey = loaded.managementKey;
        state.config = loaded.config;
        notify(ctx, "Management Key를 사용자 전용 파일(0600)에 저장했습니다. 파일은 암호화되지 않습니다.");
      } catch (e) {
        notify(ctx, `Management Key 저장 실패: ${redact((e as Error).message)}`, "error");
      }
      return;
    }
    if (action === "clear") {
      if (process.env["OMO_CPA_MANAGEMENT_KEY"]?.trim()) {
        notify(ctx, "환경변수 OMO_CPA_MANAGEMENT_KEY가 우선 적용 중입니다. 환경변수를 제거한 뒤 파일 키를 초기화하세요.", "warning");
        return;
      }
      try {
        clearManagementKey(managementKeyPath);
        const loaded = loadConfig(state.apiKey, state.config?.root, managementKeyPath);
        state.managementKey = loaded.managementKey;
        state.config = loaded.config;
        notify(ctx, "저장된 Management Key를 삭제했습니다");
      } catch (e) {
        notify(ctx, `Management Key 삭제 실패: ${redact((e as Error).message)}`, "error");
      }
      return;
    }
    notify(ctx, `알 수 없는 management 하위 명령 "${action}". 사용법: /cpa management [status|set|clear]`, "warning");
  }

  function showHelp(): void {
    sendBlock([
      "/cpa 명령 도움말",
      "/cpa                         상태·tier·fallback chain·사용량 리포트",
      "/cpa help                    이 도움말",
      "/cpa refresh                 상태와 모델 카탈로그 새로고침",
      "/cpa management [status]     Management Key 설정 상태 확인",
      "/cpa management set          입력창에서 키 저장 (타이핑은 화면에 표시될 수 있음)",
      "/cpa management clear        저장한 키 삭제",
      "/cpa tier                    모델 tier와 override 목록",
      "/cpa tier promote <model-id> 주력 tier로 지정",
      "/cpa tier demote <model-id>  최후 fallback tier로 지정",
      "/cpa tier reset <model-id>   수동 tier 지정 해제",
      "/cpa chains                  fallback chain 미리보기",
      "/cpa chains apply            현재 세션에 fallback chain 적용",
      "",
      `키는 ${managementKeyPath ?? MANAGEMENT_KEY_FILE} 에 암호화 없이 사용자 전용 권한(0600)으로 저장됩니다.`,
      "OMO_CPA_MANAGEMENT_KEY 환경변수가 저장된 키보다 우선합니다.",
    ].join("\n"), "omo-cpa-help");
  }

  pi.registerCommand("cpa", {
    description: "CPA 상태·tier·fallback chain·계정 사용량 점검",
    argumentHint: "[help|refresh|management [status|set|clear]|tier [promote|demote|reset] <model-id>|chains [apply]]",
    handler: async (args: string, ctx: any) => {
      try {
        const words = args.trim().split(/\s+/).filter(Boolean);
        if (words[0] === "help" || words[0] === "--help" || words[0] === "-h") {
          showHelp();
          return;
        }
        if (words[0] === "management") {
          await handleManagementCommand(words[1], ctx);
          return;
        }
        const tierCommand = parseTierCommand(words);
        if (tierCommand) {
          await handleTierCommand(tierCommand, ctx);
          return;
        }
        if (words[0] === "chains") {
          await handleChainsCommand(words, ctx);
          return;
        }
        if (words.length > 0 && words[0] !== "refresh") {
          notify(ctx, `알 수 없는 하위 명령 "${words[0]}". /cpa help 에서 지원 인자를 확인하세요.`, "warning");
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
          tiers: state.tiers,
          tierReason: state.tierReason,
          health: state.health.snapshot(),
          usage,
        });

        sendBlock(report, "omo-cpa-report");
        setStatus(ctx);
      } catch (e) {
        notify(ctx, `/cpa 실패: ${redact((e as Error).message)}`, "error");
      }
    },
  });
}
