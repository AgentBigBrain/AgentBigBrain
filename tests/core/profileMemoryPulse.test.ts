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

test("countStaleActiveFacts counts only confirmed compatibility-visible stale facts", () => {
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

test("assessRelationshipRole prefers confirmed current relationship role over uncertain challengers", () => {
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
  assert.equal(assessment.role, "acquaintance");
  assert.ok(assessment.roleFactId);
});

test("assessRelationshipRole falls back to uncertain relationship role when no confirmed current role exists", () => {
  const state: ProfileMemoryState = {
    ...createEmptyProfileMemoryState(),
    facts: [
      {
        id: "fact_uncertain_friend_1",
        key: "relationship.role",
        value: "friend",
        sensitive: false,
        sourceTaskId: "relationship_uncertain_only",
        source: "test.seed",
        observedAt: "2026-02-02T00:00:00.000Z",
        lastUpdatedAt: "2026-02-02T00:00:00.000Z",
        status: "uncertain",
        confirmedAt: null,
        supersededAt: null,
        confidence: 0.6
      }
    ]
  };

  const assessment = assessRelationshipRole(state);
  assert.equal(assessment.role, "friend");
  assert.equal(assessment.roleFactId, "fact_uncertain_friend_1");
});

test("assessRelationshipRole recognizes acquaintance from contact relationship facts", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "contact.riley.relationship",
    value: "acquaintance",
    sensitive: false,
    sourceTaskId: "relationship_acquaintance_contact",
    source: "test.seed",
    observedAt: "2026-02-02T00:00:00.000Z",
    confidence: 0.9
  }).nextState;

  const assessment = assessRelationshipRole(state);
  assert.equal(assessment.role, "acquaintance");
  assert.ok(assessment.roleFactId);
});

test("assessRelationshipRole maps classmate contact relationships to acquaintance", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "contact.iris.relationship",
    value: "classmate",
    sensitive: false,
    sourceTaskId: "relationship_classmate_contact",
    source: "test.seed",
    observedAt: "2026-02-02T00:00:00.000Z",
    confidence: 0.9
  }).nextState;

  const assessment = assessRelationshipRole(state);
  assert.equal(assessment.role, "acquaintance");
  assert.ok(assessment.roleFactId);
});

test("assessRelationshipRole maps partner-family contact relationships to partner", () => {
  for (const value of ["partner", "married", "wife", "husband", "girlfriend", "boyfriend"]) {
    let state = createEmptyProfileMemoryState();
    state = upsertTemporalProfileFact(state, {
      key: "contact.iris.relationship",
      value,
      sensitive: false,
      sourceTaskId: `relationship_${value}_contact`,
      source: "test.seed",
      observedAt: "2026-02-02T00:00:00.000Z",
      confidence: 0.9
    }).nextState;

    const assessment = assessRelationshipRole(state);
    assert.equal(assessment.role, "partner");
    assert.ok(assessment.roleFactId);
  }
});

test("assessRelationshipRole maps cousin to distant_relative", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "relationship.role",
    value: "cousin",
    sensitive: false,
    sourceTaskId: "relationship_cousin",
    source: "test.seed",
    observedAt: "2026-02-02T00:00:00.000Z",
    confidence: 0.9
  }).nextState;

  const assessment = assessRelationshipRole(state);
  assert.equal(assessment.role, "distant_relative");
  assert.ok(assessment.roleFactId);
});

test("assessRelationshipRole maps close-kinship contact relationships to distant_relative", () => {
  for (const value of ["mom", "mother", "dad", "father", "sister", "brother"]) {
    let state = createEmptyProfileMemoryState();
    state = upsertTemporalProfileFact(state, {
      key: "contact.rosa.relationship",
      value,
      sensitive: false,
      sourceTaskId: `relationship_${value}_contact`,
      source: "test.seed",
      observedAt: "2026-02-02T00:00:00.000Z",
      confidence: 0.9
    }).nextState;

    const assessment = assessRelationshipRole(state);
    assert.equal(assessment.role, "distant_relative");
    assert.ok(assessment.roleFactId);
  }
});

