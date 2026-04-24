/**
 * @fileoverview Tamper-evident execution receipt chain with dual JSON/SQLite backends for approved action provenance tracking.
 */

import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import { LedgerBackend } from "./config";
import { hashSha256 } from "./cryptoUtils";
import { withFileLock, writeFileAtomic } from "./fileLock";
import { makeId } from "./ids";
import { sha256HexFromCanonicalJson } from "./normalizers/canonicalizationRules";
import { buildProjectionChangeSet } from "./projections/service";
import { withSqliteDatabase } from "./sqliteStore";
import { ActionRunResult } from "./types";

const MAX_EXECUTION_RECEIPTS = 10_000;
const SQLITE_EXECUTION_RECEIPTS_TABLE = "execution_receipts";

export interface ExecutionReceipt {
    id: string;
    recordedAt: string;
    taskId: string;
    planTaskId: string;
    proposalId: string | null;
    actionId: string;
    actionType: string;
    approved: boolean;
    outputDigest: string;
    voteDigest: string;
    metadataDigest: string;
    priorReceiptHash: string;
    receiptHash: string;
}

interface ExecutionReceiptDocument {
    receipts: ExecutionReceipt[];
}

interface ExecutionReceiptStoreOptions {
    backend?: LedgerBackend;
    sqlitePath?: string;
    exportJsonOnWrite?: boolean;
    onChange?: (changeSet: import("./projections/contracts").ProjectionChangeSet) => Promise<void> | void;
}

export interface AppendExecutionReceiptInput {
    taskId: string;
    planTaskId: string;
    proposalId: string | null;
    actionResult: ActionRunResult;
}

export interface ExecutionReceiptVerificationResult {
    valid: boolean;
    mismatchIndices: readonly number[];
}

interface SqliteExecutionReceiptRow {
    id: string;
    recorded_at: string;
    task_id: string;
    plan_task_id: string;
    proposal_id: string | null;
    action_id: string;
    action_type: string;
    approved: number;
    output_digest: string;
    vote_digest: string;
    metadata_digest: string;
    prior_receipt_hash: string;
    receipt_hash: string;
}

/**
 * Validates a raw sqlite row shape for execution-receipt reads.
 */
function isSqliteExecutionReceiptRow(value: unknown): value is SqliteExecutionReceiptRow {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Partial<SqliteExecutionReceiptRow>;
    return (
        typeof candidate.id === "string" &&
        typeof candidate.recorded_at === "string" &&
        typeof candidate.task_id === "string" &&
        typeof candidate.plan_task_id === "string" &&
        (candidate.proposal_id === null || typeof candidate.proposal_id === "string") &&
        typeof candidate.action_id === "string" &&
        typeof candidate.action_type === "string" &&
        typeof candidate.approved === "number" &&
        Number.isFinite(candidate.approved) &&
        typeof candidate.output_digest === "string" &&
        typeof candidate.vote_digest === "string" &&
        typeof candidate.metadata_digest === "string" &&
        typeof candidate.prior_receipt_hash === "string" &&
        typeof candidate.receipt_hash === "string"
    );
}

/**
 * Validates and normalizes sqlite execution-receipt row arrays.
 */
function parseSqliteExecutionReceiptRows(rows: unknown): SqliteExecutionReceiptRow[] {
    if (!Array.isArray(rows)) {
        throw new Error("Execution receipt sqlite query returned non-array rowset.");
    }

    const normalizedRows: SqliteExecutionReceiptRow[] = [];
    for (const row of rows) {
        if (!isSqliteExecutionReceiptRow(row)) {
            throw new Error("Execution receipt sqlite row failed shape validation.");
        }
        normalizedRows.push(row);
    }

    return normalizedRows;
}

/**
 * Determines whether a sqlite table already defines a specific column name.
 */
function sqliteTableHasColumn(
    db: DatabaseSync,
    tableName: string,
    columnName: string
): boolean {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
    return rows.some((row) => typeof row.name === "string" && row.name === columnName);
}

/**
 * Builds a deterministic payload string for receipt hash computation.
 */
function toReceiptPayload(receipt: Omit<ExecutionReceipt, "id" | "recordedAt" | "receiptHash">): string {
    return JSON.stringify({
        taskId: receipt.taskId,
        planTaskId: receipt.planTaskId,
        proposalId: receipt.proposalId,
        actionId: receipt.actionId,
        actionType: receipt.actionType,
        approved: receipt.approved,
        outputDigest: receipt.outputDigest,
        voteDigest: receipt.voteDigest,
        metadataDigest: receipt.metadataDigest,
        priorReceiptHash: receipt.priorReceiptHash
    });
}

