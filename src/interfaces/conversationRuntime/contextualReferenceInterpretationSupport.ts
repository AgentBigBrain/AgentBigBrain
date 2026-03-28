/**
 * @fileoverview Shared bounded eligibility and validation helpers for contextual-reference interpretation inside conversation runtime.
 */

import { classifyRoutingIntentV1 } from "../routingMap";
import type { ConversationSession } from "../sessionStore";
import type { ConversationStackV1 } from "../../core/types";
import {
  routeContextualReferenceInterpretationModel
} from "../../organs/languageUnderstanding/localIntentModelRouter";
import type {
  ContextualReferenceInterpretationKind,
  ContextualReferenceInterpretationResolver
} from "../../organs/languageUnderstanding/localIntentModelContracts";
import type {
  ContextualReferenceResolution
} from "../../organs/languageUnderstanding/contextualReferenceResolution";
import { analyzeConversationChatTurnSignals } from "./chatTurnSignals";
import { buildLocalIntentSessionHints } from "./conversationRoutingSupport";
import { normalizeWhitespace } from "../conversationManagerHelpers";

const MAX_CONTEXTUAL_REFERENCE_INTERPRETATION_INPUT_CHARS = 240;
const MAX_CONTEXTUAL_REFERENCE_RECENT_TURNS = 4;
const MAX_CONTEXTUAL_REFERENCE_PAUSED_THREADS = 3;

export interface InterpretedContextualReferenceHints {
  kind: ContextualReferenceInterpretationKind;
  entityHints: readonly string[];
  topicHints: readonly string[];
  explanation: string;
}

/**
 * Returns whether a bounded contextual-reference interpretation attempt is justified for the
 * current turn.
 *
 * **Why it exists:**
 * The shared local model should only run on the narrow ambiguous band where contextual recall is
 * plausible but deterministic hint extraction is still weak.
 *
 * **What it talks to:**
 * - Uses `classifyRoutingIntentV1` from `../routingMap`.
 * - Uses `analyzeConversationChatTurnSignals` from `./chatTurnSignals`.
 * - Uses local constants/helpers within this module.
 *
 * @param userInput - Raw current user wording.
 * @param session - Conversation session providing nearby turn context.
 * @param stack - Resolved Stage 6.86 conversation stack.
 * @param resolvedReference - Deterministic contextual-reference result for the same turn.
 * @returns `true` when the local contextual-reference interpreter may be consulted.
 */
export function shouldAttemptContextualReferenceInterpretation(
  userInput: string,
  session: ConversationSession,
  stack: ConversationStackV1,
  resolvedReference: ContextualReferenceResolution
): boolean {
  const normalizedInput = normalizeWhitespace(userInput);
  if (!normalizedInput || normalizedInput.includes("\n")) {
    return false;
  }
  if (normalizedInput.length > MAX_CONTEXTUAL_REFERENCE_INTERPRETATION_INPUT_CHARS) {
    return false;
  }
  if (resolvedReference.directTerms.length >= 2 && resolvedReference.resolvedHints.length >= 2) {
    return false;
  }
  const routingClassification = classifyRoutingIntentV1(normalizedInput);
  if (
    routingClassification.routeType === "execution_surface" &&
    routingClassification.commandIntent !== null
  ) {
    return false;
  }
  const signals = analyzeConversationChatTurnSignals(normalizedInput);
  if (
    signals.primaryKind === "workflow_candidate" ||
    signals.primaryKind === "approval_or_control" ||
    signals.primaryKind === "self_identity_query" ||
    signals.primaryKind === "self_identity_statement" ||
    signals.primaryKind === "assistant_identity_query"
  ) {
    return false;
  }
  if (!resolvedReference.hasRecallCue && signals.actionability !== "recall_only") {
    return false;
  }
  const hasPausedThreadContext = stack.threads.some((thread) => thread.state === "paused");
  const hasOpenLoopContext = stack.threads.some((thread) =>
    thread.openLoops.some((loop) => loop.status === "open")
  );
  if (!hasPausedThreadContext && !hasOpenLoopContext) {
    return false;
  }
  return session.conversationTurns.length > 0;
}

/**
 * Resolves validated model-assisted contextual hints for one ambiguous recall turn.
 *
 * **Why it exists:**
 * This helper centralizes request shaping, bounded context selection, and fail-closed acceptance
 * rules so contextual-recall callers do not duplicate model plumbing.
 *
 * **What it talks to:**
 * - Uses `routeContextualReferenceInterpretationModel` from `../../organs/languageUnderstanding/localIntentModelRouter`.
 * - Uses `buildLocalIntentSessionHints` from `./conversationRoutingSupport`.
 * - Uses local constants/helpers within this module.
 *
 * @param session - Conversation session providing nearby turn context.
 * @param stack - Resolved Stage 6.86 conversation stack.
 * @param userInput - Raw current user wording.
 * @param resolvedReference - Deterministic contextual-reference result for the same turn.
 * @param resolver - Optional contextual-reference interpreter.
 * @returns Validated model-assisted contextual hints, or `null` when the model should not be used.
 */
export async function resolveInterpretedContextualReferenceHints(
  session: ConversationSession,
  stack: ConversationStackV1,
  userInput: string,
  resolvedReference: ContextualReferenceResolution,
  resolver?: ContextualReferenceInterpretationResolver
): Promise<InterpretedContextualReferenceHints | null> {
  if (
    !resolver ||
    !shouldAttemptContextualReferenceInterpretation(
      userInput,
      session,
      stack,
      resolvedReference
    )
  ) {
    return null;
  }

  const interpretation = await routeContextualReferenceInterpretationModel(
    {
      userInput: normalizeWhitespace(userInput),
      routingClassification: classifyRoutingIntentV1(userInput),
      sessionHints: buildLocalIntentSessionHints(session),
      recentTurns: session.conversationTurns
        .slice(-MAX_CONTEXTUAL_REFERENCE_RECENT_TURNS)
        .map((turn) => ({
          role: turn.role,
          text: normalizeWhitespace(turn.text)
        })),
      pausedThreads: stack.threads
        .filter((thread) => thread.state === "paused")
        .sort((left, right) => right.lastTouchedAt.localeCompare(left.lastTouchedAt))
        .slice(0, MAX_CONTEXTUAL_REFERENCE_PAUSED_THREADS)
        .map((thread) => ({
          topicLabel: thread.topicLabel,
          resumeHint: thread.resumeHint,
          openLoopCount: thread.openLoops.filter((loop) => loop.status === "open").length,
          lastTouchedAt: thread.lastTouchedAt
        })),
      deterministicHints: resolvedReference.resolvedHints
    },
    resolver
  );

  if (
    !interpretation ||
    interpretation.confidence === "low" ||
    interpretation.kind === "non_contextual_reference" ||
    interpretation.kind === "uncertain"
  ) {
    return null;
  }
  if (interpretation.entityHints.length === 0 && interpretation.topicHints.length === 0) {
    return null;
  }

  return {
    kind: interpretation.kind,
    entityHints: interpretation.entityHints,
    topicHints: interpretation.topicHints,
    explanation: interpretation.explanation
  };
}
