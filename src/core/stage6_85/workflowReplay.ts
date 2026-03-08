/**
 * @fileoverview Canonical Stage 6.85 workflow-replay helpers for capture normalization, script compilation, conflict detection, and run receipts.
 */

import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";
import type {
  Stage685BlockCode,
  WorkflowCaptureEventV1,
  WorkflowCaptureV1,
  WorkflowConflictCodeV1,
  WorkflowOperationV1,
  WorkflowRunReceiptV1,
  WorkflowScriptV1
} from "../types";

export interface WorkflowBridgeDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Normalizes ordering for workflow-capture events.
 *
 * @param events - Value for events.
 * @returns Ordered collection produced by this step.
 */
function sortCaptureEvents(events: readonly WorkflowCaptureEventV1[]): WorkflowCaptureEventV1[] {
  return [...events].sort((left, right) => {
    if (left.timestampMs !== right.timestampMs) {
      return left.timestampMs - right.timestampMs;
    }
    return left.eventId.localeCompare(right.eventId);
  });
}

/**
 * Builds a deterministic workflow capture envelope.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `WorkflowCaptureV1` result.
 */
export function buildWorkflowCaptureV1(input: {
  captureId: string;
  startedAt: string;
  stoppedAt: string;
  events: readonly WorkflowCaptureEventV1[];
}): WorkflowCaptureV1 {
  return {
    captureId: input.captureId.trim() || "capture_unknown",
    startedAt: input.startedAt,
    stoppedAt: input.stoppedAt,
    events: sortCaptureEvents(input.events)
  };
}

/**
 * Maps a capture event type to the canonical replay operation.
 *
 * @param eventType - Value for event type.
 * @returns Computed `WorkflowOperationV1` result.
 */
function mapEventToOperation(eventType: WorkflowCaptureEventV1["type"]): WorkflowOperationV1 {
  if (eventType === "navigate") {
    return "replay_step";
  }
  if (eventType === "click") {
    return "replay_step";
  }
  return "replay_step";
}

/**
 * Compiles a deterministic workflow script from a captured workflow envelope.
 *
 * @param capture - Value for capture.
 * @returns Computed `WorkflowScriptV1` result.
 */
export function compileWorkflowScriptV1(capture: WorkflowCaptureV1): WorkflowScriptV1 {
  const replaySteps = capture.events.map((event, index) => {
    const stepId = `step_${String(index + 1).padStart(2, "0")}`;
    const operation = mapEventToOperation(event.type);
    const idempotencyKey = sha256HexFromCanonicalJson({
      captureId: capture.captureId,
      stepId,
      selector: event.selector,
      operation
    });
    return {
      stepId,
      operation,
      selector: event.selector,
      assertion: event.type === "navigate" ? "url_matches" : "element_present",
      retryPolicy: "bounded" as const,
      idempotencyKey
    };
  });

  return {
    scriptId: `script_${capture.captureId}`,
    captureId: capture.captureId,
    steps: replaySteps
  };
}

/**
 * Evaluates the deterministic bridge between computer-use action family and workflow replay.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `WorkflowBridgeDecision` result.
 */
export function evaluateComputerUseBridge(input: {
  actionType: string;
  actionFamily: string;
  operation: string;
}): WorkflowBridgeDecision {
  const operationAllowlist = new Set<WorkflowOperationV1>([
    "capture_start",
    "capture_stop",
    "compile",
    "replay_step"
  ]);
  if (input.actionType !== "run_skill") {
    return { allowed: false, reason: "ActionType bridge must remain run_skill in Stage 6.85 rollout." };
  }
  if (input.actionFamily !== "computer_use") {
    return { allowed: false, reason: "Action family must be computer_use for workflow replay." };
  }
  if (!operationAllowlist.has(input.operation as WorkflowOperationV1)) {
    return { allowed: false, reason: "Workflow operation is unsupported for Stage 6.85 computer-use flow." };
  }
  return { allowed: true, reason: "Computer-use bridge mapping is valid." };
}

/**
 * Detects deterministic workflow conflicts in priority order.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `WorkflowConflictCodeV1 | null` result.
 */
export function detectWorkflowConflict(input: {
  schemaSupported: boolean;
  windowFocused: boolean;
  navigationMatches: boolean;
  selectorFound: boolean;
  assertionPassed: boolean;
}): WorkflowConflictCodeV1 | null {
  if (!input.schemaSupported) {
    return "CAPTURE_SCHEMA_UNSUPPORTED";
  }
  if (!input.windowFocused) {
    return "WINDOW_NOT_FOCUSED";
  }
  if (!input.navigationMatches) {
    return "NAVIGATION_MISMATCH";
  }
  if (!input.selectorFound) {
    return "SELECTOR_NOT_FOUND";
  }
  if (!input.assertionPassed) {
    return "ASSERTION_FAILED";
  }
  return null;
}

/**
 * Builds a deterministic workflow-run receipt from replay execution results.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `WorkflowRunReceiptV1` result.
 */
export function buildWorkflowRunReceipt(input: {
  runId: string;
  scriptId: string;
  operation: WorkflowOperationV1;
  conflictCode: WorkflowConflictCodeV1 | null;
}): WorkflowRunReceiptV1 {
  const blockCode: Stage685BlockCode | null =
    input.conflictCode === null ? null : "WORKFLOW_DRIFT_DETECTED";
  return {
    runId: input.runId,
    scriptId: input.scriptId,
    operation: input.operation,
    actionFamily: "computer_use",
    actionTypeBridge: "run_skill",
    approved: blockCode === null,
    blockCode,
    conflictCode: input.conflictCode
  };
}
