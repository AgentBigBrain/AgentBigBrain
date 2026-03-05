/**
 * @fileoverview Persists Stage 6.86 runtime continuity state (conversation stack, pulse state, bridge queue, and mutation receipt linkage) with JSON/SQLite parity.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { LedgerBackend } from "./config";
import { withFileLock, writeFileAtomic } from "./fileLock";
import { withSqliteDatabase } from "./sqliteStore";
import { Stage686PulseStateV1 } from "./stage6_86MemoryGovernance";
import { createEmptyConversationStackV1, isConversationStackV1 } from "./stage6_86ConversationStack";
import { BridgeQuestionV1, ConversationStackV1 } from "./types";

const SQLITE_STAGE686_RUNTIME_STATE_TABLE = "stage6_86_runtime_state";
const MAX_PENDING_BRIDGE_QUESTIONS = 64;
const MAX_BRIDGE_HISTORY = 200;

interface Stage686RuntimeStateStoreOptions {
  backend?: LedgerBackend;
  sqlitePath?: string;
  exportJsonOnWrite?: boolean;
}

interface Stage686RuntimeStateDocumentV1 {
  schemaVersion: "v1";
  updatedAt: string;
  conversationStack: ConversationStackV1;
  pulseState: Stage686PulseStateV1;
  pendingBridgeQuestions: readonly BridgeQuestionV1[];
  lastMemoryMutationReceiptHash: string | null;
}

export interface Stage686RuntimeStateSnapshot {
  updatedAt: string;
  conversationStack: ConversationStackV1;
  pulseState: Stage686PulseStateV1;
  pendingBridgeQuestions: readonly BridgeQuestionV1[];
  lastMemoryMutationReceiptHash: string | null;
}

/**
 * Builds default Stage 6.86 pulse-state snapshot for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps pulse-state defaults deterministic across bootstrap and malformed-document recovery.
 *
 * **What it talks to:**
 * - Uses `Stage686PulseStateV1` contract.
 *
 * @param observedAt - Timestamp used for deterministic bootstrap metadata.
 * @returns Default pulse-state object.
 */
function createDefaultPulseState(observedAt: string): Stage686PulseStateV1 {
  return {
    schemaVersion: "v1",
    updatedAt: observedAt,
    lastPulseAt: null,
    emittedTodayCount: 0,
    bridgeHistory: []
  };
}

/**
 * Builds default Stage 6.86 runtime-state document for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps bootstrap behavior deterministic when state does not exist yet.
 *
 * **What it talks to:**
 * - Uses `createEmptyConversationStackV1(...)` for stack bootstrap.
 *
 * @param observedAt - Timestamp used for deterministic bootstrap metadata.
 * @returns Default runtime-state document.
 */
function createDefaultDocument(observedAt: string): Stage686RuntimeStateDocumentV1 {
  return {
    schemaVersion: "v1",
    updatedAt: observedAt,
    conversationStack: createEmptyConversationStackV1(observedAt),
    pulseState: createDefaultPulseState(observedAt),
    pendingBridgeQuestions: [],
    lastMemoryMutationReceiptHash: null
  };
}

/**
 * Evaluates iso timestamp string and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps timestamp validation centralized for JSON/SQLite normalization paths.
 *
 * **What it talks to:**
 * - Uses `Date.parse` for deterministic timestamp checks.
 *
 * @param value - Timestamp candidate.
 * @returns `true` when timestamp is valid ISO parseable text.
 */
function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * Normalizes bridge-question list into a stable shape for `stage6_86RuntimeStateStore` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for pending bridge questions so malformed persisted records
 * fail closed and runtime behavior remains deterministic.
 *
 * **What it talks to:**
 * - Uses `BridgeQuestionV1` contract.
 *
 * @param value - Untrusted pending-question payload.
 * @returns Normalized pending bridge questions.
 */
