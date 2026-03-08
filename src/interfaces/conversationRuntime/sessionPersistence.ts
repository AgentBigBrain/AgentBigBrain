/**
 * @fileoverview Canonical JSON and SQLite session persistence helpers for the interface layer.
 */

import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import { withFileLock, writeFileAtomic } from "../../core/fileLock";
import { withSqliteDatabase } from "../../core/sqliteStore";

import type {
  InterfaceSessionFile,
  NormalizeConversationSession,
  NormalizeInterfaceSessionState,
  SessionPersistenceContext,
  SqliteSessionRow
} from "./contracts";
import type { ConversationSession } from "../sessionStore";

const SQLITE_INTERFACE_SESSIONS_TABLE = "interface_sessions";

/**
 * Builds empty interface-session state for persistence paths.
 */
export function createEmptyInterfaceSessionFile(): InterfaceSessionFile {
  return {
    conversations: {}
  };
}

/**
 * Reads JSON-backed session state and normalizes it through the provided callback.
 */
export async function readJsonSessionState(
  statePath: string,
  normalizeState: NormalizeInterfaceSessionState
): Promise<InterfaceSessionFile> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(stripUtf8Bom(raw)) as Partial<InterfaceSessionFile>;
    return normalizeState(parsed);
  } catch {
    return createEmptyInterfaceSessionFile();
  }
}

/**
 * Persists JSON-backed session state atomically.
 */
export async function writeJsonSessionState(
  statePath: string,
  state: InterfaceSessionFile
): Promise<void> {
  await writeFileAtomic(statePath, JSON.stringify(state, null, 2));
}

/**
 * Initializes the SQLite interface-session backend and imports the JSON snapshot on first boot.
 */
export async function initializeSqliteSessionBackend(
  context: Pick<SessionPersistenceContext, "sqlitePath" | "statePath" | "normalizeState">
): Promise<void> {
  await withSqliteDatabase(context.sqlitePath, async (db) => {
    ensureSqliteSessionSchema(db);
  });

  await importJsonSnapshotIntoSqliteIfEmpty(context);
}

/**
 * Reads one normalized session from SQLite storage.
 */
export async function readSessionFromSqlite(
  sqlitePath: string,
  conversationId: string,
  normalizeSession: NormalizeConversationSession
): Promise<ConversationSession | null> {
  return withSqliteDatabase(sqlitePath, async (db) => {
    ensureSqliteSessionSchema(db);
    const row = db
      .prepare(
        `SELECT conversation_id, updated_at, session_json
         FROM ${SQLITE_INTERFACE_SESSIONS_TABLE}
         WHERE conversation_id = ?`
      )
      .get(conversationId);
    const validatedRow = parseOptionalSqliteSessionRow(row);
    if (!validatedRow) {
      return null;
    }
    return deserializeSqliteSessionRow(validatedRow, normalizeSession);
  });
}

/**
 * Writes one normalized session to SQLite storage and refreshes the JSON export when enabled.
 */
export async function writeSessionToSqlite(
  context: SessionPersistenceContext,
  session: ConversationSession
): Promise<void> {
  await withSqliteDatabase(context.sqlitePath, async (db) => {
    ensureSqliteSessionSchema(db);
    db.exec("BEGIN IMMEDIATE;");
    try {
      insertOrReplaceSqliteSession(db, session);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  });

  if (context.exportJsonOnWrite) {
    await persistSqliteSnapshotToJson(context);
  }
}

/**
 * Deletes one session from SQLite storage and refreshes the JSON export when enabled.
 */
export async function deleteSessionFromSqlite(
  context: SessionPersistenceContext,
  conversationId: string
): Promise<void> {
  await withSqliteDatabase(context.sqlitePath, async (db) => {
    ensureSqliteSessionSchema(db);
    db.prepare(
      `DELETE FROM ${SQLITE_INTERFACE_SESSIONS_TABLE}
       WHERE conversation_id = ?`
    ).run(conversationId);
  });

  if (context.exportJsonOnWrite) {
    await persistSqliteSnapshotToJson(context);
  }
}

/**
 * Reads all normalized sessions from SQLite storage.
 */
export async function listSessionsFromSqlite(
  sqlitePath: string,
  normalizeSession: NormalizeConversationSession
): Promise<ConversationSession[]> {
  return withSqliteDatabase(sqlitePath, async (db) => {
    ensureSqliteSessionSchema(db);
    const rows = db
      .prepare(
        `SELECT conversation_id, updated_at, session_json
         FROM ${SQLITE_INTERFACE_SESSIONS_TABLE}
         ORDER BY updated_at DESC, conversation_id ASC`
      )
      .all();
    const validatedRows = parseSqliteSessionRows(rows);

    const sessions: ConversationSession[] = [];
    for (const row of validatedRows) {
      const normalized = deserializeSqliteSessionRow(row, normalizeSession);
      if (normalized) {
        sessions.push(normalized);
      }
    }

    return sessions;
  });
}

/**
 * Strips a UTF-8 BOM prefix from persisted session JSON before parsing.
 */
function stripUtf8Bom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

/**
 * Validates one raw SQLite session row before it reaches normalization logic.
 */
function isSqliteSessionRow(value: unknown): value is SqliteSessionRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<SqliteSessionRow>;
  return (
    typeof candidate.conversation_id === "string" &&
    typeof candidate.updated_at === "string" &&
    typeof candidate.session_json === "string"
  );
}

