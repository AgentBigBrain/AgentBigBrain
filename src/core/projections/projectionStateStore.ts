/**
 * @fileoverview Persists projection sync status so mirror rebuilds and sink failures remain reviewable across restarts.
 */

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { LedgerBackend } from "../config";
import { withFileLock, writeFileAtomic } from "../fileLock";
import { withSqliteDatabase } from "../sqliteStore";
import type {
  ProjectionStateSnapshot,
  ProjectionSinkSyncState
} from "./contracts";

const SQLITE_PROJECTION_STATE_TABLE = "projection_state";

interface ProjectionStateStoreOptions {
  backend?: LedgerBackend;
  sqlitePath?: string;
  exportJsonOnWrite?: boolean;
}

/**
 * Builds the zero-value sink sync state.
 *
 * **Why it exists:**
 * Every sink needs the same bootstrap shape so startup, rebuild, and failure paths can update
 * per-sink status without repeating partial object literals.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @returns Empty per-sink sync state.
 */
function createEmptyProjectionSinkSyncState(): ProjectionSinkSyncState {
  return {
    lastAttemptedAt: null,
    lastSucceededAt: null,
    lastError: null
  };
}

/**
 * Builds the zero-value projection-state snapshot.
 *
 * **Why it exists:**
 * Projection persistence should recover cleanly when no prior mirror state exists yet.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @returns Empty projection-state snapshot.
 */
function createEmptyProjectionStateSnapshot(): ProjectionStateSnapshot {
  return {
    schemaVersion: "v1",
    updatedAt: new Date().toISOString(),
    lastChangeId: null,
    lastRebuildAt: null,
    sinkStates: {}
  };
}

/**
 * Parses unknown persisted JSON into the canonical projection-state snapshot shape.
 *
 * **Why it exists:**
 * Sink-status persistence should fail closed on malformed disk state while still letting the
 * runtime rebuild from a clean zero-value snapshot.
 *
 * **What it talks to:**
 * - Uses local snapshot-normalization helpers within this module.
 *
 * @param input - Unknown persisted payload.
 * @returns Canonical projection-state snapshot.
 */
function parseProjectionStateSnapshot(input: unknown): ProjectionStateSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return createEmptyProjectionStateSnapshot();
  }
  const candidate = input as Partial<ProjectionStateSnapshot>;
  const sinkStates = !candidate.sinkStates || typeof candidate.sinkStates !== "object"
    ? {}
    : Object.fromEntries(
        Object.entries(candidate.sinkStates).map(([sinkId, value]) => [
          sinkId,
          parseProjectionSinkSyncState(value)
        ])
      );
  return {
    schemaVersion: "v1",
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim().length > 0
        ? candidate.updatedAt
        : new Date().toISOString(),
    lastChangeId:
      candidate.lastChangeId === null || typeof candidate.lastChangeId === "string"
        ? (candidate.lastChangeId ?? null)
        : null,
    lastRebuildAt:
      candidate.lastRebuildAt === null || typeof candidate.lastRebuildAt === "string"
        ? (candidate.lastRebuildAt ?? null)
        : null,
    sinkStates
  };
}

/**
 * Parses one per-sink status record into the canonical sync-state shape.
 *
 * **Why it exists:**
 * Projection state is per-sink, and this helper keeps malformed sink rows from leaking partial
 * status into operator-facing review and rebuild diagnostics.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Unknown persisted sink-state payload.
 * @returns Canonical per-sink sync state.
 */
function parseProjectionSinkSyncState(input: unknown): ProjectionSinkSyncState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return createEmptyProjectionSinkSyncState();
  }
  const candidate = input as Partial<ProjectionSinkSyncState>;
  return {
    lastAttemptedAt:
      candidate.lastAttemptedAt === null || typeof candidate.lastAttemptedAt === "string"
        ? (candidate.lastAttemptedAt ?? null)
        : null,
    lastSucceededAt:
      candidate.lastSucceededAt === null || typeof candidate.lastSucceededAt === "string"
        ? (candidate.lastSucceededAt ?? null)
        : null,
    lastError:
      candidate.lastError === null || typeof candidate.lastError === "string"
        ? (candidate.lastError ?? null)
        : null
  };
}

/**
 * Persists projection sink sync state with JSON or SQLite parity.
 */
export class ProjectionStateStore {
  private sqliteReady = false;
  private readonly backend: LedgerBackend;
  private readonly sqlitePath: string;
  private readonly exportJsonOnWrite: boolean;

  /**
   * Initializes the projection-state store.
   *
   * **Why it exists:**
   * Projection sinks are optional and failure-tolerant, but their last-known state still needs a
   * stable persistence surface for operator review and restart-safe rebuild behavior.
   *
   * **What it talks to:**
   * - Uses `path.resolve` (import `default`) from `node:path`.
   *
   * @param filePath - JSON export path for the projection-state snapshot.
   * @param options - Backend and SQLite parity options.
   */
  constructor(
    private readonly filePath = path.resolve(process.cwd(), "runtime/projection_state.json"),
    options: ProjectionStateStoreOptions = {}
  ) {
    this.backend = options.backend ?? "json";
    this.sqlitePath = options.sqlitePath ?? path.resolve(process.cwd(), "runtime/ledgers.sqlite");
    this.exportJsonOnWrite = options.exportJsonOnWrite ?? true;
  }

