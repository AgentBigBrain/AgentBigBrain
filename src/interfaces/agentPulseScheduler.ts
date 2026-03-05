/**
 * @fileoverview Runs deterministic Agent Pulse evaluations for opted-in interface sessions and enqueues governed proactive check-ins.
 */

import { AgentPulseDecision, AgentPulseReason } from "../core/agentPulse";
import {
  AgentPulseEvaluationRequest,
  AgentPulseEvaluationResult
} from "../core/profileMemoryStore";
import {
  ConversationSession,
  ConversationTurn,
  InterfaceSessionStore,
  computeUserStyleFingerprint,
  resolveUserLocalTime,
  ResolvedUserLocalTime
} from "./sessionStore";
import {
  classifyContextualFollowupLexicalCue,
  ContextualFollowupLexicalClassification
} from "./contextualFollowupLexicalClassifier";
import { EntityGraphV1, PulseCandidateV1, PulseReasonCodeV1 } from "../core/types";
import {
  evaluatePulseCandidatesV1,
  PulseEmissionRecordV1
} from "../core/stage6_86PulseCandidates";
import { buildConversationStackFromTurnsV1 } from "../core/stage6_86ConversationStack";

export interface AgentPulseStateUpdate {
  optIn?: boolean;
  mode?: ConversationSession["agentPulse"]["mode"];
  routeStrategy?: ConversationSession["agentPulse"]["routeStrategy"];
  lastPulseSentAt?: string | null;
  lastPulseReason?: string | null;
  lastPulseTargetConversationId?: string | null;
  lastDecisionCode?: ConversationSession["agentPulse"]["lastDecisionCode"];
  lastEvaluatedAt?: string | null;
  lastContextualLexicalEvidence?: ConversationSession["agentPulse"]["lastContextualLexicalEvidence"];
  updatedAt?: string;
  newEmission?: PulseEmissionRecordV1;
}

export interface AgentPulseSchedulerDeps {
  provider: "telegram" | "discord";
  sessionStore: InterfaceSessionStore;
  evaluateAgentPulse: (
    request: AgentPulseEvaluationRequest
  ) => Promise<AgentPulseEvaluationResult>;
  enqueueSystemJob: (
    session: ConversationSession,
    systemInput: string,
    receivedAt: string
  ) => Promise<boolean>;
  updatePulseState: (
    conversationKey: string,
    update: AgentPulseStateUpdate
  ) => Promise<void>;
  enableDynamicPulse?: boolean;
  getEntityGraph?: () => Promise<EntityGraphV1>;
}

export interface AgentPulseSchedulerConfig {
  tickIntervalMs: number;
  reasonPriority: AgentPulseReason[];
}

const DEFAULT_AGENT_PULSE_SCHEDULER_CONFIG: AgentPulseSchedulerConfig = {
  tickIntervalMs: 120_000,
  reasonPriority: ["unresolved_commitment", "stale_fact_revalidation", "contextual_followup"]
};

interface ContextualFollowupCandidate {
  eligible: boolean;
  topicKey: string | null;
  topicSummary: string | null;
  topicTokens: readonly string[];
  linkageConfidence: number;
  sideThreadLinkage: boolean;
  suppressionCode: AgentPulseDecision["decisionCode"] | null;
  nextEligibleAtIso: string | null;
  lexicalClassification: ContextualFollowupLexicalClassification;
}

const CONTEXTUAL_FOLLOWUP_MIN_CONFIDENCE = 0.7;
const CONTEXTUAL_FOLLOWUP_SIGNAL_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const CONTEXTUAL_FOLLOWUP_TOPIC_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Constrains and sanitizes confidence to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for confidence before data flows to policy checks.
 *
 * **What it talks to:**
 * - Local numeric guards only.
 *
 * @param value - Primary input consumed by this function.
 * @returns Numeric result used by downstream logic.
 */
function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

/**
 * Normalizes text for tokenization into a stable shape for `agentPulseScheduler` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for text for tokenization so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @returns Resulting string value.
 */
