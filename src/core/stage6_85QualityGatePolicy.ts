/**
 * @fileoverview Thin compatibility entrypoint for canonical Stage 6.85 quality-gate helpers.
 */

export type { DefinitionOfDoneProfileV1 } from "./stage6_85/qualityGates";
export {
  evaluateTruthfulnessGate,
  evaluateVerificationGate,
  resolveDefinitionOfDoneProfile
} from "./stage6_85/qualityGates";
