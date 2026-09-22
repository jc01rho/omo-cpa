#!/usr/bin/env bun
/**
 * Install the plugin as an omo extension by writing a tiny loader that
 * re-exports this project's entry point (the pattern omo itself uses for its
 * built-in extensions).
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const EXT_DIR = join(homedir(), ".omo", "agent", "extensions");
const TARGET = join(EXT_DIR, "omo-cpa.ts");
const entry = resolve(import.meta.dir, "..", "src", "extension.ts");

const loader = `// omo-cpa extension loader. Delete this file to unload the plugin.
export { default } from "file://${entry}";
`;

await Bun.write(TARGET, loader);
console.log(`설치 완료: ${TARGET}`);
console.log(`  → ${entry}`);
console.log("omo를 새로 시작하면 /cpa 명령을 쓸 수 있습니다.");
