/**
 * @fileoverview Covers the canonical Agent Pulse session-selection and tick-scheduling helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEmptyConversationDomainContext } from "../../src/core/sessionContext";
import {
  conversationBelongsToProvider,
  selectPulseTargetSession,
  shouldSkipSessionForPulse,
  shouldSuppressPulseForSessionDomain,
  sortByMostRecentSessionUpdate
} from "../../src/interfaces/conversationRuntime/pulseScheduling";
import type { ConversationSession } from "../../src/interfaces/sessionStore";
import {
  buildConversationJobFixture,
  buildConversationSessionFixture
} from "../helpers/conversationFixtures";

/**
 * Builds a minimal conversation session for pulse-scheduling tests.
 */
function buildSession(
  conversationId: string,
  overrides: Partial<ConversationSession> = {}
): ConversationSession {
  const nowIso = new Date().toISOString();
  return buildConversationSessionFixture(
    {
      updatedAt: nowIso,
      agentPulse: {
        ...buildConversationSessionFixture().agentPulse,
        optIn: true
      },
      ...overrides
    },
    {
      conversationId,
      receivedAt: nowIso
    }
  );
}

function buildWorkflowDomainContext(conversationId: string): ConversationSession["domainContext"] {
  return {
    ...createEmptyConversationDomainContext(conversationId),
    dominantLane: "workflow",
    continuitySignals: {
      activeWorkspace: true,
      returnHandoff: false,
      modeContinuity: true
    },
    activeSince: "2026-03-01T12:00:00.000Z",
    lastUpdatedAt: "2026-03-01T12:00:00.000Z"
  };
}

test("conversationBelongsToProvider matches only the active provider prefix", () => {
  assert.equal(conversationBelongsToProvider("telegram:chat-1:user-1", "telegram"), true);
  assert.equal(conversationBelongsToProvider("discord:chan-1:user-1", "telegram"), false);
});

test("shouldSkipSessionForPulse enforces opt-in, active work, and human-scale minimum gap", () => {
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
          buildConversationJobFixture({
            id: "job-1",
            input: "queued",
            createdAt: new Date().toISOString(),
            status: "queued",
            ackLifecycleState: "NOT_SENT",
            finalDeliveryOutcome: "not_attempted"
          })
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

  assert.equal(
    shouldSkipSessionForPulse(
      buildSession("telegram:chat-1:user-1", {
        agentPulse: {
          optIn: true,
          mode: "private",
          routeStrategy: "last_private_used",
          lastPulseSentAt: new Date(Date.now() - 13 * 60 * 60 * 1_000).toISOString(),
          lastPulseReason: null,
          lastPulseTargetConversationId: null,
          lastDecisionCode: "NOT_EVALUATED",
          lastEvaluatedAt: null
        }
      })
    ),
    false
  );
});

test("shouldSuppressPulseForSessionDomain only suppresses non-explicit workflow-session pulse reasons", () => {
  const workflowSession = buildSession("telegram:chat-1:user-1", {
    domainContext: buildWorkflowDomainContext("telegram:chat-1:user-1")
  });

  assert.equal(
    shouldSuppressPulseForSessionDomain(workflowSession, "stale_fact_revalidation"),
    true
  );
  assert.equal(
    shouldSuppressPulseForSessionDomain(workflowSession, "contextual_followup"),
    true
  );
  assert.equal(
    shouldSuppressPulseForSessionDomain(workflowSession, "dynamic"),
    true
  );
  assert.equal(
    shouldSuppressPulseForSessionDomain(workflowSession, "unresolved_commitment"),
    false
  );
  assert.equal(
    shouldSuppressPulseForSessionDomain(workflowSession, "user_requested_followup"),
    false
  );
  assert.equal(
    shouldSuppressPulseForSessionDomain(buildSession("telegram:chat-2:user-1"), "stale_fact_revalidation"),
    false
  );
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
