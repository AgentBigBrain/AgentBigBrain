/**
 * @fileoverview Provides lazy SQLite database helpers for optional runtime ledger persistence backends.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

const SQLITE_BUSY_RETRY_LIMIT = 5;
const SQLITE_BUSY_RETRY_BASE_DELAY_MS = 20;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const sqliteOperationQueues = new Map<string, Promise<void>>();

/**
 * Resolves sqlite path from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of sqlite path by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param sqlitePath - Filesystem location used by this operation.
 * @returns Resulting string value.
 */
export function resolveSqlitePath(sqlitePath: string): string {
  return path.isAbsolute(sqlitePath)
    ? sqlitePath
    : path.resolve(process.cwd(), sqlitePath);
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
 * @param delayMs - Duration value in milliseconds.
 * @returns Promise resolving to void.
 */
async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Evaluates sqlite busy error and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the sqlite busy error policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param error - Value for error.
 * @returns `true` when this check passes.
 */
function isSqliteBusyError(error: unknown): boolean {
  const message = (error as Error)?.message?.toLowerCase?.() ?? "";
  return message.includes("sqlite_busy") || message.includes("database is locked");
}

/**
 * Implements with sqlite busy retries behavior used by `sqliteStore`.
 *
 * **Why it exists:**
 * Keeps `with sqlite busy retries` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param operation - Value for operation.
 * @returns Promise resolving to T.
 */
async function withSqliteBusyRetries<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= SQLITE_BUSY_RETRY_LIMIT) {
        throw error;
      }
      const retryDelayMs = SQLITE_BUSY_RETRY_BASE_DELAY_MS * (attempt + 1);
      await sleep(retryDelayMs);
    }
  }
}

/**
 * Executes queued by path as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the queued by path runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param resolvedPath - Filesystem location used by this operation.
 * @param operation - Value for operation.
 * @returns Promise resolving to T.
 */
async function runQueuedByPath<T>(resolvedPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = sqliteOperationQueues.get(resolvedPath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const queued = run.then(
    () => undefined,
    () => undefined
  );
  sqliteOperationQueues.set(resolvedPath, queued);
  try {
    return await run;
  } finally {
    if (sqliteOperationQueues.get(resolvedPath) === queued) {
      sqliteOperationQueues.delete(resolvedPath);
    }
  }
}

/**
 * Implements with sqlite database behavior used by `sqliteStore`.
 *
 * **Why it exists:**
 * Defines public behavior from `sqliteStore.ts` for other modules/tests.
 *
 * **What it talks to:**
 * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
 * - Uses `path` (import `default`) from `node:path`.
 * - Uses `DatabaseSync` (import `DatabaseSync`) from `node:sqlite`.
 *
 * @param sqlitePath - Filesystem location used by this operation.
 * @param operation - Value for operation.
 * @returns Promise resolving to T.
 */
export async function withSqliteDatabase<T>(
  sqlitePath: string,
  operation: (db: DatabaseSync) => T | Promise<T>
): Promise<T> {
  const resolvedPath = resolveSqlitePath(sqlitePath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });

  return runQueuedByPath(resolvedPath, async () =>
    withSqliteBusyRetries(async () => {
      const sqlite = await import("node:sqlite");
      using db = new sqlite.DatabaseSync(resolvedPath);
      db.exec("PRAGMA journal_mode=WAL;");
      db.exec("PRAGMA synchronous=NORMAL;");
      db.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS};`);
      return await operation(db);
    })
  );
}
