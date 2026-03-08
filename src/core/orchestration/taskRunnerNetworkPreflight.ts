/**
 * @fileoverview Stage 6.75 connector and approval preflight for task-runner network writes.
 */

import { canonicalJson } from "../normalizers/canonicalizationRules";
import { evaluateConsistencyPreflight } from "../stage6_75ConsistencyPolicy";
import {
  type Stage675ConnectorOperation,
  validateStage675ConnectorOperation
} from "../stage6_75ConnectorPolicy";
import {
  createApprovalGrantV1,
  createApprovalRequestV1,
  registerApprovalGrantUse,
  validateApprovalGrantUse
} from "../stage6_75ApprovalPolicy";
import { evaluateStage675EgressPolicy } from "../stage6_75EgressPolicy";
import {
  type ActionRunResult,
  type ApprovalGrantV1,
  type ConflictObjectV1,
  type ConstraintViolationCode,
  type GovernanceProposal,
  isConstraintViolationCode,
  STAGE_6_75_BLOCK_CODES,
  type TaskRunResult
} from "../types";
import { normalizeOptionalString } from "../taskRunnerSupport";
import { buildBlockedActionResult } from "./taskRunnerSummary";
import type {
  EvaluateTaskRunnerPreflightResult,
  TaskRunnerPreflightBlockedOutcome
} from "./taskRunnerPreflight";

type Metadata = Record<string, string | number | boolean | null>;

export interface TaskRunnerConnectorReceiptSeed {
  connector: "gmail" | "calendar";
  operation: "read" | "watch" | "draft" | "propose" | "write";
  requestPayload: unknown;
  responseMetadata: unknown;
  externalIds: readonly string[];
}

export interface EvaluateTaskRunnerNetworkWritePreflightInput {
  action: ActionRunResult["action"];
  approvalGrantById: ReadonlyMap<string, ApprovalGrantV1>;
  idempotencyKey: string;
  mode: ActionRunResult["mode"];
  nowIso: string;
  proposal: GovernanceProposal;
  task: TaskRunResult["task"];
}

/** Applies connector consistency, egress, and approval preflight to one network-write action. */
export function evaluateTaskRunnerNetworkWritePreflight(
  input: EvaluateTaskRunnerNetworkWritePreflightInput
): EvaluateTaskRunnerPreflightResult {
  const url =
    normalizeOptionalString(input.action.params.url) ??
    normalizeOptionalString(input.action.params.endpoint);
  if (!url) {
    return {
      proposal: input.proposal,
      blockedOutcome: {
        actionResult: buildBlockedActionResult({
          action: input.action,
          mode: input.mode,
          blockedBy: ["NETWORK_EGRESS_POLICY_BLOCKED"],
          violations: [
            {
              code: "NETWORK_EGRESS_POLICY_BLOCKED",
              message: "Missing URL/endpoint in network_write action."
            }
          ]
        })
      }
    };
  }

  const connectorRaw = normalizeOptionalString(input.action.params.connector)?.toLowerCase();
  const connector =
    connectorRaw === "gmail" || connectorRaw === "calendar"
      ? connectorRaw
      : null;
  const operationRaw =
    normalizeOptionalString(input.action.params.operation)?.toLowerCase() ?? null;
  const connectorOperation = normalizeConnectorOperation(operationRaw);
  if (operationRaw && !connectorOperation) {
    return {
      proposal: input.proposal,
      blockedOutcome: buildConstraintBlockedOutcome(
        input.action,
        input.mode,
        "CONNECTOR_OPERATION_NOT_SUPPORTED_IN_STAGE_6_75",
        `Unsupported connector operation '${operationRaw}'.`
      )
    };
  }

  if (connectorOperation) {
    const connectorDecision = validateStage675ConnectorOperation(connectorOperation);
    if (!connectorDecision.ok && connectorDecision.blockCode) {
      const normalizedConnectorCode = isConstraintViolationCode(connectorDecision.blockCode)
        ? connectorDecision.blockCode
        : "CONNECTOR_OPERATION_NOT_SUPPORTED_IN_STAGE_6_75";
      return {
        proposal: input.proposal,
        blockedOutcome: buildConstraintBlockedOutcome(
          input.action,
          input.mode,
          normalizedConnectorCode,
          connectorDecision.reason
        )
      };
    }
  }

  const requiresConsistencyPreflight =
    input.action.params.requiresConsistencyPreflight === true ||
    connector === "calendar" ||
    connector === "gmail";
  if (requiresConsistencyPreflight) {
    const consistencyBlock = evaluateConsistencyBlock(
      input.action,
      input.mode,
      input.nowIso,
      connector
    );
    if (consistencyBlock) {
      return {
        proposal: input.proposal,
        blockedOutcome: consistencyBlock
      };
    }
  }

  const egressDecision = evaluateStage675EgressPolicy(url);
  if (!egressDecision.ok) {
    return {
      proposal: input.proposal,
      blockedOutcome: buildConstraintBlockedOutcome(
        input.action,
        input.mode,
        "NETWORK_EGRESS_POLICY_BLOCKED",
        egressDecision.reason
      )
    };
  }

  const approvalResult = evaluateApprovalGrant(input, url);
  if (approvalResult.blockedOutcome) {
    return {
      proposal: input.proposal,
      blockedOutcome: approvalResult.blockedOutcome
    };
  }

  return {
    proposal: input.proposal,
    approvalGrant: approvalResult.approvalGrant,
    connectorReceiptInput:
      connector && connectorOperation && connectorOperation !== "update" && connectorOperation !== "delete"
        ? {
            connector,
            operation: connectorOperation,
            requestPayload: input.action.params.payload ?? null,
            responseMetadata: {
              endpoint: url
            },
            externalIds: Array.isArray(input.action.params.externalIds)
              ? input.action.params.externalIds
                  .map((value) => normalizeOptionalString(value))
                  .filter((value): value is string => value !== null)
              : []
          }
        : null
  };
}

