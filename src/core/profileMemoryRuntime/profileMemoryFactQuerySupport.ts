/**
 * @fileoverview Shared bounded read/query helpers for active profile facts, sensitivity gating,
 * and readable fact projection.
 */

import type { ProfileFactRecord, ProfileMemoryState } from "../profileMemory";
import { isStoredProfileFactEffectivelySensitive } from "./profileMemoryFactSensitivity";
import type { ProfileAccessRequest, ProfileReadableFact } from "./contracts";
import type { ProfileMemoryQueryDecisionRecord } from "./profileMemoryDecisionRecordContracts";

/**
 * Evaluates whether a profile access request includes explicit human approval metadata.
 *
 * **Why it exists:**
 * Read and review surfaces share the same explicit-approval gate, so this validation lives in one
 * place instead of drifting across query helpers.
 *
 * **What it talks to:**
 * - Uses `ProfileAccessRequest` (import type) from `./contracts`.
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
 * Evaluates whether one stored fact should be treated as sensitive after the code-owned family
 * floor is enforced.
 *
 * **Why it exists:**
 * Query and continuity surfaces both need the same effective sensitivity floor, so the shared
 * helper prevents divergence between read paths.
 *
 * **What it talks to:**
 * - Uses `isStoredProfileFactEffectivelySensitive` (import) from `./profileMemoryFactSensitivity`.
 *
 * @param fact - Stored fact under evaluation.
 * @returns `true` when the fact is effectively sensitive on bounded read/query surfaces.
 */
export function isProfileFactEffectivelySensitive(fact: ProfileFactRecord): boolean {
  return isStoredProfileFactEffectivelySensitive(fact);
}

/**
 * Evaluates whether sensitive profile facts may be returned for one bounded request.
 *
 * **Why it exists:**
 * Review, read, and planning inspections must share the same fail-closed sensitivity posture
 * instead of open-coding approval checks.
 *
 * **What it talks to:**
 * - Uses local `isApprovalValid(...)`.
 *
 * @param request - Access request under evaluation.
 * @returns `true` when sensitive facts may be shown.
 */
export function canReadSensitiveFacts(request: ProfileAccessRequest): boolean {
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
 * **Why it exists:**
 * Multiple query surfaces need the same active-fact definition, so the status and supersession
 * check stays centralized.
 *
 * **What it talks to:**
 * - Uses local fact fields only.
 *
 * @param fact - Profile fact under evaluation.
 * @returns `true` when the fact is active and not superseded.
 */
export function isActiveProfileFact(fact: ProfileFactRecord): boolean {
  return fact.status !== "superseded" && fact.supersededAt === null;
}

/**
 * Projects one active fact into the public readable-fact shape used by bounded review surfaces.
 *
 * **Why it exists:**
 * Read, review, and continuity paths all need the same readable projection, so the mapping stays
 * deterministic and sensitivity-aware in one helper.
 *
 * **What it talks to:**
 * - Uses local `isProfileFactEffectivelySensitive(...)`.
 *
 * @param fact - Active fact record under projection.
 * @returns Readable fact view.
 */
export function toReadableFact(fact: ProfileFactRecord): ProfileReadableFact {
  return {
    factId: fact.id,
    key: fact.key,
    value: fact.value,
    status: fact.status,
    sensitive: isProfileFactEffectivelySensitive(fact),
    observedAt: fact.observedAt,
    lastUpdatedAt: fact.lastUpdatedAt,
    confidence: fact.confidence,
    mutationAudit: fact.mutationAudit
  };
}

/**
 * Recovers the backing state fact record for one readable-fact projection.
 *
 * **Why it exists:**
 * Planner context still needs the original state record after bounded readable selection, so this
 * helper enforces that the projection and state remain in sync.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryState` (import type) from `../profileMemory`.
 *
 * @param state - Loaded profile-memory state.
 * @param fact - Readable fact projection.
 * @returns Backing state fact record.
 */
export function toStateFactRecord(
  state: ProfileMemoryState,
  fact: ProfileReadableFact
): ProfileFactRecord {
  const stateFact = state.facts.find((entry) => entry.id === fact.factId);
  if (!stateFact) {
    throw new Error(`Readable fact ${fact.factId} is missing from profile-memory state.`);
  }
  return stateFact;
}

/**
 * Converts one governance action plus visibility posture into a bounded query-time disposition.
 *
 * **Why it exists:**
 * Query proof records need one stable disposition mapping so planners, review surfaces, and tests
 * do not drift on how the same governance outcome is described.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryQueryDecisionRecord` (import type) from `./profileMemoryDecisionRecordContracts`.
 *
 * @param action - Governance action assigned to the fact source.
 * @param compatibilityVisible - Whether the fact is allowed on compatibility surfaces.
 * @param selected - Whether the fact survived bounded query selection.
 * @param corroborationMode - Family-level corroboration posture.
 * @returns Deterministic query-time disposition.
 */
export function deriveQueryDecisionDisposition(
  action: "allow_current_state" | "allow_episode_support" | "support_only_legacy" | "allow_end_state" | "quarantine",
  compatibilityVisible: boolean,
  selected: boolean,
  corroborationMode: "not_required" | "required_before_current_state" | "required_before_any_visibility"
): ProfileMemoryQueryDecisionRecord["disposition"] {
  if (action === "quarantine") {
    return "quarantined";
  }
  if (selected) {
    return action === "support_only_legacy"
      ? "selected_supporting_history"
      : "selected_current_state";
  }
  if (!compatibilityVisible) {
    if (corroborationMode !== "not_required") {
      return "needs_corroboration";
    }
    return "insufficient_evidence";
  }
  return "ambiguous_contested";
}
