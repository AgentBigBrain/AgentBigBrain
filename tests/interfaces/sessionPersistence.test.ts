/**
 * @fileoverview Tests canonical conversation-runtime session persistence helpers.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createEmptyInterfaceSessionFile,
  deleteSessionFromSqlite,
  initializeSqliteSessionBackend,
  listSessionsFromSqlite,
  readJsonSessionState,
  writeJsonSessionState,
  writeSessionToSqlite
} from "../../src/interfaces/conversationRuntime/sessionPersistence";
import type {
  InterfaceSessionFile,
  SessionPersistenceContext
} from "../../src/interfaces/conversationRuntime/contracts";
import type { ConversationSession } from "../../src/interfaces/sessionStore";

function buildSessionFixture(overrides: Partial<ConversationSession> = {}): ConversationSession {
  const now = new Date().toISOString();
  return {
    conversationId: "telegram:chat-1:user-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    updatedAt: now,
    activeProposal: null,
    runningJobId: null,
    queuedJobs: [],
    recentJobs: [],
    conversationTurns: [
      {
        role: "user",
        text: "hello",
        at: now
      }
    ],
    classifierEvents: [],
    agentPulse: {
      optIn: false,
      mode: "private",
      routeStrategy: "last_private_used",
      lastPulseSentAt: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      lastDecisionCode: "NOT_EVALUATED",
      lastEvaluatedAt: null,
      recentEmissions: []
    },
    ...overrides
  };
}

function normalizeSession(raw: Partial<ConversationSession>): ConversationSession | null {
  if (
    typeof raw.conversationId !== "string" ||
    typeof raw.userId !== "string" ||
    typeof raw.username !== "string" ||
    typeof raw.updatedAt !== "string" ||
    !Array.isArray(raw.queuedJobs) ||
    !Array.isArray(raw.recentJobs) ||
    !Array.isArray(raw.conversationTurns) ||
    !raw.agentPulse ||
    typeof raw.agentPulse !== "object"
  ) {
    return null;
  }

  return raw as ConversationSession;
}

function normalizeState(raw: Partial<InterfaceSessionFile>): InterfaceSessionFile {
  if (!raw.conversations || typeof raw.conversations !== "object") {
    return createEmptyInterfaceSessionFile();
  }

  const conversations: Record<string, ConversationSession> = {};
  for (const [key, value] of Object.entries(raw.conversations)) {
    const normalized = normalizeSession(value as Partial<ConversationSession>);
    if (normalized) {
      conversations[key] = normalized;
    }
  }

  return { conversations };
}

function buildPersistenceContext(tempDir: string): SessionPersistenceContext {
  return {
    statePath: path.join(tempDir, "sessions.json"),
    sqlitePath: path.join(tempDir, "sessions.sqlite"),
    exportJsonOnWrite: true,
    normalizeSession,
    normalizeState
  };
}

test("conversation runtime JSON persistence reads missing files as empty state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-runtime-json-"));

  try {
    const context = buildPersistenceContext(tempDir);
    const state = await readJsonSessionState(context.statePath, context.normalizeState);
    assert.deepEqual(state, createEmptyInterfaceSessionFile());

    const session = buildSessionFixture();
    await writeJsonSessionState(context.statePath, {
      conversations: {
        [session.conversationId]: session
      }
    });

    const reloaded = await readJsonSessionState(context.statePath, context.normalizeState);
    assert.deepEqual(Object.keys(reloaded.conversations), [session.conversationId]);
    assert.equal(reloaded.conversations[session.conversationId]?.username, "agentowner");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conversation runtime SQLite persistence imports JSON snapshots and exports updates", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-runtime-sqlite-"));

  try {
    const context = buildPersistenceContext(tempDir);
    const initialSession = buildSessionFixture();
    await writeJsonSessionState(context.statePath, {
      conversations: {
        [initialSession.conversationId]: initialSession
      }
    });

    await initializeSqliteSessionBackend(context);
    const importedSessions = await listSessionsFromSqlite(context.sqlitePath, context.normalizeSession);
    assert.equal(importedSessions.length, 1);
    assert.equal(importedSessions[0]?.conversationId, initialSession.conversationId);

    const updatedSession = buildSessionFixture({
      conversationId: initialSession.conversationId,
      updatedAt: new Date(Date.now() + 1000).toISOString(),
      activeProposal: {
        id: "proposal-1",
        originalInput: "watch email",
        currentInput: "watch email hourly",
        createdAt: initialSession.updatedAt,
        updatedAt: new Date(Date.now() + 1000).toISOString(),
        status: "pending"
      }
    });
    await writeSessionToSqlite(context, updatedSession);

    const exportedRaw = JSON.parse(await readFile(context.statePath, "utf8")) as InterfaceSessionFile;
    assert.equal(
      exportedRaw.conversations[initialSession.conversationId]?.activeProposal?.currentInput,
      "watch email hourly"
    );

    await deleteSessionFromSqlite(context, initialSession.conversationId);
    const emptiedState = await readJsonSessionState(context.statePath, context.normalizeState);
    assert.deepEqual(emptiedState, createEmptyInterfaceSessionFile());
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});