/**
 * Builds a deterministic vote digest from an action result's voting state.
 */
function buildVoteDigest(result: ActionRunResult): string {
    return hashSha256(
        JSON.stringify({
            blockedBy: result.blockedBy,
            votes: result.votes,
            decision: result.decision ?? null
        })
    );
}

/**
 * Builds a deterministic metadata digest from execution metadata.
 */
function buildMetadataDigest(result: ActionRunResult): string {
    return sha256HexFromCanonicalJson(result.executionMetadata ?? {});
}

/**
 * Coerces unknown input into a valid ExecutionReceiptDocument.
 */
function coerceExecutionReceiptDocument(input: unknown): ExecutionReceiptDocument {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return { receipts: [] };
    }

    const record = input as { receipts?: unknown };
    if (!Array.isArray(record.receipts)) {
        return { receipts: [] };
    }

    const receipts = record.receipts
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .map((item) => {
            const raw = item as Partial<ExecutionReceipt>;
            return {
                id: typeof raw.id === "string" && raw.id.trim() ? raw.id : makeId("execution_receipt"),
                recordedAt: typeof raw.recordedAt === "string" && raw.recordedAt.trim() ? raw.recordedAt : new Date().toISOString(),
                taskId: typeof raw.taskId === "string" ? raw.taskId : "unknown_task",
                planTaskId: typeof raw.planTaskId === "string" ? raw.planTaskId : "unknown_plan",
                proposalId: typeof raw.proposalId === "string" ? raw.proposalId : null,
                actionId: typeof raw.actionId === "string" ? raw.actionId : "unknown_action",
                actionType: typeof raw.actionType === "string" ? raw.actionType : "unknown_action_type",
                approved: raw.approved === true,
                outputDigest: typeof raw.outputDigest === "string" ? raw.outputDigest : hashSha256(""),
                voteDigest: typeof raw.voteDigest === "string" ? raw.voteDigest : hashSha256(""),
                metadataDigest: typeof raw.metadataDigest === "string"
                    ? raw.metadataDigest
                    : sha256HexFromCanonicalJson({}),
                priorReceiptHash: typeof raw.priorReceiptHash === "string" ? raw.priorReceiptHash : "GENESIS",
                receiptHash: typeof raw.receiptHash === "string" ? raw.receiptHash : hashSha256("")
            } satisfies ExecutionReceipt;
        });

    return { receipts };
}

export class ExecutionReceiptStore {
    private sqliteReady = false;
    private readonly backend: LedgerBackend;
    private readonly sqlitePath: string;
    private readonly exportJsonOnWrite: boolean;
    private readonly onChange?: ExecutionReceiptStoreOptions["onChange"];

    /**
     * Initializes `ExecutionReceiptStore` with deterministic runtime dependencies.
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
        private readonly filePath = "runtime/execution_receipts.json",
        options: ExecutionReceiptStoreOptions = {}
    ) {
        this.backend = options.backend ?? "json";
        this.sqlitePath = options.sqlitePath ?? "runtime/ledgers.sqlite";
        this.exportJsonOnWrite = options.exportJsonOnWrite ?? true;
        this.onChange = options.onChange;
    }

    /**
     * Reads input needed for this execution step.
     *
     * **Why it exists:**
     * Separates input read-path handling from orchestration and mutation code.
     *
     * **What it talks to:**
     * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
     * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
     * @returns Promise resolving to ExecutionReceiptDocument.
     */
    async load(): Promise<ExecutionReceiptDocument> {
        if (this.backend === "sqlite") {
            await this.ensureSqliteReady();
            return withSqliteDatabase(this.sqlitePath, async (db) => {
                this.ensureSqliteSchema(db);
                return this.readSqliteDocument(db);
            });
        }

        try {
            const raw = await readFile(this.filePath, "utf8");
            return coerceExecutionReceiptDocument(JSON.parse(raw));
        } catch {
            return { receipts: [] };
        }
    }

