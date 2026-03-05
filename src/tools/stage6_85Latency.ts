/**
 * @fileoverview Runs Stage 6.85 checkpoint 6.85.G latency checks and emits deterministic evidence artifacts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildDeterministicRejectSummary,
  evaluateCacheBaselineEquivalence,
  evaluatePhaseLatencies,
  resolveDefaultLatencyBudgetsMs
} from "../core/stage6_85LatencyPolicy";

const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_85_latency_report.json");

interface Stage685CheckpointGArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.85.G";
  budgetsMs: Record<string, number>;
  observations: {
    passingOverall: boolean;
    failingOverall: boolean;
  };
  cacheEquivalence: {
    passing: {
      passed: boolean;
      reason: string;
    };
    failing: {
      passed: boolean;
      reason: string;
    };
  };
  denySummary: string;
  passCriteria: {
    latencyBudgetPass: boolean;
    cacheBaselinePass: boolean;
    summaryPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Executes stage685 checkpoint g as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the stage685 checkpoint g runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `buildDeterministicRejectSummary` (import `buildDeterministicRejectSummary`) from `../core/stage6_85LatencyPolicy`.
 * - Uses `evaluateCacheBaselineEquivalence` (import `evaluateCacheBaselineEquivalence`) from `../core/stage6_85LatencyPolicy`.
 * - Uses `evaluatePhaseLatencies` (import `evaluatePhaseLatencies`) from `../core/stage6_85LatencyPolicy`.
 * - Uses `resolveDefaultLatencyBudgetsMs` (import `resolveDefaultLatencyBudgetsMs`) from `../core/stage6_85LatencyPolicy`.
 * @returns Promise resolving to Stage685CheckpointGArtifact.
 */
export async function runStage685CheckpointG(): Promise<Stage685CheckpointGArtifact> {
  const budgetsMs = resolveDefaultLatencyBudgetsMs();
  const passingLatency = evaluatePhaseLatencies({
    budgetsMs,
    observedMs: {
      planning: 6_500,
      vote_collection: 2_100,
      execution: 8_800,
      response_rendering: 1_400
    }
  });
  const failingLatency = evaluatePhaseLatencies({
    budgetsMs,
    observedMs: {
      planning: 8_500,
      vote_collection: 2_100,
      execution: 8_800,
      response_rendering: 1_400
    }
  });

  const cachePass = evaluateCacheBaselineEquivalence({
    baselineModelCalls: 5,
    cachedModelCalls: 4
  });
  const cacheFail = evaluateCacheBaselineEquivalence({
    baselineModelCalls: 5,
    cachedModelCalls: 7
  });

  const denySummary = buildDeterministicRejectSummary([
    "MODEL_SPEND_LIMIT_EXCEEDED",
    "WORKFLOW_DRIFT_DETECTED",
    "MODEL_SPEND_LIMIT_EXCEEDED"
  ]);

  const latencyBudgetPass = passingLatency.overallPass && !failingLatency.overallPass;
  const cacheBaselinePass = cachePass.passed && !cacheFail.passed;
  const summaryPass = denySummary === "MODEL_SPEND_LIMIT_EXCEEDED | WORKFLOW_DRIFT_DETECTED";
  const overallPass = latencyBudgetPass && cacheBaselinePass && summaryPass;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_85:latency",
    checkpointId: "6.85.G",
    budgetsMs,
    observations: {
      passingOverall: passingLatency.overallPass,
      failingOverall: failingLatency.overallPass
    },
    cacheEquivalence: {
      passing: cachePass,
      failing: cacheFail
    },
    denySummary,
    passCriteria: {
      latencyBudgetPass,
      cacheBaselinePass,
      summaryPass,
      overallPass
    }
  };
}

/**
 * Runs the `stage6_85Latency` entrypoint workflow.
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
  const artifact = await runStage685CheckpointG();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.85 checkpoint 6.85.G artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
