/**
 * @fileoverview Tests bounded temporal retrieval and synthesis for graph-backed profile memory.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSchemaEnvelopeV1 } from "../../src/core/schemaEnvelope";
import {
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
  createEmptyProfileMemoryState
} from "../../src/core/profileMemory";
import { createEmptyProfileMemoryGraphState } from "../../src/core/profileMemoryRuntime/profileMemoryGraphState";
import type { ProfileMemoryTemporalClaimFamilySlice } from "../../src/core/profileMemoryRuntime/profileMemoryTemporalQueryContracts";
import { queryProfileMemoryTemporalEvidence } from "../../src/core/profileMemoryRuntime/profileMemoryTemporalQueries";
import { synthesizeProfileMemoryTemporalEvidence } from "../../src/core/profileMemoryRuntime/profileMemoryTemporalSynthesis";

function buildState(input: {
  observations?: ReturnType<typeof createSchemaEnvelopeV1>[];
  claims?: ReturnType<typeof createSchemaEnvelopeV1>[];
  events?: ReturnType<typeof createSchemaEnvelopeV1>[];
}) {
  const updatedAt = "2026-04-09T16:00:00.000Z";
  return {
    ...createEmptyProfileMemoryState(),
    updatedAt,
    graph: {
      ...createEmptyProfileMemoryGraphState(updatedAt),
      observations: input.observations ?? [],
      claims: input.claims ?? [],
      events: input.events ?? []
    }
  };
}

function buildObservation(
  observationId: string,
  stableRefId: string | null,
  family: string,
  normalizedKey: string,
  normalizedValue: string,
  observedAt: string
) {
  return createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME, {
    observationId,
    stableRefId,
    family,
    normalizedKey,
    normalizedValue,
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: `${observationId}_task`,
    sourceFingerprint: `${observationId}_fingerprint`,
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: stableRefId?.startsWith("stable_contact_") ? [`contact.${stableRefId.replace("stable_contact_", "")}`] : []
  });
}

function buildClaim(input: {
  claimId: string;
  stableRefId: string;
  family: ProfileMemoryTemporalClaimFamilySlice["family"];
  normalizedKey: string;
  normalizedValue: string | null;
  assertedAt: string;
  sourceTier?: "explicit_user_statement" | "assistant_inference";
  derivedFromObservationIds?: readonly string[];
  validFrom?: string | null;
  validTo?: string | null;
  endedAt?: string | null;
  active?: boolean;
}) {
  return createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, {
    claimId: input.claimId,
    stableRefId: input.stableRefId,
    family: input.family,
    normalizedKey: input.normalizedKey,
    normalizedValue: input.normalizedValue,
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: `${input.claimId}_task`,
    sourceFingerprint: `${input.claimId}_fingerprint`,
    sourceTier: input.sourceTier ?? "explicit_user_statement",
    assertedAt: input.assertedAt,
    validFrom: input.validFrom ?? input.assertedAt,
    validTo: input.validTo ?? null,
    endedAt: input.endedAt ?? null,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [...(input.derivedFromObservationIds ?? [])],
    projectionSourceIds: [`projection_${input.claimId}`],
    entityRefIds: input.stableRefId.startsWith("stable_contact_")
      ? [`contact.${input.stableRefId.replace("stable_contact_", "")}`]
      : [],
    active: input.active ?? true
  });
}

function buildEvent(input: {
  eventId: string;
  stableRefId: string;
  title: string;
  summary: string;
  observedAt: string;
  derivedFromObservationIds?: readonly string[];
  validTo?: string | null;
}) {
  return createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
    eventId: input.eventId,
    stableRefId: input.stableRefId,
    family: "episode.candidate",
    title: input.title,
    summary: input.summary,
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: `${input.eventId}_task`,
    sourceFingerprint: `${input.eventId}_fingerprint`,
    sourceTier: "explicit_user_statement",
    assertedAt: input.observedAt,
    observedAt: input.observedAt,
    validFrom: input.observedAt,
    validTo: input.validTo ?? null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [...(input.derivedFromObservationIds ?? [])],
    projectionSourceIds: [`projection_${input.eventId}`],
    entityRefIds: input.stableRefId.startsWith("stable_contact_")
      ? [`contact.${input.stableRefId.replace("stable_contact_", "")}`]
      : []
  });
}

test("queryProfileMemoryTemporalEvidence returns bounded slices without deriving a winner", () => {
  const stableRefId = "stable_contact_owen";
  const supportingObservationIds = ["obs1", "obs2", "obs3", "obs4", "obs5"];
  const state = buildState({
    observations: supportingObservationIds.map((observationId, index) =>
      buildObservation(
        observationId,
        stableRefId,
        "contact.work_association",
        "contact.owen.work_association",
        `Lantern ${index}`,
        `2026-04-0${index + 1}T10:00:00.000Z`
      )
    ),
    claims: Array.from({ length: 7 }, (_, index) =>
      buildClaim({
        claimId: `claim_${index + 1}`,
        stableRefId,
        family: "contact.work_association",
        normalizedKey: "contact.owen.work_association",
        normalizedValue: `Lantern ${index + 1}`,
        assertedAt: `2026-04-0${Math.min(index + 1, 9)}T12:00:00.000Z`,
        derivedFromObservationIds: supportingObservationIds
      })
    ),
    events: Array.from({ length: 4 }, (_, index) =>
      buildEvent({
        eventId: `event_${index + 1}`,
        stableRefId,
        title: `Owen event ${index + 1}`,
        summary: `Owen event summary ${index + 1}`,
        observedAt: `2026-04-1${index}T09:00:00.000Z`,
        derivedFromObservationIds: supportingObservationIds
      })
    )
  });

  const slice = queryProfileMemoryTemporalEvidence(state, {
    semanticMode: "relationship_inventory",
    relevanceScope: "global_profile",
    entityHints: ["Owen"],
    queryText: "What is going on with Owen?"
  });

  assert.equal(slice.focusEntities.length, 1);
  assert.equal(slice.focusEntities[0]?.claimFamilies.length, 1);
  assert.equal(slice.focusEntities[0]?.claimFamilies[0]?.claims.length, 6);
  assert.equal(slice.focusEntities[0]?.eventSlice.events.length, 3);
  assert.equal(
    slice.focusEntities[0]?.claimFamilies[0]?.claims[0]?.supportingObservationIds.length,
    4
  );
  assert.equal("proof" in slice, false);
  assert.match(
    slice.focusEntities[0]?.degradedNotes.join("\n") ?? "",
    /bounded_overflow/
  );
});

test("synthesizeProfileMemoryTemporalEvidence prefers higher-authority truth and keeps contradictions explicit", () => {
  const stableRefId = "stable_contact_owen";
  const state = buildState({
    observations: [
      buildObservation(
        "obs_owen_work",
        stableRefId,
        "contact.work_association",
        "contact.owen.work_association",
        "Lantern Studio",
        "2026-04-01T10:00:00.000Z"
      )
    ],
    claims: [
      buildClaim({
        claimId: "claim_owen_lantern",
        stableRefId,
        family: "contact.work_association",
        normalizedKey: "contact.owen.work_association",
        normalizedValue: "Lantern Studio",
        assertedAt: "2026-04-01T10:00:00.000Z",
        derivedFromObservationIds: ["obs_owen_work"]
      }),
      buildClaim({
        claimId: "claim_owen_harbor",
        stableRefId,
        family: "contact.work_association",
        normalizedKey: "contact.owen.work_association",
        normalizedValue: "Harbor Labs",
        assertedAt: "2026-04-02T10:00:00.000Z",
        sourceTier: "assistant_inference"
      })
    ]
  });

  const synthesis = synthesizeProfileMemoryTemporalEvidence(
    queryProfileMemoryTemporalEvidence(state, {
      semanticMode: "relationship_inventory",
      relevanceScope: "global_profile",
      entityHints: ["Owen"],
      queryText: "Where does Owen work now?"
    })
  );

  assert.equal(synthesis.answerMode, "ambiguous");
  assert.deepEqual(synthesis.currentState, [
    "contact.work_association: Lantern Studio"
  ]);
  assert.equal(synthesis.contradictionNotes.length, 1);
  assert.equal(
    synthesis.laneMetadata[0]?.chosenClaimId,
    "claim_owen_lantern"
  );
  assert.deepEqual(synthesis.laneMetadata[0]?.rejectedClaims, [
    {
      claimId: "claim_owen_harbor",
      reason: "lower_source_authority"
    }
  ]);
});

test("synthesizeProfileMemoryTemporalEvidence fails closed for quarantined focus identities", () => {
  const state = buildState({
    claims: [
      buildClaim({
        claimId: "claim_quarantine",
        stableRefId: "stable_quarantine_contact_owen",
        family: "contact.relationship",
        normalizedKey: "contact.owen.relationship",
        normalizedValue: "friend",
        assertedAt: "2026-04-01T10:00:00.000Z"
      })
    ]
  });

  const synthesis = synthesizeProfileMemoryTemporalEvidence(
    queryProfileMemoryTemporalEvidence(state, {
      semanticMode: "identity",
      relevanceScope: "conversation_local",
      entityHints: ["Owen"],
      queryText: "Who is Owen again?"
    })
  );

  assert.equal(synthesis.answerMode, "quarantined_identity");
  assert.deepEqual(synthesis.currentState, []);
  assert.equal(synthesis.laneMetadata[0]?.answerMode, "quarantined_identity");
});

test("synthesizeProfileMemoryTemporalEvidence marks same-name cross-focus matches ambiguous", () => {
  const state = buildState({
    claims: [
      buildClaim({
        claimId: "claim_jordan_northstar",
        stableRefId: "stable_contact_jordan",
        family: "contact.work_association",
        normalizedKey: "contact.jordan.work_association",
        normalizedValue: "Northstar",
        assertedAt: "2026-04-01T10:00:00.000Z"
      }),
      buildClaim({
        claimId: "claim_jordan_ember",
        stableRefId: "stable_contact_jordan_ember",
        family: "contact.work_association",
        normalizedKey: "contact.jordan_ember.work_association",
        normalizedValue: "Ember",
        assertedAt: "2026-04-02T10:00:00.000Z"
      })
    ]
  });

  const synthesis = synthesizeProfileMemoryTemporalEvidence(
    queryProfileMemoryTemporalEvidence(state, {
      semanticMode: "relationship_inventory",
      relevanceScope: "conversation_local",
      entityHints: ["Jordan"],
      queryText: "What about Jordan?"
    })
  );

  assert.equal(synthesis.answerMode, "ambiguous");
  assert.match(synthesis.contradictionNotes[0] ?? "", /multiple people match jordan/i);
  assert.deepEqual(synthesis.currentState, [
    "contact.work_association: Northstar",
    "contact.work_association: Ember"
  ]);
});

test("synthesizeProfileMemoryTemporalEvidence honors as-of boundaries for historical answers", () => {
  const state = buildState({
    claims: [
      buildClaim({
        claimId: "claim_old_job",
        stableRefId: "stable_self_profile_owner",
        family: "employment.current",
        normalizedKey: "employment.current",
        normalizedValue: "Old Lantern",
        assertedAt: "2026-01-01T10:00:00.000Z",
        validFrom: "2026-01-01T10:00:00.000Z",
        validTo: "2026-02-01T10:00:00.000Z",
        endedAt: "2026-02-01T10:00:00.000Z",
        active: false
      })
    ]
  });

  const synthesis = synthesizeProfileMemoryTemporalEvidence(
    queryProfileMemoryTemporalEvidence(state, {
      semanticMode: "identity",
      relevanceScope: "global_profile",
      entityHints: [],
      queryText: "Where did I work before?",
      asOfValidTime: "2026-03-01T00:00:00.000Z",
      asOfObservedTime: "2026-03-01T00:00:00.000Z"
    })
  );

  assert.equal(synthesis.answerMode, "historical");
  assert.deepEqual(synthesis.currentState, []);
  assert.deepEqual(synthesis.historicalContext, [
    "employment.current (historical): Old Lantern"
  ]);
  assert.equal(synthesis.proof.asOfValidTime, "2026-03-01T00:00:00.000Z");
});

test("synthesizeProfileMemoryTemporalEvidence preserves prior winners for preserve-prior singular conflicts", () => {
  const state = buildState({
    claims: [
      buildClaim({
        claimId: "claim_self_employer_one",
        stableRefId: "stable_self_profile_owner",
        family: "employment.current",
        normalizedKey: "employment.current",
        normalizedValue: "Lantern",
        assertedAt: "2026-04-01T10:00:00.000Z"
      }),
      buildClaim({
        claimId: "claim_self_employer_two",
        stableRefId: "stable_self_profile_owner",
        family: "employment.current",
        normalizedKey: "employment.current",
        normalizedValue: "Harbor",
        assertedAt: "2026-04-02T10:00:00.000Z"
      })
    ]
  });

  const synthesis = synthesizeProfileMemoryTemporalEvidence(
    queryProfileMemoryTemporalEvidence(state, {
      semanticMode: "identity",
      relevanceScope: "thread_local",
      entityHints: [],
      queryText: "Where do I work?"
    })
  );

  assert.equal(synthesis.answerMode, "ambiguous");
  assert.deepEqual(synthesis.currentState, [
    "employment.current: Lantern"
  ]);
  assert.match(synthesis.contradictionNotes[0] ?? "", /keeping prior current value Lantern/i);
  assert.equal(synthesis.laneMetadata[0]?.chosenClaimId, "claim_self_employer_one");
  assert.deepEqual(synthesis.laneMetadata[0]?.rejectedClaims, [
    {
      claimId: "claim_self_employer_two",
      reason: "prior_winner_retained"
    }
  ]);
});

test("synthesizeProfileMemoryTemporalEvidence advances authoritative successors for replace-successor families", () => {
  const state = buildState({
    claims: [
      buildClaim({
        claimId: "claim_name_old",
        stableRefId: "stable_self_profile_owner",
        family: "identity.preferred_name",
        normalizedKey: "identity.preferred_name",
        normalizedValue: "Ben",
        assertedAt: "2026-04-01T10:00:00.000Z"
      }),
      buildClaim({
        claimId: "claim_name_new",
        stableRefId: "stable_self_profile_owner",
        family: "identity.preferred_name",
        normalizedKey: "identity.preferred_name",
        normalizedValue: "Benjamin",
        assertedAt: "2026-04-02T10:00:00.000Z"
      })
    ]
  });

  const synthesis = synthesizeProfileMemoryTemporalEvidence(
    queryProfileMemoryTemporalEvidence(state, {
      semanticMode: "identity",
      relevanceScope: "thread_local",
      entityHints: [],
      queryText: "What name should I use?"
    })
  );

  assert.equal(synthesis.answerMode, "current");
  assert.deepEqual(synthesis.currentState, [
    "identity.preferred_name: Benjamin"
  ]);
  assert.deepEqual(synthesis.contradictionNotes, []);
  assert.equal(synthesis.laneMetadata[0]?.chosenClaimId, "claim_name_new");
  assert.deepEqual(synthesis.laneMetadata[0]?.rejectedClaims, [
    {
      claimId: "claim_name_old",
      reason: "authoritative_successor"
    }
  ]);
});

test("queryProfileMemoryTemporalEvidence exposes lifecycle bucket overflow for event history inventories", () => {
  const stableRefId = "stable_contact_owen";
  const state = buildState({
    events: [
      buildEvent({
        eventId: "event_current_1",
        stableRefId,
        title: "Open issue one",
        summary: "Still unresolved.",
        observedAt: "2026-04-01T10:00:00.000Z"
      }),
      buildEvent({
        eventId: "event_current_2",
        stableRefId,
        title: "Open issue two",
        summary: "Still unresolved.",
        observedAt: "2026-04-02T10:00:00.000Z"
      }),
      buildEvent({
        eventId: "event_current_3",
        stableRefId,
        title: "Open issue three",
        summary: "Still unresolved.",
        observedAt: "2026-04-03T10:00:00.000Z"
      }),
      buildEvent({
        eventId: "event_old",
        stableRefId,
        title: "Closed issue",
        summary: "Already resolved.",
        observedAt: "2026-03-01T10:00:00.000Z",
        validTo: "2026-03-02T10:00:00.000Z"
      })
    ]
  });

  const slice = queryProfileMemoryTemporalEvidence(state, {
    semanticMode: "event_history",
    relevanceScope: "global_profile",
    entityHints: ["Owen"],
    queryText: "What happened with Owen?",
    caps: {
      maxEventsPerFocusEntity: 3
    }
  });

  assert.equal(slice.focusEntities[0]?.eventSlice.events.length, 3);
  assert.match(
    slice.focusEntities[0]?.eventSlice.lifecycleBuckets.overflowNote ?? "",
    /bounded_overflow/
  );
});

test("global truth, local relevance keeps synthesis truth stable across scope changes", () => {
  const state = buildState({
    claims: [
      buildClaim({
        claimId: "claim_self_name",
        stableRefId: "stable_self_profile_owner",
        family: "identity.preferred_name",
        normalizedKey: "identity.preferred_name",
        normalizedValue: "Avery",
        assertedAt: "2026-04-01T10:00:00.000Z"
      })
    ]
  });

  const globalSynthesis = synthesizeProfileMemoryTemporalEvidence(
    queryProfileMemoryTemporalEvidence(state, {
      semanticMode: "identity",
      relevanceScope: "global_profile",
      entityHints: [],
      queryText: "What's my name?"
    })
  );
  const threadLocalSynthesis = synthesizeProfileMemoryTemporalEvidence(
    queryProfileMemoryTemporalEvidence(state, {
      semanticMode: "identity",
      relevanceScope: "thread_local",
      entityHints: [],
      queryText: "What's my name?"
    })
  );

  assert.deepEqual(threadLocalSynthesis.currentState, globalSynthesis.currentState);
  assert.equal(threadLocalSynthesis.answerMode, globalSynthesis.answerMode);
});

test("queryProfileMemoryTemporalEvidence enforces default focus-entity and claim-family caps", () => {
  const state = buildState({
    claims: [
      buildClaim({
        claimId: "claim_owen_name",
        stableRefId: "stable_contact_owen",
        family: "contact.name",
        normalizedKey: "contact.owen.name",
        normalizedValue: "Owen",
        assertedAt: "2026-04-01T10:00:00.000Z"
      }),
      buildClaim({
        claimId: "claim_owen_relationship",
        stableRefId: "stable_contact_owen",
        family: "contact.relationship",
        normalizedKey: "contact.owen.relationship",
        normalizedValue: "friend",
        assertedAt: "2026-04-01T10:05:00.000Z"
      }),
      buildClaim({
        claimId: "claim_owen_work",
        stableRefId: "stable_contact_owen",
        family: "contact.work_association",
        normalizedKey: "contact.owen.work_association",
        normalizedValue: "Lantern",
        assertedAt: "2026-04-01T10:10:00.000Z"
      }),
      buildClaim({
        claimId: "claim_owen_school",
        stableRefId: "stable_contact_owen",
        family: "contact.school_association",
        normalizedKey: "contact.owen.school_association",
        normalizedValue: "State U",
        assertedAt: "2026-04-01T10:15:00.000Z"
      }),
      buildClaim({
        claimId: "claim_owen_context",
        stableRefId: "stable_contact_owen",
        family: "contact.context",
        normalizedKey: "contact.owen.context",
        normalizedValue: "met via launch prep",
        assertedAt: "2026-04-01T10:20:00.000Z"
      }),
      buildClaim({
        claimId: "claim_owen_hint",
        stableRefId: "stable_contact_owen",
        family: "contact.entity_hint",
        normalizedKey: "contact.owen.entity_hint",
        normalizedValue: "Owen",
        assertedAt: "2026-04-01T10:25:00.000Z"
      }),
      buildClaim({
        claimId: "claim_sarah_name",
        stableRefId: "stable_contact_sarah",
        family: "contact.name",
        normalizedKey: "contact.sarah.name",
        normalizedValue: "Sarah",
        assertedAt: "2026-04-01T11:00:00.000Z"
      }),
      buildClaim({
        claimId: "claim_milo_name",
        stableRefId: "stable_contact_milo",
        family: "contact.name",
        normalizedKey: "contact.milo.name",
        normalizedValue: "Milo",
        assertedAt: "2026-04-01T11:05:00.000Z"
      }),
      buildClaim({
        claimId: "claim_nora_name",
        stableRefId: "stable_contact_nora",
        family: "contact.name",
        normalizedKey: "contact.nora.name",
        normalizedValue: "Nora",
        assertedAt: "2026-04-01T11:10:00.000Z"
      })
    ]
  });

  const slice = queryProfileMemoryTemporalEvidence(state, {
    semanticMode: "relationship_inventory",
    relevanceScope: "global_profile",
    entityHints: ["Owen Sarah Milo Nora"],
    queryText: "What do you remember about Owen Sarah Milo Nora?"
  });
  const owenFocusEntity = slice.focusEntities.find((focusEntity) => focusEntity.stableRefId === "stable_contact_owen");

  assert.equal(slice.focusEntities.length, 3);
  assert.equal(owenFocusEntity?.claimFamilies.length, 5);
  assert.match(slice.degradedNotes.join("\n"), /focus entities omitted/);
  assert.match(owenFocusEntity?.degradedNotes.join("\n") ?? "", /claim families omitted/);
});

test("synthesizeProfileMemoryTemporalEvidence caps contradiction notes and exposes insufficient evidence explicitly", () => {
  const state = buildState({
    claims: [
      buildClaim({
        claimId: "claim_owen_old",
        stableRefId: "stable_contact_owen",
        family: "contact.relationship",
        normalizedKey: "contact.owen.relationship",
        normalizedValue: "friend",
        assertedAt: "2026-04-01T10:00:00.000Z"
      }),
      buildClaim({
        claimId: "claim_owen_new",
        stableRefId: "stable_contact_owen",
        family: "contact.relationship",
        normalizedKey: "contact.owen.relationship",
        normalizedValue: "coworker",
        assertedAt: "2026-04-02T10:00:00.000Z"
      }),
      buildClaim({
        claimId: "claim_sarah_old",
        stableRefId: "stable_contact_sarah",
        family: "contact.relationship",
        normalizedKey: "contact.sarah.relationship",
        normalizedValue: "friend",
        assertedAt: "2026-04-01T11:00:00.000Z"
      }),
      buildClaim({
        claimId: "claim_sarah_new",
        stableRefId: "stable_contact_sarah",
        family: "contact.relationship",
        normalizedKey: "contact.sarah.relationship",
        normalizedValue: "manager",
        assertedAt: "2026-04-02T11:00:00.000Z"
      }),
      buildClaim({
        claimId: "claim_milo_old",
        stableRefId: "stable_contact_milo",
        family: "contact.relationship",
        normalizedKey: "contact.milo.relationship",
        normalizedValue: "friend",
        assertedAt: "2026-04-01T12:00:00.000Z"
      }),
      buildClaim({
        claimId: "claim_milo_new",
        stableRefId: "stable_contact_milo",
        family: "contact.relationship",
        normalizedKey: "contact.milo.relationship",
        normalizedValue: "neighbor",
        assertedAt: "2026-04-02T12:00:00.000Z"
      })
    ]
  });

  const boundedSynthesis = synthesizeProfileMemoryTemporalEvidence(
    queryProfileMemoryTemporalEvidence(state, {
      semanticMode: "relationship_inventory",
      relevanceScope: "global_profile",
      entityHints: ["Owen Sarah Milo"],
      queryText: "What is my relationship to Owen Sarah Milo?"
    })
  );
  const insufficientSynthesis = synthesizeProfileMemoryTemporalEvidence(
    queryProfileMemoryTemporalEvidence(buildState({}), {
      semanticMode: "identity",
      relevanceScope: "thread_local",
      entityHints: ["Unknown person"],
      queryText: "Do you know Unknown person?"
    })
  );

  assert.equal(boundedSynthesis.contradictionNotes.length, 2);
  assert.equal(insufficientSynthesis.answerMode, "insufficient_evidence");
  assert.deepEqual(insufficientSynthesis.currentState, []);
  assert.deepEqual(insufficientSynthesis.historicalContext, []);
});

test("synthesizeProfileMemoryTemporalEvidence treats ended claims as historical transition instead of live contradiction", () => {
  const state = buildState({
    claims: [
      buildClaim({
        claimId: "claim_old_employer",
        stableRefId: "stable_self_profile_owner",
        family: "employment.current",
        normalizedKey: "employment.current",
        normalizedValue: "Old Lantern",
        assertedAt: "2026-01-01T10:00:00.000Z",
        validFrom: "2026-01-01T10:00:00.000Z",
        validTo: "2026-02-01T10:00:00.000Z",
        endedAt: "2026-02-01T10:00:00.000Z",
        active: false
      }),
      buildClaim({
        claimId: "claim_current_employer",
        stableRefId: "stable_self_profile_owner",
        family: "employment.current",
        normalizedKey: "employment.current",
        normalizedValue: "Harbor Labs",
        assertedAt: "2026-03-01T10:00:00.000Z"
      })
    ]
  });

  const synthesis = synthesizeProfileMemoryTemporalEvidence(
    queryProfileMemoryTemporalEvidence(state, {
      semanticMode: "identity",
      relevanceScope: "global_profile",
      entityHints: [],
      queryText: "Where do I work now and where did I work before?"
    })
  );

  assert.equal(synthesis.answerMode, "current");
  assert.deepEqual(synthesis.currentState, [
    "employment.current: Harbor Labs"
  ]);
  assert.deepEqual(synthesis.historicalContext, [
    "employment.current (historical): Old Lantern"
  ]);
  assert.deepEqual(synthesis.contradictionNotes, []);
});

test("queryProfileMemoryTemporalEvidence keeps higher-authority active claims inside bounded family caps", () => {
  const stableRefId = "stable_contact_owen";
  const state = buildState({
    observations: [
      buildObservation(
        "obs_authoritative_1",
        stableRefId,
        "contact.work_association",
        "contact.owen.work_association",
        "Lantern Studio",
        "2026-04-01T09:00:00.000Z"
      ),
      buildObservation(
        "obs_authoritative_2",
        stableRefId,
        "contact.work_association",
        "contact.owen.work_association",
        "Lantern Studio",
        "2026-04-01T09:05:00.000Z"
      )
    ],
    claims: [
      buildClaim({
        claimId: "claim_authoritative",
        stableRefId,
        family: "contact.work_association",
        normalizedKey: "contact.owen.work_association",
        normalizedValue: "Lantern Studio",
        assertedAt: "2026-04-01T10:00:00.000Z",
        derivedFromObservationIds: ["obs_authoritative_1", "obs_authoritative_2"]
      }),
      buildClaim({
        claimId: "claim_inference_1",
        stableRefId,
        family: "contact.work_association",
        normalizedKey: "contact.owen.work_association",
        normalizedValue: "Harbor Labs",
        assertedAt: "2026-04-02T10:00:00.000Z",
        sourceTier: "assistant_inference"
      }),
      buildClaim({
        claimId: "claim_inference_2",
        stableRefId,
        family: "contact.work_association",
        normalizedKey: "contact.owen.work_association",
        normalizedValue: "Pier Nine",
        assertedAt: "2026-04-03T10:00:00.000Z",
        sourceTier: "assistant_inference"
      }),
      buildClaim({
        claimId: "claim_inference_3",
        stableRefId,
        family: "contact.work_association",
        normalizedKey: "contact.owen.work_association",
        normalizedValue: "Northstar",
        assertedAt: "2026-04-04T10:00:00.000Z",
        sourceTier: "assistant_inference"
      }),
      buildClaim({
        claimId: "claim_inference_4",
        stableRefId,
        family: "contact.work_association",
        normalizedKey: "contact.owen.work_association",
        normalizedValue: "Riverpoint",
        assertedAt: "2026-04-05T10:00:00.000Z",
        sourceTier: "assistant_inference"
      })
    ]
  });

  const slice = queryProfileMemoryTemporalEvidence(state, {
    semanticMode: "relationship_inventory",
    relevanceScope: "global_profile",
    entityHints: ["Owen"],
    queryText: "Where does Owen work now?",
    caps: {
      maxCandidateClaimsPerFamily: 3
    }
  });
  const selectedClaimIds =
    slice.focusEntities[0]?.claimFamilies[0]?.claims.map((claim) => claim.claimId) ?? [];
  const synthesis = synthesizeProfileMemoryTemporalEvidence(slice);

  assert.equal(selectedClaimIds.length, 3);
  assert.equal(selectedClaimIds.includes("claim_authoritative"), true);
  assert.equal(synthesis.laneMetadata[0]?.chosenClaimId, "claim_authoritative");
  assert.deepEqual(synthesis.currentState, [
    "contact.work_association: Lantern Studio"
  ]);
});

test("synthesizeProfileMemoryTemporalEvidence uses salience ordering only after governance gates", () => {
  const state = buildState({
    observations: [
      buildObservation(
        "obs_supported_1",
        "stable_self_profile_owner",
        "identity.preferred_name",
        "identity.preferred_name",
        "Ben",
        "2026-04-01T09:00:00.000Z"
      ),
      buildObservation(
        "obs_supported_2",
        "stable_self_profile_owner",
        "identity.preferred_name",
        "identity.preferred_name",
        "Ben",
        "2026-04-01T09:05:00.000Z"
      )
    ],
    claims: [
      buildClaim({
        claimId: "claim_supported_name",
        stableRefId: "stable_self_profile_owner",
        family: "identity.preferred_name",
        normalizedKey: "identity.preferred_name",
        normalizedValue: "Ben",
        assertedAt: "2026-04-01T10:00:00.000Z",
        derivedFromObservationIds: ["obs_supported_1", "obs_supported_2"]
      }),
      buildClaim({
        claimId: "claim_thin_name",
        stableRefId: "stable_self_profile_owner",
        family: "identity.preferred_name",
        normalizedKey: "identity.preferred_name",
        normalizedValue: "Benjamin",
        assertedAt: "2026-04-02T10:00:00.000Z",
        derivedFromObservationIds: ["obs_supported_1"]
      })
    ]
  });

  const synthesis = synthesizeProfileMemoryTemporalEvidence(
    queryProfileMemoryTemporalEvidence(state, {
      semanticMode: "identity",
      relevanceScope: "global_profile",
      entityHints: [],
      queryText: "What name should I use?"
    })
  );

  assert.equal(synthesis.answerMode, "current");
  assert.deepEqual(synthesis.currentState, [
    "identity.preferred_name: Ben"
  ]);
  assert.equal(synthesis.laneMetadata[0]?.chosenClaimId, "claim_supported_name");
  assert.deepEqual(synthesis.laneMetadata[0]?.rejectedClaims, [
    {
      claimId: "claim_thin_name",
      reason: "authoritative_successor"
    }
  ]);
});

test("queryProfileMemoryTemporalEvidence keeps higher-authority events inside bounded event caps", () => {
  const stableRefId = "stable_contact_owen";
  const state = buildState({
    observations: [
      buildObservation(
        "obs_event_authoritative_1",
        stableRefId,
        "episode.candidate",
        "episode.owen_project",
        "Lantern launch blocker",
        "2026-04-01T08:00:00.000Z"
      ),
      buildObservation(
        "obs_event_authoritative_2",
        stableRefId,
        "episode.candidate",
        "episode.owen_project",
        "Lantern launch blocker",
        "2026-04-01T08:05:00.000Z"
      )
    ],
    events: [
      buildEvent({
        eventId: "event_authoritative",
        stableRefId,
        title: "Lantern launch blocker",
        summary: "Owen said the launch is blocked on approvals.",
        observedAt: "2026-04-01T10:00:00.000Z",
        derivedFromObservationIds: [
          "obs_event_authoritative_1",
          "obs_event_authoritative_2"
        ]
      }),
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
        eventId: "event_inference_1",
        stableRefId,
        family: "episode.candidate",
        title: "Harbor follow-up",
        summary: "A possible Harbor follow-up might be needed.",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "event_inference_1_task",
        sourceFingerprint: "event_inference_1_fingerprint",
        sourceTier: "assistant_inference",
        assertedAt: "2026-04-02T10:00:00.000Z",
        observedAt: "2026-04-02T10:00:00.000Z",
        validFrom: "2026-04-02T10:00:00.000Z",
        validTo: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["projection_event_inference_1"],
        entityRefIds: ["contact.owen"]
      }),
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
        eventId: "event_inference_2",
        stableRefId,
        family: "episode.candidate",
        title: "Pier Nine follow-up",
        summary: "A possible Pier Nine follow-up might be needed.",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "event_inference_2_task",
        sourceFingerprint: "event_inference_2_fingerprint",
        sourceTier: "assistant_inference",
        assertedAt: "2026-04-03T10:00:00.000Z",
        observedAt: "2026-04-03T10:00:00.000Z",
        validFrom: "2026-04-03T10:00:00.000Z",
        validTo: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["projection_event_inference_2"],
        entityRefIds: ["contact.owen"]
      }),
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
        eventId: "event_inference_3",
        stableRefId,
        family: "episode.candidate",
        title: "Northstar follow-up",
        summary: "A possible Northstar follow-up might be needed.",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "event_inference_3_task",
        sourceFingerprint: "event_inference_3_fingerprint",
        sourceTier: "assistant_inference",
        assertedAt: "2026-04-04T10:00:00.000Z",
        observedAt: "2026-04-04T10:00:00.000Z",
        validFrom: "2026-04-04T10:00:00.000Z",
        validTo: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["projection_event_inference_3"],
        entityRefIds: ["contact.owen"]
      }),
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
        eventId: "event_inference_4",
        stableRefId,
        family: "episode.candidate",
        title: "Riverpoint follow-up",
        summary: "A possible Riverpoint follow-up might be needed.",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "event_inference_4_task",
        sourceFingerprint: "event_inference_4_fingerprint",
        sourceTier: "assistant_inference",
        assertedAt: "2026-04-05T10:00:00.000Z",
        observedAt: "2026-04-05T10:00:00.000Z",
        validFrom: "2026-04-05T10:00:00.000Z",
        validTo: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["projection_event_inference_4"],
        entityRefIds: ["contact.owen"]
      })
    ]
  });

  const slice = queryProfileMemoryTemporalEvidence(state, {
    semanticMode: "event_history",
    relevanceScope: "global_profile",
    entityHints: ["Owen"],
    queryText: "What is still happening with Owen?",
    caps: {
      maxEventsPerFocusEntity: 3
    }
  });
  const selectedEventIds =
    slice.focusEntities[0]?.eventSlice.events.map((event) => event.eventId) ?? [];
  const synthesis = synthesizeProfileMemoryTemporalEvidence(slice);

  assert.equal(selectedEventIds.length, 3);
  assert.equal(selectedEventIds.includes("event_authoritative"), true);
  assert.match(synthesis.currentState.join("\n"), /Lantern launch blocker/);
});

test("synthesizeProfileMemoryTemporalEvidence exposes degraded notes when supporting evidence recovery is incomplete", () => {
  const state = buildState({
    claims: [
      buildClaim({
        claimId: "claim_missing_support",
        stableRefId: "stable_self_profile_owner",
        family: "identity.preferred_name",
        normalizedKey: "identity.preferred_name",
        normalizedValue: "Avery",
        assertedAt: "2026-04-01T10:00:00.000Z",
        derivedFromObservationIds: ["obs_missing_support"]
      })
    ]
  });

  const slice = queryProfileMemoryTemporalEvidence(state, {
    semanticMode: "identity",
    relevanceScope: "global_profile",
    entityHints: [],
    queryText: "What name should I use?"
  });
  const synthesis = synthesizeProfileMemoryTemporalEvidence(slice);

  assert.match(
    slice.focusEntities[0]?.degradedNotes.join("\n") ?? "",
    /missing_supporting_observation:obs_missing_support/
  );
  assert.match(
    synthesis.proof.degradedNotes.join("\n"),
    /missing_supporting_observation:obs_missing_support/
  );
  assert.match(
    synthesis.laneMetadata[0]?.degradedNotes.join("\n") ?? "",
    /missing_supporting_observation:obs_missing_support/
  );
});
