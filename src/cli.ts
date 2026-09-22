#!/usr/bin/env bun
/** Standalone checker: same logic as the plugin, usable outside an omo session. */
import { loadConfig } from "./config.ts";
import { loadProviderData, buildProviderRegistration } from "./provider.ts";
import { loadOverrideStore, toOverrideMap } from "./tier.ts";
import { HealthTracker } from "./health.ts";
import { fetchUsage } from "./usage.ts";
import { renderReport } from "./render.ts";
import { redact, keyPresence } from "./redact.ts";

const HELP = `omo-cpa — CPA(CLI Proxy API) 점검 도구

사용법
  omo-cpa               상태 리포트 (기본)
  omo-cpa --json        같은 결과를 JSON으로 (키·토큰 없음)
  omo-cpa --help        이 도움말

환경변수
  OMO_CPA_BASE_URL          CPA 서버 주소 재정의
  OMO_CPA_API_KEY           추론 키 (omo 세션 밖에서는 필수)
  OMO_CPA_MANAGEMENT_KEY    관리 API 키 (있으면 계정 사용량 활성화)

이 도구는 omo의 models.json / omo.jsonc 를 읽지 않습니다.
`;

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const asJson = argv.includes("--json");

  const loaded = loadConfig();
  if (!loaded.apiKey) {
    const msg = "추론 키를 찾을 수 없음 (OMO_CPA_API_KEY 또는 omo 안에서 /login local-proxy)";
    console.error(asJson ? JSON.stringify({ ok: false, reason: msg }) : `오류: ${msg}`);
    return 1;
  }

  const health = new HealthTracker();
  let tiers: { primary: number; last: number; chatUnfit: number } | null = null;
  let tierReason: string | null = null;
  try {
    const [data, store] = await Promise.all([
      loadProviderData({ apiKey: loaded.apiKey }),
      loadOverrideStore(),
    ]);
    const { report } = buildProviderRegistration({ ...data, overrides: toOverrideMap(store) });
    tiers = {
      primary: report.primary.length,
      last: report.last.length,
      chatUnfit: report.chatUnfit.length,
    };
    health.record(200);
  } catch (e) {
    tierReason = redact((e as Error).message);
    health.recordFailure(tierReason);
  }

  const usage = await fetchUsage(loaded.config!.root, loaded.managementKey);

  if (asJson) {
    console.log(JSON.stringify({
      ok: tiers !== null,
      server: loaded.config!.root,
      managementKey: keyPresence(loaded.managementKey),
      tiers,
      tierReason,
      usage,
    }, null, 2));
  } else {
    console.log(redact(renderReport({
      config: loaded.config!,
      tiers,
      tierReason,
      health: health.snapshot(),
      usage,
    })));
  }

  return tiers === null ? 2 : 0;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
