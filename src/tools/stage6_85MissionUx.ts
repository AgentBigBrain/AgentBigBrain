/**
 * @fileoverview Runs Stage 6.85 checkpoint 6.85.B mission-UX coherence checks and emits deterministic evidence artifacts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildMissionUxResultEnvelope,
  deriveMissionUxState,
  determineApprovalGranularity,
  formatStableApprovalDiff
} from "../core/stage6_85MissionUxPolicy";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_85_mission_ux_report.json"
);

interface Stage685CheckpointBArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.85.B";
  missionState: {
    planning: string;
    awaitingApproval: string;
    executing: string;
    blocked: string;
    completed: string;
  };
  approvals: {
    fallback: {
      approvalMode: string;
      requiresEscalationPath: boolean;
    };
    tier3Default: {
      approvalMode: string;
      requiresEscalationPath: boolean;
    };
    tier3Allowlisted: {
      approvalMode: string;
      requiresEscalationPath: boolean;
    };
    tier2Path: {
      approvalMode: string;
      requiresEscalationPath: boolean;
    };
  };
  diffRendering: {
    formatted: string;
  };
  resultEnvelope: {
    missionId: string;
    state: string;
    summary: string;
    evidenceRefs: readonly string[];
    receiptRefs: readonly string[];
    nextStepSuggestion: string | null;
  };
  passCriteria: {
    stateContractPass: boolean;
    approvalDefaultPass: boolean;
    fallbackPass: boolean;
    diffFormattingPass: boolean;
    resultEnvelopePass: boolean;
    overallPass: boolean;
  };
}

/**
 * Executes stage685 checkpoint b as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the stage685 checkpoint b runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `buildMissionUxResultEnvelope` (import `buildMissionUxResultEnvelope`) from `../core/stage6_85MissionUxPolicy`.
 * - Uses `deriveMissionUxState` (import `deriveMissionUxState`) from `../core/stage6_85MissionUxPolicy`.
 * - Uses `determineApprovalGranularity` (import `determineApprovalGranularity`) from `../core/stage6_85MissionUxPolicy`.
 * - Uses `formatStableApprovalDiff` (import `formatStableApprovalDiff`) from `../core/stage6_85MissionUxPolicy`.
 * @returns Promise resolving to Stage685CheckpointBArtifact.
 */
export async function runStage685CheckpointB(): Promise<Stage685CheckpointBArtifact> {
  const planning = deriveMissionUxState({
    hasCompletedOutcome: false,
    hasBlockingOutcome: false,
    awaitingApproval: false,
    hasInFlightExecution: false
  });
  const awaitingApproval = deriveMissionUxState({
    hasCompletedOutcome: false,
    hasBlockingOutcome: false,
    awaitingApproval: true,
    hasInFlightExecution: false
  });
  const executing = deriveMissionUxState({
    hasCompletedOutcome: false,
    hasBlockingOutcome: false,
    awaitingApproval: false,
    hasInFlightExecution: true
  });
  const blocked = deriveMissionUxState({
    hasCompletedOutcome: false,
    hasBlockingOutcome: true,
    awaitingApproval: true,
    hasInFlightExecution: true
  });
  const completed = deriveMissionUxState({
    hasCompletedOutcome: true,
    hasBlockingOutcome: false,
    awaitingApproval: true,
    hasInFlightExecution: true
  });

  const fallback = determineApprovalGranularity({
    stepTiers: [],
    playbookAllowlistedForApproveAll: false,
    tierDerivationFailed: true
  });
  const tier3Default = determineApprovalGranularity({
    stepTiers: [3],
    playbookAllowlistedForApproveAll: false,
    tierDerivationFailed: false
  });
  const tier3Allowlisted = determineApprovalGranularity({
    stepTiers: [3],
    playbookAllowlistedForApproveAll: true,
    tierDerivationFailed: false
  });
  const tier2Path = determineApprovalGranularity({
    stepTiers: [2],
    playbookAllowlistedForApproveAll: false,
    tierDerivationFailed: false
  });

  const formattedDiff = formatStableApprovalDiff([
    "+ create calendar focus block on Tue 14:00",
    "+ create calendar focus block on Wed 13:00",
    "+ create calendar focus block on Fri 16:00"
  ]);

  const resultEnvelope = buildMissionUxResultEnvelope({
    missionId: "mission_6_85_b_001",
    state: "awaiting_approval",
    summary: "  Mission prepared with pending approval gates.  ",
    evidenceRefs: ["trace_2", "trace_1", "trace_2"],
    receiptRefs: ["receipt_b", "receipt_a", "receipt_a"],
    nextStepSuggestion: "  Approve step or request diff adjustments. "
  });

  const stateContractPass =
    planning === "planning" &&
    awaitingApproval === "awaiting_approval" &&
    executing === "executing" &&
    blocked === "blocked" &&
    completed === "completed";
  const approvalDefaultPass =
    tier3Default.approvalMode === "approve_step" &&
    tier3Allowlisted.approvalMode === "approve_all" &&
    tier2Path.approvalMode === "approve_all";
  const fallbackPass =
    fallback.approvalMode === "approve_step" && fallback.requiresEscalationPath === true;
  const diffFormattingPass = formattedDiff.startsWith("01. ") && formattedDiff.includes("\n02. ");
  const resultEnvelopePass =
    resultEnvelope.summary === "Mission prepared with pending approval gates." &&
    resultEnvelope.evidenceRefs.join(",") === "trace_1,trace_2" &&
    resultEnvelope.receiptRefs.join(",") === "receipt_a,receipt_b";

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_85:mission_ux",
    checkpointId: "6.85.B",
    missionState: {
      planning,
      awaitingApproval,
      executing,
      blocked,
      completed
    },
    approvals: {
      fallback: {
        approvalMode: fallback.approvalMode,
        requiresEscalationPath: fallback.requiresEscalationPath
      },
      tier3Default: {
        approvalMode: tier3Default.approvalMode,
        requiresEscalationPath: tier3Default.requiresEscalationPath
      },
      tier3Allowlisted: {
        approvalMode: tier3Allowlisted.approvalMode,
        requiresEscalationPath: tier3Allowlisted.requiresEscalationPath
      },
      tier2Path: {
        approvalMode: tier2Path.approvalMode,
        requiresEscalationPath: tier2Path.requiresEscalationPath
      }
    },
    diffRendering: {
      formatted: formattedDiff
    },
    resultEnvelope,
    passCriteria: {
      stateContractPass,
      approvalDefaultPass,
      fallbackPass,
      diffFormattingPass,
      resultEnvelopePass,
      overallPass:
        stateContractPass &&
        approvalDefaultPass &&
        fallbackPass &&
        diffFormattingPass &&
        resultEnvelopePass
    }
  };
}

/**
 * Runs the `stage6_85MissionUx` entrypoint workflow.
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
  const artifact = await runStage685CheckpointB();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.85 checkpoint 6.85.B artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
