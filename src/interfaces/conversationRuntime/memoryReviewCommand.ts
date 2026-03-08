/**
 * @fileoverview Handles bounded private `/memory` review and mutation commands.
 */

import { normalizeWhitespace, splitCommand } from "../conversationManagerHelpers";
import type { ConversationSession } from "../sessionStore";
import type { ConversationIngressDependencies } from "./contracts";
import type { ConversationInboundMessage } from "./managerContracts";
import {
  renderMemoryReviewHelpText,
  renderMemoryReviewList,
  renderMemoryReviewMutationResult
} from "./memoryReviewRendering";

type MemoryReviewMutationAction = "resolve" | "wrong" | "forget";

interface ParsedMemoryReviewAction {
  action: "list" | "help" | MemoryReviewMutationAction;
  episodeId: string | null;
  note: string;
}

/**
 * Handles the bounded remembered-situation review command surface.
 *
 * @param _session - Mutable session state for the current conversation.
 * @param message - Inbound slash-command message.
 * @param deps - Manager dependencies exposing brokered memory review operations.
 * @param argument - Raw `/memory` argument text.
 * @returns User-facing review or mutation result text.
 */
export async function handleMemoryReviewCommand(
  _session: ConversationSession,
  message: ConversationInboundMessage,
  deps: ConversationIngressDependencies,
  argument: string
): Promise<string> {
  if (message.conversationVisibility !== "private") {
    return "The /memory command is only available in private conversations.";
  }

  const parsed = parseMemoryReviewAction(argument);
  if (parsed.action === "help") {
    return renderMemoryReviewHelpText();
  }

  if (parsed.action === "list") {
    if (!deps.reviewConversationMemory) {
      return "Memory review is unavailable in this runtime.";
    }
    const episodes = await deps.reviewConversationMemory({
      reviewTaskId: buildMemoryReviewTaskId("review", message.receivedAt),
      query: message.text,
      nowIso: message.receivedAt,
      maxEpisodes: 5
    });
    return renderMemoryReviewList(episodes);
  }

  if (!parsed.episodeId) {
    return renderMemoryReviewHelpText();
  }

  const mutationRequest = {
    episodeId: parsed.episodeId,
    note: parsed.note || undefined,
    nowIso: message.receivedAt,
    sourceTaskId: buildMemoryReviewTaskId(parsed.action, message.receivedAt),
    sourceText: message.text
  };

  if (parsed.action === "resolve") {
    if (!deps.resolveConversationMemoryEpisode) {
      return "Memory review is unavailable in this runtime.";
    }
    const episode = await deps.resolveConversationMemoryEpisode(mutationRequest);
    return renderMemoryReviewMutationResult("resolve", episode);
  }

  if (parsed.action === "wrong") {
    if (!deps.markConversationMemoryEpisodeWrong) {
      return "Memory review is unavailable in this runtime.";
    }
    const episode = await deps.markConversationMemoryEpisodeWrong(mutationRequest);
    return renderMemoryReviewMutationResult("wrong", episode);
  }

  if (!deps.forgetConversationMemoryEpisode) {
    return "Memory review is unavailable in this runtime.";
  }
  const episode = await deps.forgetConversationMemoryEpisode({
    episodeId: mutationRequest.episodeId,
    nowIso: mutationRequest.nowIso,
    sourceTaskId: mutationRequest.sourceTaskId,
    sourceText: mutationRequest.sourceText
  });
  return renderMemoryReviewMutationResult("forget", episode);
}

/**
 * Parses `/memory` subcommands into a bounded deterministic command shape.
 *
 * @param argument - Raw command argument text.
 * @returns Parsed memory-review action.
 */
function parseMemoryReviewAction(argument: string): ParsedMemoryReviewAction {
  const normalized = normalizeWhitespace(argument);
  if (!normalized) {
    return {
      action: "list",
      episodeId: null,
      note: ""
    };
  }

  const { command, argument: remainder } = splitCommand(normalized);
  if (command === "help") {
    return {
      action: "help",
      episodeId: null,
      note: ""
    };
  }
  if (command === "list" || command === "status") {
    return {
      action: "list",
      episodeId: null,
      note: ""
    };
  }
  if (command === "resolve" || command === "wrong" || command === "forget") {
    const parsedTarget = parseEpisodeTarget(remainder);
    return {
      action: command,
      episodeId: parsedTarget.episodeId,
      note: parsedTarget.note
    };
  }

  return {
    action: "help",
    episodeId: null,
    note: ""
  };
}

/**
 * Parses the target episode id and optional note from a mutation command tail.
 *
 * @param value - Raw mutation argument text after the action name.
 * @returns Parsed target episode id and note.
 */
function parseEpisodeTarget(
  value: string
): { episodeId: string | null; note: string } {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return {
      episodeId: null,
      note: ""
    };
  }

  const firstSpace = normalized.indexOf(" ");
  if (firstSpace < 0) {
    return {
      episodeId: normalized,
      note: ""
    };
  }

  return {
    episodeId: normalized.slice(0, firstSpace),
    note: normalized.slice(firstSpace + 1).trim()
  };
}

/**
 * Builds a deterministic synthetic task id for user-driven memory review commands.
 *
 * @param action - Memory review action category.
 * @param receivedAt - Command timestamp.
 * @returns Stable synthetic task id for audit and mutation provenance.
 */
function buildMemoryReviewTaskId(action: string, receivedAt: string): string {
  const normalizedTimestamp = receivedAt.replace(/[^0-9A-Za-z]+/g, "_");
  return `memory_${action}_${normalizedTimestamp}`;
}
