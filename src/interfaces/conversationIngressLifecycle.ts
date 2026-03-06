/**
 * @fileoverview Runs deterministic inbound-message, command, proposal-flow, and stale-job recovery lifecycle for ConversationManager.
 */

import type {
  ConversationCheckpointReviewRunner,
  ConversationInboundMessage,
  ConversationIntentInterpreter,
  ConversationManagerConfig,
  ConversationNotifier,
  ExecuteConversationTask
} from "./conversationManager";
import type { InterpretedConversationIntent } from "../organs/intentInterpreter";
import { canTransitionAckLifecycleState } from "./ackStateMachine";
import { recordClassifierEvent, recordPulseLexicalClassifierEvent } from "./conversationClassifierEvents";
import {
  renderConversationCommandHelpText,
  resolvePulseCommandResponse,
  resolveReviewCommandResponse
} from "./conversationCommandPolicy";
import { buildConversationAwareExecutionInput, resolveFollowUpInput } from "./conversationExecutionInputPolicy";
import {
  adjustProposalDraft,
  cancelProposalDraft,
  createProposalDraft,
  renderConversationStatus,
  renderConversationStatusDebug,
  renderProposalDraftStatus
} from "./conversationDraftStatusPolicy";
import {
  buildConversationKey,
  buildProposalQuestionPrompt,
  buildRecoveredStaleJob,
  buildSessionSeed,
  classifyProposalReply,
  type FollowUpRuleContext,
  normalizeWhitespace,
  type PulseLexicalRuleContext,
  resolveNaturalPulseCommandClassification
} from "./conversationManagerHelpers";
import { classifyRoutingIntentV1 } from "./routingMap";
import { detectTimezoneFromMessage, type ConversationSession, InterfaceSessionStore } from "./sessionStore";
import { backfillPulseResponseOutcome, expireStaleEmissions } from "./pulseEmissionLifecycle";
import {
  backfillTurnsFromRecentJobsIfNeeded,
  findRecentJob,
  recordAssistantTurn,
  recordUserTurn,
  upsertRecentJob
} from "./conversationSessionMutations";

const MAX_INTENT_INTERPRETER_INPUT_CHARS = 320;

interface EnqueueResult {
  reply: string;
  shouldStartWorker: boolean;
}

interface InterpretedPulseResolution {
  pulseMode: "on" | "off" | "private" | "public" | "status";
  lexicalClassification: ReturnType<typeof resolveNaturalPulseCommandClassification> | null;
}

export interface ConversationIngressDependencies {
  store: InterfaceSessionStore;
  config: Pick<
    ConversationManagerConfig,
    | "allowAutonomousViaInterface"
    | "maxProposalInputChars"
    | "maxConversationTurns"
    | "maxContextTurnsForExecution"
    | "staleRunningJobRecoveryMs"
    | "maxRecentJobs"
  >;
  followUpRuleContext: FollowUpRuleContext;
  pulseLexicalRuleContext: PulseLexicalRuleContext;
  interpretConversationIntent?: ConversationIntentInterpreter;
  intentInterpreterConfidenceThreshold: number;
  runCheckpointReview?: ConversationCheckpointReviewRunner;
  isWorkerActive(sessionKey: string): boolean;
  clearAckTimer(sessionKey: string): void;
  setWorkerBinding(
    sessionKey: string,
    executeTask: ExecuteConversationTask,
    notify: ConversationNotifier
  ): void;
  startWorkerIfNeeded(
    sessionKey: string,
    executeTask: ExecuteConversationTask,
    notify: ConversationNotifier
  ): Promise<void>;
  enqueueJob(
    session: ConversationSession,
    input: string,
    receivedAt: string,
    executionInput?: string,
    isSystemJob?: boolean
  ): EnqueueResult;
  buildAutonomousExecutionInput(goal: string): string;
}

/**
 * Recovers stale running-job state when session metadata indicates worker interruption.
 *
 * @param sessionKey - Conversation session key.
 * @param session - Mutable session snapshot to repair.
 * @param nowIso - Recovery timestamp.
 * @param deps - Manager lifecycle dependencies and recovery bounds.
 */
