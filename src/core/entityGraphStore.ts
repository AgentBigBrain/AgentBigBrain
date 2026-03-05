/**
 * @fileoverview Persists Stage 6.86 entity graph state with deterministic JSON/SQLite parity and extraction upsert helpers.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { LedgerBackend } from "./config";
import { withFileLock, writeFileAtomic } from "./fileLock";
import { withSqliteDatabase } from "./sqliteStore";
import { EntityGraphV1 } from "./types";
import {
  applyEntityExtractionToGraph,
  createEmptyEntityGraphV1,
  extractEntityCandidates,
  Stage686EntityExtractionInput,
  Stage686EntityGraphMutationOptions,
  Stage686EntityGraphMutationResult
} from "./stage6_86EntityGraph";

const SQLITE_ENTITY_GRAPH_STATE_TABLE = "entity_graph_state";

interface EntityGraphStoreOptions {
  backend?: LedgerBackend;
  sqlitePath?: string;
  exportJsonOnWrite?: boolean;
}

/**
 * Implements a deterministic entity graph store with JSON/SQLite parity.
 */
export class EntityGraphStore {
  private loaded = false;
  private graph: EntityGraphV1 = createEmptyEntityGraphV1(new Date().toISOString());
  private sqliteReady = false;
  private readonly backend: LedgerBackend;
  private readonly sqlitePath: string;
  private readonly exportJsonOnWrite: boolean;

  /**
   * Initializes `EntityGraphStore` with deterministic runtime dependencies.
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
    private readonly filePath: string = path.resolve(process.cwd(), "runtime/entity_graph.json"),
    options: EntityGraphStoreOptions = {}
  ) {
    this.backend = options.backend ?? "json";
    this.sqlitePath = options.sqlitePath ?? path.resolve(process.cwd(), "runtime/ledgers.sqlite");
    this.exportJsonOnWrite = options.exportJsonOnWrite ?? true;
  }

  /**
   * Reads graph needed for this execution step.
   *
   * **Why it exists:**
   * Separates graph read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `./types`.
   * @returns Promise resolving to EntityGraphV1.
   */
  async getGraph(): Promise<EntityGraphV1> {
    if (this.backend === "sqlite") {
      await this.ensureSqliteReady();
      return withSqliteDatabase(this.sqlitePath, async (db) => this.readGraphFromSqlite(db));
    }

    await this.ensureLoaded(true);
    return this.graph;
  }

  /**
   * Persists from extraction input with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes from extraction input mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `applyEntityExtractionToGraph` (import `applyEntityExtractionToGraph`) from `./stage6_86EntityGraph`.
   * - Uses `extractEntityCandidates` (import `extractEntityCandidates`) from `./stage6_86EntityGraph`.
   * - Uses `Stage686EntityExtractionInput` (import `Stage686EntityExtractionInput`) from `./stage6_86EntityGraph`.
   * - Uses `Stage686EntityGraphMutationOptions` (import `Stage686EntityGraphMutationOptions`) from `./stage6_86EntityGraph`.
   * - Uses `Stage686EntityGraphMutationResult` (import `Stage686EntityGraphMutationResult`) from `./stage6_86EntityGraph`.
   *
   * @param input - Structured input object for this operation.
   * @param options - Optional tuning knobs for this operation.
   * @returns Promise resolving to Stage686EntityGraphMutationResult.
   */
  async upsertFromExtractionInput(
    input: Stage686EntityExtractionInput,
    options: Stage686EntityGraphMutationOptions = {}
  ): Promise<Stage686EntityGraphMutationResult> {
    const extraction = extractEntityCandidates(input);
    const currentGraph = await this.getGraph();
    const mutation = applyEntityExtractionToGraph(
      currentGraph,
      extraction,
      input.observedAt,
      input.evidenceRef,
      options
    );
    await this.persistGraph(mutation.graph);
    return mutation;
  }

