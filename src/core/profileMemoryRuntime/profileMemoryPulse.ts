/**
 * @fileoverview Agent Pulse continuity helpers derived from profile-memory state.
 */

import {
  assessProfileFactFreshness,
  type ProfileFactRecord,
  type ProfileMemoryState
} from "../profileMemory";
import { type AgentPulseDecision } from "../agentPulse";
import {
  type AgentPulseContextDriftAssessment,
  type AgentPulseContextDriftDomain,
  type AgentPulseEvaluationRequest,
  type ProfilePulseRelevantEpisode,
  type AgentPulseRelationshipAssessment,
  type AgentPulseRelationshipRole
} from "./contracts";
import {
  assessProfileEpisodeFreshness,
  compareProfileEpisodesForLifecyclePriority
} from "./profileMemoryEpisodeConsolidation";
import { isTerminalProfileEpisodeStatus } from "./profileMemoryEpisodeState";
import { isCompatibilityVisibleFactLike } from "./profileMemoryCompatibilityVisibility";
import { isActiveFact } from "./profileMemoryCommitmentSignals";

const RELATIONSHIP_FACT_KEY_HINTS = [
  "relationship",
  "friend",
  "partner",
  "married",
  "spouse",
  "wife",
  "husband",
  "girlfriend",
  "boyfriend",
  "acquaintance",
  "classmate",
  "family",
  "family member",
  "relative",
  "mom",
  "mother",
  "dad",
  "father",
  "son",
  "daughter",
  "parent",
  "child",
  "sibling",
  "sister",
  "brother",
  "manager",
  "employee",
  "coworker",
  "colleague",
  "teammate",
  "peer",
  "neighbor",
  "boss",
  "supervisor"
];

const RELATIONSHIP_ROLE_ALIASES: Record<
  Exclude<AgentPulseRelationshipRole, "unknown">,
  string[]
> = {
  friend: ["friend"],
  partner: ["partner", "married", "spouse", "wife", "husband", "girlfriend", "boyfriend"],
  acquaintance: ["acquaintance", "classmate"],
  distant_relative: [
    "distant_relative",
    "distant relative",
      "relative",
      "family",
      "family member",
      "cousin",
    "aunt",
    "uncle",
      "mom",
      "mother",
      "dad",
      "father",
      "son",
      "daughter",
      "parent",
      "child",
      "sibling",
      "sister",
      "brother"
  ],
  work_peer: ["work_peer", "work peer", "coworker", "colleague", "teammate", "peer"],
  manager: ["manager", "boss", "supervisor", "team lead", "lead"],
  employee: ["employee", "direct report"],
  neighbor: ["neighbor", "neighbour"]
};

const RELATIONSHIP_ROLE_SUPPRESSION_SET = new Set<AgentPulseRelationshipRole>([
  "acquaintance",
  "distant_relative"
]);

/**
 * Counts stale active facts for downstream policy and scoring decisions.
 *
 * @param state - Loaded profile-memory state.
 * @param staleAfterDays - Value for stale after days.
 * @param nowIso - Timestamp used for recency decisions.
 * @returns Number of stale active facts.
 */
export function countStaleActiveFacts(
  state: ProfileMemoryState,
  staleAfterDays: number,
  nowIso: string
): number {
  return state.facts.filter((fact) => {
    if (!isPulseTruthCandidateFact(fact)) {
      return false;
    }
    return assessProfileFactFreshness(fact, staleAfterDays, nowIso).stale;
  }).length;
}

/**
 * Selects bounded unresolved situation previews appropriate for pulse grounding.
 *
 * @param state - Loaded profile-memory state.
 * @param staleAfterDays - Value for stale after days.
 * @param nowIso - Timestamp used for freshness decisions.
 * @param maxEpisodes - Maximum relevant episode count.
 * @returns Deterministically ranked non-sensitive episode previews.
 */
export function selectRelevantEpisodesForPulse(
  state: ProfileMemoryState,
  staleAfterDays: number,
  nowIso: string,
  maxEpisodes = 2
): ProfilePulseRelevantEpisode[] {
  const safeMaxEpisodes = Math.max(0, maxEpisodes);
  if (safeMaxEpisodes === 0) {
    return [];
  }

  return [...state.episodes]
    .filter((episode) => !episode.sensitive)
    .filter((episode) => !isTerminalProfileEpisodeStatus(episode.status))
    .map((episode) => ({
      episode,
      freshness: assessProfileEpisodeFreshness(episode, staleAfterDays, nowIso)
    }))
    .filter((entry) => !entry.freshness.stale)
    .sort((left, right) =>
      compareProfileEpisodesForLifecyclePriority(
        left.episode,
        right.episode,
        staleAfterDays,
        nowIso
      )
    )
    .slice(0, safeMaxEpisodes)
    .map(({ episode, freshness }) => ({
      episodeId: episode.id,
      title: episode.title,
      summary: episode.summary,
      status: episode.status,
      lastMentionedAt: episode.lastMentionedAt,
      ageDays: freshness.ageDays
    }));
}

