import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConversationSessionFixture } from "../helpers/conversationFixtures";
import { createEmptyConversationDomainContext } from "../../src/core/sessionContext";
import {
  normalizeSession,
  normalizeState
} from "../../src/interfaces/conversationRuntime/sessionNormalization";

test("normalizeSession migrates legacy session payloads to the stable runtime shape", () => {
  const now = "2026-03-07T12:00:00.000Z";
  const normalized = normalizeSession({
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
        text: "hello there",
        at: now
      }
    ],
    classifierEvents: [
      {
        classifier: "pulse_lexical",
        input: "turn on pulse reminders",
        at: now,
        isShortFollowUp: false,
        category: "COMMAND",
        confidenceTier: "HIGH",
        matchedRuleId: "pulse_lexical_v1_enable",
        rulepackVersion: "PulseLexicalRulepackV1",
        intent: "on",
        conflict: false
      }
    ],
    agentPulse: {
      optIn: true,
      mode: "private",
      routeStrategy: "last_private_used",
      lastPulseSentAt: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      lastDecisionCode: "ALLOWED",
      lastEvaluatedAt: now,
      recentEmissions: [
        {
          emittedAt: now,
          reasonCode: "STALE_FACT_REVALIDATION",
          candidateEntityRefs: []
        }
      ]
    }
  });

  assert.ok(normalized);
  assert.equal(normalized?.sessionSchemaVersion, "v2");
  assert.ok(normalized?.conversationStack);
  assert.equal(normalized?.classifierEvents?.[0]?.intent, "on");
  assert.equal(normalized?.agentPulse.recentEmissions?.length, 1);
  assert.deepEqual(
    normalized?.domainContext,
    createEmptyConversationDomainContext("telegram:chat-1:user-1")
  );
});

test("normalizeState drops invalid conversation entries", () => {
  const normalized = normalizeState({
    conversations: {
      valid: {
        ...buildConversationSessionFixture(
          {
            conversationId: "valid",
            updatedAt: "2026-03-07T12:00:00.000Z"
          },
          {
            conversationId: "valid",
            receivedAt: "2026-03-07T12:00:00.000Z"
          }
        ),
        updatedAt: "2026-03-07T12:00:00.000Z",
      },
      invalid: {
        userId: "user-2"
      } as never
    }
  });

  assert.deepEqual(Object.keys(normalized.conversations), ["valid"]);
});

test("normalizeSession preserves the session-domain pulse suppression decision code", () => {
  const now = "2026-03-07T12:00:00.000Z";
  const normalized = normalizeSession({
    ...buildConversationSessionFixture(
      {
        updatedAt: now,
        agentPulse: {
          ...buildConversationSessionFixture().agentPulse,
          lastDecisionCode: "SESSION_DOMAIN_SUPPRESSED"
        }
      },
      {
        conversationId: "telegram:chat-2:user-1",
        receivedAt: now
      }
    )
  });

  assert.equal(normalized?.agentPulse.lastDecisionCode, "SESSION_DOMAIN_SUPPRESSED");
});