function normalizeTextForTokenization(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalizes ordering and duplication for turns by timestamp.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for turns by timestamp in one place.
 *
 * **What it talks to:**
 * - Uses `ConversationTurn` (import `ConversationTurn`) from `./sessionStore`.
 *
 * @param turns - Conversation turns to sort chronologically.
 * @returns Ordered collection produced by this step.
 */
function sortTurnsByTimestamp(turns: ConversationTurn[]): ConversationTurn[] {
  return [...turns].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

/**
 * Finds latest contextual anchor from available runtime state.
 *
 * **Why it exists:**
 * Keeps candidate selection logic for latest contextual anchor centralized so outcomes stay consistent.
 *
 * **What it talks to:**
 * - Uses `classifyContextualFollowupLexicalCue` (import `classifyContextualFollowupLexicalCue`) from `./contextualFollowupLexicalClassifier`.
 * - Uses `ContextualFollowupLexicalClassification` (import `ContextualFollowupLexicalClassification`) from `./contextualFollowupLexicalClassifier`.
 * - Uses `ConversationTurn` (import `ConversationTurn`) from `./sessionStore`.
 *
 * @param turns - Value for turns.
 * @returns Computed `{ anchor: ConversationTurn; index: number; lexicalClassification: ContextualFollowupLexicalClassification } | null` result.
 */
function findLatestContextualAnchor(
  turns: ConversationTurn[]
): { anchor: ConversationTurn; index: number; lexicalClassification: ContextualFollowupLexicalClassification } | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.role !== "user") {
      continue;
    }
    const lexicalClassification = classifyContextualFollowupLexicalCue(turn.text);
    if (!lexicalClassification.cueDetected && !lexicalClassification.conflict) {
      continue;
    }
    return {
      anchor: turn,
      index,
      lexicalClassification
    };
  }
  return null;
}

/**
 * Builds contextual topic identity for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of contextual topic identity consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param tokens - Token value used for lexical parsing or matching.
 * @returns Computed `{ topicKey: string; topicSummary: string }` result.
 */
function buildContextualTopicIdentity(tokens: string[]): { topicKey: string; topicSummary: string } {
  const sorted = [...tokens].sort();
  const topicKey = sorted.slice(0, 3).join("_");
  const topicSummary = sorted.slice(0, 6).join(" ");
  return {
    topicKey,
    topicSummary
  };
}

/**
 * Resolves linkage signal from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of linkage signal by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `ConversationTurn` (import `ConversationTurn`) from `./sessionStore`.
 *
 * @param topicTokens - Token value used for lexical parsing or matching.
 * @param followingTurns - Value for following turns.
 * @returns Computed `{ sideThreadLinkage: boolean; topicOverlapCount: number }` result.
 */
function resolveLinkageSignal(
  topicTokens: string[],
  followingTurns: ConversationTurn[]
): { sideThreadLinkage: boolean; topicOverlapCount: number } {
  const sideThreadLinkage = followingTurns.length >= 2;
  const normalizedFollowingText = normalizeTextForTokenization(
    followingTurns.map((turn) => turn.text).join(" ")
  );
  const topicOverlapCount = topicTokens.filter((token) => normalizedFollowingText.includes(token))
    .length;
  return {
    sideThreadLinkage,
    topicOverlapCount
  };
}

/**
 * Derives contextual linkage confidence from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps `calculate contextual linkage confidence` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses `clampConfidence` and local scoring heuristics.
 *
 * @param topicTokens - Topic tokens extracted from the contextual anchor.
 * @param sideThreadLinkage - Whether additional follow-up turns indicate an active side thread.
 * @param topicOverlapCount - Numeric bound, counter, or index used by this logic.
 * @returns Numeric result used by downstream logic.
 */
function calculateContextualLinkageConfidence(
  topicTokens: string[],
  sideThreadLinkage: boolean,
  topicOverlapCount: number
): number {
  let score = 0.45;
  if (topicTokens.length >= 2) {
    score += 0.1;
  }
  if (sideThreadLinkage) {
    score += 0.2;
  }
  if (topicOverlapCount > 0) {
    score += 0.25;
  }
  return clampConfidence(score);
}

/**
 * Derives contextual topic key from pulse input from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for contextual topic key from pulse input in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `string | null` result.
 */
function extractContextualTopicKeyFromPulseInput(input: string): string | null {
  const reasonMatch = input.match(/^\s*Reason code:\s*([a-z_]+)/im);
  if (!reasonMatch || reasonMatch[1].trim().toLowerCase() !== "contextual_followup") {
    return null;
  }
  const topicKeyMatch = input.match(/^\s*Contextual topic key(?:\s+\(derived\))?:\s*([a-z0-9_]+)/im);
  if (!topicKeyMatch) {
    return null;
  }
  return topicKeyMatch[1].trim().toLowerCase();
}

/**
 * Resolves contextual topic cooldown from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of contextual topic cooldown by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `ConversationSession` (import `ConversationSession`) from `./sessionStore`.
 *
 * @param session - Value for session.
 * @param topicKey - Lookup key or map field identifier.
 * @param nowMs - Duration value in milliseconds.
 * @returns Computed `string | null` result.
 */
