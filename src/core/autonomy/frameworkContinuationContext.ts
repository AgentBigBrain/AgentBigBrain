/**
 * @fileoverview Enriches model-generated framework continuation prompts with tracked workspace and
 * loopback context so later planner repair stays on the exact app the user already started.
 */

import { extractActiveRequestSegment } from "../currentRequestExtraction";
import type { LoopbackTargetHint } from "./liveRunRecovery";
import type { ApprovedManagedProcessStartContext } from "./loopCleanupPolicy";

const FRAMEWORK_GOAL_PATTERN =
  /\b(?:next\.?js|nextjs|react|vite|landing\s+page|homepage|site|preview|browser)\b/i;
const FRAMEWORK_CONTINUATION_PATTERN =
  /\b(?:restart|start|launch|run|serve|open|reopen|bring\s+(?:back|up)|pull\s+up|preview|browser|localhost|local\s+url|ready)\b/i;
const GENERIC_DESKTOP_PROJECT_PATTERN = /\b(?:project|workspace)\s+on\s+the\s+desktop\b/i;
const RUNTIME_MANAGEMENT_GOAL_PATTERN =
  /\b(?:inspect|check|verify|confirm|make\s+sure|see\s+if|look\s+at|stop|shut\s+down|turn\s+off|kill)\b/i;
const RUNTIME_MANAGEMENT_TARGET_PATTERN =
  /\b(?:server|preview|process|running|listening|localhost|loopback|port)\b/i;

/**
 * Escapes one string for bounded literal regex matching.
 *
 * @param value - Raw text to escape.
 * @returns Regex-safe literal text.
 */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Evaluates whether one model-produced continuation still needs tracked framework context injected.
 *
 * @param overarchingGoal - Mission goal text for the current loop.
 * @param nextUserInput - Model-produced next instruction text.
 * @returns `true` when the continuation is framework-shaped but still generic about workspace/runtime ownership.
 */
function shouldEnrichFrameworkContinuation(
  overarchingGoal: string,
  nextUserInput: string
): boolean {
  const goalRequest = extractActiveRequestSegment(overarchingGoal).trim();
  const continuationRequest = extractActiveRequestSegment(nextUserInput).trim();
  if (
    goalRequest.length === 0 ||
    continuationRequest.length === 0 ||
    !FRAMEWORK_GOAL_PATTERN.test(goalRequest) ||
    !FRAMEWORK_CONTINUATION_PATTERN.test(continuationRequest)
  ) {
    return false;
  }

  return (
    GENERIC_DESKTOP_PROJECT_PATTERN.test(continuationRequest) ||
    /\blocal\s+url\b/i.test(continuationRequest) ||
    /\b(?:browser|preview)\b/i.test(continuationRequest)
  );
}

/**
 * Prefixes a generic model-generated framework continuation with the exact tracked workspace and
 * loopback target so later deterministic fallback cannot drift to a different folder or port.
 *
 * @param overarchingGoal - Mission goal text for the current loop.
 * @param nextUserInput - Model-produced next instruction text.
 * @param trackedManagedProcessStartContext - Last approved managed-process start context, if any.
 * @param trackedLoopbackTarget - Last tracked loopback target, if any.
 * @returns Enriched continuation text, or the original text when no enrichment is needed.
 */
export function enrichFrameworkContinuationNextUserInput(
  overarchingGoal: string,
  nextUserInput: string,
  trackedManagedProcessStartContext: ApprovedManagedProcessStartContext | null,
  trackedLoopbackTarget: LoopbackTargetHint | null
): string {
  const normalizedNextUserInput = nextUserInput.trim();
  if (
    normalizedNextUserInput.length === 0 ||
    !shouldEnrichFrameworkContinuation(overarchingGoal, normalizedNextUserInput)
  ) {
    return normalizedNextUserInput;
  }

  const directives: string[] = [];
  const trackedWorkspaceRoot = trackedManagedProcessStartContext?.cwd?.trim() ?? "";
  if (
    trackedWorkspaceRoot.length > 0 &&
    !new RegExp(escapeRegexLiteral(trackedWorkspaceRoot), "i").test(normalizedNextUserInput)
  ) {
    directives.push(
      `Reuse the existing project at \`${trackedWorkspaceRoot}\`. ` +
        "Do not invent a new Desktop folder name or switch workspaces unless fresh evidence proves the tracked project is wrong."
    );
  }

  const trackedLoopbackUrl = trackedLoopbackTarget?.url?.trim() ?? "";
  if (
    trackedLoopbackUrl.length > 0 &&
    !new RegExp(escapeRegexLiteral(trackedLoopbackUrl), "i").test(normalizedNextUserInput)
  ) {
    directives.push(
      `Reuse the tracked loopback target ${trackedLoopbackUrl} unless a new port conflict or ownership change is proven.`
    );
  }

  if (directives.length === 0) {
    return normalizedNextUserInput;
  }

  return `${directives.join(" ")} ${normalizedNextUserInput}`.trim();
}

