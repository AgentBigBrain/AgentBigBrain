/**
 * @fileoverview Test-gated SQLite store skeleton for Source Recall records and chunks.
 */

import type { DatabaseSync } from "node:sqlite";

import { withSqliteDatabase } from "../sqliteStore";
import {
  createEmptySourceRecallDocument,
  isSourceRecallLifecycleVisible,
  markSourceRecallRecordForgottenInDocument,
  markSourceRecallRecordsByOriginParentRefInDocument,
  parseSourceRecallDocument,
  upsertSourceRecallRecordInDocument,
  type SourceRecallDocument
} from "./sourceRecallPersistence";
import type {
  SourceRecallChunk,
  SourceRecallLifecycleState,
  SourceRecallRecord
} from "./contracts";

const SOURCE_RECALL_STATE_TABLE = "source_recall_state";
const SOURCE_RECALL_STATE_ROW_ID = "source_recall_document";

export interface SourceRecallStoreOptions {
  sqlitePath: string;
  testOnlyAllowPlaintextStorage?: boolean;
}

export interface SourceRecallListOptions {
  scopeId?: string;
  threadId?: string;
  includeInactive?: boolean;
}

/**
 * Stores Source Recall records and chunks behind a test-only plaintext latch.
 */
export class SourceRecallStore {
  private readonly sqlitePath: string;
  private readonly testOnlyAllowPlaintextStorage: boolean;

  /**
   * Creates the S1 Source Recall store skeleton.
   *
   * **Why it exists:**
   * S1 needs the store seam and round-trip tests before production capture exists. The explicit
   * plaintext latch prevents this skeleton from becoming a production raw-text sink before S2
   * implements encryption and runtime enablement policy.
   *
   * **What it talks to:**
   * - Uses local constructor options within this module.
   *
   * @param options - SQLite path and test-only plaintext latch.
   */
  constructor(options: SourceRecallStoreOptions) {
    this.sqlitePath = options.sqlitePath;
    this.testOnlyAllowPlaintextStorage = options.testOnlyAllowPlaintextStorage === true;
    if (!this.testOnlyAllowPlaintextStorage) {
      throw new Error(
        "SourceRecallStore S1 skeleton is test-only until encryption and retention policy exist."
      );
    }
  }

  /**
   * Saves or replaces one source record and its chunks.
   *
   * **Why it exists:**
   * Tests and later capture slices need one deterministic upsert seam that preserves source/chunk
   * metadata without wiring production runtime capture yet.
   *
   * **What it talks to:**
   * - Uses `upsertSourceRecallRecordInDocument` from `./sourceRecallPersistence`.
   *
   * @param record - Source record to insert or replace.
   * @param chunks - Chunks belonging to the source record.
   * @returns Promise resolving when the store is updated.
   */
  async upsertSourceRecord(
    record: SourceRecallRecord,
    chunks: readonly SourceRecallChunk[]
  ): Promise<void> {
    await this.mutateDocument((document) =>
      upsertSourceRecallRecordInDocument(document, record, chunks)
    );
  }

  /**
   * Reads one visible source record by id.
   *
   * **Why it exists:**
   * Source-id retrieval and tests need a narrow read path that excludes forgotten records by
   * default.
   *
   * **What it talks to:**
   * - Uses `isSourceRecallLifecycleVisible` from `./sourceRecallPersistence`.
   *
   * @param sourceRecordId - Source record id to read.
   * @param includeInactive - Whether forgotten/quarantined/redacted records should be returned.
   * @returns Matching record, or `null` when absent or hidden.
   */
  async getSourceRecord(
    sourceRecordId: string,
    includeInactive = false
  ): Promise<SourceRecallRecord | null> {
    const document = await this.loadDocument();
    const record = document.records.find((entry) => entry.sourceRecordId === sourceRecordId);
    if (!record) {
      return null;
    }
    if (!includeInactive && !isSourceRecallLifecycleVisible(record.lifecycleState)) {
      return null;
    }
    return record;
  }

  /**
   * Lists source records matching optional scope and thread filters.
   *
   * **Why it exists:**
   * Scoped listing is the minimal retrieval primitive allowed in S1 before ranking or prompt
   * injection exists.
   *
   * **What it talks to:**
   * - Uses `isSourceRecallLifecycleVisible` from `./sourceRecallPersistence`.
   *
   * @param options - Optional scope/thread and inactive visibility controls.
   * @returns Matching records in deterministic order.
   */
  async listSourceRecords(options: SourceRecallListOptions = {}): Promise<SourceRecallRecord[]> {
    const document = await this.loadDocument();
    return document.records.filter((record) => {
      if (!options.includeInactive && !isSourceRecallLifecycleVisible(record.lifecycleState)) {
        return false;
      }
      if (options.scopeId && record.scopeId !== options.scopeId) {
        return false;
      }
      if (options.threadId && record.threadId !== options.threadId) {
        return false;
      }
      return true;
    });
  }

  /**
   * Lists chunks for one source record.
   *
   * **Why it exists:**
   * S1 needs to prove forgotten chunks are hidden without adding broader retrieval behavior.
   *
   * **What it talks to:**
   * - Uses `isSourceRecallLifecycleVisible` from `./sourceRecallPersistence`.
   *
   * @param sourceRecordId - Source record id whose chunks should be listed.
   * @param options - Inactive visibility controls.
   * @returns Matching chunks in deterministic order.
   */
  async listChunksForRecord(
    sourceRecordId: string,
    options: Pick<SourceRecallListOptions, "includeInactive"> = {}
  ): Promise<SourceRecallChunk[]> {
    const document = await this.loadDocument();
    return document.chunks.filter((chunk) => {
      if (chunk.sourceRecordId !== sourceRecordId) {
        return false;
      }
      return options.includeInactive === true || isSourceRecallLifecycleVisible(chunk.lifecycleState);
    });
  }