function resolveContextualTopicCooldown(
  session: ConversationSession,
  topicKey: string,
  nowMs: number
): string | null {
  let latestTopicPulseMs: number | null = null;
  const history = [...session.queuedJobs, ...session.recentJobs];
  for (const job of history) {
    const matchedTopicKey = extractContextualTopicKeyFromPulseInput(job.input);
    if (matchedTopicKey !== topicKey) {
      continue;
    }
    const atIso = job.completedAt ?? job.createdAt;
    const atMs = Date.parse(atIso);
    if (!Number.isFinite(atMs)) {
      continue;
    }
    if (latestTopicPulseMs === null || atMs > latestTopicPulseMs) {
      latestTopicPulseMs = atMs;
    }
  }

  if (latestTopicPulseMs === null) {
    return null;
  }
  if (nowMs - latestTopicPulseMs >= CONTEXTUAL_FOLLOWUP_TOPIC_COOLDOWN_MS) {
    return null;
  }
  return new Date(latestTopicPulseMs + CONTEXTUAL_FOLLOWUP_TOPIC_COOLDOWN_MS).toISOString();
}

/**
 * Evaluates contextual followup candidate and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the contextual followup candidate policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `classifyContextualFollowupLexicalCue` (import `classifyContextualFollowupLexicalCue`) from `./contextualFollowupLexicalClassifier`.
 * - Uses `ConversationSession` (import `ConversationSession`) from `./sessionStore`.
 *
 * @param session - Value for session.
 * @param nowIso - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed `ContextualFollowupCandidate` result.
 */
function evaluateContextualFollowupCandidate(
  session: ConversationSession,
  nowIso: string
): ContextualFollowupCandidate {
  const noCueClassification = classifyContextualFollowupLexicalCue("");
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    return {
      eligible: false,
      topicKey: null,
      topicSummary: null,
      topicTokens: [],
      linkageConfidence: 0,
      sideThreadLinkage: false,
      suppressionCode: "NO_CONTEXTUAL_LINKAGE",
      nextEligibleAtIso: null,
      lexicalClassification: noCueClassification
    };
  }

  const turns = sortTurnsByTimestamp(session.conversationTurns);
  const anchor = findLatestContextualAnchor(turns);
  if (!anchor) {
    return {
      eligible: false,
      topicKey: null,
      topicSummary: null,
      topicTokens: [],
      linkageConfidence: 0,
      sideThreadLinkage: false,
      suppressionCode: "NO_CONTEXTUAL_LINKAGE",
      nextEligibleAtIso: null,
      lexicalClassification: noCueClassification
    };
  }

  const anchorAtMs = Date.parse(anchor.anchor.at);
  if (!Number.isFinite(anchorAtMs) || nowMs - anchorAtMs > CONTEXTUAL_FOLLOWUP_SIGNAL_MAX_AGE_MS) {
    return {
      eligible: false,
      topicKey: null,
      topicSummary: null,
      topicTokens: [],
      linkageConfidence: 0,
      sideThreadLinkage: false,
      suppressionCode: "NO_CONTEXTUAL_LINKAGE",
      nextEligibleAtIso: null,
      lexicalClassification: anchor.lexicalClassification
    };
  }

  const topicTokens = [...anchor.lexicalClassification.candidateTokens];
  if (anchor.lexicalClassification.conflict || topicTokens.length === 0) {
    return {
      eligible: false,
      topicKey: null,
      topicSummary: null,
      topicTokens: [],
      linkageConfidence: 0,
      sideThreadLinkage: false,
      suppressionCode: "NO_CONTEXTUAL_LINKAGE",
      nextEligibleAtIso: null,
      lexicalClassification: anchor.lexicalClassification
    };
  }

  const followingTurns = turns.slice(anchor.index + 1);
  const linkageSignal = resolveLinkageSignal(topicTokens, followingTurns);
  const linkageConfidence = calculateContextualLinkageConfidence(
    topicTokens,
    linkageSignal.sideThreadLinkage,
    linkageSignal.topicOverlapCount
  );
  if (linkageConfidence < CONTEXTUAL_FOLLOWUP_MIN_CONFIDENCE) {
    return {
      eligible: false,
      topicKey: null,
      topicSummary: null,
      topicTokens,
      linkageConfidence,
      sideThreadLinkage: linkageSignal.sideThreadLinkage,
      suppressionCode: "NO_CONTEXTUAL_LINKAGE",
      nextEligibleAtIso: null,
      lexicalClassification: anchor.lexicalClassification
    };
  }

  const topicIdentity = buildContextualTopicIdentity(topicTokens);
  const cooldownNextEligibleAtIso = resolveContextualTopicCooldown(
    session,
    topicIdentity.topicKey,
    nowMs
  );
  if (cooldownNextEligibleAtIso) {
    return {
      eligible: false,
      topicKey: topicIdentity.topicKey,
      topicSummary: topicIdentity.topicSummary,
      topicTokens,
      linkageConfidence,
      sideThreadLinkage: linkageSignal.sideThreadLinkage,
      suppressionCode: "CONTEXTUAL_TOPIC_COOLDOWN",
      nextEligibleAtIso: cooldownNextEligibleAtIso,
      lexicalClassification: anchor.lexicalClassification
    };
  }

  return {
    eligible: true,
    topicKey: topicIdentity.topicKey,
    topicSummary: topicIdentity.topicSummary,
    topicTokens,
    linkageConfidence,
    sideThreadLinkage: linkageSignal.sideThreadLinkage,
    suppressionCode: null,
    nextEligibleAtIso: null,
    lexicalClassification: anchor.lexicalClassification
  };
}

