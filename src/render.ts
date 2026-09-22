import type { CpaConfig, DriftReport, HealthSnapshot, UsageResult } from "./types.ts";

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
export function renderStatusLine(drift: DriftReport | null, health: HealthSnapshot): string {
  const parts: string[] = [];
  parts.push(`CPA ${STATE_LABEL[health.state]}`);
  if (drift) {
    parts.push(drift.dead.length === 0 ? `모델 ${drift.healthy}종 정상` : `죽은 모델 ${drift.dead.length}종`);
  }
  return parts.join(" · ");
}

export interface ReportInput {
  config: CpaConfig;
  drift: DriftReport | null;
  driftReason: string | null;
  health: HealthSnapshot;
  usage: UsageResult;
  refs?: { ref: string; line: number }[];
  substitutionEnabled: boolean;
}

/** Full multi-line report for the /cpa command and the CLI. */
export function renderReport(input: ReportInput): string {
  const { config, drift, driftReason, health, usage, refs, substitutionEnabled } = input;
  const L: string[] = [];

  L.push("CPA 상태");
  L.push("─".repeat(72));
  L.push(`서버        ${config.root}`);
  L.push(`provider    ${config.providers.map((p) => p.name).join(", ") || "(없음)"}`);
  L.push(`상태        ${STATE_LABEL[health.state]} · ${health.detail}`);
  L.push("");

  L.push("모델 드리프트");
  L.push("─".repeat(72));
  if (!drift) {
    L.push(`  확인 불가 · ${driftReason ?? "이유 불명"}`);
  } else if (drift.dead.length === 0) {
    L.push(`  정상 · 선언 ${drift.checked}종 전부 서버에 존재 (서버 ${drift.live}종 서빙)`);
  } else {
    L.push(`  선언 ${drift.checked}종 중 ${drift.dead.length}종이 서버에 없음 (서버 ${drift.live}종 서빙)`);
    L.push("");
    for (const d of drift.dead) {
      const hits = refs?.filter((r) => r.ref === d.ref) ?? [];
      const where = hits.length > 0 ? ` · omo.jsonc ${hits.length}곳 (L${hits.slice(0, 5).map((h) => h.line).join(", L")}${hits.length > 5 ? ", …" : ""})` : "";
      L.push(`  ✗ ${d.ref}${where}`);
      L.push(d.substitute
        ? `      대체 후보: ${d.substitute.id} (${d.substitute.why})`
        : `      대체 후보 없음 — 직접 골라야 합니다`);
    }
    L.push("");
    L.push(substitutionEnabled
      ? "  자동 대체: 켜짐 — 요청 시 대체 후보가 있는 모델만 교체합니다"
      : "  자동 대체: 꺼짐 (경고만) — OMO_CPA_SUBSTITUTE=1 로 켤 수 있습니다");
    L.push("  omo 설정은 읽기만 합니다. 위 줄 번호를 직접 고치세요.");
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
