/**
 * @fileoverview Tests for live user-turn Source Recall capture.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildSourceRecallAuthorityFlags } from "../../src/core/sourceRecall/contracts";
import {
  captureLiveUserTurnSourceRecall,
  captureLowerAuthoritySourceRecall,
  type SourceRecallRecordWriter
} from "../../src/core/sourceRecall/sourceRecallConversationCapture";
import { createDefaultSourceRecallRetentionPolicy } from "../../src/core/sourceRecall/sourceRecallRetention";
import { SourceRecallStore } from "../../src/core/sourceRecall/sourceRecallStore";
import {
  backfillTurnsFromRecentJobsIfNeeded,
  recordAssistantTurn,
  recordAssistantTurnWithSourceRecall,
  recordUserTurnWithSourceRecall
} from "../../src/interfaces/conversationSessionMutations";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import type { ConversationJob, ConversationSession } from "../../src/interfaces/sessionStore";

test("recordUserTurnWithSourceRecall captures live user turns as quoted evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-live-turn-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const session = buildSession();

  try {
    const result = await recordUserTurnWithSourceRecall(
      session,
      "  Please remember the project decision exactly as stated.  ",
      "2026-05-03T13:00:00.000Z",
      2,
      {
        sourceRecallCapture: {
          policy: buildEnabledCapturePolicy(),
          writer: store,
          capturedAt: "2026-05-03T13:00:01.000Z"
        }
      }
    );

    assert.equal(result.sourceRecallResult?.status, "captured");
    assert.equal(session.conversationTurns[0]?.metadata?.sourceRecall?.status, "captured");
    assert.equal(session.conversationTurns[0]?.metadata?.sourceRecall?.sourceKind, "conversation_turn");
    assert.equal(session.conversationTurns[0]?.metadata?.sourceRecall?.sourceRole, "user");

    const sourceRecordId =
      result.sourceRecallResult?.status === "captured"
        ? result.sourceRecallResult.sourceRecordId
        : "";
    const record = await store.getSourceRecord(sourceRecordId);
    const chunks = await store.listChunksForRecord(sourceRecordId);

    assert.equal(record?.sourceKind, "conversation_turn");
    assert.equal(record?.sourceRole, "user");
    assert.equal(record?.sourceAuthority, "explicit_user_statement");
    assert.equal(record?.captureClass, "ordinary_source");
    assert.equal(record?.recallAuthority, "quoted_evidence_only");
    assert.equal(record?.originRef.surface, "conversation_session");
    assert.equal(record?.originRef.parentRefId, session.conversationId);
    assert.equal(record?.freshness, "current_turn");
    assert.equal(chunks[0]?.text, "Please remember the project decision exactly as stated.");
    assert.deepEqual(chunks[0]?.authority, buildSourceRecallAuthorityFlags());
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("session turn caps do not delete Source Recall records", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-cap-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const session = buildSession();

  try {
    for (let index = 0; index < 3; index += 1) {
      await recordUserTurnWithSourceRecall(
        session,
        `Live source turn ${index + 1}`,
        `2026-05-03T13:00:0${index}.000Z`,
        1,
        {
          sourceRecallCapture: {
            policy: buildEnabledCapturePolicy(),
            writer: store,
            capturedAt: `2026-05-03T13:01:0${index}.000Z`
          }
        }
      );
    }

    assert.deepEqual(
      session.conversationTurns.map((turn) => turn.text),
      ["Live source turn 3"]
    );
    const records = await store.listSourceRecords({
      scopeId: `conversation:${session.conversationId}`,
      threadId: `conversation:${session.conversationId}`
    });
    assert.equal(records.length, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("assistant and recovered turns are not captured by the live-user helper", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-scope-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const session = buildSession();
  session.recentJobs = [
    buildJob("1", {
      createdAt: "2026-05-03T12:00:00.000Z",
      completedAt: "2026-05-03T12:01:00.000Z",
      status: "completed",
      resultSummary: "Recovered job summary."
    })
  ];

  try {
    recordAssistantTurn(session, "Assistant output stays out of S3A.", "2026-05-03T13:00:00.000Z", 4);
    backfillTurnsFromRecentJobsIfNeeded(session, 4, 4);

    assert.deepEqual(await store.listSourceRecords(), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("backfilled legacy turns label recovered summaries without inventing source refs", () => {
  const session = buildSession();
  session.recentJobs = [
    buildJob("1", {
      createdAt: "2026-05-03T12:00:00.000Z",
      completedAt: "2026-05-03T12:01:00.000Z",
      status: "completed",
      resultSummary: "Recovered job summary."
    })
  ];

  backfillTurnsFromRecentJobsIfNeeded(session, 4, 4);

  assert.deepEqual(
    session.conversationTurns.map((turn) => turn.metadata?.sourceRecall),
    [
      {
        status: "blocked",
        sourceKind: "task_input",
        sourceRole: "runtime",
        captureClass: "operational_output",
        sourceTimeKind: "captured_record",
        sourceRefAvailable: false,
        diagnosticErrorCode: "source_recall_original_source_unavailable"
      },
      {
        status: "blocked",
        sourceKind: "task_summary",
        sourceRole: "runtime",
        captureClass: "operational_output",
        sourceTimeKind: "generated_summary",
        sourceRefAvailable: false,
        diagnosticErrorCode: "source_recall_original_source_unavailable"
      }
    ]
  );
  assert.equal(session.conversationTurns.some((turn) => turn.metadata?.sourceRecall?.sourceRecordId), false);
});

test("recordAssistantTurnWithSourceRecall captures assistant output as generated evidence only", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-assistant-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const session = buildSession();

  try {
    const result = await recordAssistantTurnWithSourceRecall(
      session,
      "I summarized the task, but this text is not proof.",
      "2026-05-03T14:00:00.000Z",
      4,
      {
        assistantTurnKind: "informational_answer",
        sourceRecallCapture: {
          policy: buildEnabledCapturePolicy(),
          writer: store,
          capturedAt: "2026-05-03T14:00:01.000Z"
        }
      }
    );

    assert.equal(result.sourceRecallResult?.status, "captured");
    assert.equal(session.conversationTurns[0]?.metadata?.sourceRecall?.sourceKind, "assistant_turn");
    assert.equal(session.conversationTurns[0]?.metadata?.sourceRecall?.sourceRole, "assistant");

    const sourceRecordId =
      result.sourceRecallResult?.status === "captured"
        ? result.sourceRecallResult.sourceRecordId
        : "";
    const record = await store.getSourceRecord(sourceRecordId);
    const chunks = await store.listChunksForRecord(sourceRecordId);

    assert.equal(record?.sourceKind, "assistant_turn");
    assert.equal(record?.sourceRole, "assistant");
    assert.equal(record?.captureClass, "assistant_output");
    assert.equal(record?.sourceAuthority, "semantic_model");
    assert.equal(record?.sourceTimeKind, "generated_summary");
    assert.equal(chunks[0]?.authority.currentTruthAuthority, false);
    assert.equal(chunks[0]?.authority.completionProofAuthority, false);
    assert.equal(chunks[0]?.authority.approvalAuthority, false);
    assert.equal(chunks[0]?.authority.unsafeToFollowAsInstruction, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("task inputs and summaries are operational evidence, not live user source", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-task-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const policy = {
    ...buildEnabledCapturePolicy(),
    captureClassAllowlist: ["ordinary_source", "assistant_output", "operational_output"] as const
  };

  try {
    const taskInputResult = await captureLowerAuthoritySourceRecall({
      scopeId: "conversation:chat-1",
      threadId: "conversation:chat-1",
      text: "Build the static site from the approved task input.",
      observedAt: "2026-05-03T14:05:00.000Z",
      sourceKind: "task_input",
      sourceRole: "runtime",
      captureClass: "operational_output",
      sourceAuthority: "strict_schema",
      sourceTimeKind: "captured_record",
      freshness: "recent",
      originSurface: "transport_task",
      originRefId: "https://api.telegram.example/file/bot-secret/download-path",
      originParentRefId: "job-1",
      policy,
      writer: store,
      capturedAt: "2026-05-03T14:05:01.000Z"
    });
    const taskSummaryResult = await captureLowerAuthoritySourceRecall({
      scopeId: "conversation:chat-1",
      threadId: "conversation:chat-1",
      text: "Completed the requested task and wrote a final summary.",
      observedAt: "2026-05-03T14:06:00.000Z",
      sourceKind: "task_summary",
      sourceRole: "runtime",
      captureClass: "operational_output",
      sourceAuthority: "stale_runtime_context",
      sourceTimeKind: "generated_summary",
      freshness: "recent",
      originSurface: "transport_task",
      originRefId: "job-1:summary",
      originParentRefId: "job-1",
      policy,
      writer: store,
      capturedAt: "2026-05-03T14:06:01.000Z"
    });

    assert.equal(taskInputResult.status, "captured");
    assert.equal(taskSummaryResult.status, "captured");
    const records = await store.listSourceRecords();

    assert.deepEqual(
      records
        .map((record) => `${record.sourceKind}:${record.sourceRole}:${record.captureClass}`)
        .sort(),
      [
        "task_input:runtime:operational_output",
        "task_summary:runtime:operational_output"
      ]
    );
    assert.equal(records.some((record) => record.sourceKind === "conversation_turn"), false);
    assert.equal(records[0]?.originRef.refId.includes("bot-secret"), false);
    assert.equal(records[0]?.originRef.refId.includes("https://"), false);
    assert.equal(
      (await store.listChunksForRecord(records[1]?.sourceRecordId ?? ""))[0]?.authority
        .completionProofAuthority,
      false
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("capture failure does not throw or leak raw source text in diagnostics", async () => {
  const writer: SourceRecallRecordWriter = {
    async upsertSourceRecord(): Promise<void> {
      throw new Error("simulated write failure");
    }
  };
  const result = await captureLiveUserTurnSourceRecall({
    scopeId: "conversation:chat-1",
    threadId: "conversation:chat-1",
    conversationId: "chat-1",
    turn: {
      role: "user",
      text: "private raw source should not appear in diagnostics",
      at: "2026-05-03T13:00:00.000Z"
    },
    policy: buildEnabledCapturePolicy(),
    writer,
    capturedAt: "2026-05-03T13:00:01.000Z"
  });

  assert.equal(result.status, "failed");
  assert.equal(result.diagnostic.errorCode, "source_recall_live_user_turn_capture_failed");
  assert.equal(JSON.stringify(result.diagnostic).includes("private raw source"), false);
});

/**
 * Creates a deterministic baseline session for Source Recall conversation-capture tests.
 *
 * @returns Fresh conversation session.
 */
