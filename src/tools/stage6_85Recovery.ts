/**
 * @fileoverview Runs Stage 6.85 checkpoint 6.85.D recovery checks and emits deterministic evidence artifacts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildMissionPostmortem,
  evaluateResumeSafety,
  evaluateRetryBudget,
  resolveLastDurableCheckpoint
} from "../core/stage6_85RecoveryPolicy";
import { MissionCheckpointV1 } from "../core/types";

const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_85_recovery_report.json");
const POSTMORTEM_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/mission_stage6_85_recovery_postmortem.json"
);

interface Stage685CheckpointDArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.85.D";
  checkpoints: {
    count: number;
    lastDurableActionId: string | null;
  };
  retryPolicy: {
    allowedRetry: {
      shouldRetry: boolean;
      nextAttempt: number;
      blockCode: string | null;
    };
    stopLimitBlocked: {
      shouldRetry: boolean;
      blockCode: string | null;
    };
  };
  resumeSafety: {
    allowed: {
      allowed: boolean;
      blockCode: string | null;
    };
    staleBlocked: {
      allowed: boolean;
      blockCode: string | null;
    };
    diffBlocked: {
      allowed: boolean;
      blockCode: string | null;
    };
  };
  postmortem: {
    path: string;
    blockCode: string;
    lastDurableActionId: string | null;
  };
  passCriteria: {
    checkpointResumePass: boolean;
    retryBudgetPass: boolean;
    resumeSafetyPass: boolean;
    postmortemPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Builds checkpoint for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of checkpoint consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `MissionCheckpointV1` (import `MissionCheckpointV1`) from `../core/types`.
 *
 * @param missionAttemptId - Stable identifier used to reference an entity or record.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param actionId - Stable identifier used to reference an entity or record.
 * @returns Computed `MissionCheckpointV1` result.
 */
function buildCheckpoint(
  missionAttemptId: number,
  observedAt: string,
  actionId: string
): MissionCheckpointV1 {
  return {
    missionId: "mission_stage6_85_recovery",
    missionAttemptId,
    phase: "verify",
    actionType: "run_skill",
    observedAt,
    idempotencyKey: `idem_${actionId}`,
    actionId
  };
}

/**
 * Executes stage685 checkpoint d as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the stage685 checkpoint d runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `buildMissionPostmortem` (import `buildMissionPostmortem`) from `../core/stage6_85RecoveryPolicy`.
 * - Uses `evaluateResumeSafety` (import `evaluateResumeSafety`) from `../core/stage6_85RecoveryPolicy`.
 * - Uses `evaluateRetryBudget` (import `evaluateRetryBudget`) from `../core/stage6_85RecoveryPolicy`.
 * - Uses `resolveLastDurableCheckpoint` (import `resolveLastDurableCheckpoint`) from `../core/stage6_85RecoveryPolicy`.
 * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
 * - Uses `writeFile` (import `writeFile`) from `node:fs/promises`.
 * - Additional imported collaborators are also used in this function body.
 * @returns Promise resolving to Stage685CheckpointDArtifact.
 */
export async function runStage685CheckpointD(): Promise<Stage685CheckpointDArtifact> {
  const checkpoints = [
    buildCheckpoint(1, "2026-02-27T00:01:00.000Z", "action_001"),
    buildCheckpoint(1, "2026-02-27T00:02:00.000Z", "action_002"),
    buildCheckpoint(2, "2026-02-27T00:03:00.000Z", "action_003")
  ];
  const lastDurable = resolveLastDurableCheckpoint(checkpoints);
  const retryAllowed = evaluateRetryBudget(1, 3);
  const retryBlocked = evaluateRetryBudget(3, 3);

  const resumeAllowed = evaluateResumeSafety({
    approvalUses: 0,
    approvalMaxUses: 2,
    freshnessValid: true,
    diffHashMatches: true
  });
  const resumeStaleBlocked = evaluateResumeSafety({
    approvalUses: 0,
    approvalMaxUses: 2,
    freshnessValid: false,
    diffHashMatches: true
  });
  const resumeDiffBlocked = evaluateResumeSafety({
    approvalUses: 0,
    approvalMaxUses: 2,
    freshnessValid: true,
    diffHashMatches: false
  });

  const postmortem = buildMissionPostmortem({
    missionId: "mission_stage6_85_recovery",
    missionAttemptId: 2,
    failedAt: "2026-02-27T00:03:30.000Z",
    blockCode: "STATE_STALE_REPLAN_REQUIRED",
    rootCause: "Freshness check failed before pending side-effect execution.",
    checkpoints
  });
  await mkdir(path.dirname(POSTMORTEM_PATH), { recursive: true });
  await writeFile(POSTMORTEM_PATH, `${JSON.stringify(postmortem, null, 2)}\n`, "utf8");

  const checkpointResumePass = checkpoints.length === 3 && lastDurable?.actionId === "action_003";
  const retryBudgetPass =
    retryAllowed.shouldRetry &&
    retryAllowed.nextAttempt === 2 &&
    retryBlocked.shouldRetry === false &&
    retryBlocked.blockCode === "MISSION_STOP_LIMIT_REACHED";
  const resumeSafetyPass =
    resumeAllowed.allowed &&
    resumeStaleBlocked.blockCode === "STATE_STALE_REPLAN_REQUIRED" &&
    resumeDiffBlocked.blockCode === "APPROVAL_DIFF_HASH_MISMATCH";
  const postmortemPass =
    postmortem.blockCode === "STATE_STALE_REPLAN_REQUIRED" &&
    postmortem.lastDurableCheckpoint?.actionId === "action_003";
  const overallPass = checkpointResumePass && retryBudgetPass && resumeSafetyPass && postmortemPass;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_85:recovery",
    checkpointId: "6.85.D",
    checkpoints: {
      count: checkpoints.length,
      lastDurableActionId: lastDurable?.actionId ?? null
    },
    retryPolicy: {
      allowedRetry: {
        shouldRetry: retryAllowed.shouldRetry,
        nextAttempt: retryAllowed.nextAttempt,
        blockCode: retryAllowed.blockCode
      },
      stopLimitBlocked: {
        shouldRetry: retryBlocked.shouldRetry,
        blockCode: retryBlocked.blockCode
      }
    },
    resumeSafety: {
      allowed: {
        allowed: resumeAllowed.allowed,
        blockCode: resumeAllowed.blockCode
      },
      staleBlocked: {
        allowed: resumeStaleBlocked.allowed,
        blockCode: resumeStaleBlocked.blockCode
      },
      diffBlocked: {
        allowed: resumeDiffBlocked.allowed,
        blockCode: resumeDiffBlocked.blockCode
      }
    },
    postmortem: {
      path: path.relative(process.cwd(), POSTMORTEM_PATH),
      blockCode: postmortem.blockCode,
      lastDurableActionId: postmortem.lastDurableCheckpoint?.actionId ?? null
    },
    passCriteria: {
      checkpointResumePass,
      retryBudgetPass,
      resumeSafetyPass,
      postmortemPass,
      overallPass
    }
  };
}

/**
 * Runs the `stage6_85Recovery` entrypoint workflow.
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
  const artifact = await runStage685CheckpointD();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.85 checkpoint 6.85.D artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
