/**
 * @fileoverview Tests deterministic Agent Pulse opt-in, quiet-hour, and rate-limit policy evaluation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentPulseEvaluationInput,
  AgentPulsePolicyConfig,
  evaluateAgentPulsePolicy
} from "../../src/core/agentPulse";

/**
 * Implements `buildPolicy` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildPolicy(overrides: Partial<AgentPulsePolicyConfig> = {}): AgentPulsePolicyConfig {
  return {
    enabled: true,
    timezoneOffsetMinutes: 0,
    quietHoursStartHourLocal: 22,
    quietHoursEndHourLocal: 8,
    minIntervalMinutes: 60,
    ...overrides
  };
}

/**
 * Implements `buildInput` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildInput(overrides: Partial<AgentPulseEvaluationInput> = {}): AgentPulseEvaluationInput {
  return {
    nowIso: "2026-02-23T15:00:00.000Z",
    userOptIn: true,
    reason: "stale_fact_revalidation",
    staleFactCount: 2,
    unresolvedCommitmentCount: 0,
    contextualLinkageConfidence: 0,
    lastPulseSentAtIso: null,
    overrideQuietHours: false,
    ...overrides
  };
}

test("agent pulse blocks when policy is disabled", () => {
  const decision = evaluateAgentPulsePolicy(
    buildPolicy({ enabled: false }),
    buildInput()
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.decisionCode, "DISABLED");
});

test("agent pulse blocks when user has not opted in", () => {
  const decision = evaluateAgentPulsePolicy(
    buildPolicy(),
    buildInput({ userOptIn: false })
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.decisionCode, "OPT_OUT");
});

test("agent pulse blocks stale-fact reason without stale facts", () => {
  const decision = evaluateAgentPulsePolicy(
    buildPolicy(),
    buildInput({ staleFactCount: 0, reason: "stale_fact_revalidation" })
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.decisionCode, "NO_STALE_FACTS");
});

test("agent pulse blocks unresolved-commitment reason without commitments", () => {
  const decision = evaluateAgentPulsePolicy(
    buildPolicy(),
    buildInput({ reason: "unresolved_commitment", unresolvedCommitmentCount: 0 })
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.decisionCode, "NO_UNRESOLVED_COMMITMENTS");
});

test("agent pulse blocks contextual-followup reason without linkage confidence", () => {
  const decision = evaluateAgentPulsePolicy(
    buildPolicy(),
    buildInput({
      reason: "contextual_followup",
      staleFactCount: 0,
      unresolvedCommitmentCount: 0,
      contextualLinkageConfidence: 0
    })
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.decisionCode, "NO_CONTEXTUAL_LINKAGE");
});

test("agent pulse blocks during quiet hours unless override is enabled", () => {
  const policy = buildPolicy({
    quietHoursStartHourLocal: 22,
    quietHoursEndHourLocal: 8
  });
  const quietTimeInput = buildInput({
    nowIso: "2026-02-23T23:15:00.000Z",
    reason: "unresolved_commitment",
    unresolvedCommitmentCount: 1
  });

  const blocked = evaluateAgentPulsePolicy(policy, quietTimeInput);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.decisionCode, "QUIET_HOURS");

  const overridden = evaluateAgentPulsePolicy(policy, {
    ...quietTimeInput,
    overrideQuietHours: true
  });
  assert.equal(overridden.allowed, true);
  assert.equal(overridden.decisionCode, "ALLOWED");
});

test("agent pulse applies deterministic min-interval rate limit", () => {
  const nowIso = "2026-02-23T15:00:00.000Z";
  const lastPulseIso = "2026-02-23T14:20:00.000Z";
  const decision = evaluateAgentPulsePolicy(
    buildPolicy({ minIntervalMinutes: 60 }),
    buildInput({
      nowIso,
      reason: "unresolved_commitment",
      unresolvedCommitmentCount: 1,
      lastPulseSentAtIso: lastPulseIso
    })
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.decisionCode, "RATE_LIMIT");
  assert.equal(decision.nextEligibleAtIso, "2026-02-23T15:20:00.000Z");
});

test("agent pulse allows valid opt-in check-in outside quiet hours and interval", () => {
  const decision = evaluateAgentPulsePolicy(
    buildPolicy({
      quietHoursStartHourLocal: 1,
      quietHoursEndHourLocal: 5
    }),
    buildInput({
      nowIso: "2026-02-23T15:00:00.000Z",
      reason: "user_requested_followup",
      staleFactCount: 0,
      unresolvedCommitmentCount: 0,
      lastPulseSentAtIso: "2026-02-23T12:00:00.000Z"
    })
  );

  assert.equal(decision.allowed, true);
  assert.equal(decision.decisionCode, "ALLOWED");
  assert.equal(decision.suppressedBy.length, 0);
});
