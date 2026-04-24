/**
 * @fileoverview Owns persisted clarification-state creation and answer resolution for the canonical conversation front door.
 */

import type {
  ActiveClarificationOption,
  ActiveClarificationState,
  ClarificationOptionId,
  ConversationIntentMode
} from "../sessionStore";
import type { IntentClarificationCandidate } from "./intentModeContracts";
import {
  isDeterministicFrameworkBuildLaneRequest,
  isStaticHtmlExecutionStyleRequest
} from "../../organs/plannerPolicy/liveVerificationPolicy";
import {
  matchesClarificationOption,
  tokenizeClarificationReply
} from "./clarificationOptionMatching";

const EXECUTION_MODE_CLARIFICATION_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const BUILD_FORMAT_CLARIFICATION_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const TASK_RECOVERY_CLARIFICATION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface ClarificationResolutionResult {
  selectedOptionId: ClarificationOptionId;
}

/**
 * Resolves the canonical post-clarification intent mode so the user's answer controls the route,
 * not a hidden generic build fallback.
 */
export function resolveClarifiedIntentMode(
  sourceInput: string,
  clarification: ActiveClarificationState,
  selectedOptionId: ClarificationOptionId
): ConversationIntentMode {
  if (clarification.kind === "build_format") {
    switch (selectedOptionId) {
      case "static_html":
        return "static_html_build";
      case "nextjs":
      case "react":
        return "framework_app_build";
      default:
        return "build";
    }
  }

  if (clarification.kind === "execution_mode") {
    if (selectedOptionId === "plan") {
      return "plan";
    }
    if (selectedOptionId === "build") {
      if (isStaticHtmlExecutionStyleRequest(sourceInput)) {
        return "static_html_build";
      }
      if (isDeterministicFrameworkBuildLaneRequest(sourceInput)) {
        return "framework_app_build";
      }
      return "build";
    }
  }

  return "build";
}

/**
 * Converts one canonical clarification candidate into persisted session state.
 *
 * **Why it exists:**
 * Clarification state needs one stable persistence shape so later answer resolution and queue input
 * rebuilding stay deterministic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param sourceInput - Original user input that triggered clarification.
 * @param requestedAt - Timestamp of the clarification turn.
 * @param candidate - Canonical clarification candidate.
 * @returns Persistable clarification state.
 */
export function createActiveClarificationState(
  sourceInput: string,
  requestedAt: string,
  candidate: IntentClarificationCandidate
): ActiveClarificationState {
  return {
    id: `clarification_${requestedAt}`,
    kind: candidate.kind,
    sourceInput,
    question: candidate.question,
    requestedAt,
    matchedRuleId: candidate.matchedRuleId,
    renderingIntent: candidate.renderingIntent,
    options: candidate.options.map((option): ActiveClarificationOption => ({
      id: option.id,
      label: option.label
    }))
  };
}

/**
 * Creates one persisted task-recovery clarification state for blocked follow-up flows that can
 * safely continue after a short user confirmation.
 *
 * **Why it exists:**
 * Recovery clarifications need a stable persisted shape so the next turn can resume safely without
 * rebuilding hidden runtime state from prose alone.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param sourceInput - Original user request that hit a recoverable blocker.
 * @param requestedAt - Timestamp of the recovery clarification turn.
 * @param question - Human-facing recovery question shown to the user.
 * @param matchedRuleId - Stable rule id describing the recovery reason.
 * @returns Persistable clarification state for the next turn.
 */
export function createTaskRecoveryClarificationState(
  sourceInput: string,
  requestedAt: string,
  question: string,
  matchedRuleId: string,
  recoveryInstruction?: string | null,
  options?: readonly ActiveClarificationOption[]
): ActiveClarificationState {
  return {
    id: `clarification_${requestedAt}`,
    kind: "task_recovery",
    sourceInput,
    question,
    requestedAt,
    matchedRuleId,
    renderingIntent: "task_recovery",
    recoveryInstruction: recoveryInstruction ?? null,
    options:
      options ?? [
        {
          id: "retry_with_shutdown",
          label: "Yes, shut them down and retry"
        },
        {
          id: "cancel",
          label: "No, leave them alone"
        }
      ]
  };
}

/**
 * Resolves one user answer against the currently active clarification state.
 *
 * **Why it exists:**
 * Clarification answers are safety-relevant because they can unlock execution. Resolution must stay
 * deterministic, explicit, and fail closed on generic or overlapping wording.
 *
 * **What it talks to:**
 * - Uses `tokenizeClarificationReply` and `matchesClarificationOption` from `./clarificationOptionMatching`.
 *
 * @param clarification - Active clarification state persisted on the session.
 * @param userInput - User reply text attempting to answer the clarification.
 * @returns Selected option when resolution is deterministic; otherwise `null`.
 */
