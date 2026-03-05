/**
 * @fileoverview Judgment pattern learning store with confidence calibration, outcome signals, and dual JSON/SQLite backends.
 */

import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import { LedgerBackend } from "./config";
import { hashSha256, clampConfidence, toIso } from "./cryptoUtils";
import { withFileLock, writeFileAtomic } from "./fileLock";
import { makeId } from "./ids";
import { withSqliteDatabase } from "./sqliteStore";
import { TaskRunResult } from "./types";

const MAX_JUDGMENT_PATTERNS = 2_000;
const SQLITE_JUDGMENT_PATTERNS_TABLE = "judgment_patterns";

export type JudgmentSignalType = "objective" | "human_feedback" | "delayed";
export type JudgmentRiskPosture = "conservative" | "balanced" | "aggressive";
export type JudgmentPatternStatus = "active" | "superseded";

export interface JudgmentOutcomeSignal {
    id: string;
    signalType: JudgmentSignalType;
    score: number;
    recordedAt: string;
}

export interface JudgmentPattern {
    id: string;
    sourceTaskId: string;
    contextFingerprint: string;
    optionsFingerprint: string;
    choiceFingerprint: string;
    rationaleFingerprint: string;
    riskPosture: JudgmentRiskPosture;
    confidence: number;
    status: JudgmentPatternStatus;
    createdAt: string;
    lastUpdatedAt: string;
    supersededAt: string | null;
    outcomeHistory: readonly JudgmentOutcomeSignal[];
}

interface JudgmentPatternDocument {
    patterns: JudgmentPattern[];
}

interface JudgmentPatternStoreOptions {
    backend?: LedgerBackend;
    sqlitePath?: string;
    exportJsonOnWrite?: boolean;
}

interface SqliteJudgmentPatternRow {
    pattern_json: string;
}

export interface RecordJudgmentPatternInput {
    sourceTaskId: string;
    context: string;
    options: string;
    choice: string;
    rationale: string;
    riskPosture: JudgmentRiskPosture;
}

export interface JudgmentCalibrationResult {
    pattern: JudgmentPattern;
    previousConfidence: number;
    newConfidence: number;
}

/**
 * Clamps a score to the [-1, 1] range with 4 decimal precision.
 */
function toSignalScore(score: number): number {
    if (!Number.isFinite(score)) {
        return 0;
    }
    return Number(Math.max(-1, Math.min(1, score)).toFixed(4));
}

/**
 * Returns the weight multiplier for a given signal type.
 */
function scoreWeightForSignalType(signalType: JudgmentSignalType): number {
    if (signalType === "objective") {
        return 0.5;
    }
    if (signalType === "human_feedback") {
        return 0.3;
    }
    return 0.2;
}

/**
 * Applies an outcome signal to a pattern, returning the calibrated result.
 */
function applyOutcomeSignalToPattern(
    pattern: JudgmentPattern,
    signalType: JudgmentSignalType,
    score: number,
    recordedAt?: string
): JudgmentCalibrationResult {
    const normalizedScore = toSignalScore(score);
    const signal: JudgmentOutcomeSignal = {
        id: makeId("judgment_signal"),
        signalType,
        score: normalizedScore,
        recordedAt: toIso(recordedAt)
    };

    const previousConfidence = pattern.confidence;
    const delta = scoreWeightForSignalType(signalType) * normalizedScore * 0.25;
    const newConfidence = clampConfidence(previousConfidence + delta);
    const updatedPattern: JudgmentPattern = {
        ...pattern,
        confidence: newConfidence,
        lastUpdatedAt: signal.recordedAt,
        outcomeHistory: [...pattern.outcomeHistory, signal]
    };

    return {
        pattern: updatedPattern,
        previousConfidence,
        newConfidence
    };
}

/**
 * Marks a judgment pattern as superseded with capped confidence.
 */
function supersedeJudgmentPattern(
    pattern: JudgmentPattern,
    supersededAt?: string
): JudgmentPattern {
    const timestamp = toIso(supersededAt);
    return {
        ...pattern,
        status: "superseded",
        supersededAt: timestamp,
        lastUpdatedAt: timestamp,
        confidence: clampConfidence(Math.min(pattern.confidence, 0.3))
    };
}

/**
 * Coerces unknown input into a valid JudgmentPatternDocument.
 */
