/**
 * @fileoverview Shared helper utilities for ConversationManager command parsing, turn formatting, and pulse status rendering.
 */

import {
  ConversationJob,
  ConversationSession,
  ConversationTurn,
  ConversationVisibility,
  PendingProposal
} from "./sessionStore";
import { createEmptyConversationDomainContext } from "../core/sessionContext";
import { normalizeConversationTransportIdentity } from "./conversationRuntime/transportIdentity";
import {
  classifyPulseLexicalCommand,
  createPulseLexicalRuleContext,
  PulseControlMode,
  PulseLexicalClassification,
  PulseLexicalRuleContext
} from "../organs/pulseLexicalClassifier";
import { createEmptyConversationStackV1 } from "../core/stage6_86ConversationStack";
import { stripLabelStyleOpening } from "./userFacing/languageSurface";
export {
  FollowUpRulepackV1,
  type FollowUpClassification,
  type FollowUpRuleContext,
  type ProposalReplyClassification,
  classifyFollowUp,
  classifyProposalReply,
  classifyShortUtterance,
  createFollowUpRuleContext
} from "./followUpClassifier";
export {
  PulseLexicalRulepackV1,
  type PulseControlMode,
  type PulseLexicalCategory,
  type PulseLexicalClassification,
  type PulseLexicalConfidenceTier,
  type PulseLexicalOverrideV1,
  type PulseLexicalRuleContext,
  classifyPulseLexicalCommand,
  createPulseLexicalRuleContext
} from "../organs/pulseLexicalClassifier";

export const MAX_STORED_TURN_CHARS = 600;
const DEFAULT_PULSE_LEXICAL_RULE_CONTEXT = createPulseLexicalRuleContext(null);
const ASSISTANT_CLARIFICATION_PROMPT_PATTERNS: readonly RegExp[] = [
  /\bplease\s+confirm\b/i,
  /\bwould\s+you\s+like\s+to\s+proceed\b/i,
  /\bhow\s+would\s+you\s+like\b/i,
  /\bcould\s+you\s+please\b/i,
  /\bcan\s+you\s+please\b/i,
  /\bplease\s+specify\b/i,
  /\bis\s+that\s+correct\b/i
] as const;

export interface ConversationKeySeedInput {
  provider: "telegram" | "discord";
  conversationId: string;
  userId: string;
  username: string;
  transportIdentity?: ConversationSession["transportIdentity"];
  conversationVisibility: ConversationVisibility;
  receivedAt: string;
}

/**
 * Collapses repeated whitespace so command and classifier parsing sees one canonical text shape.
 *
 * **Why it exists:**
 * Centralizes normalization rules for whitespace so call sites stay aligned.
 *
 * **What it talks to:**
 * - Local regex normalization only.
 *
 * @param value - Primary input consumed by this function.
 * @returns Input text with collapsed whitespace and trimmed edges.
 */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Evaluates likely assistant clarification prompt and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the likely assistant clarification prompt policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `normalizeWhitespace` and local clarification prompt patterns.
 *
 * @param value - Primary input consumed by this function.
 * @returns `true` when this check/policy condition passes.
 */
export function isLikelyAssistantClarificationPrompt(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return false;
  }
  if (normalized.includes("?")) {
    return true;
  }
  return ASSISTANT_CLARIFICATION_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Removes the leading slash from command text when present.
 *
 * **Why it exists:**
 * Command parsing should treat `/status` and `status` the same way.
 *
 * **What it talks to:**
 * - Local string trimming only.
 *
 * @param value - Raw command text from a conversation turn.
 * @returns Command text without a leading slash prefix.
 */
