/**
 * @fileoverview Persists planner failure fingerprint strike/cooldown state for deterministic fail-safe throttling.
 */

import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { withSqliteDatabase } from "./sqliteStore";

export type PlannerFailureFingerprintEntry = {
  strikes: number;
  lastFailureAtMs: number;
  blockedUntilMs: number;
};

export interface PlannerFailureStore {
  get(fingerprint: string): Promise<PlannerFailureFingerprintEntry | undefined>;
  upsert(fingerprint: string, entry: PlannerFailureFingerprintEntry): Promise<void>;
  delete(fingerprint: string): Promise<void>;
  cleanupOlderThan(staleBeforeMs: number): Promise<void>;
}

/**
 * Normalizes entry into a stable shape for `plannerFailureStore` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for entry so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `PlannerFailureFingerprintEntry | undefined` result.
 */
function normalizeEntry(input: unknown): PlannerFailureFingerprintEntry | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const strikes = Number(record.strikes);
  const lastFailureAtMs = Number(record.lastFailureAtMs);
  const blockedUntilMs = Number(record.blockedUntilMs);
  if (
    !Number.isFinite(strikes) ||
    strikes < 0 ||
    !Number.isFinite(lastFailureAtMs) ||
    lastFailureAtMs < 0 ||
    !Number.isFinite(blockedUntilMs) ||
    blockedUntilMs < 0
  ) {
    return undefined;
  }

  return {
    strikes: Math.floor(strikes),
    lastFailureAtMs: Math.floor(lastFailureAtMs),
    blockedUntilMs: Math.floor(blockedUntilMs)
  };
}

export class InMemoryPlannerFailureStore implements PlannerFailureStore {
  private readonly entries = new Map<string, PlannerFailureFingerprintEntry>();

  /**
   * Reads input needed for this execution step.
   *
   * **Why it exists:**
   * Separates input read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param fingerprint - Value for fingerprint.
   * @returns Promise resolving to PlannerFailureFingerprintEntry | undefined.
   */
  async get(fingerprint: string): Promise<PlannerFailureFingerprintEntry | undefined> {
    const entry = this.entries.get(fingerprint);
    if (!entry) {
      return undefined;
    }

    return { ...entry };
  }

  /**
   * Persists input with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes input mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param fingerprint - Value for fingerprint.
   * @param entry - Value for entry.
   * @returns Promise resolving to void.
   */
  async upsert(fingerprint: string, entry: PlannerFailureFingerprintEntry): Promise<void> {
    this.entries.set(fingerprint, { ...entry });
  }

  /**
   * Removes input according to deterministic lifecycle rules.
   *
   * **Why it exists:**
   * Ensures input removal follows deterministic lifecycle and retention rules.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param fingerprint - Value for fingerprint.
   * @returns Promise resolving to void.
   */
  async delete(fingerprint: string): Promise<void> {
    this.entries.delete(fingerprint);
  }

  /**
   * Cleans up older than according to deterministic retention rules.
   *
   * **Why it exists:**
   * Keeps older than lifecycle mutation logic centralized to reduce drift in state transitions.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param staleBeforeMs - Duration value in milliseconds.
   * @returns Promise resolving to void.
   */
  async cleanupOlderThan(staleBeforeMs: number): Promise<void> {
    for (const [fingerprint, entry] of this.entries.entries()) {
      if (entry.lastFailureAtMs < staleBeforeMs) {
        this.entries.delete(fingerprint);
      }
    }
  }
}

export class SqlitePlannerFailureStore implements PlannerFailureStore {
  private sqliteReady = false;
  private readonly sqlitePath: string;

  /**
   * Initializes `SqlitePlannerFailureStore` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses `path` (import `default`) from `node:path`.
   *
   * @param sqlitePath - Filesystem location used by this operation.
   */
  constructor(sqlitePath: string = path.resolve(process.cwd(), "runtime/ledgers.sqlite")) {
    this.sqlitePath = sqlitePath;
  }