  /**
   * Marks a source record and its chunks as forgotten.
   *
   * **Why it exists:**
   * Delete-marker behavior must exist before any retrieval or projection surface can safely depend
   * on this store.
   *
   * **What it talks to:**
   * - Uses `markSourceRecallRecordForgottenInDocument` from `./sourceRecallPersistence`.
   *
   * @param sourceRecordId - Source record to hide from normal reads.
   * @returns Promise resolving when the marker is persisted.
   */
  async markSourceRecordForgotten(sourceRecordId: string): Promise<void> {
    await this.mutateDocument((document) =>
      markSourceRecallRecordForgottenInDocument(document, sourceRecordId)
    );
  }

  /**
   * Marks every source record linked to one origin parent reference with a lifecycle state.
   *
   * **Why it exists:**
   * Media artifact deletion/redaction must make linked source chunks unreachable without assuming
   * artifact bytes and Source Recall text have the same retention lifecycle.
   *
   * **What it talks to:**
   * - Uses `markSourceRecallRecordsByOriginParentRefInDocument` from `./sourceRecallPersistence`.
   *
   * @param parentRefId - Origin parent reference, such as media artifact id or checksum.
   * @param lifecycleState - Lifecycle state to apply to matching records and chunks.
   * @returns Promise resolving when the marker is persisted.
   */
  async markSourceRecordsByOriginParentRef(
    parentRefId: string,
    lifecycleState: Extract<SourceRecallLifecycleState, "redacted" | "forgotten" | "expired" | "quarantined">
  ): Promise<void> {
    await this.mutateDocument((document) =>
      markSourceRecallRecordsByOriginParentRefInDocument(document, parentRefId, lifecycleState)
    );
  }

  /**
   * Loads the full Source Recall document from SQLite.
   *
   * **Why it exists:**
   * S1 stores one authoritative SQLite document so later slices can replace internals without
   * changing the public store seam.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` from `../sqliteStore`.
   *
   * @returns Source Recall document.
   */
  async loadDocument(): Promise<SourceRecallDocument> {
    return withSqliteDatabase(this.sqlitePath, (db) => {
      ensureSourceRecallSchema(db);
      return readSourceRecallDocument(db);
    });
  }

  /**
   * Applies one deterministic document mutation and persists it.
   *
   * **Why it exists:**
   * Centralizing read-modify-write behavior keeps S1 upserts and delete markers consistent.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` from `../sqliteStore`.
   *
   * @param mutate - Pure document mutation.
   * @returns Promise resolving when the mutation is written.
   */
  private async mutateDocument(
    mutate: (document: SourceRecallDocument) => SourceRecallDocument
  ): Promise<void> {
    await withSqliteDatabase(this.sqlitePath, (db) => {
      ensureSourceRecallSchema(db);
      const current = readSourceRecallDocument(db);
      writeSourceRecallDocument(db, mutate(current));
    });
  }
}

/**
 * Ensures the Source Recall SQLite schema exists.
 *
 * **Why it exists:**
 * Store operations should bootstrap their own table before reading or writing test-only state.
 *
 * **What it talks to:**
 * - Uses `DatabaseSync` from `node:sqlite`.
 *
 * @param db - Open SQLite database handle.
 */
function ensureSourceRecallSchema(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${SOURCE_RECALL_STATE_TABLE} (
      id TEXT PRIMARY KEY,
      document_json TEXT NOT NULL
    );`
  );
}

/**
 * Reads the persisted Source Recall document from SQLite.
 *
 * **Why it exists:**
 * Keeps JSON parsing and document fallback behavior in one place for the SQLite-backed store.
 *
 * **What it talks to:**
 * - Uses `parseSourceRecallDocument` from `./sourceRecallPersistence`.
 *
 * @param db - Open SQLite database handle.
 * @returns Parsed Source Recall document.
 */
function readSourceRecallDocument(db: DatabaseSync): SourceRecallDocument {
  const row = db.prepare(
    `SELECT document_json
       FROM ${SOURCE_RECALL_STATE_TABLE}
      WHERE id = ?`
  ).get(SOURCE_RECALL_STATE_ROW_ID) as { document_json?: unknown } | undefined;
  if (typeof row?.document_json !== "string") {
    return createEmptySourceRecallDocument();
  }
  return parseSourceRecallDocument(JSON.parse(row.document_json));
}

/**
 * Writes one Source Recall document to SQLite.
 *
 * **Why it exists:**
 * S1 keeps persistence in one row, giving later slices one place to add encryption and cascade
 * behavior.
 *
 * **What it talks to:**
 * - Uses `DatabaseSync` from `node:sqlite`.
 *
 * @param db - Open SQLite database handle.
 * @param document - Document to persist.
 */
function writeSourceRecallDocument(db: DatabaseSync, document: SourceRecallDocument): void {
  db.prepare(
    `INSERT OR REPLACE INTO ${SOURCE_RECALL_STATE_TABLE}(id, document_json)
     VALUES (?, ?)`
  ).run(SOURCE_RECALL_STATE_ROW_ID, JSON.stringify(document, null, 2));
}
