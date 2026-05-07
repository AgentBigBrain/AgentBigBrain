/**
 * @fileoverview Covers Agent Pulse wording outcome metadata and bounded response binding.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  backfillPulseResponseOutcome,
  backfillPulseSnippet,
  buildPulseDeliveredTextPreview
} from "../../src/interfaces/pulseEmissionLifecycle";
import type { ConversationJob, ConversationSession } from "../../src/interfaces/sessionStore";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";

/**
 * Builds a minimal session with one typed pulse emission.
 */
function buildPulseSession(): ConversationSession {
  const nowIso = "2026-03-07T15:00:00.000Z";
  const session = {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-1",
      userId: "user-1",
      username: "agentowner",
      conversationVisibility: "private",
      receivedAt: nowIso
    }),
    conversationId: "telegram:chat-1:user-1",
    updatedAt: nowIso
  };

  session.agentPulse = {
    ...session.agentPulse,
    optIn: true,
    recentEmissions: [
      {
        emittedAt: nowIso,
        reasonCode: "OPEN_LOOP_RESUME",
        candidateEntityRefs: ["thread_budget"],
        pulseId: "pulse_1",
        candidateId: "candidate_1",
        questionIntent: "resume the budget thread",
        deliveryEnvelope: {
          pulseId: "pulse_1",
          candidateId: "candidate_1",
          reasonCode: "OPEN_LOOP_RESUME",
          inquiryType: "resume_open_loop",
          evidenceRefs: ["thread_budget"],
          sourceRecallRefs: ["source_record_1"],
          deliveryDecisionId: "decision_1",
          promptKind: "semantic_inquiry_pulse",
          createdAt: nowIso,
          allowedByPolicy: true,
          userVisibleDeliveryAllowed: true
        },
        outcomeRecord: {
          pulseId: "pulse_1",
          candidateId: "candidate_1",
          emittedAt: nowIso,
          deliveredTextHash: null,
          deliveredTextPreviewRedacted: null,
          responseOutcome: null,
          outcomeSource: "timeout"
        },
        responseOutcome: null,
        generatedSnippet: "resume_open_loop: resume the budget thread"
      }
    ]
  };

  return session;
}

/**
 * Builds a completed system job carrying final pulse wording.
 */
function buildCompletedPulseJob(resultSummary: string): ConversationJob {
  return {
    id: "job_1",
    input: "Agent Pulse",
    executionInput: "Agent Pulse",
    createdAt: "2026-03-07T15:00:00.000Z",
    startedAt: "2026-03-07T15:00:01.000Z",
    completedAt: "2026-03-07T15:00:02.000Z",
    status: "completed",
    resultSummary,
    errorMessage: null,
    isSystemJob: true,
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
    pauseRequestedAt: null
  };
}

test("pulse lifecycle stores delivered wording as hash and redacted preview", () => {
  const session = buildPulseSession();
  const deliveredText = [
    "Quick check-in: want to resume the budget thread?",
    "```",
    "Source Recall quoted evidence should not persist here.",
    "```"
  ].join("\n");

  backfillPulseSnippet(session, buildCompletedPulseJob(deliveredText));

  const emission = session.agentPulse.recentEmissions?.[0];
  assert.ok(emission?.outcomeRecord);
  assert.equal(emission.outcomeRecord.deliveredTextHash?.length, 64);
  assert.match(emission.outcomeRecord.deliveredTextPreviewRedacted ?? "", /\[quoted evidence redacted\]/);
  assert.doesNotMatch(
    emission.outcomeRecord.deliveredTextPreviewRedacted ?? "",
    /Source Recall quoted evidence should not persist/
  );
  assert.equal(emission.generatedSnippet, emission.outcomeRecord.deliveredTextPreviewRedacted?.slice(0, 120));
});

test("pulse lifecycle binds user replies to pulse outcome records without storing reply text", () => {
  const session = buildPulseSession();

  backfillPulseResponseOutcome(
    session,
    "That follow-up was not helpful.",
    Date.parse("2026-03-07T15:03:00.000Z"),
    "turn_user_1"
  );

  const emission = session.agentPulse.recentEmissions?.[0];
  assert.equal(emission?.responseOutcome, "negative");
  assert.equal(emission?.outcomeRecord?.responseOutcome, "negative");
  assert.equal(emission?.outcomeRecord?.outcomeSource, "explicit_user_reply");
  assert.equal(emission?.outcomeRecord?.boundUserTurnId, "turn_user_1");
  assert.deepEqual(
    Object.values(emission?.outcomeRecord ?? {}).some((value) => value === "That follow-up was not helpful."),
    false
  );
});

test("pulse delivered text preview redacts token-shaped values", () => {
  const preview = buildPulseDeliveredTextPreview(
    "Follow-up about abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN should not retain the full value."
  );

  assert.match(preview, /\[redacted\]/);
  assert.doesNotMatch(preview, /abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN/);
});
