/**
 * @fileoverview Owns canonical non-command invocation resolution below the stable conversation ingress coordinator.
 */

import { recordPulseLexicalClassifierEvent } from "../conversationClassifierEvents";
import { resolvePulseCommandResponse } from "../conversationCommandPolicy";
import {
  resolveNaturalPulseCommandClassification
} from "../conversationManagerHelpers";
import {
  resolveConversationCommandRoutingInput,
  resolveConversationInboundUserInput,
  type ConversationInboundMessage,
  type ExecuteConversationTask
} from "./managerContracts";
import type { ConversationSession } from "../sessionStore";
import type { ConversationIngressDependencies } from "./contracts";
import {
  handleImplicitProposalFlow,
  resolveInterpretedPulseCommandArgument
} from "./followUpResolution";
import { routeConversationMessageInput } from "./conversationRouting";
import { isMixedConversationMemoryStatusRecallTurn } from "./chatTurnSignals";

export interface ConversationInvocationResolution {
  reply: string;
  shouldStartWorker: boolean;
}

const EXPLICIT_PULSE_STATUS_HINT_PATTERN =
  /\b(pulse|check[- ]?in|check in|notifications?|reminders?|nudges?|pings?)\b/i;

/**
 * Returns whether active or queued work should win over a generic pulse-status lexical match.
 *
 * @param session - Mutable conversation session under evaluation.
 * @returns `true` when there is runnable or waiting work in flight.
 */
function hasActiveOrQueuedWork(session: ConversationSession): boolean {
  if (session.runningJobId || session.queuedJobs.length > 0) {
    return true;
  }
  return (
    session.progressState?.status === "starting" ||
    session.progressState?.status === "working" ||
    session.progressState?.status === "retrying" ||
    session.progressState?.status === "verifying" ||
    session.progressState?.status === "waiting_for_user"
  );
}

/**
 * Resolves one non-command inbound message across pulse control, proposal follow-up, and queue-routing paths.
 *
 * @param session - Mutable conversation session receiving any policy side effects.
 * @param message - Inbound non-command conversation message.
 * @param executeTask - Runtime execution callback for direct proposal-question handling.
 * @param deps - Stable ingress dependencies exposed by the top-level coordinator.
 * @returns User-facing reply plus whether the stable ingress coordinator should start the worker.
 */
export async function resolveConversationInvocation(
  session: ConversationSession,
  message: ConversationInboundMessage,
  executeTask: ExecuteConversationTask,
  deps: ConversationIngressDependencies
): Promise<ConversationInvocationResolution> {
  const trimmed = resolveConversationInboundUserInput(message).trim();
  const commandRoutingText = resolveConversationCommandRoutingInput(message).trim();
  const naturalPulseClassification = resolveNaturalPulseCommandClassification(
    commandRoutingText,
    deps.pulseLexicalRuleContext
  );
  recordPulseLexicalClassifierEvent(
    session,
    commandRoutingText,
    message.receivedAt,
    naturalPulseClassification
  );
  const mixedMemoryStatusRecall =
    isMixedConversationMemoryStatusRecallTurn(commandRoutingText);
  const shouldPreferWorkStatusOverPulseStatus =
    naturalPulseClassification.category === "COMMAND" &&
    naturalPulseClassification.commandIntent === "status" &&
    !naturalPulseClassification.conflict &&
    hasActiveOrQueuedWork(session) &&
    !EXPLICIT_PULSE_STATUS_HINT_PATTERN.test(commandRoutingText);
  const shouldPreferConversationRecallOverPulseStatus =
    naturalPulseClassification.category === "COMMAND" &&
    naturalPulseClassification.commandIntent === "status" &&
    !naturalPulseClassification.conflict &&
    mixedMemoryStatusRecall &&
    !EXPLICIT_PULSE_STATUS_HINT_PATTERN.test(commandRoutingText);
  if (
    !shouldPreferWorkStatusOverPulseStatus &&
    !shouldPreferConversationRecallOverPulseStatus &&
    naturalPulseClassification.category === "COMMAND" &&
    !naturalPulseClassification.conflict &&
    naturalPulseClassification.commandIntent
  ) {
    return {
      reply: resolvePulseCommandResponse(
        session,
        naturalPulseClassification.commandIntent,
        message.receivedAt
      ),
      shouldStartWorker: false
    };
  }

  if (
    !naturalPulseClassification.conflict &&
    !shouldPreferWorkStatusOverPulseStatus &&
    !shouldPreferConversationRecallOverPulseStatus
  ) {
    const interpretedPulse = await resolveInterpretedPulseCommandArgument(
      commandRoutingText,
      session,
      deps
    );
    if (interpretedPulse !== null) {
      if (interpretedPulse.lexicalClassification) {
        recordPulseLexicalClassifierEvent(
          session,
          commandRoutingText,
          message.receivedAt,
          interpretedPulse.lexicalClassification
        );
      }
      return {
        reply: resolvePulseCommandResponse(
          session,
          interpretedPulse.pulseMode,
          message.receivedAt
        ),
        shouldStartWorker: false
      };
    }
  }

  if (session.activeProposal) {
    return {
      reply: await handleImplicitProposalFlow(
        session,
        message,
        executeTask,
        deps
      ),
      shouldStartWorker: session.queuedJobs.length > 0
    };
  }

  const routedResolution = await routeConversationMessageInput(
    session,
    trimmed,
    message.receivedAt,
    {
      ...deps,
      abortActiveAutonomousRun: deps.abortActiveAutonomousRun
        ? () => deps.abortActiveAutonomousRun?.(message.conversationId) ?? false
        : undefined,
      runDirectConversationTurn: deps.runDirectConversationTurn
    },
    message.media
  );

  return {
    reply: routedResolution.reply,
    shouldStartWorker: routedResolution.shouldStartWorker
  };
}

