/**
 * @fileoverview Prevents duplicate interface-runtime processes from polling the same providers concurrently.
 */

import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

interface InterfaceRuntimeLockRecord {
  pid: number;
  acquiredAt: string;
  argv: string[];
  cwd: string;
}

interface InterfaceRuntimeLockOptions {
  lockPath?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  nowMs?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface InterfaceRuntimeLockHandle {
  release(): Promise<void>;
}

const DEFAULT_LOCK_TIMEOUT_MS = 1_500;
const DEFAULT_POLL_INTERVAL_MS = 50;
function resolveInterfaceRuntimeLockPath(): string {
  return path.resolve(process.cwd(), "runtime/interface_runtime.lock");
}

function isNodeErrno(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

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

function buildInterfaceRuntimeLockRecord(): InterfaceRuntimeLockRecord {
  return {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    argv: [...process.argv],
    cwd: process.cwd()
  };
}

async function readInterfaceRuntimeLockRecord(
  lockPath: string
): Promise<InterfaceRuntimeLockRecord | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<InterfaceRuntimeLockRecord>;
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.acquiredAt === "string" &&
      Array.isArray(parsed.argv) &&
      typeof parsed.cwd === "string"
    ) {
      return {
        pid: parsed.pid,
        acquiredAt: parsed.acquiredAt,
        argv: parsed.argv.filter((value): value is string => typeof value === "string"),
        cwd: parsed.cwd
      };
    }
  } catch (error) {
    if (isNodeErrno(error) && error.code === "ENOENT") {
      return null;
    }
  }
  return null;
}

/**
 * Acquires the single-process interface runtime lock used to prevent duplicate provider pollers.
 *
 * @param options - Optional timing and liveness overrides for tests.
 * @returns Lock handle released during runtime shutdown.
 */
export async function acquireInterfaceRuntimeLock(
  options: InterfaceRuntimeLockOptions = {}
): Promise<InterfaceRuntimeLockHandle> {
  const lockPath = options.lockPath ?? resolveInterfaceRuntimeLockPath();
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const nowMs = options.nowMs ?? (() => Date.now());
  const processAlive = options.isProcessAlive ?? isProcessAlive;
  const startedAt = nowMs();

  await mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      let released = false;
      try {
        await handle.writeFile(
          `${JSON.stringify(buildInterfaceRuntimeLockRecord(), null, 2)}\n`,
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
          await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      if (
        !isNodeErrno(error) ||
        (error.code !== "EEXIST" && error.code !== "EPERM" && error.code !== "EACCES")
      ) {
        throw error;
      }

      const existing = await readInterfaceRuntimeLockRecord(
        lockPath
      );
      if (existing && !processAlive(existing.pid)) {
        await rm(lockPath, { force: true });
        continue;
      }

      if (nowMs() - startedAt >= timeoutMs) {
        if (!existing) {
          throw new Error(
            `Interface runtime startup is blocked by a malformed or incomplete lock file at ` +
            `${lockPath}. Remove it if no interface runtime is still starting.`
          );
        }
        throw new Error(
          `Another interface runtime is already running (pid ${existing.pid}). ` +
          `Stop the older interface process or remove ${lockPath} if it is stale.`
        );
      }

      await sleep(pollIntervalMs);
    }
  }
}
