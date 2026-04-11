/**
 * @fileoverview Bounded relationship-memory continuity context for ordinary direct-chat prompts.
 */

import type { ProfileMemoryRequestTelemetry } from "../../core/profileMemoryRuntime/contracts";
import { extractContextualRecallTerms } from "../../core/languageRuntime/queryIntentTerms";
import { hasConversationalProfileUpdateSignal } from "../../core/profileMemoryRuntime/profileMemoryConversationalSignals";
import {
  recordProfileMemoryRenderOperation,
  recordProfileMemorySynthesisOperation
} from "../../core/profileMemoryRuntime/profileMemoryRequestTelemetry";
import { buildRecallSynthesis, renderRecallSynthesisSupportLines } from "../../organs/memorySynthesis/recallSynthesis";
import { normalizeWhitespace } from "../conversationManagerHelpers";
import type { ConversationSession } from "../sessionStore";
import { analyzeConversationChatTurnSignals, isRelationshipConversationRecallTurn } from "./chatTurnSignals";
import {
  ensureStructuredContinuityFactResult,
  toMemorySynthesisFactRecord
} from "./contextualRecallContinuitySupport";
import { resolveConversationStack } from "./contextualRecallSupport";
import type { ConversationContinuityFactRecord, ConversationContinuityFactResult } from "./continuityContracts";
import type { QueryConversationContinuityFacts } from "./managerContracts";

/**
 * Returns whether the current short turn is plausibly continuing a recent personal-memory subject
 * without restating the original person or relationship bundle.
 *
 * @param session - Conversation session containing recent user turns.
 * @param userInput - Raw current user wording.
 * @returns `true` when one short question overlaps a recent memory-shaped user turn.
 */
export function hasRecentMemorySubjectFollowUpContext(
  session: ConversationSession,
  userInput: string
): boolean {
  return collectRecentMemorySubjectFollowUpHints(session, userInput).length > 0;
}

/**
 * Collects bounded recent memory-turn hints that overlap the current short follow-up wording.
 *
 * @param session - Conversation session containing recent user turns.
 * @param userInput - Raw current user wording.
 * @returns Stable deduped hint terms from the best recent memory-shaped user turns.
 */
function collectRecentMemorySubjectFollowUpHints(
  session: ConversationSession,
  userInput: string
): readonly string[] {
  const normalizedInput = normalizeWhitespace(userInput);
  if (!normalizedInput) {
    return [];
  }
  const inputSignals = analyzeConversationChatTurnSignals(normalizedInput);
  if (
    !inputSignals.questionLike ||
    inputSignals.containsWorkflowCue ||
    inputSignals.referencesArtifact ||
    inputSignals.meaningfulTerms.length === 0 ||
    inputSignals.rawTokenCount > 6
  ) {
    return [];
  }
  const currentTerms = new Set(
    inputSignals.meaningfulTerms.map((term) => term.toLowerCase())
  );
  const matchedTerms = new Set<string>(inputSignals.meaningfulTerms);
  let matchedRecentTurn = false;
  session.conversationTurns
    .slice(-8)
    .forEach((turn) => {
      if (
        turn.role !== "user" ||
        (
          !hasConversationalProfileUpdateSignal(turn.text) &&
          !isRelationshipConversationRecallTurn(turn.text)
        )
      ) {
        return;
      }
      const turnSignals = analyzeConversationChatTurnSignals(turn.text);
      if (
        !turnSignals.meaningfulTerms.some((term) =>
          currentTerms.has(term.toLowerCase())
        )
      ) {
        return;
      }
      matchedRecentTurn = true;
      for (const term of turnSignals.meaningfulTerms) {
        matchedTerms.add(term);
        if (matchedTerms.size >= 6) {
          return;
        }
      }
    });
  return matchedRecentTurn ? [...matchedTerms] : [];
}

/**
 * Tokenizes one continuity fact surface into bounded lower-case comparison terms.
 *
 * @param value - Freeform fact key/value surface.
 * @returns Ordered lowercase lexical terms.
 */
function tokenizeRelationshipContinuityTerms(value: string): readonly string[] {
  return extractContextualRecallTerms(normalizeWhitespace(value));
}

/**
 * Returns one bounded fact list from either structured or flat continuity results.
 *
 * @param supportingFacts - Continuity result under adaptation.
 * @returns Flat ordered fact records.
 */
function toRelationshipContinuityFacts(
  supportingFacts: readonly ConversationContinuityFactRecord[] | ConversationContinuityFactResult
): readonly ConversationContinuityFactRecord[] {
  return Array.from(supportingFacts);
}

/**
 * Builds one small follow-up cue line when the user asked about a short remembered detail that the
 * temporal split view does not surface directly.
 *
 * @param supportingFacts - Continuity fact result already selected for this turn.
 * @param currentTerms - Current user-input meaning terms.
 * @param synthesisLines - Existing split-view support lines.
 * @returns Bounded extra cue lines for the prompt.
 */
