/**
 * @fileoverview Persists deterministic workflow-learning patterns with JSON/SQLite parity and planner-hint retrieval.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { adaptWorkflowPatterns } from "./advancedAutonomyFoundation";
import { LedgerBackend } from "./config";
import { withFileLock, writeFileAtomic } from "./fileLock";
import { withSqliteDatabase } from "./sqliteStore";
import { TaskRunResult, WorkflowAdaptationResult, WorkflowObservation, WorkflowPattern } from "./types";
import { applyWorkflowObservationMetadata } from "./workflowLearningRuntime/patternLifecycle";
import { deriveWorkflowObservationFromTaskRunDetailed } from "./workflowLearningRuntime/observationExtraction";
import { rankRelevantWorkflowPatterns } from "./workflowLearningRuntime/relevanceRanking";

const SQLITE_WORKFLOW_PATTERNS_TABLE = "workflow_patterns";
const MAX_WORKFLOW_PATTERNS = 2_000;
const DEFAULT_RELEVANT_PATTERN_LIMIT = 3;

interface WorkflowLearningStoreOptions {
  backend?: LedgerBackend;
  sqlitePath?: string;
  exportJsonOnWrite?: boolean;
}

interface WorkflowLearningDocument {
  patterns: WorkflowPattern[];
}

interface SqliteWorkflowPatternRow {
  pattern_json: string;
}

/**
 * Constrains and sanitizes confidence to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for confidence before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed numeric value.
 */
function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

/**
 * Parses workflow pattern and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for workflow pattern so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `WorkflowPattern` (import `WorkflowPattern`) from `./types`.
 *
 * @param input - Primary value processed by this function.
 * @returns Computed `WorkflowPattern | null` result.
 */
function parseWorkflowPattern(input: unknown): WorkflowPattern | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Partial<WorkflowPattern>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.workflowKey !== "string" ||
    typeof candidate.firstSeenAt !== "string" ||
    typeof candidate.lastSeenAt !== "string" ||
    typeof candidate.domainLane !== "string" ||
    !Number.isFinite(candidate.successCount) ||
    !Number.isFinite(candidate.failureCount) ||
    !Number.isFinite(candidate.suppressedCount)
  ) {
    return null;
  }

  const status = candidate.status === "superseded" ? "superseded" : "active";
  const contextTags = Array.isArray(candidate.contextTags)
    ? candidate.contextTags.filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    id: candidate.id,
    workflowKey: candidate.workflowKey.trim(),
    status,
    confidence: clampConfidence(typeof candidate.confidence === "number" ? candidate.confidence : 0),
    firstSeenAt: candidate.firstSeenAt,
    lastSeenAt: candidate.lastSeenAt,
    supersededAt:
      typeof candidate.supersededAt === "string" && candidate.supersededAt.trim().length > 0
        ? candidate.supersededAt
        : null,
    domainLane: candidate.domainLane.trim() || "unknown",
    successCount: Number(candidate.successCount),
    failureCount: Number(candidate.failureCount),
    suppressedCount: Number(candidate.suppressedCount),
    contextTags,
    executionStyle: parseOptionalEnum(candidate.executionStyle, [
      "respond_only",
      "single_action",
      "multi_action",
      "live_run",
      "skill_based"
    ] as const),
    actionSequenceShape: parseOptionalString(candidate.actionSequenceShape) ?? undefined,
    approvalPosture: parseOptionalEnum(candidate.approvalPosture, [
      "none",
      "fast_path_only",
      "escalation_only",
      "mixed",
      "blocked_only"
    ] as const),
    verificationProofPresent: parseOptionalBoolean(candidate.verificationProofPresent),
    costBand: parseOptionalEnum(candidate.costBand, ["none", "low", "medium", "high"] as const),
    latencyBand: parseOptionalEnum(candidate.latencyBand, ["fast", "moderate", "slow"] as const),
    dominantFailureMode: parseOptionalString(candidate.dominantFailureMode),
    recoveryPath: parseOptionalString(candidate.recoveryPath),
    linkedSkillName: parseOptionalString(candidate.linkedSkillName),
    linkedSkillVerificationStatus: parseOptionalEnum(candidate.linkedSkillVerificationStatus, [
      "unverified",
      "verified",
      "failed"
    ] as const)
  };
}

