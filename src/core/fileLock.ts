/**
 * @fileoverview Provides deterministic file-locking and atomic-write helpers for runtime JSON stores.
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_RUNTIME_ENTROPY_SOURCE,
  RuntimeEntropySource
} from "./runtimeEntropy";

interface FileLockOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  entropySource?: RuntimeEntropySource;
  isProcessAlive?: (pid: number) => boolean;
  malformedStaleAfterMs?: number;
}

interface FileLockHandle {
  release: () => Promise<void>;
}

interface FileLockRecord {
  pid: number;
  acquiredAt: string;
  targetPath: string;
}

interface FileLockInspection {
  record: FileLockRecord | null;
  ageMs: number | null;
}

const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_MALFORMED_STALE_AFTER_MS = 60_000;

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

/** Checks whether the process that owns a file lock is still alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeErrno(error) && error.code === "EPERM") {
      return true;
    }
    if (isNodeErrno(error) && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

/** Builds the persisted metadata written into a file-lock sidecar. */
function buildFileLockRecord(targetPath: string): FileLockRecord {
  return {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    targetPath
  };
}

/** Inspects an on-disk lock file and returns its parsed record plus observed age. */
async function inspectFileLock(
  lockPath: string,
  entropySource: RuntimeEntropySource
): Promise<FileLockInspection> {
  try {
    const [raw, lockStat] = await Promise.all([
      readFile(lockPath, "utf8"),
      stat(lockPath)
    ]);
    const ageMs = Math.max(0, entropySource.nowMs() - lockStat.mtimeMs);
    try {
      const parsed = JSON.parse(raw) as Partial<FileLockRecord>;
      if (
        typeof parsed.pid === "number" &&
        Number.isInteger(parsed.pid) &&
        parsed.pid > 0 &&
        typeof parsed.acquiredAt === "string" &&
        typeof parsed.targetPath === "string"
      ) {
        return {
          record: {
            pid: parsed.pid,
            acquiredAt: parsed.acquiredAt,
            targetPath: parsed.targetPath
          },
          ageMs
        };
      }
    } catch {
      // Intentionally ignore malformed JSON; caller decides whether stale reclaim is safe.
    }
    return {
      record: null,
      ageMs
    };
  } catch (error) {
    if (isNodeErrno(error) && error.code === "ENOENT") {
      return {
        record: null,
        ageMs: null
      };
    }
    if (
      isNodeErrno(error) &&
      (error.code === "EPERM" || error.code === "EACCES")
    ) {
      try {
        const lockStat = await stat(lockPath);
        return {
          record: null,
          ageMs: Math.max(0, entropySource.nowMs() - lockStat.mtimeMs)
        };
      } catch (statError) {
        if (isNodeErrno(statError) && statError.code === "ENOENT") {
          return {
            record: null,
            ageMs: null
          };
        }
        if (
          isNodeErrno(statError) &&
          (statError.code === "EPERM" || statError.code === "EACCES")
        ) {
          return {
            record: null,
            ageMs: null
          };
        }
        throw statError;
      }
    }
    throw error;
  }
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
  const entropySource = options.entropySource ?? DEFAULT_RUNTIME_ENTROPY_SOURCE;
  const processAlive = options.isProcessAlive ?? isProcessAlive;
  const malformedStaleAfterMs = Math.max(
    1,
    options.malformedStaleAfterMs ?? DEFAULT_MALFORMED_STALE_AFTER_MS
  );
  const startedAt = entropySource.nowMs();
  await mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      let released = false;
      try {
        await handle.writeFile(
          `${JSON.stringify(buildFileLockRecord(lockPath.slice(0, -".lock".length)), null, 2)}\n`,
          "utf8"
        );
      } catch (error) {
        await handle.close();
        await rm(lockPath, { force: true });
        throw error;
      }
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

      const existing = await inspectFileLock(lockPath, entropySource);
      if (existing.record && !processAlive(existing.record.pid)) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (!existing.record && existing.ageMs !== null && existing.ageMs >= malformedStaleAfterMs) {
        await rm(lockPath, { force: true });
        continue;
      }

      if (entropySource.nowMs() - startedAt >= timeoutMs) {
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
 * Builds deterministic atomic-write temp file path from available runtime context.
 *
 * **Why it exists:**
 * Centralizes temp-path naming so atomic-write behavior is testable and free of ad-hoc
 * `Date.now`/`Math.random` usage across call sites.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 * - Uses `RuntimeEntropySource` (import `RuntimeEntropySource`) from `./runtimeEntropy`.
 * - Uses `DEFAULT_RUNTIME_ENTROPY_SOURCE` (import `DEFAULT_RUNTIME_ENTROPY_SOURCE`) from `./runtimeEntropy`.
 *
 * @param filePath - Final destination file path.
 * @param entropySource - Optional entropy source used for temp-name suffix generation.
 * @returns Deterministic temp file path shape for atomic write operations.
 */
export function buildAtomicWriteTempFilePath(
  filePath: string,
  entropySource: RuntimeEntropySource = DEFAULT_RUNTIME_ENTROPY_SOURCE
): string {
  const dirPath = path.dirname(filePath);
  const basename = path.basename(filePath);
  const timestampToken = String(entropySource.nowMs());
  const randomToken = entropySource.randomHex(12);
  return path.join(dirPath, `${basename}.tmp-${process.pid}-${timestampToken}-${randomToken}`);
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
 * - Uses `buildAtomicWriteTempFilePath` in this module.
 * - Uses `RuntimeEntropySource` (import `RuntimeEntropySource`) from `./runtimeEntropy`.
 *
 * @param filePath - Filesystem location used by this operation.
 * @param content - Value for content.
 * @param entropySource - Optional entropy source used for deterministic temp-name generation.
 * @returns Promise resolving to void.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  entropySource: RuntimeEntropySource = DEFAULT_RUNTIME_ENTROPY_SOURCE
): Promise<void> {
  const dirPath = path.dirname(filePath);
  await mkdir(dirPath, { recursive: true });

  const tempFilePath = buildAtomicWriteTempFilePath(filePath, entropySource);

  try {
    await writeFile(tempFilePath, content, "utf8");
    await rename(tempFilePath, filePath);
  } catch (error) {
    await rm(tempFilePath, { force: true });
    throw error;
  }
}
