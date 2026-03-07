/**
 * @fileoverview Success and technical outcome rendering helpers for user-facing summaries.
 */

import { TaskRunResult } from "../../core/types";
import { isSimulatedOutput } from "../trustLexicalClassifier";
import { DEFAULT_TRUST_LEXICAL_RULE_CONTEXT } from "./trustSurface";

export interface UserFacingTechnicalOutcomeLines {
  createSkillOutcomeLine: string | null;
  runSkillOutcomeLine: string | null;
  managedProcessOutcomeLine: string | null;
  probeOutcomeLine: string | null;
  browserVerificationOutcomeLine: string | null;
  directExecutionOutcomeLine: string | null;
}

/**
 * Resolves create-skill outcome wording.
 */
export function resolveCreateSkillOutcomeLine(runResult: TaskRunResult): string | null {
  const createSkillResults = runResult.actionResults.filter(
    (result) => result.action.type === "create_skill"
  );
  if (createSkillResults.length === 0) {
    return null;
  }

  const approvedCreateSkillResults = createSkillResults.filter(
    (result) => result.approved
  );
  if (approvedCreateSkillResults.length > 0) {
    const output = [...approvedCreateSkillResults]
      .reverse()
      .map((result) => (typeof result.output === "string" ? result.output.trim() : ""))
      .find((value) => value.length > 0);
    if (output) {
      return `Skill status: ${output}`;
    }
    return "Skill status: created successfully.";
  }

  const blockedCodes = Array.from(
    new Set(
      createSkillResults
        .filter((result) => !result.approved)
        .flatMap((result) => result.blockedBy)
        .map((code) => code.trim())
        .filter((code) => code.length > 0)
    )
  );
  if (blockedCodes.length > 0) {
    return `Skill status: blocked (${blockedCodes.join(", ")}).`;
  }

  return "Skill status: blocked.";
}

/**
 * Resolves run-skill outcome wording.
 */
export function resolveRunSkillOutcomeLine(runResult: TaskRunResult): string | null {
  const runSkillResults = runResult.actionResults.filter(
    (result) => result.action.type === "run_skill"
  );
  if (runSkillResults.length === 0) {
    return null;
  }

  const approvedRunSkillResults = runSkillResults.filter(
    (result) => result.approved
  );
  if (approvedRunSkillResults.length > 0) {
    const output = [...approvedRunSkillResults]
      .reverse()
      .map((result) => (typeof result.output === "string" ? result.output.trim() : ""))
      .find((value) => value.length > 0);
    if (output) {
      return output;
    }
    return "Run skill success.";
  }

  const failedRunSkillResult = [...runSkillResults]
    .reverse()
    .find(
      (result) =>
        !result.approved &&
        (result.executionStatus === "failed" ||
          result.executionFailureCode === "RUN_SKILL_ARTIFACT_MISSING" ||
          result.blockedBy.includes("RUN_SKILL_ARTIFACT_MISSING") ||
          result.violations.some((violation) => violation.code === "RUN_SKILL_ARTIFACT_MISSING") ||
          result.executionFailureCode === "ACTION_EXECUTION_FAILED" ||
          result.blockedBy.includes("ACTION_EXECUTION_FAILED") ||
          result.violations.some((violation) => violation.code === "ACTION_EXECUTION_FAILED"))
    );
  if (failedRunSkillResult) {
    const output = typeof failedRunSkillResult.output === "string"
      ? failedRunSkillResult.output.trim()
      : "";
    if (output.length > 0) {
      return output;
    }
    const violationMessage = failedRunSkillResult.violations
      .filter(
        (violation) =>
          violation.code === "RUN_SKILL_ARTIFACT_MISSING" ||
          violation.code === "ACTION_EXECUTION_FAILED"
      )
      .map((violation) => violation.message.trim())
      .find((message) => message.length > 0);
    return violationMessage ?? "Run skill failed: action execution failed with no detailed output.";
  }
  return null;
}

/**
 * Resolves managed-process lifecycle outcome wording.
 */
export function resolveManagedProcessOutcomeLine(runResult: TaskRunResult): string | null {
  const processResults = runResult.actionResults.filter((result) =>
    result.action.type === "start_process" ||
    result.action.type === "check_process" ||
    result.action.type === "stop_process"
  );
  if (processResults.length === 0) {
    return null;
  }
  const output = [...processResults]
    .reverse()
    .map((result) => (typeof result.output === "string" ? result.output.trim() : ""))
    .find((value) => value.length > 0);
  return output ?? null;
}

