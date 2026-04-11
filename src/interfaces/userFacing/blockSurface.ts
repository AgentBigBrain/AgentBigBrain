/**
 * @fileoverview Shared policy helpers for blocked user-facing responses and safety-code extraction.
 */

import {
  GovernorId,
  GovernorRejectCategory,
  GovernorVote,
  TaskRunResult
} from "../../core/types";
import { evaluateVerificationGate } from "../../core/stage6_85QualityGatePolicy";
import {
  resolveVerificationCategoryForPrompt,
  shouldEvaluateVerificationGateForDiagnostics
} from "../diagnosticsPromptPolicy";
import { isLiveBuildVerificationPrompt } from "../liveBuildVerificationPromptPolicy";

/**
 * Render options for blocked-message formatting.
 */
export interface BlockMessageRenderOptions {
  showSafetyCodes: boolean;
}

const ABUSE_SIGNAL_REGEXES: RegExp[] = [
  /\bmalware\b/i,
  /\bransomware\b/i,
  /\bspyware\b/i,
  /\bkeylogger\b/i,
  /\b(rootkit|trojan|worm)\b/i,
  /\bphish(?:ing|ed|er)?\b/i,
  /\bexploit(?:ation|ing|ed)?\b/i,
  /\b(botnet|ddos|denial[\s-]?of[\s-]?service)\b/i,
  /\b(data\s+exfil(?:tration|trate)|credential\s+theft)\b/i,
  /\b(steal(?:ing)?\s+(credentials?|passwords?|tokens?)|token\s+theft)\b/i,
  /\b(sql\s*injection|command\s*injection|xss|cross[\s-]?site\s*scripting)\b/i,
  /\b(privilege\s+escalation|backdoor|remote\s+code\s+execution|rce)\b/i,
  /\b(command[\s-]?and[\s-]?control|c2|remote\s+access\s+trojan|rat)\b/i,
  /\b(abusive|harmful|destructive|unsafe)\b/i,
  /\bbypass(?:ing|ed)?\b/i,
  /\b(scam|fraud|extortion|blackmail|doxx?ing|swatting)\b/i
];
const STRUCTURED_ABUSE_REJECT_CATEGORIES: GovernorRejectCategory[] = [
  "ABUSE_MALWARE_OR_FRAUD"
];
const LIVE_BUILD_RUNTIME_POLICY_CODES = [
  "SHELL_DISABLED_BY_POLICY",
  "PROCESS_DISABLED_BY_POLICY"
] as const;
const LOCAL_FOLDER_IN_USE_PATTERN =
  /the process cannot access the file because it is being used by another process\./i;

/**
 * Collects unique block/violation policy codes from failed actions and adds verification-gate failures.
 *
 * @param runResult - Task execution result to inspect.
 * @returns De-duplicated policy code list for user-facing rendering.
 */
export function extractBlockedPolicyCodes(runResult: TaskRunResult): string[] {
  const codes = new Set<string>();
  for (const result of runResult.actionResults) {
    if (result.approved) {
      continue;
    }
    for (const code of result.blockedBy) {
      if (code.trim()) {
        codes.add(code.trim());
      }
    }
    for (const violation of result.violations) {
      if (violation.code.trim()) {
        codes.add(violation.code.trim());
      }
    }
  }

  if (shouldEvaluateVerificationGateForDiagnostics(runResult)) {
    const verificationGate = evaluateVerificationGate({
      gateId: "verification_gate_runtime_chat",
      category: resolveVerificationCategoryForPrompt(runResult.task.userInput),
      proofRefs: runResult.actionResults
        .filter((result) => result.approved && result.action.type !== "respond")
        .map((result) => `action:${result.action.id}`),
      waiverApproved: false
    });
    if (!verificationGate.passed) {
      codes.add("VERIFICATION_GATE_FAILED");
    }
  }

  return Array.from(codes);
}

/**
 * Resolves the blocked-response message shown when no approved completion output is available.
 *
 * @param runResult - Task execution result containing votes and blocked actions.
 * @param policyCodes - Policy/violation codes collected from blocked actions.
 * @param options - Rendering options for optional safety-code tails.
 * @returns A user-facing blocked message, or `null` if no blocked policy signal exists.
 */