export function withNormalizedCommandPrefix(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

/**
 * Splits command into normalized segments for downstream parsing.
 *
 * **Why it exists:**
 * Maintains one token/segment boundary policy for command so lexical decisions stay stable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `{ command: string; argument: string }` result.
 */
export function splitCommand(value: string): { command: string; argument: string } {
  const normalized = withNormalizedCommandPrefix(value);
  const firstSpace = normalized.indexOf(" ");
  if (firstSpace < 0) {
    return {
      command: normalized.toLowerCase(),
      argument: ""
    };
  }

  return {
    command: normalized.slice(0, firstSpace).toLowerCase(),
    argument: normalized.slice(firstSpace + 1).trim()
  };
}

/**
 * Creates the stable session key used to identify one user inside one provider conversation.
 *
 * **Why it exists:**
 * Keeps construction of conversation key consistent across call sites.
 *
 * **What it talks to:**
 * - Local key formatting only.
 *
 * @param message - Provider/conversation/user seed used for session identity.
 * @returns Stable conversation key: `${provider}:${conversationId}:${userId}`.
 */
export function buildConversationKey(message: ConversationKeySeedInput): string {
  return `${message.provider}:${message.conversationId}:${message.userId}`;
}

/**
 * Creates a new default conversation session record when no prior session exists.
 *
 * **Why it exists:**
 * Keeps construction of session seed consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `createEmptyConversationStackV1` (import `createEmptyConversationStackV1`) from `../core/stage6_86ConversationStack`.
 * - Uses `ConversationSession` (import `ConversationSession`) from `./sessionStore`.
 *
 * @param message - Message/text content processed by this function.
 * @returns Computed `ConversationSession` result.
 */
export function buildSessionSeed(message: ConversationKeySeedInput): ConversationSession {
  return {
    conversationId: buildConversationKey(message),
    userId: message.userId,
    username: message.username,
    transportIdentity: normalizeConversationTransportIdentity(message.transportIdentity),
    conversationVisibility: message.conversationVisibility,
    sessionSchemaVersion: "v2",
    conversationStack: createEmptyConversationStackV1(message.receivedAt),
    updatedAt: message.receivedAt,
    modelBackendOverride: null,
    codexAuthProfileId: null,
    activeProposal: null,
    activeClarification: null,
    domainContext: createEmptyConversationDomainContext(buildConversationKey(message)),
    modeContinuity: null,
    progressState: null,
    returnHandoff: null,
    runningJobId: null,
    queuedJobs: [],
    recentJobs: [],
    recentActions: [],
    browserSessions: [],
    pathDestinations: [],
    activeWorkspace: null,
    conversationTurns: [],
    classifierEvents: [],
    agentPulse: {
      optIn: false,
      mode: "private",
      routeStrategy: "last_private_used",
      lastPulseSentAt: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      lastDecisionCode: "NOT_EVALUATED",
      lastEvaluatedAt: null,
      lastContextualLexicalEvidence: null
    }
  };
}

/**
 * Resolves natural pulse command classification from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of natural pulse command classification by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `classifyPulseLexicalCommand` (import `classifyPulseLexicalCommand`) from `../organs/pulseLexicalClassifier`.
 * - Uses `PulseLexicalClassification` (import `PulseLexicalClassification`) from `../organs/pulseLexicalClassifier`.
 * - Uses `PulseLexicalRuleContext` (import `PulseLexicalRuleContext`) from `../organs/pulseLexicalClassifier`.
 *
 * @param value - Primary value processed by this function.
 * @param ruleContext - Message/text content processed by this function.
 * @returns Computed `PulseLexicalClassification` result.
 */
export function resolveNaturalPulseCommandClassification(
  value: string,
  ruleContext: PulseLexicalRuleContext = DEFAULT_PULSE_LEXICAL_RULE_CONTEXT
): PulseLexicalClassification {
  return classifyPulseLexicalCommand(value, ruleContext);
}

/**
 * Resolves natural pulse command argument from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of natural pulse command argument by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `PulseControlMode` (import `PulseControlMode`) from `../organs/pulseLexicalClassifier`.
 * - Uses `PulseLexicalRuleContext` (import `PulseLexicalRuleContext`) from `../organs/pulseLexicalClassifier`.
 *
 * @param value - Primary value processed by this function.
 * @param ruleContext - Message/text content processed by this function.
 * @returns Computed `PulseControlMode | null` result.
 */
export function resolveNaturalPulseCommandArgument(
  value: string,
  ruleContext: PulseLexicalRuleContext = DEFAULT_PULSE_LEXICAL_RULE_CONTEXT
): PulseControlMode | null {
  const classification = resolveNaturalPulseCommandClassification(value, ruleContext);
  if (
    classification.category !== "COMMAND" ||
    classification.conflict ||
    !classification.commandIntent
  ) {
    return null;
  }
  return classification.commandIntent;
}

/**
 * Produces a bounded one-line preview of the active proposal text.
 *
 * **Why it exists:**
 * Defines public behavior from `conversationManagerHelpers.ts` for other modules/tests.
 *
 * **What it talks to:**
 * - Uses `PendingProposal` (import `PendingProposal`) from `./sessionStore`.
 *
 * @param proposal - Value for proposal.
 * @returns Resulting string value.
 */
export function proposalPreview(proposal: PendingProposal): string {
  const normalized = normalizeWhitespace(proposal.currentInput);
  if (normalized.length <= 280) {
    return normalized;
  }
  return `${normalized.slice(0, 277)}...`;
}

/**
 * Builds an analysis-only prompt for questions asked while a proposal draft is pending.
 *
 * **Why it exists:**
 * Keeps construction of proposal question prompt consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `PendingProposal` (import `PendingProposal`) from `./sessionStore`.
 *
 * @param proposal - Pending proposal context shown to the model.
 * @param question - User's question about the pending proposal.
 * @returns Prompt text for analysis-only follow-up responses.
 */
export function buildProposalQuestionPrompt(proposal: PendingProposal, question: string): string {
  return [
    "You are helping the user review a pending automation proposal before approval.",
    "Answer clearly and concisely.",
    "Do not perform external actions. Provide analysis only.",
    "",
    `Pending proposal (${proposal.id}):`,
    proposal.currentInput,
    "",
    "User question:",
    question
  ].join("\n");
}

/**
 * Computes elapsed whole seconds from an ISO timestamp to now.
 *
 * **Why it exists:**
 * Ack/final-delivery timers need a single elapsed-time calculation path.
 *
 * **What it talks to:**
 * - Local `Date.parse` / `Date.now` math only.
 *
 * @param fromIso - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Numeric result used by downstream logic.
 */
export function elapsedSeconds(fromIso: string): number {
  const startMs = Date.parse(fromIso);
  if (!Number.isFinite(startMs)) {
    return 0;
  }
  return Math.max(0, Math.floor((Date.now() - startMs) / 1000));
}

/**
 * Trims and caps stored turn text so conversation history remains bounded and readable.
 *
 * **Why it exists:**
 * Centralizes normalization rules for turn text so call sites stay aligned.
 *
 * **What it talks to:**
 * - Local whitespace normalization and length capping rules.
 *
 * @param value - Primary input consumed by this function.
 * @returns Turn text trimmed and capped to `MAX_STORED_TURN_CHARS`.
 */
export function normalizeTurnText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_STORED_TURN_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_STORED_TURN_CHARS - 3)}...`;
}

/**
 * Normalizes assistant-authored turn text and strips robotic label-style openings.
 *
 * **Why it exists:**
 * Assistant turns are persisted and later re-injected into prompt context. Stripping prefixes like
 * `AI assistant response:` here prevents stale history from teaching the model bad style in later
 * turns while preserving the underlying answer content.
 *
 * **What it talks to:**
 * - Uses `normalizeTurnText` for bounded storage.
 * - Uses `stripLabelStyleOpening` to remove robotic assistant labels.
 *
 * @param value - Raw assistant-authored turn text.
 * @returns Assistant turn text normalized for storage and prompt-context reuse.
 */
export function normalizeAssistantTurnText(value: string): string {
  const stripped = stripLabelStyleOpening(value).replace(/\r\n/g, "\n");
  const paragraphs = stripped
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .replace(/[^\S\n]+/g, " ")
        .replace(/\n+/g, " ")
        .trim()
    )
    .filter((paragraph) => paragraph.length > 0);
  const normalized = (paragraphs.length > 0
    ? paragraphs.join("\n\n")
    : stripped.replace(/\s+/g, " ").trim());
  if (normalized.length <= MAX_STORED_TURN_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_STORED_TURN_CHARS - 3)}...`;
}

