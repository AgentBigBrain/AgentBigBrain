/**
 * @fileoverview Persists append-only governance decision events and exposes immutable read views for governors.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { LedgerBackend } from "./config";
import {
  ActionBlockReason,
  ConstraintViolationCode,
  GovernanceBlockCategory,
  GovernanceMemoryEvent,
  GovernanceMemoryReadView,
  GovernorId,
  isConstraintViolationCode,
  isGovernorId
} from "./types";
import { withFileLock, writeFileAtomic } from "./fileLock";
import { makeId } from "./ids";
import { buildProjectionChangeSet } from "./projections/service";
import { withSqliteDatabase } from "./sqliteStore";

const DEFAULT_RECENT_LIMIT = 25;
const SQLITE_GOVERNANCE_EVENTS_TABLE = "governance_events";
const SQLITE_GOVERNANCE_METADATA_TABLE = "governance_metadata";

interface GovernanceMemoryState {
  createdAt: string;
  lastAppendedAt?: string;
  events: GovernanceMemoryEvent[];
}

interface GovernanceMemoryStoreOptions {
  backend?: LedgerBackend;
  sqlitePath?: string;
  exportJsonOnWrite?: boolean;
  onChange?: (changeSet: import("./projections/contracts").ProjectionChangeSet) => Promise<void> | void;
}

interface AppendGovernanceMemoryEventInput {
  id?: string;
  recordedAt?: string;
  taskId: string;
  proposalId: string | null;
  actionId: string;
  actionType: GovernanceMemoryEvent["actionType"];
  mode: GovernanceMemoryEvent["mode"];
  outcome: GovernanceMemoryEvent["outcome"];
  blockCategory: GovernanceMemoryEvent["blockCategory"];
  blockedBy: ActionBlockReason[];
  violationCodes: ConstraintViolationCode[];
  yesVotes: number;
  noVotes: number;
  threshold: number | null;
  dissentGovernorIds: GovernorId[];
}

interface LegacyGovernanceMemoryEvent extends Omit<GovernanceMemoryEvent, "mode"> {
  mode: GovernanceMemoryEvent["mode"] | "constraint_only";
}

/**
 * Builds initial state for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of initial state consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @returns Computed `GovernanceMemoryState` result.
 */
function createInitialState(): GovernanceMemoryState {
  return {
    createdAt: new Date().toISOString(),
    events: []
  };
}

/**
 * Constrains and sanitizes utf8 bom to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for utf8 bom before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function stripUtf8Bom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

/**
 * Normalizes block category into a stable shape for `governanceMemory` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for block category so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `GovernanceBlockCategory` (import `GovernanceBlockCategory`) from `./types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `GovernanceBlockCategory` result.
 */
function normalizeBlockCategory(value: unknown): GovernanceBlockCategory {
  if (value === "constraints" || value === "governance" || value === "runtime") {
    return value;
  }
  return "none";
}

/**
 * Normalizes event into a stable shape for `governanceMemory` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for event so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `ActionBlockReason` (import `ActionBlockReason`) from `./types`.
 * - Uses `ConstraintViolationCode` (import `ConstraintViolationCode`) from `./types`.
 * - Uses `GovernanceMemoryEvent` (import `GovernanceMemoryEvent`) from `./types`.
 * - Uses `GovernorId` (import `GovernorId`) from `./types`.
 * - Uses `isConstraintViolationCode` (import `isConstraintViolationCode`) from `./types`.
 * - Uses `isGovernorId` (import `isGovernorId`) from `./types`.
 *
 * @param raw - Value for raw.
 * @returns Computed `GovernanceMemoryEvent | null` result.
 */
