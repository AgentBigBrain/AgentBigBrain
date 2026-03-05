/**
 * @fileoverview Runs Stage 6.85 checkpoint 6.85.E quality-gate checks and emits deterministic evidence artifacts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  evaluateTruthfulnessGate,
  evaluateVerificationGate,
  resolveDefinitionOfDoneProfile
} from "../core/stage6_85QualityGatePolicy";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_85_quality_gates_report.json"
);

interface Stage685CheckpointEArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.85.E";
  profiles: {
    build: readonly string[];
    research: readonly string[];
    workflowReplay: readonly string[];
    communication: readonly string[];
  };
  verification: {
    withProofs: {
      passed: boolean;
      proofRefs: readonly string[];
    };
    withWaiver: {
      passed: boolean;
      waiverApproved: boolean;
    };
    blockedWithoutProof: {
      passed: boolean;
      reason: string;
    };
  };
  truthfulness: {
    blockedOptimistic: {
      passed: boolean;
      reason: string;
    };
    blockedSimulationLabelMissing: {
      passed: boolean;
      reason: string;
    };
    allowedTruthful: {
      passed: boolean;
      reason: string;
    };
  };
  passCriteria: {
    profileContractPass: boolean;
    verificationPass: boolean;
    truthfulnessPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Executes stage685 checkpoint e as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the stage685 checkpoint e runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `evaluateTruthfulnessGate` (import `evaluateTruthfulnessGate`) from `../core/stage6_85QualityGatePolicy`.
 * - Uses `evaluateVerificationGate` (import `evaluateVerificationGate`) from `../core/stage6_85QualityGatePolicy`.
 * - Uses `resolveDefinitionOfDoneProfile` (import `resolveDefinitionOfDoneProfile`) from `../core/stage6_85QualityGatePolicy`.
 * @returns Promise resolving to Stage685CheckpointEArtifact.
 */
export async function runStage685CheckpointE(): Promise<Stage685CheckpointEArtifact> {
  const buildProfile = resolveDefinitionOfDoneProfile("build");
  const researchProfile = resolveDefinitionOfDoneProfile("research");
  const replayProfile = resolveDefinitionOfDoneProfile("workflow_replay");
  const communicationProfile = resolveDefinitionOfDoneProfile("communication");

  const withProofs = evaluateVerificationGate({
    gateId: "gate_685_e_001",
    category: "build",
    proofRefs: ["artifact_build", "artifact_test", "artifact_build"],
    waiverApproved: false
  });
  const withWaiver = evaluateVerificationGate({
    gateId: "gate_685_e_002",
    category: "research",
    proofRefs: [],
    waiverApproved: true
  });
  const blockedWithoutProof = evaluateVerificationGate({
    gateId: "gate_685_e_003",
    category: "communication",
    proofRefs: [],
    waiverApproved: false
  });

  const blockedOptimistic = evaluateTruthfulnessGate({
    summaryText: "Completed and sent calendar update successfully.",
    blockedSideEffectCount: 1,
    simulatedActionCount: 0,
    simulationLabelPresent: false
  });
  const blockedSimulationLabelMissing = evaluateTruthfulnessGate({
    summaryText: "Prepared output.",
    blockedSideEffectCount: 0,
    simulatedActionCount: 1,
    simulationLabelPresent: false
  });
  const allowedTruthful = evaluateTruthfulnessGate({
    summaryText: "Simulated execution only; waiting for explicit approval.",
    blockedSideEffectCount: 0,
    simulatedActionCount: 1,
    simulationLabelPresent: true
  });

  const profileContractPass =
    buildProfile.requiredProofKinds.join(",") === "build,test" &&
    replayProfile.requiredProofKinds.includes("replay_receipt");
  const verificationPass =
    withProofs.passed && withWaiver.passed && blockedWithoutProof.passed === false;
  const truthfulnessPass =
    blockedOptimistic.passed === false &&
    blockedSimulationLabelMissing.passed === false &&
    allowedTruthful.passed;
  const overallPass = profileContractPass && verificationPass && truthfulnessPass;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_85:quality_gates",
    checkpointId: "6.85.E",
    profiles: {
      build: buildProfile.requiredProofKinds,
      research: researchProfile.requiredProofKinds,
      workflowReplay: replayProfile.requiredProofKinds,
      communication: communicationProfile.requiredProofKinds
    },
    verification: {
      withProofs: {
        passed: withProofs.passed,
        proofRefs: withProofs.proofRefs
      },
      withWaiver: {
        passed: withWaiver.passed,
        waiverApproved: withWaiver.waiverApproved
      },
      blockedWithoutProof: {
        passed: blockedWithoutProof.passed,
        reason: blockedWithoutProof.reason
      }
    },
    truthfulness: {
      blockedOptimistic,
      blockedSimulationLabelMissing,
      allowedTruthful
    },
    passCriteria: {
      profileContractPass,
      verificationPass,
      truthfulnessPass,
      overallPass
    }
  };
}

/**
 * Runs the `stage6_85QualityGates` entrypoint workflow.
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
  const artifact = await runStage685CheckpointE();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.85 checkpoint 6.85.E artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
