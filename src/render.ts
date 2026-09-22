import type { CpaConfig, HealthSnapshot, UsageResult } from "./types.ts";

/** East-Asian-aware display width, so Korean text never breaks column alignment. */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

export function pad(text: string, width: number): string {
  const diff = width - displayWidth(text);
  return diff > 0 ? text + " ".repeat(diff) : text;
}

const STATE_LABEL: Record<HealthSnapshot["state"], string> = {
  ok: "정상", degraded: "불안정", down: "다운", rate_limited: "요청 제한", unknown: "미확인",
};

/** One-line summary suitable for the TUI footer. */
export function renderStatusLine(tiers: TierCounts | null, health: HealthSnapshot): string {
  const parts: string[] = [];
  parts.push(`CPA ${STATE_LABEL[health.state]}`);
  if (tiers) parts.push(`주력 ${tiers.primary}종 · 최후 ${tiers.last}종`);
  return parts.join(" · ");
}

/** Live tier sizes, derived from the catalog. */
export interface TierCounts {
  primary: number;
  last: number;
  chatUnfit: number;
}

export interface ReportInput {
  config: CpaConfig;
  tiers: TierCounts | null;
  tierReason: string | null;
  health: HealthSnapshot;
  usage: UsageResult;
}

/** Full multi-line report for the /cpa command and the CLI. */
export function renderReport(input: ReportInput): string {
  const { config, tiers, tierReason, health, usage } = input;
  const L: string[] = [];

  L.push("CPA 상태");
  L.push("─".repeat(72));
  L.push(`서버        ${config.root}`);
  L.push(`상태        ${STATE_LABEL[health.state]} · ${health.detail}`);
  L.push("");

  L.push("모델 티어");
  L.push("─".repeat(72));
  if (!tiers) {
    L.push(`  확인 불가 · ${tierReason ?? "이유 불명"}`);
  } else {
    L.push(`  주력 ${tiers.primary}종 · 최후 ${tiers.last}종 · 대화 불가 ${tiers.chatUnfit}종`);
    L.push("  티어는 실시간 카탈로그에서 산출합니다. omo 설정 파일은 읽지도 쓰지도 않습니다.");
  }
  L.push("");

  L.push("계정 사용량");
  L.push("─".repeat(72));
  if (!usage.supported) {
    L.push(`  n/a · ${usage.reason}`);
  } else if (usage.accounts.length === 0) {
    L.push("  계정 없음");
  } else {
    for (const a of usage.accounts) {
      const head = `  ${pad(a.label, 22)} ${a.provider}`;
      L.push(a.status === "ok" ? head : `${head} · ${a.detail ?? "오류"}`);
      for (const w of a.windows) {
        L.push(`      ${pad(w.label, 10)} ${w.remainingPercent === null ? "n/a" : `${w.remainingPercent}%`}`);
      }
    }
  }

  return L.join("\n");
}
