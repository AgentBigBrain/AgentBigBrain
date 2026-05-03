/**
 * @fileoverview Owns proposal and follow-up resolution helpers below the stable conversation ingress entrypoint.
 */

import type { InterpretedConversationIntent } from "../../organs/intentInterpreter";
import { buildConversationAwareExecutionInput } from "../conversationExecutionInputPolicy";
import { recordClassifierEvent } from "../conversationClassifierEvents";
import {
  adjustProposalDraft,
  cancelProposalDraft
} from "../conversationDraftStatusPolicy";
import {
  buildProposalQuestionPrompt,
  classifyProposalReply,
  proposalPreview,
  normalizeWhitespace,
  resolveNaturalPulseCommandClassification
} from "../conversationManagerHelpers";
import { classifyRoutingIntentV1 } from "../routingMap";
import type { ConversationSession } from "../sessionStore";
import { buildLocalIntentSessionHints } from "./conversationRoutingSupport";
import { routeProposalReplyInterpretationModel } from "../../organs/languageUnderstanding/localIntentModelRouter";
import type { ProposalReplyInterpretationSignal } from "../../organs/languageUnderstanding/localIntentModelProposalReplyContracts";
import {
  recordAssistantTurn,
  recordUserTurn
} from "../conversationSessionMutations";
import {
  resolveConversationInboundUserInput,
  type ConversationInboundMessage,
  type ExecuteConversationTask
} from "./managerContracts";
import type { ConversationIngressDependencies } from "./contracts";

const MAX_INTENT_INTERPRETER_INPUT_CHARS = 320;
const MAX_PROPOSAL_REPLY_INTERPRETATION_CHARS = 220;
const PROPOSAL_REPLY_COMMAND_PREFIX_PATTERN = /^[!/]/;
const PROPOSAL_REPLY_URL_PATTERN = /\b(?:https?:\/\/|file:\/\/|www\.)\S+/i;
const PROPOSAL_REPLY_WINDOWS_PATH_PATTERN = /(?:^|\s)[A-Za-z]:\\\S+/;
const PROPOSAL_REPLY_UNIX_PATH_PATTERN = /(?:^|\s)(?:\.{1,2}[\\/]|~[\\/]|\/)\S+/;
const PROPOSAL_REPLY_SHELL_PATTERN =
  /(?:^|\s)(?:npm|npx|pnpm|yarn|git|pwsh|powershell|cmd|bash|python|node)\b/i;
const PULSE_INTERPRETATION_HINT_PATTERN =
  /\b(pulse|check[- ]?in|check in|notifications?|reminders?|nudges?|pings?)\b/i;

/**
 * Validates a model-proposed draft adjustment payload against bounded deterministic safety rules.
 *
 * @param adjustmentText - Normalized adjustment text returned by the proposal-reply interpreter.
 * @returns `true` when the adjustment remains a short conversational edit request.
 */
function isProposalReplyAdjustmentTextSafe(adjustmentText: string): boolean {
  return !(
    PROPOSAL_REPLY_URL_PATTERN.test(adjustmentText) ||
    PROPOSAL_REPLY_WINDOWS_PATH_PATTERN.test(adjustmentText) ||
    PROPOSAL_REPLY_UNIX_PATH_PATTERN.test(adjustmentText) ||
    PROPOSAL_REPLY_SHELL_PATTERN.test(adjustmentText)
  );
}

/**
 * Returns whether proposal-reply interpretation is justified after deterministic lexical proposal
 * classification remains unresolved.
 *
 * @param session - Current conversation session containing active draft state.
 * @param normalizedInput - Canonically normalized inbound user text.
 * @param proposalReplyClassification - Deterministic lexical proposal-reply result for the same turn.
 * @param deps - Ingress dependencies that expose the optional shared proposal-reply resolver.
 * @returns `true` when one bounded model attempt is allowed.
 */
function shouldAttemptProposalReplyInterpretation(
  session: ConversationSession,
  normalizedInput: string,
  proposalReplyClassification: ReturnType<typeof classifyProposalReply>,
  deps: ConversationIngressDependencies
): boolean {
  if (!deps.proposalReplyInterpretationResolver || !session.activeProposal) {
    return false;
  }
  if (proposalReplyClassification.intent !== "QUESTION") {
    return false;
  }
  if (!normalizedInput || normalizedInput.includes("\n")) {
    return false;
  }
  if (normalizedInput.length > MAX_PROPOSAL_REPLY_INTERPRETATION_CHARS) {
    return false;
  }
  if (PROPOSAL_REPLY_COMMAND_PREFIX_PATTERN.test(normalizedInput)) {
    return false;
  }
  return true;
}

