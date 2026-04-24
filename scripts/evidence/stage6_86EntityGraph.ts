/**
 * @fileoverview Runs Stage 6.86 checkpoint 6.86.B relationship graph checks and emits deterministic evidence.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applyEntityExtractionToGraph,
  computeCoMentionIncrement,
  createEmptyEntityGraphV1,
  extractEntityCandidates,
  promoteRelationEdgeWithConfirmation
} from "../../src/core/stage6_86EntityGraph";

const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_86_entity_graph_report.json");

interface Stage686CheckpointBArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.86.B";
  baseline: {
    entityCount: number;
    edgeCount: number;
    uncertainCoMentionEdgeCount: number;
  };
  promotion: {
    deniedWithoutConfirmation: boolean;
    promotedWithConfirmation: boolean;
    promotedRelationType: string | null;
    promotedStatus: string | null;
  };
  strength: {
    sameDayIncrement: number;
    staleIncrement: number;
    recencyWeightingPass: boolean;
  };
  caps: {
    evictedEdgeCount: number;
    evictionPass: boolean;
  };
  passCriteria: {
    baselinePass: boolean;
    promotionPass: boolean;
    strengthPass: boolean;
    evictionPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Implements `runStage686CheckpointB` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage686CheckpointB(): Promise<Stage686CheckpointBArtifact> {
  const observedAt = "2026-03-01T00:00:00.000Z";
  const extraction = extractEntityCandidates({
    text: "Billy and Sarah reviewed Project Aurora at Beacon Labs.",
    observedAt,
    evidenceRef: "trace:stage686_b_001"
  });
  const baselineMutation = applyEntityExtractionToGraph(
    createEmptyEntityGraphV1(observedAt),
    extraction,
    observedAt,
    "trace:stage686_b_001"
  );
  const baselineGraph = baselineMutation.graph;
  const billy = baselineGraph.entities.find((entity) => entity.canonicalName === "Billy");
  const sarah = baselineGraph.entities.find((entity) => entity.canonicalName === "Sarah");
  if (!billy || !sarah) {
    throw new Error("Checkpoint 6.86.B requires deterministic Billy/Sarah extraction baseline.");
  }

  const deniedPromotion = promoteRelationEdgeWithConfirmation(baselineGraph, {
    sourceEntityKey: billy.entityKey,
    targetEntityKey: sarah.entityKey,
    relationType: "coworker",
    explicitUserConfirmation: false,
    observedAt: "2026-03-02T00:00:00.000Z",
    evidenceRef: "trace:stage686_b_denied"
  });
  const promoted = promoteRelationEdgeWithConfirmation(baselineGraph, {
    sourceEntityKey: billy.entityKey,
    targetEntityKey: sarah.entityKey,
    relationType: "coworker",
    explicitUserConfirmation: true,
    observedAt: "2026-03-02T00:00:00.000Z",
    evidenceRef: "trace:stage686_b_promoted"
  });
  const promotedEdge = promoted.graph.edges.find((edge) => edge.edgeKey === promoted.edgeKey);

  const sameDayIncrement = computeCoMentionIncrement(
    "2026-03-01T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z"
  );
  const staleIncrement = computeCoMentionIncrement(
    "2025-09-01T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z"
  );
  const recencyWeightingPass = staleIncrement < sameDayIncrement && staleIncrement > 0;

  const cappedGraph = applyEntityExtractionToGraph(
    baselineGraph,
    {
      nodes: [],
      coMentionPairs: []
    },
    observedAt,
    "trace:stage686_b_caps",
    {
      maxGraphEdgesPerEntity: 2
    }
  );

  const baselinePass =
    baselineGraph.entities.length >= 3 &&
    baselineGraph.edges.length > 0 &&
    baselineGraph.edges.every(
      (edge) => edge.relationType === "co_mentioned" && edge.status === "uncertain"
    );
  const promotionPass =
    deniedPromotion.promoted === false &&
    deniedPromotion.deniedConflictCode === "INSUFFICIENT_EVIDENCE" &&
    promoted.promoted === true &&
    promotedEdge?.relationType === "coworker" &&
    promotedEdge?.status === "confirmed";
  const strengthPass = recencyWeightingPass;
  const evictionPass = cappedGraph.evictedEdgeKeys.length > 0;
  const overallPass = baselinePass && promotionPass && strengthPass && evictionPass;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_86:entity_graph",
    checkpointId: "6.86.B",
    baseline: {
      entityCount: baselineGraph.entities.length,
      edgeCount: baselineGraph.edges.length,
      uncertainCoMentionEdgeCount: baselineGraph.edges.filter(
        (edge) => edge.relationType === "co_mentioned" && edge.status === "uncertain"
      ).length
    },
    promotion: {
      deniedWithoutConfirmation:
        deniedPromotion.promoted === false &&
        deniedPromotion.deniedConflictCode === "INSUFFICIENT_EVIDENCE",
      promotedWithConfirmation: promoted.promoted,
      promotedRelationType: promotedEdge?.relationType ?? null,
      promotedStatus: promotedEdge?.status ?? null
    },
    strength: {
      sameDayIncrement,
      staleIncrement,
      recencyWeightingPass
    },
    caps: {
      evictedEdgeCount: cappedGraph.evictedEdgeKeys.length,
      evictionPass
    },
    passCriteria: {
      baselinePass,
      promotionPass,
      strengthPass,
      evictionPass,
      overallPass
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage686CheckpointB();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.86 checkpoint 6.86.B artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
