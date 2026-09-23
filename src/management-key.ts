import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MANAGEMENT_KEY_FILE = join(homedir(), ".omo", "agent", "cpa-management-key");

/** Returns the saved secret, treating a missing/unreadable file as unconfigured. */
export function readManagementKey(path = MANAGEMENT_KEY_FILE): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Atomically saves a non-empty secret with owner-only file permissions. */
export function saveManagementKey(key: string, path = MANAGEMENT_KEY_FILE): void {
  const value = key.trim();
  if (!value) throw new Error("Management Key가 비어 있습니다");

  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${value}\n`, "utf8");
    closeSync(fd);
    fd = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* no temporary file to clean up */ }
    throw error;
  }
}

/** Removes a saved secret; clearing an already-absent key is harmless. */
export function clearManagementKey(path = MANAGEMENT_KEY_FILE): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