    /**
     * Persists approved action receipt with deterministic state semantics.
     *
     * **Why it exists:**
     * Centralizes approved action receipt mutations for auditability and replay.
     *
     * **What it talks to:**
     * - Uses `hashSha256` (import `hashSha256`) from `./cryptoUtils`.
     * - Uses `withFileLock` (import `withFileLock`) from `./fileLock`.
     * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `./fileLock`.
     * - Uses `makeId` (import `makeId`) from `./ids`.
     *
     * @param input - Structured input object for this operation.
     * @returns Promise resolving to ExecutionReceipt.
     */
    async appendApprovedActionReceipt(input: AppendExecutionReceiptInput): Promise<ExecutionReceipt> {
        if (!input.actionResult.approved) {
            throw new Error("Execution receipts are only emitted for approved actions.");
        }

        if (this.backend === "sqlite") {
            const receipt = await this.appendApprovedActionReceiptSqlite(input);
            await this.notifyProjectionChange(receipt);
            return receipt;
        }

        const outputDigest = hashSha256((input.actionResult.output ?? "").trim());
        const voteDigest = buildVoteDigest(input.actionResult);
        const metadataDigest = buildMetadataDigest(input.actionResult);

        let appendedReceipt: ExecutionReceipt | null = null;
        await withFileLock(this.filePath, async () => {
            const document = await this.load();
            const priorReceiptHash =
                document.receipts.length > 0
                    ? document.receipts[document.receipts.length - 1].receiptHash
                    : "GENESIS";

            const baseReceipt = {
                taskId: input.taskId,
                planTaskId: input.planTaskId,
                proposalId: input.proposalId,
                actionId: input.actionResult.action.id,
                actionType: input.actionResult.action.type,
                approved: input.actionResult.approved,
                outputDigest,
                voteDigest,
                metadataDigest,
                priorReceiptHash
            };
            const receiptHash = hashSha256(toReceiptPayload(baseReceipt));

            const receipt: ExecutionReceipt = {
                id: makeId("execution_receipt"),
                recordedAt: new Date().toISOString(),
                ...baseReceipt,
                receiptHash
            };

            document.receipts.push(receipt);
            if (document.receipts.length > MAX_EXECUTION_RECEIPTS) {
                document.receipts = document.receipts.slice(-MAX_EXECUTION_RECEIPTS);
            }
            await writeFileAtomic(this.filePath, JSON.stringify(document, null, 2));
            appendedReceipt = receipt;
        });

        if (!appendedReceipt) {
            throw new Error("Execution receipt append failed unexpectedly.");
        }

        await this.notifyProjectionChange(appendedReceipt);
        return appendedReceipt;
    }

    /**
     * Applies deterministic validity checks for chain.
     *
     * **Why it exists:**
     * Fails fast when chain is invalid so later control flow stays safe and predictable.
     *
     * **What it talks to:**
     * - Uses `hashSha256` (import `hashSha256`) from `./cryptoUtils`.
     * @returns Promise resolving to ExecutionReceiptVerificationResult.
     */
    async verifyChain(): Promise<ExecutionReceiptVerificationResult> {
        const document = await this.load();
        const mismatchIndices: number[] = [];

        let expectedPriorHash = "GENESIS";
        for (let index = 0; index < document.receipts.length; index += 1) {
            const receipt = document.receipts[index];
            const payload = toReceiptPayload({
                taskId: receipt.taskId,
                planTaskId: receipt.planTaskId,
                proposalId: receipt.proposalId,
                actionId: receipt.actionId,
                actionType: receipt.actionType,
                approved: receipt.approved,
                outputDigest: receipt.outputDigest,
                voteDigest: receipt.voteDigest,
                metadataDigest: receipt.metadataDigest,
                priorReceiptHash: receipt.priorReceiptHash
            });
            const expectedHash = hashSha256(payload);

            if (receipt.priorReceiptHash !== expectedPriorHash || receipt.receiptHash !== expectedHash) {
                mismatchIndices.push(index);
            }

            expectedPriorHash = receipt.receiptHash;
        }

        return {
            valid: mismatchIndices.length === 0,
            mismatchIndices
        };
    }