/**
 * Implements assess relationship role behavior used by `profileMemoryStore`.
 *
 * @param state - Loaded profile-memory state.
 * @returns Relationship-role assessment.
 */
export function assessRelationshipRole(
  state: ProfileMemoryState
): AgentPulseRelationshipAssessment {
  const confirmedFacts = state.facts
    .filter((fact) => isPulseCurrentFact(fact))
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt));
  const previouslyConfirmedFallbackFacts = state.facts
    .filter(
      (fact) =>
        isActiveFact(fact) &&
        fact.status === "uncertain" &&
        fact.confirmedAt !== null &&
        isCompatibilityVisibleFactLike(fact)
    )
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt));
  const unconfirmedFallbackFacts = state.facts
    .filter(
      (fact) =>
        isActiveFact(fact) &&
        fact.status === "uncertain" &&
        fact.confirmedAt === null &&
        isCompatibilityVisibleFactLike(fact)
    )
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt));

  for (const fact of [
    ...confirmedFacts,
    ...previouslyConfirmedFallbackFacts,
    ...unconfirmedFallbackFacts
  ]) {
    const role = inferRelationshipRoleFromFact(fact);
    if (!role) {
      continue;
    }
    return {
      role,
      roleFactId: fact.id
    };
  }

  return {
    role: "unknown",
    roleFactId: null
  };
}

/**
 * Determines whether one fact is current enough to stay canonical on pulse surfaces.
 *
 * Preserve-prior challengers remain active as uncertain evidence under Phase 2.5, but pulse
 * should treat them as drift signals rather than canonical current truth while a confirmed winner
 * still exists. `assessContextDrift` still consumes those uncertain active facts separately.
 *
 * @param fact - Candidate fact from the normalized profile state.
 * @returns `true` when the fact is confirmed, active, and compatibility-visible.
 */
function isPulseCurrentFact(
  fact: ProfileFactRecord
): boolean {
  return (
    isActiveFact(fact) &&
    fact.status === "confirmed" &&
    isCompatibilityVisibleFactLike(fact)
  );
}

/**
 * Determines whether one fact still counts as stale canonical truth for pulse revalidation.
 *
 * Stale formerly confirmed facts are downgraded to `uncertain` during load normalization, but
 * they should still count toward stale-fact revalidation because they represent prior canonical
 * truth that now needs verification. Preserve-prior challengers never carried confirmed truth, so
 * they stay drift-only and do not inflate stale-fact counts.
 *
 * @param fact - Candidate fact from the normalized profile state.
 * @returns `true` when the fact is active, compatibility-visible, and was previously confirmed.
 */
function isPulseTruthCandidateFact(
  fact: ProfileFactRecord
): boolean {
  return (
    isActiveFact(fact) &&
    fact.confirmedAt !== null &&
    isCompatibilityVisibleFactLike(fact)
  );
}

/**
 * Assesses profile-domain context drift signals from current fact states.
 *
 * @param state - Current normalized profile state.
 * @returns Drift assessment with affected domains and revalidation requirement.
 */
export function assessContextDrift(
  state: ProfileMemoryState
): AgentPulseContextDriftAssessment {
  const domains = new Set<AgentPulseContextDriftDomain>();
  for (const fact of state.facts) {
    const domain = toContextDriftDomain(fact.key);
    if (!domain) {
      continue;
    }

    const supersededSignal = fact.status === "superseded";
    const uncertainActiveSignal = isActiveFact(fact) && fact.status === "uncertain";
    if (supersededSignal || uncertainActiveSignal) {
      domains.add(domain);
    }
  }

  const sortedDomains = [...domains].sort();
  return {
    detected: sortedDomains.length > 0,
    domains: sortedDomains,
    requiresRevalidation: sortedDomains.length > 0
  };
}

