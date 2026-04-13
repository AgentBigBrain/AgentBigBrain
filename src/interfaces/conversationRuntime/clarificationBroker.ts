/**
 * @fileoverview Owns persisted clarification-state creation and answer resolution for the canonical conversation front door.
 */

import type {
  ActiveClarificationOption,
  ActiveClarificationState,
  ClarificationOptionId
} from "../sessionStore";
import type {
  IntentClarificationCandidate
} from "./intentModeContracts";

export interface ClarificationResolutionResult {
  selectedOptionId: ClarificationOptionId;
}

const EXECUTION_MODE_CLARIFICATION_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const TASK_RECOVERY_CLARIFICATION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const CLARIFICATION_OPTION_PATTERNS: Readonly<Record<ClarificationOptionId, readonly RegExp[]>> = {
  plan: [
    /\bplan\b/i,
    /\bplan it\b/i,
    /\boutline\b/i,
    /\bwalk me through\b/i,
    /\bproposal\b/i
  ],
  build: [
    /\bbuild\b/i,
    /\bbuild it\b/i,
    /\bcreate\b/i,
    /\bmake it\b/i,
    /\bimplement\b/i
  ],
  explain: [
    /\bexplain\b/i,
    /\bexplain it\b/i,
    /\btalk me through\b/i,
    /\bwalk me through\b/i,
    /\bshow me why\b/i
  ],
  fix_now: [
    /\bfix\b/i,
    /\bfix it\b/i,
    /\bdo it now\b/i,
    /\bjust do it\b/i,
    /\brepair\b/i,
    /\brun it now\b/i,
    /\bexecute\b/i
  ],
  skills: [
    /\bskills?\b/i,
    /\btools?\b/i,
    /\blist\b/i,
    /\bshow\b/i,
    /\bwhat do you know\b/i
  ],
  continue_recovery: [
    /^\s*(?:yes|yeah|yep|sure|okay|ok)\b/i,
    /\bgo ahead\b/i,
    /\bplease do\b/i,
    /\bcontinue\b/i,
    /\binspect\b/i,
    /\blook (?:into|closer)\b/i,
    /\brecover\b/i,
    /\btry again\b/i
  ],
  retry_with_shutdown: [
    /^\s*(?:yes|yeah|yep|sure|okay|ok)\b/i,
    /\bgo ahead\b/i,
    /\bplease do\b/i,
    /\bretry\b/i,
    /\bshut (?:them|those|it) down\b/i,
    /\bclose (?:them|those|it)\b/i,
    /\bfix it\b/i,
    /\bdo that\b/i
  ],
  cancel: [
    /^\s*(?:no|nope|nah)\b/i,
    /\bcancel\b/i,
    /\bnever mind\b/i,
    /\bleave (?:them|those|it) (?:alone|where (?:they|it) (?:are|is))\b/i,
    /\bdon't\b/i,
    /\bdo not\b/i,
    /\bstop\b/i
  ]
} as const;

/**
 * Converts one canonical clarification candidate into persisted session state.
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
 * @param clarification - Active clarification state persisted on the session.
 * @param userInput - User reply text attempting to answer the clarification.
 * @returns Selected option when resolution is deterministic; otherwise `null`.
 */
export function resolveClarificationAnswer(
  clarification: ActiveClarificationState,
  userInput: string
): ClarificationResolutionResult | null {
  const normalized = userInput.trim();
  if (!normalized) {
    return null;
  }

  const matchedOptionIds = clarification.options
    .map((option) => option.id)
    .filter((optionId) =>
      (CLARIFICATION_OPTION_PATTERNS[optionId] ?? []).some((pattern) => pattern.test(normalized))
    );

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
    : TASK_RECOVERY_CLARIFICATION_MAX_AGE_MS;
  return clarificationAgeMs > maxAgeMs;
}

/**
 * Builds the clarified execution input that preserves the original request while making the user's
 * selected mode explicit to the downstream planner.
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
  if (
    clarification.kind === "task_recovery" &&
    (
      selectedOptionId === "retry_with_shutdown" ||
      selectedOptionId === "continue_recovery"
    )
  ) {
    lines.push(
      clarification.recoveryInstruction ??
        "Recovery instruction: inspect the relevant workspace resources or path holders first. If exact tracked preview holders are found, stop only those exact tracked holders, confirm they stopped, then retry the original folder-organization request. If the inspection finds only likely untracked holders, explain plainly that user confirmation is required before shutting them down."
    );
  }
  return lines.join("\n");
}
