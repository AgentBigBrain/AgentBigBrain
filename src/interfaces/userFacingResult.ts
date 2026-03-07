/**
 * @fileoverview Compatibility entrypoint for user-facing task-result rendering.
 */

export type {
  NormalizedUserFacingSummaryOptions,
  UserFacingSummaryOptions
} from "./userFacing/contracts";
export { selectUserFacingSummary } from "./userFacing/resultSurface";
