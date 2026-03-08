/**
 * @fileoverview Covers the canonical Agent Pulse session-selection and tick-scheduling helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  conversationBelongsToProvider,
  selectPulseTargetSession,
  shouldSkipSessionForPulse,
  sortByMostRecentSessionUpdate
} from "../../src/interfaces/conversationRuntime/pulseScheduling";
import type { ConversationSession } from "../../src/interfaces/sessionStore";

/**
 * Builds a minimal conversation session for pulse-scheduling tests.
 */
function buildSession(
  conversationId: string,
  overrides: Partial<ConversationSession> = {}
): ConversationSession {
  const nowIso = new Date().toISOString();
  return {
    conversationId,
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    updatedAt: nowIso,
    activeProposal: null,
    runningJobId: null,
    queuedJobs: [],
    recentJobs: [],
    conversationTurns: [],
    agentPulse: {
      optIn: true,
      mode: "private",
      routeStrategy: "last_private_used",
      lastPulseSentAt: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      lastDecisionCode: "NOT_EVALUATED",
      lastEvaluatedAt: null
    },
    ...overrides
  };
}

test("conversationBelongsToProvider matches only the active provider prefix", () => {
  assert.equal(conversationBelongsToProvider("telegram:chat-1:user-1", "telegram"), true);
  assert.equal(conversationBelongsToProvider("discord:chan-1:user-1", "telegram"), false);
});

test("shouldSkipSessionForPulse enforces opt-in, active work, and minimum gap", () => {
  assert.equal(
    shouldSkipSessionForPulse(
      buildSession("telegram:chat-1:user-1", {
        agentPulse: {
          optIn: false,
          mode: "private",
          routeStrategy: "last_private_used",
          lastPulseSentAt: null,
          lastPulseReason: null,
          lastPulseTargetConversationId: null,
          lastDecisionCode: "NOT_EVALUATED",
          lastEvaluatedAt: null
        }
      })
    ),
    true
  );

  assert.equal(
    shouldSkipSessionForPulse(
      buildSession("telegram:chat-1:user-1", {
        queuedJobs: [
          {
            id: "job-1",
            input: "queued",
            createdAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            status: "queued",
            resultSummary: null,
            errorMessage: null,
            ackTimerGeneration: 0,
            ackEligibleAt: null,
            ackLifecycleState: "PENDING",
            ackMessageId: null,
            ackSentAt: null,
            ackEditAttemptCount: 0,
            ackLastErrorCode: null,
            finalDeliveryOutcome: null,
            finalDeliveryAttemptCount: 0,
            finalDeliveryLastErrorCode: null,
            finalDeliveryLastAttemptAt: null
          }
        ]
      })
    ),
    true
  );

  assert.equal(
    shouldSkipSessionForPulse(
      buildSession("telegram:chat-1:user-1", {
        agentPulse: {
          optIn: true,
          mode: "private",
          routeStrategy: "last_private_used",
          lastPulseSentAt: new Date().toISOString(),
          lastPulseReason: null,
          lastPulseTargetConversationId: null,
          lastDecisionCode: "NOT_EVALUATED",
          lastEvaluatedAt: null
        }
      })
    ),
    true
  );

  assert.equal(shouldSkipSessionForPulse(buildSession("telegram:chat-1:user-1")), false);
});

test("selectPulseTargetSession prefers the newest private route and reports NO_PRIVATE_ROUTE", () => {
  const olderPrivate = buildSession("telegram:chat-private-old:user-1", {
    updatedAt: "2026-03-01T10:00:00.000Z"
  });
  const newerPrivate = buildSession("telegram:chat-private-new:user-1", {
    updatedAt: "2026-03-01T12:00:00.000Z"
  });
  const publicController = buildSession("telegram:chat-public:user-1", {
    conversationVisibility: "public",
    agentPulse: {
      optIn: true,
      mode: "private",
      routeStrategy: "last_private_used",
      lastPulseSentAt: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      lastDecisionCode: "NOT_EVALUATED",
      lastEvaluatedAt: null
    }
  });

  const selected = selectPulseTargetSession(publicController, [
    olderPrivate,
    newerPrivate,
    publicController
  ]);
  assert.equal(selected.targetSession?.conversationId, newerPrivate.conversationId);
  assert.equal(selected.suppressionCode, null);

  const denied = selectPulseTargetSession(publicController, [publicController]);
  assert.equal(denied.targetSession, null);
  assert.equal(denied.suppressionCode, "NO_PRIVATE_ROUTE");
});

test("sortByMostRecentSessionUpdate returns sessions newest first", () => {
  const ordered = sortByMostRecentSessionUpdate([
    buildSession("telegram:chat-1:user-1", { updatedAt: "2026-03-01T10:00:00.000Z" }),
    buildSession("telegram:chat-2:user-1", { updatedAt: "2026-03-01T12:00:00.000Z" }),
    buildSession("telegram:chat-3:user-1", { updatedAt: "2026-03-01T11:00:00.000Z" })
  ]);
  assert.deepEqual(
    ordered.map((session) => session.conversationId),
    ["telegram:chat-2:user-1", "telegram:chat-3:user-1", "telegram:chat-1:user-1"]
  );
});
