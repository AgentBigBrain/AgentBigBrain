/**
 * @fileoverview Runs Stage 6.85 checkpoint 6.85.A playbook-system checks and emits deterministic evidence artifacts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createSchemaEnvelopeV1, verifySchemaEnvelopeV1 } from "../core/schemaEnvelope";
import {
  compileCandidatePlaybookFromTrace,
  createPlaybookEnvelopeV1,
  selectPlaybookDeterministically
} from "../core/stage6_85/playbookPolicy";

const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_85_playbooks_report.json");
const REGISTRY_PATH = path.resolve(process.cwd(), "runtime/playbooks/playbook_registry.json");

interface Stage685CheckpointAArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.85.A";
  playbooks: {
    candidateIds: readonly string[];
    envelopeHashes: readonly string[];
    registryPath: string;
  };
  selection: {
    selectedPlaybookId: string | null;
    fallbackToPlanner: boolean;
    topScore: number;
  };
  fallbackScenario: {
    selectedPlaybookId: string | null;
    fallbackToPlanner: boolean;
  };
  passCriteria: {
    candidateCompilePass: boolean;
    registryEnvelopePass: boolean;
    deterministicSelectionPass: boolean;
    fallbackPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Executes stage685 checkpoint a as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the stage685 checkpoint a runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `createSchemaEnvelopeV1` (import `createSchemaEnvelopeV1`) from `../core/schemaEnvelope`.
 * - Uses `verifySchemaEnvelopeV1` (import `verifySchemaEnvelopeV1`) from `../core/schemaEnvelope`.
 * - Uses `compileCandidatePlaybookFromTrace` (import `compileCandidatePlaybookFromTrace`) from `../core/stage6_85PlaybookPolicy`.
 * - Uses `createPlaybookEnvelopeV1` (import `createPlaybookEnvelopeV1`) from `../core/stage6_85PlaybookPolicy`.
 * - Uses `selectPlaybookDeterministically` (import `selectPlaybookDeterministically`) from `../core/stage6_85PlaybookPolicy`.
 * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
 * - Additional imported collaborators are also used in this function body.
 * @returns Promise resolving to Stage685CheckpointAArtifact.
 */
export async function runStage685CheckpointA(): Promise<Stage685CheckpointAArtifact> {
  const createdAt = "2026-02-27T00:00:00.000Z";
  const candidateBuild = compileCandidatePlaybookFromTrace({
    traceId: "stage685_a_build",
    goal: "Build deterministic backup CLI",
    intentTags: ["build", "cli", "verify"],
    inputSchema: "build_cli_v1",
    steps: [
      {
        actionFamily: "build",
        operation: "compile",
        succeeded: true,
        durationMs: 2_200,
        denyCount: 0,
        verificationPassed: true
      },
      {
        actionFamily: "verification",
        operation: "test",
        succeeded: true,
        durationMs: 4_400,
        denyCount: 0,
        verificationPassed: true
      }
    ]
  });
  const candidateResearch = compileCandidatePlaybookFromTrace({
    traceId: "stage685_a_research",
    goal: "Research deterministic sandboxing controls",
    intentTags: ["research", "security"],
    inputSchema: "research_v1",
    steps: [
      {
        actionFamily: "research",
        operation: "summarize",
        succeeded: true,
        durationMs: 6_200,
        denyCount: 1,
        verificationPassed: false
      }
    ]
  });

  const buildEnvelope = createPlaybookEnvelopeV1(candidateBuild, createdAt);
  const researchEnvelope = createPlaybookEnvelopeV1(candidateResearch, createdAt);
  const registryPayload = {
    entries: [
      {
        playbookId: candidateBuild.id,
        version: 1,
        hash: buildEnvelope.hash
      },
      {
        playbookId: candidateResearch.id,
        version: 1,
        hash: researchEnvelope.hash
      }
    ]
  };
  const registryEnvelope = createSchemaEnvelopeV1("PlaybookRegistryV1", registryPayload, createdAt);

  await mkdir(path.dirname(REGISTRY_PATH), { recursive: true });
  await writeFile(REGISTRY_PATH, `${JSON.stringify(registryEnvelope, null, 2)}\n`, "utf8");

  const selection = selectPlaybookDeterministically({
    playbooks: [candidateBuild, candidateResearch],
    signals: [
      {
        playbookId: candidateBuild.id,
        passCount: 12,
        failCount: 1,
        lastSuccessAt: "2026-02-27T00:00:00.000Z",
        averageDenyRate: 0.02,
        averageTimeToCompleteMs: 15_000,
        verificationPassRate: 0.98
      },
      {
        playbookId: candidateResearch.id,
        passCount: 2,
        failCount: 5,
        lastSuccessAt: "2026-01-20T00:00:00.000Z",
        averageDenyRate: 0.35,
        averageTimeToCompleteMs: 80_000,
        verificationPassRate: 0.45
      }
    ],
    requestedTags: ["build", "cli", "verify"],
    requiredInputSchema: "build_cli_v1",
    nowIso: "2026-02-27T12:00:00.000Z"
  });
  const fallbackScenario = selectPlaybookDeterministically({
    playbooks: [candidateResearch],
    signals: [
      {
        playbookId: candidateResearch.id,
        passCount: 0,
        failCount: 10,
        lastSuccessAt: null,
        averageDenyRate: 1,
        averageTimeToCompleteMs: 180_000,
        verificationPassRate: 0
      }
    ],
    requestedTags: ["build"],
    requiredInputSchema: "build_cli_v1",
    nowIso: "2026-02-27T12:00:00.000Z"
  });

  const candidateCompilePass =
    candidateBuild.steps.length > 0 &&
    candidateResearch.steps.length > 0 &&
    candidateBuild.requiredEvidenceTypes.includes("receipt");
  const registryEnvelopePass = verifySchemaEnvelopeV1(registryEnvelope);
  const deterministicSelectionPass =
    selection.selectedPlaybook?.id === candidateBuild.id &&
    selection.fallbackToPlanner === false;
  const fallbackPass =
    fallbackScenario.selectedPlaybook === null && fallbackScenario.fallbackToPlanner === true;
  const overallPass =
    candidateCompilePass && registryEnvelopePass && deterministicSelectionPass && fallbackPass;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_85:playbooks",
    checkpointId: "6.85.A",
    playbooks: {
      candidateIds: [candidateBuild.id, candidateResearch.id],
      envelopeHashes: [buildEnvelope.hash, researchEnvelope.hash],
      registryPath: path.relative(process.cwd(), REGISTRY_PATH)
    },
    selection: {
      selectedPlaybookId: selection.selectedPlaybook?.id ?? null,
      fallbackToPlanner: selection.fallbackToPlanner,
      topScore: selection.scores[0]?.score ?? 0
    },
    fallbackScenario: {
      selectedPlaybookId: fallbackScenario.selectedPlaybook?.id ?? null,
      fallbackToPlanner: fallbackScenario.fallbackToPlanner
    },
    passCriteria: {
      candidateCompilePass,
      registryEnvelopePass,
      deterministicSelectionPass,
      fallbackPass,
      overallPass
    }
  };
}

/**
 * Runs the `stage6_85Playbooks` entrypoint workflow.
 *
 * **Why it exists:**
 * Coordinates imported collaborators behind the `main` function boundary.
 *
 * **What it talks to:**
 * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
 * - Uses `writeFile` (import `writeFile`) from `node:fs/promises`.
 * - Uses `path` (import `default`) from `node:path`.
 * @returns Promise resolving to void.
 */
async function main(): Promise<void> {
  const artifact = await runStage685CheckpointA();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.85 checkpoint 6.85.A artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