/**
 * Parses workflow learning document and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for workflow learning document so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `WorkflowPattern` (import `WorkflowPattern`) from `./types`.
 *
 * @param input - Primary value processed by this function.
 * @returns Computed `WorkflowLearningDocument` result.
 */
function parseWorkflowLearningDocument(input: unknown): WorkflowLearningDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { patterns: [] };
  }
  const candidate = input as { patterns?: unknown };
  if (!Array.isArray(candidate.patterns)) {
    return { patterns: [] };
  }
  return {
    patterns: candidate.patterns
      .map((entry) => parseWorkflowPattern(entry))
      .filter((entry): entry is WorkflowPattern => entry !== null)
  };
}

/**
 * Parses optional string fields from persisted workflow documents.
 *
 * @param value - Raw persisted value.
 * @returns `undefined` for type mismatch, `null` for empty/null, or the trimmed string.
 */
function parseOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim().length > 0 ? value : null;
}

/**
 * Parses optional boolean fields from persisted workflow documents.
 *
 * @param value - Raw persisted value.
 * @returns Boolean when valid, otherwise `undefined`.
 */
function parseOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Parses optional enum fields from persisted workflow documents.
 *
 * @param value - Raw persisted value.
 * @param allowedValues - Canonical enum values accepted for the field.
 * @returns Matching enum value or `undefined`.
 */
function parseOptionalEnum<T extends string>(
  value: unknown,
  allowedValues: readonly T[]
): T | undefined {
  return typeof value === "string" && allowedValues.includes(value as T)
    ? (value as T)
    : undefined;
}

/**
 * Reapplies structured observation metadata to the workflow adaptation result returned by the
 * legacy adapter so richer fields survive the persistence round trip.
 *
 * @param adaptation - Legacy workflow adaptation result.
 * @param observation - New observation metadata to apply.
 * @returns Adaptation result with the updated pattern enriched.
 */
function applyObservationMetadataToAdaptation(
  adaptation: WorkflowAdaptationResult,
  observation: WorkflowObservation
): WorkflowAdaptationResult {
  const patterns = adaptation.patterns.map((pattern) =>
    pattern.id === adaptation.updatedPattern.id
      ? applyWorkflowObservationMetadata(pattern, observation)
      : pattern
  );
  const updatedPattern =
    patterns.find((pattern) => pattern.id === adaptation.updatedPattern.id) ??
    applyWorkflowObservationMetadata(adaptation.updatedPattern, observation);
  return {
    patterns,
    updatedPattern,
    supersededPatternIds: adaptation.supersededPatternIds
  };
}

/**
 * Sorts patterns by deterministic recency and confidence for retention capping.
 *
 * **Why it exists:**
 * Keeps deterministic retention ordering centralized for both JSON and SQLite write paths.
 *
 * **What it talks to:**
 * - Uses `WorkflowPattern` (import `WorkflowPattern`) from `./types`.
 *
 * @param left - Value for left.
 * @param right - Value for right.
 * @returns Computed numeric value.
 */
function sortPatternsForRetention(left: WorkflowPattern, right: WorkflowPattern): number {
  if (left.lastSeenAt !== right.lastSeenAt) {
    return right.lastSeenAt.localeCompare(left.lastSeenAt);
  }
  if (left.confidence !== right.confidence) {
    return right.confidence - left.confidence;
  }
  return left.id.localeCompare(right.id);
}

/**
 * Applies deterministic retention cap to workflow patterns.
 *
 * **Why it exists:**
 * Prevents unbounded growth while preserving the most recent/high-confidence patterns.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param patterns - Value for patterns.
 * @returns Ordered collection produced by this step.
 */
function capWorkflowPatterns(patterns: readonly WorkflowPattern[]): WorkflowPattern[] {
  return [...patterns]
    .sort(sortPatternsForRetention)
    .slice(0, MAX_WORKFLOW_PATTERNS);
}

