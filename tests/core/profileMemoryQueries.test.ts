/**
 * @fileoverview Tests profile-memory runtime query helpers for bounded planning context and approval-gated fact reads.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createEmptyProfileMemoryState,
  upsertTemporalProfileFact
} from "../../src/core/profileMemory";
import {
  buildProfilePlanningContext,
  queryProfileFactsForContinuity,
  readProfileFacts
} from "../../src/core/profileMemoryRuntime/profileMemoryQueries";

test("readProfileFacts hides sensitive facts without explicit approval", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "employment.current",
    value: "Lantern",
    sensitive: false,
    sourceTaskId: "task_profile_query_read_1",
    source: "test",
    observedAt: "2026-02-23T00:00:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "address",
    value: "123 Main Street",
    sensitive: true,
    sourceTaskId: "task_profile_query_read_2",
    source: "test",
    observedAt: "2026-02-23T00:01:00.000Z",
    confidence: 0.95
  }).nextState;

  const readable = readProfileFacts(state, {
    purpose: "operator_view",
    includeSensitive: true,
    explicitHumanApproval: false
  });

  assert.equal(readable.some((fact) => fact.key === "address"), false);
  assert.equal(readable.some((fact) => fact.key === "employment.current"), true);
});

test("readProfileFacts returns sensitive facts only with explicit operator approval", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "address",
    value: "123 Main Street",
    sensitive: true,
    sourceTaskId: "task_profile_query_read_approved",
    source: "test",
    observedAt: "2026-02-23T00:00:00.000Z",
    confidence: 0.95
  }).nextState;

  const readable = readProfileFacts(state, {
    purpose: "operator_view",
    includeSensitive: true,
    explicitHumanApproval: true,
    approvalId: "approval_profile_query_1"
  });

  assert.equal(readable.length, 1);
  assert.equal(readable[0]?.key, "address");
  assert.equal(readable[0]?.value, "123 Main Street");
});

test("buildProfilePlanningContext preserves query-aware non-sensitive grounding", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "employment.current",
    value: "Lantern",
    sensitive: false,
    sourceTaskId: "task_profile_query_context_1",
    source: "test",
    observedAt: "2026-02-24T00:00:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "address",
    value: "123 Main Street",
    sensitive: true,
    sourceTaskId: "task_profile_query_context_2",
    source: "test",
    observedAt: "2026-02-24T00:01:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.name",
    value: "Owen",
    sensitive: false,
    sourceTaskId: "task_profile_query_context_3",
    source: "test",
    observedAt: "2026-02-24T00:02:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.work_association",
    value: "Lantern Studio",
    sensitive: false,
    sourceTaskId: "task_profile_query_context_4",
    source: "test",
    observedAt: "2026-02-24T00:03:00.000Z",
    confidence: 0.95
  }).nextState;

  const planningContext = buildProfilePlanningContext(state, 4, "who is Owen?");

  assert.equal(planningContext.includes("contact.owen.name: Owen"), true);
  assert.equal(
    planningContext.includes("contact.owen.work_association: Lantern Studio"),
    true
  );
  assert.equal(planningContext.includes("employment.current: Lantern"), true);
  assert.equal(planningContext.includes("address"), false);
  assert.equal(planningContext.includes("123 Main Street"), false);
});

test("read and planning surfaces hide compatibility-unsafe legacy support-only facts", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.name",
    value: "Owen",
    sensitive: false,
    sourceTaskId: "task_profile_query_legacy_name",
    source: "test",
    observedAt: "2026-04-03T00:00:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.relationship",
    value: "work_peer",
    sensitive: false,
    sourceTaskId: "task_profile_query_legacy_relationship",
    source: "user_input_pattern.work_with_contact_historical",
    observedAt: "2026-04-03T00:01:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.school_association",
    value: "went_to_school_together",
    sensitive: false,
    sourceTaskId: "task_profile_query_legacy_school",
    source: "user_input_pattern.school_association",
    observedAt: "2026-04-03T00:02:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "employment.current",
    value: "Old Lantern",
    sensitive: false,
    sourceTaskId: "task_profile_query_legacy_employment",
    source: "user_input_pattern.work_at_historical",
    observedAt: "2026-04-03T00:03:00.000Z",
    confidence: 0.95
  }).nextState;

  const readable = readProfileFacts(state, {
    purpose: "operator_view",
    includeSensitive: false,
    explicitHumanApproval: false
  });
  const planningContext = buildProfilePlanningContext(state, 6, "who is Owen?");
  const continuityFacts = queryProfileFactsForContinuity(state, {
    entityHints: ["mia"],
    maxFacts: 6
  });

  assert.equal(readable.some((fact) => fact.key === "contact.owen.name"), true);
  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "contact.owen.relationship" &&
        fact.value === "work_peer"
    ),
    false
  );
  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "contact.owen.school_association" &&
        fact.value === "went_to_school_together"
    ),
    false
  );
  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "employment.current" &&
        fact.value === "Old Lantern"
    ),
    false
  );
  assert.equal(planningContext.includes("contact.owen.name: Owen"), true);
  assert.equal(planningContext.includes("contact.owen.relationship: work_peer"), false);
  assert.equal(
    planningContext.includes("contact.owen.school_association: went_to_school_together"),
    false
  );
  assert.equal(planningContext.includes("employment.current: Old Lantern"), false);
  assert.equal(
    continuityFacts.some((fact) => fact.key === "contact.owen.name" && fact.value === "Owen"),
    true
  );
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "contact.owen.relationship" &&
        fact.value === "work_peer"
    ),
    false
  );
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "contact.owen.school_association" &&
        fact.value === "went_to_school_together"
    ),
    false
  );
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "employment.current" &&
        fact.value === "Old Lantern"
    ),
    false
  );
});

test("read and planning surfaces hide corroboration-free contact entity hints while preserving bounded context", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "contact.sarah.name",
    value: "Sarah",
    sensitive: false,
    sourceTaskId: "task_profile_query_hint_name",
    source: "user_input_pattern.contact_entity_hint",
    observedAt: "2026-04-03T00:10:00.000Z",
    confidence: 0.75
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.sarah.context.abc12345",
    value: "I know Sarah from yoga.",
    sensitive: false,
    sourceTaskId: "task_profile_query_hint_context",
    source: "user_input_pattern.contact_context",
    observedAt: "2026-04-03T00:11:00.000Z",
    confidence: 0.95
  }).nextState;

  const readable = readProfileFacts(state, {
    purpose: "operator_view",
    includeSensitive: false,
    explicitHumanApproval: false
  });
  const planningContext = buildProfilePlanningContext(state, 4, "who is Sarah?");
  const continuityFacts = queryProfileFactsForContinuity(state, {
    entityHints: ["Sarah"],
    maxFacts: 4
  });

  assert.equal(
    readable.some((fact) => fact.key === "contact.sarah.name" && fact.value === "Sarah"),
    false
  );
  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "contact.sarah.context.abc12345" &&
        fact.value === "I know Sarah from yoga."
    ),
    true
  );
  assert.equal(planningContext.includes("contact.sarah.name: Sarah"), false);
  assert.equal(planningContext.includes("I know Sarah from yoga."), true);
  assert.equal(
    continuityFacts.some((fact) => fact.key === "contact.sarah.name" && fact.value === "Sarah"),
    false
  );
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "contact.sarah.context.abc12345" &&
        fact.value === "I know Sarah from yoga."
    ),
    true
  );
});

test("read and planning surfaces fail closed for malformed legacy contact-entity-hint facts", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "contact.sarah.relationship",
    value: "friend",
    sensitive: false,
    sourceTaskId: "task_profile_query_hint_relationship",
    source: "user_input_pattern.contact_entity_hint",
    observedAt: "2026-04-03T00:12:00.000Z",
    confidence: 0.75
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "employment.current",
    value: "Lantern Studio",
    sensitive: false,
    sourceTaskId: "task_profile_query_hint_employment",
    source: "user_input_pattern.contact_entity_hint",
    observedAt: "2026-04-03T00:13:00.000Z",
    confidence: 0.75
  }).nextState;

  const readable = readProfileFacts(state, {
    purpose: "operator_view",
    includeSensitive: false,
    explicitHumanApproval: false
  });
  const planningContext = buildProfilePlanningContext(state, 4, "who is Sarah?");
  const continuityFacts = queryProfileFactsForContinuity(state, {
    entityHints: ["Sarah"],
    maxFacts: 4
  });

  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "contact.sarah.relationship" &&
        fact.value === "friend"
    ),
    false
  );
  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "employment.current" &&
        fact.value === "Lantern Studio"
    ),
    false
  );
  assert.equal(planningContext.includes("contact.sarah.relationship: friend"), false);
  assert.equal(planningContext.includes("employment.current: Lantern Studio"), false);
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "contact.sarah.relationship" &&
        fact.value === "friend"
    ),
    false
  );
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "employment.current" &&
        fact.value === "Lantern Studio"
    ),
    false
  );
});

test("read and planning surfaces fail closed for malformed legacy contact-context facts", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "contact.sarah.context.abc12345",
    value: "I know Sarah from yoga.",
    sensitive: false,
    sourceTaskId: "task_profile_query_contact_context_good",
    source: "user_input_pattern.contact_context",
    observedAt: "2026-04-03T00:14:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.sarah.relationship",
    value: "friend",
    sensitive: false,
    sourceTaskId: "task_profile_query_contact_context_bad_relationship",
    source: "user_input_pattern.contact_context",
    observedAt: "2026-04-03T00:15:00.000Z",
    confidence: 0.75
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "employment.current",
    value: "Lantern Studio",
    sensitive: false,
    sourceTaskId: "task_profile_query_contact_context_bad_employment",
    source: "user_input_pattern.contact_context",
    observedAt: "2026-04-03T00:16:00.000Z",
    confidence: 0.75
  }).nextState;

  const readable = readProfileFacts(state, {
    purpose: "operator_view",
    includeSensitive: false,
    explicitHumanApproval: false
  });
  const planningContext = buildProfilePlanningContext(state, 4, "who is Sarah?");
  const continuityFacts = queryProfileFactsForContinuity(state, {
    entityHints: ["Sarah"],
    maxFacts: 4
  });

  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "contact.sarah.context.abc12345" &&
        fact.value === "I know Sarah from yoga."
    ),
    true
  );
  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "contact.sarah.relationship" &&
        fact.value === "friend"
    ),
    false
  );
  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "employment.current" &&
        fact.value === "Lantern Studio"
    ),
    false
  );
  assert.equal(planningContext.includes("I know Sarah from yoga."), true);
  assert.equal(planningContext.includes("contact.sarah.relationship: friend"), false);
  assert.equal(planningContext.includes("employment.current: Lantern Studio"), false);
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "contact.sarah.context.abc12345" &&
        fact.value === "I know Sarah from yoga."
    ),
    true
  );
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "contact.sarah.relationship" &&
        fact.value === "friend"
    ),
    false
  );
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "employment.current" &&
        fact.value === "Lantern Studio"
    ),
    false
  );
});

test("read and planning surfaces fail closed for malformed legacy school-association facts", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "contact.sarah.school_association",
    value: "went_to_school_together",
    sensitive: false,
    sourceTaskId: "task_profile_query_school_good",
    source: "user_input_pattern.school_association",
    observedAt: "2026-04-03T00:17:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.sarah.relationship",
    value: "classmate",
    sensitive: false,
    sourceTaskId: "task_profile_query_school_bad_relationship",
    source: "user_input_pattern.school_association",
    observedAt: "2026-04-03T00:18:00.000Z",
    confidence: 0.75
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "employment.current",
    value: "Lantern Studio",
    sensitive: false,
    sourceTaskId: "task_profile_query_school_bad_employment",
    source: "user_input_pattern.school_association",
    observedAt: "2026-04-03T00:19:00.000Z",
    confidence: 0.75
  }).nextState;

  const readable = readProfileFacts(state, {
    purpose: "operator_view",
    includeSensitive: false,
    explicitHumanApproval: false
  });
  const planningContext = buildProfilePlanningContext(state, 4, "who is Sarah?");
  const continuityFacts = queryProfileFactsForContinuity(state, {
    entityHints: ["Sarah"],
    maxFacts: 4
  });

  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "contact.sarah.school_association" &&
        fact.value === "went_to_school_together"
    ),
    false
  );
  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "contact.sarah.relationship" &&
        fact.value === "classmate"
    ),
    false
  );
  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "employment.current" &&
        fact.value === "Lantern Studio"
    ),
    false
  );
  assert.equal(
    planningContext.includes("contact.sarah.school_association: went_to_school_together"),
    false
  );
  assert.equal(planningContext.includes("contact.sarah.relationship: classmate"), false);
  assert.equal(planningContext.includes("employment.current: Lantern Studio"), false);
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "contact.sarah.school_association" &&
        fact.value === "went_to_school_together"
    ),
    false
  );
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "contact.sarah.relationship" &&
        fact.value === "classmate"
    ),
    false
  );
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "employment.current" &&
        fact.value === "Lantern Studio"
    ),
    false
  );
});

test("read and planning surfaces keep only contact identity for historical or severed contact-support sources", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.name",
    value: "Owen",
    sensitive: false,
    sourceTaskId: "task_profile_query_historical_contact_name",
    source: "user_input_pattern.direct_contact_relationship_historical",
    observedAt: "2026-04-03T00:20:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.relationship",
    value: "manager",
    sensitive: false,
    sourceTaskId: "task_profile_query_historical_contact_relationship",
    source: "user_input_pattern.direct_contact_relationship_historical",
    observedAt: "2026-04-03T00:21:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.work_association",
    value: "Lantern Studio",
    sensitive: false,
    sourceTaskId: "task_profile_query_historical_contact_work",
    source: "user_input_pattern.work_association_historical",
    observedAt: "2026-04-03T00:22:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "employment.current",
    value: "Lantern Studio",
    sensitive: false,
    sourceTaskId: "task_profile_query_historical_contact_bad_employment",
    source: "user_input_pattern.work_with_contact_severed",
    observedAt: "2026-04-03T00:23:00.000Z",
    confidence: 0.75
  }).nextState;

  const readable = readProfileFacts(state, {
    purpose: "operator_view",
    includeSensitive: false,
    explicitHumanApproval: false
  });
  const planningContext = buildProfilePlanningContext(state, 4, "who is Owen?");
  const continuityFacts = queryProfileFactsForContinuity(state, {
    entityHints: ["Owen"],
    maxFacts: 4
  });

  assert.equal(
    readable.some((fact) => fact.key === "contact.owen.name" && fact.value === "Owen"),
    true
  );
  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "contact.owen.relationship" &&
        fact.value === "manager"
    ),
    false
  );
  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "contact.owen.work_association" &&
        fact.value === "Lantern Studio"
    ),
    false
  );
  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "employment.current" &&
        fact.value === "Lantern Studio"
    ),
    false
  );
  assert.equal(planningContext.includes("contact.owen.name: Owen"), true);
  assert.equal(planningContext.includes("contact.owen.relationship: manager"), false);
  assert.equal(
    planningContext.includes("contact.owen.work_association: Lantern Studio"),
    false
  );
  assert.equal(planningContext.includes("employment.current: Lantern Studio"), false);
  assert.equal(
    continuityFacts.some((fact) => fact.key === "contact.owen.name" && fact.value === "Owen"),
    true
  );
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "contact.owen.relationship" &&
        fact.value === "manager"
    ),
    false
  );
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "contact.owen.work_association" &&
        fact.value === "Lantern Studio"
    ),
    false
  );
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "employment.current" &&
        fact.value === "Lantern Studio"
    ),
    false
  );
});

test("read and planning surfaces fail closed for malformed legacy self-historical facts", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "employment.current",
    value: "Old Lantern",
    sensitive: false,
    sourceTaskId: "task_profile_query_self_historical_work",
    source: "user_input_pattern.work_at_historical",
    observedAt: "2026-04-03T00:24:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "residence.current",
    value: "Detroit",
    sensitive: false,
    sourceTaskId: "task_profile_query_self_historical_residence",
    source: "user_input_pattern.residence_historical",
    observedAt: "2026-04-03T00:25:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.sarah.relationship",
    value: "friend",
    sensitive: false,
    sourceTaskId: "task_profile_query_self_historical_bad_relationship",
    source: "user_input_pattern.work_at_historical",
    observedAt: "2026-04-03T00:26:00.000Z",
    confidence: 0.75
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "identity.preferred_name",
    value: "Ben",
    sensitive: false,
    sourceTaskId: "task_profile_query_self_historical_bad_name",
    source: "user_input_pattern.residence_historical",
    observedAt: "2026-04-03T00:27:00.000Z",
    confidence: 0.75
  }).nextState;

  const readable = readProfileFacts(state, {
    purpose: "operator_view",
    includeSensitive: false,
    explicitHumanApproval: false
  });
  const planningContext = buildProfilePlanningContext(state, 4, "where did I live before?");
  const continuityFacts = queryProfileFactsForContinuity(state, {
    entityHints: ["Sarah"],
    maxFacts: 4
  });

  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "employment.current" &&
        fact.value === "Old Lantern"
    ),
    false
  );
  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "residence.current" &&
        fact.value === "Detroit"
    ),
    false
  );
  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "contact.sarah.relationship" &&
        fact.value === "friend"
    ),
    false
  );
  assert.equal(
    readable.some(
      (fact) =>
        fact.key === "identity.preferred_name" &&
        fact.value === "Ben"
    ),
    false
  );
  assert.equal(planningContext.includes("employment.current: Old Lantern"), false);
  assert.equal(planningContext.includes("residence.current: Detroit"), false);
  assert.equal(planningContext.includes("contact.sarah.relationship: friend"), false);
  assert.equal(planningContext.includes("identity.preferred_name: Ben"), false);
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "employment.current" &&
        fact.value === "Old Lantern"
    ),
    false
  );
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "residence.current" &&
        fact.value === "Detroit"
    ),
    false
  );
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "contact.sarah.relationship" &&
        fact.value === "friend"
    ),
    false
  );
  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "identity.preferred_name" &&
        fact.value === "Ben"
    ),
    false
  );
});