export function resolveBlockedActionMessage(
  runResult: TaskRunResult,
  policyCodes: string[],
  options: BlockMessageRenderOptions
): string | null {
  if (policyCodes.length === 0) {
    return null;
  }

  if (policyCodes.includes("IDENTITY_IMPERSONATION_DENIED")) {
    return buildIdentityBlockedMessage(policyCodes, options);
  }

  if (policyCodes.includes("PERSONAL_DATA_APPROVAL_REQUIRED")) {
    return buildPersonalDataBlockedMessage(policyCodes, options);
  }

  if (hasLocalFolderInUseSignal(runResult)) {
    return buildLocalFolderInUseBlockedMessage(policyCodes, options);
  }

  const rejectVotes = extractRejectVotes(runResult);
  if (rejectVotes.length > 0) {
    return buildGovernanceBlockedMessage(rejectVotes, policyCodes, options);
  }

  if (shouldUseLiveBuildPolicyBlockedMessage(runResult.task.userInput, policyCodes)) {
    return buildLiveBuildPolicyBlockedMessage(policyCodes, options);
  }

  const runtimeFailureDetail = resolveRuntimeExecutionFailureDetail(runResult);
  if (runtimeFailureDetail) {
    return buildRuntimeExecutionBlockedMessage(runtimeFailureDetail, policyCodes, options);
  }

  return buildGenericBlockedMessage(policyCodes, options);
}

/**
 * Returns `true` when a blocked action represents a concrete runtime execution failure.
 *
 * @param runResult - Blocked action result to inspect.
 * @returns `true` when the action failed during runtime execution.
 */
function isRuntimeExecutionFailureResult(
  runResult: TaskRunResult["actionResults"][number]
): boolean {
  if (runResult.approved) {
    return false;
  }
  if (runResult.executionFailureCode === "ACTION_EXECUTION_FAILED") {
    return true;
  }
  if (runResult.blockedBy.includes("ACTION_EXECUTION_FAILED")) {
    return true;
  }
  return runResult.violations.some((violation) => violation.code === "ACTION_EXECUTION_FAILED");
}

/**
 * Scores runtime execution failures so higher-signal runtime steps win over early inspection noise.
 *
 * @param actionType - Action type to score.
 * @returns Relative priority score.
 */
function resolveRuntimeExecutionFailurePriority(
  actionType: TaskRunResult["actionResults"][number]["action"]["type"]
): number {
  switch (actionType) {
    case "open_browser":
      return 100;
    case "verify_browser":
      return 95;
    case "start_process":
      return 92;
    case "probe_http":
    case "probe_port":
      return 90;
    case "shell_command":
      return 85;
    case "stop_folder_runtime_processes":
      return 84;
    case "write_file":
      return 80;
    case "delete_file":
      return 78;
    case "network_write":
      return 70;
    case "list_directory":
      return 20;
    default:
      return 10;
  }
}

/**
 * Extracts the most useful human-readable runtime execution failure detail from a blocked action.
 *
 * @param result - Blocked action result to inspect.
 * @returns Normalized failure detail, or `null` when none exists.
 */
function resolveRuntimeExecutionFailureDetailFromResult(
  result: TaskRunResult["actionResults"][number]
): string | null {
  const output = typeof result.output === "string" ? result.output.trim() : "";
  if (output.length > 0) {
    return output;
  }

  const violationMessage = result.violations
    .filter((violation) => violation.code === "ACTION_EXECUTION_FAILED")
    .map((violation) => violation.message.trim())
    .find((message) => message.length > 0);
  if (violationMessage) {
    return violationMessage;
  }

  const fallbackViolationMessage = result.violations
    .map((violation) => violation.message.trim())
    .find((message) => message.length > 0);
  if (fallbackViolationMessage) {
    return fallbackViolationMessage;
  }

  return null;
}

/**
 * Resolves the strongest runtime execution failure detail from one blocked run.
 *
 * @param runResult - Task execution result to inspect.
 * @returns Best available runtime execution failure detail, or `null`.
 */
function resolveRuntimeExecutionFailureDetail(runResult: TaskRunResult): string | null {
  let preferredResult: TaskRunResult["actionResults"][number] | null = null;
  let preferredPriority = -1;
  let preferredIndex = -1;
  runResult.actionResults.forEach((result, index) => {
    if (!isRuntimeExecutionFailureResult(result)) {
      return;
    }
    const priority = resolveRuntimeExecutionFailurePriority(result.action.type);
    if (priority > preferredPriority || (priority === preferredPriority && index > preferredIndex)) {
      preferredResult = result;
      preferredPriority = priority;
      preferredIndex = index;
    }
  });
  if (!preferredResult) {
    return null;
  }
  return resolveRuntimeExecutionFailureDetailFromResult(preferredResult);
}