function normalizePendingBridgeQuestions(value: unknown): readonly BridgeQuestionV1[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: BridgeQuestionV1[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const candidate = raw as Partial<BridgeQuestionV1>;
    if (
      typeof candidate.questionId !== "string" ||
      typeof candidate.sourceEntityKey !== "string" ||
      typeof candidate.targetEntityKey !== "string" ||
      typeof candidate.prompt !== "string" ||
      !isIsoTimestamp(candidate.createdAt) ||
      !isIsoTimestamp(candidate.cooldownUntil)
    ) {
      continue;
    }
    const evidenceRefs = Array.isArray(candidate.evidenceRefs)
      ? candidate.evidenceRefs
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
    normalized.push({
      questionId: candidate.questionId,
      sourceEntityKey: candidate.sourceEntityKey,
      targetEntityKey: candidate.targetEntityKey,
      prompt: candidate.prompt,
      createdAt: candidate.createdAt,
      cooldownUntil: candidate.cooldownUntil,
      threadKey:
        candidate.threadKey === null || typeof candidate.threadKey === "string"
          ? candidate.threadKey
          : null,
      evidenceRefs: [...new Set(evidenceRefs)].sort((left, right) => left.localeCompare(right))
    });
  }

  return normalized
    .sort((left, right) => left.questionId.localeCompare(right.questionId))
    .slice(-MAX_PENDING_BRIDGE_QUESTIONS);
}

/**
 * Normalizes pulse-state payload into a stable shape for `stage6_86RuntimeStateStore` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for pulse-state persistence and malformed-document recovery.
 *
 * **What it talks to:**
 * - Uses `Stage686PulseStateV1` contract.
 *
 * @param value - Untrusted pulse-state payload.
 * @param fallbackIso - Fallback timestamp when persisted value is invalid.
 * @returns Normalized pulse-state object.
 */
function normalizePulseState(value: unknown, fallbackIso: string): Stage686PulseStateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createDefaultPulseState(fallbackIso);
  }
  const candidate = value as Partial<Stage686PulseStateV1>;
  const updatedAt = isIsoTimestamp(candidate.updatedAt) ? candidate.updatedAt : fallbackIso;
  const lastPulseAt =
    candidate.lastPulseAt === null || isIsoTimestamp(candidate.lastPulseAt)
      ? (candidate.lastPulseAt ?? null)
      : null;
  const emittedTodayCount =
    typeof candidate.emittedTodayCount === "number" && Number.isFinite(candidate.emittedTodayCount)
      ? Math.max(0, Math.floor(candidate.emittedTodayCount))
      : 0;

  const bridgeHistory = Array.isArray(candidate.bridgeHistory)
    ? candidate.bridgeHistory
        .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
        .map((entry) => {
          const record = entry as Stage686PulseStateV1["bridgeHistory"][number];
          if (
            typeof record.questionId !== "string" ||
            typeof record.sourceEntityKey !== "string" ||
            typeof record.targetEntityKey !== "string" ||
            !isIsoTimestamp(record.askedAt) ||
            !isIsoTimestamp(record.cooldownUntil) ||
            typeof record.deferralCount !== "number" ||
            typeof record.conversationKey !== "string"
          ) {
            return null;
          }
          const status =
            record.status === "asked" || record.status === "confirmed" || record.status === "deferred"
              ? record.status
              : "asked";
          return {
            questionId: record.questionId,
            sourceEntityKey: record.sourceEntityKey,
            targetEntityKey: record.targetEntityKey,
            askedAt: record.askedAt,
            status,
            cooldownUntil: record.cooldownUntil,
            deferralCount: Math.max(0, Math.floor(record.deferralCount)),
            conversationKey: record.conversationKey
          };
        })
        .filter(
          (
            entry
          ): entry is Stage686PulseStateV1["bridgeHistory"][number] => entry !== null
        )
        .sort((left, right) => left.askedAt.localeCompare(right.askedAt))
        .slice(-MAX_BRIDGE_HISTORY)
    : [];

  return {
    schemaVersion: "v1",
    updatedAt,
    lastPulseAt,
    emittedTodayCount,
    bridgeHistory
  };
}

/**
 * Normalizes runtime-state document into a stable shape for `stage6_86RuntimeStateStore` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for malformed JSON/SQLite document recovery.
 *
 * **What it talks to:**
 * - Uses `isConversationStackV1(...)` for conversation-stack validation.
 * - Uses local pulse/bridge normalization helpers.
 *
 * @param value - Untrusted runtime-state payload.
 * @returns Normalized runtime-state document.
 */