/** Evaluates freshness and unresolved-conflict requirements for connector-backed write flows. */
function evaluateConsistencyBlock(
  action: ActionRunResult["action"],
  mode: ActionRunResult["mode"],
  nowIso: string,
  connector: "gmail" | "calendar" | null
): TaskRunnerPreflightBlockedOutcome | null {
  const lastReadAtIso =
    normalizeOptionalString(action.params.lastReadAtIso) ??
    normalizeOptionalString(action.params.observedAtWatermark);
  const unresolvedConflict = parseConflictObject(action.params.unresolvedConflict, nowIso);
  const providedFreshnessWindowMs =
    typeof action.params.freshnessWindowMs === "number" &&
    Number.isFinite(action.params.freshnessWindowMs) &&
    action.params.freshnessWindowMs > 0
      ? Math.floor(action.params.freshnessWindowMs)
      : null;
  const defaultFreshnessWindowMs = connector === "calendar" ? 2_000 : 5_000;
  const consistencyDecision = evaluateConsistencyPreflight({
    nowIso,
    lastReadAtIso,
    freshnessWindowMs: providedFreshnessWindowMs ?? defaultFreshnessWindowMs,
    unresolvedConflict
  });
  if (consistencyDecision.ok || !consistencyDecision.blockCode) {
    return null;
  }

  const normalizedConsistencyCode = isConstraintViolationCode(consistencyDecision.blockCode)
    ? consistencyDecision.blockCode
    : "STATE_STALE_REPLAN_REQUIRED";
  return buildConstraintBlockedOutcome(
    action,
    mode,
    normalizedConsistencyCode,
    consistencyDecision.reason
  );
}