  /**
   * Reads input needed for this execution step.
   *
   * **Why it exists:**
   * Separates input read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   *
   * @param fingerprint - Value for fingerprint.
   * @returns Promise resolving to PlannerFailureFingerprintEntry | undefined.
   */
  async get(fingerprint: string): Promise<PlannerFailureFingerprintEntry | undefined> {
    await this.ensureSchema();
    return withSqliteDatabase(this.sqlitePath, async (db) => {
      const row = db
        .prepare(
          `SELECT strikes, last_failure_at_ms, blocked_until_ms
           FROM planner_failure_fingerprints
           WHERE fingerprint = ?`
        )
        .get(fingerprint) as Record<string, unknown> | undefined;
      if (!row) {
        return undefined;
      }
      return normalizeEntry({
        strikes: row.strikes,
        lastFailureAtMs: row.last_failure_at_ms,
        blockedUntilMs: row.blocked_until_ms
      });
    });
  }

  /**
   * Persists input with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes input mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   *
   * @param fingerprint - Value for fingerprint.
   * @param entry - Value for entry.
   * @returns Promise resolving to void.
   */
  async upsert(fingerprint: string, entry: PlannerFailureFingerprintEntry): Promise<void> {
    await this.ensureSchema();
    await withSqliteDatabase(this.sqlitePath, async (db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        db.prepare(
          `INSERT INTO planner_failure_fingerprints (
            fingerprint,
            strikes,
            last_failure_at_ms,
            blocked_until_ms,
            updated_at_ms
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(fingerprint) DO UPDATE SET
            strikes = excluded.strikes,
            last_failure_at_ms = excluded.last_failure_at_ms,
            blocked_until_ms = excluded.blocked_until_ms,
            updated_at_ms = excluded.updated_at_ms`
        ).run(
          fingerprint,
          entry.strikes,
          entry.lastFailureAtMs,
          entry.blockedUntilMs,
          Date.now()
        );
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
    });
  }

  /**
   * Removes input according to deterministic lifecycle rules.
   *
   * **Why it exists:**
   * Ensures input removal follows deterministic lifecycle and retention rules.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   *
   * @param fingerprint - Value for fingerprint.
   * @returns Promise resolving to void.
   */
  async delete(fingerprint: string): Promise<void> {
    await this.ensureSchema();
    await withSqliteDatabase(this.sqlitePath, async (db) => {
      db.prepare("DELETE FROM planner_failure_fingerprints WHERE fingerprint = ?").run(fingerprint);
    });
  }

  /**
   * Cleans up older than according to deterministic retention rules.
   *
   * **Why it exists:**
   * Keeps older than lifecycle mutation logic centralized to reduce drift in state transitions.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   *
   * @param staleBeforeMs - Duration value in milliseconds.
   * @returns Promise resolving to void.
   */
  async cleanupOlderThan(staleBeforeMs: number): Promise<void> {
    await this.ensureSchema();
    await withSqliteDatabase(this.sqlitePath, async (db) => {
      db.prepare(
        "DELETE FROM planner_failure_fingerprints WHERE last_failure_at_ms < ? AND blocked_until_ms <= ?"
      ).run(staleBeforeMs, Date.now());
    });
  }

  /**
   * Applies deterministic validity checks for schema.
   *
   * **Why it exists:**
   * Fails fast when schema is invalid so later control flow stays safe and predictable.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   * @returns Promise resolving to void.
   */
  private async ensureSchema(): Promise<void> {
    if (this.sqliteReady) {
      return;
    }

    await withSqliteDatabase(this.sqlitePath, async (db) => {
      this.initSchema(db);
    });
    this.sqliteReady = true;
  }

  /**
   * Implements init schema behavior used by `plannerFailureStore`.
   *
   * **Why it exists:**
   * Keeps `init schema` behavior centralized so collaborating call sites stay consistent.
   *
   * **What it talks to:**
   * - Uses `DatabaseSync` (import `DatabaseSync`) from `node:sqlite`.
   *
   * @param db - Value for db.
   */
  private initSchema(db: DatabaseSync): void {
    db.exec(
      `CREATE TABLE IF NOT EXISTS planner_failure_fingerprints (
        fingerprint TEXT PRIMARY KEY,
        strikes INTEGER NOT NULL,
        last_failure_at_ms INTEGER NOT NULL,
        blocked_until_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_planner_failure_updated_at
       ON planner_failure_fingerprints(updated_at_ms)`
    );
  }
}