function normalizeEvent(raw: Partial<LegacyGovernanceMemoryEvent>): GovernanceMemoryEvent | null {
  if (
    typeof raw.id !== "string" ||
    typeof raw.recordedAt !== "string" ||
    typeof raw.taskId !== "string" ||
    typeof raw.actionId !== "string" ||
    typeof raw.actionType !== "string" ||
    typeof raw.mode !== "string" ||
    typeof raw.outcome !== "string"
  ) {
    return null;
  }

  if (raw.outcome !== "approved" && raw.outcome !== "blocked") {
    return null;
  }

  if (raw.mode !== "fast_path" && raw.mode !== "escalation_path" && raw.mode !== "constraint_only") {
    return null;
  }

  const normalizedMode = raw.mode === "constraint_only" ? "fast_path" : raw.mode;

  if (
    !Number.isFinite(raw.yesVotes) ||
    !Number.isFinite(raw.noVotes) ||
    !(raw.threshold === null || Number.isFinite(raw.threshold))
  ) {
    return null;
  }

  const blockedBy = Array.isArray(raw.blockedBy)
    ? raw.blockedBy.filter(
      (item): item is ActionBlockReason =>
        isConstraintViolationCode(item) || isGovernorId(item)
    )
    : [];
  const violationCodes = Array.isArray(raw.violationCodes)
    ? raw.violationCodes.filter(
      (item): item is ConstraintViolationCode => isConstraintViolationCode(item)
    )
    : [];
  const dissentGovernorIds = Array.isArray(raw.dissentGovernorIds)
    ? raw.dissentGovernorIds.filter((item): item is GovernorId => isGovernorId(item))
    : [];

  return {
    id: raw.id,
    recordedAt: raw.recordedAt,
    taskId: raw.taskId,
    proposalId: typeof raw.proposalId === "string" ? raw.proposalId : null,
    actionId: raw.actionId,
    actionType: raw.actionType as GovernanceMemoryEvent["actionType"],
    mode: normalizedMode,
    outcome: raw.outcome,
    blockCategory: normalizeBlockCategory(raw.blockCategory),
    blockedBy,
    violationCodes,
    yesVotes: Number(raw.yesVotes),
    noVotes: Number(raw.noVotes),
    threshold: raw.threshold ?? null,
    dissentGovernorIds
  };
}

/**
 * Normalizes state into a stable shape for `governanceMemory` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for state so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `GovernanceMemoryEvent` (import `GovernanceMemoryEvent`) from `./types`.
 *
 * @param raw - Value for raw.
 * @returns Computed `GovernanceMemoryState` result.
 */
function normalizeState(raw: Partial<GovernanceMemoryState>): GovernanceMemoryState {
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString();
  const events = Array.isArray(raw.events)
    ? raw.events
      .map((event) => normalizeEvent(event as Partial<LegacyGovernanceMemoryEvent>))
      .filter((event): event is GovernanceMemoryEvent => event !== null)
    : [];

  return {
    createdAt,
    lastAppendedAt: typeof raw.lastAppendedAt === "string" ? raw.lastAppendedAt : undefined,
    events
  };
}

/**
 * Implements freeze event behavior used by `governanceMemory`.
 *
 * **Why it exists:**
 * Keeps `freeze event` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `GovernanceMemoryEvent` (import `GovernanceMemoryEvent`) from `./types`.
 *
 * @param event - Value for event.
 * @returns Computed `GovernanceMemoryEvent` result.
 */
function freezeEvent(event: GovernanceMemoryEvent): GovernanceMemoryEvent {
  return Object.freeze({
    ...event,
    blockedBy: Object.freeze([...event.blockedBy]),
    violationCodes: Object.freeze([...event.violationCodes]),
    dissentGovernorIds: Object.freeze([...event.dissentGovernorIds])
  });
}

/**
 * Implements freeze read view behavior used by `governanceMemory`.
 *
 * **Why it exists:**
 * Keeps `freeze read view` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `GovernanceMemoryReadView` (import `GovernanceMemoryReadView`) from `./types`.
 *
 * @param view - Value for view.
 * @returns Computed `GovernanceMemoryReadView` result.
 */
function freezeReadView(view: GovernanceMemoryReadView): GovernanceMemoryReadView {
  return Object.freeze({
    ...view,
    recentEvents: Object.freeze(view.recentEvents.map((event) => freezeEvent(event))),
    recentBlockCounts: Object.freeze({ ...view.recentBlockCounts }),
    recentGovernorRejectCounts: Object.freeze({ ...view.recentGovernorRejectCounts })
  });
}