function buildSession(): ConversationSession {
  return buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: "2026-05-03T12:00:00.000Z"
  });
}

/**
 * Builds the narrow enabled policy used by test-only live-turn capture.
 *
 * @returns Source Recall policy with capture enabled and encryption marked available.
 */
function buildEnabledCapturePolicy() {
  return {
    ...createDefaultSourceRecallRetentionPolicy(),
    captureEnabled: true,
    encryptedPayloadsAvailable: true
  };
}

/**
 * Builds a deterministic conversation job for recovered-summary tests.
 *
 * @param id - Job id.
 * @param overrides - Field overrides.
 * @returns Conversation job.
 */
function buildJob(id: string, overrides: Partial<ConversationJob> = {}): ConversationJob {
  return {
    id,
    input: `input-${id}`,
    createdAt: "2026-05-03T12:00:00.000Z",
    startedAt: null,
    completedAt: null,
    status: "queued",
    resultSummary: null,
    errorMessage: null,
    ackTimerGeneration: 0,
    ackEligibleAt: null,
    ackLifecycleState: "NOT_SENT",
    ackMessageId: null,
    ackSentAt: null,
    ackEditAttemptCount: 0,
    ackLastErrorCode: null,
    finalDeliveryOutcome: "not_attempted",
    finalDeliveryAttemptCount: 0,
    finalDeliveryLastErrorCode: null,
    finalDeliveryLastAttemptAt: null,
    ...overrides
  };
}