/**
 * Validates and normalizes SQLite row arrays for interface-session reads.
 */
function parseSqliteSessionRows(rows: unknown): SqliteSessionRow[] {
  if (!Array.isArray(rows)) {
    throw new Error("Interface session sqlite query returned non-array rowset.");
  }

  const normalizedRows: SqliteSessionRow[] = [];
  for (const row of rows) {
    if (!isSqliteSessionRow(row)) {
      throw new Error("Interface session sqlite row failed shape validation.");
    }
    normalizedRows.push(row);
  }

  return normalizedRows;
}

/**
 * Validates an optional SQLite session row.
 */
function parseOptionalSqliteSessionRow(row: unknown): SqliteSessionRow | null {
  if (row === undefined || row === null) {
    return null;
  }
  if (!isSqliteSessionRow(row)) {
    throw new Error("Interface session sqlite row failed shape validation.");
  }
  return row;
}

/**
 * Ensures the interface-session SQLite schema exists before reads or writes.
 */
function ensureSqliteSessionSchema(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${SQLITE_INTERFACE_SESSIONS_TABLE} (
       conversation_id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       username TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       session_json TEXT NOT NULL
     );`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_${SQLITE_INTERFACE_SESSIONS_TABLE}_updated_at
     ON ${SQLITE_INTERFACE_SESSIONS_TABLE}(updated_at);`
  );
}

/**
 * Upserts one normalized session row inside an existing SQLite transaction.
 */
function insertOrReplaceSqliteSession(db: DatabaseSync, session: ConversationSession): void {
  db.prepare(
    `INSERT INTO ${SQLITE_INTERFACE_SESSIONS_TABLE} (
       conversation_id, user_id, username, updated_at, session_json
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id)
     DO UPDATE SET
       user_id = excluded.user_id,
       username = excluded.username,
       updated_at = excluded.updated_at,
       session_json = excluded.session_json`
  ).run(
    session.conversationId,
    session.userId,
    session.username,
    session.updatedAt,
    JSON.stringify(session)
  );
}

/**
 * Deserializes one SQLite row into the normalized conversation-session shape.
 */
function deserializeSqliteSessionRow(
  row: SqliteSessionRow,
  normalizeSession: NormalizeConversationSession
): ConversationSession | null {
  try {
    const parsed = JSON.parse(row.session_json) as Partial<ConversationSession>;
    return normalizeSession(parsed);
  } catch {
    return null;
  }
}

/**
 * Imports the JSON session snapshot into SQLite when the table is still empty.
 */
async function importJsonSnapshotIntoSqliteIfEmpty(
  context: Pick<SessionPersistenceContext, "sqlitePath" | "statePath" | "normalizeState">
): Promise<void> {
  const snapshot = await readJsonSessionState(context.statePath, context.normalizeState);
  const sessions = Object.values(snapshot.conversations);
  if (sessions.length === 0) {
    return;
  }

  await withSqliteDatabase(context.sqlitePath, async (db) => {
    ensureSqliteSessionSchema(db);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS totalSessions
         FROM ${SQLITE_INTERFACE_SESSIONS_TABLE}`
      )
      .get() as { totalSessions?: number } | undefined;
    if (Number(row?.totalSessions ?? 0) > 0) {
      return;
    }

    db.exec("BEGIN IMMEDIATE;");
    try {
      for (const session of sessions) {
        insertOrReplaceSqliteSession(db, session);
      }
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  });
}

/**
 * Reads the full normalized interface-session snapshot from SQLite storage.
 */
async function readStateFromSqlite(
  sqlitePath: string,
  normalizeSession: NormalizeConversationSession
): Promise<InterfaceSessionFile> {
  return withSqliteDatabase(sqlitePath, async (db) => {
    ensureSqliteSessionSchema(db);
    const rows = db
      .prepare(
        `SELECT conversation_id, updated_at, session_json
         FROM ${SQLITE_INTERFACE_SESSIONS_TABLE}
         ORDER BY updated_at DESC, conversation_id ASC`
      )
      .all();
    const validatedRows = parseSqliteSessionRows(rows);

    const conversations: Record<string, ConversationSession> = {};
    for (const row of validatedRows) {
      const normalized = deserializeSqliteSessionRow(row, normalizeSession);
      if (normalized) {
        conversations[normalized.conversationId] = normalized;
      }
    }

    return { conversations };
  });
}

/**
 * Persists a normalized SQLite snapshot back to the JSON export file.
 */
async function persistSqliteSnapshotToJson(
  context: Pick<SessionPersistenceContext, "sqlitePath" | "statePath" | "normalizeSession">
): Promise<void> {
  const snapshot = await readStateFromSqlite(context.sqlitePath, context.normalizeSession);

  await withFileLock(context.statePath, async () => {
    await writeJsonSessionState(context.statePath, snapshot);
  });
}