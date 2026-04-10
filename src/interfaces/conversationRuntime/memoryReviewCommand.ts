/**
 * @fileoverview Handles bounded private `/memory` review and mutation commands.
 */

import { normalizeWhitespace, splitCommand } from "../conversationManagerHelpers";
import type { ConversationSession } from "../sessionStore";
import type { ConversationIngressDependencies } from "./contracts";
import type {
  ConversationInboundMessage,
  ConversationMemoryMutationRequest
} from "./managerContracts";
import {
  renderMemoryReviewFactList,
  renderMemoryReviewFactMutationResult,
  renderMemoryReviewHelpText,
  renderMemoryReviewList,
  renderMemoryReviewMutationResult
} from "./memoryReviewRendering";

type MemoryReviewEpisodeMutationAction = "resolve" | "wrong" | "forget";
type MemoryReviewFactMutationAction = "correct" | "forget";
type MemoryReviewAction =
  | "list"
  | "help"
  | MemoryReviewEpisodeMutationAction
  | "fact_list"
  | "fact_correct"
  | "fact_forget";

interface ParsedMemoryReviewAction {
  action: MemoryReviewAction;
  episodeId: string | null;
  factId: string | null;
  query: string;
  replacementValue: string;
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

  if (parsed.action === "fact_list") {
    if (!parsed.query) {
      return renderMemoryReviewHelpText();
    }
    if (!deps.reviewConversationMemoryFacts) {
      return "Memory review is unavailable in this runtime.";
    }
    const facts = await deps.reviewConversationMemoryFacts({
      reviewTaskId: buildMemoryReviewTaskId("fact_review", message.receivedAt),
      query: parsed.query,
      nowIso: message.receivedAt,
      maxFacts: 5
    });
    return renderMemoryReviewFactList(facts);
  }

  if (parsed.action === "resolve") {
    if (!parsed.episodeId) {
      return renderMemoryReviewHelpText();
    }
    if (!deps.resolveConversationMemoryEpisode) {
      return "Memory review is unavailable in this runtime.";
    }
    const mutationRequest: ConversationMemoryMutationRequest = {
      episodeId: parsed.episodeId,
      note: parsed.note || undefined,
      nowIso: message.receivedAt,
      sourceTaskId: buildMemoryReviewTaskId(parsed.action, message.receivedAt),
      sourceText: message.text
    };
    const episode = await deps.resolveConversationMemoryEpisode(mutationRequest);
    return renderMemoryReviewMutationResult("resolve", episode);
  }

  if (parsed.action === "wrong") {
    if (!parsed.episodeId) {
      return renderMemoryReviewHelpText();
    }
    if (!deps.markConversationMemoryEpisodeWrong) {
      return "Memory review is unavailable in this runtime.";
    }
    const mutationRequest: ConversationMemoryMutationRequest = {
      episodeId: parsed.episodeId,
      note: parsed.note || undefined,
      nowIso: message.receivedAt,
      sourceTaskId: buildMemoryReviewTaskId(parsed.action, message.receivedAt),
      sourceText: message.text
    };
    const episode = await deps.markConversationMemoryEpisodeWrong(mutationRequest);
    return renderMemoryReviewMutationResult("wrong", episode);
  }

  if (parsed.action === "forget") {
    if (!parsed.episodeId) {
      return renderMemoryReviewHelpText();
    }
    if (!deps.forgetConversationMemoryEpisode) {
      return "Memory review is unavailable in this runtime.";
    }
    const episode = await deps.forgetConversationMemoryEpisode({
      episodeId: parsed.episodeId,
      nowIso: message.receivedAt,
      sourceTaskId: buildMemoryReviewTaskId(parsed.action, message.receivedAt),
      sourceText: message.text
    });
    return renderMemoryReviewMutationResult("forget", episode);
  }

  if (!parsed.factId) {
    return renderMemoryReviewHelpText();
  }
  if (parsed.action === "fact_correct") {
    if (!parsed.replacementValue) {
      return renderMemoryReviewHelpText();
    }
    if (!deps.correctConversationMemoryFact) {
      return "Memory review is unavailable in this runtime.";
    }
    const fact = await deps.correctConversationMemoryFact({
      factId: parsed.factId,
      replacementValue: parsed.replacementValue,
      note: parsed.note || undefined,
      nowIso: message.receivedAt,
      sourceTaskId: buildMemoryReviewTaskId("fact_correct", message.receivedAt),
      sourceText: message.text
    });
    return renderMemoryReviewFactMutationResult("correct", fact);
  }

