import { describe, expect, test } from "bun:test";
import { parseRefs, toRoot } from "../src/config.ts";

describe("toRoot", () => {
  test("strips the api suffix", () => {
    expect(toRoot("http://h:8317/v1")).toBe("http://h:8317");
    expect(toRoot("http://h:8317/v1beta")).toBe("http://h:8317");
    expect(toRoot("http://h:8317")).toBe("http://h:8317");
    expect(toRoot("http://h:8317/")).toBe("http://h:8317");
  });
});

describe("parseRefs", () => {
  test("extracts provider/model refs with line numbers", () => {
    const refs = parseRefs([
      '{',
      '  "model": "local-proxy/gpt-spark",',
      '  "other": "local-proxy-anthropic/sonnet"',
      '}',
    ].join("\n"));
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ line: 2, provider: "local-proxy", id: "gpt-spark" });
    expect(refs[1]).toMatchObject({ line: 3, provider: "local-proxy-anthropic", id: "sonnet" });
  });

  test("ignores commented-out lines", () => {
    expect(parseRefs('  // "model": "local-proxy/dead"')).toHaveLength(0);
  });

  test("ignores non-CPA providers", () => {
    expect(parseRefs('"model": "anthropic/claude"')).toHaveLength(0);
  });
});
