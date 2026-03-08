/**
 * @fileoverview Stable compatibility entrypoint for the canonical Stage 6.86 pulse-candidate subsystem.
 */

export {
  buildBridgeInsufficientEvidenceConflictV1,
  evaluatePulseCandidatesV1,
  type EvaluatePulseCandidatesInputV1,
  type EvaluatePulseCandidatesOptionsV1,
  type EvaluatePulseCandidatesResultV1,
  type PulseCandidateDecisionV1,
  type PulseEmissionRecordV1,
  type PulseResponseOutcome
} from "./stage6_86/pulseCandidates";