/**
 * Builds suppressed evaluation for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of suppressed evaluation consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `AgentPulseDecision` (import `AgentPulseDecision`) from `../core/agentPulse`.
 * - Uses `AgentPulseEvaluationResult` (import `AgentPulseEvaluationResult`) from `../core/profileMemoryStore`.
 *
 * @param decision - Value for decision.
 * @returns Computed `AgentPulseEvaluationResult` result.
 */
function buildSuppressedEvaluation(
  decision: AgentPulseDecision
): AgentPulseEvaluationResult {
  return {
    decision,
    staleFactCount: 0,
    unresolvedCommitmentCount: 0,
    unresolvedCommitmentTopics: [],
    relationship: {
      role: "unknown",
      roleFactId: null
    },
    contextDrift: {
      detected: false,
      domains: [],
      requiresRevalidation: false
    }
  };
}

/**
 * Converts values into contextual lexical evidence form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for contextual lexical evidence deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses `ContextualFollowupLexicalClassification` (import `ContextualFollowupLexicalClassification`) from `./contextualFollowupLexicalClassifier`.
 * - Uses `ConversationSession` (import `ConversationSession`) from `./sessionStore`.
 *
 * @param classification - Value for classification.
 * @param evaluatedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed `NonNullable<ConversationSession["agentPulse"]["lastContextualLexicalEvidence"]>` result.
 */
function toContextualLexicalEvidence(
  classification: ContextualFollowupLexicalClassification,
  evaluatedAt: string
): NonNullable<ConversationSession["agentPulse"]["lastContextualLexicalEvidence"]> {
  return {
    matchedRuleId: classification.matchedRuleId,
    rulepackVersion: classification.rulepackVersion,
    rulepackFingerprint: classification.rulepackFingerprint,
    confidenceTier: classification.confidenceTier,
    confidence: classification.confidence,
    conflict: classification.conflict,
    candidateTokens: [...classification.candidateTokens],
    evaluatedAt
  };
}

/**
 * Checks whether a session key belongs to the active provider namespace.
 *
 * **Why it exists:**
 * Pulse scheduler ticks may include sessions from multiple providers; filtering avoids cross-provider routing.
 *
 * **What it talks to:**
 * - Local prefix matching only.
 *
 * @param conversationKey - Lookup key or map field identifier.
 * @param provider - Stable identifier used to reference an entity or record.
 * @returns `true` when this check/policy condition passes.
 */
function conversationBelongsToProvider(
  conversationKey: string,
  provider: "telegram" | "discord"
): boolean {
  return conversationKey.startsWith(`${provider}:`);
}

/**
 * Builds pulse prompt for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of pulse prompt consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `AgentPulseReason` (import `AgentPulseReason`) from `../core/agentPulse`.
 * - Uses `AgentPulseEvaluationResult` (import `AgentPulseEvaluationResult`) from `../core/profileMemoryStore`.
 * - Uses `ConversationSession` (import `ConversationSession`) from `./sessionStore`.
 *
 * @param session - Session receiving the pulse prompt.
 * @param reason - Selected pulse reason code.
 * @param evaluation - Deterministic pulse evaluation result for this user/session.
 * @param mode - Pulse delivery mode (`private` or `public`).
 * @param contextualCandidate - Optional contextual-followup candidate details.
 * @returns Prompt text sent to the planner/executor for pulse message drafting.
 */