  /**
   * Persists graph with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes graph mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `withFileLock` (import `withFileLock`) from `./fileLock`.
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `./fileLock`.
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `./types`.
   *
   * @param graph - Value for graph.
   * @returns Promise resolving to void.
   */
  async persistGraph(graph: EntityGraphV1): Promise<void> {
    const normalized = normalizeEntityGraph(graph);
    if (this.backend === "sqlite") {
      await this.ensureSqliteReady();
      await withSqliteDatabase(this.sqlitePath, async (db) => {
        this.ensureSqliteSchema(db);
        this.writeGraphToSqlite(db, normalized);
      });
      if (this.exportJsonOnWrite) {
        await withFileLock(this.filePath, async () => {
          await writeFileAtomic(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`);
        });
      }
      return;
    }

    await withFileLock(this.filePath, async () => {
      this.graph = normalized;
      await writeFileAtomic(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`);
    });
  }

  /**
   * Applies deterministic validity checks for loaded.
   *
   * **Why it exists:**
   * Fails fast when loaded is invalid so later control flow stays safe and predictable.
   *
   * **What it talks to:**
   * - Uses `createEmptyEntityGraphV1` (import `createEmptyEntityGraphV1`) from `./stage6_86EntityGraph`.
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
      const parsed = JSON.parse(stripUtf8Bom(raw)) as unknown;
      this.graph = normalizeEntityGraph(parsed);
    } catch {
      this.graph = createEmptyEntityGraphV1(new Date().toISOString());
    }

    this.loaded = true;
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
      `CREATE TABLE IF NOT EXISTS ${SQLITE_ENTITY_GRAPH_STATE_TABLE} (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         schema_version TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         graph_json TEXT NOT NULL
       );`
    );
  }

  /**
   * Reads graph from sqlite needed for this execution step.
   *
   * **Why it exists:**
   * Separates graph from sqlite read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `createEmptyEntityGraphV1` (import `createEmptyEntityGraphV1`) from `./stage6_86EntityGraph`.
   * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `./types`.
   * - Uses `DatabaseSync` (import `DatabaseSync`) from `node:sqlite`.
   *
   * @param db - Value for db.
   * @returns Computed `EntityGraphV1` result.
   */
  private readGraphFromSqlite(db: DatabaseSync): EntityGraphV1 {
    this.ensureSqliteSchema(db);
    const row = db
      .prepare(
        `SELECT schema_version, updated_at, graph_json
         FROM ${SQLITE_ENTITY_GRAPH_STATE_TABLE}
         WHERE id = 1`
      )
      .get() as
      | {
          schema_version?: string;
          updated_at?: string;
          graph_json?: string;
        }
      | undefined;
    if (!row?.graph_json || row.schema_version !== "v1" || typeof row.updated_at !== "string") {
      return createEmptyEntityGraphV1(new Date().toISOString());
    }

    try {
      const parsed = JSON.parse(row.graph_json) as unknown;
      return normalizeEntityGraph(parsed);
    } catch {
      return createEmptyEntityGraphV1(new Date().toISOString());
    }
  }

  /**
   * Persists graph to sqlite with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes graph to sqlite mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `./types`.
   * - Uses `DatabaseSync` (import `DatabaseSync`) from `node:sqlite`.
   *
   * @param db - Value for db.
   * @param graph - Value for graph.
   */
  private writeGraphToSqlite(db: DatabaseSync, graph: EntityGraphV1): void {
    this.ensureSqliteSchema(db);
    db.prepare(
      `INSERT INTO ${SQLITE_ENTITY_GRAPH_STATE_TABLE}(id, schema_version, updated_at, graph_json)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         schema_version = excluded.schema_version,
         updated_at = excluded.updated_at,
         graph_json = excluded.graph_json`
    ).run("v1", graph.updatedAt, JSON.stringify(graph));
  }

  /**
   * Imports json snapshot into sqlite if empty into local state while preserving deterministic ordering.
   *
   * **Why it exists:**
   * Ensures json snapshot into sqlite if empty import follows one deterministic migration/bootstrap path.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
   * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `./types`.
   * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
   * @returns Promise resolving to void.
   */
  private async importJsonSnapshotIntoSqliteIfEmpty(): Promise<void> {
    let snapshot: EntityGraphV1 | null = null;
    try {
      const raw = await readFile(this.filePath, "utf8");
      snapshot = normalizeEntityGraph(JSON.parse(stripUtf8Bom(raw)));
    } catch {
      snapshot = null;
    }

    if (!snapshot) {
      return;
    }

    await withSqliteDatabase(this.sqlitePath, async (db) => {
      this.ensureSqliteSchema(db);
      const existing = db
        .prepare(
          `SELECT COUNT(*) AS total
           FROM ${SQLITE_ENTITY_GRAPH_STATE_TABLE}`
        )
        .get() as { total?: number } | undefined;
      if (Number(existing?.total ?? 0) > 0) {
        return;
      }
      this.writeGraphToSqlite(db, snapshot!);
    });
  }
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
 * Evaluates string array and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the string array policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Ordered collection produced by this step.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Normalizes entity graph into a stable shape for `entityGraphStore` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for entity graph so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `./types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `EntityGraphV1` result.
 */
function normalizeEntityGraph(value: unknown): EntityGraphV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed entity graph: expected object root.");
  }

  const candidate = value as Partial<EntityGraphV1>;
  if (candidate.schemaVersion !== "v1") {
    throw new Error("Malformed entity graph: schemaVersion must be 'v1'.");
  }
  if (typeof candidate.updatedAt !== "string" || !Number.isFinite(Date.parse(candidate.updatedAt))) {
    throw new Error("Malformed entity graph: updatedAt must be an ISO timestamp string.");
  }
  if (!Array.isArray(candidate.entities) || !Array.isArray(candidate.edges)) {
    throw new Error("Malformed entity graph: entities/edges must be arrays.");
  }

  const entities = candidate.entities.map((entity, index) => normalizeEntityNode(entity, index));
  const edges = candidate.edges.map((edge, index) => normalizeRelationEdge(edge, index));
  return {
    schemaVersion: "v1",
    updatedAt: candidate.updatedAt,
    entities: entities.sort((left, right) => left.entityKey.localeCompare(right.entityKey)),
    edges: edges.sort((left, right) => left.edgeKey.localeCompare(right.edgeKey))
  };
}

/**
 * Normalizes entity node into a stable shape for `entityGraphStore` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for entity node so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `./types`.
 *
 * @param value - Primary value processed by this function.
 * @param index - Numeric bound, counter, or index used by this logic.
 * @returns Computed `EntityGraphV1["entities"][number]` result.
 */
function normalizeEntityNode(value: unknown, index: number): EntityGraphV1["entities"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Malformed entity node at index ${index}.`);
  }

