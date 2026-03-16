/**
 * @fileoverview Tests deterministic conversation status and proposal-draft helper policies extracted from ConversationManager.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import {
  adjustProposalDraft,
  cancelProposalDraft,
  createProposalDraft,
  renderAgentPulseStatus,
  renderConversationStatus,
  renderConversationStatusDebug,
  renderProposalDraftStatus,
  resetAgentPulseRuntimeStatus
} from "../../src/interfaces/conversationDraftStatusPolicy";
import {
  ConversationJob,
  ConversationSession
} from "../../src/interfaces/sessionStore";

/**
 * Builds a deterministic baseline conversation session for helper tests.
 *
 * @returns Fresh session with default queue/draft/pulse state.
 */
function buildSession(): ConversationSession {
  return buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: "2026-03-03T00:00:00.000Z"
  });
}

/**
 * Builds a fully-typed conversation job record with optional overrides.
 *
 * @param id - Unique job identifier used in test assertions.
 * @param overrides - Optional per-test field overrides.
 * @returns Fully-typed conversation job.
 */
function buildJob(id: string, overrides: Partial<ConversationJob> = {}): ConversationJob {
  return {
    id,
    input: `input-${id}`,
    createdAt: "2026-03-03T00:00:00.000Z",
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

test("renderConversationStatus keeps default /status human-first while preserving work summary", () => {
  const session = buildSession();
  const running = buildJob("job-1", {
    status: "running",
    ackTimerGeneration: 4,
    ackEligibleAt: "2026-03-03T00:00:05.000Z",
    ackLifecycleState: "SENT",
    finalDeliveryOutcome: "not_attempted",
    finalDeliveryAttemptCount: 1
  });
  session.runningJobId = running.id;
  session.queuedJobs = [buildJob("job-2")];
  session.recentJobs = [
    running,
    buildJob("job-3", { status: "completed" })
  ];

  const rendered = renderConversationStatus(session);

  assert.match(rendered, /Current status: I'm working on a request right now\./);
  assert.match(rendered, /Working on: input-job-1/);
  assert.match(rendered, /Queue: 1 request waiting after the current run\./);
  assert.match(rendered, /Draft: none\./);
  assert.match(rendered, /Agent Pulse: off\./);
  assert.match(rendered, /Recent activity:/);
  assert.match(rendered, /- Completed: input-job-3/);
  assert.match(rendered, /run \/status debug/);
});

test("renderConversationStatusDebug preserves detailed ack and delivery metadata for troubleshooting", () => {
  const session = buildSession();
  const running = buildJob("job-1", {
    status: "running",
    ackTimerGeneration: 4,
    ackEligibleAt: "2026-03-03T00:00:05.000Z",
    ackLifecycleState: "SENT",
    finalDeliveryOutcome: "not_attempted",
    finalDeliveryAttemptCount: 1
  });
  session.runningJobId = running.id;
  session.queuedJobs = [buildJob("job-2")];
  session.recentJobs = [
    running,
    buildJob("job-3", { status: "completed" })
  ];

  const rendered = renderConversationStatusDebug(session);

  assert.match(rendered, /^Debug status:/);
  assert.match(rendered, /Running job: job-1/);
  assert.match(rendered, /Queued jobs: 1/);
  assert.match(rendered, /Running ack: state=SENT, generation=4/);
  assert.match(rendered, /Running final delivery: outcome=not_attempted, attempts=1/);
  assert.match(rendered, /Active draft: none/);
  assert.match(rendered, /Recent jobs:/);
  assert.match(rendered, /- job-1 \(running\)/);
});

test("renderAgentPulseStatus and resetAgentPulseRuntimeStatus keep pulse metadata deterministic", () => {
  const session = buildSession();
  session.agentPulse.optIn = true;
  session.agentPulse.mode = "public";
  session.agentPulse.routeStrategy = "current_conversation";
  session.agentPulse.lastDecisionCode = "DYNAMIC_SENT";
  session.agentPulse.lastEvaluatedAt = "2026-03-03T00:10:00.000Z";
  session.agentPulse.lastPulseSentAt = "2026-03-03T00:10:01.000Z";
  session.agentPulse.lastPulseReason = "contextual_followup";
  session.agentPulse.lastPulseTargetConversationId = "telegram:chat-1:user-1";
  session.agentPulse.lastContextualLexicalEvidence = {
    matchedRuleId: "contextual_followup_v1_candidate",
    rulepackVersion: "contextual_followup_v1",
    rulepackFingerprint: "fp-1",
    confidenceTier: "HIGH",
    confidence: 0.93,
    conflict: false,
    candidateTokens: ["project"],
    evaluatedAt: "2026-03-03T00:09:59.000Z"
  };

  const rendered = renderAgentPulseStatus(session);
  assert.match(rendered, /Agent Pulse: on/);
  assert.match(rendered, /Mode: public/);
  assert.match(rendered, /Route strategy: current_conversation/);
  assert.match(rendered, /Last decision: DYNAMIC_SENT/);
  assert.match(rendered, /Last target conversation:/);

  resetAgentPulseRuntimeStatus(session);
  assert.equal(session.agentPulse.lastDecisionCode, "NOT_EVALUATED");
  assert.equal(session.agentPulse.lastEvaluatedAt, null);
  assert.equal(session.agentPulse.lastPulseReason, null);
  assert.equal(session.agentPulse.lastPulseTargetConversationId, null);
  assert.equal(session.agentPulse.lastContextualLexicalEvidence, null);
});

test("proposal draft helpers create adjust render and cancel deterministic draft state", () => {
  const session = buildSession();
  const receivedAt = "2026-03-03T01:00:00.000Z";

  const createReply = createProposalDraft(
    session,
    "Schedule focused work blocks for next week",
    receivedAt,
    500
  );
  assert.match(createReply, /Draft .* created\./);
  assert.ok(session.activeProposal);
  assert.equal(session.activeProposal?.status, "pending");

  const adjustReply = adjustProposalDraft(
    session,
    "also include daily summary notes",
    "2026-03-03T01:01:00.000Z",
    500
  );
  assert.match(adjustReply, /updated/);
  assert.match(session.activeProposal?.currentInput ?? "", /Adjustment requested by user/);

  const draftStatus = renderProposalDraftStatus(session.activeProposal!);
  assert.match(draftStatus, /Draft .* \(pending\)/);
  assert.match(draftStatus, /Preview:/);

  const cancelReply = cancelProposalDraft(session, "2026-03-03T01:02:00.000Z");
  assert.match(cancelReply, /cancelled\./);
  assert.equal(session.activeProposal, null);
});

test("proposal draft helpers fail closed on missing active draft and oversize updates", () => {
  const session = buildSession();

  const noDraftAdjustReply = adjustProposalDraft(
    session,
    "add more detail",
    "2026-03-03T02:00:00.000Z",
    30
  );
  assert.equal(noDraftAdjustReply, "No active draft to adjust. Use /propose <task> first.");

  const tooLongCreateReply = createProposalDraft(
    session,
    "this proposal text is intentionally beyond the allowed size",
    "2026-03-03T02:00:00.000Z",
    10
  );
  assert.equal(tooLongCreateReply, "Proposal is too long. Limit is 10 characters.");
  assert.equal(session.activeProposal, null);
});