function buildPulsePrompt(
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
      "Generate one concise, friendly, generic check-in message in explicit AI assistant identity.",
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
  const reasonExplanation = reasonExplanationByCode[reason];
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
    `Reason explanation: ${reasonExplanation}`,
    relationshipLine,
    contextDriftLine,
    `Signal counts: staleFactCount=${evaluation.staleFactCount}, unresolvedCommitmentCount=${evaluation.unresolvedCommitmentCount}`,
    ...(unresolvedTopicsLine ? [unresolvedTopicsLine] : []),
    ...(unresolvedTopicsDirective ? [unresolvedTopicsDirective] : []),
    ...contextualLines,
    "Generate one concise, friendly follow-up message in explicit AI assistant identity.",
    revalidationDirective,
    "Do not impersonate a human."
  ].join("\n");
}

const DYNAMIC_PULSE_INTENT_DIRECTIVES: Record<PulseReasonCodeV1, string> = {
  OPEN_LOOP_RESUME:
    "Something was left unfinished in conversation. Bring it back up if it feels right.",
  RELATIONSHIP_CLARIFICATION:
    "These things keep coming up together. You're curious about the connection.",
  TOPIC_DRIFT_RESUME:
    "A conversation drifted away from something that seemed important. See if they want to revisit.",
  STALE_FACT_REVALIDATION:
    "Something you know might be outdated. Check in about it casually.",
  USER_REQUESTED_FOLLOWUP:
    "They asked you to follow up on this. Now's a good time.",
  SAFETY_HOLD: ""
};

const DYNAMIC_PULSE_MAX_CONTEXT_TURNS = 8;

export interface DynamicPulsePromptContext {
  nowIso: string;
  userLocalTime: ResolvedUserLocalTime;
  conversationalGapMs: number;
  relationshipAgeDays: number;
  previousPulseOutcomes: readonly PulseEmissionRecordV1[];
  userStyleFingerprint: string;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Formats a millisecond duration into a human-readable gap string.
 */
function formatConversationalGap(gapMs: number): string {
  if (gapMs < MS_PER_MINUTE) return "just now";
  if (gapMs < MS_PER_HOUR) return `${Math.round(gapMs / MS_PER_MINUTE)} minutes`;
  if (gapMs < MS_PER_DAY) return `${Math.round(gapMs / MS_PER_HOUR)} hours`;
  return `${Math.round(gapMs / MS_PER_DAY)} days`;
}

/**
 * Builds a context-rich prompt for the dynamic pulse engine.
 * Provides the model with structured candidate data, recent conversation
 * context, and 6 naturalness context sections: conversational gap, local time,
 * relationship depth, response tracking, phrasing dedup, and style fingerprint.
 * The model decides tone and wording based on the full situation.
 */
function buildDynamicPulsePrompt(
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
        `Your recent pulse messages were:\n${recentSnippets.map((s) => `- "${s}"`).join("\n")}`
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
    "Never repeat a message you've already sent. If you've asked about this before, find a new angle.",
    "Do not explain why you're bringing this up. No 'I noticed that...' or 'My records show...'.",
    "Do not impersonate a human.",
    "Temperature hint: 0.65"
  ].filter(Boolean).join("\n");
}

const PULSE_MINIMUM_GAP_MS = 60_000;

/**
 * Returns true when the session should be skipped for pulse evaluation.
 * Enforces opt-in, active-work avoidance, and a hard minimum gap since the
 * last sent pulse to prevent rapid-fire even if emission persistence fails.
 */
function shouldSkipSessionForPulse(session: ConversationSession): boolean {
  if (!session.agentPulse.optIn) {
    return true;
  }
  if (Boolean(session.runningJobId) || session.queuedJobs.length > 0) {
    return true;
  }
  const lastSentMs = Date.parse(session.agentPulse.lastPulseSentAt ?? "");
  if (Number.isFinite(lastSentMs) && Date.now() - lastSentMs < PULSE_MINIMUM_GAP_MS) {
    return true;
  }
  return false;
}

/**
 * Normalizes ordering and duplication for by most recent session update.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for by most recent session update in one place.
 *
 * **What it talks to:**
 * - Uses `ConversationSession` (import `ConversationSession`) from `./sessionStore`.
 *
 * @param sessions - Sessions for one user/provider to sort by update recency.
 * @returns Ordered collection produced by this step.
 */
function sortByMostRecentSessionUpdate(sessions: ConversationSession[]): ConversationSession[] {
  return [...sessions].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  );
}

/**
 * Resolves pulse target session from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of pulse target session by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `ConversationSession` (import `ConversationSession`) from `./sessionStore`.
 *
 * @param controllerSession - Value for controller session.
 * @param userSessions - Value for user sessions.
 * @returns Computed `{ targetSession: ConversationSession | null; suppressionCode: ConversationSession["agentPulse"]["lastDecisionCode"] | null }` result.
 */
