/**
 * @fileoverview SQLite-backed vector store for lesson embeddings with nearest-neighbor search.
 *
 * Stores embedding vectors as packed Float32Array blobs alongside lesson IDs.
 * Retrieval uses brute-force cosine similarity (sufficient for <10K lessons).
 * Schema auto-creates on first access.
 */

import type { DatabaseSync } from "node:sqlite";

import { cosineSimilarity } from "./embeddingProvider";
import { withSqliteDatabase } from "./sqliteStore";

const VECTOR_TABLE = "lesson_embeddings";

export interface VectorSearchResult {
    lessonId: string;
    similarity: number;
}

interface SqliteVectorRow {
    lesson_id: string;
    embedding_blob: Buffer;
}

/**
 * Packs a float32 array into a Buffer for SQLite BLOB storage.
 */
function packFloat32(values: readonly number[]): Buffer {
    const buffer = Buffer.alloc(values.length * 4);
    for (let i = 0; i < values.length; i++) {
        buffer.writeFloatLE(values[i], i * 4);
    }
    return buffer;
}

/**
 * Unpacks a SQLite BLOB buffer back into a float32 array.
 */
function unpackFloat32(buffer: Buffer): number[] {
    const count = Math.floor(buffer.length / 4);
    const values: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
        values[i] = buffer.readFloatLE(i * 4);
    }
    return values;
}

/**
 * Validates a raw sqlite row shape for embedding scans.
 */
function isSqliteVectorRow(value: unknown): value is SqliteVectorRow {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const candidate = value as Partial<SqliteVectorRow>;
    return typeof candidate.lesson_id === "string" && Buffer.isBuffer(candidate.embedding_blob);
}

/**
 * Validates and normalizes sqlite vector row arrays.
 */
function parseSqliteVectorRows(rows: unknown): SqliteVectorRow[] {
    if (!Array.isArray(rows)) {
        throw new Error("Vector sqlite query returned non-array rowset.");
    }

    const normalized: SqliteVectorRow[] = [];
    for (const row of rows) {
        if (!isSqliteVectorRow(row)) {
            throw new Error("Vector sqlite row failed shape validation.");
        }
        normalized.push(row);
    }
    return normalized;
}

export class SqliteVectorStore {
    private schemaReady = false;

    /**
     * Initializes `SqliteVectorStore` with deterministic runtime dependencies.
     *
     * **Why it exists:**
     * Captures required dependencies at initialization time so runtime behavior remains explicit.
     *
     * **What it talks to:**
     * - Uses local constants/helpers within this module.
     *
     * @param sqlitePath - Filesystem location used by this operation.
     */
    constructor(private readonly sqlitePath: string) { }

    /**
     * Stores or updates an embedding vector for a lesson.
     */
    async upsert(lessonId: string, embedding: readonly number[]): Promise<void> {
        const blob = packFloat32(embedding);
        await withSqliteDatabase(this.sqlitePath, async (db) => {
            this.ensureSchema(db);
            db.prepare(
                `INSERT OR REPLACE INTO ${VECTOR_TABLE} (lesson_id, embedding_blob, dimension)
         VALUES (?, ?, ?)`
            ).run(lessonId, blob, embedding.length);
        });
    }

    /**
     * Stores embeddings for multiple lessons in a single transaction.
     */
    async upsertBatch(entries: ReadonlyArray<{ lessonId: string; embedding: readonly number[] }>): Promise<void> {
        if (entries.length === 0) return;
        await withSqliteDatabase(this.sqlitePath, async (db) => {
            this.ensureSchema(db);
            db.exec("BEGIN IMMEDIATE;");
            try {
                const stmt = db.prepare(
                    `INSERT OR REPLACE INTO ${VECTOR_TABLE} (lesson_id, embedding_blob, dimension)
           VALUES (?, ?, ?)`
                );
                for (const entry of entries) {
                    stmt.run(entry.lessonId, packFloat32(entry.embedding), entry.embedding.length);
                }
                db.exec("COMMIT;");
            } catch (error) {
                db.exec("ROLLBACK;");
                throw error;
            }
        });
    }

    /**
     * Removes the embedding for a lesson.
     */
    async remove(lessonId: string): Promise<void> {
        await withSqliteDatabase(this.sqlitePath, async (db) => {
            this.ensureSchema(db);
            db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE lesson_id = ?`).run(lessonId);
        });
    }

    /**
     * Finds the top-k nearest lessons by cosine similarity to the query embedding.
     * Uses brute-force scan — fast enough for <10K lessons (~5ms at 1K).
     */
    async search(queryEmbedding: readonly number[], topK = 5): Promise<VectorSearchResult[]> {
        return withSqliteDatabase(this.sqlitePath, async (db) => {
            this.ensureSchema(db);
            const rows = db
                .prepare(
                    `SELECT lesson_id, embedding_blob
           FROM ${VECTOR_TABLE}`
                )
                .all();
            const validatedRows = parseSqliteVectorRows(rows);

            const results: VectorSearchResult[] = [];
            for (const row of validatedRows) {
                const embedding = unpackFloat32(row.embedding_blob);
                const similarity = cosineSimilarity(queryEmbedding, embedding);
                results.push({ lessonId: row.lesson_id, similarity });
            }

            return results
                .sort((a, b) => b.similarity - a.similarity)
                .slice(0, topK);
        });
    }

    /**
     * Returns the count of stored embeddings.
     */
    async count(): Promise<number> {
        return withSqliteDatabase(this.sqlitePath, async (db) => {
            this.ensureSchema(db);
            const row = db
                .prepare(`SELECT COUNT(*) AS total FROM ${VECTOR_TABLE}`)
                .get() as { total?: number } | undefined;
            return Number(row?.total ?? 0);
        });
    }

    /**
     * Applies deterministic validity checks for schema.
     *
     * **Why it exists:**
     * Fails fast when schema is invalid so later control flow stays safe and predictable.
     *
     * **What it talks to:**
     * - Uses `DatabaseSync` (import `DatabaseSync`) from `node:sqlite`.
     *
     * @param db - Value for db.
     */
    private ensureSchema(db: DatabaseSync): void {
        if (this.schemaReady) return;
        db.exec(
            `CREATE TABLE IF NOT EXISTS ${VECTOR_TABLE} (
         lesson_id TEXT PRIMARY KEY,
         embedding_blob BLOB NOT NULL,
         dimension INTEGER NOT NULL
       );`
        );
        this.schemaReady = true;
    }
}
