/**
 * @fileoverview Runs Stage 6.86 checkpoint 6.86.A entity extraction and alias canonicalization checks and emits deterministic evidence.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { EntityGraphStore } from "../../src/core/entityGraphStore";
import {
  applyEntityExtractionToGraph,
  buildEntityKey,
  createEmptyEntityGraphV1,
  extractEntityCandidates
} from "../../src/core/stage6_86EntityGraph";

const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_86_entities_report.json");
const SAMPLE_GRAPH_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_86_entities_sample_graph.json");
const JSON_STORE_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_86_entities_graph.json");
const SQLITE_JSON_STORE_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_86_entities_graph_sqlite.json"
);
const SQLITE_STORE_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_86_entities_graph.sqlite");

interface Stage686CheckpointAArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.86.A";
  extraction: {
    extractedCount: number;
    extractedEntityKeys: readonly string[];
    deterministicKeysPass: boolean;
  };
  graph: {
    entityCount: number;
    edgeCount: number;
    aliasConflictCount: number;
    evictedEdgeCount: number;
  };
  parity: {
    backendParityPass: boolean;
    jsonStorePath: string;
    sqliteStorePath: string;
  };
  passCriteria: {
    extractionPass: boolean;
    coMentionPass: boolean;
    aliasCollisionPass: boolean;
    backendParityPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Implements `runStage686CheckpointA` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage686CheckpointA(): Promise<Stage686CheckpointAArtifact> {
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await rm(SQLITE_STORE_PATH, { force: true });
  await rm(JSON_STORE_PATH, { force: true });
  await rm(SQLITE_JSON_STORE_PATH, { force: true });

  const observedAt = "2026-03-01T00:00:00.000Z";
  const extractionOne = extractEntityCandidates({
    text: "Billy and Sarah met at Beacon Labs before Project Aurora review.",
    observedAt,
    evidenceRef: "trace:stage686_a_001"
  });
  const extractionTwo = extractEntityCandidates({
    text: "Billy and Sarah met at Beacon Labs before Project Aurora review.",
    observedAt,
    evidenceRef: "trace:stage686_a_002"
  });

  const deterministicKeysPass =
    extractionOne.nodes.map((node) => node.entityKey).join(",") ===
    extractionTwo.nodes.map((node) => node.entityKey).join(",");

  const jsonStore = new EntityGraphStore(JSON_STORE_PATH, { backend: "json" });
  const sqliteStore = new EntityGraphStore(SQLITE_JSON_STORE_PATH, {
    backend: "sqlite",
    sqlitePath: SQLITE_STORE_PATH,
    exportJsonOnWrite: false
  });

  await jsonStore.upsertFromExtractionInput({
    text: "Billy and Sarah met at Beacon Labs before Project Aurora review.",
    observedAt,
    evidenceRef: "trace:stage686_a_003"
  });
  const jsonMutation = await jsonStore.upsertFromExtractionInput({
    text: "Sarah and Billy met again at Beacon Labs for Project Aurora review.",
    observedAt: "2026-03-02T00:00:00.000Z",
    evidenceRef: "trace:stage686_a_004"
  });

  await sqliteStore.upsertFromExtractionInput({
    text: "Billy and Sarah met at Beacon Labs before Project Aurora review.",
    observedAt,
    evidenceRef: "trace:stage686_a_003"
  });
  const sqliteMutation = await sqliteStore.upsertFromExtractionInput({
    text: "Sarah and Billy met again at Beacon Labs for Project Aurora review.",
    observedAt: "2026-03-02T00:00:00.000Z",
    evidenceRef: "trace:stage686_a_004"
  });

  const backendParityPass = JSON.stringify(jsonMutation.graph) === JSON.stringify(sqliteMutation.graph);

  const aliasCollisionProbe = applyEntityExtractionToGraph(
    createEmptyEntityGraphV1(observedAt),
    {
      nodes: [
        {
          entityKey: buildEntityKey("William Bena", "person", null),
          canonicalName: "William Bena",
          entityType: "person",
          disambiguator: null,
          domainHint: null,
          aliases: ["Billy"],
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
          salience: 1,
          evidenceRefs: ["trace:stage686_alias_seed"]
        }
      ],
      coMentionPairs: []
    },
    observedAt,
    "trace:stage686_alias_seed"
  );
  const aliasCollisionResult = applyEntityExtractionToGraph(
    aliasCollisionProbe.graph,
    {
      nodes: [
        {
          entityKey: buildEntityKey("Billy Bena", "person", null),
          canonicalName: "Billy Bena",
          entityType: "person",
          disambiguator: null,
          domainHint: null,
          aliases: ["Billy", "Billy Bena"],
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
          salience: 1,
          evidenceRefs: ["trace:stage686_alias_incoming"]
        }
      ],
      coMentionPairs: []
    },
    observedAt,
    "trace:stage686_alias_incoming"
  );

  const extractionPass = extractionOne.nodes.length >= 3 && deterministicKeysPass;
  const coMentionPass = jsonMutation.graph.edges.length > 0 && jsonMutation.graph.edges.every(
    (edge) => edge.relationType === "co_mentioned" && edge.status === "uncertain"
  );
  const aliasCollisionPass = aliasCollisionResult.aliasConflicts.some(
    (conflict) => conflict.conflictCode === "ALIAS_COLLISION"
  );
  const overallPass = extractionPass && coMentionPass && aliasCollisionPass && backendParityPass;

  await writeFile(SAMPLE_GRAPH_PATH, `${JSON.stringify(jsonMutation.graph, null, 2)}\n`, "utf8");

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_86:entities",
    checkpointId: "6.86.A",
    extraction: {
      extractedCount: extractionOne.nodes.length,
      extractedEntityKeys: extractionOne.nodes.map((node) => node.entityKey),
      deterministicKeysPass
    },
    graph: {
      entityCount: jsonMutation.graph.entities.length,
      edgeCount: jsonMutation.graph.edges.length,
      aliasConflictCount: aliasCollisionResult.aliasConflicts.length,
      evictedEdgeCount: jsonMutation.evictedEdgeKeys.length
    },
    parity: {
      backendParityPass,
      jsonStorePath: path.relative(process.cwd(), JSON_STORE_PATH),
      sqliteStorePath: path.relative(process.cwd(), SQLITE_STORE_PATH)
    },
    passCriteria: {
      extractionPass,
      coMentionPass,
      aliasCollisionPass,
      backendParityPass,
      overallPass
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage686CheckpointA();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.86 checkpoint 6.86.A artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