function coerceJudgmentPatternDocument(input: unknown): JudgmentPatternDocument {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return { patterns: [] };
    }

    const record = input as { patterns?: unknown };
    if (!Array.isArray(record.patterns)) {
        return { patterns: [] };
    }

    const patterns = record.patterns
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .map((item) => {
            const raw = item as Partial<JudgmentPattern>;
            const outcomeHistory = Array.isArray(raw.outcomeHistory)
                ? raw.outcomeHistory
                    .filter((signal) => signal && typeof signal === "object")
                    .map((signal) => {
                        const rawSignal = signal as Partial<JudgmentOutcomeSignal>;
                        const signalType: JudgmentSignalType =
                            rawSignal.signalType === "objective" ||
                                rawSignal.signalType === "human_feedback" ||
                                rawSignal.signalType === "delayed"
                                ? rawSignal.signalType
                                : "objective";
                        return {
                            id:
                                typeof rawSignal.id === "string" && rawSignal.id.trim()
                                    ? rawSignal.id
                                    : makeId("judgment_signal"),
                            signalType,
                            score: toSignalScore(typeof rawSignal.score === "number" ? rawSignal.score : 0),
                            recordedAt:
                                typeof rawSignal.recordedAt === "string" && rawSignal.recordedAt.trim()
                                    ? rawSignal.recordedAt
                                    : new Date().toISOString()
                        } satisfies JudgmentOutcomeSignal;
                    })
                : [];

            return {
                id: typeof raw.id === "string" && raw.id.trim() ? raw.id : makeId("judgment_pattern"),
                sourceTaskId:
                    typeof raw.sourceTaskId === "string" && raw.sourceTaskId.trim()
                        ? raw.sourceTaskId
                        : "unknown_task",
                contextFingerprint:
                    typeof raw.contextFingerprint === "string" && raw.contextFingerprint.trim()
                        ? raw.contextFingerprint
                        : hashSha256(""),
                optionsFingerprint:
                    typeof raw.optionsFingerprint === "string" && raw.optionsFingerprint.trim()
                        ? raw.optionsFingerprint
                        : hashSha256(""),
                choiceFingerprint:
                    typeof raw.choiceFingerprint === "string" && raw.choiceFingerprint.trim()
                        ? raw.choiceFingerprint
                        : hashSha256(""),
                rationaleFingerprint:
                    typeof raw.rationaleFingerprint === "string" && raw.rationaleFingerprint.trim()
                        ? raw.rationaleFingerprint
                        : hashSha256(""),
                riskPosture:
                    raw.riskPosture === "conservative" ||
                        raw.riskPosture === "balanced" ||
                        raw.riskPosture === "aggressive"
                        ? raw.riskPosture
                        : "balanced",
                confidence: clampConfidence(typeof raw.confidence === "number" ? raw.confidence : 0.5),
                status: raw.status === "superseded" ? "superseded" : "active",
                createdAt:
                    typeof raw.createdAt === "string" && raw.createdAt.trim()
                        ? raw.createdAt
                        : new Date().toISOString(),
                lastUpdatedAt:
                    typeof raw.lastUpdatedAt === "string" && raw.lastUpdatedAt.trim()
                        ? raw.lastUpdatedAt
                        : new Date().toISOString(),
                supersededAt:
                    typeof raw.supersededAt === "string" && raw.supersededAt.trim() ? raw.supersededAt : null,
                outcomeHistory
            } satisfies JudgmentPattern;
        });

    return { patterns };
}

/**
 * Validates a raw sqlite row shape for judgment-pattern reads.
 */
function isSqliteJudgmentPatternRow(value: unknown): value is SqliteJudgmentPatternRow {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Partial<SqliteJudgmentPatternRow>;
    return typeof candidate.pattern_json === "string";
}

/**
 * Validates and normalizes sqlite judgment-pattern row arrays.
 */
function parseSqliteJudgmentPatternRows(rows: unknown): SqliteJudgmentPatternRow[] {
    if (!Array.isArray(rows)) {
        throw new Error("Judgment sqlite query returned non-array rowset.");
    }

    const normalizedRows: SqliteJudgmentPatternRow[] = [];
    for (const row of rows) {
        if (!isSqliteJudgmentPatternRow(row)) {
            throw new Error("Judgment sqlite row failed shape validation.");
        }
        normalizedRows.push(row);
    }

    return normalizedRows;
}

