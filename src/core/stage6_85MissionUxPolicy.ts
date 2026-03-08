/**
 * @fileoverview Thin compatibility entrypoint for canonical Stage 6.85 mission-UX helpers.
 */

export type {
  MissionUxApprovalDecision,
  MissionUxApprovalInput,
  MissionUxResultEnvelopeInput,
  MissionUxStateInput
} from "./stage6_85/contracts";
export {
  buildMissionUxResultEnvelope,
  deriveMissionUxState,
  determineApprovalGranularity,
  formatStableApprovalDiff
} from "./stage6_85/missionUx";