test("assessRelationshipRole maps family and family-member relationships to distant_relative", () => {
  for (const fact of [
    { key: "contact.rosa.relationship", value: "family" },
    { key: "contact.rosa.relationship", value: "family member" },
    { key: "family.member", value: "Rosa" }
  ]) {
    let state = createEmptyProfileMemoryState();
    state = upsertTemporalProfileFact(state, {
      key: fact.key,
      value: fact.value,
      sensitive: false,
      sourceTaskId: `relationship_${fact.key.replace(/[^a-z0-9]+/gi, "_")}`,
      source: "test.seed",
      observedAt: "2026-04-03T12:00:00.000Z",
      confidence: 0.9
    }).nextState;

    const assessment = assessRelationshipRole(state);
    assert.equal(assessment.role, "distant_relative");
    assert.ok(assessment.roleFactId);
  }
});

test("assessRelationshipRole maps broader close-kinship relationships to distant_relative", () => {
  for (const value of ["son", "daughter", "parent", "child", "sibling"]) {
    let state = createEmptyProfileMemoryState();
    state = upsertTemporalProfileFact(state, {
      key: "contact.rosa.relationship",
      value,
      sensitive: false,
      sourceTaskId: `relationship_${value}_contact`,
      source: "test.seed",
      observedAt: "2026-04-03T12:00:00.000Z",
      confidence: 0.9
    }).nextState;

    const assessment = assessRelationshipRole(state);
    assert.equal(assessment.role, "distant_relative");
    assert.ok(assessment.roleFactId);
  }
});

test("assessRelationshipRole fails closed on ambiguous bare report phrasing", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "relationship.role",
    value: "report",
    sensitive: false,
    sourceTaskId: "relationship_report",
    source: "test.seed",
    observedAt: "2026-02-02T00:00:00.000Z",
    confidence: 0.9
  }).nextState;

  const assessment = assessRelationshipRole(state);
  assert.equal(assessment.role, "unknown");
  assert.equal(assessment.roleFactId, null);
});

test("assessRelationshipRole keeps roommate fail-closed until pulse taxonomy expands", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "contact.kai.relationship",
    value: "roommate",
    sensitive: false,
    sourceTaskId: "relationship_roommate",
    source: "test.seed",
    observedAt: "2026-02-02T00:00:00.000Z",
    confidence: 0.9
  }).nextState;

  const assessment = assessRelationshipRole(state);
  assert.equal(assessment.role, "unknown");
  assert.equal(assessment.roleFactId, null);
});

test("assessRelationshipRole ignores historical support-only contact relationships", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.relationship",
    value: "work_peer",
    sensitive: false,
    sourceTaskId: "relationship_historical_work_peer",
    source: "user_input_pattern.work_with_contact_historical",
    observedAt: "2026-04-03T12:00:00.000Z",
    confidence: 0.95
  }).nextState;

  const assessment = assessRelationshipRole(state);
  assert.equal(assessment.role, "unknown");
  assert.equal(assessment.roleFactId, null);
});

test("assessRelationshipRole ignores severed support-only contact relationships", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "contact.jordan.relationship",
    value: "manager",
    sensitive: false,
    sourceTaskId: "relationship_severed_manager",
    source: "user_input_pattern.direct_contact_relationship_severed",
    observedAt: "2026-04-03T12:00:00.000Z",
    confidence: 0.95
  }).nextState;

  const assessment = assessRelationshipRole(state);
  assert.equal(assessment.role, "unknown");
  assert.equal(assessment.roleFactId, null);
});

test("assessRelationshipRole still recognizes corroborated current relationships after historical support-only facts", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.relationship",
    value: "work_peer",
    sensitive: false,
    sourceTaskId: "relationship_historical_work_peer",
    source: "user_input_pattern.work_with_contact_historical",
    observedAt: "2026-04-03T12:00:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.sam.relationship",
    value: "friend",
    sensitive: false,
    sourceTaskId: "relationship_current_friend",
    source: "user_input_pattern.direct_contact_relationship",
    observedAt: "2026-04-03T12:05:00.000Z",
    confidence: 0.95
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