/**
 * Resolves readiness-probe outcome wording.
 */
export function resolveProbeOutcomeLine(runResult: TaskRunResult): string | null {
  const probeResults = runResult.actionResults.filter((result) =>
    result.action.type === "probe_port" ||
    result.action.type === "probe_http"
  );
  if (probeResults.length === 0) {
    return null;
  }
  const output = [...probeResults]
    .reverse()
    .map((result) => (typeof result.output === "string" ? result.output.trim() : ""))
    .find((value) => value.length > 0);
  return output ?? null;
}

/**
 * Resolves browser-verification outcome wording.
 */
export function resolveBrowserVerificationOutcomeLine(runResult: TaskRunResult): string | null {
  const browserResults = runResult.actionResults.filter(
    (result) => result.action.type === "verify_browser"
  );
  if (browserResults.length === 0) {
    return null;
  }
  const output = [...browserResults]
    .reverse()
    .map((result) => (typeof result.output === "string" ? result.output.trim() : ""))
    .find((value) => value.length > 0);
  return output ?? null;
}

/**
 * Resolves direct execution success wording for approved non-respond actions.
 */
export function resolveDirectExecutionOutcomeLine(runResult: TaskRunResult): string | null {
  const latestRealExecution = [...runResult.actionResults]
    .reverse()
    .find(
      (result) =>
        result.approved &&
        result.action.type !== "respond" &&
        result.action.type !== "run_skill" &&
        result.action.type !== "create_skill" &&
        result.action.type !== "start_process" &&
        result.action.type !== "check_process" &&
        result.action.type !== "stop_process" &&
        result.action.type !== "probe_port" &&
        result.action.type !== "probe_http" &&
        result.action.type !== "verify_browser" &&
        !isSimulatedOutput(result.output ?? "", DEFAULT_TRUST_LEXICAL_RULE_CONTEXT)
    );
  if (!latestRealExecution) {
    return null;
  }

  switch (latestRealExecution.action.type) {
    case "write_file": {
      const targetPath = latestRealExecution.action.params.path?.trim();
      return targetPath
        ? `I created or updated ${targetPath}.`
        : "I created or updated the requested file.";
    }
    case "delete_file": {
      const targetPath = latestRealExecution.action.params.path?.trim();
      return targetPath ? `I deleted ${targetPath}.` : "I deleted the requested file.";
    }
    case "read_file": {
      const targetPath = latestRealExecution.action.params.path?.trim();
      return targetPath ? `I read ${targetPath}.` : "I read the requested file.";
    }
    case "list_directory": {
      const targetPath = latestRealExecution.action.params.path?.trim();
      return targetPath
        ? `I checked ${targetPath}.`
        : "I checked the requested directory.";
    }
    case "shell_command": {
      const output = typeof latestRealExecution.output === "string"
        ? latestRealExecution.output.trim()
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
      const output = typeof latestRealExecution.output === "string"
        ? latestRealExecution.output.trim()
        : "";
      const responseMatch = output.match(/^Network write response:\s*(.+)$/i);
      if (responseMatch?.[1]) {
        return `I sent the request successfully (${responseMatch[1].trim()}).`;
      }
      return output.length > 0 ? output : "I sent the request successfully.";
    }
    case "self_modify":
      return "I updated the requested runtime code.";
    case "memory_mutation":
      return "I updated the requested memory state.";
    case "pulse_emit":
      return "I sent the requested follow-up prompt.";
    default:
      return null;
  }
}

/**
 * Collects the technical outcome lines used by the result surface.
 */
export function resolveTechnicalOutcomeLines(
  runResult: TaskRunResult
): UserFacingTechnicalOutcomeLines {
  return {
    createSkillOutcomeLine: resolveCreateSkillOutcomeLine(runResult),
    runSkillOutcomeLine: resolveRunSkillOutcomeLine(runResult),
    managedProcessOutcomeLine: resolveManagedProcessOutcomeLine(runResult),
    probeOutcomeLine: resolveProbeOutcomeLine(runResult),
    browserVerificationOutcomeLine: resolveBrowserVerificationOutcomeLine(runResult),
    directExecutionOutcomeLine: resolveDirectExecutionOutcomeLine(runResult)
  };
}
