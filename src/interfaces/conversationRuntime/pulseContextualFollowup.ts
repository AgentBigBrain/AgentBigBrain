/**
 * @fileoverview Canonical contextual follow-up evaluation helpers for Agent Pulse scheduling.
 */

import type { AgentPulseDecision } from "../../core/agentPulse";
import type { AgentPulseEvaluationResult } from "../../core/profileMemoryStore";
import type { ConversationSession, ConversationTurn } from "../sessionStore";
import {
  classifyContextualFollowupLexicalCue,
  type ContextualFollowupLexicalClassification
} from "../contextualFollowupLexicalClassifier";

export interface ContextualFollowupCandidate {
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
 * Normalizes confidence into deterministic bounds.
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
 * Normalizes freeform text into token-matching form.
 */
function normalizeTextForTokenization(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns conversation turns sorted chronologically.
 */
function sortTurnsByTimestamp(turns: ConversationTurn[]): ConversationTurn[] {
  return [...turns].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

/**
 * Finds the latest user turn that carries a contextual follow-up cue.
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
 * Builds the derived topic identity for a contextual follow-up candidate.
 */
function buildContextualTopicIdentity(tokens: string[]): { topicKey: string; topicSummary: string } {
  const sorted = [...tokens].sort();
  return {
    topicKey: sorted.slice(0, 3).join("_"),
    topicSummary: sorted.slice(0, 6).join(" ")
  };
}

/**
 * Resolves side-thread linkage and topic overlap from following turns.
 */
function resolveLinkageSignal(
  topicTokens: string[],
  followingTurns: ConversationTurn[]
): { sideThreadLinkage: boolean; topicOverlapCount: number } {
  const sideThreadLinkage = followingTurns.length >= 2;
  const normalizedFollowingText = normalizeTextForTokenization(
    followingTurns.map((turn) => turn.text).join(" ")
  );
  return {
    sideThreadLinkage,
    topicOverlapCount: topicTokens.filter((token) => normalizedFollowingText.includes(token))
      .length
  };
}

/**
 * Scores contextual linkage confidence from the derived linkage signal.
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
 * Extracts the derived contextual topic key from a previously emitted pulse prompt.
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
 * Resolves the next eligible time for a contextual topic cooldown, if any.
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
 * Evaluates whether a bounded contextual follow-up candidate exists for a session.
 */
export function evaluateContextualFollowupCandidate(
  session: ConversationSession,
  nowIso: string
) : ContextualFollowupCandidate {
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
 * Builds a synthetic suppressed evaluation for contextual-follow-up suppression paths.
 */
export function buildSuppressedEvaluation(
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
 * Converts lexical classification output into persisted contextual evidence metadata.
 */
export function toContextualLexicalEvidence(
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
