import { describe, expect, test } from "bun:test";
import { deriveWindows, fetchUsage, parseAuthFiles } from "../src/usage.ts";
import { renderReport, displayWidth } from "../src/render.ts";
import { HealthTracker } from "../src/health.ts";
import type { CpaConfig } from "../src/types.ts";

/** Serves one canned response so fetchUsage is exercised over a real socket. */
async function withServer(
  handler: (req: Request) => Response | Promise<Response>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ port: 0, fetch: handler });
  try {
    await run(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop(true);
  }
}

/**
 * Fixtures mirror the live `GET /v0/management/auth-files` shape (captured
 * 2026-09-24 from the CPA at port 8317): a `{files:[…], observed_at}` envelope
 * whose entries carry upstream header snapshots under `quota.signals` and
 * `model_quotas.<id>.signals`.
 */
const codexSignals = {
  "X-Codex-Active-Limit": "premium",
  "X-Codex-Credits-Balance": "0",
  "X-Codex-Credits-Has-Credits": "False",
  "X-Codex-Credits-Unlimited": "False",
  "X-Codex-Plan-Type": "pro",
  "X-Codex-Primary-Over-Secondary-Limit-Percent": "0",
  "X-Codex-Primary-Reset-After-Seconds": "203427",
  "X-Codex-Primary-Reset-At": "1790452922",
  "X-Codex-Primary-Used-Percent": "39",
  "X-Codex-Primary-Window-Minutes": "10080",
  "X-Codex-Secondary-Reset-After-Seconds": "0",
  "X-Codex-Secondary-Used-Percent": "0",
  "X-Codex-Secondary-Window-Minutes": "0",
};

const claudeSignals = {
  "Anthropic-Ratelimit-Unified-Overage-Reset": "1790310427",
  "Anthropic-Ratelimit-Unified-Overage-Status": "allowed",
  "Anthropic-Ratelimit-Unified-Overage-Utilization": "0.43",
  "Anthropic-Ratelimit-Unified-Representative-Claim": "overage",
  "Anthropic-Ratelimit-Unified-Reset": "1790310427",
  "Anthropic-Ratelimit-Unified-Status": "allowed",
};

const codexFile = {
  account: "codex-user@example.com",
  account_type: "oauth",
  auth_index: "0a1b2c3d4e5f6071",
  disabled: false,
  email: "codex-user@example.com",
  failed: 0,
  label: "codex-user@example.com",
  name: "codex-user.json",
  provider: "codex",
  quota: { observed_at: "2026-09-24T20:31:41+09:00", signals: codexSignals },
  model_quotas: {
    "gpt-6-luna": { observed_at: "2026-09-24T20:31:41+09:00", signals: codexSignals },
  },
  status: "active",
  status_message: "",
  success: 63,
  type: "codex",
  unavailable: false,
};

const claudeFile = {
  account: "claude-user@example.com",
  auth_index: "1b2c3d4e5f607182",
  disabled: false,
  email: "claude-user@example.com",
  label: "claude-user@example.com",
  name: "claude-user.json",
  provider: "claude",
  quota: { observed_at: "2026-09-24T20:31:41+09:00", signals: claudeSignals },
  status: "active",
  status_message: "",
  type: "claude",
  unavailable: false,
};

const emptyQuotaFile = {
  auth_index: "2c3d4e5f60718293",
  disabled: false,
  email: "copilot-user@example.com",
  label: "copilot-user@example.com",
  name: "copilot-user.json",
  provider: "github-copilot",
  // A provider whose upstream response carried no quota header keeps an empty snapshot.
  quota: { signals: {} },
  status: "active",
  status_message: "",
  type: "github-copilot",
};

const disabledFile = {
  auth_index: "3d4e5f6071829304",
  disabled: true,
  email: "old-user@example.com",
  label: "old-user@example.com",
  name: "old-user.json",
  provider: "antigravity",
  quota: { signals: {} },
  status: "disabled",
  status_message: "",
  type: "antigravity",
};

const envelope = {
  files: [codexFile, claudeFile, emptyQuotaFile, disabledFile],
  observed_at: "2026-09-24T11:46:09.1490137Z",
};