/**
 * Validates sqlite workflow-pattern row and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the sqlite workflow-pattern row policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns `true` when this check passes.
 */
function isSqliteWorkflowPatternRow(value: unknown): value is SqliteWorkflowPatternRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<SqliteWorkflowPatternRow>;
  return typeof candidate.pattern_json === "string";
}

/**
 * Parses sqlite workflow-pattern rows and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for sqlite workflow-pattern rows so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param rows - Value for rows.
 * @returns Ordered collection produced by this step.
 */
function parseSqliteWorkflowPatternRows(rows: unknown): SqliteWorkflowPatternRow[] {
  if (!Array.isArray(rows)) {
    throw new Error("Workflow sqlite query returned non-array rowset.");
  }
  const normalizedRows: SqliteWorkflowPatternRow[] = [];
  for (const row of rows) {
    if (!isSqliteWorkflowPatternRow(row)) {
      throw new Error("Workflow sqlite row failed shape validation.");
    }
    normalizedRows.push(row);
  }
  return normalizedRows;
}

export class WorkflowLearningStore {
  private sqliteReady = false;
  private readonly backend: LedgerBackend;
  private readonly sqlitePath: string;
  private readonly exportJsonOnWrite: boolean;

  /**
   * Initializes `WorkflowLearningStore` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param filePath - Filesystem location used by this operation.
   * @param options - Optional tuning knobs for this operation.
   */
  constructor(
    private readonly filePath = path.resolve(process.cwd(), "runtime/workflow_learning.json"),
    options: WorkflowLearningStoreOptions = {}
  ) {
    this.backend = options.backend ?? "json";
    this.sqlitePath =
      options.sqlitePath ?? path.resolve(process.cwd(), "runtime/ledgers.sqlite");
    this.exportJsonOnWrite = options.exportJsonOnWrite ?? true;
  }

  /**
   * Reads workflow-learning document needed for this execution step.
   *
   * **Why it exists:**
   * Separates workflow-learning document read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   *
   * @returns Promise resolving to WorkflowLearningDocument.
   */
  async load(): Promise<WorkflowLearningDocument> {
    if (this.backend === "sqlite") {
      await this.ensureSqliteReady();
      return withSqliteDatabase(this.sqlitePath, async (db) => {
        this.ensureSqliteSchema(db);
        return this.readSqliteDocument(db);
      });
    }
    return this.readJsonDocumentFromFile();
  }

  /**
   * Persists workflow observation with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes workflow-learning mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `adaptWorkflowPatterns` (import `adaptWorkflowPatterns`) from `./advancedAutonomyFoundation`.
   * - Uses `withFileLock` (import `withFileLock`) from `./fileLock`.
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `./fileLock`.
   *
   * @param observation - Value for observation.
   * @returns Promise resolving to WorkflowAdaptationResult.
   */
  async recordObservation(observation: WorkflowObservation): Promise<WorkflowAdaptationResult> {
    if (this.backend === "sqlite") {
      return this.recordObservationSqlite(observation);
    }

    return withFileLock(this.filePath, async () => {
      const document = await this.readJsonDocumentFromFile();
      const adaptation = applyObservationMetadataToAdaptation(
        adaptWorkflowPatterns(document.patterns, observation),
        observation
      );
      const nextPatterns = capWorkflowPatterns(adaptation.patterns);
      const nextUpdatedPattern =
        nextPatterns.find((pattern) => pattern.id === adaptation.updatedPattern.id) ??
        adaptation.updatedPattern;
      const nextAdaptation: WorkflowAdaptationResult = {
        patterns: nextPatterns,
        updatedPattern: nextUpdatedPattern,
        supersededPatternIds: adaptation.supersededPatternIds
      };
      await writeFileAtomic(
        this.filePath,
        JSON.stringify({ patterns: nextPatterns }, null, 2)
      );
      return nextAdaptation;
    });
  }