  if (!deps.forgetConversationMemoryFact) {
    return "Memory review is unavailable in this runtime.";
  }
  const fact = await deps.forgetConversationMemoryFact({
    factId: parsed.factId,
    nowIso: message.receivedAt,
    sourceTaskId: buildMemoryReviewTaskId("fact_forget", message.receivedAt),
    sourceText: message.text
  });
  return renderMemoryReviewFactMutationResult("forget", fact);
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
      factId: null,
      query: "",
      replacementValue: "",
      note: ""
    };
  }

  const { command, argument: remainder } = splitCommand(normalized);
  if (command === "help") {
    return {
      action: "help",
      episodeId: null,
      factId: null,
      query: "",
      replacementValue: "",
      note: ""
    };
  }
  if (command === "list" || command === "status") {
    return {
      action: "list",
      episodeId: null,
      factId: null,
      query: "",
      replacementValue: "",
      note: ""
    };
  }
  if (command === "fact" || command === "facts") {
    return parseFactReviewAction(remainder);
  }
  if (command === "resolve" || command === "wrong" || command === "forget") {
    const parsedTarget = parseEpisodeTarget(remainder);
    return {
      action: command,
      episodeId: parsedTarget.episodeId,
      factId: null,
      query: "",
      replacementValue: "",
      note: parsedTarget.note
    };
  }

  return {
    action: "help",
    episodeId: null,
    factId: null,
    query: "",
    replacementValue: "",
    note: ""
  };
}

/**
 * Parses `/memory fact ...` subcommands into bounded deterministic fact review or mutation shapes.
 *
 * @param argument - Raw fact-command argument text.
 * @returns Parsed fact review action.
 */
function parseFactReviewAction(argument: string): ParsedMemoryReviewAction {
  const normalized = normalizeWhitespace(argument);
  if (!normalized) {
    return {
      action: "help",
      episodeId: null,
      factId: null,
      query: "",
      replacementValue: "",
      note: ""
    };
  }

  const { command, argument: remainder } = splitCommand(normalized);
  if (command === "list") {
    return {
      action: "fact_list",
      episodeId: null,
      factId: null,
      query: normalizeWhitespace(remainder),
      replacementValue: "",
      note: ""
    };
  }
  if (command === "correct") {
    const parsedTarget = parseFactCorrectionTarget(remainder);
    return {
      action: "fact_correct",
      episodeId: null,
      factId: parsedTarget.factId,
      query: "",
      replacementValue: parsedTarget.replacementValue,
      note: parsedTarget.note
    };
  }
  if (command === "forget") {
    const parsedTarget = parseFactTarget(remainder);
    return {
      action: "fact_forget",
      episodeId: null,
      factId: parsedTarget.factId,
      query: "",
      replacementValue: "",
      note: ""
    };
  }

  return {
    action: "fact_list",
    episodeId: null,
    factId: null,
    query: normalized,
    replacementValue: "",
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
 * Parses one remembered-fact target id from a mutation command tail.
 *
 * @param value - Raw fact mutation argument text after the action name.
 * @returns Parsed target fact id.
 */
function parseFactTarget(
  value: string
): { factId: string | null } {
  const normalized = normalizeWhitespace(value);
  return {
    factId: normalized || null
  };
}

/**
 * Parses one remembered-fact correction payload from a mutation command tail.
 *
 * @param value - Raw fact correction argument text after the action name.
 * @returns Parsed target fact id, replacement value, and optional note.
 */
function parseFactCorrectionTarget(
  value: string
): { factId: string | null; replacementValue: string; note: string } {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return {
      factId: null,
      replacementValue: "",
      note: ""
    };
  }

  const firstSpace = normalized.indexOf(" ");
  if (firstSpace < 0) {
    return {
      factId: normalized,
      replacementValue: "",
      note: ""
    };
  }

  return {
    factId: normalized.slice(0, firstSpace),
    replacementValue: normalized.slice(firstSpace + 1).trim(),
    note: ""
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
