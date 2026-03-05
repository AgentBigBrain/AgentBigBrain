/**
 * @fileoverview Runs Stage 6.85 checkpoint 6.85.H observability checks and emits deterministic evidence artifacts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildMissionTimelineV1,
  buildRedactedEvidenceBundleProfile,
  explainFailureDeterministically
} from "../core/stage6_85ObservabilityPolicy";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_85_observability_report.json"
);

interface Stage685CheckpointHArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.85.H";
  timeline: {
    missionId: string;
    orderedSequences: readonly number[];
    orderedEventTypes: readonly string[];
  };
  failureExplainer: {
    driftSummary: string;
    driftRemediation: readonly string[];
    fallbackSummary: string;
    fallbackRemediation: readonly string[];
  };
  redactedBundle: {
    artifactPaths: readonly string[];
    redactedFieldNames: readonly string[];
    redactionCount: number;
  };
  passCriteria: {
    timelinePass: boolean;
    failureExplainerPass: boolean;
    redactionBundlePass: boolean;
    overallPass: boolean;
  };
}

/**
 * Executes stage685 checkpoint h as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the stage685 checkpoint h runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `buildMissionTimelineV1` (import `buildMissionTimelineV1`) from `../core/stage6_85ObservabilityPolicy`.
 * - Uses `buildRedactedEvidenceBundleProfile` (import `buildRedactedEvidenceBundleProfile`) from `../core/stage6_85ObservabilityPolicy`.
 * - Uses `explainFailureDeterministically` (import `explainFailureDeterministically`) from `../core/stage6_85ObservabilityPolicy`.
 * @returns Promise resolving to Stage685CheckpointHArtifact.
 */
export async function runStage685CheckpointH(): Promise<Stage685CheckpointHArtifact> {
  const timeline = buildMissionTimelineV1({
    missionId: "mission_stage6_85_observability",
    events: [
      {
        sequence: 4,
        phase: "execute",
        eventType: "receipt",
        detail: "Captured governed replay receipt.",
        observedAt: "2026-02-27T00:04:00.000Z"
      },
      {
        sequence: 1,
        phase: "plan",
        eventType: "plan",
        detail: "Compiled mission plan from playbook candidate.",
        observedAt: "2026-02-27T00:01:00.000Z"
      },
      {
        sequence: 5,
        phase: "outcome",
        eventType: "outcome",
        detail: "Mission blocked on workflow drift conflict.",
        observedAt: "2026-02-27T00:05:00.000Z"
      },
      {
        sequence: 2,
        phase: "approval",
        eventType: "approval",
        detail: "Rendered deterministic approval diff and awaited approval.",
        observedAt: "2026-02-27T00:02:00.000Z"
      },
      {
        sequence: 3,
        phase: "execute",
        eventType: "action",
        detail: "Executed governed replay step.",
        observedAt: "2026-02-27T00:03:00.000Z"
      }
    ]
  });

  const driftExplainer = explainFailureDeterministically({
    blockCode: "WORKFLOW_DRIFT_DETECTED",
    conflictCode: "SELECTOR_NOT_FOUND"
  });
  const fallbackExplainer = explainFailureDeterministically({
    blockCode: "WORKFLOW_DRIFT_DETECTED",
    conflictCode: null
  });

  const redactedBundle = buildRedactedEvidenceBundleProfile({
    artifactPaths: [
      "runtime/evidence/stage6_85_playbooks_report.json",
      "runtime/evidence/stage6_85_mission_ux_report.json",
      "runtime/evidence/stage6_85_clones_report.json",
      "runtime/evidence/stage6_85_recovery_report.json",
      "runtime/evidence/stage6_85_quality_gates_report.json",
      "runtime/evidence/stage6_85_workflow_replay_report.json",
      "runtime/evidence/stage6_85_latency_report.json",
      "runtime/evidence/stage6_85_mission_ux_report.json"
    ],
    redactedFieldNames: ["authorization", "token", "authorization", "approvalId"]
  });

  const orderedSequences = timeline.events.map((event) => event.sequence);
  const orderedEventTypes = timeline.events.map((event) => event.eventType);
  const timelinePass = orderedSequences.join(",") === "1,2,3,4,5";
  const failureExplainerPass =
    driftExplainer.summary.includes("SELECTOR_NOT_FOUND") &&
    driftExplainer.remediation.length === 1 &&
    driftExplainer.remediation[0]?.includes("selector") &&
    fallbackExplainer.remediation.length === 1 &&
    fallbackExplainer.remediation[0]?.includes("recapture");
  const redactionBundlePass =
    redactedBundle.redactionCount === 3 &&
    redactedBundle.artifactPaths.length === 7 &&
    redactedBundle.redactedFieldNames.join(",") === "approvalId,authorization,token";
  const overallPass = timelinePass && failureExplainerPass && redactionBundlePass;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_85:observability",
    checkpointId: "6.85.H",
    timeline: {
      missionId: timeline.missionId,
      orderedSequences,
      orderedEventTypes
    },
    failureExplainer: {
      driftSummary: driftExplainer.summary,
      driftRemediation: driftExplainer.remediation,
      fallbackSummary: fallbackExplainer.summary,
      fallbackRemediation: fallbackExplainer.remediation
    },
    redactedBundle: {
      artifactPaths: redactedBundle.artifactPaths,
      redactedFieldNames: redactedBundle.redactedFieldNames,
      redactionCount: redactedBundle.redactionCount
    },
    passCriteria: {
      timelinePass,
      failureExplainerPass,
      redactionBundlePass,
      overallPass
    }
  };
}

/**
 * Runs the `stage6_85Observability` entrypoint workflow.
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
  const artifact = await runStage685CheckpointH();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.85 checkpoint 6.85.H artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
