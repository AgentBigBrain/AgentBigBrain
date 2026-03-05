/**
 * @fileoverview Runs Stage 6.75 checkpoint 6.75.B mission-engine replay validation and emits deterministic mission/idempotency evidence artifact.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  MISSION_PHASE_SEQUENCE,
  advanceMissionPhase,
  buildInitialMissionState,
  createMissionCheckpoint,
  evaluateMissionStopDecision,
  registerMissionActionOutcome
} from "../../src/core/stage6_75MissionStateMachine";
import { MissionCheckpointV1 } from "../../src/core/types";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_75_mission_replay_report.json"
);

interface Stage675CheckpointBArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.75.B";
  missionReplay: {
    missionId: string;
    attemptAActionIds: readonly string[];
    attemptBActionIds: readonly string[];
    deterministicReplay: boolean;
    phaseCount: number;
  };
  idempotency: {
    duplicateReplayDetected: boolean;
    duplicateKey: string;
  };
  stopLimits: {
    shouldStop: boolean;
    blockCode: string | null;
    reason: string;
  };
  passCriteria: {
    deterministicReplayPass: boolean;
    idempotencyReplayPass: boolean;
    stopLimitPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Implements `runMissionAttempt` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function runMissionAttempt(missionId: string, missionAttemptId: number): MissionCheckpointV1[] {
  let state = buildInitialMissionState(missionId, missionAttemptId);
  const checkpoints: MissionCheckpointV1[] = [];
  const observedAtBase = "2026-02-27T22:00:00.000Z";

  for (let index = 0; index < MISSION_PHASE_SEQUENCE.length; index += 1) {
    const phase = MISSION_PHASE_SEQUENCE[index];
    const idempotencyKey = `idem_${missionId}_${missionAttemptId}_${phase}`;
    const checkpoint = createMissionCheckpoint(
      state,
      phase,
      phase === "execute_writes" ? "write_file" : "read_file",
      idempotencyKey,
      {
        phase
      },
      new Date(Date.parse(observedAtBase) + index * 1_000).toISOString()
    );
    checkpoints.push(checkpoint);
    const outcome = registerMissionActionOutcome(state, idempotencyKey, 256, false);
    state = outcome.nextState;
    state = advanceMissionPhase(state);
  }

  return checkpoints;
}

/**
 * Implements `runStage675CheckpointB` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage675CheckpointB(): Promise<Stage675CheckpointBArtifact> {
  const missionId = "mission_stage6_75_b_001";
  const attemptA = runMissionAttempt(missionId, 1);
  const attemptB = runMissionAttempt(missionId, 1);

  const attemptAActionIds = attemptA.map((checkpoint) => checkpoint.actionId);
  const attemptBActionIds = attemptB.map((checkpoint) => checkpoint.actionId);
  const deterministicReplay = JSON.stringify(attemptAActionIds) === JSON.stringify(attemptBActionIds);

  let state = buildInitialMissionState(missionId, 1);
  const firstOutcome = registerMissionActionOutcome(state, "idem_duplicate_001", 512, false);
  const secondOutcome = registerMissionActionOutcome(
    firstOutcome.nextState,
    "idem_duplicate_001",
    512,
    true
  );
  const duplicateReplayDetected = secondOutcome.duplicateReplayDetected;
  state = secondOutcome.nextState;
  const stopDecision = evaluateMissionStopDecision(state, {
    maxActions: 2,
    maxDenies: 10,
    maxBytes: 10_240
  });

  const deterministicReplayPass = deterministicReplay;
  const idempotencyReplayPass = duplicateReplayDetected;
  const stopLimitPass =
    stopDecision.shouldStop && stopDecision.blockCode === "MISSION_STOP_LIMIT_REACHED";

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_75:missions",
    checkpointId: "6.75.B",
    missionReplay: {
      missionId,
      attemptAActionIds,
      attemptBActionIds,
      deterministicReplay,
      phaseCount: MISSION_PHASE_SEQUENCE.length
    },
    idempotency: {
      duplicateReplayDetected,
      duplicateKey: "idem_duplicate_001"
    },
    stopLimits: {
      shouldStop: stopDecision.shouldStop,
      blockCode: stopDecision.blockCode,
      reason: stopDecision.reason
    },
    passCriteria: {
      deterministicReplayPass,
      idempotencyReplayPass,
      stopLimitPass,
      overallPass: deterministicReplayPass && idempotencyReplayPass && stopLimitPass
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage675CheckpointB();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.75 checkpoint 6.75.B artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
