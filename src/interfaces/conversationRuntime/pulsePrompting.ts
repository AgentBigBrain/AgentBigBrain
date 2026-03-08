/**
 * @fileoverview Canonical prompt and relationship-context builders for Agent Pulse.
 */

import type { AgentPulseReason } from "../../core/agentPulse";
import type { AgentPulseEvaluationResult } from "../../core/profileMemoryStore";
import type { EntityGraphV1, PulseCandidateV1, PulseReasonCodeV1 } from "../../core/types";
import type { PulseEmissionRecordV1 } from "../../core/stage6_86PulseCandidates";
import type { ResolvedUserLocalTime } from "./sessionPulseMetadata";
import type { ConversationSession } from "../sessionStore";
import type { ContextualFollowupCandidate } from "./pulseContextualFollowup";

const DYNAMIC_PULSE_INTENT_DIRECTIVES: Record<PulseReasonCodeV1, string> = {
  OPEN_LOOP_RESUME:
    "Something was left unfinished in conversation. Bring it back up if it feels right.",
  RELATIONSHIP_CLARIFICATION:
    "Only ask about the connection if a specific recent topic clearly grounds it. Ask one concrete, low-pressure question rather than sending a generic check-in.",
  TOPIC_DRIFT_RESUME:
    "A conversation drifted away from something that seemed important. See if they want to revisit.",
  STALE_FACT_REVALIDATION:
    "Something you know might be outdated. Check in about it casually.",
  USER_REQUESTED_FOLLOWUP:
    "They asked you to follow up on this. Now's a good time.",
  SAFETY_HOLD: ""
};

const DYNAMIC_PULSE_MAX_CONTEXT_TURNS = 8;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export interface DynamicPulsePromptContext {
  nowIso: string;
  userLocalTime: ResolvedUserLocalTime;
  conversationalGapMs: number;
  relationshipAgeDays: number;
  previousPulseOutcomes: readonly PulseEmissionRecordV1[];
  userStyleFingerprint: string;
}

/**
 * Formats a conversational gap into a short human-readable string.
 */
function formatConversationalGap(gapMs: number): string {
  if (gapMs < MS_PER_MINUTE) return "just now";
  if (gapMs < MS_PER_HOUR) return `${Math.round(gapMs / MS_PER_MINUTE)} minutes`;
  if (gapMs < MS_PER_DAY) return `${Math.round(gapMs / MS_PER_HOUR)} hours`;
  return `${Math.round(gapMs / MS_PER_DAY)} days`;
}

/**
 * Builds the legacy governed pulse prompt for the selected reason.
 */
