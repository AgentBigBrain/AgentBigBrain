/**
 * @fileoverview Natural-language rendering helpers for structured clarification state.
 */

import type {
  ActiveClarificationOption,
  ActiveClarificationState,
  ClarificationRenderingIntent
} from "../sessionStore";
import type { IntentClarificationCandidate } from "./intentModeContracts";
import type { RunDirectConversationTurn } from "./managerContracts";

type ClarificationPromptDescriptor =
  Pick<
    ActiveClarificationState,
    "kind" | "matchedRuleId" | "question" | "options" | "renderingIntent"
  > & {
    sourceInput: string;
  };

const MAX_CLARIFICATION_QUESTION_LENGTH = 180;

/**
 * Normalizes clarification question.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param question - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function normalizeClarificationQuestion(question: string | null | undefined): string | null {
  const normalized = (question ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Tokenizes clarification question.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param question - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function tokenizeClarificationQuestion(question: string): readonly string[] {
  return (question.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/**
 * Evaluates whether required option coverage.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ClarificationRenderingIntent` (import `ClarificationRenderingIntent`) from `../sessionStore`.
 * @param tokens - Input consumed by this helper.
 * @param renderingIntent - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function matchesRequiredOptionCoverage(
  tokens: readonly string[],
  renderingIntent: ClarificationRenderingIntent
): boolean {
  const hasAny = (...candidates: readonly string[]) => candidates.some((candidate) => tokens.includes(candidate));
  switch (renderingIntent) {
    case "build_format":
      return hasAny("html", "static") && hasAny("framework", "next", "nextjs", "react");
    case "plan_or_build":
      return hasAny("plan") && hasAny("build", "building");
    case "fix_or_explain":
      return hasAny("explain", "explaining") && hasAny("fix", "fixing", "repair", "correct");
    case "task_recovery":
      return hasAny("retry", "continue", "leave", "cancel", "stop", "shut");
    default:
      return false;
  }
}

/**
 * Evaluates whether usable clarification question.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ClarificationRenderingIntent` (import `ClarificationRenderingIntent`) from `../sessionStore`.
 * @param question - Input consumed by this helper.
 * @param renderingIntent - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function isUsableClarificationQuestion(
  question: string | null,
  renderingIntent: ClarificationRenderingIntent
): question is string {
  if (!question || question.length > MAX_CLARIFICATION_QUESTION_LENGTH || !question.includes("?")) {
    return false;
  }
  return matchesRequiredOptionCoverage(
    tokenizeClarificationQuestion(question),
    renderingIntent
  );
}

/**
 * Builds clarification rendering goal.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ClarificationRenderingIntent` (import `ClarificationRenderingIntent`) from `../sessionStore`.
 * @param renderingIntent - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function buildClarificationRenderingGoal(
  renderingIntent: ClarificationRenderingIntent
): string {
  switch (renderingIntent) {
    case "build_format":
      return "Find out whether the user wants plain HTML or a framework app.";
    case "plan_or_build":
      return "Find out whether the user wants planning first or immediate building.";
    case "fix_or_explain":
      return "Find out whether the user wants an explanation first or an immediate fix.";
    case "task_recovery":
      return "Find out whether the user wants the safe recovery step to continue.";
    default:
      return "Ask the required clarification question.";
  }
}

/**
 * Builds clarification option summary.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ActiveClarificationOption` (import `ActiveClarificationOption`) from `../sessionStore`.
 * @param options - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function buildClarificationOptionSummary(
  options: readonly ActiveClarificationOption[]
): string {
  return options.map((option) => `${option.label} (${option.id})`).join("; ");
}

/**
 * Builds clarification prompt.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param clarification - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function buildClarificationPrompt(
  clarification: ClarificationPromptDescriptor
): string {
  return [
    "Ask one short natural clarification question for this request.",
    buildClarificationRenderingGoal(clarification.renderingIntent),
    "Do not decide for the user.",
    "Do not explain policy or implementation details.",
    "Mention only valid options from the provided list.",
    "Return only the question.",
    "",
    `Clarification kind: ${clarification.kind}`,
    `Matched rule: ${clarification.matchedRuleId}`,
    `Valid options: ${buildClarificationOptionSummary(clarification.options)}`,
    `Fallback question: ${clarification.question}`,
    "",
    "Original request:",
    clarification.sourceInput
  ].join("\n");
}

/**
 * Renders one clarification question naturally while keeping the clarification state itself
 * structured and deterministic.
 */
export async function renderClarificationQuestionText(
  clarification: ClarificationPromptDescriptor,
  receivedAt: string,
  runDirectConversationTurn?: RunDirectConversationTurn
): Promise<string> {
  if (typeof runDirectConversationTurn !== "function") {
    return clarification.question;
  }
  const rendered = await runDirectConversationTurn(
    buildClarificationPrompt(clarification),
    receivedAt
  );
  const question = normalizeClarificationQuestion(rendered.summary);
  return isUsableClarificationQuestion(question, clarification.renderingIntent)
    ? question
    : clarification.question;
}

/**
 * Converts to clarification prompt descriptor.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ActiveClarificationState` (import `ActiveClarificationState`) from `../sessionStore`.
 * - Uses `IntentClarificationCandidate` (import `IntentClarificationCandidate`) from `./intentModeContracts`.
 * @param sourceInput - Input consumed by this helper.
 * @param clarification - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function toClarificationPromptDescriptor(
  sourceInput: string,
  clarification: IntentClarificationCandidate | ActiveClarificationState
): ClarificationPromptDescriptor {
  return {
    kind: clarification.kind,
    matchedRuleId: clarification.matchedRuleId,
    question: clarification.question,
    options: clarification.options,
    renderingIntent: clarification.renderingIntent,
    sourceInput
  };
}
