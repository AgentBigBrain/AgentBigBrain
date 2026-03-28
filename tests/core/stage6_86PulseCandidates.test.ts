/**
 * @fileoverview Tests deterministic Stage 6.86 pulse candidate generation and suppression behavior for checkpoint 6.86.E.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConversationStackFromTurnsV1 } from "../../src/core/stage6_86ConversationStack";
import { upsertOpenLoopOnConversationStackV1 } from "../../src/core/stage6_86OpenLoops";
import {
  evaluatePulseCandidatesV1
} from "../../src/core/stage6_86PulseCandidates";
import { createEmptyEntityGraphV1 } from "../../src/core/stage6_86EntityGraph";
import { ConversationStackV1, EntityGraphV1 } from "../../src/core/types";

/**
 * Implements `buildCheckpointFixture` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildCheckpointFixture(): { graph: EntityGraphV1; stack: ConversationStackV1 } {
  const graph: EntityGraphV1 = {
    schemaVersion: "v1",
    updatedAt: "2025-10-01T00:00:00.000Z",
    entities: [
      {
        entityKey: "entity_owen",
        canonicalName: "Owen",
        entityType: "person",
        disambiguator: null,
        aliases: ["Owen"],
        firstSeenAt: "2025-10-01T00:00:00.000Z",
        lastSeenAt: "2026-02-25T00:00:00.000Z",
        salience: 6,
        evidenceRefs: ["trace:entity_owen"]
      },
      {
        entityKey: "entity_lantern_labs",
        canonicalName: "Lantern Labs",
        entityType: "org",
        disambiguator: null,
        aliases: ["Lantern Labs"],
        firstSeenAt: "2025-10-01T00:00:00.000Z",
        lastSeenAt: "2026-02-20T00:00:00.000Z",
        salience: 5,
        evidenceRefs: ["trace:entity_lantern"]
      },
      {
        entityKey: "entity_project_aurora",
        canonicalName: "Project Aurora",
        entityType: "concept",
        disambiguator: null,
        aliases: ["Project Aurora"],
        firstSeenAt: "2025-10-01T00:00:00.000Z",
        lastSeenAt: "2026-01-15T00:00:00.000Z",
        salience: 4,
        evidenceRefs: ["trace:entity_aurora"]
      }
    ],
    edges: [
      {
        edgeKey: "edge_bridge_candidate",
        sourceEntityKey: "entity_lantern_labs",
        targetEntityKey: "entity_project_aurora",
        relationType: "co_mentioned",
        status: "uncertain",
        coMentionCount: 7,
        strength: 7,
        firstObservedAt: "2025-10-01T00:00:00.000Z",
        lastObservedAt: "2026-02-20T00:00:00.000Z",
        evidenceRefs: ["trace:edge_bridge_candidate"]
      },
      {
        edgeKey: "edge_stale_confirmed",
        sourceEntityKey: "entity_owen",
        targetEntityKey: "entity_lantern_labs",
        relationType: "coworker",
        status: "confirmed",
        coMentionCount: 6,
        strength: 6,
        firstObservedAt: "2025-10-01T00:00:00.000Z",
        lastObservedAt: "2025-11-01T00:00:00.000Z",
        evidenceRefs: ["trace:edge_stale_confirmed"]
      }
    ]
  };

  const seeded = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's review sprint backlog priorities.",
        at: "2026-02-27T09:00:00.000Z"
      },
      {
        role: "user",
        text: "Switch to budget runway assumptions.",
        at: "2026-02-28T09:00:00.000Z"
      }
    ],
    "2026-02-28T09:00:00.000Z"
  );
  const activeThreadKey = seeded.activeThreadKey;
  assert.ok(activeThreadKey);
  const withOpenLoop = upsertOpenLoopOnConversationStackV1({
    stack: seeded,
    threadKey: activeThreadKey!,
    text: "Remind me later to finalize budget runway assumptions.",
    observedAt: "2026-02-28T09:05:00.000Z",
    entityRefs: ["entity_lantern_labs"],
    priorityHint: 0.74
  });
  return {
    graph,
    stack: withOpenLoop.stack
  };
}

/**
 * Implements `generatesDeterministicPulseCandidatesFromAllPrimarySources` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function generatesDeterministicPulseCandidatesFromAllPrimarySources(): void {
  const fixture = buildCheckpointFixture();
  const first = evaluatePulseCandidatesV1({
    graph: fixture.graph,
    stack: fixture.stack,
    observedAt: "2026-03-01T12:00:00.000Z"
  });
  const second = evaluatePulseCandidatesV1({
    graph: fixture.graph,
    stack: fixture.stack,
    observedAt: "2026-03-01T12:00:00.000Z"
  });

  assert.deepEqual(first.orderedCandidates, second.orderedCandidates);
  const reasonCodes = new Set(first.orderedCandidates.map((candidate) => candidate.reasonCode));
  assert.ok(reasonCodes.has("OPEN_LOOP_RESUME"));
  assert.ok(reasonCodes.has("RELATIONSHIP_CLARIFICATION"));
  assert.ok(reasonCodes.has("TOPIC_DRIFT_RESUME"));
  assert.ok(reasonCodes.has("STALE_FACT_REVALIDATION"));
  assert.ok(reasonCodes.has("USER_REQUESTED_FOLLOWUP"));
}

/**
 * Implements `suppressesAllCandidatesWhenActiveMissionWorkExists` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function suppressesAllCandidatesWhenActiveMissionWorkExists(): void {
  const fixture = buildCheckpointFixture();
  const result = evaluatePulseCandidatesV1({
    graph: fixture.graph,
    stack: fixture.stack,
    observedAt: "2026-03-01T12:00:00.000Z",
    activeMissionWorkExists: true
  });

  assert.equal(result.emittedCandidate, null);
  assert.ok(
    result.decisions.every(
      (entry) =>
        entry.decision.decisionCode === "SUPPRESS" &&
        entry.decision.blockDetailReason === "DERAILS_ACTIVE_MISSION"
    )
  );
}

/**
 * Implements `suppressesCandidatesOnDailyCapAndIntervalCooldown` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function suppressesCandidatesOnDailyCapAndIntervalCooldown(): void {
  const graph = {
    ...createEmptyEntityGraphV1("2026-03-01T00:00:00.000Z"),
    entities: [
      {
        entityKey: "entity_lantern_ops",
        canonicalName: "Lantern Ops",
        entityType: "org" as const,
        disambiguator: null,
        aliases: ["Lantern Ops"],
        firstSeenAt: "2026-02-20T00:00:00.000Z",
        lastSeenAt: "2026-03-01T11:55:00.000Z",
        salience: 5,
        evidenceRefs: ["trace:lantern_ops"]
      }
    ]
  };
  const stack = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's review infrastructure budgets.",
        at: "2026-03-01T11:00:00.000Z"
      }
    ],
    "2026-03-01T11:00:00.000Z"
  );
  const result = evaluatePulseCandidatesV1(
    {
      graph,
      stack,
      observedAt: "2026-03-01T12:00:00.000Z",
      recentPulseHistory: [
        {
          emittedAt: "2026-03-01T08:30:00.000Z",
          reasonCode: "USER_REQUESTED_FOLLOWUP",
          candidateEntityRefs: ["entity_lantern_ops"]
        },
        {
          emittedAt: "2026-03-01T10:30:00.000Z",
          reasonCode: "USER_REQUESTED_FOLLOWUP",
          candidateEntityRefs: ["entity_lantern_ops"]
        }
      ]
    },
    {
      pulseMaxPerDay: 2,
      pulseMinIntervalMinutes: 240
    }
  );

  assert.equal(result.emittedCandidate, null);
  assert.ok(
    result.decisions.some(
      (entry) =>
        entry.decision.decisionCode === "SUPPRESS" &&
        entry.decision.blockDetailReason === "PULSE_CAP_REACHED"
    )
  );
}

/**
 * Implements `suppressesPrivacySensitiveCandidatesDeterministically` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function suppressesPrivacySensitiveCandidatesDeterministically(): void {
  const fixture = buildCheckpointFixture();
  const result = evaluatePulseCandidatesV1({
    graph: fixture.graph,
    stack: fixture.stack,
    observedAt: "2026-03-01T12:00:00.000Z"
  });

  assert.ok(
    result.decisions.some(
      (entry) =>
        entry.candidate.entityRefs.includes("entity_owen") &&
        entry.decision.decisionCode === "SUPPRESS" &&
        entry.decision.blockDetailReason === "PRIVACY_SENSITIVE"
    )
  );
}

/**
 * Implements `suppressesBridgeCandidatesWhenBridgeCooldownActive` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function suppressesBridgeCandidatesWhenBridgeCooldownActive(): void {
  const fixture = buildCheckpointFixture();
  const result = evaluatePulseCandidatesV1(
    {
      graph: fixture.graph,
      stack: fixture.stack,
      observedAt: "2026-03-01T12:00:00.000Z",
      recentPulseHistory: [
        {
          emittedAt: "2026-02-25T12:00:00.000Z",
          reasonCode: "RELATIONSHIP_CLARIFICATION",
          candidateEntityRefs: ["entity_lantern_labs", "entity_project_aurora"]
        }
      ]
    },
    {
      bridgeCooldownDays: 14
    }
  );

  assert.ok(
    result.decisions.some(
      (entry) =>
        entry.candidate.reasonCode === "RELATIONSHIP_CLARIFICATION" &&
        entry.decision.decisionCode === "SUPPRESS" &&
        entry.decision.blockDetailReason === "BRIDGE_COOLDOWN_ACTIVE"
    )
  );
}

test(
  "stage 6.86 pulse candidates generate deterministic source coverage across entity bridge open-loop topic and stale-fact signals",
  generatesDeterministicPulseCandidatesFromAllPrimarySources
);
test(
  "stage 6.86 pulse candidates suppress emissions while active mission work exists",
  suppressesAllCandidatesWhenActiveMissionWorkExists
);
test(
  "stage 6.86 pulse candidates suppress on deterministic daily-cap and interval cooldown gates",
  suppressesCandidatesOnDailyCapAndIntervalCooldown
);
test(
  "stage 6.86 pulse candidates suppress privacy-sensitive entity-driven prompts",
  suppressesPrivacySensitiveCandidatesDeterministically
);
test(
  "stage 6.86 pulse candidates enforce deterministic bridge cooldown suppression",
  suppressesBridgeCandidatesWhenBridgeCooldownActive
);
