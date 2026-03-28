/**
 * @fileoverview Tests profile-memory pulse continuity helpers after Phase 2 extraction.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type AgentPulseDecision } from "../../src/core/agentPulse";
import {
  createProfileEpisodeRecord,
  createEmptyProfileMemoryState,
  type ProfileMemoryState,
  upsertTemporalProfileFact
} from "../../src/core/profileMemory";
import {
  applyRelationshipAwareTemporalNudging,
  assessContextDrift,
  assessRelationshipRole,
  countStaleActiveFacts,
  selectRelevantEpisodesForPulse
} from "../../src/core/profileMemoryRuntime/profileMemoryPulse";

test("countStaleActiveFacts counts only active stale facts", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "favorite.editor",
    value: "vscode",
    sensitive: false,
    sourceTaskId: "old_editor",
    source: "test.seed",
    observedAt: "2025-01-01T00:00:00.000Z",
    confidence: 0.9
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "favorite.editor",
    value: "zed",
    sensitive: false,
    sourceTaskId: "new_editor",
    source: "test.seed",
    observedAt: "2026-02-01T00:00:00.000Z",
    confidence: 0.9
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "favorite.shell",
    value: "pwsh",
    sensitive: false,
    sourceTaskId: "current_shell",
    source: "test.seed",
    observedAt: "2026-02-10T00:00:00.000Z",
    confidence: 0.9
  }).nextState;

  const staleCount = countStaleActiveFacts(state, 30, "2026-03-07T00:00:00.000Z");
  assert.equal(staleCount, 1);
});

test("assessRelationshipRole returns the newest active relationship role", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "relationship.role",
    value: "acquaintance",
    sensitive: false,
    sourceTaskId: "relationship_old",
    source: "test.seed",
    observedAt: "2026-02-01T00:00:00.000Z",
    confidence: 0.9
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "relationship.role",
    value: "friend",
    sensitive: false,
    sourceTaskId: "relationship_new",
    source: "test.seed",
    observedAt: "2026-02-02T00:00:00.000Z",
    confidence: 0.9
  }).nextState;

  const assessment = assessRelationshipRole(state);
  assert.equal(assessment.role, "friend");
  assert.ok(assessment.roleFactId);
});

test("assessContextDrift detects uncertain active and superseded domain facts", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "employment.current",
    value: "OldCo",
    sensitive: false,
    sourceTaskId: "job_old",
    source: "test.seed",
    observedAt: "2026-02-01T00:00:00.000Z",
    confidence: 0.9
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "employment.current",
    value: "NewCo",
    sensitive: false,
    sourceTaskId: "job_new",
    source: "test.seed",
    observedAt: "2026-02-02T00:00:00.000Z",
    confidence: 0.9
  }).nextState;

  const uncertainContactState: ProfileMemoryState = {
    ...state,
    facts: [
      ...state.facts,
      {
        id: "fact_uncertain_contact",
        key: "contact.email",
        value: "benny@example.com",
        sensitive: true,
        sourceTaskId: "contact_seed",
        source: "test.seed",
        observedAt: "2026-02-03T00:00:00.000Z",
        lastUpdatedAt: "2026-02-03T00:00:00.000Z",
        status: "uncertain",
        confirmedAt: null,
        supersededAt: null,
        confidence: 0.4
      }
    ]
  };

  const assessment = assessContextDrift(uncertainContactState);
  assert.equal(assessment.detected, true);
  assert.equal(assessment.requiresRevalidation, true);
  assert.deepEqual(assessment.domains, ["contact", "job"]);
});

test("applyRelationshipAwareTemporalNudging suppresses unresolved-commitment nudges for distant roles", () => {
  const baseDecision: AgentPulseDecision = {
    allowed: true,
    decisionCode: "ALLOWED",
    suppressedBy: [],
    nextEligibleAtIso: null
  };

  const decision = applyRelationshipAwareTemporalNudging(
    baseDecision,
    {
      nowIso: "2026-03-07T12:00:00.000Z",
      userOptIn: true,
      reason: "unresolved_commitment",
      lastPulseSentAtIso: null
    },
    {
      role: "acquaintance",
      roleFactId: "fact_relationship"
    },
    {
      detected: false,
      domains: [],
      requiresRevalidation: false
    }
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.decisionCode, "RELATIONSHIP_ROLE_SUPPRESSED");
});

test("applyRelationshipAwareTemporalNudging suppresses unresolved-commitment nudges for unknown relationships when context drift is present", () => {
  const baseDecision: AgentPulseDecision = {
    allowed: true,
    decisionCode: "ALLOWED",
    suppressedBy: [],
    nextEligibleAtIso: null
  };

  const decision = applyRelationshipAwareTemporalNudging(
    baseDecision,
    {
      nowIso: "2026-03-07T12:00:00.000Z",
      userOptIn: true,
      reason: "unresolved_commitment",
      lastPulseSentAtIso: null
    },
    {
      role: "unknown",
      roleFactId: null
    },
    {
      detected: true,
      domains: ["contact", "job"],
      requiresRevalidation: true
    }
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.decisionCode, "CONTEXT_DRIFT_SUPPRESSED");
  assert.deepEqual(decision.suppressedBy, [
    "context_drift.requires_revalidation",
    "context_drift.contact",
    "context_drift.job"
  ]);
});

test("selectRelevantEpisodesForPulse excludes stale and terminal situations", () => {
  const state = {
    ...createEmptyProfileMemoryState(),
    episodes: [
      createProfileEpisodeRecord({
        title: "Owen finished rehab",
        summary: "Owen finished rehab and fully recovered.",
        sourceTaskId: "task_profile_pulse_episode_1",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-03-05T10:00:00.000Z",
        lastMentionedAt: "2026-03-05T10:00:00.000Z",
        status: "resolved",
        resolvedAt: "2026-03-05T12:00:00.000Z",
        entityRefs: ["contact.owen"]
      }),
      createProfileEpisodeRecord({
        title: "Owen changed jobs",
        summary: "Owen changed jobs and the outcome never got resolved.",
        sourceTaskId: "task_profile_pulse_episode_2",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2025-10-01T10:00:00.000Z",
        lastMentionedAt: "2025-10-01T10:00:00.000Z",
        entityRefs: ["contact.owen"]
      }),
      createProfileEpisodeRecord({
        title: "Owen fell down",
        summary: "Owen fell down and the outcome was never mentioned.",
        sourceTaskId: "task_profile_pulse_episode_3",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-03-07T10:00:00.000Z",
        lastMentionedAt: "2026-03-07T10:00:00.000Z",
        entityRefs: ["contact.owen"]
      })
    ]
  };

  const relevantEpisodes = selectRelevantEpisodesForPulse(
    state,
    90,
    "2026-03-08T10:00:00.000Z",
    2
  );

  assert.deepEqual(
    relevantEpisodes.map((episode) => episode.title),
    ["Owen fell down"]
  );
});
