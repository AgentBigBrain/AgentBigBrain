import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_CONVERSATION_DOMAIN_LANE_HISTORY,
  MAX_CONVERSATION_DOMAIN_ROUTING_SIGNALS,
  applyDomainSignalWindow,
  createEmptyConversationDomainContext,
  detectCrossDomainDip,
  normalizeConversationDomainContext,
  resolveSessionDomain,
  selectConversationDomainContext
} from "../../src/core/sessionContext";

test("createEmptyConversationDomainContext seeds the canonical empty shape", () => {
  assert.deepEqual(createEmptyConversationDomainContext("telegram:chat-1:user-1"), {
    conversationId: "telegram:chat-1:user-1",
    dominantLane: "unknown",
    recentLaneHistory: [],
    recentRoutingSignals: [],
    continuitySignals: {
      activeWorkspace: false,
      returnHandoff: false,
      modeContinuity: false
    },
    activeSince: null,
    lastUpdatedAt: null
  });
});

test("normalizeConversationDomainContext backfills defaults and canonical conversation id", () => {
  const normalized = normalizeConversationDomainContext(
    {
      conversationId: "wrong-id",
      dominantLane: "workflow",
      recentLaneHistory: [{ lane: "workflow", observedAt: "2026-03-20T12:00:00.000Z", source: "routing_mode" }]
    },
    "telegram:chat-1:user-1"
  );

  assert.equal(normalized.conversationId, "telegram:chat-1:user-1");
  assert.equal(normalized.dominantLane, "workflow");
  assert.equal(normalized.recentLaneHistory[0]?.weight, 1);
  assert.equal(normalized.lastUpdatedAt, "2026-03-20T12:00:00.000Z");
  assert.equal(normalized.activeSince, "2026-03-20T12:00:00.000Z");
});

test("resolveSessionDomain prefers stronger lane evidence and keeps the current dominant on ties", () => {
  assert.equal(
    resolveSessionDomain([
      { lane: "profile", observedAt: "2026-03-20T12:00:00.000Z", source: "keyword", weight: 1 },
      { lane: "workflow", observedAt: "2026-03-20T12:01:00.000Z", source: "routing_mode", weight: 2 }
    ]),
    "workflow"
  );

  assert.equal(
    resolveSessionDomain(
      [
        { lane: "profile", observedAt: "2026-03-20T12:00:00.000Z", source: "keyword", weight: 1 },
        { lane: "workflow", observedAt: "2026-03-20T12:01:00.000Z", source: "routing_mode", weight: 1 }
      ],
      "profile"
    ),
    "profile"
  );
});