export class JudgmentPatternStore {
    private sqliteReady = false;
    private readonly backend: LedgerBackend;
    private readonly sqlitePath: string;
    private readonly exportJsonOnWrite: boolean;

    /**
     * Initializes `JudgmentPatternStore` with deterministic runtime dependencies.
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
        private readonly filePath = "runtime/judgment_patterns.json",
        options: JudgmentPatternStoreOptions = {}
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
     * @returns Promise resolving to JudgmentPatternDocument.
     */
    async load(): Promise<JudgmentPatternDocument> {
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
     * @returns Promise resolving to JudgmentPatternDocument.
     */
    private async readJsonDocumentFromFile(): Promise<JudgmentPatternDocument> {
        try {
            const raw = await readFile(this.filePath, "utf8");
            return coerceJudgmentPatternDocument(JSON.parse(raw));
        } catch {
            return { patterns: [] };
        }
    }

    /**
     * Persists pattern with deterministic state semantics.
     *
     * **Why it exists:**
     * Centralizes pattern mutations for auditability and replay.
     *
     * **What it talks to:**
     * - Uses `hashSha256` (import `hashSha256`) from `./cryptoUtils`.
     * - Uses `withFileLock` (import `withFileLock`) from `./fileLock`.
     * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `./fileLock`.
     * - Uses `makeId` (import `makeId`) from `./ids`.
     *
     * @param input - Structured input object for this operation.
     * @returns Promise resolving to JudgmentPattern.
     */
    async recordPattern(input: RecordJudgmentPatternInput): Promise<JudgmentPattern> {
        const createdAt = new Date().toISOString();
        const pattern: JudgmentPattern = {
            id: makeId("judgment_pattern"),
            sourceTaskId: input.sourceTaskId,
            contextFingerprint: hashSha256(input.context.trim()),
            optionsFingerprint: hashSha256(input.options.trim()),
            choiceFingerprint: hashSha256(input.choice.trim()),
            rationaleFingerprint: hashSha256(input.rationale.trim()),
            riskPosture: input.riskPosture,
            confidence: 0.5,
            status: "active",
            createdAt,
            lastUpdatedAt: createdAt,
            supersededAt: null,
            outcomeHistory: []
        };

        if (this.backend === "sqlite") {
            await this.recordPatternSqlite(pattern);
            return pattern;
        }

        await withFileLock(this.filePath, async () => {
            const document = await this.load();
            document.patterns.push(pattern);
            if (document.patterns.length > MAX_JUDGMENT_PATTERNS) {
                document.patterns = document.patterns.slice(-MAX_JUDGMENT_PATTERNS);
            }
            await writeFileAtomic(this.filePath, JSON.stringify(document, null, 2));
        });

        return pattern;
    }

    /**
     * Persists pattern sqlite with deterministic state semantics.
     *
     * **Why it exists:**
     * Centralizes pattern sqlite mutations for auditability and replay.
     *
     * **What it talks to:**
     * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
     *
     * @param pattern - Value for pattern.
     * @returns Promise resolving to void.
     */
    private async recordPatternSqlite(pattern: JudgmentPattern): Promise<void> {
        await this.ensureSqliteReady();
        await withSqliteDatabase(this.sqlitePath, async (db) => {
            this.ensureSqliteSchema(db);
            db.exec("BEGIN IMMEDIATE;");
            try {
                db.prepare(
                    `INSERT INTO ${SQLITE_JUDGMENT_PATTERNS_TABLE} (
             id, source_task_id, last_updated_at, pattern_json
           ) VALUES (?, ?, ?, ?)`
                ).run(
                    pattern.id,
                    pattern.sourceTaskId,
                    pattern.lastUpdatedAt,
                    JSON.stringify(pattern)
                );
                db.prepare(
                    `DELETE FROM ${SQLITE_JUDGMENT_PATTERNS_TABLE}
           WHERE pattern_seq NOT IN (
             SELECT pattern_seq
             FROM ${SQLITE_JUDGMENT_PATTERNS_TABLE}
             ORDER BY pattern_seq DESC
             LIMIT ?
           )`
                ).run(MAX_JUDGMENT_PATTERNS);
                db.exec("COMMIT;");
            } catch (error) {
                db.exec("ROLLBACK;");
                throw error;
            }
        });

        if (this.exportJsonOnWrite) {
            await this.persistSqliteSnapshotToJson();
        }
    }

    /**
     * Executes outcome signal as part of this module's control flow.
     *
     * **Why it exists:**
     * Isolates the outcome signal runtime step so higher-level orchestration stays readable.
     *
     * **What it talks to:**
     * - Uses `withFileLock` (import `withFileLock`) from `./fileLock`.
     * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `./fileLock`.
     *
     * @param patternId - Stable identifier used to reference an entity or record.
     * @param signalType - Value for signal type.
     * @param score - Value for score.
     * @param recordedAt - Timestamp used for ordering, timeout, or recency decisions.
     * @returns Promise resolving to JudgmentCalibrationResult.
     */
    async applyOutcomeSignal(
        patternId: string,
        signalType: JudgmentSignalType,
        score: number,
        recordedAt?: string
    ): Promise<JudgmentCalibrationResult> {
        if (this.backend === "sqlite") {
            return this.applyOutcomeSignalSqlite(patternId, signalType, score, recordedAt);
        }

        let result: JudgmentCalibrationResult | null = null;

        await withFileLock(this.filePath, async () => {
            const document = await this.load();
            const index = document.patterns.findIndex((pattern) => pattern.id === patternId);
            if (index === -1) {
                throw new Error(`Judgment pattern ${patternId} not found.`);
            }

            const current = document.patterns[index];
            const calibration = applyOutcomeSignalToPattern(current, signalType, score, recordedAt);
            const updatedPattern = calibration.pattern;

            document.patterns[index] = updatedPattern;
            await writeFileAtomic(this.filePath, JSON.stringify(document, null, 2));
            result = calibration;
        });

        if (!result) {
            throw new Error("Judgment outcome signal application failed unexpectedly.");
        }

        return result;
    }

    /**
     * Executes outcome signal sqlite as part of this module's control flow.
     *
     * **Why it exists:**
     * Isolates the outcome signal sqlite runtime step so higher-level orchestration stays readable.
     *
     * **What it talks to:**
     * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
     *
     * @param patternId - Stable identifier used to reference an entity or record.
     * @param signalType - Value for signal type.
     * @param score - Value for score.
     * @param recordedAt - Timestamp used for ordering, timeout, or recency decisions.
     * @returns Promise resolving to JudgmentCalibrationResult.
     */
    private async applyOutcomeSignalSqlite(
        patternId: string,
        signalType: JudgmentSignalType,
        score: number,
        recordedAt?: string
    ): Promise<JudgmentCalibrationResult> {
        await this.ensureSqliteReady();
        const result = await withSqliteDatabase(this.sqlitePath, async (db) => {
            this.ensureSqliteSchema(db);
            db.exec("BEGIN IMMEDIATE;");
            try {
                const row = db
                    .prepare(
                        `SELECT pattern_json
             FROM ${SQLITE_JUDGMENT_PATTERNS_TABLE}
             WHERE id = ?`
                    )
                    .get(patternId) as { pattern_json?: string } | undefined;
                if (!row || typeof row.pattern_json !== "string") {
                    throw new Error(`Judgment pattern ${patternId} not found.`);
                }

                const current = this.parseJudgmentPattern(row.pattern_json);
                if (!current) {
                    throw new Error(`Judgment pattern ${patternId} could not be parsed.`);
                }

                const calibration = applyOutcomeSignalToPattern(current, signalType, score, recordedAt);
                db.prepare(
                    `UPDATE ${SQLITE_JUDGMENT_PATTERNS_TABLE}
           SET last_updated_at = ?, pattern_json = ?
           WHERE id = ?`
                ).run(
                    calibration.pattern.lastUpdatedAt,
                    JSON.stringify(calibration.pattern),
                    patternId
                );
                db.exec("COMMIT;");
                return calibration;
            } catch (error) {
                db.exec("ROLLBACK;");
                throw error;
            }
        });

        if (this.exportJsonOnWrite) {
            await this.persistSqliteSnapshotToJson();
        }

        return result;
    }

    /**
     * Implements supersede pattern behavior used by `judgmentPatterns`.
     *
     * **Why it exists:**
     * Keeps `supersede pattern` behavior centralized so collaborating call sites stay consistent.
     *
     * **What it talks to:**
     * - Uses `withFileLock` (import `withFileLock`) from `./fileLock`.
     * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `./fileLock`.
     *
     * @param patternId - Stable identifier used to reference an entity or record.
     * @param supersededAt - Timestamp used for ordering, timeout, or recency decisions.
     * @returns Promise resolving to JudgmentPattern.
     */
    async supersedePattern(patternId: string, supersededAt?: string): Promise<JudgmentPattern> {
        if (this.backend === "sqlite") {
            return this.supersedePatternSqlite(patternId, supersededAt);
        }

        let updated: JudgmentPattern | null = null;

        await withFileLock(this.filePath, async () => {
            const document = await this.load();
            const index = document.patterns.findIndex((pattern) => pattern.id === patternId);
            if (index === -1) {
                throw new Error(`Judgment pattern ${patternId} not found.`);
            }

            const current = document.patterns[index];
            updated = supersedeJudgmentPattern(current, supersededAt);

            document.patterns[index] = updated;
            await writeFileAtomic(this.filePath, JSON.stringify(document, null, 2));
        });

        if (!updated) {
            throw new Error("Judgment supersession failed unexpectedly.");
        }

        return updated;
    }

    /**
     * Reads relevant judgment patterns needed for this execution step.
     *
     * **Why it exists:**
     * Separates relevant judgment patterns read-path handling from orchestration and mutation code.
     *
     * **What it talks to:**
     * - Uses `hashSha256` (import `hashSha256`) from `./cryptoUtils`.
     *
     * @param context - Value for context.
     * @param limit - Numeric bound, counter, or index used by this logic.
     * @returns Promise resolving to readonly JudgmentPattern[].
     */
    async getRelevantPatterns(context: string, limit = 3): Promise<readonly JudgmentPattern[]> {
        const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
        const contextFingerprint = hashSha256(context.trim());
        const document = await this.load();

        const ranked = document.patterns
            .filter((pattern) => pattern.status === "active")
            .map((pattern) => ({
                pattern,
                score:
                    (pattern.contextFingerprint === contextFingerprint ? 1 : 0) +
                    pattern.confidence
            }))
            .sort((left, right) => {
                if (left.score !== right.score) {
                    return right.score - left.score;
                }
                if (left.pattern.confidence !== right.pattern.confidence) {
                    return right.pattern.confidence - left.pattern.confidence;
                }
                if (left.pattern.lastUpdatedAt !== right.pattern.lastUpdatedAt) {
                    return right.pattern.lastUpdatedAt.localeCompare(left.pattern.lastUpdatedAt);
                }
                return left.pattern.id.localeCompare(right.pattern.id);
            });

        return ranked.slice(0, normalizedLimit).map((entry) => entry.pattern);
    }

    /**
     * Implements supersede pattern sqlite behavior used by `judgmentPatterns`.
     *
     * **Why it exists:**
     * Keeps `supersede pattern sqlite` behavior centralized so collaborating call sites stay consistent.
     *
     * **What it talks to:**
     * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `./sqliteStore`.
     *
     * @param patternId - Stable identifier used to reference an entity or record.
     * @param supersededAt - Timestamp used for ordering, timeout, or recency decisions.
     * @returns Promise resolving to JudgmentPattern.
     */
    private async supersedePatternSqlite(
        patternId: string,
        supersededAt?: string
    ): Promise<JudgmentPattern> {
        await this.ensureSqliteReady();
        const updated = await withSqliteDatabase(this.sqlitePath, async (db) => {
            this.ensureSqliteSchema(db);
            db.exec("BEGIN IMMEDIATE;");
            try {
                const row = db
                    .prepare(
                        `SELECT pattern_json
             FROM ${SQLITE_JUDGMENT_PATTERNS_TABLE}
             WHERE id = ?`
                    )
                    .get(patternId) as { pattern_json?: string } | undefined;
                if (!row || typeof row.pattern_json !== "string") {
                    throw new Error(`Judgment pattern ${patternId} not found.`);
                }

                const current = this.parseJudgmentPattern(row.pattern_json);
                if (!current) {
                    throw new Error(`Judgment pattern ${patternId} could not be parsed.`);
                }

                const next = supersedeJudgmentPattern(current, supersededAt);
                db.prepare(
                    `UPDATE ${SQLITE_JUDGMENT_PATTERNS_TABLE}
           SET last_updated_at = ?, pattern_json = ?
           WHERE id = ?`
                ).run(
                    next.lastUpdatedAt,
                    JSON.stringify(next),
                    patternId
                );
                db.exec("COMMIT;");
                return next;
            } catch (error) {
                db.exec("ROLLBACK;");
                throw error;
            }
        });

        if (this.exportJsonOnWrite) {
            await this.persistSqliteSnapshotToJson();
        }

        return updated;
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
            `CREATE TABLE IF NOT EXISTS ${SQLITE_JUDGMENT_PATTERNS_TABLE} (
         pattern_seq INTEGER PRIMARY KEY AUTOINCREMENT,
         id TEXT NOT NULL UNIQUE,
         source_task_id TEXT NOT NULL,
         last_updated_at TEXT NOT NULL,
         pattern_json TEXT NOT NULL
       );`
        );
        db.exec(
            `CREATE INDEX IF NOT EXISTS idx_${SQLITE_JUDGMENT_PATTERNS_TABLE}_last_updated_at
       ON ${SQLITE_JUDGMENT_PATTERNS_TABLE}(last_updated_at);`
        );
    }