  /**
   * Reads the current projection-state snapshot.
   *
   * **Why it exists:**
   * Rebuild and sync paths need a stable read seam for sink status without caring whether the
   * runtime stores that snapshot in JSON or SQLite.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `../sqliteStore`.
   * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
   *
   * @returns Canonical projection-state snapshot.
   */
  async load(): Promise<ProjectionStateSnapshot> {
    if (this.backend === "sqlite") {
      await this.ensureSqliteReady();
      return withSqliteDatabase(this.sqlitePath, async (db) => {
        this.ensureSqliteSchema(db);
        return this.readSqliteSnapshot(db);
      });
    }
    try {
      const raw = await readFile(this.filePath, "utf8");
      return parseProjectionStateSnapshot(JSON.parse(raw));
    } catch {
      return createEmptyProjectionStateSnapshot();
    }
  }

  /**
   * Persists the current projection-state snapshot.
   *
   * **Why it exists:**
   * Projection sync updates happen across multiple sinks and should land through one store helper
   * so JSON and SQLite backends stay aligned.
   *
   * **What it talks to:**
   * - Uses `withFileLock` (import `withFileLock`) from `../fileLock`.
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `../fileLock`.
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `../sqliteStore`.
   *
   * @param snapshot - Canonical projection-state snapshot to persist.
   * @returns Promise resolving after persistence completes.
   */
  async save(snapshot: ProjectionStateSnapshot): Promise<void> {
    const normalized = parseProjectionStateSnapshot(snapshot);
    if (this.backend === "sqlite") {
      await this.ensureSqliteReady();
      await withSqliteDatabase(this.sqlitePath, async (db) => {
        this.ensureSqliteSchema(db);
        db.prepare(
          `INSERT INTO ${SQLITE_PROJECTION_STATE_TABLE} (singleton_id, snapshot_json)
           VALUES (1, ?)
           ON CONFLICT(singleton_id) DO UPDATE SET snapshot_json = excluded.snapshot_json`
        ).run(JSON.stringify(normalized));
      });
      if (this.exportJsonOnWrite) {
        await writeFileAtomic(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`);
      }
      return;
    }

    await withFileLock(this.filePath, async () => {
      await writeFileAtomic(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`);
    });
  }

  /**
   * Ensures the SQLite parent directory exists before state persistence.
   *
   * **Why it exists:**
   * Projection-state writes share the same parity model as other runtime stores and need one
   * bounded bootstrap step before touching SQLite.
   *
   * **What it talks to:**
   * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
   * - Uses `path.dirname` (import `default`) from `node:path`.
   *
   * @returns Promise resolving after the SQLite parent directory exists.
   */
  private async ensureSqliteReady(): Promise<void> {
    if (this.sqliteReady) {
      return;
    }
    await mkdir(path.dirname(this.sqlitePath), { recursive: true });
    this.sqliteReady = true;
  }

  /**
   * Ensures the SQLite schema exists for projection-state persistence.
   *
   * **Why it exists:**
   * Projection state is stored as one compact singleton document so restart-safe diagnostics can be
   * read and updated atomically.
   *
   * **What it talks to:**
   * - Uses `DatabaseSync` (import type `DatabaseSync`) from `node:sqlite`.
   *
   * @param db - Open SQLite handle.
   */
  private ensureSqliteSchema(db: DatabaseSync): void {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${SQLITE_PROJECTION_STATE_TABLE} (
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
        snapshot_json TEXT NOT NULL
      )`
    );
  }

  /**
   * Reads the canonical projection-state snapshot from SQLite.
   *
   * **Why it exists:**
   * SQLite persistence should reuse the same document parser as the JSON backend so operator review
   * sees one canonical state shape regardless of backend selection.
   *
   * **What it talks to:**
   * - Uses `DatabaseSync` (import type `DatabaseSync`) from `node:sqlite`.
   * - Uses local snapshot parser helpers within this module.
   *
   * @param db - Open SQLite handle.
   * @returns Canonical projection-state snapshot.
   */
  private readSqliteSnapshot(db: DatabaseSync): ProjectionStateSnapshot {
    const row = db.prepare(
      `SELECT snapshot_json
       FROM ${SQLITE_PROJECTION_STATE_TABLE}
       WHERE singleton_id = 1`
    ).get() as { snapshot_json?: unknown } | undefined;
    if (typeof row?.snapshot_json !== "string") {
      return createEmptyProjectionStateSnapshot();
    }
    return parseProjectionStateSnapshot(JSON.parse(row.snapshot_json));
  }
}