/**
 * Builds the user-facing message for concrete runtime execution failures.
 *
 * @param detail - Normalized runtime failure detail.
 * @param policyCodes - Block/violation codes to append when enabled.
 * @param options - Rendering options that control safety-code visibility.
 * @returns Runtime failure explanation text.
 */
function buildRuntimeExecutionBlockedMessage(
  detail: string,
  policyCodes: string[],
  options: BlockMessageRenderOptions
): string {
  const normalizedDetail = detail.trim();
  const suffixedDetail = /[.!?]$/.test(normalizedDetail)
    ? normalizedDetail
    : `${normalizedDetail}.`;
  return (
    "I couldn't finish this run. " +
    `What happened: a runtime execution step failed: ${suffixedDetail} ` +
    "Why it didn't execute: the command or environment failed during execution after planning and approval had already advanced. " +
    "What to do next: inspect the failing step and retry after fixing that runtime issue." +
    formatTechnicalCodeTail(policyCodes, options)
  );
}

/**
 * Detects blocked execution results where a local folder move failed because another process still
 * holds the folder open.
 *
 * @param runResult - Task execution result to inspect.
 * @returns `true` when the blocked run matches the in-use folder failure pattern.
 */
function hasLocalFolderInUseSignal(runResult: TaskRunResult): boolean {
  return runResult.actionResults.some((result) => {
    if (result.approved) {
      return false;
    }
    const output = typeof result.output === "string" ? result.output : "";
    if (LOCAL_FOLDER_IN_USE_PATTERN.test(output)) {
      return true;
    }
    return result.violations.some((violation) => LOCAL_FOLDER_IN_USE_PATTERN.test(violation.message));
  });
}

/**
 * Normalizes vote-reason text so duplicate detection and rendering are stable.
 *
 * @param value - Raw vote reason text.
 * @returns Reason text with collapsed whitespace and trimmed edges.
 */
function normalizeReasonText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Extracts unique reject votes from blocked action results.
 *
 * @param runResult - Task execution result to inspect.
 * @returns Reject votes with normalized reason text.
 */
function extractRejectVotes(runResult: TaskRunResult): GovernorVote[] {
  const deduped = new Set<string>();
  const rejectedVotes: GovernorVote[] = [];

  for (const result of runResult.actionResults) {
    if (result.approved) {
      continue;
    }

    for (const vote of result.votes) {
      if (vote.approve) {
        continue;
      }
      const normalizedReason = normalizeReasonText(vote.reason);
      const key = `${vote.governorId}::${normalizedReason.toLowerCase()}`;
      if (deduped.has(key)) {
        continue;
      }
      deduped.add(key);
      rejectedVotes.push({
        ...vote,
        reason: normalizedReason
      });
    }
  }

  return rejectedVotes;
}

/**
 * Returns unique reject categories represented in rejected votes.
 *
 * @param rejectVotes - Reject votes gathered from blocked actions.
 * @returns De-duplicated reject-category list.
 */
function extractRejectCategories(rejectVotes: GovernorVote[]): GovernorRejectCategory[] {
  return Array.from(
    new Set(
      rejectVotes
        .map((vote) => vote.rejectCategory)
        .filter((category): category is GovernorRejectCategory => category !== undefined)
    )
  );
}

/**
 * Formats a governor ID as user-facing label text.
 *
 * @param governorId - Governor identifier from vote records.
 * @returns Human-readable governor label.
 */
function formatGovernorLabel(governorId: GovernorId): string {
  switch (governorId) {
    case "ethics":
      return "Ethics";
    case "logic":
      return "Logic";
    case "resource":
      return "Resource";
    case "security":
      return "Security";
    case "continuity":
      return "Continuity";
    case "utility":
      return "Utility";
    case "compliance":
      return "Compliance";
    case "codeReview":
      return "Code review";
    default:
      return governorId;
  }
}

/**
 * Formats a list of governor IDs into natural-language list text.
 *
 * @param governorIds - Governor IDs participating in a rejection.
 * @returns Rendered list text (for example "Ethics and Security").
 */