function normalizeDocument(value: unknown): Stage686RuntimeStateDocumentV1 {
  const fallbackIso = new Date().toISOString();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createDefaultDocument(fallbackIso);
  }
  const candidate = value as Partial<Stage686RuntimeStateDocumentV1>;
  const updatedAt = isIsoTimestamp(candidate.updatedAt) ? candidate.updatedAt : fallbackIso;
  const conversationStack = isConversationStackV1(candidate.conversationStack)
    ? candidate.conversationStack
    : createEmptyConversationStackV1(updatedAt);
  const pulseState = normalizePulseState(candidate.pulseState, updatedAt);

  return {
    schemaVersion: "v1",
    updatedAt,
    conversationStack,
    pulseState,
    pendingBridgeQuestions: normalizePendingBridgeQuestions(candidate.pendingBridgeQuestions),
    lastMemoryMutationReceiptHash:
      candidate.lastMemoryMutationReceiptHash === null ||
      typeof candidate.lastMemoryMutationReceiptHash === "string"
        ? (candidate.lastMemoryMutationReceiptHash ?? null)
        : null
  };
}

/**
 * Converts normalized runtime-state document into snapshot form for runtime consumers.
 *
 * **Why it exists:**
 * Keeps consumer-facing state shape stable and independent from persistence-envelope details.
 *
 * **What it talks to:**
 * - Uses `Stage686RuntimeStateSnapshot` contract.
 *
 * @param document - Normalized document.
 * @returns Snapshot consumed by runtime action engine.
 */
function toSnapshot(document: Stage686RuntimeStateDocumentV1): Stage686RuntimeStateSnapshot {
  return {
    updatedAt: document.updatedAt,
    conversationStack: document.conversationStack,
    pulseState: document.pulseState,
    pendingBridgeQuestions: document.pendingBridgeQuestions,
    lastMemoryMutationReceiptHash: document.lastMemoryMutationReceiptHash
  };
}

/**
 * Builds persisted runtime-state document from runtime snapshot input.
 *
 * **Why it exists:**
 * Keeps write-path serialization deterministic and centralized.
 *
 * **What it talks to:**
 * - Uses local normalization helpers for fail-closed writes.
 *
 * @param snapshot - Runtime snapshot being persisted.
 * @returns Normalized persisted document.
 */
function fromSnapshot(snapshot: Stage686RuntimeStateSnapshot): Stage686RuntimeStateDocumentV1 {
  return normalizeDocument({
    schemaVersion: "v1",
    updatedAt: snapshot.updatedAt,
    conversationStack: snapshot.conversationStack,
    pulseState: snapshot.pulseState,
    pendingBridgeQuestions: snapshot.pendingBridgeQuestions,
    lastMemoryMutationReceiptHash: snapshot.lastMemoryMutationReceiptHash
  });
}

/**
 * Implements deterministic persistence for Stage 6.86 runtime state.
 */
export class Stage686RuntimeStateStore {
  private sqliteReady = false;
  private readonly backend: LedgerBackend;
  private readonly sqlitePath: string;
  private readonly exportJsonOnWrite: boolean;

  /**
   * Initializes `Stage686RuntimeStateStore` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures persistence backend/runtime paths once so callers cannot diverge on storage contracts.
   *
   * **What it talks to:**
   * - Uses `path.resolve(...)` for deterministic default path resolution.
   *
   * @param filePath - JSON fallback path for runtime state.
   * @param options - Backend configuration options (json/sqlite parity).
   */
  constructor(
    private readonly filePath: string = path.resolve(process.cwd(), "runtime/stage6_86_runtime_state.json"),
    options: Stage686RuntimeStateStoreOptions = {}
  ) {
    this.backend = options.backend ?? "json";
    this.sqlitePath = options.sqlitePath ?? path.resolve(process.cwd(), "runtime/ledgers.sqlite");
    this.exportJsonOnWrite = options.exportJsonOnWrite ?? true;
  }