describe("parseAuthFiles", () => {
  test("reads the documented {files:[…]} envelope", () => {
    const accounts = parseAuthFiles(envelope);
    expect(accounts).not.toBeNull();
    expect(accounts!.map((a) => a.provider)).toEqual([
      "codex", "claude", "github-copilot", "antigravity",
    ]);
  });

  test("keeps accepting bare arrays and legacy envelopes", () => {
    expect(parseAuthFiles([codexFile])!.length).toBe(1);
    expect(parseAuthFiles({ auth_files: [codexFile] })!.length).toBe(1);
    expect(parseAuthFiles({ data: [codexFile] })!.length).toBe(1);
  });

  test("returns null for an unrecognised shape so the caller can say so", () => {
    expect(parseAuthFiles({ accounts: [] })).toBeNull();
    expect(parseAuthFiles("nope")).toBeNull();
    expect(parseAuthFiles(null)).toBeNull();
  });

  test("maps field names and status without inventing values", () => {
    const [codex, claude, copilot, disabled] = parseAuthFiles(envelope)!;
    expect(codex!.label).toBe("codex-user@example.com");
    expect(codex!.status).toBe("ok");
    expect(codex!.meta).toContain("요금제 pro");
    expect(codex!.meta).toContain("한도 premium");
    // Credits are present but zero-disabled, so the balance is not advertised.
    expect(codex!.meta).not.toContain("크레딧");
    expect(claude!.meta).toContain("통합 allowed");
    expect(copilot!.status).toBe("ok");
    expect(copilot!.windows).toEqual([]);
    expect(disabled!.status).toBe("off");
  });

  test("a status_message becomes the error detail", () => {
    const [account] = parseAuthFiles([
      { ...emptyQuotaFile, status_message: "refresh failed" },
    ])!;
    expect(account!.status).toBe("error");
    expect(account!.detail).toBe("refresh failed");
  });

  test("unknown values never surface as a percentage", () => {
    const [account] = parseAuthFiles([
      { ...emptyQuotaFile, quota: { signals: { "X-Codex-Primary-Used-Percent": "not-a-number" } } },
    ])!;
    expect(account!.windows).toEqual([]);
  });

  test("a stale credential watermark is not dated from the listing envelope", async () => {
    const stale = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const fresh = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await withServer(
      () => Response.json({
        // The envelope timestamp is regenerated per request, so it always reads "0분 전".
        observed_at: new Date().toISOString(),
        files: [
          { ...codexFile, quota: { observed_at: stale, signals: codexSignals } },
          { ...claudeFile, quota: { observed_at: fresh, signals: claudeSignals } },
        ],
      }),
      async (root) => {
        const res = await fetchUsage(root, "k");
        if (!res.supported) throw new Error(res.reason);
        const ageMinutes = (Date.now() - res.observedAt!) / 60_000;
        expect(ageMinutes).toBeGreaterThanOrEqual(4);
        expect(ageMinutes).toBeLessThan(6);
      },
    );
  });

  test("an unparseable watermark time is unknown, not now", async () => {
    await withServer(
      () => Response.json({ files: [{ ...codexFile, quota: { observed_at: "nonsense", signals: codexSignals } }] }),
      async (root) => {
        const res = await fetchUsage(root, "k");
        if (!res.supported) throw new Error(res.reason);
        expect(res.observedAt).toBeNull();
      },
    );
  });

  test("per-model snapshots are read for model-scoped credentials", () => {
    const [account] = parseAuthFiles([
      { ...claudeFile, quota: { signals: {} }, model_quotas: claudeFile.quota ? { "claude-opus-5": { signals: claudeSignals } } : {} },
    ])!;
    expect(account!.models.map((m) => m.id)).toEqual(["claude-opus-5"]);
    expect(account!.models[0]!.windows.length).toBeGreaterThan(0);
  });
});

