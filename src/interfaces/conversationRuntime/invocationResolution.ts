/**
 * @fileoverview Owns canonical non-command invocation resolution below the stable conversation ingress coordinator.
 */

import { recordPulseLexicalClassifierEvent } from "../conversationClassifierEvents";
import { resolvePulseCommandResponse } from "../conversationCommandPolicy";
import {
  resolveNaturalPulseCommandClassification
} from "../conversationManagerHelpers";
import {
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

export interface ConversationInvocationResolution {
  reply: string;
  shouldStartWorker: boolean;
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
    return {
      reply: resolvePulseCommandResponse(
        session,
        naturalPulseClassification.commandIntent,
        message.receivedAt
      ),
      shouldStartWorker: false
    };
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

  return {
    reply: (await routeConversationMessageInput(
      session,
      trimmed,
      message.receivedAt,
      deps,
      message.media
    )).reply,
    shouldStartWorker: session.queuedJobs.length > 0
  };
}