  /**
   * Reads Stage 6.86 runtime state from durable storage.
   *
   * **Why it exists:**
   * Provides one canonical load path for action-runtime continuity state.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase(...)` when sqlite backend is enabled.
   * - Uses `readFile(...)` for JSON backend fallback.
   *
   * @returns Normalized runtime state snapshot.
   */
  async load(): Promise<Stage686RuntimeStateSnapshot> {
    if (this.backend === "sqlite") {
      await this.ensureSqliteReady();
      return withSqliteDatabase(this.sqlitePath, async (db) => {
        this.ensureSqliteSchema(db);
        const row = db
          .prepare(
            `SELECT state_json
             FROM ${SQLITE_STAGE686_RUNTIME_STATE_TABLE}
             WHERE id = 1`
          )
          .get() as { state_json?: string } | undefined;
        if (!row?.state_json) {
          return toSnapshot(createDefaultDocument(new Date().toISOString()));
        }
        try {
          return toSnapshot(normalizeDocument(JSON.parse(row.state_json)));
        } catch {
          return toSnapshot(createDefaultDocument(new Date().toISOString()));
        }
      });
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      return toSnapshot(normalizeDocument(JSON.parse(stripUtf8Bom(raw))));
    } catch {
      return toSnapshot(createDefaultDocument(new Date().toISOString()));
    }
  }

  /**
   * Persists Stage 6.86 runtime state to durable storage.
   *
   * **Why it exists:**
   * Centralizes JSON/SQLite write behavior so runtime action semantics remain backend-agnostic.
   *
   * **What it talks to:**
   * - Uses `withFileLock(...)` + `writeFileAtomic(...)` for JSON writes.
   * - Uses `withSqliteDatabase(...)` for sqlite writes.
   *
   * @param snapshot - Runtime snapshot to persist.
   * @returns Promise resolving when state is durable.
   */
  async save(snapshot: Stage686RuntimeStateSnapshot): Promise<void> {
    const normalized = fromSnapshot(snapshot);
    if (this.backend === "sqlite") {
      await this.ensureSqliteReady();
      await withSqliteDatabase(this.sqlitePath, async (db) => {
        this.ensureSqliteSchema(db);
        db.prepare(
          `INSERT INTO ${SQLITE_STAGE686_RUNTIME_STATE_TABLE}(id, schema_version, updated_at, state_json)
           VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             schema_version = excluded.schema_version,
             updated_at = excluded.updated_at,
             state_json = excluded.state_json`
        ).run("v1", normalized.updatedAt, JSON.stringify(normalized));
      });
      if (this.exportJsonOnWrite) {
        await withFileLock(this.filePath, async () => {
          await writeFileAtomic(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`);
        });
      }
      return;
    }

    await withFileLock(this.filePath, async () => {
      await writeFileAtomic(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`);
    });
  }

  /**
   * Applies deterministic validity checks for sqlite backend readiness.
   *
   * **Why it exists:**
   * Ensures table bootstrap runs once and avoids repeated startup churn.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase(...)` for schema bootstrap.
   *
   * @returns Promise resolving when sqlite schema is ready.
   */
  private async ensureSqliteReady(): Promise<void> {
    if (this.sqliteReady) {
      return;
    }
    await withSqliteDatabase(this.sqlitePath, async (db) => {
      this.ensureSqliteSchema(db);
    });
    this.sqliteReady = true;
  }

  /**
   * Applies deterministic validity checks for sqlite schema.
   *
   * **Why it exists:**
   * Fails closed when expected table shape does not exist.
   *
   * **What it talks to:**
   * - Uses `DatabaseSync` schema DDL execution.
   *
   * @param db - SQLite database handle.
   */
  private ensureSqliteSchema(db: DatabaseSync): void {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${SQLITE_STAGE686_RUNTIME_STATE_TABLE} (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         schema_version TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         state_json TEXT NOT NULL
       );`
    );
  }
}

/**
 * Normalizes utf8 bom from persisted JSON text.
 *
 * **Why it exists:**
 * Keeps cross-editor json parsing deterministic for bootstrap reads.
 *
 * **What it talks to:**
 * - Uses local regex helper only.
 *
 * @param value - Raw persisted JSON text.
 * @returns BOM-stripped JSON text.
 */
function stripUtf8Bom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}