/**
 * Renders conversation turns into bullet lines for prompt context blocks.
 *
 * **Why it exists:**
 * Defines public behavior from `conversationManagerHelpers.ts` for other modules/tests.
 *
 * **What it talks to:**
 * - Uses `ConversationTurn` (import `ConversationTurn`) from `./sessionStore`.
 *
 * @param turns - Conversation turns selected for context rendering.
 * @returns Bullet-style transcript lines used in prompt context blocks.
 */
export function renderTurnsForContext(turns: ConversationTurn[]): string {
  return turns
    .map((turn) =>
      `- ${turn.role}: ${turn.role === "assistant" ? normalizeAssistantTurnText(turn.text) : turn.text}`
    )
    .join("\n");
}

/**
 * Normalizes ordering and duplication for turns by time.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for turns by time in one place.
 *
 * **What it talks to:**
 * - Uses `ConversationTurn` (import `ConversationTurn`) from `./sessionStore`.
 *
 * @param turns - Conversation turns to order chronologically.
 * @returns Ordered collection produced by this step.
 */
export function sortTurnsByTime(turns: ConversationTurn[]): ConversationTurn[] {
  return [...turns].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

/**
 * Creates a synthetic failed job record when a stale running job must be recovered.
 *
 * **Why it exists:**
 * Keeps construction of recovered stale job consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ConversationJob` (import `ConversationJob`) from `./sessionStore`.
 *
 * @param jobId - Stable identifier used to reference an entity or record.
 * @param startedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param completedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed `ConversationJob` result.
 */
export function buildRecoveredStaleJob(
  jobId: string,
  startedAt: string,
  completedAt: string
): ConversationJob {
  return {
    id: jobId,
    input: "__recovered_stale_job__",
    createdAt: startedAt,
      startedAt,
      completedAt,
      status: "failed",
      resultSummary: null,
      errorMessage: "Recovered stale running job after runtime interruption.",
      recoveryTrace: {
        kind: "stale_session_recovery",
        status: "failed",
        summary: "Recovered stale running job after runtime interruption.",
        updatedAt: completedAt,
        recoveryClass: null,
        fingerprint: null
      },
      ackTimerGeneration: 0,
    ackEligibleAt: null,
    ackLifecycleState: "CANCELLED",
    ackMessageId: null,
    ackSentAt: null,
    ackEditAttemptCount: 0,
    ackLastErrorCode: "STALE_RUNNING_JOB_RECOVERED",
    finalDeliveryOutcome: "failed",
    finalDeliveryAttemptCount: 1,
    finalDeliveryLastErrorCode: "STALE_RUNNING_JOB_RECOVERED",
    finalDeliveryLastAttemptAt: completedAt
  };
}

/**
 * Creates a synthetic failed queued-job record when persisted queue state outlives the worker that
 * should have processed it.
 *
 * @param job - Persisted queued job being recovered.
 * @param completedAt - Recovery timestamp.
 * @returns Failed job snapshot suitable for recent-job ledgers.
 */
export function buildRecoveredStaleQueuedJob(
  job: ConversationJob,
  completedAt: string
): ConversationJob {
  return {
    ...job,
    startedAt: job.startedAt ?? job.createdAt,
      completedAt,
      status: "failed",
      resultSummary: null,
      errorMessage: "Recovered stale queued job after runtime interruption.",
      recoveryTrace: {
        kind: "stale_session_recovery",
        status: "failed",
        summary: "Recovered stale queued job after runtime interruption.",
        updatedAt: completedAt,
        recoveryClass: null,
        fingerprint: null
      },
      ackTimerGeneration: Math.max(1, job.ackTimerGeneration + 1),
    ackEligibleAt: null,
    ackLifecycleState: "CANCELLED",
    ackMessageId: null,
    ackSentAt: null,
    ackEditAttemptCount: 0,
    ackLastErrorCode: "STALE_QUEUED_JOB_RECOVERED",
    finalDeliveryOutcome: "failed",
    finalDeliveryAttemptCount: Math.max(1, job.finalDeliveryAttemptCount),
    finalDeliveryLastErrorCode: "STALE_QUEUED_JOB_RECOVERED",
    finalDeliveryLastAttemptAt: completedAt
  };
}

/**
 * Redacts the stored pulse-target conversation id for user-facing status output.
 *
 * **Why it exists:**
 * Defines public behavior from `conversationManagerHelpers.ts` for other modules/tests.
 *
 * **What it talks to:**
 * - Local string parsing/redaction only.
 *
 * @param lastPulseTargetConversationId - Last pulse conversation key stored in session state.
 * @returns Redacted provider label for UI display (for example `discord:redacted`).
 */
export function renderPulseTargetConversation(
  lastPulseTargetConversationId: string | null
): string {
  if (!lastPulseTargetConversationId) {
    return "none";
  }

  const provider = lastPulseTargetConversationId.split(":")[0]?.trim();
  if (!provider) {
    return "redacted";
  }

  return `${provider}:redacted`;
}
