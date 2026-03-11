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
import { renderSkillInventory } from "../../organs/skillRegistry/skillInspection";

export interface ConversationInvocationResolution {
  reply: string;
  shouldStartWorker: boolean;
}

const NATURAL_SKILL_DISCOVERY_LEAD_PATTERNS: readonly RegExp[] = [
  /\bwhat\b/i,
  /\bwhich\b/i,
  /\bshow\b/i,
  /\blist\b/i,
  /\btell me\b/i
];
const NATURAL_SKILL_DISCOVERY_SUBJECT_PATTERNS: readonly RegExp[] = [
  /\bskills?\b/i,
  /\btools?\b/i
];
const NATURAL_SKILL_DISCOVERY_INVENTORY_PATTERNS: readonly RegExp[] = [
  /\bavailable\b/i,
  /\bhave\b/i,
  /\bknow\b/i,
  /\breusable\b/i,
  /\btrust\b/i,
  /\balready\b/i
];

/**
 * Returns `true` when the inbound non-command message is clearly asking for the canonical skill
 * inventory in natural language.
 *
 * @param value - Raw inbound user text before queue routing.
 * @returns `true` when the text looks like an explicit skill/tool inventory request.
 */
function isNaturalSkillDiscoveryRequest(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  const hasLead = NATURAL_SKILL_DISCOVERY_LEAD_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasSubject = NATURAL_SKILL_DISCOVERY_SUBJECT_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasInventoryCue = NATURAL_SKILL_DISCOVERY_INVENTORY_PATTERNS.some((pattern) => pattern.test(normalized));
  return hasLead && hasSubject && hasInventoryCue;
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

  if (deps.listAvailableSkills && isNaturalSkillDiscoveryRequest(trimmed)) {
    return {
      reply: renderSkillInventory(await deps.listAvailableSkills()),
      shouldStartWorker: false
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

