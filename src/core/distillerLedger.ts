/**
 * @fileoverview Distiller merge rejection ledger with dual JSON/SQLite backends for satellite lesson merge tracking.
 */

import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import { LedgerBackend } from "./config";
import { hashSha256, toIso, toSortedUnique } from "./cryptoUtils";
import { withFileLock, writeFileAtomic } from "./fileLock";
import { makeId } from "./ids";
import { withSqliteDatabase } from "./sqliteStore";

const MAX_DISTILLER_LEDGER_ENTRIES = 2_000;
const SQLITE_DISTILLER_LEDGER_TABLE = "distiller_rejection_ledger";

export interface DistillerMergeLedgerEntry {
    id: string;
    decidedAt: string;
    cloneId: string;
    lessonFingerprint: string;
    merged: boolean;
    rejectingGovernorIds: readonly string[];
    reason: string;
}

interface DistillerMergeLedgerDocument {
    entries: DistillerMergeLedgerEntry[];
}

interface DistillerMergeLedgerStoreOptions {
    backend?: LedgerBackend;
    sqlitePath?: string;
    exportJsonOnWrite?: boolean;
}

interface SqliteDistillerLedgerRow {
    id: string;
    decided_at: string;
    clone_id: string;
    lesson_fingerprint: string;
    merged: number;
    rejecting_governor_ids_json: string;
    reason: string;
}

/**
 * Validates a raw sqlite row shape for distiller ledger reads.
 */
function isSqliteDistillerLedgerRow(value: unknown): value is SqliteDistillerLedgerRow {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Partial<SqliteDistillerLedgerRow>;
    return (
        typeof candidate.id === "string" &&
        typeof candidate.decided_at === "string" &&
        typeof candidate.clone_id === "string" &&
        typeof candidate.lesson_fingerprint === "string" &&
        typeof candidate.merged === "number" &&
        Number.isFinite(candidate.merged) &&
        typeof candidate.rejecting_governor_ids_json === "string" &&
        typeof candidate.reason === "string"
    );
}

/**
 * Validates and normalizes sqlite distiller-ledger row arrays.
 */
function parseSqliteDistillerLedgerRows(rows: unknown): SqliteDistillerLedgerRow[] {
    if (!Array.isArray(rows)) {
        throw new Error("Distiller sqlite query returned non-array rowset.");
    }

    const normalizedRows: SqliteDistillerLedgerRow[] = [];
    for (const row of rows) {
        if (!isSqliteDistillerLedgerRow(row)) {
            throw new Error("Distiller sqlite row failed shape validation.");
        }
        normalizedRows.push(row);
    }

    return normalizedRows;
}

/**
 * Coerces unknown input into a valid DistillerMergeLedgerDocument.
 */
function coerceDistillerDocument(input: unknown): DistillerMergeLedgerDocument {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return { entries: [] };
    }

    const record = input as { entries?: unknown };
    if (!Array.isArray(record.entries)) {
        return { entries: [] };
    }

    const entries = record.entries
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .map((item) => {
            const raw = item as Partial<DistillerMergeLedgerEntry>;
            return {
                id: typeof raw.id === "string" && raw.id.trim() ? raw.id : makeId("distiller_ledger"),
                decidedAt: typeof raw.decidedAt === "string" && raw.decidedAt.trim() ? raw.decidedAt : new Date().toISOString(),
                cloneId: typeof raw.cloneId === "string" && raw.cloneId.trim() ? raw.cloneId : "unknown_clone",
                lessonFingerprint:
                    typeof raw.lessonFingerprint === "string" && raw.lessonFingerprint.trim()
                        ? raw.lessonFingerprint
                        : hashSha256(""),
                merged: raw.merged === true,
                rejectingGovernorIds: Array.isArray(raw.rejectingGovernorIds)
                    ? toSortedUnique(raw.rejectingGovernorIds.filter((value): value is string => typeof value === "string"))
                    : [],
                reason: typeof raw.reason === "string" ? raw.reason : ""
            } satisfies DistillerMergeLedgerEntry;
        });

    return { entries };
}

export class DistillerMergeLedgerStore {
    private sqliteReady = false;
    private readonly backend: LedgerBackend;
    private readonly sqlitePath: string;
    private readonly exportJsonOnWrite: boolean;

