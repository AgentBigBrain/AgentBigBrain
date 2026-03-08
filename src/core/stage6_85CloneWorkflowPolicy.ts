/**
 * @fileoverview Thin compatibility entrypoint for canonical Stage 6.85 clone-workflow helpers.
 */

export type {
  CloneActionSurfaceDecision,
  ClonePacketDraftInput,
  ClonePacketMergeDecision,
  CloneQueueValidationDecision,
  ParallelSpikeBoundsDecision,
  ParallelSpikeBoundsInput
} from "./stage6_85/cloneWorkflow";
export {
  buildFindingsPacketV1,
  buildOptionPacketV1,
  createFindingsPacketEnvelopeV1,
  createOptionPacketEnvelopeV1,
  evaluateCloneActionSurface,
  evaluateClonePacketMergeEligibility,
  resolveParallelSpikeBounds,
  STAGE_6_85_DEFAULT_MAX_CLONE_BUDGET_USD,
  STAGE_6_85_DEFAULT_MAX_PACKETS_PER_CLONE,
  STAGE_6_85_MAX_CLONE_BUDGET_USD_CAP,
  STAGE_6_85_MAX_PACKETS_PER_CLONE_CAP,
  validateCloneQueueRequest
} from "./stage6_85/cloneWorkflow";
