/**
 * @fileoverview Canonical Stage 6.85 mission-UX runtime contracts.
 */

import type { ApprovalGranularityV1, MissionUxStateV1 } from "../types";

export interface MissionUxStateInput {
  hasCompletedOutcome: boolean;
  hasBlockingOutcome: boolean;
  awaitingApproval: boolean;
  hasInFlightExecution: boolean;
}

export interface MissionUxApprovalInput {
  stepTiers: readonly number[];
  playbookAllowlistedForApproveAll: boolean;
  tierDerivationFailed: boolean;
}

export interface MissionUxApprovalDecision {
  approvalMode: ApprovalGranularityV1;
  requiresEscalationPath: boolean;
  reason: string;
}

export interface MissionUxResultEnvelopeInput {
  missionId: string;
  state: MissionUxStateV1;
  summary: string;
  evidenceRefs: readonly string[];
  receiptRefs: readonly string[];
  nextStepSuggestion: string | null;
}
