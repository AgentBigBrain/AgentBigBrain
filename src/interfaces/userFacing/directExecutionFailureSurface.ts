/**
 * @fileoverview Failure rendering helpers for approved direct execution actions.
 */

import { ActionRunResult, TaskRunResult } from "../../core/types";
import { isSimulatedOutput } from "../trustLexicalClassifier";
import {
  resolveLocalOrganizationOutcomeLine,
  resolvePartialLocalOrganizationOutcomeLine
} from "./organizationOutcomeSurface";
import { DEFAULT_TRUST_LEXICAL_RULE_CONTEXT } from "./trustSurface";

/**
 * Returns `true` when an approved action has concrete success evidence in this run.
 *
 * Legacy fixtures may omit `executionStatus`; treat that as success so old evidence-only tests
 * continue to behave like historical runtime records.
 */
function didApprovedActionExecuteSuccessfully(result: ActionRunResult): boolean {
  return (
    result.approved &&
    (result.executionStatus === undefined || result.executionStatus === "success")
  );
}

/**
 * Returns `true` when an approved action reached runtime execution and then failed or was blocked.
 */
function didApprovedActionExecutionFail(result: ActionRunResult): boolean {
  return (
    result.approved &&
    (result.executionStatus === "failed" || result.executionStatus === "blocked")
  );
}

/**
 * Returns `true` when an action type is eligible for direct user-facing execution wording.
 */
function isDirectExecutionActionType(actionType: ActionRunResult["action"]["type"]): boolean {
  return (
    actionType !== "respond" &&
    actionType !== "run_skill" &&
    actionType !== "create_skill" &&
    actionType !== "start_process" &&
    actionType !== "check_process" &&
    actionType !== "stop_process" &&
    actionType !== "probe_port" &&
    actionType !== "probe_http" &&
    actionType !== "verify_browser"
  );
}

/**
 * Returns `true` when one approved action is eligible for direct user-facing execution wording.
 */
function isDirectExecutionOutcomeCandidate(result: ActionRunResult): boolean {
  return (
    didApprovedActionExecuteSuccessfully(result) &&
    isDirectExecutionActionType(result.action.type) &&
    !isSimulatedOutput(result.output ?? "", DEFAULT_TRUST_LEXICAL_RULE_CONTEXT)
  );
}

/**
 * Returns `true` when one approved direct action should surface as a failed execution attempt.
 */
function isDirectExecutionFailureOutcomeCandidate(result: ActionRunResult): boolean {
  return (
    didApprovedActionExecutionFail(result) &&
    isDirectExecutionActionType(result.action.type) &&
    !isSimulatedOutput(result.output ?? "", DEFAULT_TRUST_LEXICAL_RULE_CONTEXT)
  );
}

/**
 * Scores direct execution actions so user-facing summaries prefer the strongest proven effect over
 * later inspection-only follow-up steps.
 */
function resolveDirectExecutionOutcomePriority(result: ActionRunResult): number {
  switch (result.action.type) {
    case "open_browser":
      return 100;
    case "close_browser":
      return 95;
    case "write_file":
      return 90;
    case "delete_file":
      return 88;
    case "self_modify":
      return 86;
    case "shell_command":
      return 80;
    case "network_write":
      return 78;
    case "memory_mutation":
      return 70;
    case "pulse_emit":
      return 68;
    case "read_file":
      return 20;
    case "list_directory":
      return 10;
    default:
      return 0;
  }
}

/**
 * Picks the strongest failed direct execution attempt for one run, breaking ties toward the latest
 * action so the surfaced failure matches what most recently happened.
 */
function resolvePreferredDirectExecutionFailureResult(
  runResult: TaskRunResult
): ActionRunResult | null {
  let preferredResult: ActionRunResult | null = null;
  let preferredPriority = -1;
  let preferredIndex = -1;
  runResult.actionResults.forEach((result, index) => {
    if (!isDirectExecutionFailureOutcomeCandidate(result)) {
      return;
    }
    const priority = resolveDirectExecutionOutcomePriority(result);
    if (
      priority > preferredPriority ||
      (priority === preferredPriority && index > preferredIndex)
    ) {
      preferredResult = result;
      preferredPriority = priority;
      preferredIndex = index;
    }
  });
  return preferredResult;
}

/**
 * Resolves the strongest available failure detail for one approved action that failed during
 * execution.
 */
