/**
 * @fileoverview Detects bounded media-analysis turns that should stay on the conversational path.
 */

import type { ConversationInboundMediaEnvelope } from "../mediaRuntime/contracts";
import {
  analyzeConversationChatTurnSignals,
  collectConversationChatTurnRawTokens,
  normalizeConversationChatTurnWhitespace
} from "./chatTurnSignalAnalysis";

const MEDIA_ANALYSIS_VERBS = new Set([
  "describe",
  "extract",
  "identify",
  "list",
  "review",
  "summarize",
  "tell",
  "what"
]);

const MEDIA_ANALYSIS_SUBJECT_TERMS = new Set([
  "appear",
  "appears",
  "attached",
  "attachment",
  "content",
  "contents",
  "describe",
  "diagram",
  "document",
  "filing",
  "filings",
  "identifier",
  "identifiers",
  "image",
  "label",
  "labels",
  "name",
  "names",
  "pdf",
  "photo",
  "picture",
  "process",
  "show",
  "shows",
  "text",
  "video",
  "visible",
  "what"
]);

const MEDIA_REPAIR_TERMS = new Set([
  "blocked",
  "broken",
  "bug",
  "debug",
  "error",
  "failing",
  "failed",
  "fix",
  "issue",
  "problem",
  "regression",
  "repair",
  "test",
  "tests"
]);

const MEDIA_WORKFLOW_TERMS = new Set([
  "approve",
  "build",
  "change",
  "close",
  "create",
  "delete",
  "deploy",
  "edit",
  "launch",
  "move",
  "open",
  "restart",
  "run",
  "save",
  "scaffold",
  "start",
  "stop",
  "update",
  "write"
]);

const ATTACHED_MEDIA_CONTEXT_MARKER = "\n\nAttached media context:";

/**
 * Extracts direct media analysis text.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param userInput - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function extractDirectMediaAnalysisText(userInput: string): string {
  const attachedMediaIndex = userInput.indexOf(ATTACHED_MEDIA_CONTEXT_MARKER);
  if (attachedMediaIndex >= 0) {
    return userInput.slice(0, attachedMediaIndex).trim();
  }
  return userInput.trim();
}

/**
 * Returns whether one inbound attachment review turn should stay on the direct conversational path.
 *
 * @param userInput - Canonical user input for the turn.
 * @param media - Optional inbound media envelope attached to the turn.
 * @returns `true` when the turn is about understanding attachment content, not executing work.
 */
export function isMediaAnalysisConversationTurn(
  userInput: string,
  media: ConversationInboundMediaEnvelope | null | undefined
): boolean {
  if ((media?.attachments?.length ?? 0) === 0) {
    return false;
  }

  const directText = extractDirectMediaAnalysisText(userInput);
  const normalized = normalizeConversationChatTurnWhitespace(directText);
  if (!normalized) {
    return false;
  }

  const rawTokens = collectConversationChatTurnRawTokens(normalized);
  const signals = analyzeConversationChatTurnSignals(normalized);
  if (signals.containsWorkflowCue) {
    return false;
  }
  if (rawTokens.some((token) => MEDIA_REPAIR_TERMS.has(token))) {
    return false;
  }
  if (
    rawTokens.some(
      (token) =>
        MEDIA_WORKFLOW_TERMS.has(token) &&
        !MEDIA_ANALYSIS_SUBJECT_TERMS.has(token)
    )
  ) {
    return false;
  }

  const hasAnalysisVerb = rawTokens.some((token) => MEDIA_ANALYSIS_VERBS.has(token));
  const hasMediaSubject = rawTokens.some((token) => MEDIA_ANALYSIS_SUBJECT_TERMS.has(token));
  const asksForGroundedExplanation =
    hasAnalysisVerb &&
    hasMediaSubject &&
    (signals.questionLike || rawTokens.includes("please"));
  return asksForGroundedExplanation;
}