test("applyDomainSignalWindow updates dominant lane, preserves activeSince within one lane, and caps windows", () => {
  const conversationId = "telegram:chat-1:user-1";
  const afterProfile = applyDomainSignalWindow(createEmptyConversationDomainContext(conversationId), {
    observedAt: "2026-03-20T12:00:00.000Z",
    laneSignals: [
      { lane: "profile", observedAt: "2026-03-20T12:00:00.000Z", source: "keyword", weight: 1 }
    ]
  });
  const workflowSignals = Array.from({ length: MAX_CONVERSATION_DOMAIN_LANE_HISTORY + 2 }, (_, index) => ({
    lane: "workflow" as const,
    observedAt: `2026-03-20T12:${String(index + 1).padStart(2, "0")}:00.000Z`,
    source: "routing_mode" as const,
    weight: 1
  }));
  const routingSignals = Array.from({ length: MAX_CONVERSATION_DOMAIN_ROUTING_SIGNALS + 2 }, (_, index) => ({
    mode: "autonomous" as const,
    observedAt: `2026-03-20T13:${String(index).padStart(2, "0")}:00.000Z`
  }));
  const afterWorkflow = applyDomainSignalWindow(afterProfile, {
    observedAt: "2026-03-20T12:01:00.000Z",
    laneSignals: workflowSignals,
    routingSignals,
    continuitySignals: {
      activeWorkspace: true
    }
  });
  const afterWorkflowFollowUp = applyDomainSignalWindow(afterWorkflow, {
    observedAt: "2026-03-20T13:30:00.000Z",
    laneSignals: [
      { lane: "workflow", observedAt: "2026-03-20T13:30:00.000Z", source: "continuity_state", weight: 1 }
    ],
    continuitySignals: {
      modeContinuity: true
    }
  });

  assert.equal(afterProfile.dominantLane, "profile");
  assert.equal(afterProfile.activeSince, "2026-03-20T12:00:00.000Z");
  assert.equal(afterWorkflow.dominantLane, "workflow");
  assert.equal(afterWorkflow.activeSince, "2026-03-20T12:01:00.000Z");
  assert.equal(afterWorkflow.recentLaneHistory.length, MAX_CONVERSATION_DOMAIN_LANE_HISTORY);
  assert.equal(afterWorkflow.recentRoutingSignals.length, MAX_CONVERSATION_DOMAIN_ROUTING_SIGNALS);
  assert.equal(afterWorkflowFollowUp.activeSince, "2026-03-20T12:01:00.000Z");
  assert.equal(afterWorkflowFollowUp.continuitySignals.activeWorkspace, true);
  assert.equal(afterWorkflowFollowUp.continuitySignals.modeContinuity, true);
});

test("detectCrossDomainDip only fires when continuity is already active", () => {
  assert.equal(
    detectCrossDomainDip(
      {
        dominantLane: "workflow",
        continuitySignals: {
          activeWorkspace: true,
          returnHandoff: false,
          modeContinuity: false
        }
      },
      "profile"
    ),
    true
  );
  assert.equal(
    detectCrossDomainDip(
      {
        dominantLane: "workflow",
        continuitySignals: {
          activeWorkspace: false,
          returnHandoff: false,
          modeContinuity: false
        }
      },
      "profile"
    ),
    false
  );
});

test("selectConversationDomainContext preserves meaningful context over a newer empty update", () => {
  const conversationId = "telegram:chat-1:user-1";
  const existing = applyDomainSignalWindow(createEmptyConversationDomainContext(conversationId), {
    observedAt: "2026-03-20T12:00:00.000Z",
    laneSignals: [
      { lane: "workflow", observedAt: "2026-03-20T12:00:00.000Z", source: "routing_mode", weight: 1 }
    ]
  });
  const incoming = normalizeConversationDomainContext(
    {
      dominantLane: "unknown",
      lastUpdatedAt: "2026-03-20T12:05:00.000Z"
    },
    conversationId
  );

  const selected = selectConversationDomainContext(existing, incoming, conversationId);
  assert.equal(selected.dominantLane, "workflow");
  assert.equal(selected.recentLaneHistory.length, 1);
});

test("selectConversationDomainContext prefers the fresher meaningful context when both sides carry data", () => {
  const conversationId = "telegram:chat-1:user-1";
  const existing = applyDomainSignalWindow(createEmptyConversationDomainContext(conversationId), {
    observedAt: "2026-03-20T12:00:00.000Z",
    laneSignals: [
      { lane: "workflow", observedAt: "2026-03-20T12:00:00.000Z", source: "routing_mode", weight: 1 }
    ]
  });
  const incoming = applyDomainSignalWindow(createEmptyConversationDomainContext(conversationId), {
    observedAt: "2026-03-20T12:10:00.000Z",
    laneSignals: [
      { lane: "profile", observedAt: "2026-03-20T12:10:00.000Z", source: "keyword", weight: 1 }
    ]
  });

  const selected = selectConversationDomainContext(existing, incoming, conversationId);
  assert.equal(selected.dominantLane, "profile");
  assert.equal(selected.lastUpdatedAt, "2026-03-20T12:10:00.000Z");
});