function resolveExecutionFailureDetail(result: ActionRunResult): string | null {
  const output = typeof result.output === "string" ? result.output.trim() : "";
  if (output.length > 0) {
    return output;
  }

  const preferredViolationMessage = result.violations
    .filter(
      (violation) =>
        violation.code === result.executionFailureCode ||
        violation.code === "ACTION_EXECUTION_FAILED"
    )
    .map((violation) => violation.message.trim())
    .find((message) => message.length > 0);
  if (preferredViolationMessage) {
    return preferredViolationMessage;
  }

  const fallbackViolationMessage = result.violations
    .map((violation) => violation.message.trim())
    .find((message) => message.length > 0);
  if (fallbackViolationMessage) {
    return fallbackViolationMessage;
  }

  const blockedCode = result.blockedBy.find((code) => code.trim().length > 0);
  if (blockedCode) {
    return blockedCode.trim();
  }

  const failureCode = result.executionFailureCode?.trim();
  if (failureCode && failureCode.length > 0) {
    return failureCode;
  }

  return null;
}

/**
 * Removes redundant type-specific failure prefixes so user-facing summaries stay natural.
 */
function normalizeExecutionFailureDetail(
  result: ActionRunResult,
  detail: string | null
): string | null {
  if (!detail) {
    return null;
  }

  let normalized = detail.trim();
  switch (result.action.type) {
    case "open_browser":
      normalized = normalized.replace(/^Browser open failed:\s*/i, "").trim();
      break;
    case "close_browser":
      normalized = normalized.replace(/^Browser close failed:\s*/i, "").trim();
      break;
    case "shell_command":
      normalized = normalized.replace(/^Shell (?:command )?failed:\s*/i, "").trim();
      break;
    default:
      break;
  }
  return normalized.length > 0 ? normalized : null;
}

/**
 * Appends a normalized failure detail to a user-facing action-attempt prefix.
 */
function appendExecutionFailureDetail(prefix: string, detail: string | null): string {
  if (!detail) {
    return `${prefix}.`;
  }
  return `${prefix}: ${detail}${/[.!?]$/.test(detail) ? "" : "."}`;
}

/**
 * Resolves direct execution failure wording for approved actions that reached runtime execution but
 * did not succeed.
 */
export function resolveDirectExecutionFailureOutcomeLine(
  runResult: TaskRunResult
): string | null {
  const preferredFailure = resolvePreferredDirectExecutionFailureResult(runResult);
  if (!preferredFailure) {
    return null;
  }

  const failureClause =
    preferredFailure.executionStatus === "blocked"
      ? "but runtime execution was blocked"
      : "but it failed";
  const detail = normalizeExecutionFailureDetail(
    preferredFailure,
    resolveExecutionFailureDetail(preferredFailure)
  );

  switch (preferredFailure.action.type) {
    case "write_file": {
      const targetPath = preferredFailure.action.params.path?.trim();
      return appendExecutionFailureDetail(
        targetPath
          ? `I tried to create or update ${targetPath}, ${failureClause}`
          : `I tried to create or update the requested file, ${failureClause}`,
        detail
      );
    }
    case "delete_file": {
      const targetPath = preferredFailure.action.params.path?.trim();
      return appendExecutionFailureDetail(
        targetPath
          ? `I tried to delete ${targetPath}, ${failureClause}`
          : `I tried to delete the requested file, ${failureClause}`,
        detail
      );
    }
    case "shell_command":
      return appendExecutionFailureDetail(
        `I tried to run the command, ${failureClause}`,
        detail
      );
    case "network_write":
      return appendExecutionFailureDetail(
        `I tried to send the request, ${failureClause}`,
        detail
      );
    case "self_modify":
      return appendExecutionFailureDetail(
        `I tried to update the requested runtime code, ${failureClause}`,
        detail
      );
    case "open_browser": {
      const targetUrl = preferredFailure.action.params.url?.trim();
      return appendExecutionFailureDetail(
        targetUrl
          ? `I tried to open ${targetUrl} in your browser, ${failureClause}`
          : `I tried to open the requested page in your browser, ${failureClause}`,
        detail
      );
    }
    case "close_browser": {
      const targetSessionId = preferredFailure.action.params.sessionId?.trim();
      const targetUrl = preferredFailure.action.params.url?.trim();
      if (targetUrl) {
        return appendExecutionFailureDetail(
          `I tried to close the browser window for ${targetUrl}, ${failureClause}`,
          detail
        );
      }
      return appendExecutionFailureDetail(
        targetSessionId
          ? `I tried to close the tracked browser session ${targetSessionId}, ${failureClause}`
          : `I tried to close the tracked browser window, ${failureClause}`,
        detail
      );
    }
    case "memory_mutation":
      return appendExecutionFailureDetail(
        `I tried to update the requested memory state, ${failureClause}`,
        detail
      );
    case "pulse_emit":
      return appendExecutionFailureDetail(
        `I tried to send the requested follow-up prompt, ${failureClause}`,
        detail
      );
    case "read_file": {
      const targetPath = preferredFailure.action.params.path?.trim();
      return appendExecutionFailureDetail(
        targetPath
          ? `I tried to read ${targetPath}, ${failureClause}`
          : `I tried to read the requested file, ${failureClause}`,
        detail
      );
    }
    case "list_directory": {
      const targetPath = preferredFailure.action.params.path?.trim();
      return appendExecutionFailureDetail(
        targetPath
          ? `I tried to check ${targetPath}, ${failureClause}`
          : `I tried to check the requested directory, ${failureClause}`,
        detail
      );
    }
    default:
      return appendExecutionFailureDetail(
        `I tried to execute the requested ${preferredFailure.action.type.replace(/_/g, " ")} action, ${failureClause}`,
        detail
      );
  }
}

