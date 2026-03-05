/**
 * @fileoverview Runs Stage 6.86 checkpoint 6.86.F bridge-question checks and emits deterministic evidence.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  evaluateBridgeQuestionEmissionV1,
  resolveBridgeQuestionAnswerV1
} from "../../src/core/stage6_86BridgeQuestions";
import { EntityGraphV1, PulseCandidateV1 } from "../../src/core/types";

const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_86_bridge_report.json");

interface Stage686CheckpointFArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.86.F";
  emission: {
    approved: boolean;
    hasBridgeQuestion: boolean;
    hasPulseEmitPayload: boolean;
    neutralPromptPass: boolean;
  };
  gating: {
    thresholdBlockPass: boolean;
    cooldownBlockPass: boolean;
    missionBlockPass: boolean;
    privacyBlockPass: boolean;
    capBlockPass: boolean;
  };
  answerHandling: {
    confirmationPromotesRelation: boolean;
    deferredBackoffPass: boolean;
  };
  passCriteria: {
    emissionPass: boolean;
    gatingPass: boolean;
    answerHandlingPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Implements `buildBridgeFixtureGraph` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildBridgeFixtureGraph(): EntityGraphV1 {
  return {
    schemaVersion: "v1",
    updatedAt: "2026-03-01T00:00:00.000Z",
    entities: [
      {
        entityKey: "entity_flare_labs",
        canonicalName: "Flare Labs",
        entityType: "org",
        disambiguator: null,
        aliases: ["Flare Labs"],
        firstSeenAt: "2025-10-01T00:00:00.000Z",
        lastSeenAt: "2026-02-25T00:00:00.000Z",
        salience: 6,
        evidenceRefs: ["trace:entity_flare_labs"]
      },
      {
        entityKey: "entity_project_aurora",
        canonicalName: "Project Aurora",
        entityType: "concept",
        disambiguator: null,
        aliases: ["Project Aurora"],
        firstSeenAt: "2025-10-01T00:00:00.000Z",
        lastSeenAt: "2026-02-25T00:00:00.000Z",
        salience: 5,
        evidenceRefs: ["trace:entity_project_aurora"]
      }
    ],
    edges: [
      {
        edgeKey: "edge_bridge_primary",
        sourceEntityKey: "entity_project_aurora",
        targetEntityKey: "entity_flare_labs",
        relationType: "co_mentioned",
        status: "uncertain",
        coMentionCount: 7,
        strength: 7,
        firstObservedAt: "2025-10-01T00:00:00.000Z",
        lastObservedAt: "2026-02-25T00:00:00.000Z",
        evidenceRefs: ["trace:edge_bridge_primary"]
      }
    ]
  };
}

/**
 * Implements `buildBridgePulseCandidate` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildBridgePulseCandidate(): PulseCandidateV1 {
  return {
    candidateId: "pulse_candidate_bridge_primary",
    reasonCode: "RELATIONSHIP_CLARIFICATION",
    score: 0.86,
    scoreBreakdown: {
      recency: 0.82,
      frequency: 0.78,
      unresolvedImportance: 0.72,
      sensitivityPenalty: 0,
      cooldownPenalty: 0
    },
    lastTouchedAt: "2026-02-25T00:00:00.000Z",
    threadKey: "thread_budget",
    entityRefs: ["entity_flare_labs", "entity_project_aurora"],
    evidenceRefs: ["trace:candidate_bridge_primary"],
    stableHash: "hash_bridge_primary"
  };
}

/**
 * Implements `runStage686CheckpointF` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage686CheckpointF(): Promise<Stage686CheckpointFArtifact> {
  const graph = buildBridgeFixtureGraph();
  const candidate = buildBridgePulseCandidate();
  const observedAt = "2026-03-01T12:00:00.000Z";

  const emission = evaluateBridgeQuestionEmissionV1({
    graph,
    candidate,
    observedAt
  });
  const neutralPromptPass =
    (emission.bridgeQuestion?.prompt ?? "").includes("How would you describe their relationship") &&
    (emission.bridgeQuestion?.prompt ?? "").includes(
      "coworker, friend, family, project_related, other, or not related"
    );

  const thresholdBlocked = evaluateBridgeQuestionEmissionV1(
    {
      graph,
      candidate,
      observedAt
    },
    {
      coMentionThreshold: 8
    }
  );
  const cooldownBlocked = evaluateBridgeQuestionEmissionV1({
    graph,
    candidate,
    observedAt,
    recentBridgeHistory: [
      {
        questionId: "bridge_q_prior",
        conversationKey: "thread_budget",
        sourceEntityKey: "entity_flare_labs",
        targetEntityKey: "entity_project_aurora",
        askedAt: "2026-02-26T12:00:00.000Z",
        status: "deferred",
        cooldownUntil: "2026-03-05T12:00:00.000Z",
        deferralCount: 1
      }
    ]
  });
  const missionBlocked = evaluateBridgeQuestionEmissionV1({
    graph,
    candidate,
    observedAt,
    activeMissionWorkExists: true
  });
  const privacyBlocked = evaluateBridgeQuestionEmissionV1({
    graph,
    candidate,
    observedAt,
    privacyOptOutEntityKeys: ["entity_flare_labs"]
  });
  const capBlocked = evaluateBridgeQuestionEmissionV1({
    graph,
    candidate,
    observedAt,
    recentBridgeHistory: [
      {
        questionId: "bridge_q_prior_cap",
        conversationKey: "thread_budget",
        sourceEntityKey: "entity_flare_labs",
        targetEntityKey: "entity_project_aurora",
        askedAt: "2026-02-20T12:00:00.000Z",
        status: "asked",
        cooldownUntil: "2026-02-21T12:00:00.000Z",
        deferralCount: 0
      }
    ]
  });

  if (!emission.bridgeQuestion) {
    throw new Error("Checkpoint 6.86.F requires approved bridge question emission.");
  }

  const confirmationResolution = resolveBridgeQuestionAnswerV1({
    graph,
    question: emission.bridgeQuestion,
    observedAt: "2026-03-02T12:00:00.000Z",
    evidenceRef: "trace:bridge_confirmation",
    answer: {
      kind: "confirmed",
      relationType: "project_related"
    }
  });
  const promotedEdge = confirmationResolution.graph.edges.find((edge) => edge.edgeKey === "edge_bridge_primary");
  const confirmationPromotesRelation =
    confirmationResolution.deniedConflictCode === null &&
    promotedEdge?.relationType === "project_related" &&
    promotedEdge?.status === "confirmed";

  const deferredResolution = resolveBridgeQuestionAnswerV1({
    graph,
    question: emission.bridgeQuestion,
    observedAt: "2026-03-02T12:00:00.000Z",
    evidenceRef: "trace:bridge_deferred",
    answer: {
      kind: "deferred"
    },
    recentBridgeHistory: [
      {
        questionId: "bridge_q_previous",
        conversationKey: "thread_budget",
        sourceEntityKey: "entity_flare_labs",
        targetEntityKey: "entity_project_aurora",
        askedAt: "2026-02-20T12:00:00.000Z",
        status: "deferred",
        cooldownUntil: "2026-02-28T12:00:00.000Z",
        deferralCount: 1
      }
    ]
  });
  const deferredBackoffPass =
    deferredResolution.historyRecord.status === "deferred" &&
    deferredResolution.historyRecord.deferralCount === 2 &&
    deferredResolution.historyRecord.cooldownUntil === "2026-04-13T12:00:00.000Z";

  const emissionPass =
    emission.approved &&
    Boolean(emission.bridgeQuestion) &&
    Boolean(emission.pulseEmitParams) &&
    neutralPromptPass;
  const gatingPass =
    thresholdBlocked.blockDetailReason === "BRIDGE_INSUFFICIENT_EVIDENCE" &&
    cooldownBlocked.blockDetailReason === "BRIDGE_COOLDOWN_ACTIVE" &&
    missionBlocked.blockDetailReason === "DERAILS_ACTIVE_MISSION" &&
    privacyBlocked.blockDetailReason === "BRIDGE_PRIVACY_SENSITIVE" &&
    capBlocked.blockDetailReason === "BRIDGE_CAP_REACHED";
  const answerHandlingPass = confirmationPromotesRelation && deferredBackoffPass;
  const overallPass = emissionPass && gatingPass && answerHandlingPass;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_86:bridge",
    checkpointId: "6.86.F",
    emission: {
      approved: emission.approved,
      hasBridgeQuestion: Boolean(emission.bridgeQuestion),
      hasPulseEmitPayload: Boolean(emission.pulseEmitParams),
      neutralPromptPass
    },
    gating: {
      thresholdBlockPass: thresholdBlocked.blockDetailReason === "BRIDGE_INSUFFICIENT_EVIDENCE",
      cooldownBlockPass: cooldownBlocked.blockDetailReason === "BRIDGE_COOLDOWN_ACTIVE",
      missionBlockPass: missionBlocked.blockDetailReason === "DERAILS_ACTIVE_MISSION",
      privacyBlockPass: privacyBlocked.blockDetailReason === "BRIDGE_PRIVACY_SENSITIVE",
      capBlockPass: capBlocked.blockDetailReason === "BRIDGE_CAP_REACHED"
    },
    answerHandling: {
      confirmationPromotesRelation,
      deferredBackoffPass
    },
    passCriteria: {
      emissionPass,
      gatingPass,
      answerHandlingPass,
      overallPass
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage686CheckpointF();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.86 checkpoint 6.86.F artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
