/**
 * @fileoverview Runs Stage 6.86 checkpoint 6.86.E pulse-candidate checks and emits deterministic evidence.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildConversationStackFromTurnsV1 } from "../../src/core/stage6_86ConversationStack";
import { upsertOpenLoopOnConversationStackV1 } from "../../src/core/stage6_86OpenLoops";
import { evaluatePulseCandidatesV1 } from "../../src/core/stage6_86PulseCandidates";
import { EntityGraphV1 } from "../../src/core/types";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_86_pulse_candidates_report.json"
);

interface Stage686CheckpointEArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.86.E";
  candidateCoverage: {
    reasonCodes: readonly string[];
    includesOpenLoopResume: boolean;
    includesRelationshipClarification: boolean;
    includesTopicDriftResume: boolean;
    includesStaleFactRevalidation: boolean;
    includesUserRequestedFollowup: boolean;
  };
  ordering: {
    deterministicOrderPass: boolean;
    sortedTuplePass: boolean;
    topCandidateReason: string | null;
  };
  suppression: {
    missionSuppressionPass: boolean;
    cooldownSuppressionPass: boolean;
    capSuppressionPass: boolean;
    privacySuppressionPass: boolean;
    bridgeCooldownSuppressionPass: boolean;
  };
  passCriteria: {
    coveragePass: boolean;
    orderingPass: boolean;
    suppressionPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Implements `buildCheckpointGraph` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildCheckpointGraph(): EntityGraphV1 {
  return {
    schemaVersion: "v1",
    updatedAt: "2025-10-01T00:00:00.000Z",
    entities: [
      {
        entityKey: "entity_billy",
        canonicalName: "Billy",
        entityType: "person",
        disambiguator: null,
        aliases: ["Billy"],
        firstSeenAt: "2025-10-01T00:00:00.000Z",
        lastSeenAt: "2026-02-25T00:00:00.000Z",
        salience: 6,
        evidenceRefs: ["trace:entity_billy"]
      },
      {
        entityKey: "entity_flare_labs",
        canonicalName: "Flare Labs",
        entityType: "org",
        disambiguator: null,
        aliases: ["Flare Labs"],
        firstSeenAt: "2025-10-01T00:00:00.000Z",
        lastSeenAt: "2026-02-20T00:00:00.000Z",
        salience: 5,
        evidenceRefs: ["trace:entity_flare"]
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
        sourceEntityKey: "entity_flare_labs",
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
        sourceEntityKey: "entity_billy",
        targetEntityKey: "entity_flare_labs",
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
}

/**
 * Implements `buildCheckpointStack` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildCheckpointStack() {
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
  if (!activeThreadKey) {
    throw new Error("Checkpoint stack requires deterministic active thread.");
  }
  return upsertOpenLoopOnConversationStackV1({
    stack: seeded,
    threadKey: activeThreadKey,
    text: "Remind me later to finalize budget runway assumptions.",
    observedAt: "2026-02-28T09:05:00.000Z",
    entityRefs: ["entity_flare_labs"],
    priorityHint: 0.74
  }).stack;
}

/**
 * Implements `isSortedByDeterministicTuple` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isSortedByDeterministicTuple(
  candidates: readonly {
    score: number;
    reasonCode: string;
    lastTouchedAt: string;
    stableHash: string;
  }[]
): boolean {
  const reasonPriority = [
    "OPEN_LOOP_RESUME",
    "RELATIONSHIP_CLARIFICATION",
    "TOPIC_DRIFT_RESUME",
    "STALE_FACT_REVALIDATION",
    "USER_REQUESTED_FOLLOWUP",
    "SAFETY_HOLD"
  ];
  for (let index = 1; index < candidates.length; index += 1) {
    const previous = candidates[index - 1];
    const current = candidates[index];
    if (previous.score < current.score) {
      return false;
    }
    if (previous.score === current.score) {
      const previousPriority = reasonPriority.indexOf(previous.reasonCode);
      const currentPriority = reasonPriority.indexOf(current.reasonCode);
      if (previousPriority > currentPriority) {
        return false;
      }
      if (previousPriority === currentPriority) {
        if (previous.lastTouchedAt < current.lastTouchedAt) {
          return false;
        }
        if (previous.lastTouchedAt === current.lastTouchedAt) {
          if (previous.stableHash > current.stableHash) {
            return false;
          }
        }
      }
    }
  }
  return true;
}

/**
 * Implements `runStage686CheckpointE` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage686CheckpointE(): Promise<Stage686CheckpointEArtifact> {
  const graph = buildCheckpointGraph();
  const stack = buildCheckpointStack();
  const observedAt = "2026-03-01T12:00:00.000Z";

  const baselineA = evaluatePulseCandidatesV1({
    graph,
    stack,
    observedAt
  });
  const baselineB = evaluatePulseCandidatesV1({
    graph,
    stack,
    observedAt
  });
  const deterministicOrderPass =
    JSON.stringify(baselineA.orderedCandidates) === JSON.stringify(baselineB.orderedCandidates);
  const sortedTuplePass = isSortedByDeterministicTuple(baselineA.orderedCandidates);

  const reasonCodes = [...new Set(baselineA.orderedCandidates.map((candidate) => candidate.reasonCode))].sort(
    (left, right) => left.localeCompare(right)
  );

  const missionSuppressed = evaluatePulseCandidatesV1({
    graph,
    stack,
    observedAt,
    activeMissionWorkExists: true
  });
  const missionSuppressionPass = missionSuppressed.decisions.every(
    (entry) =>
      entry.decision.decisionCode === "SUPPRESS" &&
      entry.decision.blockDetailReason === "DERAILS_ACTIVE_MISSION"
  );

  const cooldownSuppressed = evaluatePulseCandidatesV1(
    {
      graph,
      stack,
      observedAt,
      recentPulseHistory: [
        {
          emittedAt: "2026-03-01T10:45:00.000Z",
          reasonCode: "USER_REQUESTED_FOLLOWUP",
          candidateEntityRefs: ["entity_flare_labs"]
        }
      ]
    },
    {
      pulseMinIntervalMinutes: 240
    }
  );
  const cooldownSuppressionPass = cooldownSuppressed.decisions.some(
    (entry) =>
      entry.decision.decisionCode === "SUPPRESS" &&
      entry.decision.blockDetailReason === "PULSE_COOLDOWN_ACTIVE"
  );

  const capSuppressed = evaluatePulseCandidatesV1(
    {
      graph,
      stack,
      observedAt,
      recentPulseHistory: [
        {
          emittedAt: "2026-03-01T08:30:00.000Z",
          reasonCode: "USER_REQUESTED_FOLLOWUP",
          candidateEntityRefs: ["entity_flare_labs"]
        },
        {
          emittedAt: "2026-03-01T10:30:00.000Z",
          reasonCode: "USER_REQUESTED_FOLLOWUP",
          candidateEntityRefs: ["entity_flare_labs"]
        }
      ]
    },
    {
      pulseMaxPerDay: 2
    }
  );
  const capSuppressionPass = capSuppressed.decisions.some(
    (entry) =>
      entry.decision.decisionCode === "SUPPRESS" &&
      (entry.decision.blockDetailReason === "PULSE_CAP_REACHED" ||
        entry.decision.blockDetailReason === "BRIDGE_CAP_REACHED")
  );

  const privacySuppressionPass = baselineA.decisions.some(
    (entry) =>
      entry.candidate.entityRefs.includes("entity_billy") &&
      entry.decision.decisionCode === "SUPPRESS" &&
      (entry.decision.blockDetailReason === "PRIVACY_SENSITIVE" ||
        entry.decision.blockDetailReason === "BRIDGE_PRIVACY_SENSITIVE")
  );

  const bridgeCooldownSuppressed = evaluatePulseCandidatesV1(
    {
      graph,
      stack,
      observedAt,
      recentPulseHistory: [
        {
          emittedAt: "2026-02-25T12:00:00.000Z",
          reasonCode: "RELATIONSHIP_CLARIFICATION",
          candidateEntityRefs: ["entity_flare_labs", "entity_project_aurora"]
        }
      ]
    },
    {
      bridgeCooldownDays: 14
    }
  );
  const bridgeCooldownSuppressionPass = bridgeCooldownSuppressed.decisions.some(
    (entry) =>
      entry.candidate.reasonCode === "RELATIONSHIP_CLARIFICATION" &&
      entry.decision.decisionCode === "SUPPRESS" &&
      entry.decision.blockDetailReason === "BRIDGE_COOLDOWN_ACTIVE"
  );

  const coveragePass =
    reasonCodes.includes("OPEN_LOOP_RESUME") &&
    reasonCodes.includes("RELATIONSHIP_CLARIFICATION") &&
    reasonCodes.includes("TOPIC_DRIFT_RESUME") &&
    reasonCodes.includes("STALE_FACT_REVALIDATION") &&
    reasonCodes.includes("USER_REQUESTED_FOLLOWUP");
  const orderingPass = deterministicOrderPass && sortedTuplePass;
  const suppressionPass =
    missionSuppressionPass &&
    cooldownSuppressionPass &&
    capSuppressionPass &&
    privacySuppressionPass &&
    bridgeCooldownSuppressionPass;
  const overallPass = coveragePass && orderingPass && suppressionPass;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_86:pulse_candidates",
    checkpointId: "6.86.E",
    candidateCoverage: {
      reasonCodes,
      includesOpenLoopResume: reasonCodes.includes("OPEN_LOOP_RESUME"),
      includesRelationshipClarification: reasonCodes.includes("RELATIONSHIP_CLARIFICATION"),
      includesTopicDriftResume: reasonCodes.includes("TOPIC_DRIFT_RESUME"),
      includesStaleFactRevalidation: reasonCodes.includes("STALE_FACT_REVALIDATION"),
      includesUserRequestedFollowup: reasonCodes.includes("USER_REQUESTED_FOLLOWUP")
    },
    ordering: {
      deterministicOrderPass,
      sortedTuplePass,
      topCandidateReason: baselineA.orderedCandidates[0]?.reasonCode ?? null
    },
    suppression: {
      missionSuppressionPass,
      cooldownSuppressionPass,
      capSuppressionPass,
      privacySuppressionPass,
      bridgeCooldownSuppressionPass
    },
    passCriteria: {
      coveragePass,
      orderingPass,
      suppressionPass,
      overallPass
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage686CheckpointE();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.86 checkpoint 6.86.E artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