/**
 * Picks the strongest direct execution proof for one run, breaking ties toward the latest action.
 */
function resolvePreferredDirectExecutionResult(
  runResult: TaskRunResult
): ActionRunResult | null {
  let preferredResult: ActionRunResult | null = null;
  let preferredPriority = -1;
  let preferredIndex = -1;
  runResult.actionResults.forEach((result, index) => {
    if (!isDirectExecutionOutcomeCandidate(result)) {
      return;
    }
    const priority = resolveDirectExecutionOutcomePriority(result);
    if (
      priority > preferredPriority ||
      (priority === preferredPriority && index > preferredIndex)
    ) {
      preferredResult = result;
      preferredPriority = priority;
      preferredIndex = index;
    }
  });
  return preferredResult;
}

/**
 * Resolves direct execution success wording for approved non-respond actions.
 */
export function resolveDirectExecutionOutcomeLine(
  runResult: TaskRunResult
): string | null {
  const localOrganizationOutcomeLine = resolveLocalOrganizationOutcomeLine(runResult);
  if (localOrganizationOutcomeLine) {
    return localOrganizationOutcomeLine;
  }
  const partialLocalOrganizationOutcomeLine =
    resolvePartialLocalOrganizationOutcomeLine(runResult);
  if (partialLocalOrganizationOutcomeLine) {
    return partialLocalOrganizationOutcomeLine;
  }

  const preferredExecution = resolvePreferredDirectExecutionResult(runResult);
  if (!preferredExecution) {
    return null;
  }

  switch (preferredExecution.action.type) {
    case "write_file": {
      const targetPath = preferredExecution.action.params.path?.trim();
      return targetPath
        ? `I created or updated ${targetPath}.`
        : "I created or updated the requested file.";
    }
    case "delete_file": {
      const targetPath = preferredExecution.action.params.path?.trim();
      return targetPath ? `I deleted ${targetPath}.` : "I deleted the requested file.";
    }
    case "read_file": {
      const targetPath = preferredExecution.action.params.path?.trim();
      return targetPath ? `I read ${targetPath}.` : "I read the requested file.";
    }
    case "list_directory": {
      const targetPath = preferredExecution.action.params.path?.trim();
      return targetPath
        ? `I checked ${targetPath}.`
        : "I checked the requested directory.";
    }
    case "shell_command": {
      const output = typeof preferredExecution.output === "string"
        ? preferredExecution.output.trim()
        : "";
      if (/^Shell success:\s*command returned no output\./i.test(output)) {
        return "I ran the command successfully.";
      }
      if (/^Shell success:\s*/i.test(output)) {
        const commandOutput = output.replace(/^Shell success:\s*/i, "").trim();
        return commandOutput.length > 0
          ? `I ran the command successfully.\nCommand output:\n${commandOutput}`
          : "I ran the command successfully.";
      }
      return output.length > 0 ? output : "I ran the command successfully.";
    }
    case "network_write": {
      const output = typeof preferredExecution.output === "string"
        ? preferredExecution.output.trim()
        : "";
      const responseMatch = output.match(/^Network write response:\s*(.+)$/i);
      if (responseMatch?.[1]) {
        return `I sent the request successfully (${responseMatch[1].trim()}).`;
      }
      return output.length > 0 ? output : "I sent the request successfully.";
    }
    case "self_modify":
      return "I updated the requested runtime code.";
    case "open_browser": {
      const targetUrl = preferredExecution.action.params.url?.trim();
      return targetUrl
        ? `I opened ${targetUrl} in your browser and left it open.`
        : "I opened the requested page in your browser and left it open.";
    }
    case "close_browser": {
      const targetSessionId = preferredExecution.action.params.sessionId?.trim();
      const targetUrl = preferredExecution.action.params.url?.trim();
      if (targetUrl) {
        return `I closed the browser window for ${targetUrl}.`;
      }
      return targetSessionId
        ? `I closed the tracked browser session ${targetSessionId}.`
        : "I closed the tracked browser window.";
    }
    case "memory_mutation":
      return "I updated the requested memory state.";
    case "pulse_emit":
      return "I sent the requested follow-up prompt.";
    default:
      return null;
  }
}