/**
 * Applies relationship/context-aware suppression on top of base pulse policy decisions.
 *
 * @param baseDecision - Result from core pulse policy evaluation.
 * @param request - Pulse evaluation request metadata.
 * @param relationship - Relationship-role assessment derived from profile facts.
 * @param contextDrift - Drift assessment derived from profile fact status/domain signals.
 * @returns Final pulse decision after relationship/context nudging rules.
 */
export function applyRelationshipAwareTemporalNudging(
  baseDecision: AgentPulseDecision,
  request: AgentPulseEvaluationRequest,
  relationship: AgentPulseRelationshipAssessment,
  contextDrift: AgentPulseContextDriftAssessment
): AgentPulseDecision {
  if (!baseDecision.allowed) {
    return baseDecision;
  }

  if (
    request.reason === "unresolved_commitment" &&
    RELATIONSHIP_ROLE_SUPPRESSION_SET.has(relationship.role)
  ) {
    return {
      allowed: false,
      decisionCode: "RELATIONSHIP_ROLE_SUPPRESSED",
      suppressedBy: [`relationship.role.${relationship.role}`],
      nextEligibleAtIso: null
    };
  }

  if (
    request.reason === "unresolved_commitment" &&
    contextDrift.detected &&
    relationship.role === "unknown"
  ) {
    return {
      allowed: false,
      decisionCode: "CONTEXT_DRIFT_SUPPRESSED",
      suppressedBy: [
        "context_drift.requires_revalidation",
        ...contextDrift.domains.map((domain) => `context_drift.${domain}`)
      ],
      nextEligibleAtIso: null
    };
  }

  return baseDecision;
}

/**
 * Normalizes fact text into a stable shape for relationship-role inference.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeFactText(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s-]+/g, " ");
}

/**
 * Evaluates whole-alias presence inside normalized relationship text without substring bleed.
 *
 * @param normalizedValue - Already-normalized fact text.
 * @param alias - Relationship alias candidate to search for.
 * @returns `true` when the alias is present as a bounded term.
 */
function hasWholeRelationshipAlias(
  normalizedValue: string,
  alias: string
): boolean {
  const escapedAlias = normalizeFactText(alias).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\b)${escapedAlias}(?:\\b|$)`, "i").test(normalizedValue);
}

/**
 * Derives relationship role from text from available runtime inputs.
 *
 * @param value - Primary value processed by this function.
 * @returns Inferred relationship role when available.
 */
function inferRelationshipRoleFromText(
  value: string
): Exclude<AgentPulseRelationshipRole, "unknown"> | undefined {
  const normalized = normalizeFactText(value);
  const roles = Object.entries(RELATIONSHIP_ROLE_ALIASES) as Array<
    [Exclude<AgentPulseRelationshipRole, "unknown">, string[]]
  >;
  for (const [role, aliases] of roles) {
    if (aliases.some((alias) => hasWholeRelationshipAlias(normalized, alias))) {
      return role;
    }
  }
  return undefined;
}

/**
 * Derives relationship role from fact from available runtime inputs.
 *
 * @param fact - Value for fact.
 * @returns Inferred relationship role when available.
 */
function inferRelationshipRoleFromFact(
  fact: ProfileFactRecord
): Exclude<AgentPulseRelationshipRole, "unknown"> | undefined {
  const normalizedKey = fact.key.trim().toLowerCase();
  const keyLooksRelationshipSpecific = RELATIONSHIP_FACT_KEY_HINTS.some((hint) =>
    normalizedKey.includes(hint)
  );
  if (!keyLooksRelationshipSpecific && !normalizedKey.startsWith("relationship.")) {
    return undefined;
  }

  return (
    inferRelationshipRoleFromText(normalizedKey) ||
    inferRelationshipRoleFromText(fact.value)
  );
}

/**
 * Converts values into context drift domain form for consistent downstream use.
 *
 * @param factKey - Lookup key or map field identifier.
 * @returns Drift domain or `null`.
 */
function toContextDriftDomain(factKey: string): AgentPulseContextDriftDomain | null {
  const normalized = factKey.trim().toLowerCase();
  if (normalized.startsWith("team.") || normalized.includes(".team")) {
    return "team";
  }
  if (normalized.startsWith("employment.") || normalized.includes("job")) {
    return "job";
  }
  if (
    normalized.startsWith("residence.") ||
    normalized.startsWith("location.") ||
    normalized.includes(".location")
  ) {
    return "location";
  }
  if (
    normalized.startsWith("contact.") ||
    normalized.includes("email") ||
    normalized.includes("phone")
  ) {
    return "contact";
  }
  return null;
}