    /**
     * Parses judgment pattern and validates expected structure.
     *
     * **Why it exists:**
     * Centralizes normalization rules for judgment pattern so call sites stay aligned.
     *
     * **What it talks to:**
     * - Uses local constants/helpers within this module.
     *
     * @param rawJson - Value for raw json.
     * @returns Computed `JudgmentPattern | null` result.
     */
    private parseJudgmentPattern(rawJson: string): JudgmentPattern | null {
        try {
            const raw = JSON.parse(rawJson) as unknown;
            const document = coerceJudgmentPatternDocument({ patterns: [raw] });
            return document.patterns[0] ?? null;
        } catch {
            return null;
        }
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
     * @returns Computed `JudgmentPatternDocument` result.
     */
    private readSqliteDocument(db: DatabaseSync): JudgmentPatternDocument {
        const rows = db
            .prepare(
                `SELECT pattern_json
         FROM ${SQLITE_JUDGMENT_PATTERNS_TABLE}
         ORDER BY pattern_seq ASC`
            )
            .all();
        const validatedRows = parseSqliteJudgmentPatternRows(rows);

        const parsedPatterns: unknown[] = [];
        for (const row of validatedRows) {
            try {
                parsedPatterns.push(JSON.parse(row.pattern_json));
            } catch {
                throw new Error("Judgment sqlite row contains invalid JSON.");
            }
        }

        return coerceJudgmentPatternDocument({ patterns: parsedPatterns });
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
        if (document.patterns.length === 0) {
            return;
        }

        await withSqliteDatabase(this.sqlitePath, async (db) => {
            this.ensureSqliteSchema(db);
            const existing = db
                .prepare(
                    `SELECT COUNT(*) AS totalPatterns
           FROM ${SQLITE_JUDGMENT_PATTERNS_TABLE}`
                )
                .get() as { totalPatterns?: number } | undefined;
            if (Number(existing?.totalPatterns ?? 0) > 0) {
                return;
            }

            db.exec("BEGIN IMMEDIATE;");
            try {
                for (const pattern of document.patterns) {
                    db.prepare(
                        `INSERT OR IGNORE INTO ${SQLITE_JUDGMENT_PATTERNS_TABLE} (
               id, source_task_id, last_updated_at, pattern_json
             ) VALUES (?, ?, ?, ?)`
                    ).run(
                        pattern.id,
                        pattern.sourceTaskId,
                        pattern.lastUpdatedAt,
                        JSON.stringify(pattern)
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
 * Derives a judgment pattern input from a completed task run result.
 */
export function deriveJudgmentPatternFromTaskRun(
    runResult: TaskRunResult,
    riskPosture: JudgmentRiskPosture = "balanced"
): RecordJudgmentPatternInput {
    const optionSummary = runResult.plan.actions.map((action) => `${action.type}:${action.description}`).join(" | ");
    const approvedChoices = runResult.actionResults
        .filter((result) => result.approved)
        .map((result) => `${result.action.type}:${result.action.id}`)
        .join(" | ");

    return {
        sourceTaskId: runResult.task.id,
        context: `${runResult.task.goal}\n${runResult.task.userInput}`,
        options: optionSummary,
        choice: approvedChoices || "no_approved_actions",
        rationale: runResult.summary,
        riskPosture
    };
}
