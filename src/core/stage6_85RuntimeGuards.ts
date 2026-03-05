/**
 * @fileoverview Enforces deterministic Stage 6.85 runtime guards before side-effect execution.
 */

import { evaluateResumeSafety } from "./stage6_85RecoveryPolicy";
import { detectWorkflowConflict, evaluateComputerUseBridge } from "./stage6_85WorkflowReplayPolicy";
import { ConstraintViolation, TaskRunResult, isConstraintViolationCode } from "./types";

/**
 * Shared Stage 6.85 runtime-guard result shape.
 */
export interface Stage685RuntimeGuardResult {
  violation: ConstraintViolation;
  conflictCode: string | null;
}

/**
 * Converts values into record or empty form for consistent runtime-guard processing.
 *
 * **Why it exists:**
 * Keeps params parsing deterministic when guard checks receive non-object payloads.
 *
 * **What it talks to:**
 * - Local type guards only; no cross-module collaborators.
 *
 * @param value - Unknown action params payload.
 * @returns Plain object record or `{}` for non-record inputs.
 */
function asRecordOrEmpty(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Converts values into optional integer form for deterministic guard checks.
 *
 * **Why it exists:**
 * Ensures numeric metadata fields are validated consistently across guard paths.
 *
 * **What it talks to:**
 * - Local numeric checks only; no cross-module collaborators.
 *
 * @param value - Unknown metadata value that may be an integer.
 * @returns Integer value or `null` when missing/invalid.
 */
function toOptionalInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

/**
 * Converts values into optional boolean form for deterministic guard checks.
 *
 * **Why it exists:**
 * Ensures boolean metadata fields are validated consistently across guard paths.
 *
 * **What it talks to:**
 * - Local type checks only; no cross-module collaborators.
 *
 * @param value - Unknown metadata value that may be a boolean.
 * @returns Boolean value or `null` when missing/invalid.
 */
function toOptionalBoolean(value: unknown): boolean | null {
  if (typeof value !== "boolean") {
    return null;
  }
  return value;
}

/**
 * Evaluates own metadata key presence and returns a deterministic signal.
 *
 * **Why it exists:**
 * Avoids inherited-key ambiguity when action metadata is inspected by runtime guards.
 *
 * **What it talks to:**
 * - Uses `Object.prototype.hasOwnProperty`.
 *
 * @param record - Parsed params object to inspect.
 * @param key - Exact metadata key expected on `record`.
 * @returns `true` when key exists directly on `record`.
 */
function hasOwnMetadataKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Normalizes optional string values for deterministic workflow guard checks.
 *
 * **Why it exists:**
 * Keeps optional string parsing consistent across action-family/operation metadata checks.
 *
 * **What it talks to:**
 * - Local string operations only; no cross-module collaborators.
 *
 * @param value - Unknown metadata value that may contain string data.
 * @returns Trimmed non-empty string or `null` when missing/invalid.
 */
function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Evaluates Stage 6.85 resume-safety metadata guard.
 *
 * **Why it exists:**
 * Prevents stale approvals and diff/freshness mismatches from silently continuing execution.
 *
 * **What it talks to:**
 * - Uses `evaluateResumeSafety` from `./stage6_85RecoveryPolicy`.
 * - Uses `isConstraintViolationCode` from `./types` for typed-code normalization.
 *
 * @param action - Planned action candidate under runtime guard review.
 * @returns Guard violation result or `null` when resume metadata is absent/valid.
 */
function evaluateResumeSafetyRuntimeGuard(
  action: TaskRunResult["plan"]["actions"][number]
): Stage685RuntimeGuardResult | null {
  const params = asRecordOrEmpty(action.params);
  const hasResumeMetadata =
    hasOwnMetadataKey(params, "approvalUses") ||
    hasOwnMetadataKey(params, "approvalMaxUses") ||
    hasOwnMetadataKey(params, "freshnessValid") ||
    hasOwnMetadataKey(params, "diffHashMatches");
  if (!hasResumeMetadata) {
    return null;
  }

  const approvalUses = toOptionalInteger(params.approvalUses);
  const approvalMaxUses = toOptionalInteger(params.approvalMaxUses);
  const freshnessValid = toOptionalBoolean(params.freshnessValid);
  const diffHashMatches = toOptionalBoolean(params.diffHashMatches);
  if (
    approvalUses === null ||
    approvalUses < 0 ||
    approvalMaxUses === null ||
    approvalMaxUses <= 0 ||
    freshnessValid === null ||
    diffHashMatches === null
  ) {
    return {
      violation: {
        code: "STATE_STALE_REPLAN_REQUIRED",
        message: "Resume metadata is invalid; fail-closed replan required before execution."
      },
      conflictCode: null
    };
  }

  const decision = evaluateResumeSafety({
    approvalUses,
    approvalMaxUses,
    freshnessValid,
    diffHashMatches
  });
  if (decision.allowed || !decision.blockCode) {
    return null;
  }
  const normalizedCode = isConstraintViolationCode(decision.blockCode)
    ? decision.blockCode
    : "STATE_STALE_REPLAN_REQUIRED";
  return {
    violation: {
      code: normalizedCode,
      message:
        normalizedCode === decision.blockCode
          ? decision.reason
          : `${decision.reason} (normalized from ${decision.blockCode}).`
    },
    conflictCode: null
  };
}

/**
 * Evaluates Stage 6.85 workflow-replay metadata guard.
 *
 * **Why it exists:**
 * Enforces typed bridge and conflict checks for governed workflow replay actions.
 *
 * **What it talks to:**
 * - Uses `evaluateComputerUseBridge` and `detectWorkflowConflict` from `./stage6_85WorkflowReplayPolicy`.
 *
 * @param action - Planned action candidate under runtime guard review.
 * @returns Guard violation result or `null` when workflow metadata is absent/valid.
 */
function evaluateWorkflowReplayRuntimeGuard(
  action: TaskRunResult["plan"]["actions"][number]
): Stage685RuntimeGuardResult | null {
  if (action.type !== "run_skill") {
    return null;
  }

  const params = asRecordOrEmpty(action.params);
  const actionFamily = normalizeOptionalString(params.actionFamily);
  const operation = normalizeOptionalString(params.operation);
  const hasWorkflowMetadata =
    actionFamily !== null ||
    operation !== null ||
    hasOwnMetadataKey(params, "schemaSupported") ||
    hasOwnMetadataKey(params, "windowFocused") ||
    hasOwnMetadataKey(params, "navigationMatches") ||
    hasOwnMetadataKey(params, "selectorFound") ||
    hasOwnMetadataKey(params, "assertionPassed");
  if (!hasWorkflowMetadata) {
    return null;
  }

  if (!actionFamily || !operation) {
    return {
      violation: {
        code: "WORKFLOW_DRIFT_DETECTED",
        message:
          "Workflow replay metadata missing actionFamily/operation; fail-closed bridge enforcement denied execution."
      },
      conflictCode: "CAPTURE_SCHEMA_UNSUPPORTED"
    };
  }

  const bridgeDecision = evaluateComputerUseBridge({
    actionType: action.type,
    actionFamily,
    operation
  });
  if (!bridgeDecision.allowed) {
    return {
      violation: {
        code: "WORKFLOW_DRIFT_DETECTED",
        message: bridgeDecision.reason
      },
      conflictCode: null
    };
  }

  const schemaSupportedRaw = params.schemaSupported;
  const windowFocusedRaw = params.windowFocused;
  const navigationMatchesRaw = params.navigationMatches;
  const selectorFoundRaw = params.selectorFound;
  const assertionPassedRaw = params.assertionPassed;

  if (
    (hasOwnMetadataKey(params, "schemaSupported") && toOptionalBoolean(schemaSupportedRaw) === null) ||
    (hasOwnMetadataKey(params, "windowFocused") && toOptionalBoolean(windowFocusedRaw) === null) ||
    (hasOwnMetadataKey(params, "navigationMatches") && toOptionalBoolean(navigationMatchesRaw) === null) ||
    (hasOwnMetadataKey(params, "selectorFound") && toOptionalBoolean(selectorFoundRaw) === null) ||
    (hasOwnMetadataKey(params, "assertionPassed") && toOptionalBoolean(assertionPassedRaw) === null)
  ) {
    return {
      violation: {
        code: "WORKFLOW_DRIFT_DETECTED",
        message: "Workflow replay conflict metadata must use strict booleans."
      },
      conflictCode: "CAPTURE_SCHEMA_UNSUPPORTED"
    };
  }

  const conflictCode = detectWorkflowConflict({
    schemaSupported: toOptionalBoolean(schemaSupportedRaw) ?? true,
    windowFocused: toOptionalBoolean(windowFocusedRaw) ?? true,
    navigationMatches: toOptionalBoolean(navigationMatchesRaw) ?? true,
    selectorFound: toOptionalBoolean(selectorFoundRaw) ?? true,
    assertionPassed: toOptionalBoolean(assertionPassedRaw) ?? true
  });
  if (conflictCode === null) {
    return null;
  }

  return {
    violation: {
      code: "WORKFLOW_DRIFT_DETECTED",
      message: `Workflow replay drift detected (${conflictCode}); recapture or approved patch required.`
    },
    conflictCode
  };
}

/**
 * Evaluates Stage 6.85 runtime guard sequence for a planned action.
 *
 * **Why it exists:**
 * Provides one deterministic entrypoint for resume-safety and workflow-replay guard checks.
 *
 * **What it talks to:**
 * - Uses local resume-safety and workflow-replay guard helpers.
 *
 * @param action - Planned action candidate under Stage 6.85 runtime guard policy.
 * @returns Guard violation result or `null` when no Stage 6.85 guard blocks execution.
 */
export function evaluateStage685RuntimeGuard(
  action: TaskRunResult["plan"]["actions"][number]
): Stage685RuntimeGuardResult | null {
  const resumeGuard = evaluateResumeSafetyRuntimeGuard(action);
  if (resumeGuard) {
    return resumeGuard;
  }
  return evaluateWorkflowReplayRuntimeGuard(action);
}