  /**
   * Reads relevant workflow patterns needed for this execution step.
   *
   * **Why it exists:**
   * Separates relevant workflow patterns read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses local deterministic scoring helpers in this module.
   *
   * @param query - Value for query.
   * @param limit - Numeric bound, counter, or index used by this logic.
   * @returns Promise resolving to readonly WorkflowPattern[].
   */
  async getRelevantPatterns(
    query: string,
    limit = DEFAULT_RELEVANT_PATTERN_LIMIT,
    sessionDomainLane: string | null = null
  ): Promise<readonly WorkflowPattern[]> {
    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
    const document = await this.load();
    return rankRelevantWorkflowPatterns(document.patterns, query, normalizedLimit, sessionDomainLane);
  }

  /**
   * Reads json document from file needed for this execution step.
   *
   * **Why it exists:**
   * Separates json document from file read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
   *
   * @returns Promise resolving to WorkflowLearningDocument.
   */
  private async readJsonDocumentFromFile(): Promise<WorkflowLearningDocument> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return parseWorkflowLearningDocument(JSON.parse(raw));
    } catch {
      return { patterns: [] };
    }
  }

  /**
   * Persists observation sqlite with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes observation sqlite mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   *
   * @param observation - Value for observation.
   * @returns Promise resolving to WorkflowAdaptationResult.
   */
  private async recordObservationSqlite(
    observation: WorkflowObservation
  ): Promise<WorkflowAdaptationResult> {
    await this.ensureSqliteReady();
    const adaptation = await withSqliteDatabase(this.sqlitePath, async (db) => {
      this.ensureSqliteSchema(db);
      const current = this.readSqliteDocument(db);
      const next = applyObservationMetadataToAdaptation(
        adaptWorkflowPatterns(current.patterns, observation),
        observation
      );
      const nextPatterns = capWorkflowPatterns(next.patterns);
      const nextUpdatedPattern =
        nextPatterns.find((pattern) => pattern.id === next.updatedPattern.id) ??
        next.updatedPattern;

      db.exec("BEGIN IMMEDIATE;");
      try {
        db.prepare(`DELETE FROM ${SQLITE_WORKFLOW_PATTERNS_TABLE}`).run();
        const insertStatement = db.prepare(
          `INSERT INTO ${SQLITE_WORKFLOW_PATTERNS_TABLE} (
             id, workflow_key, status, confidence, last_seen_at, pattern_json
           ) VALUES (?, ?, ?, ?, ?, ?)`
        );
        for (const pattern of nextPatterns) {
          insertStatement.run(
            pattern.id,
            pattern.workflowKey,
            pattern.status,
            pattern.confidence,
            pattern.lastSeenAt,
            JSON.stringify(pattern)
          );
        }
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }

      return {
        patterns: nextPatterns,
        updatedPattern: nextUpdatedPattern,
        supersededPatternIds: next.supersededPatternIds
      } satisfies WorkflowAdaptationResult;
    });

    if (this.exportJsonOnWrite) {
      await this.persistSqliteSnapshotToJson();
    }

    return adaptation;
  }

  /**
   * Applies deterministic validity checks for sqlite ready.
   *
   * **Why it exists:**
   * Fails fast when sqlite ready is invalid so later control flow stays safe and predictable.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   *
   * @returns Promise resolving to void.
   */
  private async ensureSqliteReady(): Promise<void> {
    if (this.sqliteReady) {
      return;
    }
    await withSqliteDatabase(this.sqlitePath, async (db) => {
      this.ensureSqliteSchema(db);
      await this.importJsonSnapshotIntoSqliteIfEmpty(db);
    });
    this.sqliteReady = true;
  }

  /**
   * Applies deterministic validity checks for sqlite schema.
   *
   * **Why it exists:**
   * Fails fast when sqlite schema is invalid so later control flow stays safe and predictable.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param db - Value for db.
   */
  private ensureSqliteSchema(db: DatabaseSync): void {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${SQLITE_WORKFLOW_PATTERNS_TABLE} (
         pattern_seq INTEGER PRIMARY KEY AUTOINCREMENT,
         id TEXT NOT NULL UNIQUE,
         workflow_key TEXT NOT NULL,
         status TEXT NOT NULL,
         confidence REAL NOT NULL,
         last_seen_at TEXT NOT NULL,
         pattern_json TEXT NOT NULL
       );`
    );
  }

  /**
   * Reads sqlite document needed for this execution step.
   *
   * **Why it exists:**
   * Separates sqlite document read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param db - Value for db.
   * @returns Computed `WorkflowLearningDocument` result.
   */
  private readSqliteDocument(db: DatabaseSync): WorkflowLearningDocument {
    const rows = parseSqliteWorkflowPatternRows(
      db
        .prepare(
          `SELECT pattern_json
             FROM ${SQLITE_WORKFLOW_PATTERNS_TABLE}
             ORDER BY pattern_seq ASC`
        )
        .all()
    );

    const patterns = rows
      .map((row) => parseWorkflowPattern(JSON.parse(row.pattern_json)))
      .filter((entry): entry is WorkflowPattern => entry !== null);
    return {
      patterns
    };
  }

  /**
   * Imports json snapshot into sqlite when table is empty.
   *
   * **Why it exists:**
   * Supports deterministic JSON-to-SQLite backend migration without losing prior patterns.
   *
   * **What it talks to:**
   * - Uses current `DatabaseSync` connection opened by caller during sqlite bootstrap.
   *
   * @param db - Open sqlite database connection used for deterministic bootstrap.
   * @returns Promise resolving to void.
   */
  private async importJsonSnapshotIntoSqliteIfEmpty(db: DatabaseSync): Promise<void> {
    const jsonSnapshot = await this.readJsonDocumentFromFile();
    if (jsonSnapshot.patterns.length === 0) {
      return;
    }

    const row = db
      .prepare(
        `SELECT COUNT(*) AS totalPatterns
           FROM ${SQLITE_WORKFLOW_PATTERNS_TABLE}`
      )
      .get() as { totalPatterns?: number } | undefined;
    if (Number(row?.totalPatterns ?? 0) > 0) {
      return;
    }

    db.exec("BEGIN IMMEDIATE;");
    try {
      const insert = db.prepare(
        `INSERT INTO ${SQLITE_WORKFLOW_PATTERNS_TABLE} (
           id, workflow_key, status, confidence, last_seen_at, pattern_json
         ) VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const pattern of jsonSnapshot.patterns) {
        insert.run(
          pattern.id,
          pattern.workflowKey,
          pattern.status,
          pattern.confidence,
          pattern.lastSeenAt,
          JSON.stringify(pattern)
        );
      }
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }

  /**
   * Persists sqlite snapshot to json with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes sqlite snapshot to json mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   * - Uses `withFileLock` (import `withFileLock`) from `./fileLock`.
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `./fileLock`.
   *
   * @returns Promise resolving to void.
   */
  private async persistSqliteSnapshotToJson(): Promise<void> {
    const snapshot = await withSqliteDatabase(this.sqlitePath, async (db) => {
      this.ensureSqliteSchema(db);
      return this.readSqliteDocument(db);
    });
    await withFileLock(this.filePath, async () => {
      await writeFileAtomic(this.filePath, JSON.stringify(snapshot, null, 2));
    });
  }
}

/**
 * Derives workflow observation from a completed task run result.
 *
 * **Why it exists:**
 * Keeps Stage 6.13 observation extraction deterministic and in one place for runtime learning writes.
 *
 * **What it talks to:**
 * - Uses `extractActiveRequestSegment` (import `extractActiveRequestSegment`) from `./currentRequestExtraction`.
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `./types`.
 * - Uses `WorkflowObservation` (import `WorkflowObservation`) from `./types`.
 *
 * @param runResult - Completed task run used for observation extraction.
 * @returns Computed `WorkflowObservation` result.
 */
export function deriveWorkflowObservationFromTaskRun(
  runResult: TaskRunResult
): WorkflowObservation {
  return deriveWorkflowObservationFromTaskRunDetailed(runResult);
}