export function buildPulsePrompt(
  session: ConversationSession,
  reason: AgentPulseReason,
  evaluation: AgentPulseEvaluationResult,
  mode: ConversationSession["agentPulse"]["mode"],
  contextualCandidate: ContextualFollowupCandidate | null
): string {
  const contextDriftDomains =
    evaluation.contextDrift.domains.length > 0
      ? evaluation.contextDrift.domains.join(", ")
      : "none";
  const relationshipLine = `Relationship role taxonomy: ${evaluation.relationship.role}`;
  const contextDriftLine =
    `Context drift: detected=${evaluation.contextDrift.detected}; ` +
    `domains=${contextDriftDomains}; ` +
    `requiresRevalidation=${evaluation.contextDrift.requiresRevalidation}`;
  const revalidationDirective = evaluation.contextDrift.requiresRevalidation
    ? "Ask one concise revalidation question before making assumptions."
    : "Use a normal concise follow-up question.";

  if (mode === "public") {
    return [
      "Agent Pulse proactive check-in request.",
      "Delivery mode: public",
      `Target user: ${session.username}`,
      `Reason code: ${reason}`,
      relationshipLine,
      contextDriftLine,
      "Generate one concise, friendly, generic check-in message in natural language.",
      "Be truthful that you are an AI assistant only if that identity is directly relevant, and do not prepend labels like 'AI assistant response' or 'AI assistant check-in'.",
      "Do not mention profile facts, unresolved commitments, or personal details.",
      reason === "contextual_followup"
        ? "Contextual follow-up nudge is enabled. Keep it generic in public mode."
        : "No contextual side-thread follow-up detail is required for this reason.",
      revalidationDirective,
      "Do not impersonate a human."
    ].join("\n");
  }

  const reasonExplanationByCode: Record<AgentPulseReason, string> = {
    stale_fact_revalidation:
      "Older profile facts appear stale and should be reconfirmed.",
    unresolved_commitment:
      "There is at least one unresolved commitment signal worth following up.",
    user_requested_followup:
      "User explicitly requested a proactive follow-up.",
    contextual_followup:
      "Recent conversation context indicates a bounded side-thread follow-up is appropriate."
  };
  const unresolvedTopicsLine =
    reason === "unresolved_commitment"
      ? `Unresolved commitment topics: ${evaluation.unresolvedCommitmentTopics.length > 0
        ? evaluation.unresolvedCommitmentTopics.join("; ")
        : "unspecified"}`
      : null;
  const unresolvedTopicsDirective =
    reason === "unresolved_commitment"
      ? "If you mention unresolved commitments, focus only on the listed topics and avoid unrelated recent topics."
      : null;
  const relevantEpisodesLine =
    evaluation.relevantEpisodes.length > 0 &&
    (reason === "contextual_followup" || reason === "user_requested_followup")
      ? `Relevant unresolved situations: ${evaluation.relevantEpisodes
        .map((episode) => `${episode.title} (${episode.status}; ${episode.ageDays}d old)`)
        .join("; ")}`
      : null;
  const contextualLines =
    reason === "contextual_followup" && contextualCandidate
      ? [
        "Contextual follow-up nudge: enabled.",
        `Contextual candidate tokens: ${contextualCandidate.topicTokens.join(", ") || "none"}`,
        `Contextual lexical confidence: ${contextualCandidate.lexicalClassification.confidence.toFixed(2)}`,
        `Contextual topic key (derived): ${contextualCandidate.topicKey ?? "unknown"}`,
        `Topic linkage confidence: ${contextualCandidate.linkageConfidence.toFixed(2)}`,
        `Side-thread linkage: ${contextualCandidate.sideThreadLinkage ? "present" : "absent"}`,
        `Revalidation-required follow-up: ${evaluation.contextDrift.requiresRevalidation ? "yes" : "no"}`,
        "Contextual-follow-up cooldown is active per topic to avoid repetitive nudges."
      ]
      : [];
  return [
    "Agent Pulse proactive check-in request.",
    `Target user: ${session.username}`,
    `Reason code: ${reason}`,
    `Reason explanation: ${reasonExplanationByCode[reason]}`,
    relationshipLine,
    contextDriftLine,
    `Signal counts: staleFactCount=${evaluation.staleFactCount}, unresolvedCommitmentCount=${evaluation.unresolvedCommitmentCount}`,
    ...(unresolvedTopicsLine ? [unresolvedTopicsLine] : []),
    ...(unresolvedTopicsDirective ? [unresolvedTopicsDirective] : []),
    ...(relevantEpisodesLine ? [relevantEpisodesLine] : []),
    ...contextualLines,
    "Generate one concise, friendly follow-up message in natural language.",
    "Be truthful that you are an AI assistant only if that identity is directly relevant, and do not prepend labels like 'AI assistant response' or 'AI assistant check-in'.",
    revalidationDirective,
    "Do not impersonate a human."
  ].join("\n");
}

/**
 * Builds the Stage 6.86 dynamic pulse prompt from the candidate and recent context.
 */
