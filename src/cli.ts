#!/usr/bin/env bun
/** Standalone checker: same logic as the plugin, usable outside an omo session. */
import { loadConfig, scanOmoConfigRefs } from "./config.ts";
import { getCatalog } from "./catalog.ts";
import { computeDrift } from "./drift.ts";
import { HealthTracker } from "./health.ts";
import { fetchUsage } from "./usage.ts";
import { renderReport } from "./render.ts";
import { redact, keyPresence } from "./redact.ts";

const HELP = `omo-cpa — CPA(CLI Proxy API) 점검 도구

사용법
  omo-cpa               상태 리포트 (기본)
  omo-cpa --json        같은 결과를 JSON으로 (키·토큰 없음)
  omo-cpa --refresh     캐시 무시하고 다시 조회
  omo-cpa --help        이 도움말

환경변수
  OMO_CPA_BASE_URL          CPA 서버 주소 재정의
  OMO_CPA_API_KEY           추론 키 재정의
  OMO_CPA_MANAGEMENT_KEY    관리 API 키 (있으면 계정 사용량 활성화)
  OMO_CPA_SUBSTITUTE=1      죽은 모델 자동 대체 (플러그인 전용)
`;

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const asJson = argv.includes("--json");
  const force = argv.includes("--refresh");

  const loaded = await loadConfig();
  if (!loaded.config) {
    const msg = loaded.reason ?? "CPA 설정을 찾을 수 없음";
    console.error(asJson ? JSON.stringify({ ok: false, reason: msg }) : `오류: ${msg}`);
    return 1;
  }
  if (!loaded.apiKey) {
    const msg = "추론 키를 찾을 수 없음 (models.json의 local-proxy apiKey 또는 OMO_CPA_API_KEY)";
    console.error(asJson ? JSON.stringify({ ok: false, reason: msg }) : `오류: ${msg}`);
    return 1;
  }

  const catalog = await getCatalog(loaded.config.root, loaded.apiKey, { force });
  const declared = loaded.config.providers.flatMap((p) => p.declared.map((id) => ({ provider: p.name, id })));
  const drift = catalog.models ? computeDrift(declared, catalog.models) : null;
  const driftReason = catalog.ok ? null : catalog.reason;

  const { refs } = await scanOmoConfigRefs();
  const usage = await fetchUsage(loaded.config.root, loaded.managementKey);

  const health = new HealthTracker();
  if (catalog.ok) health.record(200);
  else health.recordFailure(catalog.reason);

  if (asJson) {
    console.log(JSON.stringify({
      ok: true,
      server: loaded.config.root,
      providers: loaded.config.providers.map((p) => ({ name: p.name, declared: p.declared.length })),
      managementKey: keyPresence(loaded.managementKey),
      drift: drift && {
        checked: drift.checked, live: drift.live, healthy: drift.healthy,
        dead: drift.dead.map((d) => ({
          ref: d.ref, substitute: d.substitute?.id ?? null,
          references: refs.filter((r) => r.ref === d.ref).map((r) => r.line),
        })),
      },
      driftReason,
      usage,
    }, null, 2));
  } else {
    console.log(redact(renderReport({
      config: loaded.config, drift, driftReason,
      health: health.snapshot(), usage, refs,
      substitutionEnabled: process.env["OMO_CPA_SUBSTITUTE"] === "1",
    })));
  }

  return drift && drift.dead.length > 0 ? 2 : 0;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
