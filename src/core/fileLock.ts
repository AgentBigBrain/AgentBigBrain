/**
 * @fileoverview Provides deterministic file-locking and atomic-write helpers for runtime JSON stores.
 */

import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

interface FileLockOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

interface FileLockHandle {
  release: () => Promise<void>;
}

const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

/**
 * Evaluates node errno and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the node errno policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param error - Value for error.
 * @returns Computed `error is NodeJS.ErrnoException` result.
 */
function isNodeErrno(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

/**
 * Pauses execution for a bounded interval used by retry/backoff flows.
 *
 * **Why it exists:**
 * Avoids ad-hoc wait behavior by keeping retry/backoff timing in one deterministic helper.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param durationMs - Duration value in milliseconds.
 * @returns Promise resolving to void.
 */
async function sleep(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

/**
 * Implements acquire file lock behavior used by `fileLock`.
 *
 * **Why it exists:**
 * Keeps `acquire file lock` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
 * - Uses `open` (import `open`) from `node:fs/promises`.
 * - Uses `rm` (import `rm`) from `node:fs/promises`.
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param lockPath - Filesystem location used by this operation.
 * @param options - Optional tuning knobs for this operation.
 * @returns Promise resolving to FileLockHandle.
 */
async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions = {}
): Promise<FileLockHandle> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const startedAt = Date.now();
  await mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      let released = false;
      return {
        release: async (): Promise<void> => {
          if (released) {
            return;
          }
          released = true;
          await handle.close();
          try {
            await rm(lockPath, { force: true });
          } catch (error) {
            if (!isNodeErrno(error) || error.code !== "ENOENT") {
              throw error;
            }
          }
        }
      };
    } catch (error) {
      if (
        !isNodeErrno(error) ||
        (error.code !== "EEXIST" && error.code !== "EPERM" && error.code !== "EACCES")
      ) {
        throw error;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for file lock: ${path.basename(lockPath)}`);
      }

      await sleep(pollIntervalMs);
    }
  }
}

/**
 * Implements with file lock behavior used by `fileLock`.
 *
 * **Why it exists:**
 * Defines public behavior from `fileLock.ts` for other modules/tests.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param filePath - Filesystem location used by this operation.
 * @param operation - Value for operation.
 * @param options - Optional tuning knobs for this operation.
 * @returns Promise resolving to T.
 */
export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const lock = await acquireFileLock(`${filePath}.lock`, options);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

/**
 * Persists file atomic with deterministic state semantics.
 *
 * **Why it exists:**
 * Centralizes file atomic mutations for auditability and replay.
 *
 * **What it talks to:**
 * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
 * - Uses `rename` (import `rename`) from `node:fs/promises`.
 * - Uses `rm` (import `rm`) from `node:fs/promises`.
 * - Uses `writeFile` (import `writeFile`) from `node:fs/promises`.
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param filePath - Filesystem location used by this operation.
 * @param content - Value for content.
 * @returns Promise resolving to void.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dirPath = path.dirname(filePath);
  await mkdir(dirPath, { recursive: true });

  const tempFilePath = path.join(
    dirPath,
    `${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`
  );

  try {
    await writeFile(tempFilePath, content, "utf8");
    await rename(tempFilePath, filePath);
  } catch (error) {
    await rm(tempFilePath, { force: true });
    throw error;
  }
}