    /**
     * Persists approved action receipt sqlite with deterministic state semantics.
     *
     * **Why it exists:**
     * Centralizes approved action receipt sqlite mutations for auditability and replay.
     *
     * **What it talks to:**
     * - Uses `hashSha256` (import `hashSha256`) from `./cryptoUtils`.
     * - Uses `makeId` (import `makeId`) from `./ids`.
     * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
     *
     * @param input - Structured input object for this operation.
     * @returns Promise resolving to ExecutionReceipt.
     */
    private async appendApprovedActionReceiptSqlite(
        input: AppendExecutionReceiptInput
    ): Promise<ExecutionReceipt> {
        await this.ensureSqliteReady();
        const outputDigest = hashSha256((input.actionResult.output ?? "").trim());
        const voteDigest = buildVoteDigest(input.actionResult);
        const metadataDigest = buildMetadataDigest(input.actionResult);

        const receipt = await withSqliteDatabase(this.sqlitePath, async (db) => {
            this.ensureSqliteSchema(db);
            db.exec("BEGIN IMMEDIATE;");
            try {
                const prior = db
                    .prepare(
                        `SELECT receipt_hash
             FROM ${SQLITE_EXECUTION_RECEIPTS_TABLE}
             ORDER BY receipt_seq DESC
             LIMIT 1`
                    )
                    .get() as { receipt_hash?: string } | undefined;
                const priorReceiptHash =
                    typeof prior?.receipt_hash === "string" && prior.receipt_hash.trim()
                        ? prior.receipt_hash
                        : "GENESIS";

                const baseReceipt = {
                    taskId: input.taskId,
                    planTaskId: input.planTaskId,
                    proposalId: input.proposalId,
                    actionId: input.actionResult.action.id,
                    actionType: input.actionResult.action.type,
                    approved: input.actionResult.approved,
                    outputDigest,
                    voteDigest,
                    metadataDigest,
                    priorReceiptHash
                };
                const receiptHash = hashSha256(toReceiptPayload(baseReceipt));
                const receipt: ExecutionReceipt = {
                    id: makeId("execution_receipt"),
                    recordedAt: new Date().toISOString(),
                    ...baseReceipt,
                    receiptHash
                };

                db.prepare(
                    `INSERT INTO ${SQLITE_EXECUTION_RECEIPTS_TABLE} (
             id, recorded_at, task_id, plan_task_id, proposal_id, action_id, action_type,
             approved, output_digest, vote_digest, metadata_digest, prior_receipt_hash, receipt_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(
                    receipt.id,
                    receipt.recordedAt,
                    receipt.taskId,
                    receipt.planTaskId,
                    receipt.proposalId,
                    receipt.actionId,
                    receipt.actionType,
                    receipt.approved ? 1 : 0,
                    receipt.outputDigest,
                    receipt.voteDigest,
                    receipt.metadataDigest,
                    receipt.priorReceiptHash,
                    receipt.receiptHash
                );

                db.prepare(
                    `DELETE FROM ${SQLITE_EXECUTION_RECEIPTS_TABLE}
           WHERE receipt_seq NOT IN (
             SELECT receipt_seq
             FROM ${SQLITE_EXECUTION_RECEIPTS_TABLE}
             ORDER BY receipt_seq DESC
             LIMIT ?
           )`
                ).run(MAX_EXECUTION_RECEIPTS);

                db.exec("COMMIT;");
                return receipt;
            } catch (error) {
                db.exec("ROLLBACK;");
                throw error;
            }
        });

        if (this.exportJsonOnWrite) {
            await this.persistSqliteSnapshotToJson();
        }

        return receipt;
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
     * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
     * - Uses `DatabaseSync` (import `DatabaseSync`) from `node:sqlite`.
     *
     * @param db - Value for db.
     */
    private ensureSqliteSchema(db: DatabaseSync): void {
        db.exec(
            `CREATE TABLE IF NOT EXISTS ${SQLITE_EXECUTION_RECEIPTS_TABLE} (
         receipt_seq INTEGER PRIMARY KEY AUTOINCREMENT,
         id TEXT NOT NULL UNIQUE,
         recorded_at TEXT NOT NULL,
         task_id TEXT NOT NULL,
         plan_task_id TEXT NOT NULL,
         proposal_id TEXT,
         action_id TEXT NOT NULL,
         action_type TEXT NOT NULL,
         approved INTEGER NOT NULL,
         output_digest TEXT NOT NULL,
         vote_digest TEXT NOT NULL,
         metadata_digest TEXT NOT NULL,
         prior_receipt_hash TEXT NOT NULL,
         receipt_hash TEXT NOT NULL
       );`
        );
        if (!sqliteTableHasColumn(db, SQLITE_EXECUTION_RECEIPTS_TABLE, "metadata_digest")) {
            db.exec(
                `ALTER TABLE ${SQLITE_EXECUTION_RECEIPTS_TABLE}
         ADD COLUMN metadata_digest TEXT NOT NULL DEFAULT '${sha256HexFromCanonicalJson({})}';`
            );
        }
        db.exec(
            `CREATE INDEX IF NOT EXISTS idx_${SQLITE_EXECUTION_RECEIPTS_TABLE}_recorded_at
       ON ${SQLITE_EXECUTION_RECEIPTS_TABLE}(recorded_at);`
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
     * @returns Computed `ExecutionReceiptDocument` result.
     */
    private readSqliteDocument(db: DatabaseSync): ExecutionReceiptDocument {
        const rows = db
            .prepare(
                `SELECT id, recorded_at, task_id, plan_task_id, proposal_id, action_id, action_type,
                approved, output_digest, vote_digest, metadata_digest, prior_receipt_hash, receipt_hash
         FROM ${SQLITE_EXECUTION_RECEIPTS_TABLE}
         ORDER BY receipt_seq ASC`
            )
            .all();
        const validatedRows = parseSqliteExecutionReceiptRows(rows);
        return {
            receipts: validatedRows.map((row) => ({
                id: row.id,
                recordedAt: row.recorded_at,
                taskId: row.task_id,
                planTaskId: row.plan_task_id,
                proposalId: row.proposal_id,
                actionId: row.action_id,
                actionType: row.action_type,
                approved: Number(row.approved) === 1,
                outputDigest: row.output_digest,
                voteDigest: row.vote_digest,
                metadataDigest: row.metadata_digest,
                priorReceiptHash: row.prior_receipt_hash,
                receiptHash: row.receipt_hash
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
        if (document.receipts.length === 0) {
            return;
        }

        await withSqliteDatabase(this.sqlitePath, async (db) => {
            this.ensureSqliteSchema(db);
            const existing = db
                .prepare(
                    `SELECT COUNT(*) AS totalReceipts
           FROM ${SQLITE_EXECUTION_RECEIPTS_TABLE}`
                )
                .get() as { totalReceipts?: number } | undefined;
            if (Number(existing?.totalReceipts ?? 0) > 0) {
                return;
            }

            db.exec("BEGIN IMMEDIATE;");
            try {
                for (const receipt of document.receipts) {
                    db.prepare(
                        `INSERT OR IGNORE INTO ${SQLITE_EXECUTION_RECEIPTS_TABLE} (
               id, recorded_at, task_id, plan_task_id, proposal_id, action_id, action_type,
               approved, output_digest, vote_digest, metadata_digest, prior_receipt_hash, receipt_hash
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    ).run(
                        receipt.id,
                        receipt.recordedAt,
                        receipt.taskId,
                        receipt.planTaskId,
                        receipt.proposalId,
                        receipt.actionId,
                        receipt.actionType,
                        receipt.approved ? 1 : 0,
                        receipt.outputDigest,
                        receipt.voteDigest,
                        receipt.metadataDigest,
                        receipt.priorReceiptHash,
                        receipt.receiptHash
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

    /**
     * Emits one normalized projection change after an execution receipt append.
     *
     * **Why it exists:**
     * Receipt writes are a canonical audit seam for the mirror, and this helper keeps optional
     * projection fanout out of the receipt chain-building logic.
     *
     * **What it talks to:**
     * - Uses `buildProjectionChangeSet(...)` from `./projections/service`.
     *
     * @param receipt - Newly appended execution receipt.
     * @returns Promise resolving after the optional projection callback completes.
     */
    private async notifyProjectionChange(receipt: ExecutionReceipt): Promise<void> {
        if (!this.onChange) {
            return;
        }
        await this.onChange(buildProjectionChangeSet(
            ["execution_receipts_changed"],
            [`execution_receipt:${receipt.id}`],
            {
                receiptId: receipt.id,
                actionType: receipt.actionType
            }
        ));
    }

    /**
     * Reads json document from file needed for this execution step.
     *
     * **Why it exists:**
     * Separates json document from file read-path handling from orchestration and mutation code.
     *
     * **What it talks to:**
     * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
     * @returns Promise resolving to ExecutionReceiptDocument.
     */
    private async readJsonDocumentFromFile(): Promise<ExecutionReceiptDocument> {
        try {
            const raw = await readFile(this.filePath, "utf8");
            return coerceExecutionReceiptDocument(JSON.parse(raw));
        } catch {
            return { receipts: [] };
        }
    }
}
