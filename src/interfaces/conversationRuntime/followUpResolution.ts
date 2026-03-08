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
  normalizeWhitespace,
  resolveNaturalPulseCommandClassification
} from "../conversationManagerHelpers";
import { classifyRoutingIntentV1 } from "../routingMap";
import type { ConversationSession } from "../sessionStore";
import {
  recordAssistantTurn,
  recordUserTurn
} from "../conversationSessionMutations";
import type {
  ConversationInboundMessage,
  ExecuteConversationTask
} from "./managerContracts";
import type { ConversationIngressDependencies } from "./contracts";

const MAX_INTENT_INTERPRETER_INPUT_CHARS = 320;

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
    "Execution started. Use /status for live state."
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
  if (normalizeWhitespace(userText).length > MAX_INTENT_INTERPRETER_INPUT_CHARS) {
    return null;
  }

  const recentTurns = session.conversationTurns.slice(-deps.config.maxContextTurnsForExecution);
  let interpreted: InterpretedConversationIntent;
  try {
    interpreted = await deps.interpretConversationIntent(
      userText,
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
  const normalizedInput = message.text.trim();
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
  if (!active) {
    const enqueueResult = deps.enqueueJob(
      session,
      normalizedInput,
      message.receivedAt,
      buildConversationAwareExecutionInput(
        session,
        normalizedInput,
        deps.config.maxContextTurnsForExecution,
        classifyRoutingIntentV1(normalizedInput)
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
  recordAssistantTurn(session, answer.summary, message.receivedAt, deps.config.maxConversationTurns);
  return [
    answer.summary,
    "",
    `Draft ${active.id} is still pending.`,
    "Use 'adjust <changes>', 'approve', or 'cancel'."
  ].join("\n");
}
