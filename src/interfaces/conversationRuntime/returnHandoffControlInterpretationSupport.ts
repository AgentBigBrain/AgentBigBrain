/**
 * @fileoverview Shared bounded eligibility and promotion helpers for model-assisted return-handoff control interpretation.
 */

import type { RoutingMapClassificationV1 } from "../routingMap";
import type { ConversationSession } from "../sessionStore";
import type { ResolvedConversationIntentMode } from "./intentModeContracts";
import {
  routeHandoffControlInterpretationModel
} from "../../organs/languageUnderstanding/localIntentModelRouter";
import type {
  HandoffControlInterpretationResolver,
  HandoffControlInterpretationSignal
} from "../../organs/languageUnderstanding/localIntentModelContracts";
import {
  analyzeConversationChatTurnSignals,
  buildRecentIdentityInterpretationContext,
  shouldPreserveDeterministicDirectChatTurn
} from "./chatTurnSignals";
import { buildLocalIntentSessionHints } from "./conversationRoutingSupport";
import { normalizeWhitespace } from "../conversationManagerHelpers";

const MAX_HANDOFF_CONTROL_INTERPRETATION_CHARS = 180;
const MAX_HANDOFF_CONTROL_RECENT_TURNS = 4;

/**
 * Returns whether a bounded handoff-control interpretation attempt is justified for the current
 * turn after deterministic pause/review fast paths failed.
 *
 * @param session - Current conversation session containing durable handoff or active-autonomous context.
 * @param userInput - Raw inbound user wording.
 * @param resolvedIntentMode - Canonical pre-promotion intent result.
 * @returns `true` when the optional handoff-control interpreter may be consulted.
 */
export function shouldAttemptHandoffControlInterpretation(
  session: ConversationSession,
  userInput: string,
  resolvedIntentMode: ResolvedConversationIntentMode
): boolean {
  if (resolvedIntentMode.clarification || resolvedIntentMode.semanticHint) {
    return false;
  }
  if (
    resolvedIntentMode.mode === "autonomous" ||
    resolvedIntentMode.mode === "review" ||
    resolvedIntentMode.mode === "discover_available_capabilities"
  ) {
    return false;
  }

  const normalized = normalizeWhitespace(userInput);
  if (!normalized || normalized.includes("\n")) {
    return false;
  }
  if (normalized.length > MAX_HANDOFF_CONTROL_INTERPRETATION_CHARS) {
    return false;
  }
  if (!session.returnHandoff && !session.runningJobId) {
    return false;
  }
  const recentIdentityContext = buildRecentIdentityInterpretationContext(
    session.conversationTurns.slice(-4)
  );
  if (shouldPreserveDeterministicDirectChatTurn(normalized, recentIdentityContext)) {
    return false;
  }

  const signals = analyzeConversationChatTurnSignals(normalized);
  if (
    signals.primaryKind === "approval_or_control" ||
    signals.primaryKind === "self_identity_query" ||
    signals.primaryKind === "self_identity_statement" ||
    signals.primaryKind === "assistant_identity_query"
  ) {
    return false;
  }
  return true;
}

/**
 * Resolves one validated handoff-control interpretation signal for ambiguous pause/review turns.
 *
 * @param session - Current conversation session carrying durable handoff context.
 * @param userInput - Raw inbound user wording.
 * @param resolvedIntentMode - Canonical pre-promotion intent result.
 * @param resolver - Optional handoff-control interpreter.
 * @param routingClassification - Deterministic routing hint for the same turn.
 * @returns Validated interpreted signal, or `null` when no model-assisted control promotion should occur.
 */
export async function resolveInterpretedHandoffControlSignal(
  session: ConversationSession,
  userInput: string,
  resolvedIntentMode: ResolvedConversationIntentMode,
  resolver?: HandoffControlInterpretationResolver,
  routingClassification: RoutingMapClassificationV1 | null = null
): Promise<HandoffControlInterpretationSignal | null> {
  if (
    !resolver ||
    !shouldAttemptHandoffControlInterpretation(session, userInput, resolvedIntentMode)
  ) {
    return null;
  }
  const interpretation = await routeHandoffControlInterpretationModel(
    {
      userInput: normalizeWhitespace(userInput),
      routingClassification,
      sessionHints: buildLocalIntentSessionHints(session),
      recentTurns: session.conversationTurns.slice(-MAX_HANDOFF_CONTROL_RECENT_TURNS).map((turn) => ({
        role: turn.role,
        text: normalizeWhitespace(turn.text)
      }))
    },
    resolver
  );
  if (
    !interpretation ||
    interpretation.confidence === "low" ||
    interpretation.kind === "non_handoff_control" ||
    interpretation.kind === "uncertain"
  ) {
    return null;
  }
  return interpretation;
}

/**
 * Converts a validated handoff-control interpretation into the existing intent-mode/semantic-hint
 * contract used by inline status rendering.
 *
 * @param signal - Validated interpreted handoff-control signal.
 * @returns Promoted status intent, or `null` when the signal is a pause-only request.
 */
export function buildHandoffControlInterpretationResolution(
  signal: HandoffControlInterpretationSignal | null
): ResolvedConversationIntentMode | null {
  if (!signal) {
    return null;
  }
  switch (signal.kind) {
    case "review_request":
      return {
        mode: "status_or_recall",
        confidence: signal.confidence === "high" ? "high" : "medium",
        matchedRuleId: "intent_mode_return_handoff_review_local_interpretation",
        explanation: signal.explanation,
        clarification: null,
        semanticHint: "review_ready"
      };
    case "guided_review_request":
      return {
        mode: "status_or_recall",
        confidence: signal.confidence === "high" ? "high" : "medium",
        matchedRuleId: "intent_mode_return_handoff_guided_review_local_interpretation",
        explanation: signal.explanation,
        clarification: null,
        semanticHint: "guided_review"
      };
    case "while_away_review_request":
      return {
        mode: "status_or_recall",
        confidence: signal.confidence === "high" ? "high" : "medium",
        matchedRuleId: "intent_mode_return_handoff_while_away_local_interpretation",
        explanation: signal.explanation,
        clarification: null,
        semanticHint: "while_away_review"
      };
    default:
      return null;
  }
}
