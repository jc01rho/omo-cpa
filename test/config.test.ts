import { describe, expect, test } from "bun:test";
import { loadConfig, toRoot, DEFAULT_BASE_URL } from "../src/config.ts";

describe("toRoot", () => {
  test("strips the api suffix", () => {
    expect(toRoot("http://h:8317/v1")).toBe("http://h:8317");
    expect(toRoot("http://h:8317/v1beta")).toBe("http://h:8317");
    expect(toRoot("http://h:8317")).toBe("http://h:8317");
    expect(toRoot("http://h:8317/")).toBe("http://h:8317");
  });
});

describe("loadConfig — independent of omo's own config files", () => {
  const ENV_KEYS = ["OMO_CPA_BASE_URL", "OMO_CPA_API_KEY", "OMO_CPA_MANAGEMENT_KEY"] as const;

  function withEnv<T>(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => T): T {
    const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(values)) process.env[k] = v;
    try {
      return run();
    } finally {
      for (const k of ENV_KEYS) delete process.env[k];
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    }
  }

  test("falls back to the built-in endpoint with no env and no files", () => {
    const loaded = withEnv({}, () => loadConfig());
    expect(loaded.config?.root).toBe(DEFAULT_BASE_URL);
    expect(loaded.apiKey).toBeNull();
    // An absent key is reported, never invented, and never fatal here.
    expect(loaded.reason).toMatch(/\/login|OMO_CPA_API_KEY/);
  });

  test("env overrides the endpoint and supplies the key", () => {
    const loaded = withEnv(
      { OMO_CPA_BASE_URL: "http://example:9000/v1", OMO_CPA_API_KEY: "senpi-test" },
      () => loadConfig(),
    );
    expect(loaded.config?.root).toBe("http://example:9000");
    expect(loaded.apiKey).toBe("senpi-test");
    expect(loaded.reason).toBeNull();
  });

  test("an explicit key (from /login) wins over the environment", () => {
    const loaded = withEnv({ OMO_CPA_API_KEY: "from-env" }, () => loadConfig("from-login"));
    expect(loaded.apiKey).toBe("from-login");
  });

  test("an explicit BASE URL from /login wins over the environment", () => {
    const loaded = withEnv(
      { OMO_CPA_BASE_URL: "http://env.example:9000" },
      () => loadConfig("from-login", "http://login.example:8317/v1"),
    );
    expect(loaded.config?.root).toBe("http://login.example:8317");
  });

  test("the config module names no omo-owned file", async () => {
    const source = await Bun.file(new URL("../src/config.ts", import.meta.url)).text();
    expect(source).not.toContain("models.json");
    expect(source).not.toContain("omo.jsonc");
  });
});
