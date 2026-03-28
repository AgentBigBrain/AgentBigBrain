/**
 * @fileoverview Human-first autonomous loop progress-state rendering helpers.
 */

import type { WorkspaceRecoverySignal } from "./workspaceRecoveryPolicy";
import {
  MISSION_REQUIREMENT_PROCESS_STOP,
  MISSION_REQUIREMENT_SIDE_EFFECT,
  type RecoveryFailureClass
} from "./contracts";

type AutonomousWorkingKind =
  | "build_preview"
  | "edit_preview"
  | "organize_folders"
  | "close_preview"
  | "explain_saved_work"
  | "inspect_blocker"
  | "generic";

/**
 * Normalizes one autonomous subtask input into bounded lowercase text.
 *
 * @param input - Raw autonomous subtask input.
 * @returns Normalized comparison text.
 */
function normalizeAutonomousWorkingInput(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Returns whether the normalized autonomous input contains any bounded phrase.
 *
 * @param text - Normalized autonomous input.
 * @param phrases - Candidate phrases.
 * @returns `true` when any phrase matches.
 */
function containsAny(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

/**
 * Maps an autonomous subtask input onto one bounded user-facing progress family.
 *
 * This helper is intentionally descriptive only. It must not participate in routing,
 * authorization, or recovery decisions.
 *
 * @param input - Raw autonomous subtask input.
 * @returns Typed working-message family for progress rendering.
 */
function detectAutonomousWorkingKind(input: string): AutonomousWorkingKind {
  const text = normalizeAutonomousWorkingInput(input);

  if (
    (containsAny(text, [
      "what changed",
      "tell me about",
      "explain what",
      "summarize",
      "summary of",
      "rough draft",
      "ready to review",
      "review first"
    ]) &&
      containsAny(text, [
        "change",
        "draft",
        "review",
        "work",
        "ready",
        "finished"
      ])) ||
    (text.includes("while i was away") && containsAny(text, ["what", "changed", "done"]))
  ) {
    return "explain_saved_work";
  }

  if (
    containsAny(text, [
      "close the",
      "close that",
      "shut down",
      "stop the",
      "close it"
    ]) &&
    containsAny(text, [
      "browser",
      "preview",
      "landing page",
      "page",
      "window",
      "server"
    ])
  ) {
    return "close_preview";
  }

  if (
    containsAny(text, [
      "organize",
      "move every folder",
      "move all the",
      "put every folder",
      "put all the",
      "should go in"
    ]) &&
    containsAny(text, [
      "folder",
      "folders",
      "desktop",
      "drone-folder",
      "drone-web-projects",
      "drone-company"
    ])
  ) {
    return "organize_folders";
  }

  if (
    containsAny(text, [
      "slider",
      "carousel",
      "edit the",
      "update the",
      "change the",
      "turn the hero"
    ]) &&
    containsAny(text, [
      "hero",
      "section",
      "page",
      "landing page",
      "site",
      "homepage",
      "preview"
    ])
  ) {
    return "edit_preview";
  }

  if (
    containsAny(text, [
      "build a",
      "create a",
      "make a",
      "design a",
      "generate a"
    ]) &&
    containsAny(text, [
      "page",
      "landing page",
      "site",
      "website",
      "homepage"
    ])
  ) {
    return "build_preview";
  }

  if (
    containsAny(text, [
      "inspect",
      "check",
      "verify",
      "figure out",
      "look into"
    ]) &&
    containsAny(text, [
      "blocker",
      "preview",
      "browser",
      "workspace",
      "holder",
      "safe"
    ])
  ) {
    return "inspect_blocker";
  }

  return "generic";
}

/**
 * Builds a calmer retry/continuation message for an already-running autonomous loop.
 *
 * This helper stays deterministic and descriptive. It does not authorize actions or alter loop
 * policy; it only translates low-signal model reasoning into steadier user-facing progress text.
 *
 * @param reasoning - Next-step reasoning returned by the loop policy.
 * @param currentInput - Current autonomous subtask input.
 * @returns Human-first retry or continuation progress text.
 */
export function buildRetryingStateMessage(
  reasoning: string,
  currentInput: string
): string {
  const normalizedReasoning = normalizeAutonomousWorkingInput(reasoning);
  if (
    containsAny(normalizedReasoning, [
      "verify",
      "verification",
      "check the result",
      "confirm the result",
      "summarize what was built",
      "browser proof",
      "readiness proof"
    ])
  ) {
    return "I'm moving into the next verification step now so I can confirm the result cleanly.";
  }

  switch (detectAutonomousWorkingKind(currentInput)) {
    case "build_preview":
      return "I'm moving into the next build step now and keeping the preview aligned.";
    case "edit_preview":
      return "I'm continuing the page update now and checking the preview as I go.";
    case "organize_folders":
      return "I'm continuing the folder move now and checking what changed after each step.";
    case "close_preview":
      return "I'm finishing the close-down steps now and checking that nothing is left open.";
    case "explain_saved_work":
      return "I'm pulling together the next review detail now so the summary stays clear.";
    case "inspect_blocker":
      return "I'm narrowing the blocker now so I can choose the next safe move.";
    case "generic":
    default:
      return "I'm moving into the next step now and keeping the run on track.";
  }
}

/**
 * Builds a human-first retry message for one bounded structured recovery attempt.
 *
 * @param recoveryClass - Typed recovery class the loop is handling.
 * @returns Human-readable structured-recovery progress text.
 */
export function buildStructuredRecoveryStateMessage(
  recoveryClass: RecoveryFailureClass
): string {
  switch (recoveryClass) {
    case "DEPENDENCY_MISSING":
      return "I found a missing dependency. I'm doing one bounded repair and then retrying the original step.";
    case "VERSION_INCOMPATIBLE":
      return "I found a dependency version mismatch. I'm doing one bounded alignment pass before retrying the original step.";
    case "PROCESS_PORT_IN_USE":
      return "The requested localhost port was occupied. I'm retrying once on a free loopback port.";
    case "PROCESS_NOT_READY":
      return "The local target started but isn't ready yet. I'm checking the tracked target and retrying readiness once.";
    case "TARGET_NOT_RUNNING":
      return "The tracked local target stopped before proof completed. I'm doing one restart-and-reverify pass.";
    default:
      return "I found a bounded recoverable runtime issue. I'm trying one safe repair before I continue.";
  }
}

/**
 * Builds a concise human-first progress line for the current autonomous step.
 *
 * @param iteration - Current loop iteration number.
 * @param input - Current subtask input being executed.
 * @returns Human-readable step progress text.
 */
export function buildWorkingStateMessage(iteration: number, input: string): string {
  const stepLabel = `(step ${iteration})`;
  switch (detectAutonomousWorkingKind(input)) {
    case "build_preview":
      return `I'm building the page and setting up the preview now ${stepLabel}.`;
    case "edit_preview":
      return `I'm updating the current page and keeping the preview in sync now ${stepLabel}.`;
    case "organize_folders":
      return `I'm organizing the project folders and checking what can move safely now ${stepLabel}.`;
    case "close_preview":
      return `I'm closing the tracked preview and making sure nothing is left open now ${stepLabel}.`;
    case "explain_saved_work":
      return `I'm reviewing the saved work now so I can explain the changes clearly ${stepLabel}.`;
    case "inspect_blocker":
      return `I'm inspecting the current blocker now so I can choose the next safe move ${stepLabel}.`;
    case "generic":
    default:
      return `I'm working through the next step now ${stepLabel}.`;
  }
}

/**
 * Builds a human-first verification status line from missing mission requirements.
 *
 * @param missingRequirements - Remaining deterministic mission requirements.
 * @returns Human-readable verification progress text.
 */
export function buildVerificationStateMessage(
  missingRequirements: readonly string[]
): string {
  const normalizedRequirements = missingRequirements.map((entry) => entry.trim().toUpperCase());
  if (normalizedRequirements.includes(MISSION_REQUIREMENT_PROCESS_STOP)) {
    return "I'm finishing the cleanup proof now so I can confirm the preview stack was actually shut down.";
  }
  if (normalizedRequirements.includes("BROWSER_PROOF")) {
    return "I'm verifying the browser result now so I can confirm the page really matches the goal.";
  }
  if (normalizedRequirements.includes("READINESS_PROOF")) {
    return "I'm checking the local preview is actually up before I call this done.";
  }
  if (normalizedRequirements.includes(MISSION_REQUIREMENT_SIDE_EFFECT)) {
    return "I'm still looking for concrete side effects before I can truthfully call this finished.";
  }
  return "I'm verifying the remaining proof before I mark this goal complete.";
}

/**
 * Builds a human-first recovery status line from bounded workspace-lock recovery evidence.
 *
 * @param signal - Structured workspace-recovery signal.
 * @returns Human-readable recovery progress text.
 */
export function buildWorkspaceRecoveryStateMessage(
  signal: WorkspaceRecoverySignal
): string {
  if (signal.recommendedAction === "clarify_before_exact_non_preview_shutdown") {
    return "I found one likely exact local blocker, but I need your confirmation before I stop that specific process.";
  }
  if (signal.recommendedAction === "clarify_before_untracked_shutdown") {
    return "I found possible blockers, but I need your confirmation before I touch anything that is not exactly tracked.";
  }
  if (signal.recommendedAction === "stop_exact_tracked_holders") {
    return "I found the exact tracked holders causing the blocker, and I'm retrying with only that narrow shutdown path.";
  }
  if (signal.recommendedAction === "retry_after_inspection") {
    return "I inspected the blocker and did not prove a live exact holder, so I'm retrying the move once in case the lock already cleared.";
  }
  if (signal.recommendedAction === "stop_no_live_holders_found") {
    return "I found stale or incomplete holder evidence, so I'm stopping short of guessing and keeping the blocker explicit.";
  }
  return "I hit a blocker and I'm retrying with a narrower recovery step.";
}