function recoverStaleRunningJobIfNeeded(
  sessionKey: string,
  session: ConversationSession,
  nowIso: string,
  deps: ConversationIngressDependencies
): void {
  if (!session.runningJobId) {
    return;
  }
  if (deps.isWorkerActive(sessionKey)) {
    return;
  }

  const nowMs = Date.parse(nowIso);
  const updatedAtMs = Date.parse(session.updatedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(updatedAtMs)) {
    return;
  }
  if (nowMs - updatedAtMs < deps.config.staleRunningJobRecoveryMs) {
    return;
  }

  deps.clearAckTimer(sessionKey);
  const recoveredJob = findRecentJob(session, session.runningJobId);
  if (recoveredJob) {
    recoveredJob.status = "failed";
    recoveredJob.completedAt = nowIso;
    recoveredJob.resultSummary = null;
    recoveredJob.errorMessage = "Recovered stale running job after runtime interruption.";
    recoveredJob.ackTimerGeneration += 1;
    recoveredJob.ackLastErrorCode = "STALE_RUNNING_JOB_RECOVERED";
    recoveredJob.ackMessageId = null;
    recoveredJob.ackSentAt = null;
    recoveredJob.ackLifecycleState = canTransitionAckLifecycleState(
      recoveredJob.ackLifecycleState,
      "CANCELLED"
    )
      ? "CANCELLED"
      : recoveredJob.ackLifecycleState;
    if (recoveredJob.finalDeliveryOutcome === "not_attempted") {
      recoveredJob.finalDeliveryOutcome = "failed";
    }
    recoveredJob.finalDeliveryAttemptCount = Math.max(1, recoveredJob.finalDeliveryAttemptCount);
    recoveredJob.finalDeliveryLastErrorCode = "STALE_RUNNING_JOB_RECOVERED";
    recoveredJob.finalDeliveryLastAttemptAt = nowIso;
    upsertRecentJob(session, recoveredJob, deps.config.maxRecentJobs);
  } else {
    const syntheticRecoveredJob = buildRecoveredStaleJob(
      session.runningJobId,
      session.updatedAt,
      nowIso
    );
    upsertRecentJob(session, syntheticRecoveredJob, deps.config.maxRecentJobs);
  }

  session.runningJobId = null;
  session.updatedAt = nowIso;
}

/**
 * Approves the active proposal draft and enqueues it as a normal conversation job.
 *
 * @param session - Session containing proposal state.
 * @param message - Inbound approval message.
 * @param deps - Manager dependencies exposing enqueue behavior.
 * @returns User-facing approval response text.
 */