function buildRelationshipFollowUpCueLines(
  supportingFacts: readonly ConversationContinuityFactRecord[] | ConversationContinuityFactResult,
  currentTerms: readonly string[],
  synthesisLines: readonly string[]
): readonly string[] {
  if (currentTerms.length === 0) {
    return [];
  }
  const currentTermSet = new Set(currentTerms.map((term) => term.toLowerCase()));
  const synthesisSurface = synthesisLines.join(" ").toLowerCase();
  const candidateCues = toRelationshipContinuityFacts(supportingFacts)
    .map((fact) => {
      const cue = normalizeWhitespace(fact.value);
      if (!cue || synthesisSurface.includes(cue.toLowerCase())) {
        return null;
      }
      const cueTerms = tokenizeRelationshipContinuityTerms(`${fact.key} ${cue}`);
      const overlapTerms = cueTerms.filter((term) => currentTermSet.has(term));
      if (overlapTerms.length === 0) {
        return null;
      }
      const contextFact = /^contact\.[^.]+\.context\./i.test(fact.key);
      return {
        cue,
        score: overlapTerms.length,
        contextFact
      };
    })
    .filter((entry): entry is { cue: string; score: number; contextFact: boolean } => entry !== null)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      if (left.contextFact !== right.contextFact) {
        return left.contextFact ? -1 : 1;
      }
      return right.cue.length - left.cue.length;
    });

  if (candidateCues.length === 0) {
    return [];
  }
  return [`- Follow-up cues: ${candidateCues.slice(0, 2).map((entry) => entry.cue).join("; ")}`];
}

/**
 * Returns whether the current turn should consult bounded relationship continuity instead of relying
 * only on the last raw turns.
 *
 * @param session - Conversation session containing recent turns.
 * @param userInput - Raw current user wording.
 * @returns `true` when bounded relationship continuity should be queried.
 */
export function shouldUseRelationshipContinuityContext(
  session: ConversationSession,
  userInput: string
): boolean {
  const normalizedInput = normalizeWhitespace(userInput);
  if (!normalizedInput) {
    return false;
  }
  return (
    isRelationshipConversationRecallTurn(normalizedInput) ||
    hasConversationalProfileUpdateSignal(normalizedInput) ||
    hasRecentMemorySubjectFollowUpContext(session, normalizedInput)
  );
}

/**
 * Builds one bounded relationship-memory continuity block for the ordinary direct-chat prompt.
 *
 * @param session - Conversation session containing recent turns and stack state.
 * @param userInput - Raw current user wording.
 * @param queryContinuityFacts - Optional bounded continuity fact query capability.
 * @param requestTelemetry - Optional request-scoped telemetry collector.
 * @returns Prompt block, or `null` when no relationship continuity should be attached.
 */
export async function buildRelationshipContinuityContextBlock(
  session: ConversationSession,
  userInput: string,
  queryContinuityFacts?: QueryConversationContinuityFacts,
  requestTelemetry?: ProfileMemoryRequestTelemetry
): Promise<string | null> {
  if (
    typeof queryContinuityFacts !== "function" ||
    !shouldUseRelationshipContinuityContext(session, userInput)
  ) {
    return null;
  }
  const normalizedInput = normalizeWhitespace(userInput);
  const signals = analyzeConversationChatTurnSignals(normalizedInput);
  const recentFollowUpHints = collectRecentMemorySubjectFollowUpHints(
    session,
    normalizedInput
  );
  const entityHints = (
    recentFollowUpHints.length > 0
      ? recentFollowUpHints
      : signals.meaningfulTerms
  ).slice(0, 6);
  if (entityHints.length === 0) {
    return null;
  }

  const supportingFacts = await queryContinuityFacts({
    stack: resolveConversationStack(session),
    entityHints,
    semanticMode: "relationship_inventory",
    relevanceScope: "conversation_local",
    maxFacts: 4
  }).catch(() => []);
  const structuredSupportingFacts = ensureStructuredContinuityFactResult(supportingFacts, {
    semanticMode: "relationship_inventory",
    relevanceScope: "conversation_local"
  });
  const synthesis = buildRecallSynthesis(
    structuredSupportingFacts.temporalSynthesis,
    [],
    structuredSupportingFacts.map(toMemorySynthesisFactRecord)
  );
  if (!synthesis) {
    return null;
  }

  const synthesisLines = renderRecallSynthesisSupportLines(synthesis);
  if (synthesisLines.length === 0) {
    return null;
  }
  const followUpCueLines = recentFollowUpHints.length > 0
    ? buildRelationshipFollowUpCueLines(
        supportingFacts,
        signals.meaningfulTerms,
        synthesisLines
      )
    : [];

  recordProfileMemorySynthesisOperation(requestTelemetry);
  recordProfileMemoryRenderOperation(requestTelemetry);
  return [
    "Relationship memory continuity:",
    ...synthesisLines,
    ...followUpCueLines,
    "- Use this bounded continuity only if it helps answer the current ordinary-chat question naturally.",
    "- Do not leak these internal labels verbatim in the final reply."
  ].join("\n");
}