function formatGovernorList(governorIds: GovernorId[]): string {
  const labels = governorIds.map((governorId) => formatGovernorLabel(governorId));
  if (labels.length === 0) {
    return "";
  }
  if (labels.length === 1) {
    return labels[0];
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }

  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/**
 * Detects abuse/malware rejection signals from structured categories or lexical vote reasons.
 *
 * @param rejectVotes - Reject votes to inspect.
 * @returns `true` when abuse-oriented governance rejection is present.
 */
function hasMalwareOrAbuseSignal(rejectVotes: GovernorVote[]): boolean {
  const rejectCategories = extractRejectCategories(rejectVotes);
  if (
    rejectCategories.some((category) =>
      STRUCTURED_ABUSE_REJECT_CATEGORIES.includes(category)
    )
  ) {
    return true;
  }

  const reasonText = rejectVotes.map((vote) => vote.reason).join("\n");
  return ABUSE_SIGNAL_REGEXES.some((pattern) => pattern.test(reasonText));
}

/**
 * Builds a short "Main concerns" snippet from the top reject votes.
 *
 * @param rejectVotes - Reject votes to summarize.
 * @returns Optional rationale suffix text.
 */
function buildGovernorRationale(rejectVotes: GovernorVote[]): string {
  if (rejectVotes.length === 0) {
    return "";
  }

  const rationale = rejectVotes
    .slice(0, 2)
    .map((vote) => `${formatGovernorLabel(vote.governorId)}: ${vote.reason}`)
    .join(" | ");
  return rationale ? `\nMain concerns: ${rationale}.` : "";
}

/**
 * Builds the optional technical safety-code suffix.
 *
 * @param policyCodes - Block/violation codes to render.
 * @param options - Rendering options that control safety-code visibility.
 * @returns Empty string when disabled, otherwise a formatted "Safety code(s)" line.
 */
function formatTechnicalCodeTail(
  policyCodes: string[],
  options: BlockMessageRenderOptions
): string {
  if (!options.showSafetyCodes || policyCodes.length === 0) {
    return "";
  }
  return `\nSafety code(s): ${policyCodes.join(", ")}.`;
}

/**
 * Determines whether blocked policy codes match a live-build runtime-policy denial.
 *
 * **Why it exists:**
 * Keeps live-run build prompts from falling through to a generic blocked message when the real
 * issue is that the environment cannot start the shell/process step needed for verification.
 *
 * **What it talks to:**
 * - Uses `isLiveBuildVerificationPrompt` (import `isLiveBuildVerificationPrompt`) from `./liveBuildVerificationPromptPolicy`.
 * - Uses local runtime-policy constants within this module.
 *
 * @param userInput - Raw task user input, potentially including conversation wrappers.
 * @param policyCodes - Block/violation codes collected from blocked actions.
 * @returns `true` when humanized live-build block wording should be used.
 */
function shouldUseLiveBuildPolicyBlockedMessage(
  userInput: string,
  policyCodes: string[]
): boolean {
  if (!isLiveBuildVerificationPrompt(userInput)) {
    return false;
  }
  return LIVE_BUILD_RUNTIME_POLICY_CODES.some((code) => policyCodes.includes(code));
}

/**
 * Builds the user-facing message for identity-impersonation policy blocks.
 *
 * @param policyCodes - Block/violation codes to append when enabled.
 * @param options - Rendering options that control safety-code visibility.
 * @returns Identity-policy block explanation text.
 */
function buildIdentityBlockedMessage(
  policyCodes: string[],
  options: BlockMessageRenderOptions
): string {
  return (
    "I couldn't execute that request in this run. " +
    "What happened: the request asked for human impersonation behavior. " +
    "Why it didn't execute: identity policy requires me to stay explicitly AI and never impersonate you or anyone else. " +
    "What to do next: ask for the same content in third person with explicit AI identity wording." +
    formatTechnicalCodeTail(policyCodes, options)
  );
}

/**
 * Builds the user-facing message for personal-data policy blocks.
 *
 * @param policyCodes - Block/violation codes to append when enabled.
 * @param options - Rendering options that control safety-code visibility.
 * @returns Personal-data block explanation text.
 */
function buildPersonalDataBlockedMessage(
  policyCodes: string[],
  options: BlockMessageRenderOptions
): string {
  return (
    "I couldn't execute that request in this run. " +
    "What happened: the request attempted personal-data sharing. " +
    "Why it didn't execute: personal-data policy requires explicit human approval metadata before release. " +
    "What to do next: provide explicit approval details (approval id + consent scope) or request a non-sensitive summary." +
    formatTechnicalCodeTail(policyCodes, options)
  );
}

/**
 * Builds the user-facing message for local folder moves blocked by in-use process locks.
 *
 * @param policyCodes - Block/violation codes to append when enabled.
 * @param options - Rendering options that control safety-code visibility.
 * @returns Human-first local-lock explanation text.
 */
function buildLocalFolderInUseBlockedMessage(
  policyCodes: string[],
  options: BlockMessageRenderOptions
): string {
  return (
    "I couldn't finish organizing those folders in this run. " +
    "What happened: one or more of the target folders are still being used by another local process, so Windows would not let me move them safely. " +
    "Why it didn't execute: active preview servers, terminals, editors, or sync tools can keep a project folder locked even when the move command itself is correct. " +
    "What to do next: close the related preview or local process first, or ask me to inspect the holder so I can tell you whether it looks like a preview, editor, shell, or sync lock before I retry the move." +
    formatTechnicalCodeTail(policyCodes, options)
  );
}

/**
 * Builds the user-facing message for live-build runtime-policy blocks.
 *
 * **Why it exists:**
 * Explains live-run build denials in plain language so users understand that the app was not
 * started or verified, instead of receiving a generic blocked-action message.
 *
 * **What it talks to:**
 * - Uses `formatTechnicalCodeTail` from this module.
 *
 * @param policyCodes - Block/violation codes to append when enabled.
 * @param options - Rendering options that control safety-code visibility.
 * @returns Live-build block explanation text.
 */
function buildLiveBuildPolicyBlockedMessage(
  policyCodes: string[],
  options: BlockMessageRenderOptions
): string {
  return (
    "I couldn't start the requested live app run in this run. " +
    "What happened: the build request reached a live-run step, but the runtime blocked the shell/process action needed to run the app. " +
    "Why it didn't execute: real shell/process execution is disabled in this environment, so I can't truthfully claim the app was running or the UI was verified. " +
    "What to do next: ask for a finite build flow first (scaffold, edit, install, build), then run the dev server manually and send back the terminal output or a screenshot, or enable approved live-run execution so I can use start_process plus probe_port or probe_http and verify_browser." +
    formatTechnicalCodeTail(policyCodes, options)
  );
}

/**
 * Builds the default blocked-action message when no specialized branch applies.
 *
 * @param policyCodes - Block/violation codes to append when enabled.
 * @param options - Rendering options that control safety-code visibility.
 * @returns Generic blocked-response text.
 */
function buildGenericBlockedMessage(
  policyCodes: string[],
  options: BlockMessageRenderOptions
): string {
  return (
    "I couldn't execute that request in this run. " +
    "What happened: one or more governed actions were blocked before execution. " +
    "Why it didn't execute: a safety, governance, or runtime policy denied the requested side effect. " +
    "What to do next: ask for the exact block code and approval diff, then retry with a narrower allowed action." +
    formatTechnicalCodeTail(policyCodes, options)
  );
}

/**
 * Builds a governance-specific blocked message with reject-vote rationale.
 *
 * @param rejectVotes - Reject votes used for governor and rationale formatting.
 * @param policyCodes - Block/violation codes to append when enabled.
 * @param options - Rendering options that control safety-code visibility.
 * @returns Governance block explanation text.
 */
function buildGovernanceBlockedMessage(
  rejectVotes: GovernorVote[],
  policyCodes: string[],
  options: BlockMessageRenderOptions
): string {
  const governorIds = Array.from(
    new Set(rejectVotes.map((vote) => vote.governorId))
  );
  const governorList = formatGovernorList(governorIds);
  const governanceSentence =
    governorIds.length > 0
      ? `${governorList} governor${governorIds.length > 1 ? "s" : ""} rejected this request.`
      : "Governors rejected this request.";
  const rationale = buildGovernorRationale(rejectVotes);

  if (
    governorIds.includes("security") &&
    governorIds.includes("ethics") &&
    hasMalwareOrAbuseSignal(rejectVotes)
  ) {
    return (
      "I couldn't execute that request in this run. " +
      "What happened: the request matched malware/abuse risk signals and was governance-blocked. " +
      `Why it didn't execute: ${governanceSentence} My role is to help humans safely, and this request crosses that boundary.` +
      " What to do next: ask for defensive or recovery guidance only, without offensive or abusive intent." +
      rationale +
      formatTechnicalCodeTail(policyCodes, options)
    );
  }

  return (
    "I couldn't execute that request in this run. " +
    `What happened: governance blocked the requested action. Why it didn't execute: ${governanceSentence} ` +
    "I have to keep actions safe and aligned with helping humans. " +
    "What to do next: request the exact rejected step with typed codes, then submit a safer/narrower alternative." +
    rationale +
    formatTechnicalCodeTail(policyCodes, options)
  );
}