/**
 * Returns the latest assistant-authored turn near the active proposal exchange.
 *
 * @param session - Conversation session carrying recent turns.
 * @returns Most recent assistant text, or `null` when none exists.
 */
function resolveRecentAssistantProposalTurn(session: ConversationSession): string | null {
  return [...session.conversationTurns]
    .reverse()
    .find((turn) => turn.role === "assistant")
    ?.text ?? null;
}

/**
 * Resolves one bounded proposal-reply interpretation signal for ambiguous active-draft turns while
 * preserving deterministic fail-closed behavior.
 *
 * @param session - Current conversation session containing proposal state and recent turns.
 * @param normalizedInput - Canonically normalized inbound user text.
 * @param proposalReplyClassification - Deterministic lexical proposal-reply result for the same turn.
 * @param deps - Ingress dependencies that expose the optional shared proposal-reply resolver.
 * @returns Validated proposal-reply signal, or `null` when lexical behavior should remain in control.
 */
async function resolveInterpretedProposalReply(
  session: ConversationSession,
  normalizedInput: string,
  proposalReplyClassification: ReturnType<typeof classifyProposalReply>,
  deps: ConversationIngressDependencies
): Promise<ProposalReplyInterpretationSignal | null> {
  if (
    !shouldAttemptProposalReplyInterpretation(
      session,
      normalizedInput,
      proposalReplyClassification,
      deps
    )
  ) {
    return null;
  }
  const activeProposal = session.activeProposal;
  if (!activeProposal) {
    return null;
  }
  const interpretation = await routeProposalReplyInterpretationModel(
    {
      userInput: normalizedInput,
      routingClassification: classifyRoutingIntentV1(normalizedInput),
      sessionHints: buildLocalIntentSessionHints(session),
      activeProposalPreview: proposalPreview(activeProposal),
      recentAssistantTurn: resolveRecentAssistantProposalTurn(session)
    },
    deps.proposalReplyInterpretationResolver
  );
  if (
    !interpretation ||
    interpretation.confidence === "low" ||
    interpretation.kind === "question_or_unclear" ||
    interpretation.kind === "non_proposal_reply" ||
    interpretation.kind === "uncertain"
  ) {
    return null;
  }
  if (
    interpretation.kind === "adjust" &&
    (!interpretation.adjustmentText ||
      !isProposalReplyAdjustmentTextSafe(interpretation.adjustmentText))
  ) {
    return null;
  }
  return interpretation;
}

export interface InterpretedPulseResolution {
  pulseMode: "on" | "off" | "private" | "public" | "status";
  lexicalClassification: ReturnType<typeof resolveNaturalPulseCommandClassification> | null;
}

/**
 * Approves the active proposal draft and enqueues it as a normal conversation job.
 *
 * @param session - Session containing proposal state.
 * @param message - Inbound approval message.
 * @param deps - Manager dependencies exposing enqueue behavior.
 * @returns User-facing approval response text.
 */
export function approveProposal(
  session: ConversationSession,
  message: ConversationInboundMessage,
  deps: ConversationIngressDependencies
): string {
  const active = session.activeProposal;
  if (!active) {
    return "No active draft to approve. Use /propose <task> first.";
  }

  active.status = "approved";
  active.updatedAt = message.receivedAt;
  const enqueueResult = deps.enqueueJob(session, active.currentInput, message.receivedAt);
  active.status = "executed";
  session.activeProposal = null;
  session.updatedAt = message.receivedAt;
  if (enqueueResult.reply.trim().length > 0) {
    return [
      `Draft ${active.id} approved.`,
      enqueueResult.reply
    ].join("\n");
  }
  return [
    `Draft ${active.id} approved.`,
    "Execution started. I will keep you updated here while it runs."
  ].join("\n");
}

/**
 * Resolves optional model-assisted pulse-control interpretation for nuanced natural language.
 *
 * @param userText - User utterance being interpreted.
 * @param session - Session used for bounded turn context.
 * @param deps - Manager dependencies including optional intent interpreter.
 * @returns Interpreted pulse resolution when confidence gates pass; otherwise `null`.
 */