  const candidate = value as Partial<EntityGraphV1["entities"][number]>;
  if (
    typeof candidate.entityKey !== "string" ||
    typeof candidate.canonicalName !== "string" ||
    typeof candidate.entityType !== "string" ||
    !(candidate.disambiguator === null || typeof candidate.disambiguator === "string") ||
    !isStringArray(candidate.aliases) ||
    typeof candidate.firstSeenAt !== "string" ||
    typeof candidate.lastSeenAt !== "string" ||
    typeof candidate.salience !== "number" ||
    !Number.isFinite(candidate.salience) ||
    !isStringArray(candidate.evidenceRefs)
  ) {
    throw new Error(`Malformed entity node at index ${index}.`);
  }

  if (
    !Number.isFinite(Date.parse(candidate.firstSeenAt)) ||
    !Number.isFinite(Date.parse(candidate.lastSeenAt))
  ) {
    throw new Error(`Malformed entity node at index ${index}: invalid timestamp fields.`);
  }

  return {
    entityKey: candidate.entityKey,
    canonicalName: candidate.canonicalName,
    entityType: candidate.entityType,
    disambiguator: candidate.disambiguator,
    aliases: [...candidate.aliases].sort((left, right) => left.localeCompare(right)),
    firstSeenAt: candidate.firstSeenAt,
    lastSeenAt: candidate.lastSeenAt,
    salience: Number(candidate.salience.toFixed(4)),
    evidenceRefs: [...candidate.evidenceRefs].sort((left, right) => left.localeCompare(right))
  };
}

/**
 * Normalizes relation edge into a stable shape for `entityGraphStore` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for relation edge so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `./types`.
 *
 * @param value - Primary value processed by this function.
 * @param index - Numeric bound, counter, or index used by this logic.
 * @returns Computed `EntityGraphV1["edges"][number]` result.
 */
function normalizeRelationEdge(value: unknown, index: number): EntityGraphV1["edges"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Malformed relation edge at index ${index}.`);
  }

  const candidate = value as Partial<EntityGraphV1["edges"][number]>;
  if (
    typeof candidate.edgeKey !== "string" ||
    typeof candidate.sourceEntityKey !== "string" ||
    typeof candidate.targetEntityKey !== "string" ||
    typeof candidate.relationType !== "string" ||
    typeof candidate.status !== "string" ||
    typeof candidate.coMentionCount !== "number" ||
    !Number.isFinite(candidate.coMentionCount) ||
    typeof candidate.strength !== "number" ||
    !Number.isFinite(candidate.strength) ||
    typeof candidate.firstObservedAt !== "string" ||
    typeof candidate.lastObservedAt !== "string" ||
    !isStringArray(candidate.evidenceRefs)
  ) {
    throw new Error(`Malformed relation edge at index ${index}.`);
  }

  if (
    !Number.isFinite(Date.parse(candidate.firstObservedAt)) ||
    !Number.isFinite(Date.parse(candidate.lastObservedAt))
  ) {
    throw new Error(`Malformed relation edge at index ${index}: invalid timestamp fields.`);
  }

  return {
    edgeKey: candidate.edgeKey,
    sourceEntityKey: candidate.sourceEntityKey,
    targetEntityKey: candidate.targetEntityKey,
    relationType: candidate.relationType,
    status: candidate.status,
    coMentionCount: Math.max(0, Math.floor(candidate.coMentionCount)),
    strength: Number(candidate.strength.toFixed(4)),
    firstObservedAt: candidate.firstObservedAt,
    lastObservedAt: candidate.lastObservedAt,
    evidenceRefs: [...candidate.evidenceRefs].sort((left, right) => left.localeCompare(right))
  };
}