export class GovernanceMemoryStore {
  private loaded = false;
  private state: GovernanceMemoryState = createInitialState();
  private sqliteReady = false;
  private readonly backend: LedgerBackend;
  private readonly sqlitePath: string;
  private readonly exportJsonOnWrite: boolean;
  private readonly onChange?: GovernanceMemoryStoreOptions["onChange"];

  /**
   * Initializes `GovernanceMemoryStore` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses `path` (import `default`) from `node:path`.
   *
   * @param filePath - Filesystem location used by this operation.
   * @param options - Optional tuning knobs for this operation.
   */
  constructor(
    private readonly filePath: string = path.resolve(process.cwd(), "runtime/governance_memory.json"),
    options: GovernanceMemoryStoreOptions = {}
  ) {
    this.backend = options.backend ?? "json";
    this.sqlitePath = options.sqlitePath ?? path.resolve(process.cwd(), "runtime/ledgers.sqlite");
    this.exportJsonOnWrite = options.exportJsonOnWrite ?? true;
    this.onChange = options.onChange;
  }

  /**
   * Persists event with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes event mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `withFileLock` (import `withFileLock`) from `./fileLock`.
   * - Uses `makeId` (import `makeId`) from `./ids`.
   * - Uses `GovernanceMemoryEvent` (import `GovernanceMemoryEvent`) from `./types`.
   *
   * @param input - Structured input object for this operation.
   * @returns Promise resolving to GovernanceMemoryEvent.
   */
  async appendEvent(input: AppendGovernanceMemoryEventInput): Promise<GovernanceMemoryEvent> {
    let event: GovernanceMemoryEvent;
    if (this.backend === "sqlite") {
      event = await this.appendEventSqlite(input);
      await this.notifyProjectionChange(event);
      return event;
    }

    event = await withFileLock(this.filePath, async () => {
      await this.ensureLoaded(true);
      const normalized = normalizeEvent({
        ...input,
        id: input.id ?? makeId("govmem"),
        recordedAt: input.recordedAt ?? new Date().toISOString()
      });

      if (!normalized) {
        throw new Error("Governance memory event payload is invalid.");
      }

      this.state.events.push(normalized);
      this.state.lastAppendedAt = normalized.recordedAt;
      await this.persist();
      return normalized;
    });
    await this.notifyProjectionChange(event);
    return event;
  }

  /**
   * Reads read view needed for this execution step.
   *
   * **Why it exists:**
   * Separates read view read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `GovernanceMemoryReadView` (import `GovernanceMemoryReadView`) from `./types`.
   *
   * @param recentLimit - Numeric bound, counter, or index used by this logic.
   * @returns Promise resolving to GovernanceMemoryReadView.
   */
  async getReadView(recentLimit = DEFAULT_RECENT_LIMIT): Promise<GovernanceMemoryReadView> {
    if (this.backend === "sqlite") {
      return this.getReadViewSqlite(recentLimit);
    }

    await this.ensureLoaded(true);
    return this.buildReadViewFromEvents(this.state.events, recentLimit);
  }

  /**
   * Reads event count needed for this execution step.
   *
   * **Why it exists:**
   * Separates event count read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   * @returns Promise resolving to number.
   */
  async getEventCount(): Promise<number> {
    if (this.backend === "sqlite") {
      await this.ensureSqliteReady();
      return withSqliteDatabase(this.sqlitePath, async (db) => {
        this.ensureSqliteSchema(db);
        const row = db
          .prepare(
            `SELECT COUNT(*) AS total
             FROM ${SQLITE_GOVERNANCE_EVENTS_TABLE}`
          )
          .get() as { total?: number } | undefined;
        return Number(row?.total ?? 0);
      });
    }

    await this.ensureLoaded(true);
    return this.state.events.length;
  }