function approveProposal(
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
async function resolveInterpretedPulseCommandArgument(
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
async function handleImplicitProposalFlow(
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

/**
 * Resolves `/status` command output with human-first default text and explicit debug fallback.
 *
 * **Why it exists:**
 * Keeps status command argument handling deterministic so the normal user view stays simple while
 * operators can still opt into delivery/lifecycle internals on demand.
 *
 * **What it talks to:**
 * - Uses `renderConversationStatus` from `./conversationDraftStatusPolicy`.
 * - Uses `renderConversationStatusDebug` from `./conversationDraftStatusPolicy`.
 *
 * @param session - Mutable session state being rendered.
 * @param argument - Optional `/status` sub-argument.
 * @returns User-facing status text for the requested mode.
 */
function resolveStatusCommandResponse(
  session: ConversationSession,
  argument: string
): string {
  const normalizedArgument = argument.trim().toLowerCase();
  if (!normalizedArgument) {
    return renderConversationStatus(session);
  }
  if (normalizedArgument === "debug") {
    return renderConversationStatusDebug(session);
  }
  return "Usage: /status [debug]";
}

/**
 * Handles slash-command interactions with deterministic command-policy behavior.
 *
 * @param session - Mutable session state.
 * @param message - Inbound command message.
 * @param deps - Manager dependencies/config for command execution.
 * @returns User-facing command response text.
 */
async function handleCommand(
  session: ConversationSession,
  message: ConversationInboundMessage,
  deps: ConversationIngressDependencies
): Promise<string> {
  const normalized = message.text.trim().replace(/^\/+/, "");
  const firstSpace = normalized.indexOf(" ");
  const command =
    firstSpace < 0
      ? normalized.toLowerCase()
      : normalized.slice(0, firstSpace).toLowerCase();
  const argument = firstSpace < 0 ? "" : normalized.slice(firstSpace + 1).trim();

  if (command === "help") {
    return renderConversationCommandHelpText();
  }

  if (command === "status") {
    return resolveStatusCommandResponse(session, argument);
  }

  if (command === "propose") {
    if (!argument) {
      return "Usage: /propose <task request>";
    }
    return createProposalDraft(
      session,
      argument,
      message.receivedAt,
      deps.config.maxProposalInputChars
    );
  }

  if (command === "draft") {
    if (!session.activeProposal) {
      return "No active draft. Use /propose <task> to create one.";
    }
    return renderProposalDraftStatus(session.activeProposal);
  }

  if (command === "adjust") {
    if (!argument) {
      return "Usage: /adjust <changes>";
    }
    return adjustProposalDraft(
      session,
      argument,
      message.receivedAt,
      deps.config.maxProposalInputChars
    );
  }

  if (command === "approve") {
    return approveProposal(session, message, deps);
  }

  if (command === "cancel") {
    return cancelProposalDraft(session, message.receivedAt);
  }

  if (command === "chat") {
    if (!argument) {
      return "Usage: /chat <message>";
    }
    const normalizedInput = normalizeWhitespace(argument);
    const followUpResolution = resolveFollowUpInput(
      session,
      normalizedInput,
      deps.followUpRuleContext
    );
    const routingClassification = classifyRoutingIntentV1(normalizedInput);
    recordClassifierEvent(
      session,
      normalizedInput,
      message.receivedAt,
      followUpResolution.classification
    );
    const enqueueResult = deps.enqueueJob(
      session,
      normalizedInput,
      message.receivedAt,
      buildConversationAwareExecutionInput(
        session,
        followUpResolution.executionInput,
        deps.config.maxContextTurnsForExecution,
        routingClassification
      )
    );
    recordUserTurn(session, normalizedInput, message.receivedAt, deps.config.maxConversationTurns);
    return enqueueResult.reply;
  }

  if (command === "auto") {
    if (!deps.config.allowAutonomousViaInterface) {
      return "Autonomous loop is disabled. Set BRAIN_ALLOW_AUTONOMOUS_VIA_INTERFACE=true to enable.";
    }
    if (!argument) {
      return "Usage: /auto <goal>  --  Run a multi-step autonomous loop to achieve the goal.";
    }
    const normalizedGoal = normalizeWhitespace(argument);
    const enqueueResult = deps.enqueueJob(
      session,
      normalizedGoal,
      message.receivedAt,
      deps.buildAutonomousExecutionInput(normalizedGoal)
    );
    recordUserTurn(
      session,
      `/auto ${normalizedGoal}`,
      message.receivedAt,
      deps.config.maxConversationTurns
    );
    return `Starting autonomous loop for: ${normalizedGoal}\n${enqueueResult.reply}`;
  }

  if (command === "pulse") {
    return resolvePulseCommandResponse(session, argument, message.receivedAt);
  }

  if (command === "review") {
    return resolveReviewCommandResponse(argument, deps.runCheckpointReview);
  }

  return "Unknown command. Use /help to see available commands.";
}

/**
 * Processes one inbound message through command/pulse/proposal/queueing paths and persists session mutations.
 *
 * @param message - Inbound provider message.
 * @param executeTask - Runtime execute callback for direct proposal-question handling.
 * @param notify - Notifier callback or transport for queued work.
 * @param deps - Conversation manager lifecycle dependencies.
 * @returns User-facing reply string for this inbound message.
 */
export async function processConversationMessage(
  message: ConversationInboundMessage,
  executeTask: ExecuteConversationTask,
  notify: ConversationNotifier,
  deps: ConversationIngressDependencies
): Promise<string> {
  const trimmed = message.text.trim();
  if (!trimmed) {
    return "Message ignored because it is empty.";
  }

  const sessionKey = buildConversationKey(message);
  deps.setWorkerBinding(sessionKey, executeTask, notify);
  const session = (await deps.store.getSession(sessionKey)) ?? buildSessionSeed(message);
  recoverStaleRunningJobIfNeeded(sessionKey, session, message.receivedAt, deps);
  backfillTurnsFromRecentJobsIfNeeded(
    session,
    deps.config.maxContextTurnsForExecution,
    deps.config.maxConversationTurns
  );
  session.username = message.username;
  session.conversationVisibility = message.conversationVisibility;
  session.updatedAt = message.receivedAt;

  const receivedMs = Date.parse(message.receivedAt);
  backfillPulseResponseOutcome(session, trimmed, receivedMs);
  expireStaleEmissions(session, receivedMs);

  const detectedTz = detectTimezoneFromMessage(trimmed);
  if (detectedTz && detectedTz !== session.agentPulse.userTimezone) {
    session.agentPulse.userTimezone = detectedTz;
  }

  if (trimmed.startsWith("/")) {
    const reply = await handleCommand(session, message, deps);
    await deps.store.setSession(session);
    if (session.queuedJobs.length > 0) {
      void deps.startWorkerIfNeeded(sessionKey, executeTask, notify);
    }
    return reply;
  }

  const naturalPulseClassification = resolveNaturalPulseCommandClassification(
    trimmed,
    deps.pulseLexicalRuleContext
  );
  recordPulseLexicalClassifierEvent(
    session,
    trimmed,
    message.receivedAt,
    naturalPulseClassification
  );
  if (
    naturalPulseClassification.category === "COMMAND" &&
    !naturalPulseClassification.conflict &&
    naturalPulseClassification.commandIntent
  ) {
    const pulseReply = resolvePulseCommandResponse(
      session,
      naturalPulseClassification.commandIntent,
      message.receivedAt
    );
    await deps.store.setSession(session);
    return pulseReply;
  }

  if (!naturalPulseClassification.conflict) {
    const interpretedPulse = await resolveInterpretedPulseCommandArgument(
      trimmed,
      session,
      deps
    );
    if (interpretedPulse !== null) {
      if (interpretedPulse.lexicalClassification) {
        recordPulseLexicalClassifierEvent(
          session,
          trimmed,
          message.receivedAt,
          interpretedPulse.lexicalClassification
        );
      }
      const pulseReply = resolvePulseCommandResponse(
        session,
        interpretedPulse.pulseMode,
        message.receivedAt
      );
      await deps.store.setSession(session);
      return pulseReply;
    }
  }

  if (session.activeProposal) {
    const implicitReply = await handleImplicitProposalFlow(
      session,
      message,
      executeTask,
      deps
    );
    await deps.store.setSession(session);
    if (session.queuedJobs.length > 0) {
      void deps.startWorkerIfNeeded(sessionKey, executeTask, notify);
    }
    return implicitReply;
  }

  const followUpResolution = resolveFollowUpInput(
    session,
    trimmed,
    deps.followUpRuleContext
  );
  recordClassifierEvent(
    session,
    trimmed,
    message.receivedAt,
    followUpResolution.classification
  );
  const enqueueResult = deps.enqueueJob(
    session,
    trimmed,
    message.receivedAt,
    buildConversationAwareExecutionInput(
      session,
      followUpResolution.executionInput,
      deps.config.maxContextTurnsForExecution
    )
  );
  recordUserTurn(session, trimmed, message.receivedAt, deps.config.maxConversationTurns);
  await deps.store.setSession(session);
  if (session.queuedJobs.length > 0) {
    void deps.startWorkerIfNeeded(sessionKey, executeTask, notify);
  }
  return enqueueResult.reply;
}
