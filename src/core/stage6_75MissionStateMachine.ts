/**
 * @fileoverview Deterministic Stage 6.75 mission-phase state machine and idempotency helpers for replay-safe execution planning.
 */

import {
  ActionType,
  MissionCheckpointV1,
  MissionPhaseV1,
  Stage675BlockCode
} from "./types";
import { canonicalJson, sha256Hex } from "./normalizers/canonicalizationRules";

/**
 * Canonical phase sequence used for Stage 6.75 mission replay checks.
 */
export const MISSION_PHASE_SEQUENCE: readonly MissionPhaseV1[] = [
  "intake",
  "retrieve",
  "synthesize",
  "build",
  "verify",
  "propose_writes",
  "execute_writes",
  "monitor"
] as const;

export interface MissionStopLimitsV1 {
  maxActions: number;
  maxDenies: number;
  maxBytes: number;
}

export interface MissionStateV1 {
  missionId: string;
  missionAttemptId: number;
  currentPhase: MissionPhaseV1;
  phaseHistory: MissionPhaseV1[];
  actionCount: number;
  denyCount: number;
  bytesObserved: number;
  seenIdempotencyKeys: Record<string, true>;
}

export interface MissionStopDecision {
  shouldStop: boolean;
  blockCode: Stage675BlockCode | null;
  reason: string;
}

/**
 * Builds initial mission state for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of initial mission state consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param missionId - Stable identifier used to reference an entity or record.
 * @param missionAttemptId - Stable identifier used to reference an entity or record.
 * @returns Computed `MissionStateV1` result.
 */
export function buildInitialMissionState(missionId: string, missionAttemptId = 1): MissionStateV1 {
  return {
    missionId,
    missionAttemptId,
    currentPhase: MISSION_PHASE_SEQUENCE[0],
    phaseHistory: [MISSION_PHASE_SEQUENCE[0]],
    actionCount: 0,
    denyCount: 0,
    bytesObserved: 0,
    seenIdempotencyKeys: {}
  };
}

/**
 * Derives deterministic action id from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for deterministic action id in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses `canonicalJson` (import `canonicalJson`) from `./normalizers/canonicalizationRules`.
 * - Uses `sha256Hex` (import `sha256Hex`) from `./normalizers/canonicalizationRules`.
 * - Uses `ActionType` (import `ActionType`) from `./types`.
 * - Uses `MissionPhaseV1` (import `MissionPhaseV1`) from `./types`.
 *
 * @param missionId - Stable identifier used to reference an entity or record.
 * @param missionAttemptId - Stable identifier used to reference an entity or record.
 * @param phase - Value for phase.
 * @param actionType - Value for action type.
 * @param canonicalActionParams - Boolean gate controlling this branch.
 * @returns Resulting string value.
 */
export function deriveDeterministicActionId(
  missionId: string,
  missionAttemptId: number,
  phase: MissionPhaseV1,
  actionType: ActionType,
  canonicalActionParams: unknown
): string {
  const basis = [
    missionId,
    String(missionAttemptId),
    phase,
    actionType,
    canonicalJson(canonicalActionParams)
  ].join("|");
  return `action_${sha256Hex(basis).slice(0, 24)}`;
}

/**
 * Builds mission checkpoint for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of mission checkpoint consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ActionType` (import `ActionType`) from `./types`.
 * - Uses `MissionCheckpointV1` (import `MissionCheckpointV1`) from `./types`.
 * - Uses `MissionPhaseV1` (import `MissionPhaseV1`) from `./types`.
 *
 * @param state - Value for state.
 * @param phase - Value for phase.
 * @param actionType - Value for action type.
 * @param idempotencyKey - Stable identifier used to reference an entity or record.
 * @param canonicalActionParams - Boolean gate controlling this branch.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed `MissionCheckpointV1` result.
 */
export function createMissionCheckpoint(
  state: MissionStateV1,
  phase: MissionPhaseV1,
  actionType: ActionType,
  idempotencyKey: string,
  canonicalActionParams: unknown,
  observedAt: string
): MissionCheckpointV1 {
  return {
    missionId: state.missionId,
    missionAttemptId: state.missionAttemptId,
    phase,
    actionType,
    observedAt,
    idempotencyKey,
    actionId: deriveDeterministicActionId(
      state.missionId,
      state.missionAttemptId,
      phase,
      actionType,
      canonicalActionParams
    )
  };
}

/**
 * Implements advance mission phase behavior used by `stage6_75MissionStateMachine`.
 *
 * **Why it exists:**
 * Defines public behavior from `stage6_75MissionStateMachine.ts` for other modules/tests.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param state - Value for state.
 * @returns Computed `MissionStateV1` result.
 */
export function advanceMissionPhase(state: MissionStateV1): MissionStateV1 {
  const currentIndex = MISSION_PHASE_SEQUENCE.indexOf(state.currentPhase);
  const nextIndex = Math.min(MISSION_PHASE_SEQUENCE.length - 1, currentIndex + 1);
  const nextPhase = MISSION_PHASE_SEQUENCE[nextIndex];
  return {
    ...state,
    currentPhase: nextPhase,
    phaseHistory: [...state.phaseHistory, nextPhase]
  };
}

/**
 * Registers mission action outcome in runtime state for later policy/runtime checks.
 *
 * **Why it exists:**
 * Centralizes lifecycle tracking for mission action outcome so audit and retry flows share one source of truth.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param state - Value for state.
 * @param idempotencyKey - Stable identifier used to reference an entity or record.
 * @param bytesObserved - Value for bytes observed.
 * @param denied - Value for denied.
 * @returns Computed `{ nextState: MissionStateV1; duplicateReplayDetected: boolean }` result.
 */
export function registerMissionActionOutcome(
  state: MissionStateV1,
  idempotencyKey: string,
  bytesObserved: number,
  denied: boolean
): { nextState: MissionStateV1; duplicateReplayDetected: boolean } {
  const duplicateReplayDetected = state.seenIdempotencyKeys[idempotencyKey] === true;
  return {
    duplicateReplayDetected,
    nextState: {
      ...state,
      actionCount: state.actionCount + 1,
      denyCount: state.denyCount + (denied ? 1 : 0),
      bytesObserved: state.bytesObserved + Math.max(0, Math.floor(bytesObserved)),
      seenIdempotencyKeys: {
        ...state.seenIdempotencyKeys,
        [idempotencyKey]: true
      }
    }
  };
}

/**
 * Evaluates mission stop decision and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the mission stop decision policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param state - Value for state.
 * @param limits - Numeric bound, counter, or index used by this logic.
 * @returns Computed `MissionStopDecision` result.
 */
export function evaluateMissionStopDecision(
  state: MissionStateV1,
  limits: MissionStopLimitsV1
): MissionStopDecision {
  if (state.actionCount >= limits.maxActions) {
    return {
      shouldStop: true,
      blockCode: "MISSION_STOP_LIMIT_REACHED",
      reason: "Action limit reached."
    };
  }
  if (state.denyCount >= limits.maxDenies) {
    return {
      shouldStop: true,
      blockCode: "MISSION_STOP_LIMIT_REACHED",
      reason: "Deny limit reached."
    };
  }
  if (state.bytesObserved >= limits.maxBytes) {
    return {
      shouldStop: true,
      blockCode: "MISSION_STOP_LIMIT_REACHED",
      reason: "Byte limit reached."
    };
  }
  return {
    shouldStop: false,
    blockCode: null,
    reason: "Mission remains within deterministic limits."
  };
}