  /**
   * Applies deterministic validity checks for loaded.
   *
   * **Why it exists:**
   * Fails fast when loaded is invalid so later control flow stays safe and predictable.
   *
   * **What it talks to:**
   * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
   *
   * @param forceReload - Value for force reload.
   * @returns Promise resolving to void.
   */
  private async ensureLoaded(forceReload = false): Promise<void> {
    if (this.backend === "sqlite") {
      return;
    }

    if (this.loaded && !forceReload) {
      return;
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(stripUtf8Bom(raw)) as Partial<GovernanceMemoryState>;
      this.state = normalizeState(parsed);
    } catch {
      this.state = createInitialState();
    }

    this.loaded = true;
  }

  /**
   * Persists input with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes input mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `./fileLock`.
   * @returns Promise resolving to void.
   */
  private async persist(): Promise<void> {
    await writeFileAtomic(this.filePath, JSON.stringify(this.state, null, 2));
  }

  /**
   * Emits one normalized projection change after a governance event write.
   *
   * **Why it exists:**
   * Governance writes are one canonical mirror seam, and this helper keeps projection publishing
   * optional and centralized instead of scattering callback branches across JSON and SQLite paths.
   *
   * **What it talks to:**
   * - Uses `buildProjectionChangeSet(...)` from `./projections/service`.
   *
   * @param event - Newly appended governance memory event.
   * @returns Promise resolving after the optional projection callback completes.
   */
  private async notifyProjectionChange(event: GovernanceMemoryEvent): Promise<void> {
    if (!this.onChange) {
      return;
    }
    await this.onChange(buildProjectionChangeSet(
      ["governance_changed"],
      [`governance_event:${event.id}`],
      {
        eventId: event.id,
        actionType: event.actionType
      }
    ));
  }

  /**
   * Builds read view from events for this module's runtime flow.
   *
   * **Why it exists:**
   * Keeps construction of read view from events consistent across call sites.
   *
   * **What it talks to:**
   * - Uses `GovernanceMemoryEvent` (import `GovernanceMemoryEvent`) from `./types`.
   * - Uses `GovernanceMemoryReadView` (import `GovernanceMemoryReadView`) from `./types`.
   * - Uses `GovernorId` (import `GovernorId`) from `./types`.
   * - Uses `isGovernorId` (import `isGovernorId`) from `./types`.
   *
   * @param events - Value for events.
   * @param recentLimit - Numeric bound, counter, or index used by this logic.
   * @returns Computed `GovernanceMemoryReadView` result.
   */
  private buildReadViewFromEvents(
    events: readonly GovernanceMemoryEvent[],
    recentLimit: number
  ): GovernanceMemoryReadView {
    const normalizedLimit = Number.isFinite(recentLimit) && recentLimit > 0
      ? Math.floor(recentLimit)
      : DEFAULT_RECENT_LIMIT;
    const recentEvents = [...events].slice(-normalizedLimit);
    const recentBlockCounts: GovernanceMemoryReadView["recentBlockCounts"] = {
      constraints: 0,
      governance: 0,
      runtime: 0
    };
    const recentGovernorRejectCounts: Partial<Record<GovernorId, number>> = {};

    for (const event of recentEvents) {
      if (event.blockCategory === "constraints") {
        recentBlockCounts.constraints += 1;
      } else if (event.blockCategory === "governance") {
        recentBlockCounts.governance += 1;
      } else if (event.blockCategory === "runtime") {
        recentBlockCounts.runtime += 1;
      }

      for (const blocked of event.blockedBy) {
        if (isGovernorId(blocked)) {
          recentGovernorRejectCounts[blocked] = (recentGovernorRejectCounts[blocked] ?? 0) + 1;
        }
      }
    }

    return freezeReadView({
      generatedAt: new Date().toISOString(),
      totalEvents: events.length,
      recentEvents,
      recentBlockCounts,
      recentGovernorRejectCounts
    });
  }

