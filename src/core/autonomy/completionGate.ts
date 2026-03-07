/**
 * @fileoverview Resolves deterministic autonomy stop conditions tied to live-run completion.
 */

import type { TaskRunResult } from "../types";
import {
  EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED_REASON_CODE,
  EXECUTION_STYLE_PROCESS_NEVER_READY_REASON_CODE,
  MISSION_REQUIREMENT_BROWSER,
  MISSION_REQUIREMENT_READINESS,
  formatReasonWithCode,
  type MissionCompletionContract,
  type MissionRequirementId
} from "./contracts";
import {
  isBrowserProofEvidenceAction,
  isReadinessProofEvidenceAction
} from "./missionEvidence";

type ActionResultEntry = TaskRunResult["actionResults"][number];

/**
 * Normalizes text for deterministic case-insensitive command checks.
 *
 * **Why it exists:**
 * Live-verification shell-step detection should not vary with casing or whitespace drift.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param input - Source text to normalize.
 * @returns Lower-cased normalized text.
 */
function normalizeEvidenceText(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Detects whether a task result contains a specific execution failure code.
 *
 * **Why it exists:**
 * Completion gating should react to typed runtime failures without re-parsing free-form text.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @param failureCode - Typed execution failure code to detect.
 * @returns `true` when the result contains the requested failure code.
 */
function hasExecutionFailureCode(result: TaskRunResult, failureCode: string): boolean {
  return result.actionResults.some((entry) =>
    !entry.approved &&
    (
      entry.executionFailureCode === failureCode ||
      entry.blockedBy.some((blockCode) => blockCode === failureCode)
    )
  );
}

/**
 * Reads an action command string when the action carries one.
 *
 * **Why it exists:**
 * Shell-based localhost or Playwright flows need deterministic command extraction before they can
 * be classified as live verification work.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param action - Planned action executed in task runner.
 * @returns Command text, or an empty string when no command is present.
 */
function readActionCommandText(action: ActionResultEntry["action"]): string {
  const params = action.params as Record<string, unknown>;
  return typeof params.command === "string" ? params.command : "";
}

/**
 * Evaluates action type and returns whether it is a localhost or browser proof action.
 *
 * **Why it exists:**
 * Live verification uses a smaller action vocabulary than the full executor surface. Centralizing
 * that classification keeps the abort gate focused on the relevant actions.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param actionType - Planned action type.
 * @returns `true` when the action type is a live proof action.
 */
function isLiveVerificationProofActionType(
  actionType: ActionResultEntry["action"]["type"]
): boolean {
  return (
    actionType === "probe_port" ||
    actionType === "probe_http" ||
    actionType === "verify_browser"
  );
}

/**
 * Evaluates action and returns whether it is a shell-based localhost or live-verification step.
 *
 * **Why it exists:**
 * Some planner drifts express local-server or Playwright work through shell text, so the
 * completion gate needs one deterministic classifier for those cases too.
 *
 * **What it talks to:**
 * - Uses local command helpers within this module.
 *
 * @param action - Planned action executed in task runner.
 * @returns `true` when the action represents a shell-based live verification step.
 */
function isShellBasedLiveVerificationAction(action: ActionResultEntry["action"]): boolean {
  if (action.type !== "shell_command" && action.type !== "start_process") {
    return false;
  }
  const command = normalizeEvidenceText(readActionCommandText(action));
  if (!command) {
    return false;
  }
  return (
    /\bplaywright\b/.test(command) ||
    /\bpython\s+-m\s+http\.server\b/.test(command) ||
    /\b(localhost|127\.0\.0\.1|::1)\b/.test(command) ||
    /\bnpm\s+(?:start|run\s+dev)\b/.test(command) ||
    /\b(?:pnpm|yarn)\s+(?:start|dev)\b/.test(command) ||
    /\b(?:next|vite)\s+dev\b/.test(command)
  );
}

/**
 * Evaluates action and returns whether it belongs to a live localhost or browser verification flow.
 *
 * **Why it exists:**
 * The abort gate should inspect only live-run specific actions instead of every blocked result in
 * the task summary.
 *
 * **What it talks to:**
 * - Uses local live-verification helpers within this module.
 *
 * @param action - Planned action executed in task runner.
 * @returns `true` when the action participates in a live verification flow.
 */
function isLiveVerificationRelatedAction(action: ActionResultEntry["action"]): boolean {
  return (
    action.type === "start_process" ||
    isLiveVerificationProofActionType(action.type) ||
    isShellBasedLiveVerificationAction(action)
  );
}

/**
 * Builds a readable label for missing live-verification proof requirements.
 *
 * **Why it exists:**
 * Human-first abort reasons should name the blocked proof steps in plain language instead of raw
 * mission requirement tokens.
 *
 * **What it talks to:**
 * - Uses local mission-requirement constants within this module.
 *
 * @param missingRequirements - Ordered missing requirement identifiers.
 * @returns Human-readable proof-step label.
 */
function describeMissingLiveVerificationProof(
  missingRequirements: readonly MissionRequirementId[]
): string {
  const missingReadiness = missingRequirements.includes(MISSION_REQUIREMENT_READINESS);
  const missingBrowser = missingRequirements.includes(MISSION_REQUIREMENT_BROWSER);
  if (missingReadiness && missingBrowser) {
    return "localhost readiness and browser verification";
  }
  if (missingBrowser) {
    return "browser verification";
  }
  return "localhost readiness verification";
}

/**
 * Resolves an early-abort reason when live verification is blocked by the environment.
 *
 * **Why it exists:**
 * Once governance or runtime blocks the remaining localhost proof steps, the loop should stop
 * honestly instead of letting the model invent manual checks that still cannot provide proof.
 *
 * **What it talks to:**
 * - Uses `isReadinessProofEvidenceAction` and `isBrowserProofEvidenceAction` from `./missionEvidence`.
 * - Uses autonomy reason contracts from `./contracts`.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @param missionContract - Mission completion requirements for the overarching goal.
 * @param missingRequirements - Ordered missing requirement identifiers after this iteration.
 * @returns Abort reason text with typed code, or `null` when the loop should continue.
 */
export function resolveLiveVerificationBlockedAbortReason(
  result: TaskRunResult,
  missionContract: MissionCompletionContract,
  missingRequirements: readonly MissionRequirementId[]
): string | null {
  if (!missionContract.executionStyle) {
    return null;
  }
  if (
    !missingRequirements.includes(MISSION_REQUIREMENT_READINESS) &&
    !missingRequirements.includes(MISSION_REQUIREMENT_BROWSER)
  ) {
    return null;
  }
  if (hasExecutionFailureCode(result, "BROWSER_VERIFY_RUNTIME_UNAVAILABLE")) {
    return null;
  }

  const liveVerificationEntries = result.actionResults.filter((entry) =>
    isLiveVerificationRelatedAction(entry.action)
  );
  if (liveVerificationEntries.length === 0) {
    return null;
  }
  if (
    liveVerificationEntries.some((entry) =>
      isReadinessProofEvidenceAction(entry, missionContract.requireBrowserProof) ||
      isBrowserProofEvidenceAction(entry)
    )
  ) {
    return null;
  }

  const blockedReasons = new Set<string>();
  for (const entry of liveVerificationEntries) {
    if (entry.approved) {
      continue;
    }
    for (const blockedReason of entry.blockedBy) {
      blockedReasons.add(blockedReason);
    }
  }

  const environmentBlocked =
    blockedReasons.has("SHELL_DISABLED_BY_POLICY") ||
    blockedReasons.has("ethics") ||
    blockedReasons.has("resource") ||
    blockedReasons.has("security") ||
    blockedReasons.has("continuity") ||
    blockedReasons.has("utility") ||
    /\bMISSION_STOP_LIMIT_REACHED\b/i.test(result.summary);
  if (!environmentBlocked) {
    return null;
  }

  return formatReasonWithCode(
    EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED_REASON_CODE,
    "Live verification stopped because the environment blocked " +
      `${describeMissingLiveVerificationProof(missingRequirements)} steps, ` +
      "so I could not truthfully confirm the app or page in this run."
  );
}

/**
 * Builds a typed abort reason when one running local process never becomes HTTP-ready.
 *
 * **Why it exists:**
 * Bounded readiness retries need one shared final reason string before the loop gives up and
 * cleans up the managed process.
 *
 * **What it talks to:**
 * - Uses autonomy reason contracts from `./contracts`.
 *
 * @param targetLabel - Readable loopback target label, if known.
 * @returns Prefixed abort reason suitable for logs and interface humanization.
 */
export function formatManagedProcessNeverReadyReason(targetLabel: string | null): string {
  return formatReasonWithCode(
    EXECUTION_STYLE_PROCESS_NEVER_READY_REASON_CODE,
    "Live verification stopped because the running local process never became HTTP-ready" +
      `${targetLabel ? ` at ${targetLabel}` : ""}, so I stopped retrying and could not truthfully ` +
      "confirm the app or page in this run."
  );
}
