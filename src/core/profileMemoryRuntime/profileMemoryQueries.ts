/**
 * @fileoverview Query helpers for profile-memory planning context and readable fact access.
 */

import { type ProfileFactRecord, type ProfileMemoryState } from "../profileMemory";
import { buildQueryAwarePlanningContext } from "./profileMemoryPlanningContext";
import {
  type ProfileAccessRequest,
  type ProfileReadableFact
} from "./contracts";

/**
 * Builds planner-facing profile context from normalized profile-memory state.
 *
 * @param state - Loaded profile-memory state.
 * @param maxFacts - Maximum fact count for prompt grounding.
 * @param queryInput - Current query used for relevance ranking.
 * @returns Rendered planning context string.
 */
export function buildProfilePlanningContext(
  state: ProfileMemoryState,
  maxFacts: number,
  queryInput: string
): string {
  return buildQueryAwarePlanningContext(state, maxFacts, queryInput);
}

/**
 * Returns readable active facts under approval-aware sensitivity gating.
 *
 * @param state - Loaded profile-memory state.
 * @param request - Access request with sensitivity and count controls.
 * @returns Sorted readable fact entries filtered by sensitivity policy.
 */
export function readProfileFacts(
  state: ProfileMemoryState,
  request: ProfileAccessRequest
): ProfileReadableFact[] {
  const activeFacts = state.facts
    .filter((fact) => isActiveProfileFact(fact))
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt));

  const sensitiveAllowed = canReadSensitiveFacts(request);
  const maxFacts = Math.max(1, request.maxFacts ?? 20);
  return activeFacts
    .filter((fact) => sensitiveAllowed || !fact.sensitive)
    .slice(0, maxFacts)
    .map((fact) => ({
      factId: fact.id,
      key: fact.key,
      value: fact.value,
      status: fact.status,
      sensitive: fact.sensitive,
      observedAt: fact.observedAt,
      lastUpdatedAt: fact.lastUpdatedAt,
      confidence: fact.confidence,
      mutationAudit: fact.mutationAudit
    }));
}

/**
 * Evaluates whether a profile access request includes explicit human approval metadata.
 *
 * @param request - Access request under evaluation.
 * @returns `true` when the request includes explicit approval.
 */
function isApprovalValid(request: ProfileAccessRequest): boolean {
  return (
    request.explicitHumanApproval === true &&
    typeof request.approvalId === "string" &&
    request.approvalId.trim().length > 0
  );
}

/**
 * Evaluates whether sensitive profile facts may be returned for this request.
 *
 * @param request - Access request under evaluation.
 * @returns `true` when sensitive facts may be shown.
 */
function canReadSensitiveFacts(request: ProfileAccessRequest): boolean {
  if (!request.includeSensitive) {
    return false;
  }
  if (request.purpose !== "operator_view") {
    return false;
  }
  return isApprovalValid(request);
}

/**
 * Evaluates whether a profile fact remains active for readable query surfaces.
 *
 * @param fact - Profile fact under evaluation.
 * @returns `true` when the fact is active and not superseded.
 */
function isActiveProfileFact(fact: ProfileFactRecord): boolean {
  return fact.status !== "superseded" && fact.supersededAt === null;
}
