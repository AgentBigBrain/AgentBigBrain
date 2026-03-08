/**
 * @fileoverview Owns canonical slash-command dispatch below the stable conversation ingress coordinator.
 */

import {
  renderConversationCommandHelpText,
  resolvePulseCommandResponse,
  resolveReviewCommandResponse
} from "../conversationCommandPolicy";
import {
  adjustProposalDraft,
  cancelProposalDraft,
  createProposalDraft,
  renderConversationStatus,
  renderConversationStatusDebug,
  renderProposalDraftStatus
} from "../conversationDraftStatusPolicy";
import {
  normalizeWhitespace,
  splitCommand
} from "../conversationManagerHelpers";
import type { ConversationInboundMessage } from "./managerContracts";
import type { ConversationSession } from "../sessionStore";
import { recordUserTurn } from "../conversationSessionMutations";
import type { ConversationIngressDependencies } from "./contracts";
import { approveProposal } from "./followUpResolution";
import { routeConversationChatInput } from "./conversationRouting";
import { handleMemoryReviewCommand } from "./memoryReviewCommand";

/**
 * Resolves `/status` command output with human-first default text and explicit debug fallback.
 *
 * @param session - Mutable session state being rendered.
 * @param argument - Optional `/status` sub-argument.
 * @returns User-facing status text for the requested mode.
 */
export function resolveStatusCommandResponse(
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
export async function handleConversationCommand(
  session: ConversationSession,
  message: ConversationInboundMessage,
  deps: ConversationIngressDependencies
): Promise<string> {
  const { command, argument } = splitCommand(message.text);

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
    return (await routeConversationChatInput(
      session,
      normalizedInput,
      message.receivedAt,
      deps
    )).reply;
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

  if (command === "memory") {
    return handleMemoryReviewCommand(session, message, deps, argument);
  }

  return "Unknown command. Use /help to see available commands.";
}
