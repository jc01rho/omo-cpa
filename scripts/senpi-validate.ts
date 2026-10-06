/**
 * Locate senpi's fallback-chain validator at runtime.
 *
 * These dev-only callers used to import one absolute path inside an nvm
 * install, which broke the moment omo moved to a Bun global install. senpi's
 * package `exports` map has no entry for `dist/core/...`, so the module cannot
 * be reached by a bare specifier; it has to be found on disk.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PACKAGE = "@code-yeongyu/senpi";
const SUBPATH = "dist/core/retry-fallback/validate.js";

export interface FallbackModelRegistry {
  find(provider: string, id: string): unknown;
  getAll(): unknown[];
}

export interface SenpiValidate {
  /** Mirrors senpi's `validateFallbackChains`; returns configuration warnings. */
  validateFallbackChains(chains: unknown, registry: FallbackModelRegistry): string[];
}

function nodeVersionRoots(base: string): string[] {
  try {
    return readdirSync(base).map((name) => join(base, name, "lib", "node_modules"));
  } catch {
    return [];
  }
}

function candidatePaths(env: NodeJS.ProcessEnv): string[] {
  const explicit = env["SENPI_PACKAGE_DIR"];
  const roots = [
    join(homedir(), ".bun", "install", "global", "node_modules"),
    ...nodeVersionRoots(join(homedir(), ".nvm", "versions", "node")),
    ...nodeVersionRoots(join(homedir(), ".local", "share", "mise", "installs", "node")),
  ];
  const candidates = explicit ? [join(explicit, SUBPATH)] : [];
  for (const root of roots) {
    candidates.push(join(root, PACKAGE, SUBPATH), join(root, "omo-ai", "node_modules", PACKAGE, SUBPATH));
  }
  return candidates;
}

export function resolveSenpiValidatePath(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = candidatePaths(env);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error(
    `Cannot find ${PACKAGE}/${SUBPATH}. Set SENPI_PACKAGE_DIR to the senpi package directory.\nTried:\n${candidates.join("\n")}`,
  );
}

export async function loadSenpiValidate(env: NodeJS.ProcessEnv = process.env): Promise<SenpiValidate> {
  return (await import(resolveSenpiValidatePath(env))) as SenpiValidate;
}