/** Validates and consumes one JIT approval grant for network egress. */
function evaluateApprovalGrant(
  input: EvaluateTaskRunnerNetworkWritePreflightInput,
  url: string
): {
  approvalGrant?: {
    approvalId: string;
    grant: ApprovalGrantV1;
  };
  blockedOutcome?: TaskRunnerPreflightBlockedOutcome;
} {
  const approvalId = normalizeOptionalString(input.action.params.approvalId);
  if (!approvalId) {
    return {
      blockedOutcome: buildConstraintBlockedOutcome(
        input.action,
        input.mode,
        "JIT_APPROVAL_REQUIRED",
        "A cryptographically signed JIT UI diff approval is required for side-effect egress, but none was provided."
      )
    };
  }

  const approvalDiff =
    normalizeOptionalString(input.action.params.approvalDiff) ??
    canonicalJson({
      endpoint: url,
      method: normalizeOptionalString(input.action.params.method) ?? "POST",
      payload: input.action.params.payload ?? null
    });
  const approvalExpiresAtRaw = normalizeOptionalString(input.action.params.approvalExpiresAt);
  const approvalExpiresAt =
    approvalExpiresAtRaw ??
    new Date(Date.now() + 5 * 60 * 1000).toISOString();
  if (!Number.isFinite(Date.parse(approvalExpiresAt))) {
    return {
      blockedOutcome: buildConstraintBlockedOutcome(
        input.action,
        input.mode,
        "APPROVAL_SCOPE_MISMATCH",
        "Approval expiry timestamp is invalid."
      )
    };
  }

  const approvalMaxUses =
    typeof input.action.params.approvalMaxUses === "number" &&
    Number.isFinite(input.action.params.approvalMaxUses) &&
    input.action.params.approvalMaxUses > 0
      ? Math.floor(input.action.params.approvalMaxUses)
      : 1;
  const approvalUses =
    typeof input.action.params.approvalUses === "number" &&
    Number.isFinite(input.action.params.approvalUses) &&
    input.action.params.approvalUses >= 0
      ? Math.floor(input.action.params.approvalUses)
      : 0;
  const approvalRiskClass = input.action.params.riskClass === "tier_2" ? "tier_2" : "tier_3";
  const approvalActionIds = Array.isArray(input.action.params.approvalActionIds)
    ? input.action.params.approvalActionIds
        .map((value) => normalizeOptionalString(value))
        .filter((value): value is string => value !== null)
    : [];
  const approvalIdempotencyKeys = Array.isArray(input.action.params.idempotencyKeys)
    ? input.action.params.idempotencyKeys
        .map((value) => normalizeOptionalString(value))
        .filter((value): value is string => value !== null)
    : [];
  const approvalRequest = createApprovalRequestV1({
    missionId: input.task.id,
    actionIds: approvalActionIds.length > 0 ? approvalActionIds : [input.action.id],
    diff: approvalDiff,
    riskClass: approvalRiskClass,
    idempotencyKeys:
      approvalIdempotencyKeys.length > 0
        ? approvalIdempotencyKeys
        : [input.idempotencyKey],
    expiresAt: approvalExpiresAt,
    maxUses: approvalMaxUses
  });
  const scopedApprovalRequest = {
    ...approvalRequest,
    approvalId
  };
  let approvalGrant = input.approvalGrantById.get(approvalId);
  if (!approvalGrant) {
    const initialGrant = createApprovalGrantV1({
      request: scopedApprovalRequest,
      approvedAt: input.nowIso,
      approvedBy: normalizeOptionalString(input.action.params.approvedBy) ?? "human_operator"
    });
    approvalGrant =
      approvalUses > 0
        ? {
            ...initialGrant,
            uses: approvalUses
          }
        : initialGrant;
  }
  const approvalDecision = validateApprovalGrantUse(scopedApprovalRequest, approvalGrant, {
    missionId: input.task.id,
    actionId: input.action.id,
    idempotencyKey: input.idempotencyKey,
    nowIso: input.nowIso
  });
  if (!approvalDecision.ok) {
    const blockCode =
      approvalDecision.blockCode && isConstraintViolationCode(approvalDecision.blockCode)
        ? approvalDecision.blockCode
        : "APPROVAL_SCOPE_MISMATCH";
    return {
      blockedOutcome: buildConstraintBlockedOutcome(
        input.action,
        input.mode,
        blockCode,
        approvalDecision.reason
      )
    };
  }

  return {
    approvalGrant: {
      approvalId,
      grant: registerApprovalGrantUse(approvalGrant)
    }
  };
}

/** Normalizes optional conflict metadata into the Stage 6.75 conflict-object contract. */
function parseConflictObject(rawValue: unknown, nowIso: string): ConflictObjectV1 | null {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return null;
  }

  const raw = rawValue as Partial<ConflictObjectV1>;
  const rawConflictCode = normalizeOptionalString(raw.conflictCode);
  const detail = normalizeOptionalString(raw.detail);
  const observedAtWatermark = normalizeOptionalString(raw.observedAtWatermark);
  if (rawConflictCode && detail && observedAtWatermark) {
    const conflictCode = STAGE_6_75_BLOCK_CODES.includes(
      rawConflictCode as ConflictObjectV1["conflictCode"]
    )
      ? (rawConflictCode as ConflictObjectV1["conflictCode"])
      : "CONFLICT_OBJECT_UNRESOLVED";
    return {
      conflictCode,
      detail,
      observedAtWatermark
    };
  }

  return {
    conflictCode: "CONFLICT_OBJECT_UNRESOLVED",
    detail: "Conflict object metadata is incomplete.",
    observedAtWatermark: nowIso
  };
}

/** Maps raw connector operation text into the supported Stage 6.75 operation enum. */
function normalizeConnectorOperation(
  rawOperation: string | null
): Stage675ConnectorOperation | null {
  if (
    rawOperation === "read" ||
    rawOperation === "watch" ||
    rawOperation === "draft" ||
    rawOperation === "propose" ||
    rawOperation === "write" ||
    rawOperation === "update" ||
    rawOperation === "delete"
  ) {
    return rawOperation;
  }
  return null;
}

/** Builds a canonical constraint-blocked preflight outcome for network-write checks. */
function buildConstraintBlockedOutcome(
  action: ActionRunResult["action"],
  mode: ActionRunResult["mode"],
  blockCode: ConstraintViolationCode,
  message: string
): TaskRunnerPreflightBlockedOutcome {
  return {
    actionResult: buildBlockedActionResult({
      action,
      mode,
      blockedBy: [blockCode],
      violations: [
        {
          code: blockCode,
          message
        }
      ]
    }),
    traceDetails: {
      blockCode,
      blockCategory: "constraints"
    } satisfies Metadata
  };
}