export function buildDynamicPulsePrompt(
  candidate: PulseCandidateV1,
  session: ConversationSession,
  mode: ConversationSession["agentPulse"]["mode"],
  context?: DynamicPulsePromptContext
): string {
  const recentTurns = (session.conversationTurns ?? [])
    .slice(-DYNAMIC_PULSE_MAX_CONTEXT_TURNS)
    .map((turn) => `[${turn.role}] ${turn.text.slice(0, 300)}`)
    .join("\n");

  const intent = DYNAMIC_PULSE_INTENT_DIRECTIVES[candidate.reasonCode] || "";
  const scoreTotal = candidate.score.toFixed(2);
  const { recency, frequency, unresolvedImportance } = candidate.scoreBreakdown;

  const entityList = candidate.entityRefs.length > 0
    ? candidate.entityRefs.join(", ")
    : "(none)";
  const evidenceList = candidate.evidenceRefs.length > 0
    ? candidate.evidenceRefs.join(", ")
    : "(none)";

  const visibilityNote = mode === "public"
    ? "This is a public channel. Keep it brief and avoid anything sensitive."
    : "This is a private conversation.";

  const scoreGuidance = candidate.score >= 0.6
    ? "The signal is strong -- you can be fairly direct."
    : candidate.score >= 0.35
      ? "The signal is moderate -- bring it up naturally, like a passing thought."
      : "The signal is weak -- only mention it if it flows naturally. A subtle nudge at most.";

  const naturalnessSections: string[] = [];
  if (context) {
    naturalnessSections.push("");
    naturalnessSections.push("--- Situation awareness ---");
    naturalnessSections.push(`Time since last user message: ${formatConversationalGap(context.conversationalGapMs)}`);
    naturalnessSections.push(`User's local time: ${context.userLocalTime.formatted}`);

    if (context.relationshipAgeDays < 7) {
      naturalnessSections.push(
        `You have been working with this user for ${Math.round(context.relationshipAgeDays)} day(s). This is a new relationship -- be more tentative.`
      );
    } else if (context.relationshipAgeDays > 90) {
      naturalnessSections.push(
        `You have been working with this user for ${Math.round(context.relationshipAgeDays)} days. You know each other well -- be natural.`
      );
    } else {
      naturalnessSections.push(
        `You have been working with this user for ${Math.round(context.relationshipAgeDays)} days.`
      );
    }

    const outcomes = context.previousPulseOutcomes;
    if (outcomes.length > 0) {
      const engaged = outcomes.filter((e) => e.responseOutcome === "engaged").length;
      const ignored = outcomes.filter((e) => e.responseOutcome === "ignored").length;
      const dismissed = outcomes.filter((e) => e.responseOutcome === "dismissed").length;
      naturalnessSections.push(
        `Of your last ${outcomes.length} pulses, ${engaged} engaged, ${ignored} ignored, ${dismissed} dismissed.`
      );
      if (ignored + dismissed > engaged) {
        naturalnessSections.push(
          "The user hasn't been responding to proactive messages. Only reach out if this is genuinely important."
        );
      }
    }

    const recentSnippets = outcomes
      .filter((e) => e.generatedSnippet)
      .slice(-3)
      .map((e) => e.generatedSnippet!);
    if (recentSnippets.length > 0) {
      naturalnessSections.push(
        `Your recent pulse messages were:\n${recentSnippets.map((snippet) => `- "${snippet}"`).join("\n")}`
      );
    }

    if (context.userStyleFingerprint && context.userStyleFingerprint !== "unknown style") {
      naturalnessSections.push(`User communication style: ${context.userStyleFingerprint}`);
    }
  }

  return [
    "You are a personal AI assistant. You are not human, but you communicate warmly and naturally. Never claim to be human.",
    "",
    `User: ${session.username}`,
    visibilityNote,
    "",
    "--- Recent conversation ---",
    recentTurns || "(no recent conversation)",
    "",
    "--- What caught your attention ---",
    `Signal type: ${candidate.reasonCode}`,
    `Related to: ${entityList}`,
    `Evidence: ${evidenceList}`,
    candidate.threadKey ? `Thread: ${candidate.threadKey}` : "",
    `Score: ${scoreTotal} (recency=${recency.toFixed(2)}, frequency=${frequency.toFixed(2)}, importance=${unresolvedImportance.toFixed(2)})`,
    scoreGuidance,
    "",
    `Intent: ${intent}`,
    ...naturalnessSections,
    "",
    "--- How to respond ---",
    "Be concise -- one or two sentences, not a paragraph.",
    "Match the energy of recent conversation. If things have been casual, stay casual.",
    "Only send this if you can give one concrete reason the user would care right now.",
    "Never repeat a message you've already sent. If you've asked about this before, find a new angle.",
    "Do not explain why you're bringing this up. No 'I noticed that...' or 'My records show...'.",
    "Do not prepend labels like 'AI assistant response', 'AI assistant check-in', or similar identity headers.",
    "Do not write generic filler like 'AI assistant check-in', 'just checking in', 'here if you need anything', 'want to chat', or 'need a hand with anything'.",
    "Do not impersonate a human.",
    "Temperature hint: 0.65"
  ].filter(Boolean).join("\n");
}

/**
 * Computes relationship age in days from entity-graph or turn history.
 */
export function computeRelationshipAgeDays(
  graph: EntityGraphV1,
  session: ConversationSession,
  nowMs: number
): number {
  const username = (session.username ?? "").toLowerCase();
  let earliestMs = nowMs;

  if (username) {
    for (const entity of graph.entities) {
      const nameMatch =
        entity.canonicalName.toLowerCase() === username ||
        entity.aliases.some((alias) => alias.toLowerCase() === username);
      if (!nameMatch) {
        continue;
      }
      const seenMs = Date.parse(entity.firstSeenAt);
      if (Number.isFinite(seenMs) && seenMs < earliestMs) {
        earliestMs = seenMs;
      }
    }
  }

  if (earliestMs === nowMs && session.conversationTurns.length > 0) {
    const turnMs = Date.parse(session.conversationTurns[0].at);
    if (Number.isFinite(turnMs) && turnMs < earliestMs) {
      earliestMs = turnMs;
    }
  }

  return Math.max(0, (nowMs - earliestMs) / MS_PER_DAY);
}