function selectPulseTargetSession(
  controllerSession: ConversationSession,
  userSessions: ConversationSession[]
): { targetSession: ConversationSession | null; suppressionCode: ConversationSession["agentPulse"]["lastDecisionCode"] | null } {
  if (controllerSession.agentPulse.mode === "private") {
    const privateSessions = sortByMostRecentSessionUpdate(
      userSessions.filter((candidate) => candidate.conversationVisibility === "private")
    );
    if (privateSessions.length === 0) {
      return {
        targetSession: null,
        suppressionCode: "NO_PRIVATE_ROUTE"
      };
    }
    return {
      targetSession: privateSessions[0],
      suppressionCode: null
    };
  }

  const currentSession = userSessions.find(
    (candidate) => candidate.conversationId === controllerSession.conversationId
  );
  return {
    targetSession: currentSession ?? controllerSession,
    suppressionCode: null
  };
}

/**
 * Computes how many days the agent-user relationship has existed.
 * Checks entity graph for a matching user entity `firstSeenAt`, falling back
 * to the oldest conversation turn timestamp.
 */
function computeRelationshipAgeDays(
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
      if (nameMatch) {
        const seenMs = Date.parse(entity.firstSeenAt);
        if (Number.isFinite(seenMs) && seenMs < earliestMs) {
          earliestMs = seenMs;
        }
      }
    }
  }

  if (earliestMs === nowMs && session.conversationTurns.length > 0) {
    const oldestTurn = session.conversationTurns[0];
    const turnMs = Date.parse(oldestTurn.at);
    if (Number.isFinite(turnMs) && turnMs < earliestMs) {
      earliestMs = turnMs;
    }
  }

  return Math.max(0, (nowMs - earliestMs) / MS_PER_DAY);
}