describe("deriveWindows", () => {
  test("codex primary window converts used-percent to remaining", () => {
    const windows = deriveWindows(codexSignals);
    const primary = windows.find((w) => w.label === "7일");
    expect(primary).toBeDefined();
    expect(primary!.remainingPercent).toBe(61);
    // Epoch seconds become an absolute instant.
    expect(primary!.resetsAt).toBe(1790452922 * 1000);
  });

  test("a zero-length window is dropped, not shown as 100% remaining", () => {
    const windows = deriveWindows(codexSignals);
    expect(windows.map((w) => w.label)).toEqual(["7일"]);
  });

  test("window length drives the label", () => {
    expect(deriveWindows({ "X-Codex-Primary-Used-Percent": "10", "X-Codex-Primary-Window-Minutes": "300" })[0]!.label)
      .toBe("5시간");
    expect(deriveWindows({ "X-Codex-Primary-Used-Percent": "10", "X-Codex-Primary-Window-Minutes": "90" })[0]!.label)
      .toBe("90분");
  });

  test("anthropic utilization is a fraction of the allowance", () => {
    const windows = deriveWindows({
      "Anthropic-Ratelimit-Unified-5h-Utilization": "0.43",
      "Anthropic-Ratelimit-Unified-5h-Reset": "1790310427",
    });
    expect(windows).toEqual([
      { label: "5시간", remainingPercent: 57, resetsAt: 1790310427 * 1000, note: null },
    ]);
  });

  test("anthropic overage window keeps its own name", () => {
    const [window] = deriveWindows(claudeSignals);
    expect(window!.label).toBe("overage");
    expect(window!.remainingPercent).toBe(57);
  });

  test("reset-only signals do not fabricate a window", () => {
    expect(deriveWindows({ "Anthropic-Ratelimit-Unified-Reset": "1790310427" })).toEqual([]);
  });

  test("relative reset seconds are used when no absolute instant exists", () => {
    const before = Date.now();
    const [window] = deriveWindows({
      "X-Codex-Primary-Used-Percent": "5",
      "X-Codex-Primary-Window-Minutes": "60",
      "X-Codex-Primary-Reset-After-Seconds": "600",
    });
    expect(window!.resetsAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(window!.resetsAt).toBeLessThan(before + 601_000);
  });

  test("covers every window name the server can emit", () => {
    // Taken from the server's own header vocabulary (helps/claude_ratelimit.go).
    const windows = deriveWindows({
      "Anthropic-Ratelimit-Unified-5h-Utilization": "0.10",
      "Anthropic-Ratelimit-Unified-5h-Reset": "1790310427",
      "Anthropic-Ratelimit-Unified-5h-Status": "allowed",
      "Anthropic-Ratelimit-Unified-7d-Utilization": "0.20",
      "Anthropic-Ratelimit-Unified-7d-Status": "allowed",
      "Anthropic-Ratelimit-Unified-7d_oi-Utilization": "0.30",
      "Anthropic-Ratelimit-Unified-Overage-Utilization": "0.43",
      "Anthropic-Ratelimit-Unified-Overage-Status": "allowed",
      "Anthropic-Ratelimit-Unified-Status": "allowed",
      "Anthropic-Ratelimit-Unified-Representative-Claim": "overage",
    });
    expect(windows.map((w) => [w.label, w.remainingPercent])).toEqual([
      ["5시간", 90],
      ["7일", 80],
      ["7일(추가)", 70],
      ["overage", 57],
    ]);
  });

  test("an account-wide Status signal does not become a window of its own", () => {
    // Anthropic sends a bare -Status/-Reset alongside the per-window ones.
    expect(deriveWindows({
      "Anthropic-Ratelimit-Unified-Reset": "1790310427",
      "Anthropic-Ratelimit-Unified-Status": "allowed",
    })).toEqual([]);
  });

  test("a rejected 7d_oi window is exhausted while 5h stays usable", () => {
    const windows = deriveWindows({
      "Anthropic-Ratelimit-Unified-7d_oi-Utilization": "0.30",
      "Anthropic-Ratelimit-Unified-7d_oi-Status": "rejected",
      "Anthropic-Ratelimit-Unified-5h-Utilization": "0.10",
      "Anthropic-Ratelimit-Unified-5h-Status": "allowed",
    });
    expect(windows.map((w) => [w.label, w.remainingPercent, w.note])).toEqual([
      ["7일(추가)", 0, "한도 도달"],
      ["5시간", 90, null],
    ]);
  });

  test("a rejected window is shown as exhausted even without a utilization", () => {
    // The refusal itself is the fact; a missing percentage must not hide it.
    expect(deriveWindows({ "Anthropic-Ratelimit-Unified-5h-Status": "rejected" })[0]).toEqual({
      label: "5시간", remainingPercent: 0, resetsAt: null, note: "한도 도달",
    });
    // Without a refusal, a bare window name stays hidden as before.
    expect(deriveWindows({ "Anthropic-Ratelimit-Unified-5h-Reset": "1790310427" })).toEqual([]);
  });

  test("a zero-length rejected window is still an unused slot", () => {
    expect(deriveWindows({
      "X-Codex-Secondary-Limit-Reached": "true",
      "X-Codex-Secondary-Window-Minutes": "0",
    })).toEqual([]);
  });

  test("a namespaced extra limit is labelled by its limit name", () => {
    const windows = deriveWindows({
      "X-Codex-Additional-Bengalfox-Limit-Name": "Spark",
      "X-Codex-Additional-Bengalfox-Primary-Used-Percent": "80",
      "X-Codex-Additional-Bengalfox-Primary-Window-Minutes": "10080",
    });
    expect(windows).toEqual([
      { label: "Spark 7일", remainingPercent: 20, resetsAt: null, note: "Spark" },
    ]);
  });

  test("a window the upstream refused never reads as an allowance", () => {
    // Anthropic keeps reporting the utilization it measured on a rejected window.
    expect(deriveWindows({
      "Anthropic-Ratelimit-Unified-5h-Utilization": "0.43",
      "Anthropic-Ratelimit-Unified-5h-Status": "rejected",
    })[0]).toEqual({ label: "5시간", remainingPercent: 0, resetsAt: null, note: "한도 도달" });
    expect(deriveWindows({
      "X-Codex-Primary-Used-Percent": "39",
      "X-Codex-Primary-Window-Minutes": "10080",
      "X-Codex-Primary-Limit-Reached": "true",
    })[0]).toEqual({ label: "7일", remainingPercent: 0, resetsAt: null, note: "한도 도달" });
  });

  test("healthy rejection-shaped signals stay healthy", () => {
    // "allowed_warning" and allowed=true are the upstream saying "still usable".
    expect(deriveWindows({
      "Anthropic-Ratelimit-Unified-5h-Utilization": "0.99",
      "Anthropic-Ratelimit-Unified-5h-Status": "allowed_warning",
    })[0]!.remainingPercent).toBe(1);
    expect(deriveWindows({
      "X-Codex-Primary-Used-Percent": "39",
      "X-Codex-Primary-Window-Minutes": "10080",
      "X-Codex-Primary-Allowed": "true",
    })[0]!.remainingPercent).toBe(61);
    // An empty disabled-reason is the absence of a reason.
    expect(deriveWindows({
      "Anthropic-Ratelimit-Unified-Overage-Utilization": "0.43",
      "Anthropic-Ratelimit-Unified-Overage-Disabled-Reason": "",
    })[0]!.remainingPercent).toBe(57);
  });

  test("a credential-wide rejection flag applies to every window", () => {
    const windows = deriveWindows({
      "X-Codex-Limit-Reached": "true",
      "X-Codex-Primary-Used-Percent": "39",
      "X-Codex-Primary-Window-Minutes": "10080",
    });
    expect(windows[0]).toEqual({ label: "7일", remainingPercent: 0, resetsAt: null, note: "한도 도달" });
  });

  test("percentages are clamped to 0..100", () => {
    expect(deriveWindows({ "X-Codex-Primary-Used-Percent": "140", "X-Codex-Primary-Window-Minutes": "60" })[0]!.remainingPercent)
      .toBe(0);
    expect(deriveWindows({ "X-Codex-Primary-Used-Percent": "-10", "X-Codex-Primary-Window-Minutes": "60" })[0]!.remainingPercent)
      .toBe(100);
  });
});

describe("renderReport usage section", () => {
  const config: CpaConfig = {
    root: "http://127.0.0.1:8317", providers: [], source: "test", hasApiKey: true, hasManagementKey: true,
  };
  const render = (usage: Parameters<typeof renderReport>[0]["usage"]): string =>
    renderReport({ config, tiers: null, tierReason: null, health: new HealthTracker().snapshot(), usage });

  test("renders real watermarks instead of the n/a fallback", () => {
    const out = render({ supported: true, accounts: parseAuthFiles(envelope)!, observedAt: Date.now() });
    expect(out).not.toContain("형식을 알 수 없어");
    expect(out).toContain("codex-user@example.com");
    expect(out).toContain("61%");
    expect(out).toContain("비활성");
    expect(out).toContain("활성 3 · 비활성 1");
  });

  test("a disabled credential is labelled, not shown as an error", () => {
    const out = render({ supported: true, accounts: parseAuthFiles([disabledFile])!, observedAt: null });
    expect(out).toContain("비활성");
    expect(out).not.toContain("오류");
  });

  test("model-scoped watermarks render when the account has none", () => {
    const [account] = parseAuthFiles([
      { ...claudeFile, quota: { signals: {} }, model_quotas: { "claude-opus-5": { signals: claudeSignals } } },
    ])!;
    const out = render({ supported: true, accounts: [account!], observedAt: null });
    expect(out).toContain("claude-opus-5");
  });

  test("a mirrored model snapshot is not repeated under every model", () => {
    // Codex copies one snapshot onto each model; nothing new is added.
    const [account] = parseAuthFiles([codexFile])!;
    const out = render({ supported: true, accounts: [account!], observedAt: null });
    expect(out).toContain("7일");
    expect(out).not.toContain("gpt-6-luna");
  });

  test("a model-scoped window that differs from the account row is still shown", () => {
    const [account] = parseAuthFiles([
      {
        ...claudeFile,
        model_quotas: {
          "claude-sonnet-5": {
            signals: { "Anthropic-Ratelimit-Unified-Overage-Utilization": "0.10" },
          },
        },
      },
    ])!;
    const out = render({ supported: true, accounts: [account!], observedAt: null });
    expect(out).toContain("claude-sonnet-5 overage 90%");
  });

  test("percentages line up even when a model-scoped label is wider", () => {
    const [account] = parseAuthFiles([
      {
        ...claudeFile,
        model_quotas: {
          "claude-sonnet-5": { signals: { "Anthropic-Ratelimit-Unified-Overage-Utilization": "0.10" } },
        },
      },
    ])!;
    const rows = render({ supported: true, accounts: [account!], observedAt: null })
      .split("\n")
      .filter((line) => line.includes("%"));
    expect(rows.length).toBe(2);
    // The value column is sized to the widest label, so both percentages start together.
    const percentColumns = rows.map((line) => displayWidth(line.slice(0, line.indexOf("%"))));
    expect(percentColumns[0]).toBe(percentColumns[1]);
  });

  test("keeps the unsupported reason visible", () => {
    expect(render({ supported: false, reason: "Management 키 없음" }))
      .toContain("n/a · Management 키 없음");
  });

  test("an empty account list says so", () => {
    expect(render({ supported: true, accounts: [], observedAt: null })).toContain("계정 없음");
  });
});

describe("fetchUsage over a real socket", () => {
  test("parses the live envelope and sends the management key as a bearer token", async () => {
    let seenAuth: string | null = null;
    let seenPath: string | null = null;
    await withServer(
      (req) => {
        seenAuth = req.headers.get("authorization");
        seenPath = new URL(req.url).pathname;
        return Response.json(envelope);
      },
      async (root) => {
        const res = await fetchUsage(root, "mgmt-secret");
        expect(res.supported).toBe(true);
        if (!res.supported) throw new Error(res.reason);
        expect(res.accounts.length).toBe(4);
        // The reported age is the newest credential watermark, not the listing time.
        expect(res.observedAt).toBe(Date.parse(codexFile.quota.observed_at));
        expect(res.accounts[0]!.windows.length).toBeGreaterThan(0);
      },
    );
    // Asserted through String() so the closure assignments are not narrowed away.
    expect(String(seenPath)).toBe("/v0/management/auth-files");
    expect(String(seenAuth)).toBe("Bearer mgmt-secret");
  });

  test("reports a rejected key without reading the body", async () => {
    await withServer(
      () => new Response("unauthorized", { status: 401 }),
      async (root) => {
        expect(await fetchUsage(root, "bad")).toEqual({
          supported: false, reason: "Management 키가 거부됨 (HTTP 401)",
        });
      },
    );
  });

  test("reports an unrecognised envelope as a shape problem", async () => {
    await withServer(
      () => Response.json({ accounts: [] }),
      async (root) => {
        const res = await fetchUsage(root, "k");
        if (res.supported) throw new Error("expected unsupported");
        expect(res.reason.length).toBeGreaterThan(0);
      },
    );
  });

  test("an absent key never reaches the network", async () => {
    const res = await fetchUsage("http://127.0.0.1:1", null);
    expect(res).toEqual({
      supported: false,
      reason: "Management 키 없음 · OMO_CPA_MANAGEMENT_KEY를 설정하면 계정별 사용량이 켜집니다",
    });
  });
});
