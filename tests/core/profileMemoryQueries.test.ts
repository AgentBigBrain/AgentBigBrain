/**
 * @fileoverview Tests profile-memory runtime query helpers for bounded planning context and approval-gated fact reads.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSchemaEnvelopeV1 } from "../../src/core/schemaEnvelope";
import {
  createEmptyProfileMemoryState,
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
  upsertTemporalProfileFact
} from "../../src/core/profileMemory";
import { buildEntityKey, createEmptyEntityGraphV1 } from "../../src/core/stage6_86EntityGraph";
import { normalizeProfileMemoryGraphState } from "../../src/core/profileMemoryRuntime/profileMemoryGraphState";
import {
  buildProfilePlanningContext,
  inspectProfileFactsForPlanningContext,
  inspectProfileFactQuery,
  queryProfileFactsForContinuity,
  readProfileFacts,
  reviewProfileFactsForUser
} from "../../src/core/profileMemoryRuntime/profileMemoryQueries";
import { createEmptyConversationStackV1 } from "../../src/core/stage6_86ConversationStack";

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

test("query and planning surfaces follow graph-backed compatibility authority over orphaned flat facts", () => {
  const updatedAt = "2026-04-10T13:00:00.000Z";
  const state = {
    ...createEmptyProfileMemoryState(),
    updatedAt,
    facts: [
      {
        id: "fact_authoritative_owen_work",
        key: "contact.owen.work_association",
        value: "Lantern Studio",
        sensitive: false,
        status: "confirmed" as const,
        confidence: 0.92,
        sourceTaskId: "task_profile_query_authoritative_work",
        source: "user_input_pattern.work_with_contact",
        observedAt: updatedAt,
        confirmedAt: updatedAt,
        supersededAt: null,
        lastUpdatedAt: updatedAt
      },
      {
        id: "fact_orphaned_owen_work",
        key: "contact.owen.work_association",
        value: "Beacon Labs",
        sensitive: false,
        status: "confirmed" as const,
        confidence: 0.94,
        sourceTaskId: "task_profile_query_orphaned_work",
        source: "user_input_pattern.work_with_contact",
        observedAt: updatedAt,
        confirmedAt: updatedAt,
        supersededAt: null,
        lastUpdatedAt: updatedAt
      }
    ],
    graph: normalizeProfileMemoryGraphState(
      {
        updatedAt,
        observations: [
          createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME, {
            observationId: "observation_authoritative_owen_work",
            stableRefId: "stable_contact_owen",
            family: "contact.work_association",
            normalizedKey: "contact.owen.work_association",
            normalizedValue: "Lantern Studio",
            sensitive: false,
            sourceTaskId: "task_profile_query_authoritative_work",
            sourceFingerprint: "fingerprint_authoritative_owen_work",
            sourceTier: "explicit_user_statement",
            assertedAt: updatedAt,
            observedAt: updatedAt,
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: [buildEntityKey("contact", "owen")]
          })
        ],
        claims: [
          createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, {
            claimId: "claim_authoritative_owen_work",
            stableRefId: "stable_contact_owen",
            family: "contact.work_association",
            normalizedKey: "contact.owen.work_association",
            normalizedValue: "Lantern Studio",
            sensitive: false,
            sourceTaskId: "task_profile_query_authoritative_work",
            sourceFingerprint: "fingerprint_authoritative_owen_work",
            sourceTier: "explicit_user_statement",
            assertedAt: updatedAt,
            validFrom: updatedAt,
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_authoritative_owen_work"],
            projectionSourceIds: ["fact_authoritative_owen_work"],
            entityRefIds: [buildEntityKey("contact", "owen")],
            active: true
          })
        ],
        events: []
      },
      updatedAt,
      [],
      []
    )
  };

  const readableFacts = readProfileFacts(state, {
    purpose: "operator_view",
    includeSensitive: false,
    explicitHumanApproval: false
  });
  const planningContext = buildProfilePlanningContext(state, 4, "where does Owen work?");
  const inspection = inspectProfileFactQuery(state, {
    queryInput: "where does Owen work?",
    maxFacts: 4
  });

  assert.deepEqual(
    readableFacts.map((fact) => fact.value),
    ["Lantern Studio"]
  );
  assert.match(planningContext, /Lantern Studio/);
  assert.doesNotMatch(planningContext, /Beacon Labs/);
  assert.deepEqual(
    inspection.selectedFacts.map((fact) => fact.value),
    ["Lantern Studio"]
  );
});

test("registry sensitivity floors hide residence facts even when legacy state marked them non-sensitive", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "employment.current",
    value: "Lantern",
    sensitive: false,
    sourceTaskId: "task_profile_query_residence_floor_employment",
    source: "test",
    observedAt: "2026-04-03T00:00:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "residence.current",
    value: "Detroit",
    sensitive: false,
    sourceTaskId: "task_profile_query_residence_floor_residence",
    source: "user_input_pattern.residence",
    observedAt: "2026-04-03T00:01:00.000Z",
    confidence: 0.95
  }).nextState;

  const readableWithoutApproval = readProfileFacts(state, {
    purpose: "operator_view",
    includeSensitive: false,
    explicitHumanApproval: false
  });
  const readableWithApproval = readProfileFacts(state, {
    purpose: "operator_view",
    includeSensitive: true,
    explicitHumanApproval: true,
    approvalId: "approval_profile_query_residence_floor"
  });
  const planningContext = buildProfilePlanningContext(state, 4, "");

  assert.equal(
    readableWithoutApproval.some((fact) => fact.key === "residence.current"),
    false
  );
  assert.equal(
    readableWithApproval.some(
      (fact) => fact.key === "residence.current" && fact.value === "Detroit"
    ),
    true
  );
  assert.equal(
    readableWithApproval.some(
      (fact) =>
        fact.key === "residence.current" &&
        fact.value === "Detroit" &&
        fact.sensitive === true
    ),
    true
  );
  assert.equal(planningContext.includes("residence.current: Detroit"), false);
  assert.equal(planningContext.includes("employment.current: Lantern"), true);
});

test("generic sensitive-key facts stay approval-gated even when legacy state marked them non-sensitive", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "employment.current",
    value: "Lantern",
    sensitive: false,
    sourceTaskId: "task_profile_query_generic_floor_employment",
    source: "test",
    observedAt: "2026-04-03T00:00:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "email.address",
    value: "avery@example.com",
    sensitive: false,
    sourceTaskId: "task_profile_query_generic_floor_email",
    source: "user_input_pattern.my_is",
    observedAt: "2026-04-03T00:01:00.000Z",
    confidence: 0.95
  }).nextState;

  const readableWithoutApproval = readProfileFacts(state, {
    purpose: "operator_view",
    includeSensitive: true,
    explicitHumanApproval: false
  });
  const readableWithApproval = readProfileFacts(state, {
    purpose: "operator_view",
    includeSensitive: true,
    explicitHumanApproval: true,
    approvalId: "approval_profile_query_generic_floor"
  });
  const planningContext = buildProfilePlanningContext(state, 4, "what is my email?");
  const continuityFacts = queryProfileFactsForContinuity(state, {
    entityHints: ["email"],
    maxFacts: 4
  });
  const reviewWithoutApproval = reviewProfileFactsForUser(state, {
    queryInput: "email",
    maxFacts: 4,
    includeSensitive: true,
    explicitHumanApproval: false
  });
  const reviewWithApproval = reviewProfileFactsForUser(state, {
    queryInput: "email",
    maxFacts: 4,
    includeSensitive: true,
    explicitHumanApproval: true,
    approvalId: "approval_profile_review_generic_floor"
  });

  assert.equal(
    readableWithoutApproval.some((fact) => fact.key === "email.address"),
    false
  );
  assert.equal(
    readableWithApproval.some(
      (fact) =>
        fact.key === "email.address" &&
        fact.value === "avery@example.com" &&
        fact.sensitive === true
    ),
    true
  );
  assert.equal(planningContext.includes("email.address"), false);
  assert.equal(planningContext.includes("avery@example.com"), false);
  assert.equal(
    continuityFacts.some((fact) => fact.key === "email.address"),
    false
  );
  assert.equal(
    reviewWithoutApproval.entries.some((entry) => entry.fact.key === "email.address"),
    false
  );
  assert.equal(
    reviewWithApproval.entries.some(
      (entry) =>
        entry.fact.key === "email.address" &&
        entry.fact.sensitive === true &&
        entry.decisionRecord.disposition === "selected_current_state"
    ),
    true
  );
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

test("queryProfileFactsForContinuity expands continuity hints through the shared entity graph and returns typed temporal metadata", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "contact.william_bena.name",
    value: "William Bena",
    sensitive: false,
    sourceTaskId: "task_profile_query_continuity_graph_name",
    source: "test",
    observedAt: "2026-04-09T10:00:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.william_bena.work_association",
    value: "Lantern Studio",
    sensitive: false,
    sourceTaskId: "task_profile_query_continuity_graph_work",
    source: "test",
    observedAt: "2026-04-09T10:01:00.000Z",
    confidence: 0.94
  }).nextState;
  state = {
    ...state,
    graph: normalizeProfileMemoryGraphState(
      state.graph,
      "2026-04-09T10:02:00.000Z",
      state.episodes,
      state.facts
    )
  };

  const graph = {
    ...createEmptyEntityGraphV1("2026-04-09T10:02:00.000Z"),
    entities: [
      {
        entityKey: buildEntityKey("William Bena", "person", null),
        canonicalName: "William Bena",
        aliases: ["Owen"],
        entityType: "person",
        memoryStatus: "active",
        domainHint: "relationship",
        evidenceRefs: [],
        createdAt: "2026-04-09T10:02:00.000Z",
        updatedAt: "2026-04-09T10:02:00.000Z"
      }
    ]
  };
  const stack = {
    ...createEmptyConversationStackV1("2026-04-09T10:03:00.000Z"),
    activeThreadKey: "thread_owen",
    threads: [
      {
        threadKey: "thread_owen",
        topicKey: "topic_owen",
        topicLabel: "Owen follow-up",
        state: "active",
        resumeHint: "Need to remember who Owen is and how we know him.",
        openLoops: [],
        lastTouchedAt: "2026-04-09T10:03:00.000Z"
      }
    ],
    topics: [
      {
        topicKey: "topic_owen",
        label: "Owen follow-up",
        firstSeenAt: "2026-04-09T10:03:00.000Z",
        lastSeenAt: "2026-04-09T10:03:00.000Z",
        mentionCount: 1
      }
    ]
  };

  const continuityFacts = queryProfileFactsForContinuity(
    state,
    graph,
    {
      entityHints: ["Owen"],
      semanticMode: "relationship_inventory",
      relevanceScope: "conversation_local",
      maxFacts: 3
    },
    stack
  );

  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "contact.william_bena.work_association" &&
        fact.value === "Lantern Studio"
    ),
    true
  );
  assert.equal(continuityFacts.semanticMode, "relationship_inventory");
  assert.equal(continuityFacts.relevanceScope, "conversation_local");
  assert.deepEqual(continuityFacts.scopedThreadKeys, ["thread_owen"]);
  assert.ok(continuityFacts.temporalSynthesis);
  assert.ok(
    continuityFacts.temporalSynthesis?.laneMetadata.some(
      (lane) => lane.family === "contact.work_association"
    )
  );
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

test("inspectProfileFactQuery emits bounded decision records for selected support history and hidden corroboration facts", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "contact.sarah.name",
    value: "Sarah",
    sensitive: false,
    sourceTaskId: "task_profile_query_inspect_hint_name",
    source: "user_input_pattern.contact_entity_hint",
    observedAt: "2026-04-03T00:12:00.000Z",
    confidence: 0.75
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.sarah.context.abc12345",
    value: "I know Sarah from yoga.",
    sensitive: false,
    sourceTaskId: "task_profile_query_inspect_context",
    source: "user_input_pattern.contact_context",
    observedAt: "2026-04-03T00:11:00.000Z",
    confidence: 0.95
  }).nextState;

  const inspection = inspectProfileFactQuery(state, {
    queryInput: "who is Sarah?",
    maxFacts: 4,
    asOfValidTime: "2026-04-03T01:00:00.000Z",
    asOfObservedTime: "2026-04-03T00:30:00.000Z"
  });

  assert.equal(inspection.selectedFacts.length, 1);
  assert.equal(inspection.selectedFacts[0]?.key, "contact.sarah.context.abc12345");
  assert.deepEqual(inspection.decisionRecords, [
    {
      family: "contact.entity_hint",
      evidenceClass: "user_hint_or_context",
      governanceAction: "support_only_legacy",
      governanceReason: "contact_entity_hint_requires_corroboration",
      disposition: "needs_corroboration",
      answerModeFallback: "report_insufficient_evidence",
      candidateRefs: [state.facts[0]!.id],
      evidenceRefs: [state.facts[0]!.id],
      asOfValidTime: "2026-04-03T01:00:00.000Z",
      asOfObservedTime: "2026-04-03T00:30:00.000Z"
    },
    {
      family: "contact.context",
      evidenceClass: "user_hint_or_context",
      governanceAction: "support_only_legacy",
      governanceReason: "contact_context_is_support_only",
      disposition: "selected_supporting_history",
      answerModeFallback: "report_supporting_history",
      candidateRefs: [state.facts[1]!.id],
      evidenceRefs: [state.facts[1]!.id],
      asOfValidTime: "2026-04-03T01:00:00.000Z",
      asOfObservedTime: "2026-04-03T00:30:00.000Z"
    }
  ]);
});

test("reviewProfileFactsForUser surfaces approval-aware sensitive facts plus hidden corroboration decisions", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "residence.current",
    value: "Detroit",
    sensitive: false,
    sourceTaskId: "task_profile_review_fact_residence",
    source: "user_input_pattern.residence",
    observedAt: "2026-04-03T01:00:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.sarah.name",
    value: "Sarah",
    sensitive: false,
    sourceTaskId: "task_profile_review_fact_hint_name",
    source: "user_input_pattern.contact_entity_hint",
    observedAt: "2026-04-03T01:01:00.000Z",
    confidence: 0.75
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.sarah.context.abc12345",
    value: "I know Sarah from yoga.",
    sensitive: false,
    sourceTaskId: "task_profile_review_fact_context",
    source: "user_input_pattern.contact_context",
    observedAt: "2026-04-03T01:02:00.000Z",
    confidence: 0.95
  }).nextState;

  const review = reviewProfileFactsForUser(state, {
    queryInput: "Sarah Detroit",
    maxFacts: 4,
    includeSensitive: true,
    explicitHumanApproval: true,
    approvalId: "approval_profile_review_fact_1",
    asOfValidTime: "2026-04-03T02:00:00.000Z",
    asOfObservedTime: "2026-04-03T01:30:00.000Z"
  });

  assert.equal(review.entries.length, 2);
  assert.deepEqual(
    review.entries.map((entry) => ({
      key: entry.fact.key,
      sensitive: entry.fact.sensitive,
      disposition: entry.decisionRecord.disposition
    })),
    [
      {
        key: "contact.sarah.context.abc12345",
        sensitive: false,
        disposition: "selected_supporting_history"
      },
      {
        key: "residence.current",
        sensitive: true,
        disposition: "selected_current_state"
      }
    ]
  );
  assert.deepEqual(review.hiddenDecisionRecords, [
    {
      family: "contact.entity_hint",
      evidenceClass: "user_hint_or_context",
      governanceAction: "support_only_legacy",
      governanceReason: "contact_entity_hint_requires_corroboration",
      disposition: "needs_corroboration",
      answerModeFallback: "report_insufficient_evidence",
      candidateRefs: [state.facts[1]!.id],
      evidenceRefs: [state.facts[1]!.id],
      asOfValidTime: "2026-04-03T02:00:00.000Z",
      asOfObservedTime: "2026-04-03T01:30:00.000Z"
    }
  ]);
});

test("reviewProfileFactsForUser keeps registry-forced sensitive families hidden without explicit approval", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "residence.current",
    value: "Detroit",
    sensitive: false,
    sourceTaskId: "task_profile_review_fact_residence_hidden",
    source: "user_input_pattern.residence",
    observedAt: "2026-04-03T03:00:00.000Z",
    confidence: 0.95
  }).nextState;

  const review = reviewProfileFactsForUser(state, {
    queryInput: "Detroit",
    maxFacts: 3,
    includeSensitive: true,
    explicitHumanApproval: false
  });

  assert.deepEqual(review.entries, []);
  assert.deepEqual(review.hiddenDecisionRecords, []);
});

test("inspectProfileFactsForPlanningContext returns selected facts plus bounded decision records", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.name",
    value: "Owen",
    sensitive: false,
    sourceTaskId: "task_profile_query_planning_inspection_name",
    source: "user_input_pattern.named_contact",
    observedAt: "2026-04-03T00:00:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.work_association",
    value: "Lantern Studio",
    sensitive: false,
    sourceTaskId: "task_profile_query_planning_inspection_work",
    source: "user_input_pattern.work_with_contact",
    observedAt: "2026-04-03T00:01:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.sarah.name",
    value: "Sarah",
    sensitive: false,
    sourceTaskId: "task_profile_query_planning_inspection_hint",
    source: "user_input_pattern.contact_entity_hint",
    observedAt: "2026-04-03T00:02:00.000Z",
    confidence: 0.7
  }).nextState;

  const inspection = inspectProfileFactsForPlanningContext(state, {
    queryInput: "who is Owen?",
    maxFacts: 3,
    asOfObservedTime: "2026-04-03T00:03:00.000Z"
  });

  assert.equal(inspection.entries.length, 2);
  assert.equal(inspection.entries[0]?.fact.key, "contact.owen.name");
  assert.equal(inspection.entries[1]?.fact.key, "contact.owen.work_association");
  assert.equal(
    inspection.entries.every(
      (entry) => entry.decisionRecord.asOfObservedTime === "2026-04-03T00:03:00.000Z"
    ),
    true
  );
  assert.equal(inspection.hiddenDecisionRecords.length, 1);
  assert.equal(inspection.hiddenDecisionRecords[0]?.family, "contact.entity_hint");
  assert.equal(inspection.hiddenDecisionRecords[0]?.disposition, "needs_corroboration");
});

test("planning and continuity selectors cap multi-value contact context under registry inventory policy", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "identity.preferred_name",
    value: "Benny",
    sensitive: false,
    sourceTaskId: "task_profile_query_inventory_identity",
    source: "test",
    observedAt: "2026-04-03T00:30:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.name",
    value: "Owen",
    sensitive: false,
    sourceTaskId: "task_profile_query_inventory_name",
    source: "test",
    observedAt: "2026-04-03T00:31:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.context.ctx001",
    value: "Owen said the launch slipped.",
    sensitive: false,
    sourceTaskId: "task_profile_query_inventory_context_1",
    source: "user_input_pattern.contact_context",
    observedAt: "2026-04-03T00:32:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.context.ctx002",
    value: "Owen prefers late meetings.",
    sensitive: false,
    sourceTaskId: "task_profile_query_inventory_context_2",
    source: "user_input_pattern.contact_context",
    observedAt: "2026-04-03T00:33:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.context.ctx003",
    value: "Owen mentioned the Harbor client.",
    sensitive: false,
    sourceTaskId: "task_profile_query_inventory_context_3",
    source: "user_input_pattern.contact_context",
    observedAt: "2026-04-03T00:34:00.000Z",
    confidence: 0.95
  }).nextState;

  const planningContext = buildProfilePlanningContext(state, 5, "what about Owen?");
  const continuityFacts = queryProfileFactsForContinuity(state, {
    entityHints: ["Owen"],
    maxFacts: 5
  });
  const planningContextLines = planningContext
    .split("\n")
    .filter((line) => line.startsWith("- "));
  const planningContextEntries = planningContextLines.filter((line) =>
    line.includes("contact.owen.context.")
  );
  const continuityContextFacts = continuityFacts.filter((fact) =>
    fact.key.startsWith("contact.owen.context.")
  );

  assert.equal(planningContext.includes("identity.preferred_name: Benny"), true);
  assert.equal(planningContext.includes("contact.owen.name: Owen"), true);
  assert.equal(planningContextEntries.length, 2);
  assert.equal(planningContextLines.length, 4);
  assert.equal(continuityContextFacts.length, 2);
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

test("queryProfileFactsForContinuity uses thread-local scope to recover the active-thread person without explicit entity hints", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "contact.milo.name",
    value: "Milo",
    sensitive: false,
    sourceTaskId: "task_profile_query_scope_fact_name_milo",
    source: "test",
    observedAt: "2026-04-09T16:00:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.milo.work_association",
    value: "Northstar Creative",
    sensitive: false,
    sourceTaskId: "task_profile_query_scope_fact_work_milo",
    source: "test",
    observedAt: "2026-04-09T16:01:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.nora.name",
    value: "Nora",
    sensitive: false,
    sourceTaskId: "task_profile_query_scope_fact_name_nora",
    source: "test",
    observedAt: "2026-04-09T16:02:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.nora.work_association",
    value: "Riverpoint Labs",
    sensitive: false,
    sourceTaskId: "task_profile_query_scope_fact_work_nora",
    source: "test",
    observedAt: "2026-04-09T16:03:00.000Z",
    confidence: 0.95
  }).nextState;

  const stack = {
    schemaVersion: "v1",
    updatedAt: "2026-04-09T16:04:00.000Z",
    activeThreadKey: "thread_milo",
    threads: [
      {
        threadKey: "thread_milo",
        topicKey: "topic_milo",
        topicLabel: "Milo at Northstar Creative",
        state: "active",
        resumeHint: "You mentioned working with Milo at Northstar Creative.",
        openLoops: [
          {
            loopId: "loop_milo",
            threadKey: "thread_milo",
            entityRefs: ["Milo", "Northstar Creative"],
            createdAt: "2026-04-09T16:04:00.000Z",
            lastMentionedAt: "2026-04-09T16:04:00.000Z",
            priority: 1,
            status: "open"
          }
        ],
        lastTouchedAt: "2026-04-09T16:04:00.000Z"
      },
      {
        threadKey: "thread_build",
        topicKey: "topic_build",
        topicLabel: "Build the landing page",
        state: "paused",
        resumeHint: "Keep refining the landing page build.",
        openLoops: [],
        lastTouchedAt: "2026-04-09T16:03:30.000Z"
      }
    ],
    topics: []
  } as const;

  const continuityFacts = queryProfileFactsForContinuity(
    state,
    {
      entityHints: [],
      relevanceScope: "thread_local",
      maxFacts: 2
    },
    stack
  );

  assert.equal(
    continuityFacts.some(
      (fact) =>
        fact.key === "contact.milo.work_association" &&
        fact.value === "Northstar Creative"
    ),
    true
  );
  assert.equal(
    continuityFacts[0]?.key.startsWith("contact.milo."),
    true
  );
});
