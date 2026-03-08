import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentPulseSessionState, ConversationTurn } from "../../src/interfaces/sessionStore";
import {
  appendPulseEmission,
  computeUserStyleFingerprint,
  detectTimezoneFromMessage,
  resolveUserLocalTime
} from "../../src/interfaces/conversationRuntime/sessionPulseMetadata";

test("appendPulseEmission caps the persisted history at ten records", () => {
  const state: AgentPulseSessionState = {
    optIn: true,
    mode: "private",
    routeStrategy: "last_private_used",
    lastPulseSentAt: null,
    lastPulseReason: null,
    lastPulseTargetConversationId: null,
    lastDecisionCode: "NOT_EVALUATED",
    lastEvaluatedAt: null,
    recentEmissions: []
  };

  for (let index = 0; index < 12; index += 1) {
    appendPulseEmission(state, {
      emittedAt: `2026-03-07T12:${String(index).padStart(2, "0")}:00.000Z`,
      reasonCode: `reason-${index}`,
      candidateEntityRefs: []
    });
  }

  assert.equal(state.recentEmissions?.length, 10);
  assert.equal(state.recentEmissions?.[0]?.reasonCode, "reason-2");
  assert.equal(state.recentEmissions?.[9]?.reasonCode, "reason-11");
});

test("computeUserStyleFingerprint stays deterministic for short casual turns", () => {
  const turns: ConversationTurn[] = [
    {
      role: "user",
      text: "hey lol",
      at: "2026-03-07T12:00:00.000Z"
    },
    {
      role: "user",
      text: "cool 😄",
      at: "2026-03-07T12:01:00.000Z"
    }
  ];

  assert.equal(computeUserStyleFingerprint(turns), "short messages, casual");
});

test("detectTimezoneFromMessage maps explicit timezone mentions to IANA values", () => {
  assert.equal(detectTimezoneFromMessage("my timezone is PST"), "America/Los_Angeles");
  assert.equal(detectTimezoneFromMessage("Tell me about the project"), null);
});

test("resolveUserLocalTime uses a stored IANA zone when available", () => {
  const resolved = resolveUserLocalTime("America/New_York", "2026-06-15T14:30:00.000Z");
  assert.equal(resolved.dayOfWeek, "Monday");
  assert.equal(resolved.hour, 10);
  assert.match(resolved.formatted, /^Monday /);
});
