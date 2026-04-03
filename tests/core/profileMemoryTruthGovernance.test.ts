/**
 * @fileoverview Focused tests for deterministic profile-memory truth governance.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { governProfileMemoryCandidates } from "../../src/core/profileMemoryRuntime/profileMemoryTruthGovernance";

test("truth governance allows validated preferred-name candidates as current-state facts", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: false,
        sourceTaskId: "task_truth_governance_name",
        source: "conversation.identity_interpretation",
        observedAt: "2026-04-02T12:00:00.000Z",
        confidence: 0.95
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(result.factDecisions[0]?.decision, {
    family: "identity.preferred_name",
    evidenceClass: "validated_structured_candidate",
    action: "allow_current_state",
    reason: "validated_semantic_candidate"
  });
  assert.equal(result.allowedCurrentStateFactCandidates.length, 1);
  assert.equal(result.allowedSupportOnlyFactCandidates.length, 0);
});

test("truth governance only allows the live explicit preferred-name source", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: false,
        sourceTaskId: "task_truth_governance_name_phrase",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.95
      },
      {
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: false,
        sourceTaskId: "task_truth_governance_name_unsupported",
        source: "user_input_pattern.preference_statement",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.88
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.factDecisions.map((entry) => entry.decision),
    [
      {
        family: "identity.preferred_name",
        evidenceClass: "user_explicit_fact",
        action: "allow_current_state",
        reason: "explicit_user_fact"
      },
      {
        family: "identity.preferred_name",
        evidenceClass: "user_explicit_fact",
        action: "quarantine",
        reason: "unsupported_source"
      }
    ]
  );
  assert.equal(result.allowedCurrentStateFactCandidates.length, 1);
  assert.equal(result.quarantinedFactCandidates.length, 1);
});

test("truth governance classifies unsupported projection preferred-name sources as reconciliation_or_projection", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: false,
        sourceTaskId: "task_truth_governance_name_projection",
        source: "profile_state_reconciliation.preferred_name_refresh",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.88
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(result.factDecisions[0]?.decision, {
    family: "identity.preferred_name",
    evidenceClass: "reconciliation_or_projection",
    action: "quarantine",
    reason: "unsupported_source"
  });
  assert.equal(result.allowedCurrentStateFactCandidates.length, 0);
  assert.equal(result.quarantinedFactCandidates.length, 1);
});

test("truth governance keeps contact context and entity hints on the legacy support-only path", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "contact.owen.context.abc123",
        value: "Owen said the launch slipped.",
        sensitive: false,
        sourceTaskId: "task_truth_governance_context",
        source: "user_input_pattern.contact_context",
        observedAt: "2026-04-02T12:00:00.000Z",
        confidence: 0.82
      },
      {
        key: "contact.owen.name",
        value: "Owen",
        sensitive: false,
        sourceTaskId: "task_truth_governance_hint",
        source: "user_input_pattern.contact_entity_hint",
        observedAt: "2026-04-02T12:00:00.000Z",
        confidence: 0.75
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.factDecisions.map((entry) => entry.decision),
    [
      {
        family: "contact.context",
        evidenceClass: "user_hint_or_context",
        action: "support_only_legacy",
        reason: "contact_context_is_support_only"
      },
      {
        family: "contact.entity_hint",
        evidenceClass: "user_hint_or_context",
        action: "support_only_legacy",
        reason: "contact_entity_hint_requires_corroboration"
      }
    ]
  );
  assert.equal(result.allowedCurrentStateFactCandidates.length, 0);
  assert.equal(result.allowedSupportOnlyFactCandidates.length, 2);
});

test("truth governance quarantines contact entity hints outside the live hinted-contact-name family", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "contact.owen.relationship",
        value: "friend",
        sensitive: false,
        sourceTaskId: "task_truth_governance_hint_relationship",
        source: "user_input_pattern.contact_entity_hint",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.75
      },
      {
        key: "employment.current",
        value: "Lantern Studio",
        sensitive: false,
        sourceTaskId: "task_truth_governance_hint_employment",
        source: "user_input_pattern.contact_entity_hint",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.75
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.factDecisions.map((entry) => entry.decision),
    [
      {
        family: "contact.relationship",
        evidenceClass: "user_hint_or_context",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "employment.current",
        evidenceClass: "user_hint_or_context",
        action: "quarantine",
        reason: "unsupported_source"
      }
    ]
  );
  assert.equal(result.allowedSupportOnlyFactCandidates.length, 0);
  assert.equal(result.quarantinedFactCandidates.length, 2);
});

test("truth governance only allows the live contact-context support-only source", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "contact.owen.context.live123",
        value: "Owen said the launch slipped.",
        sensitive: false,
        sourceTaskId: "task_truth_governance_contact_context_live",
        source: "user_input_pattern.contact_context",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.82
      },
      {
        key: "contact.owen.context.structured123",
        value: "Structured contact context.",
        sensitive: false,
        sourceTaskId: "task_truth_governance_contact_context_structured",
        source: "conversation.contact_context_interpretation",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.9
      },
      {
        key: "contact.owen.context.explicit123",
        value: "Explicit unsupported contact context.",
        sensitive: false,
        sourceTaskId: "task_truth_governance_contact_context_explicit",
        source: "user_input_pattern.preference_statement",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.82
      },
      {
        key: "contact.owen.context.projection123",
        value: "Projected contact context.",
        sensitive: false,
        sourceTaskId: "task_truth_governance_contact_context_projection",
        source: "profile_state_reconciliation.contact_context_refresh",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.85
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.factDecisions.map((entry) => entry.decision),
    [
      {
        family: "contact.context",
        evidenceClass: "user_hint_or_context",
        action: "support_only_legacy",
        reason: "contact_context_is_support_only"
      },
      {
        family: "contact.context",
        evidenceClass: "validated_structured_candidate",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "contact.context",
        evidenceClass: "user_hint_or_context",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "contact.context",
        evidenceClass: "reconciliation_or_projection",
        action: "quarantine",
        reason: "unsupported_source"
      }
    ]
  );
  assert.equal(result.allowedSupportOnlyFactCandidates.length, 1);
  assert.equal(result.quarantinedFactCandidates.length, 3);
});

test("truth governance keeps historical work-linkage and school-association facts support-only", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "contact.owen.relationship",
        value: "work_peer",
        sensitive: false,
        sourceTaskId: "task_truth_governance_historical_relationship",
        source: "user_input_pattern.work_with_contact_historical",
        observedAt: "2026-04-02T12:00:00.000Z",
        confidence: 0.95
      },
      {
        key: "contact.owen.work_association",
        value: "Lantern Studio",
        sensitive: false,
        sourceTaskId: "task_truth_governance_historical_work",
        source: "user_input_pattern.work_association_historical",
        observedAt: "2026-04-02T12:00:00.000Z",
        confidence: 0.95
      },
      {
        key: "contact.owen.school_association",
        value: "went_to_school_together",
        sensitive: false,
        sourceTaskId: "task_truth_governance_school",
        source: "user_input_pattern.school_association",
        observedAt: "2026-04-02T12:00:00.000Z",
        confidence: 0.95
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.factDecisions.map((entry) => entry.decision),
    [
      {
        family: "contact.relationship",
        evidenceClass: "user_explicit_fact",
        action: "support_only_legacy",
        reason: "historical_work_linkage_support_only"
      },
      {
        family: "contact.work_association",
        evidenceClass: "user_explicit_fact",
        action: "support_only_legacy",
        reason: "historical_work_linkage_support_only"
      },
      {
        family: "contact.school_association",
        evidenceClass: "user_explicit_fact",
        action: "support_only_legacy",
        reason: "historical_school_association_support_only"
      }
    ]
  );
  assert.equal(result.allowedCurrentStateFactCandidates.length, 0);
  assert.equal(result.allowedSupportOnlyFactCandidates.length, 3);
});

test("truth governance quarantines unsupported structured school-association sources", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "contact.owen.school_association",
        value: "went_to_school_together",
        sensitive: false,
        sourceTaskId: "task_truth_governance_structured_school",
        source: "conversation.school_association_interpretation",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.9
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(result.factDecisions[0]?.decision, {
    family: "contact.school_association",
    evidenceClass: "validated_structured_candidate",
    action: "quarantine",
    reason: "unsupported_source"
  });
  assert.equal(result.allowedSupportOnlyFactCandidates.length, 0);
  assert.equal(result.quarantinedFactCandidates.length, 1);
});

test("truth governance only allows the live contact current-state sources", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "contact.owen.name",
        value: "Owen",
        sensitive: false,
        sourceTaskId: "task_truth_governance_contact_name_current",
        source: "user_input_pattern.named_contact",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.92
      },
      {
        key: "contact.owen.name",
        value: "Owen",
        sensitive: false,
        sourceTaskId: "task_truth_governance_contact_name_severed",
        source: "user_input_pattern.direct_contact_relationship_severed",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.91
      },
      {
        key: "contact.owen.relationship",
        value: "manager",
        sensitive: false,
        sourceTaskId: "task_truth_governance_contact_relationship_direct",
        source: "user_input_pattern.direct_contact_relationship",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.93
      },
      {
        key: "contact.riley.relationship",
        value: "work_peer",
        sensitive: false,
        sourceTaskId: "task_truth_governance_contact_relationship_work_with",
        source: "user_input_pattern.work_with_contact",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.9
      },
      {
        key: "contact.kai.relationship",
        value: "work_peer",
        sensitive: false,
        sourceTaskId: "task_truth_governance_contact_relationship_association",
        source: "user_input_pattern.work_association",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.9
      },
      {
        key: "contact.owen.work_association",
        value: "Lantern Studio",
        sensitive: false,
        sourceTaskId: "task_truth_governance_contact_work_direct",
        source: "user_input_pattern.direct_contact_relationship",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.93
      },
      {
        key: "contact.riley.work_association",
        value: "Northstar Creative",
        sensitive: false,
        sourceTaskId: "task_truth_governance_contact_work_with",
        source: "user_input_pattern.work_with_contact",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.9
      },
      {
        key: "contact.kai.work_association",
        value: "Harbor Labs",
        sensitive: false,
        sourceTaskId: "task_truth_governance_contact_work_association",
        source: "user_input_pattern.work_association",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.9
      },
      {
        key: "contact.milo.name",
        value: "Milo",
        sensitive: false,
        sourceTaskId: "task_truth_governance_contact_name_unsupported",
        source: "user_input_pattern.preference_statement",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.82
      },
      {
        key: "contact.milo.relationship",
        value: "friend",
        sensitive: false,
        sourceTaskId: "task_truth_governance_contact_relationship_unsupported",
        source: "user_input_pattern.preference_statement",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.82
      },
      {
        key: "contact.milo.work_association",
        value: "Beacon",
        sensitive: false,
        sourceTaskId: "task_truth_governance_contact_work_unsupported",
        source: "user_input_pattern.preference_statement",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.82
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.factDecisions.map((entry) => entry.decision),
    [
      {
        family: "contact.name",
        evidenceClass: "user_explicit_fact",
        action: "allow_current_state",
        reason: "explicit_user_fact"
      },
      {
        family: "contact.name",
        evidenceClass: "user_explicit_fact",
        action: "allow_current_state",
        reason: "explicit_user_fact"
      },
      {
        family: "contact.relationship",
        evidenceClass: "user_explicit_fact",
        action: "allow_current_state",
        reason: "explicit_user_fact"
      },
      {
        family: "contact.relationship",
        evidenceClass: "user_explicit_fact",
        action: "allow_current_state",
        reason: "explicit_user_fact"
      },
      {
        family: "contact.relationship",
        evidenceClass: "user_explicit_fact",
        action: "allow_current_state",
        reason: "explicit_user_fact"
      },
      {
        family: "contact.work_association",
        evidenceClass: "user_explicit_fact",
        action: "allow_current_state",
        reason: "explicit_user_fact"
      },
      {
        family: "contact.work_association",
        evidenceClass: "user_explicit_fact",
        action: "allow_current_state",
        reason: "explicit_user_fact"
      },
      {
        family: "contact.work_association",
        evidenceClass: "user_explicit_fact",
        action: "allow_current_state",
        reason: "explicit_user_fact"
      },
      {
        family: "contact.name",
        evidenceClass: "user_explicit_fact",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "contact.relationship",
        evidenceClass: "user_explicit_fact",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "contact.work_association",
        evidenceClass: "user_explicit_fact",
        action: "quarantine",
        reason: "unsupported_source"
      }
    ]
  );
  assert.equal(result.allowedCurrentStateFactCandidates.length, 8);
  assert.equal(result.quarantinedFactCandidates.length, 3);
});

test("truth governance only allows the live school-association support-only source", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "contact.owen.school_association",
        value: "went_to_school_together",
        sensitive: false,
        sourceTaskId: "task_truth_governance_school_live",
        source: "user_input_pattern.school_association",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.92
      },
      {
        key: "contact.owen.school_association",
        value: "went_to_school_together",
        sensitive: false,
        sourceTaskId: "task_truth_governance_school_unsupported",
        source: "user_input_pattern.preference_statement",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.82
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.factDecisions.map((entry) => entry.decision),
    [
      {
        family: "contact.school_association",
        evidenceClass: "user_explicit_fact",
        action: "support_only_legacy",
        reason: "historical_school_association_support_only"
      },
      {
        family: "contact.school_association",
        evidenceClass: "user_explicit_fact",
        action: "quarantine",
        reason: "unsupported_source"
      }
    ]
  );
  assert.equal(result.allowedSupportOnlyFactCandidates.length, 1);
  assert.equal(result.quarantinedFactCandidates.length, 1);
});

test("truth governance classifies unsupported projection contact sources as reconciliation_or_projection", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "contact.owen.name",
        value: "Owen",
        sensitive: false,
        sourceTaskId: "task_truth_governance_projection_contact_name",
        source: "profile_state_reconciliation.contact_name_refresh",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.82
      },
      {
        key: "contact.owen.relationship",
        value: "manager",
        sensitive: false,
        sourceTaskId: "task_truth_governance_projection_contact_relationship",
        source: "profile_state_reconciliation.contact_relationship_refresh",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.82
      },
      {
        key: "contact.owen.work_association",
        value: "Lantern Studio",
        sensitive: false,
        sourceTaskId: "task_truth_governance_projection_contact_work_association",
        source: "profile_state_reconciliation.contact_work_association_refresh",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.82
      },
      {
        key: "contact.owen.school_association",
        value: "went_to_school_together",
        sensitive: false,
        sourceTaskId: "task_truth_governance_projection_contact_school_association",
        source: "profile_state_reconciliation.contact_school_association_refresh",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.82
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.factDecisions.map((entry) => entry.decision),
    [
      {
        family: "contact.name",
        evidenceClass: "reconciliation_or_projection",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "contact.relationship",
        evidenceClass: "reconciliation_or_projection",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "contact.work_association",
        evidenceClass: "reconciliation_or_projection",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "contact.school_association",
        evidenceClass: "reconciliation_or_projection",
        action: "quarantine",
        reason: "unsupported_source"
      }
    ]
  );
  assert.equal(result.allowedCurrentStateFactCandidates.length, 0);
  assert.equal(result.allowedSupportOnlyFactCandidates.length, 0);
  assert.equal(result.quarantinedFactCandidates.length, 4);
});

test("truth governance keeps severed work-linkage facts support-only", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "contact.owen.relationship",
        value: "work_peer",
        sensitive: false,
        sourceTaskId: "task_truth_governance_severed_relationship",
        source: "user_input_pattern.work_with_contact_severed",
        observedAt: "2026-04-02T12:00:00.000Z",
        confidence: 0.95
      },
      {
        key: "contact.owen.work_association",
        value: "Lantern Studio",
        sensitive: false,
        sourceTaskId: "task_truth_governance_severed_work",
        source: "user_input_pattern.work_with_contact_severed",
        observedAt: "2026-04-02T12:00:00.000Z",
        confidence: 0.95
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.factDecisions.map((entry) => entry.decision),
    [
      {
        family: "contact.relationship",
        evidenceClass: "user_explicit_fact",
        action: "support_only_legacy",
        reason: "severed_work_linkage_support_only"
      },
      {
        family: "contact.work_association",
        evidenceClass: "user_explicit_fact",
        action: "support_only_legacy",
        reason: "severed_work_linkage_support_only"
      }
    ]
  );
  assert.equal(result.allowedCurrentStateFactCandidates.length, 0);
  assert.equal(result.allowedSupportOnlyFactCandidates.length, 2);
});

test("truth governance keeps historical and severed direct contact relationship facts support-only", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "contact.owen.relationship",
        value: "coworker",
        sensitive: false,
        sourceTaskId: "task_truth_governance_direct_historical_relationship",
        source: "user_input_pattern.direct_contact_relationship_historical",
        observedAt: "2026-04-02T12:00:00.000Z",
        confidence: 0.95
      },
      {
        key: "contact.owen.work_association",
        value: "Lantern Studio",
        sensitive: false,
        sourceTaskId: "task_truth_governance_direct_historical_work",
        source: "user_input_pattern.direct_contact_relationship_historical",
        observedAt: "2026-04-02T12:00:00.000Z",
        confidence: 0.95
      },
      {
        key: "contact.jordan.relationship",
        value: "manager",
        sensitive: false,
        sourceTaskId: "task_truth_governance_direct_severed_relationship",
        source: "user_input_pattern.direct_contact_relationship_severed",
        observedAt: "2026-04-02T12:00:00.000Z",
        confidence: 0.95
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.factDecisions.map((entry) => entry.decision),
    [
      {
        family: "contact.relationship",
        evidenceClass: "user_explicit_fact",
        action: "support_only_legacy",
        reason: "historical_contact_relationship_support_only"
      },
      {
        family: "contact.work_association",
        evidenceClass: "user_explicit_fact",
        action: "support_only_legacy",
        reason: "historical_contact_relationship_support_only"
      },
      {
        family: "contact.relationship",
        evidenceClass: "user_explicit_fact",
        action: "support_only_legacy",
        reason: "severed_contact_relationship_support_only"
      }
    ]
  );
  assert.equal(result.allowedCurrentStateFactCandidates.length, 0);
  assert.equal(result.allowedSupportOnlyFactCandidates.length, 3);
});

test("truth governance keeps historical self employment and residence support-only", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "employment.current",
        value: "Lantern",
        sensitive: false,
        sourceTaskId: "task_truth_governance_historical_employment",
        source: "user_input_pattern.work_at_historical",
        observedAt: "2026-04-02T12:00:00.000Z",
        confidence: 0.95
      },
      {
        key: "residence.current",
        value: "Detroit",
        sensitive: true,
        sourceTaskId: "task_truth_governance_historical_residence",
        source: "user_input_pattern.residence_historical",
        observedAt: "2026-04-02T12:00:00.000Z",
        confidence: 0.95
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.factDecisions.map((entry) => entry.decision),
    [
      {
        family: "employment.current",
        evidenceClass: "user_explicit_fact",
        action: "support_only_legacy",
        reason: "historical_employment_support_only"
      },
      {
        family: "residence.current",
        evidenceClass: "user_explicit_fact",
        action: "support_only_legacy",
        reason: "historical_residence_support_only"
      }
    ]
  );
  assert.equal(result.allowedCurrentStateFactCandidates.length, 0);
  assert.equal(result.allowedSupportOnlyFactCandidates.length, 2);
});

test("truth governance only allows the live current self employment and residence sources", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "employment.current",
        value: "Northstar Creative",
        sensitive: false,
        sourceTaskId: "task_truth_governance_work_at",
        source: "user_input_pattern.work_at",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.93
      },
      {
        key: "employment.current",
        value: "Lantern Studio",
        sensitive: false,
        sourceTaskId: "task_truth_governance_job_is",
        source: "user_input_pattern.job_is",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.91
      },
      {
        key: "residence.current",
        value: "Chicago",
        sensitive: true,
        sourceTaskId: "task_truth_governance_residence",
        source: "user_input_pattern.residence",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.9
      },
      {
        key: "employment.current",
        value: "Fallback Corp",
        sensitive: false,
        sourceTaskId: "task_truth_governance_employment_unsupported",
        source: "user_input_pattern.preference_statement",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.88
      },
      {
        key: "residence.current",
        value: "Detroit",
        sensitive: true,
        sourceTaskId: "task_truth_governance_residence_unsupported",
        source: "user_input_pattern.location_statement",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.88
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.factDecisions.map((entry) => entry.decision),
    [
      {
        family: "employment.current",
        evidenceClass: "user_explicit_fact",
        action: "allow_current_state",
        reason: "explicit_user_fact"
      },
      {
        family: "employment.current",
        evidenceClass: "user_explicit_fact",
        action: "allow_current_state",
        reason: "explicit_user_fact"
      },
      {
        family: "residence.current",
        evidenceClass: "user_explicit_fact",
        action: "allow_current_state",
        reason: "explicit_user_fact"
      },
      {
        family: "employment.current",
        evidenceClass: "user_explicit_fact",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "residence.current",
        evidenceClass: "user_explicit_fact",
        action: "quarantine",
        reason: "unsupported_source"
      }
    ]
  );
  assert.equal(result.allowedCurrentStateFactCandidates.length, 3);
  assert.equal(result.quarantinedFactCandidates.length, 2);
});

test("truth governance marks follow-up resolution facts as end-state candidates", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "followup.vet",
        value: "resolved",
        sensitive: false,
        sourceTaskId: "task_truth_governance_followup",
        source: "profile_state_reconciliation.followup_resolved",
        observedAt: "2026-04-02T12:00:00.000Z",
        confidence: 0.9
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(result.factDecisions[0]?.decision, {
    family: "followup.resolution",
    evidenceClass: "reconciliation_or_projection",
    action: "allow_end_state",
    reason: "followup_resolution_end_state"
  });
  assert.equal(result.allowedCurrentStateFactCandidates.length, 1);
});

test("truth governance quarantines unsupported structured and projection follow-up resolution sources", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "followup.vet",
        value: "resolved",
        sensitive: false,
        sourceTaskId: "task_truth_governance_structured_followup",
        source: "conversation.followup_interpretation",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.9
      },
      {
        key: "followup.vet",
        value: "resolved",
        sensitive: false,
        sourceTaskId: "task_truth_governance_projection_followup",
        source: "profile_state_reconciliation.followup_refresh",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.9
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.factDecisions.map((entry) => entry.decision),
    [
      {
        family: "followup.resolution",
        evidenceClass: "validated_structured_candidate",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "followup.resolution",
        evidenceClass: "reconciliation_or_projection",
        action: "quarantine",
        reason: "unsupported_source"
      }
    ]
  );
  assert.equal(result.allowedCurrentStateFactCandidates.length, 0);
  assert.equal(result.quarantinedFactCandidates.length, 2);
});

test("truth governance quarantines unsupported projection current-state sources outside follow-up reconciliation", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "employment.current",
        value: "Northstar Creative",
        sensitive: false,
        sourceTaskId: "task_truth_governance_projection_employment",
        source: "profile_state_reconciliation.employment_refresh",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.92
      },
      {
        key: "residence.current",
        value: "Detroit",
        sensitive: true,
        sourceTaskId: "task_truth_governance_projection_residence",
        source: "profile_state_reconciliation.residence_refresh",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.92
      },
      {
        key: "favorite.editor",
        value: "Helix",
        sensitive: false,
        sourceTaskId: "task_truth_governance_projection_generic",
        source: "profile_state_reconciliation.generic_refresh",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.88
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.factDecisions.map((entry) => entry.decision),
    [
      {
        family: "employment.current",
        evidenceClass: "reconciliation_or_projection",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "residence.current",
        evidenceClass: "reconciliation_or_projection",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "generic.profile_fact",
        evidenceClass: "reconciliation_or_projection",
        action: "quarantine",
        reason: "unsupported_source"
      }
    ]
  );
  assert.equal(result.allowedCurrentStateFactCandidates.length, 0);
  assert.equal(result.quarantinedFactCandidates.length, 3);
});

test("truth governance allows assistant-inference episodes as bounded episode support", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [],
    episodeCandidates: [
      {
        title: "Owen fell down",
        summary: "Owen fell down and the outcome is unresolved.",
        sourceTaskId: "task_truth_governance_episode",
        source: "language_understanding.episode_extraction",
        sourceKind: "assistant_inference",
        sensitive: false,
        observedAt: "2026-04-02T12:00:00.000Z",
        confidence: 0.82,
        entityRefs: ["contact.owen"],
        tags: ["followup"]
      }
    ],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(result.episodeDecisions[0]?.decision, {
    family: "episode.candidate",
    evidenceClass: "assistant_inference",
    action: "allow_episode_support",
    reason: "assistant_inference_episode"
  });
  assert.equal(result.allowedEpisodeCandidates.length, 1);
});

test("truth governance only allows the live episode candidate sources", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [],
    episodeCandidates: [
      {
        title: "Owen fell down",
        summary: "Owen fell down and the outcome is unresolved.",
        sourceTaskId: "task_truth_governance_episode_explicit_live",
        source: "user_input_pattern.episode_candidate",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.88,
        entityRefs: ["contact.owen"],
        tags: ["followup"]
      },
      {
        title: "Owen fell down",
        summary: "Unsupported explicit episode source.",
        sourceTaskId: "task_truth_governance_episode_explicit_unsupported",
        source: "user_input_pattern.preference_statement",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.82,
        entityRefs: ["contact.owen"],
        tags: ["followup"]
      },
      {
        title: "Owen fell down",
        summary: "Model-assisted episode extraction.",
        sourceTaskId: "task_truth_governance_episode_assistant_live",
        source: "language_understanding.episode_extraction",
        sourceKind: "assistant_inference",
        sensitive: false,
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.82,
        entityRefs: ["contact.owen"],
        tags: ["followup"]
      },
      {
        title: "Owen fell down",
        summary: "Unsupported assistant episode source.",
        sourceTaskId: "task_truth_governance_episode_assistant_unsupported",
        source: "assistant.generated_episode",
        sourceKind: "assistant_inference",
        sensitive: false,
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.82,
        entityRefs: ["contact.owen"],
        tags: ["followup"]
      }
    ],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.episodeDecisions.map((entry) => entry.decision),
    [
      {
        family: "episode.candidate",
        evidenceClass: "user_explicit_episode",
        action: "allow_episode_support",
        reason: "explicit_user_episode"
      },
      {
        family: "episode.candidate",
        evidenceClass: "user_explicit_episode",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "episode.candidate",
        evidenceClass: "assistant_inference",
        action: "allow_episode_support",
        reason: "assistant_inference_episode"
      },
      {
        family: "episode.candidate",
        evidenceClass: "assistant_inference",
        action: "quarantine",
        reason: "unsupported_source"
      }
    ]
  );
  assert.equal(result.allowedEpisodeCandidates.length, 2);
  assert.equal(result.quarantinedEpisodeCandidates.length, 2);
});

test("truth governance classifies unsupported structured and projection episode candidates by source prefix", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [],
    episodeCandidates: [
      {
        title: "Owen fell down",
        summary: "Structured episode candidate.",
        sourceTaskId: "task_truth_governance_episode_structured",
        source: "conversation.episode_candidate_interpretation",
        sourceKind: "assistant_inference",
        sensitive: false,
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.84,
        entityRefs: ["contact.owen"],
        tags: ["followup"]
      },
      {
        title: "Owen fell down",
        summary: "Projected episode candidate.",
        sourceTaskId: "task_truth_governance_episode_projection",
        source: "profile_state_reconciliation.episode_candidate_refresh",
        sourceKind: "assistant_inference",
        sensitive: false,
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.84,
        entityRefs: ["contact.owen"],
        tags: ["followup"]
      }
    ],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.episodeDecisions.map((entry) => entry.decision),
    [
      {
        family: "episode.candidate",
        evidenceClass: "validated_structured_candidate",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "episode.candidate",
        evidenceClass: "reconciliation_or_projection",
        action: "quarantine",
        reason: "unsupported_source"
      }
    ]
  );
  assert.equal(result.allowedEpisodeCandidates.length, 0);
  assert.equal(result.quarantinedEpisodeCandidates.length, 2);
});

test("truth governance only allows the live inferred episode-resolution source", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [],
    episodeCandidates: [],
    episodeResolutionCandidates: [
      {
        episodeId: "episode_live_inferred",
        status: "resolved",
        sourceTaskId: "task_truth_governance_episode_resolution_live",
        source: "user_input_pattern.episode_resolution_inferred",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.88,
        summary: "Owen fell down: Owen is doing better now.",
        entityRefs: ["contact.owen"],
        openLoopRefs: [],
        tags: ["followup"]
      },
      {
        episodeId: "episode_structured",
        status: "resolved",
        sourceTaskId: "task_truth_governance_episode_resolution_structured",
        source: "conversation.episode_resolution_interpretation",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.9,
        summary: "Owen fell down: interpreted structured resolution.",
        entityRefs: ["contact.owen"],
        openLoopRefs: [],
        tags: ["followup"]
      },
      {
        episodeId: "episode_projection",
        status: "resolved",
        sourceTaskId: "task_truth_governance_episode_resolution_projection",
        source: "profile_state_reconciliation.episode_resolution_refresh",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.9,
        summary: "Owen fell down: projected resolution.",
        entityRefs: ["contact.owen"],
        openLoopRefs: [],
        tags: ["followup"]
      }
    ]
  });

  assert.deepEqual(
    result.episodeResolutionDecisions.map((entry) => entry.decision),
    [
      {
        family: "episode.resolution",
        evidenceClass: "assistant_inference",
        action: "allow_end_state",
        reason: "episode_resolution_end_state"
      },
      {
        family: "episode.resolution",
        evidenceClass: "validated_structured_candidate",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "episode.resolution",
        evidenceClass: "reconciliation_or_projection",
        action: "quarantine",
        reason: "unsupported_source"
      }
    ]
  );
  assert.equal(result.allowedEpisodeResolutionCandidates.length, 1);
  assert.equal(result.quarantinedEpisodeResolutionCandidates.length, 2);
});

test("truth governance quarantines unsupported fact sources", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: false,
        sourceTaskId: "task_truth_governance_quarantine",
        source: "assistant.generated_fact",
        observedAt: "2026-04-02T12:00:00.000Z",
        confidence: 0.61
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(result.factDecisions[0]?.decision, {
    family: "identity.preferred_name",
    evidenceClass: "assistant_inference",
    action: "quarantine",
    reason: "unsupported_source"
  });
  assert.equal(result.allowedCurrentStateFactCandidates.length, 0);
  assert.equal(result.quarantinedFactCandidates.length, 1);
});

test("truth governance only allows the live generic explicit fact source", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "favorite.editor",
        value: "Helix",
        sensitive: false,
        sourceTaskId: "task_truth_governance_generic_my_is",
        source: "user_input_pattern.my_is",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.91
      },
      {
        key: "favorite.editor",
        value: "Zed",
        sensitive: false,
        sourceTaskId: "task_truth_governance_generic_unsupported",
        source: "user_input_pattern.preference_statement",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.88
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.factDecisions.map((entry) => entry.decision),
    [
      {
        family: "generic.profile_fact",
        evidenceClass: "user_explicit_fact",
        action: "allow_current_state",
        reason: "legacy_fact_family_default"
      },
      {
        family: "generic.profile_fact",
        evidenceClass: "user_explicit_fact",
        action: "quarantine",
        reason: "unsupported_source"
      }
    ]
  );
  assert.equal(result.allowedCurrentStateFactCandidates.length, 1);
  assert.equal(result.quarantinedFactCandidates.length, 1);
});

test("truth governance quarantines unsupported structured current-state sources outside self identity", () => {
  const result = governProfileMemoryCandidates({
    factCandidates: [
      {
        key: "employment.current",
        value: "Northstar Creative",
        sensitive: false,
        sourceTaskId: "task_truth_governance_structured_employment",
        source: "conversation.employment_interpretation",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.93
      },
      {
        key: "contact.owen.relationship",
        value: "manager",
        sensitive: false,
        sourceTaskId: "task_truth_governance_structured_relationship",
        source: "conversation.relationship_interpretation",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.91
      },
      {
        key: "favorite.editor",
        value: "Helix",
        sensitive: false,
        sourceTaskId: "task_truth_governance_structured_generic",
        source: "conversation.preference_interpretation",
        observedAt: "2026-04-03T12:00:00.000Z",
        confidence: 0.88
      }
    ],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.deepEqual(
    result.factDecisions.map((entry) => entry.decision),
    [
      {
        family: "employment.current",
        evidenceClass: "validated_structured_candidate",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "contact.relationship",
        evidenceClass: "validated_structured_candidate",
        action: "quarantine",
        reason: "unsupported_source"
      },
      {
        family: "generic.profile_fact",
        evidenceClass: "validated_structured_candidate",
        action: "quarantine",
        reason: "unsupported_source"
      }
    ]
  );
  assert.equal(result.allowedCurrentStateFactCandidates.length, 0);
  assert.equal(result.quarantinedFactCandidates.length, 3);
});