  /**
   * Persists event sqlite with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes event sqlite mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `makeId` (import `makeId`) from `./ids`.
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   * - Uses `GovernanceMemoryEvent` (import `GovernanceMemoryEvent`) from `./types`.
   *
   * @param input - Structured input object for this operation.
   * @returns Promise resolving to GovernanceMemoryEvent.
   */
  private async appendEventSqlite(
    input: AppendGovernanceMemoryEventInput
  ): Promise<GovernanceMemoryEvent> {
    await this.ensureSqliteReady();
    const normalized = normalizeEvent({
      ...input,
      id: input.id ?? makeId("govmem"),
      recordedAt: input.recordedAt ?? new Date().toISOString()
    });

    if (!normalized) {
      throw new Error("Governance memory event payload is invalid.");
    }

    await withSqliteDatabase(this.sqlitePath, async (db) => {
      this.ensureSqliteSchema(db);
      db.exec("BEGIN IMMEDIATE;");
      try {
        const createdAt = this.readSqliteMetadataValue(db, "createdAt") ?? normalized.recordedAt;
        this.writeSqliteMetadataValue(db, "createdAt", createdAt);
        this.insertSqliteEvent(db, normalized);
        this.writeSqliteMetadataValue(db, "lastAppendedAt", normalized.recordedAt);
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
    });

    if (this.exportJsonOnWrite) {
      await this.persistSqliteSnapshotToJson();
    }

    return normalized;
  }

  /**
   * Reads read view sqlite needed for this execution step.
   *
   * **Why it exists:**
   * Separates read view sqlite read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   * - Uses `GovernanceMemoryReadView` (import `GovernanceMemoryReadView`) from `./types`.
   *
   * @param recentLimit - Numeric bound, counter, or index used by this logic.
   * @returns Promise resolving to GovernanceMemoryReadView.
   */
  private async getReadViewSqlite(recentLimit: number): Promise<GovernanceMemoryReadView> {
    await this.ensureSqliteReady();
    return withSqliteDatabase(this.sqlitePath, async (db) => {
      this.ensureSqliteSchema(db);
      const normalizedLimit = Number.isFinite(recentLimit) && recentLimit > 0
        ? Math.floor(recentLimit)
        : DEFAULT_RECENT_LIMIT;
      const rows = db
        .prepare(
          `SELECT id, recorded_at, task_id, proposal_id, action_id, action_type, mode, outcome,
                  block_category, blocked_by_json, violation_codes_json, yes_votes, no_votes,
                  threshold, dissent_governor_ids_json
           FROM ${SQLITE_GOVERNANCE_EVENTS_TABLE}
           ORDER BY event_seq DESC
           LIMIT ?`
        )
        .all(normalizedLimit);
      const validatedRows = parseSqliteGovernanceEventRows(rows);
      const recentEvents = validatedRows.map((row) => this.deserializeSqliteEventRow(row)).reverse();

      const totals = db
        .prepare(
          `SELECT COUNT(*) AS totalEvents
           FROM ${SQLITE_GOVERNANCE_EVENTS_TABLE}`
        )
        .get() as { totalEvents?: number } | undefined;
      const view = this.buildReadViewFromEvents(recentEvents, normalizedLimit);
      return freezeReadView({
        ...view,
        totalEvents: Number(totals?.totalEvents ?? 0)
      });
    });
  }

  /**
   * Applies deterministic validity checks for sqlite ready.
   *
   * **Why it exists:**
   * Fails fast when sqlite ready is invalid so later control flow stays safe and predictable.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   * @returns Promise resolving to void.
   */
  private async ensureSqliteReady(): Promise<void> {
    if (this.sqliteReady) {
      return;
    }

    await withSqliteDatabase(this.sqlitePath, async (db) => {
      this.ensureSqliteSchema(db);
    });

    await this.importJsonSnapshotIntoSqliteIfEmpty();
    this.sqliteReady = true;
  }

  /**
   * Applies deterministic validity checks for sqlite schema.
   *
   * **Why it exists:**
   * Fails fast when sqlite schema is invalid so later control flow stays safe and predictable.
   *
   * **What it talks to:**
   * - Uses `DatabaseSync` (import `DatabaseSync`) from `node:sqlite`.
   *
   * @param db - Value for db.
   */
  private ensureSqliteSchema(db: DatabaseSync): void {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${SQLITE_GOVERNANCE_EVENTS_TABLE} (
         event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
         id TEXT NOT NULL UNIQUE,
         recorded_at TEXT NOT NULL,
         task_id TEXT NOT NULL,
         proposal_id TEXT,
         action_id TEXT NOT NULL,
         action_type TEXT NOT NULL,
         mode TEXT NOT NULL,
         outcome TEXT NOT NULL,
         block_category TEXT NOT NULL,
         blocked_by_json TEXT NOT NULL,
         violation_codes_json TEXT NOT NULL,
         yes_votes INTEGER NOT NULL,
         no_votes INTEGER NOT NULL,
         threshold INTEGER,
         dissent_governor_ids_json TEXT NOT NULL
       );`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${SQLITE_GOVERNANCE_EVENTS_TABLE}_recorded_at
       ON ${SQLITE_GOVERNANCE_EVENTS_TABLE}(recorded_at);`
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${SQLITE_GOVERNANCE_METADATA_TABLE} (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL
       );`
    );
  }

  /**
   * Reads sqlite metadata value needed for this execution step.
   *
   * **Why it exists:**
   * Separates sqlite metadata value read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `DatabaseSync` (import `DatabaseSync`) from `node:sqlite`.
   *
   * @param db - Value for db.
   * @param key - Lookup key or map field identifier.
   * @returns Computed `string | null` result.
   */
  private readSqliteMetadataValue(db: DatabaseSync, key: string): string | null {
    const row = db
      .prepare(
        `SELECT value
         FROM ${SQLITE_GOVERNANCE_METADATA_TABLE}
         WHERE key = ?`
      )
      .get(key) as { value?: string } | undefined;
    return typeof row?.value === "string" ? row.value : null;
  }

  /**
   * Persists sqlite metadata value with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes sqlite metadata value mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `DatabaseSync` (import `DatabaseSync`) from `node:sqlite`.
   *
   * @param db - Value for db.
   * @param key - Lookup key or map field identifier.
   * @param value - Primary value processed by this function.
   */
  private writeSqliteMetadataValue(db: DatabaseSync, key: string, value: string): void {
    db.prepare(
      `INSERT INTO ${SQLITE_GOVERNANCE_METADATA_TABLE}(key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }

  /**
   * Implements insert sqlite event behavior used by `governanceMemory`.
   *
   * **Why it exists:**
   * Keeps `insert sqlite event` behavior centralized so collaborating call sites stay consistent.
   *
   * **What it talks to:**
   * - Uses `GovernanceMemoryEvent` (import `GovernanceMemoryEvent`) from `./types`.
   * - Uses `DatabaseSync` (import `DatabaseSync`) from `node:sqlite`.
   *
   * @param db - Value for db.
   * @param event - Value for event.
   */
  private insertSqliteEvent(db: DatabaseSync, event: GovernanceMemoryEvent): void {
    db.prepare(
      `INSERT OR IGNORE INTO ${SQLITE_GOVERNANCE_EVENTS_TABLE} (
         id, recorded_at, task_id, proposal_id, action_id, action_type, mode, outcome,
         block_category, blocked_by_json, violation_codes_json, yes_votes, no_votes,
         threshold, dissent_governor_ids_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.id,
      event.recordedAt,
      event.taskId,
      event.proposalId,
      event.actionId,
      event.actionType,
      event.mode,
      event.outcome,
      event.blockCategory,
      JSON.stringify(event.blockedBy),
      JSON.stringify(event.violationCodes),
      event.yesVotes,
      event.noVotes,
      event.threshold,
      JSON.stringify(event.dissentGovernorIds)
    );
  }

  /**
   * Transforms sqlite event row into a stable output representation.
   *
   * **Why it exists:**
   * Keeps `deserialize sqlite event row` behavior centralized so collaborating call sites stay consistent.
   *
   * **What it talks to:**
   * - Uses `ActionBlockReason` (import `ActionBlockReason`) from `./types`.
   * - Uses `ConstraintViolationCode` (import `ConstraintViolationCode`) from `./types`.
   * - Uses `GovernanceBlockCategory` (import `GovernanceBlockCategory`) from `./types`.
   * - Uses `GovernanceMemoryEvent` (import `GovernanceMemoryEvent`) from `./types`.
   * - Uses `GovernorId` (import `GovernorId`) from `./types`.
   * - Uses `isConstraintViolationCode` (import `isConstraintViolationCode`) from `./types`.
   * - Additional imported collaborators are also used in this function body.
   *
   * @param row - Value for row.
   * @returns Computed `GovernanceMemoryEvent` result.
   */
  private deserializeSqliteEventRow(row: SqliteGovernanceEventRow): GovernanceMemoryEvent {
    const parsed = normalizeEvent({
      id: row.id,
      recordedAt: row.recorded_at,
      taskId: row.task_id,
      proposalId: row.proposal_id,
      actionId: row.action_id,
      actionType: row.action_type as GovernanceMemoryEvent["actionType"],
      mode: row.mode as GovernanceMemoryEvent["mode"],
      outcome: row.outcome as GovernanceMemoryEvent["outcome"],
      blockCategory: row.block_category as GovernanceBlockCategory,
      blockedBy: parseJsonStringArray(row.blocked_by_json).filter(
        (value): value is ActionBlockReason =>
          isConstraintViolationCode(value) || isGovernorId(value)
      ),
      violationCodes: parseJsonStringArray(row.violation_codes_json).filter(
        (value): value is ConstraintViolationCode => isConstraintViolationCode(value)
      ),
      yesVotes: Number(row.yes_votes),
      noVotes: Number(row.no_votes),
      threshold: row.threshold === null ? null : Number(row.threshold),
      dissentGovernorIds: parseJsonStringArray(row.dissent_governor_ids_json).filter(
        (value): value is GovernorId => isGovernorId(value)
      )
    });

    if (!parsed) {
      throw new Error("Governance memory sqlite row could not be normalized.");
    }

    return parsed;
  }

  /**
   * Imports json snapshot into sqlite if empty into local state while preserving deterministic ordering.
   *
   * **Why it exists:**
   * Ensures json snapshot into sqlite if empty import follows one deterministic migration/bootstrap path.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
   * @returns Promise resolving to void.
   */
  private async importJsonSnapshotIntoSqliteIfEmpty(): Promise<void> {
    let jsonState: GovernanceMemoryState | null = null;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(stripUtf8Bom(raw)) as Partial<GovernanceMemoryState>;
      jsonState = normalizeState(parsed);
    } catch {
      jsonState = null;
    }

    if (!jsonState || jsonState.events.length === 0) {
      return;
    }

    await withSqliteDatabase(this.sqlitePath, async (db) => {
      this.ensureSqliteSchema(db);
      const existing = db
        .prepare(
          `SELECT COUNT(*) AS totalEvents
           FROM ${SQLITE_GOVERNANCE_EVENTS_TABLE}`
        )
        .get() as { totalEvents?: number } | undefined;
      if (Number(existing?.totalEvents ?? 0) > 0) {
        return;
      }

      db.exec("BEGIN IMMEDIATE;");
      try {
        this.writeSqliteMetadataValue(db, "createdAt", jsonState!.createdAt);
        if (jsonState!.lastAppendedAt) {
          this.writeSqliteMetadataValue(db, "lastAppendedAt", jsonState!.lastAppendedAt);
        }
        for (const event of jsonState!.events) {
          this.insertSqliteEvent(db, event);
        }
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
    });
  }

  /**
   * Reads state from sqlite needed for this execution step.
   *
   * **Why it exists:**
   * Separates state from sqlite read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `DatabaseSync` (import `DatabaseSync`) from `node:sqlite`.
   *
   * @param db - Value for db.
   * @returns Computed `GovernanceMemoryState` result.
   */
  private readStateFromSqlite(db: DatabaseSync): GovernanceMemoryState {
    this.ensureSqliteSchema(db);
    const createdAt = this.readSqliteMetadataValue(db, "createdAt") ?? new Date().toISOString();
    const lastAppendedAt = this.readSqliteMetadataValue(db, "lastAppendedAt") ?? undefined;
    const rows = db
      .prepare(
        `SELECT id, recorded_at, task_id, proposal_id, action_id, action_type, mode, outcome,
                block_category, blocked_by_json, violation_codes_json, yes_votes, no_votes,
                threshold, dissent_governor_ids_json
         FROM ${SQLITE_GOVERNANCE_EVENTS_TABLE}
         ORDER BY event_seq ASC`
      )
      .all();
    const validatedRows = parseSqliteGovernanceEventRows(rows);
    const events = validatedRows.map((row) => this.deserializeSqliteEventRow(row));
    return {
      createdAt,
      lastAppendedAt,
      events
    };
  }

  /**
   * Persists sqlite snapshot to json with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes sqlite snapshot to json mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `withFileLock` (import `withFileLock`) from `./fileLock`.
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `./fileLock`.
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   * @returns Promise resolving to void.
   */
  private async persistSqliteSnapshotToJson(): Promise<void> {
    const snapshot = await withSqliteDatabase(this.sqlitePath, async (db) =>
      this.readStateFromSqlite(db)
    );

    await withFileLock(this.filePath, async () => {
      await writeFileAtomic(this.filePath, JSON.stringify(snapshot, null, 2));
    });
  }
}

interface SqliteGovernanceEventRow {
  id: string;
  recorded_at: string;
  task_id: string;
  proposal_id: string | null;
  action_id: string;
  action_type: string;
  mode: string;
  outcome: string;
  block_category: string;
  blocked_by_json: string;
  violation_codes_json: string;
  yes_votes: number;
  no_votes: number;
  threshold: number | null;
  dissent_governor_ids_json: string;
}

/**
 * Evaluates sqlite governance event row and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the sqlite governance event row policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is SqliteGovernanceEventRow` result.
 */
function isSqliteGovernanceEventRow(value: unknown): value is SqliteGovernanceEventRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<SqliteGovernanceEventRow>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.recorded_at === "string" &&
    typeof candidate.task_id === "string" &&
    (candidate.proposal_id === null || typeof candidate.proposal_id === "string") &&
    typeof candidate.action_id === "string" &&
    typeof candidate.action_type === "string" &&
    typeof candidate.mode === "string" &&
    typeof candidate.outcome === "string" &&
    typeof candidate.block_category === "string" &&
    typeof candidate.blocked_by_json === "string" &&
    typeof candidate.violation_codes_json === "string" &&
    typeof candidate.yes_votes === "number" &&
    Number.isFinite(candidate.yes_votes) &&
    typeof candidate.no_votes === "number" &&
    Number.isFinite(candidate.no_votes) &&
    (candidate.threshold === null ||
      (typeof candidate.threshold === "number" && Number.isFinite(candidate.threshold))) &&
    typeof candidate.dissent_governor_ids_json === "string"
  );
}

/**
 * Parses sqlite governance event rows and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for sqlite governance event rows so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param rows - Value for rows.
 * @returns Ordered collection produced by this step.
 */
function parseSqliteGovernanceEventRows(rows: unknown): SqliteGovernanceEventRow[] {
  if (!Array.isArray(rows)) {
    throw new Error("Governance sqlite query returned non-array rowset.");
  }

  const normalizedRows: SqliteGovernanceEventRow[] = [];
  for (const row of rows) {
    if (!isSqliteGovernanceEventRow(row)) {
      throw new Error("Governance sqlite row failed shape validation.");
    }
    normalizedRows.push(row);
  }

  return normalizedRows;
}

/**
 * Parses json string array and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for json string array so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param raw - Value for raw.
 * @returns Ordered collection produced by this step.
 */
function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}
