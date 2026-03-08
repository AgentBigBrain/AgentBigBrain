/**
 * @fileoverview Covers canonical Agent Pulse state updates below the stable conversation manager entrypoint.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { updateConversationAgentPulseState } from "../../src/interfaces/conversationRuntime/pulseState";
import { type ConversationSession, InterfaceSessionStore } from "../../src/interfaces/sessionStore";

/**
 * Builds a minimal session for pulse-state persistence tests.
 */
function buildSession(conversationId: string): ConversationSession {
  return {
    conversationId,
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    updatedAt: "2026-03-07T15:00:00.000Z",
    activeProposal: null,
    runningJobId: null,
    queuedJobs: [],
    recentJobs: [],
    conversationTurns: [],
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
    }
  };
}

test("updateConversationAgentPulseState persists partial pulse changes and appends emission history", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-state-runtime-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const conversationKey = "telegram:chat-1:user-1";

  try {
    await store.setSession(buildSession(conversationKey));

    await updateConversationAgentPulseState({
      conversationKey,
      store,
      update: {
        optIn: true,
        mode: "public",
        routeStrategy: "current_conversation",
        lastDecisionCode: "ALLOWED",
        lastPulseReason: "stale_fact",
        lastPulseSentAt: "2026-03-07T15:05:00.000Z",
        lastPulseTargetConversationId: "telegram:chat-1:user-1",
        lastEvaluatedAt: "2026-03-07T15:04:59.000Z",
        updatedAt: "2026-03-07T15:05:00.000Z",
        newEmission: {
          emittedAt: "2026-03-07T15:05:00.000Z",
          reasonCode: "stale_fact_revalidation",
          candidateEntityRefs: ["followup.tax_filing"],
          generatedSnippet: "Check in on the stale fact."
        }
      }
    });

    const session = await store.getSession(conversationKey);
    assert.ok(session);
    assert.equal(session?.agentPulse.optIn, true);
    assert.equal(session?.agentPulse.mode, "public");
    assert.equal(session?.agentPulse.routeStrategy, "current_conversation");
    assert.equal(session?.agentPulse.lastDecisionCode, "ALLOWED");
    assert.equal(session?.agentPulse.recentEmissions?.length, 1);
    assert.equal(session?.updatedAt, "2026-03-07T15:05:00.000Z");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
