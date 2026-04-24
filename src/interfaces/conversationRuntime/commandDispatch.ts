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
import {
  resolveConversationCommandRoutingInput,
  type ConversationInboundMessage
} from "./managerContracts";
import type { ConversationSession } from "../sessionStore";
import { recordUserTurn } from "../conversationSessionMutations";
import type { ConversationIngressDependencies } from "./contracts";
import { approveProposal } from "./followUpResolution";
import { routeConversationChatInput } from "./conversationRouting";
import { handleMemoryReviewCommand } from "./memoryReviewCommand";
import { renderSkillInventory } from "../../organs/skillRegistry/skillInspection";
import { normalizeModelBackend } from "../../models/backendConfig";

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
 * Resolves `/backend` command output and mutations for per-session backend override.
 *
 * @param session - Mutable session state being rendered or updated.
 * @param argument - Optional backend argument.
 * @returns User-facing backend status or mutation result.
 */
function resolveBackendCommandResponse(
  session: ConversationSession,
  argument: string
): string {
  const normalizedArgument = argument.trim().toLowerCase();
  if (!normalizedArgument || normalizedArgument === "status") {
    return `Session backend override: ${session.modelBackendOverride ?? "none (using process default)"}.`;
  }
  if (normalizedArgument === "clear" || normalizedArgument === "default") {
    session.modelBackendOverride = null;
    session.updatedAt = new Date().toISOString();
    return "Cleared the session backend override. This conversation will use the process default backend again.";
  }
  let normalizedBackend;
  try {
    normalizedBackend = normalizeModelBackend(normalizedArgument);
  } catch {
    return "Unsupported backend. Use /backend status, /backend clear, or one of: mock, ollama, openai_api, codex_oauth.";
  }
  session.modelBackendOverride = normalizedBackend;
  session.updatedAt = new Date().toISOString();
  if (normalizedBackend !== "codex_oauth") {
    session.codexAuthProfileId = null;
  }
  return `Session backend override set to ${normalizedBackend}. New direct replies and task runs in this conversation will use that backend.`;
}

/**
 * Resolves `/profile` command output and mutations for Codex session profile override.
 *
 * @param session - Mutable session state being rendered or updated.
 * @param argument - Optional profile argument.
 * @returns User-facing profile status or mutation result.
 */
function resolveProfileCommandResponse(
  session: ConversationSession,
  argument: string
): string {
  const normalizedArgument = argument.trim();
  if (!normalizedArgument || normalizedArgument.toLowerCase() === "status") {
    return `Session Codex profile override: ${session.codexAuthProfileId ?? "none (using default profile)"}.`;
  }
  if (normalizedArgument.toLowerCase() === "clear" || normalizedArgument.toLowerCase() === "default") {
    session.codexAuthProfileId = null;
    session.updatedAt = new Date().toISOString();
    return "Cleared the session Codex profile override. This conversation will use the default Codex profile when Codex is selected.";
  }
  session.codexAuthProfileId = normalizedArgument;
  if (!session.modelBackendOverride) {
    session.modelBackendOverride = "codex_oauth";
  }
  session.updatedAt = new Date().toISOString();
  return `Session Codex profile override set to ${normalizedArgument}. This conversation will use that Codex profile when the Codex backend is selected.`;
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
  const normalizedCommandInput = resolveConversationCommandRoutingInput(message).trim();
  const commandInput = normalizedCommandInput.startsWith("/")
    ? (normalizedCommandInput.split(/\r?\n/, 1)[0] ?? normalizedCommandInput)
    : normalizedCommandInput;
  const { command, argument } = splitCommand(commandInput);

  if (command === "help") {
    return renderConversationCommandHelpText();
  }

  if (command === "status") {
    return resolveStatusCommandResponse(session, argument);
  }

  if (command === "backend") {
    return resolveBackendCommandResponse(session, argument);
  }

  if (command === "profile") {
    return resolveProfileCommandResponse(session, argument);
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
      {
        ...deps,
        abortActiveAutonomousRun: deps.abortActiveAutonomousRun
          ? () => deps.abortActiveAutonomousRun?.(message.conversationId) ?? false
          : undefined
      }
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

  if (command === "skills") {
    if (!deps.listAvailableSkills) {
      return "Skill inventory is unavailable in this runtime.";
    }
    return renderSkillInventory(await deps.listAvailableSkills());
  }

  return "Unknown command. Use /help to see available commands.";
}