export class AgentPulseScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private tickInFlight = false;

  /**
   * Initializes `AgentPulseScheduler` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Stores injected scheduler collaborators (session store, pulse evaluator, enqueue/update callbacks).
   *
   * @param deps - Runtime dependencies for pulse evaluation and state persistence.
   * @param config - Configuration or policy values that shape deterministic behavior.
   */
  constructor(
    private readonly deps: AgentPulseSchedulerDeps,
    private readonly config: AgentPulseSchedulerConfig = DEFAULT_AGENT_PULSE_SCHEDULER_CONFIG
  ) { }

  /**
   * Starts input within this module's managed runtime lifecycle.
   *
   * **Why it exists:**
   * Keeps startup sequencing for input explicit and deterministic.
   *
   * **What it talks to:**
   * - Uses `setInterval` and `runTickOnce` to drive periodic evaluation.
   */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.timer = setInterval(() => {
      void this.runTickOnce();
    }, this.config.tickIntervalMs);
    void this.runTickOnce();
  }

  /**
   * Stops or clears input to keep runtime state consistent.
   *
   * **Why it exists:**
   * Centralizes teardown/reset behavior for input so lifecycle handling stays predictable.
   *
   * **What it talks to:**
   * - Uses `clearInterval` to stop scheduled tick execution.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Executes tick once as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the tick once runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses session listing/filtering helpers and `evaluateUser` for per-user decisions.
   * @returns Promise resolving to void.
   */
  async runTickOnce(): Promise<void> {
    if (this.tickInFlight) {
      return;
    }
    this.tickInFlight = true;

    try {
      const nowIso = new Date().toISOString();
      const sessions = await this.deps.sessionStore.listSessions();
      const providerSessions = sessions.filter((session) =>
        conversationBelongsToProvider(session.conversationId, this.deps.provider)
      );
      const users = new Set(providerSessions.map((session) => session.userId));
      for (const userId of users) {
        const userSessions = sortByMostRecentSessionUpdate(
          providerSessions.filter((session) => session.userId === userId)
        );
        const controllerSession = userSessions.find((candidate) => candidate.agentPulse.optIn);
        if (!controllerSession) {
          continue;
        }
        if (shouldSkipSessionForPulse(controllerSession)) {
          continue;
        }

        await this.evaluateUser(controllerSession, userSessions, nowIso);
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  /**
   * Executes pulse state to user sessions as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the pulse state to user sessions runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses `ConversationSession` (import `ConversationSession`) from `./sessionStore`.
   *
   * @param userSessions - Sessions that should receive synchronized pulse-state updates.
   * @param update - Pulse-state patch persisted to each session.
   * @returns Promise resolving to void.
   */
  private async applyPulseStateToUserSessions(
    userSessions: ConversationSession[],
    update: AgentPulseStateUpdate
  ): Promise<void> {
    for (const session of userSessions) {
      await this.deps.updatePulseState(session.conversationId, update);
    }
  }

  /**
   * Dynamic pulse evaluation path using the Stage 6.86 scored candidate engine.
   * Resolves entity graph and conversation stack, runs candidates through
   * `evaluatePulseCandidatesV1`, and emits a naturally-phrased pulse when a
   * high-value candidate is selected.
   */
  private async evaluateUserDynamic(
    controllerSession: ConversationSession,
    userSessions: ConversationSession[],
    targetSession: ConversationSession,
    nowIso: string
  ): Promise<void> {
    let graph: EntityGraphV1;
    try {
      graph = await this.deps.getEntityGraph!();
    } catch {
      console.log("[DynamicPulse] Entity graph unavailable, skipping tick.");
      return;
    }

    const stack = targetSession.conversationStack
      ?? buildConversationStackFromTurnsV1(
        targetSession.conversationTurns,
        targetSession.updatedAt
      );

    const activeMissionWorkExists =
      Boolean(targetSession.runningJobId) || targetSession.queuedJobs.length > 0;
    const recentPulseHistory: readonly PulseEmissionRecordV1[] =
      targetSession.agentPulse.recentEmissions ?? [];

    const result = evaluatePulseCandidatesV1({
      graph,
      stack,
      observedAt: nowIso,
      recentPulseHistory,
      activeMissionWorkExists
    });

    if (!result.emittedCandidate) {
      await this.applyPulseStateToUserSessions(userSessions, {
        lastDecisionCode: "DYNAMIC_SUPPRESSED",
        lastEvaluatedAt: nowIso,
        lastContextualLexicalEvidence: null,
        lastPulseReason: null,
        lastPulseTargetConversationId: targetSession.conversationId,
        updatedAt: nowIso
      });
      return;
    }

    const nowMs = Date.parse(nowIso);
    const userTurns = targetSession.conversationTurns.filter((t) => t.role === "user");
    const lastUserTurn = userTurns.length > 0 ? userTurns[userTurns.length - 1] : null;
    const conversationalGapMs = lastUserTurn
      ? Math.max(0, nowMs - Date.parse(lastUserTurn.at))
      : 0;

    const userLocalTime = resolveUserLocalTime(
      targetSession.agentPulse.userTimezone,
      nowIso
    );

    const relationshipAgeDays = computeRelationshipAgeDays(
      graph,
      targetSession,
      nowMs
    );

    const previousPulseOutcomes = targetSession.agentPulse.recentEmissions ?? [];
    const userStyleFingerprint = computeUserStyleFingerprint(targetSession.conversationTurns);

    const promptContext: DynamicPulsePromptContext = {
      nowIso,
      userLocalTime,
      conversationalGapMs,
      relationshipAgeDays,
      previousPulseOutcomes,
      userStyleFingerprint
    };

    const prompt = buildDynamicPulsePrompt(
      result.emittedCandidate,
      targetSession,
      controllerSession.agentPulse.mode,
      promptContext
    );

    const enqueued = await this.deps.enqueueSystemJob(targetSession, prompt, nowIso);
    if (!enqueued) return;

    const intentSummary = `${result.emittedCandidate.reasonCode}: ${result.emittedCandidate.entityRefs.join(", ") || "(no entities)"}`;
    const emission: PulseEmissionRecordV1 = {
      emittedAt: nowIso,
      reasonCode: result.emittedCandidate.reasonCode,
      candidateEntityRefs: [...result.emittedCandidate.entityRefs],
      responseOutcome: null,
      generatedSnippet: intentSummary.slice(0, 120)
    };

    await this.applyPulseStateToUserSessions(userSessions, {
      optIn: controllerSession.agentPulse.optIn,
      mode: controllerSession.agentPulse.mode,
      routeStrategy: controllerSession.agentPulse.routeStrategy,
      lastPulseSentAt: nowIso,
      lastPulseReason: result.emittedCandidate.reasonCode,
      lastPulseTargetConversationId: targetSession.conversationId,
      lastDecisionCode: "DYNAMIC_SENT",
      lastEvaluatedAt: nowIso,
      lastContextualLexicalEvidence: null,
      updatedAt: nowIso,
      newEmission: emission
    });
  }

  /**
   * Evaluates a user for pulse emission, delegating to the dynamic candidate
   * engine when enabled or falling back to the legacy counter-based path.
   */
  private async evaluateUser(
    controllerSession: ConversationSession,
    userSessions: ConversationSession[],
    nowIso: string
  ): Promise<void> {
    let lastEvaluation: AgentPulseEvaluationResult | null = null;
    let selectedReason: AgentPulseReason | null = null;
    let highestPrioritySuppression:
      | { evaluation: AgentPulseEvaluationResult; reason: AgentPulseReason }
      | null = null;

    const targetSelection = selectPulseTargetSession(controllerSession, userSessions);
    if (!targetSelection.targetSession) {
      await this.applyPulseStateToUserSessions(userSessions, {
        lastDecisionCode: targetSelection.suppressionCode ?? "NO_PRIVATE_ROUTE",
        lastEvaluatedAt: nowIso,
        lastContextualLexicalEvidence: null,
        lastPulseReason: null,
        lastPulseTargetConversationId: null,
        updatedAt: nowIso
      });
      return;
    }
    if (shouldSkipSessionForPulse(targetSelection.targetSession)) {
      return;
    }

    if (this.deps.enableDynamicPulse && this.deps.getEntityGraph) {
      await this.evaluateUserDynamic(
        controllerSession, userSessions, targetSelection.targetSession, nowIso
      );
      return;
    }

    const contextualCandidate = evaluateContextualFollowupCandidate(
      targetSelection.targetSession,
      nowIso
    );
    const contextualLexicalEvidence = toContextualLexicalEvidence(
      contextualCandidate.lexicalClassification,
      nowIso
    );

    for (const reason of this.config.reasonPriority) {
      if (reason === "contextual_followup" && !contextualCandidate.eligible) {
        lastEvaluation = buildSuppressedEvaluation({
          allowed: false,
          decisionCode: contextualCandidate.suppressionCode ?? "NO_CONTEXTUAL_LINKAGE",
          suppressedBy:
            contextualCandidate.suppressionCode === "CONTEXTUAL_TOPIC_COOLDOWN"
              ? ["policy.contextual_followup_topic_cooldown"]
              : ["reason.requires_contextual_linkage"],
          nextEligibleAtIso: contextualCandidate.nextEligibleAtIso
        });
        selectedReason = reason;
        if (!highestPrioritySuppression) {
          highestPrioritySuppression = {
            evaluation: lastEvaluation,
            reason
          };
        }
        continue;
      }

      const evaluation = await this.deps.evaluateAgentPulse({
        nowIso,
        userOptIn: controllerSession.agentPulse.optIn,
        reason,
        contextualLinkageConfidence:
          reason === "contextual_followup"
            ? contextualCandidate.linkageConfidence
            : undefined,
        lastPulseSentAtIso: controllerSession.agentPulse.lastPulseSentAt
      });
      lastEvaluation = evaluation;
      selectedReason = reason;

      if (!evaluation.decision.allowed) {
        if (!highestPrioritySuppression) {
          highestPrioritySuppression = {
            evaluation,
            reason
          };
        }
        continue;
      }

      const prompt = buildPulsePrompt(
        targetSelection.targetSession,
        reason,
        evaluation,
        controllerSession.agentPulse.mode,
        reason === "contextual_followup" ? contextualCandidate : null
      );
      const enqueued = await this.deps.enqueueSystemJob(targetSelection.targetSession, prompt, nowIso);
      if (!enqueued) {
        continue;
      }

      await this.applyPulseStateToUserSessions(userSessions, {
        optIn: controllerSession.agentPulse.optIn,
        mode: controllerSession.agentPulse.mode,
        routeStrategy: controllerSession.agentPulse.routeStrategy,
        lastPulseSentAt: nowIso,
        lastPulseReason: reason,
        lastPulseTargetConversationId: targetSelection.targetSession.conversationId,
        lastDecisionCode: evaluation.decision.decisionCode,
        lastEvaluatedAt: nowIso,
        lastContextualLexicalEvidence: contextualLexicalEvidence,
        updatedAt: nowIso
      });
      return;
    }

    const suppression = highestPrioritySuppression
      ?? (lastEvaluation && selectedReason
        ? { evaluation: lastEvaluation, reason: selectedReason }
        : null);
    if (suppression) {
      await this.applyPulseStateToUserSessions(userSessions, {
        optIn: controllerSession.agentPulse.optIn,
        mode: controllerSession.agentPulse.mode,
        routeStrategy: controllerSession.agentPulse.routeStrategy,
        lastPulseReason: suppression.reason,
        lastDecisionCode: suppression.evaluation.decision.decisionCode,
        lastEvaluatedAt: nowIso,
        lastContextualLexicalEvidence: contextualLexicalEvidence,
        updatedAt: nowIso
      });
    }
  }
}