/**
 * Prefixes a generic runtime-inspection or shutdown continuation with the tracked workspace and
 * preview target so planner fallback stays on inspect-or-stop behavior instead of drifting back to
 * build or scaffold work.
 *
 * @param overarchingGoal - Mission goal text for the current loop.
 * @param nextUserInput - Model-produced next instruction text.
 * @param trackedManagedProcessStartContext - Last approved managed-process start context, if any.
 * @param trackedLoopbackTarget - Last tracked loopback target, if any.
 * @returns Enriched runtime-management continuation text, or the original text when no enrichment is needed.
 */
export function enrichTrackedRuntimeManagementNextUserInput(
  overarchingGoal: string,
  nextUserInput: string,
  trackedManagedProcessStartContext: ApprovedManagedProcessStartContext | null,
  trackedLoopbackTarget: LoopbackTargetHint | null
): string {
  const normalizedNextUserInput = nextUserInput.trim();
  if (normalizedNextUserInput.length === 0) {
    return normalizedNextUserInput;
  }

  const goalRequest = extractActiveRequestSegment(overarchingGoal).trim();
  const continuationRequest = extractActiveRequestSegment(normalizedNextUserInput).trim();
  if (
    goalRequest.length === 0 ||
    continuationRequest.length === 0 ||
    !RUNTIME_MANAGEMENT_GOAL_PATTERN.test(goalRequest) ||
    !RUNTIME_MANAGEMENT_TARGET_PATTERN.test(goalRequest) ||
    !RUNTIME_MANAGEMENT_GOAL_PATTERN.test(continuationRequest) ||
    !RUNTIME_MANAGEMENT_TARGET_PATTERN.test(continuationRequest)
  ) {
    return normalizedNextUserInput;
  }

  const directives: string[] = [
    "Use inspect_workspace_resources first so this run proves whether the tracked preview, browser, or process stack is still active before any stop or success claim.",
    "Do not create, modify, build, install, scaffold, or rename project files for this turn."
  ];
  const trackedWorkspaceRoot = trackedManagedProcessStartContext?.cwd?.trim() ?? "";
  if (
    trackedWorkspaceRoot.length > 0 &&
    !new RegExp(escapeRegexLiteral(trackedWorkspaceRoot), "i").test(normalizedNextUserInput)
  ) {
    directives.unshift(`Treat \`${trackedWorkspaceRoot}\` as the exact runtime target for this turn.`);
  }
  const trackedLoopbackUrl = trackedLoopbackTarget?.url?.trim() ?? "";
  if (
    trackedLoopbackUrl.length > 0 &&
    !new RegExp(escapeRegexLiteral(trackedLoopbackUrl), "i").test(normalizedNextUserInput)
  ) {
    directives.push(
      `Treat ${trackedLoopbackUrl} as the last tracked preview URL only; do not restart, rebuild, or probe unrelated URLs in this shutdown or inspection pass.`
    );
  }
  return `${directives.join(" ")} ${normalizedNextUserInput}`.trim();
}

/**
 * Applies the bounded continuation enrichments used by the autonomous loop before it hands a new
 * model-produced instruction back to planner execution.
 *
 * @param overarchingGoal - Mission goal text for the current loop.
 * @param nextUserInput - Model-produced next instruction text.
 * @param trackedManagedProcessStartContext - Last approved managed-process start context, if any.
 * @param trackedLoopbackTarget - Last tracked loopback target, if any.
 * @returns Enriched continuation text.
 */
export function enrichAutonomousNextUserInput(
  overarchingGoal: string,
  nextUserInput: string,
  trackedManagedProcessStartContext: ApprovedManagedProcessStartContext | null,
  trackedLoopbackTarget: LoopbackTargetHint | null
): string {
  const frameworkEnriched = enrichFrameworkContinuationNextUserInput(
    overarchingGoal,
    nextUserInput,
    trackedManagedProcessStartContext,
    trackedLoopbackTarget
  );
  return enrichTrackedRuntimeManagementNextUserInput(
    overarchingGoal,
    frameworkEnriched,
    trackedManagedProcessStartContext,
    trackedLoopbackTarget
  );
}