    /**
     * Initializes `DistillerMergeLedgerStore` with deterministic runtime dependencies.
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
        private readonly filePath = "runtime/distiller_rejection_ledger.json",
        options: DistillerMergeLedgerStoreOptions = {}
    ) {
        this.backend = options.backend ?? "json";
        this.sqlitePath = options.sqlitePath ?? "runtime/ledgers.sqlite";
        this.exportJsonOnWrite = options.exportJsonOnWrite ?? true;
    }

    /**
     * Reads input needed for this execution step.
     *
     * **Why it exists:**
     * Separates input read-path handling from orchestration and mutation code.
     *
     * **What it talks to:**
     * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
     * @returns Promise resolving to DistillerMergeLedgerDocument.
     */
    async load(): Promise<DistillerMergeLedgerDocument> {
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
     * Reads json document from file needed for this execution step.
     *
     * **Why it exists:**
     * Separates json document from file read-path handling from orchestration and mutation code.
     *
     * **What it talks to:**
     * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
     * @returns Promise resolving to DistillerMergeLedgerDocument.
     */
    private async readJsonDocumentFromFile(): Promise<DistillerMergeLedgerDocument> {
        try {
            const raw = await readFile(this.filePath, "utf8");
            return coerceDistillerDocument(JSON.parse(raw));
        } catch {
            return { entries: [] };
        }
    }

    /**
     * Persists decision with deterministic state semantics.
     *
     * **Why it exists:**
     * Centralizes decision mutations for auditability and replay.
     *
     * **What it talks to:**
     * - Uses `hashSha256` (import `hashSha256`) from `./cryptoUtils`.
     * - Uses `toIso` (import `toIso`) from `./cryptoUtils`.
     * - Uses `toSortedUnique` (import `toSortedUnique`) from `./cryptoUtils`.
     * - Uses `withFileLock` (import `withFileLock`) from `./fileLock`.
     * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `./fileLock`.
     * - Uses `makeId` (import `makeId`) from `./ids`.
     *
     * @param input - Structured input object for this operation.
     * @returns Promise resolving to DistillerMergeLedgerEntry.
     */
    async appendDecision(input: {
        cloneId: string;
        lessonText: string;
        merged: boolean;
        rejectingGovernorIds: readonly string[];
        reason: string;
        decidedAt?: string;
    }): Promise<DistillerMergeLedgerEntry> {
        const entry: DistillerMergeLedgerEntry = {
            id: makeId("distiller_ledger"),
            decidedAt: toIso(input.decidedAt),
            cloneId: input.cloneId.trim() || "unknown_clone",
            lessonFingerprint: hashSha256(input.lessonText.trim()),
            merged: input.merged,
            rejectingGovernorIds: toSortedUnique(input.rejectingGovernorIds),
            reason: input.reason.trim()
        };

        if (this.backend === "sqlite") {
            return this.appendDecisionSqlite(entry);
        }

        await withFileLock(this.filePath, async () => {
            const document = await this.load();
            document.entries.push(entry);
            if (document.entries.length > MAX_DISTILLER_LEDGER_ENTRIES) {
                document.entries = document.entries.slice(-MAX_DISTILLER_LEDGER_ENTRIES);
            }
            await writeFileAtomic(this.filePath, JSON.stringify(document, null, 2));
        });

        return entry;
    }

    /**
     * Persists decision sqlite with deterministic state semantics.
     *
     * **Why it exists:**
     * Centralizes decision sqlite mutations for auditability and replay.
     *
     * **What it talks to:**
     * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
     *
     * @param entry - Value for entry.
     * @returns Promise resolving to DistillerMergeLedgerEntry.
     */
    private async appendDecisionSqlite(
        entry: DistillerMergeLedgerEntry
    ): Promise<DistillerMergeLedgerEntry> {
        await this.ensureSqliteReady();

        await withSqliteDatabase(this.sqlitePath, async (db) => {
            this.ensureSqliteSchema(db);
            db.exec("BEGIN IMMEDIATE;");
            try {
                db.prepare(
                    `INSERT INTO ${SQLITE_DISTILLER_LEDGER_TABLE} (
             id, decided_at, clone_id, lesson_fingerprint, merged, rejecting_governor_ids_json, reason
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
                ).run(
                    entry.id,
                    entry.decidedAt,
                    entry.cloneId,
                    entry.lessonFingerprint,
                    entry.merged ? 1 : 0,
                    JSON.stringify(entry.rejectingGovernorIds),
                    entry.reason
                );

                db.prepare(
                    `DELETE FROM ${SQLITE_DISTILLER_LEDGER_TABLE}
           WHERE ledger_seq NOT IN (
             SELECT ledger_seq
             FROM ${SQLITE_DISTILLER_LEDGER_TABLE}
             ORDER BY ledger_seq DESC
             LIMIT ?
           )`
                ).run(MAX_DISTILLER_LEDGER_ENTRIES);
                db.exec("COMMIT;");
            } catch (error) {
                db.exec("ROLLBACK;");
                throw error;
            }
        });

        if (this.exportJsonOnWrite) {
            await this.persistSqliteSnapshotToJson();
        }

        return entry;
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
            `CREATE TABLE IF NOT EXISTS ${SQLITE_DISTILLER_LEDGER_TABLE} (
         ledger_seq INTEGER PRIMARY KEY AUTOINCREMENT,
         id TEXT NOT NULL UNIQUE,
         decided_at TEXT NOT NULL,
         clone_id TEXT NOT NULL,
         lesson_fingerprint TEXT NOT NULL,
         merged INTEGER NOT NULL,
         rejecting_governor_ids_json TEXT NOT NULL,
         reason TEXT NOT NULL
       );`
        );
        db.exec(
            `CREATE INDEX IF NOT EXISTS idx_${SQLITE_DISTILLER_LEDGER_TABLE}_decided_at
       ON ${SQLITE_DISTILLER_LEDGER_TABLE}(decided_at);`
        );
    }

    /**
     * Reads sqlite document needed for this execution step.
     *
     * **Why it exists:**
     * Separates sqlite document read-path handling from orchestration and mutation code.
     *
     * **What it talks to:**
     * - Uses `DatabaseSync` (import `DatabaseSync`) from `node:sqlite`.
     *
     * @param db - Value for db.
     * @returns Computed `DistillerMergeLedgerDocument` result.
     */
    private readSqliteDocument(db: DatabaseSync): DistillerMergeLedgerDocument {
        const rows = db
            .prepare(
                `SELECT id, decided_at, clone_id, lesson_fingerprint, merged, rejecting_governor_ids_json, reason
         FROM ${SQLITE_DISTILLER_LEDGER_TABLE}
         ORDER BY ledger_seq ASC`
            )
            .all();
        const validatedRows = parseSqliteDistillerLedgerRows(rows);
        return {
            entries: validatedRows.map((row) => ({
                id: row.id,
                decidedAt: row.decided_at,
                cloneId: row.clone_id,
                lessonFingerprint: row.lesson_fingerprint,
                merged: Number(row.merged) === 1,
                rejectingGovernorIds: parseJsonStringArrayLocal(row.rejecting_governor_ids_json),
                reason: row.reason
            }))
        };
    }

    /**
     * Imports json snapshot into sqlite if empty into local state while preserving deterministic ordering.
     *
     * **Why it exists:**
     * Ensures json snapshot into sqlite if empty import follows one deterministic migration/bootstrap path.
     *
     * **What it talks to:**
     * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
     * @returns Promise resolving to void.
     */
    private async importJsonSnapshotIntoSqliteIfEmpty(): Promise<void> {
        const document = await this.readJsonDocumentFromFile();
        if (document.entries.length === 0) {
            return;
        }

        await withSqliteDatabase(this.sqlitePath, async (db) => {
            this.ensureSqliteSchema(db);
            const existing = db
                .prepare(
                    `SELECT COUNT(*) AS totalEntries
           FROM ${SQLITE_DISTILLER_LEDGER_TABLE}`
                )
                .get() as { totalEntries?: number } | undefined;
            if (Number(existing?.totalEntries ?? 0) > 0) {
                return;
            }

            db.exec("BEGIN IMMEDIATE;");
            try {
                for (const entry of document.entries) {
                    db.prepare(
                        `INSERT OR IGNORE INTO ${SQLITE_DISTILLER_LEDGER_TABLE} (
               id, decided_at, clone_id, lesson_fingerprint, merged, rejecting_governor_ids_json, reason
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`
                    ).run(
                        entry.id,
                        entry.decidedAt,
                        entry.cloneId,
                        entry.lessonFingerprint,
                        entry.merged ? 1 : 0,
                        JSON.stringify(entry.rejectingGovernorIds),
                        entry.reason
                    );
                }
                db.exec("COMMIT;");
            } catch (error) {
                db.exec("ROLLBACK;");
                throw error;
            }
        });
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
 * Module-local JSON string array parser (avoids circular import with cryptoUtils).
 */
function parseJsonStringArrayLocal(raw: string): string[] {
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