export function resolveClarificationAnswer(
  clarification: ActiveClarificationState,
  userInput: string
): ClarificationResolutionResult | null {
  const { normalized, tokens } = tokenizeClarificationReply(userInput);
  if (!normalized) {
    return null;
  }

  const matchedOptionIds = clarification.options
    .map((option) => option.id)
    .filter((optionId) => matchesClarificationOption(optionId, tokens));

  if (matchedOptionIds.length !== 1) {
    return null;
  }

  return {
    selectedOptionId: matchedOptionIds[0]
  };
}

/**
 * Returns whether one persisted clarification is old enough that the next unrelated user turn
 * should not stay trapped behind it anymore.
 *
 * **Why it exists:**
 * Clarifications are temporary routing state. They should not survive forever and hijack unrelated
 * future conversation turns.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param clarification - Active clarification stored on the session.
 * @param receivedAt - Timestamp of the new user turn.
 * @returns Whether the clarification should be treated as stale.
 */
export function isClarificationExpired(
  clarification: ActiveClarificationState,
  receivedAt: string
): boolean {
  const clarificationRequestedAt = Date.parse(clarification.requestedAt);
  const nextTurnAt = Date.parse(receivedAt);
  if (!Number.isFinite(clarificationRequestedAt) || !Number.isFinite(nextTurnAt)) {
    return false;
  }

  const clarificationAgeMs = nextTurnAt - clarificationRequestedAt;
  if (clarificationAgeMs <= 0) {
    return false;
  }

  const maxAgeMs = clarification.kind === "execution_mode"
    ? EXECUTION_MODE_CLARIFICATION_MAX_AGE_MS
    : clarification.kind === "build_format"
      ? BUILD_FORMAT_CLARIFICATION_MAX_AGE_MS
      : TASK_RECOVERY_CLARIFICATION_MAX_AGE_MS;
  return clarificationAgeMs > maxAgeMs;
}

/**
 * Builds the clarified execution input that preserves the original request while making the user's
 * selected mode explicit to the downstream planner.
 *
 * **Why it exists:**
 * Clarification answers should affect execution through explicit queue input rather than hidden
 * side channels, so downstream planning can stay auditable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param sourceInput - Original user request that triggered clarification.
 * @param clarification - Active clarification state being resolved.
 * @param selectedOptionId - Canonical option chosen by the user.
 * @returns Clarified execution input for queue insertion.
 */
export function buildClarifiedExecutionInput(
  sourceInput: string,
  clarification: ActiveClarificationState,
  selectedOptionId: ClarificationOptionId
): string {
  const selectedLabel =
    clarification.options.find((option) => option.id === selectedOptionId)?.label
    ?? selectedOptionId;
  const lines = [
    sourceInput,
    "",
    `[Clarification resolved: ${clarification.question}]`,
    `User selected: ${selectedLabel}.`
  ];
  const clarifiedIntentMode = resolveClarifiedIntentMode(
    sourceInput,
    clarification,
    selectedOptionId
  );
  if (
    clarification.kind === "execution_mode" &&
    clarifiedIntentMode !== "plan" &&
    clarifiedIntentMode !== "build"
  ) {
    lines.push(`Execution lane: ${clarifiedIntentMode}.`);
  }
  if (
    clarification.kind === "task_recovery"
    && (selectedOptionId === "retry_with_shutdown"
      || selectedOptionId === "continue_recovery")
  ) {
    lines.push(
      clarification.recoveryInstruction
        ?? "Recovery instruction: inspect the relevant workspace resources or path holders first. If exact tracked preview holders are found, stop only those exact tracked holders, confirm they stopped, then retry the original folder-organization request. If the inspection finds only likely untracked holders, explain plainly that user confirmation is required before shutting them down."
    );
  }
  if (clarification.kind === "build_format") {
    switch (selectedOptionId) {
      case "static_html":
        lines.push(
          "Build format resolved: create a plain static HTML deliverable.",
          "Execution lane: static_html_build.",
          "Do not scaffold a framework app, package manager project, or preview server unless the user later asks for that explicitly."
        );
        break;
      case "nextjs":
        lines.push(
          "Build format resolved: create a framework app using Next.js.",
          "Execution lane: framework_app_build.",
          "Preferred framework: nextjs."
        );
        break;
      case "react":
        lines.push(
          "Build format resolved: create a framework app using React.",
          "Execution lane: framework_app_build.",
          "Preferred framework: react."
        );
        break;
      default:
        break;
    }
  }
  return lines.join("\n");
}
