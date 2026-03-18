/**
 * @fileoverview Success and technical outcome rendering helpers for user-facing summaries.
 */

import { TaskRunResult } from "../../core/types";
import {
  resolveLocalOrganizationOutcomeLine,
  resolvePartialLocalOrganizationOutcomeLine
} from "./organizationOutcomeSurface";
import {
  resolveDirectExecutionFailureOutcomeLine,
} from "./directExecutionFailureSurface";

export interface UserFacingTechnicalOutcomeLines {
  createSkillOutcomeLine: string | null;
  runSkillOutcomeLine: string | null;
  managedProcessOutcomeLine: string | null;
  probeOutcomeLine: string | null;
  browserVerificationOutcomeLine: string | null;
  directExecutionOutcomeLine: string | null;
  directExecutionFailureOutcomeLine: string | null;
}

/**
 * Returns `true` when one candidate summary only proves inspection, not a stronger visible change.
 */
function isInspectionOnlyOutcomeSummary(summary: string): boolean {
  return /^(?:done[.!-]?\s+)?i\s+(?:checked|read)\b/i.test(summary.trim());
}

/**
 * Scores technical outcome lines so the user-facing layer can prefer the most meaningful proven
 * result instead of whichever technical check happened to run last.
 */
function resolveTechnicalOutcomePriority(
  kind: "direct" | "browser" | "managed_process" | "probe",
  summary: string
): number {
  switch (kind) {
    case "direct":
      return isInspectionOnlyOutcomeSummary(summary) ? 30 : 100;
    case "browser":
      return 90;
    case "probe":
      return 80;
    case "managed_process":
      return 70;
    default:
      return 0;
  }
}

/**
 * Picks the strongest primary execution proof from the available technical outcome lines.
 */
export function resolvePrimaryExecutionOutcomeLine(
  outcomes: UserFacingTechnicalOutcomeLines
): string | null {
  const candidates: Array<{
    kind: "direct" | "browser" | "managed_process" | "probe";
    summary: string;
  }> = [];
  if (outcomes.directExecutionOutcomeLine) {
    candidates.push({
      kind: "direct",
      summary: outcomes.directExecutionOutcomeLine
    });
  }
  if (outcomes.browserVerificationOutcomeLine) {
    candidates.push({
      kind: "browser",
      summary: outcomes.browserVerificationOutcomeLine
    });
  }
  if (outcomes.managedProcessOutcomeLine) {
    candidates.push({
      kind: "managed_process",
      summary: outcomes.managedProcessOutcomeLine
    });
  }
  if (outcomes.probeOutcomeLine) {
    candidates.push({
      kind: "probe",
      summary: outcomes.probeOutcomeLine
    });
  }
  if (candidates.length === 0) {
    return null;
  }

  let preferred = candidates[0];
  let preferredPriority = resolveTechnicalOutcomePriority(preferred.kind, preferred.summary);
  for (const candidate of candidates.slice(1)) {
    const candidatePriority = resolveTechnicalOutcomePriority(
      candidate.kind,
      candidate.summary
    );
    if (candidatePriority > preferredPriority) {
      preferred = candidate;
      preferredPriority = candidatePriority;
    }
  }
  return preferred.summary;
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
 * Picks the strongest direct execution proof for one run, breaking ties toward the latest action.
 */
function resolvePreferredDirectExecutionResult(
  runResult: TaskRunResult
): import("../../core/types").ActionRunResult | null {
  let preferredResult: import("../../core/types").ActionRunResult | null = null;
  let preferredPriority = -1;
  let preferredIndex = -1;
  runResult.actionResults.forEach((result, index) => {
    if (!result.approved || result.action.type === "respond" || result.action.type === "run_skill" || result.action.type === "create_skill" || result.action.type === "start_process" || result.action.type === "check_process" || result.action.type === "stop_process" || result.action.type === "probe_port" || result.action.type === "probe_http" || result.action.type === "verify_browser") {
      return;
    }
    const output = result.output ?? "";
    if (typeof output === "string" && /(?:^|\n)Shell execution simulated|real side-effect action was not executed/i.test(output)) {
      return;
    }
    const priority = (() => {
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
    })();
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
export function resolveDirectExecutionOutcomeLine(runResult: TaskRunResult): string | null {
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
    directExecutionOutcomeLine: resolveDirectExecutionOutcomeLine(runResult),
    directExecutionFailureOutcomeLine: resolveDirectExecutionFailureOutcomeLine(runResult)
  };
}
