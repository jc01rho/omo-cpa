import type { CpaConfig, HealthSnapshot, UsageAccount, UsageResult, UsageWindow } from "./types.ts";

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

const ACCOUNT_STATE_LABEL: Record<UsageAccount["status"], string> = {
  ok: "정상", error: "오류", off: "비활성",
};

/** Keeps a lone short window from hugging the percentage. */
const MIN_WINDOW_WIDTH = 12;

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
    L.push(`  ${usageSummary(usage)}`);
    for (const a of orderAccounts(usage.accounts)) {
      const head = `  ${pad(a.label, 30)} ${pad(a.provider, 15)} ${ACCOUNT_STATE_LABEL[a.status]}`;
      const tail = [a.detail ?? (a.status === "off" ? "서버에서 사용 중지" : null), a.meta]
        .filter((part): part is string => part !== null);
      L.push(tail.length > 0 ? `${head} · ${tail.join(" · ")}` : head);
      const windows = [...a.windows, ...leftoverModelWindows(a)];
      // Size the value column to its own content: a model-scoped label
      // ("claude-sonnet-5 overage") is wider than a bare window name, and a
      // fixed width would push its percentage out of line.
      const width = windows.reduce((max, w) => Math.max(max, displayWidth(w.label)), MIN_WINDOW_WIDTH);
      for (const w of windows) L.push(`      ${pad(w.label, width)} ${renderWindow(w)}`);
    }
  }

  return L.join("\n");
}

function usageSummary(usage: Extract<UsageResult, { supported: true }>): string {
  const active = usage.accounts.filter((a) => a.status !== "off").length;
  const withUsage = usage.accounts.filter((a) => a.windows.length > 0 || a.models.length > 0);
  const parts = [
    `활성 ${active}`,
    `비활성 ${usage.accounts.length - active}`,
    `사용량 관측 ${withUsage.length}`,
  ];
  // Every watermark behind the rows still shown, so the age cannot look fresher
  // than the oldest number beneath it.
  const times = withUsage.map((a) => a.observedAt).filter((t): t is number => t !== null);
  if (times.length > 0) parts.push(`스냅샷 ${formatAgo(Math.min(...times))}`);
  return parts.join(" · ");
}

/** Accounts carrying live watermarks first, then healthy, then disabled. */
function orderAccounts(accounts: UsageAccount[]): UsageAccount[] {
  const rank = (a: UsageAccount): number =>
    a.windows.length > 0 || a.models.length > 0 ? 0 : a.status === "off" ? 2 : 1;
  return [...accounts].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/**
 * Model-scoped rows, minus anything the account row already shows. Codex
 * mirrors one snapshot onto every model (so nothing is added), while Claude
 * keeps per-model claims whose numbers can genuinely differ.
 */
function leftoverModelWindows(account: UsageAccount): UsageWindow[] {
  const shown = new Set(account.windows.map(windowKey));
  const seen = new Set<string>();
  const out: UsageWindow[] = [];
  for (const model of account.models) {
    for (const window of model.windows) {
      const key = windowKey(window);
      if (shown.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ ...window, label: `${model.id} ${window.label}` });
    }
  }
  return out;
}

/**
 * Identity of a rendered window: everything the row prints after its label.
 * Two windows are the same row only when they would render identically —
 * matching on the percentage alone would hide a window that differs in its
 * reset instant.
 */
function windowKey(window: UsageWindow): string {
  return `${window.label}|${window.remainingPercent}|${window.resetsAt}|${window.note}`;
}

function renderWindow(window: UsageWindow): string {
  const percent = window.remainingPercent === null ? "n/a" : `${window.remainingPercent}%`;
  const reset = window.resetsAt === null ? null : `리셋 ${formatReset(window.resetsAt)}`;
  return [percent, window.note, reset].filter((part): part is string => part !== null).join(" · ");
}

/** Relative inside two days, absolute beyond it, so "3일 후" never hides a date. */
function formatReset(at: number): string {
  const remaining = at - Date.now();
  if (remaining <= 0) return "도래";
  if (remaining < 48 * 60 * 60 * 1000) return `${formatAgo(at, "후")}`;
  const at_ = new Date(at);
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  return `${at_.getMonth() + 1}/${at_.getDate()} ${pad2(at_.getHours())}:${pad2(at_.getMinutes())}`;
}

function formatAgo(at: number, suffix = "전"): string {
  const total = Math.max(0, Math.round(Math.abs(at - Date.now()) / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}일 ${hours}시간 ${suffix}`;
  if (hours > 0) return `${hours}시간 ${minutes}분 ${suffix}`;
  return `${minutes}분 ${suffix}`;
}