export async function resolveInterpretedPulseCommandArgument(
  userText: string,
  session: ConversationSession,
  deps: ConversationIngressDependencies
): Promise<InterpretedPulseResolution | null> {
  if (!deps.interpretConversationIntent) {
    return null;
  }
  const normalizedUserText = normalizeWhitespace(userText);
  if (normalizedUserText.length > MAX_INTENT_INTERPRETER_INPUT_CHARS) {
    return null;
  }
  if (!PULSE_INTERPRETATION_HINT_PATTERN.test(normalizedUserText)) {
    return null;
  }

  const recentTurns = session.conversationTurns.slice(-deps.config.maxContextTurnsForExecution);
  let interpreted: InterpretedConversationIntent;
  try {
    interpreted = await deps.interpretConversationIntent(
      normalizedUserText,
      recentTurns,
      deps.pulseLexicalRuleContext
    );
  } catch {
    return null;
  }
  if (
    interpreted.intentType !== "pulse_control" ||
    !interpreted.pulseMode ||
    interpreted.confidence < deps.intentInterpreterConfidenceThreshold
  ) {
    return null;
  }

  return {
    pulseMode: interpreted.pulseMode,
    lexicalClassification: interpreted.lexicalClassification ?? null
  };
}

/**
 * Handles plain-text messages while an active proposal exists.
 *
 * @param session - Session containing active proposal context.
 * @param message - Current inbound message.
 * @param executeTask - Runtime execute callback.
 * @param deps - Manager dependencies and shared config.
 * @returns User-facing proposal-flow response text.
 */
export async function handleImplicitProposalFlow(
  session: ConversationSession,
  message: ConversationInboundMessage,
  executeTask: ExecuteConversationTask,
  deps: ConversationIngressDependencies
): Promise<string> {
  const normalizedInput = resolveConversationInboundUserInput(message).trim();
  const proposalReplyClassification = classifyProposalReply(normalizedInput, {
    hasActiveProposal: Boolean(session.activeProposal),
    ruleContext: deps.followUpRuleContext
  });
  recordClassifierEvent(
    session,
    normalizedInput,
    message.receivedAt,
    proposalReplyClassification
  );

  if (proposalReplyClassification.intent === "APPROVE") {
    return approveProposal(session, message, deps);
  }

  if (proposalReplyClassification.intent === "CANCEL") {
    return cancelProposalDraft(session, message.receivedAt);
  }

  if (proposalReplyClassification.intent === "ADJUST") {
    const adjustmentText =
      proposalReplyClassification.adjustmentText ?? message.text.trim();
    return adjustProposalDraft(
      session,
      adjustmentText,
      message.receivedAt,
      deps.config.maxProposalInputChars
    );
  }

  const active = session.activeProposal;
  const interpretedProposalReply = active
    ? await resolveInterpretedProposalReply(
      session,
      normalizedInput,
      proposalReplyClassification,
      deps
    )
    : null;
  if (interpretedProposalReply?.kind === "approve") {
    return approveProposal(session, message, deps);
  }
  if (interpretedProposalReply?.kind === "cancel") {
    return cancelProposalDraft(session, message.receivedAt);
  }
  if (interpretedProposalReply?.kind === "adjust" && interpretedProposalReply.adjustmentText) {
    return adjustProposalDraft(
      session,
      interpretedProposalReply.adjustmentText,
      message.receivedAt,
      deps.config.maxProposalInputChars
    );
  }

  if (!active) {
    const enqueueResult = deps.enqueueJob(
      session,
      normalizedInput,
      message.receivedAt,
      await buildConversationAwareExecutionInput(
        session,
        normalizedInput,
        deps.config.maxContextTurnsForExecution,
        classifyRoutingIntentV1(normalizedInput),
        normalizedInput,
        deps.queryContinuityEpisodes,
        deps.queryContinuityFacts,
        message.media,
        undefined,
        null,
        undefined,
        deps.contextualReferenceInterpretationResolver,
        deps.getEntityGraph,
        deps.entityReferenceInterpretationResolver,
        deps.openContinuityReadSession
      )
    );
    recordUserTurn(session, normalizedInput, message.receivedAt, deps.config.maxConversationTurns);
    return enqueueResult.reply;
  }

  if (session.runningJobId || session.queuedJobs.length > 0) {
    const enqueueResult = deps.enqueueJob(
      session,
      normalizedInput,
      message.receivedAt,
      buildProposalQuestionPrompt(active, normalizedInput)
    );
    recordUserTurn(session, normalizedInput, message.receivedAt, deps.config.maxConversationTurns);
    return enqueueResult.reply;
  }

  recordUserTurn(session, normalizedInput, message.receivedAt, deps.config.maxConversationTurns);
  const answer = await executeTask(
    buildProposalQuestionPrompt(active, normalizedInput),
    message.receivedAt
  );
  recordAssistantTurn(
    session,
    answer.summary,
    message.receivedAt,
    deps.config.maxConversationTurns,
    {
      assistantTurnKind: "informational_answer"
    }
  );
  return [
    answer.summary,
    "",
    `Draft ${active.id} is still pending.`,
    "Reply with changes, say approve to run it, or say cancel to stop this draft."
  ].join("\n");
}

