/**
 * @fileoverview Canonical continuity, recall, and intent helpers for the orchestrator entrypoint.
 */

import { selectModelForRole } from "../modelRouting";
import {
  type AgentPulseEvaluationRequest,
  type AgentPulseEvaluationResult,
  type ProfileMemoryStore
} from "../profileMemoryStore";
import {
  type ConversationStackV1,
  type EntityGraphV1
} from "../types";
import type {
  ProfileEpisodeContinuityQueryRequest
} from "../profileMemoryRuntime/profileMemoryEpisodeQueries";
import type {
  ProfileFactContinuityQueryRequest
} from "../profileMemoryRuntime/profileMemoryQueryContracts";
import { type BrainConfig } from "../config";
import {
  type InterpretedConversationIntent,
  type IntentInterpreterOrgan,
  type IntentInterpreterTurn
} from "../../organs/intentInterpreter";
import { type PulseLexicalRuleContext } from "../../organs/pulseLexicalClassifier";
import { type MemoryBrokerOrgan } from "../../organs/memoryBroker";

export interface EvaluateAgentPulseDependencies {
  config: Pick<BrainConfig, "agentPulse">;
  profileMemoryStore?: Pick<ProfileMemoryStore, "evaluateAgentPulse">;
}

export interface InterpretConversationIntentDependencies {
  config: BrainConfig;
  intentInterpreter: Pick<IntentInterpreterOrgan, "interpretConversationIntent">;
}

export interface QueryContinuityEpisodesDependencies {
  profileMemoryStore?: Pick<ProfileMemoryStore, "queryEpisodesForContinuity">;
}

export interface QueryContinuityFactsDependencies {
  profileMemoryStore?: Pick<ProfileMemoryStore, "queryFactsForContinuity">;
}

export interface RememberedSituationDependencies {
  memoryBroker: Pick<
    MemoryBrokerOrgan,
    | "reviewRememberedSituations"
    | "reviewRememberedFacts"
    | "resolveRememberedSituation"
    | "markRememberedSituationWrong"
    | "forgetRememberedSituation"
    | "correctRememberedFact"
    | "forgetRememberedFact"
  >;
}

/** Builds the fail-closed empty remembered-fact review result. */
function buildEmptyRememberedFactReviewResult(): Awaited<
  ReturnType<MemoryBrokerOrgan["reviewRememberedFacts"]>
> {
  return Object.assign([], {
    hiddenDecisionRecords: []
  }) as Awaited<ReturnType<MemoryBrokerOrgan["reviewRememberedFacts"]>>;
}

/**
 * Builds the deterministic pulse-evaluation result used when profile memory is disabled.
 *
 * @returns Fail-closed pulse result for disabled profile-memory access.
 */
function buildDisabledPulseEvaluation(): AgentPulseEvaluationResult {
  return {
    decision: {
      allowed: false,
      decisionCode: "DISABLED",
      suppressedBy: ["profile_memory.disabled"],
      nextEligibleAtIso: null
    },
    staleFactCount: 0,
    unresolvedCommitmentCount: 0,
    unresolvedCommitmentTopics: [],
    relevantEpisodes: [],
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
 * Builds the deterministic pulse-evaluation result used when profile memory is unavailable at runtime.
 *
 * @returns Fail-closed pulse result for profile-memory runtime failures.
 */
function buildUnavailablePulseEvaluation(): AgentPulseEvaluationResult {
  return {
    decision: {
      allowed: false,
      decisionCode: "DISABLED",
      suppressedBy: ["profile_memory.unavailable"],
      nextEligibleAtIso: null
    },
    staleFactCount: 0,
    unresolvedCommitmentCount: 0,
    unresolvedCommitmentTopics: [],
    relevantEpisodes: [],
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
 * Evaluates agent-pulse eligibility while keeping disabled/unavailable fallbacks deterministic.
 *
 * @param deps - Pulse-evaluation collaborators.
 * @param request - Current pulse-evaluation request.
 * @returns Pulse-evaluation result with fail-closed fallback metadata.
 */
export async function evaluateOrchestratorAgentPulse(
  deps: EvaluateAgentPulseDependencies,
  request: AgentPulseEvaluationRequest
): Promise<AgentPulseEvaluationResult> {
  if (!deps.profileMemoryStore) {
    return buildDisabledPulseEvaluation();
  }

  try {
    return await deps.profileMemoryStore.evaluateAgentPulse(deps.config.agentPulse, request);
  } catch {
    return buildUnavailablePulseEvaluation();
  }
}

/**
 * Interprets user intent for active conversations with a stable fallback on model failure.
 *
 * @param deps - Intent-interpretation collaborators.
 * @param text - Current user text.
 * @param recentTurns - Recent conversation turns used for disambiguation.
 * @param pulseRuleContext - Optional pulse lexical context.
 * @returns Typed interpreted intent or a deterministic none-intent fallback.
 */
export async function interpretOrchestratorConversationIntent(
  deps: InterpretConversationIntentDependencies,
  text: string,
  recentTurns: IntentInterpreterTurn[],
  pulseRuleContext?: PulseLexicalRuleContext
): Promise<InterpretedConversationIntent> {
  try {
    const interpreterModel = selectModelForRole("planner", deps.config);
    return await deps.intentInterpreter.interpretConversationIntent(text, interpreterModel, {
      recentTurns,
      pulseRuleContext
    });
  } catch (error) {
    return {
      intentType: "none",
      pulseMode: null,
      confidence: 0,
      rationale: `Intent interpreter fallback: ${(error as Error).message}`,
      source: "fallback"
    };
  }
}

/**
 * Queries bounded remembered situations linked to current continuity state.
 *
 * @param deps - Profile-memory query collaborators.
 * @param graph - Current entity graph.
 * @param stack - Current conversation stack.
 * @param entityHints - Re-mentioned entity/topic hints.
 * @param maxEpisodes - Maximum number of situations to surface.
 * @returns Continuity-linked episode matches or an empty list on failure.
 */
export async function queryOrchestratorContinuityEpisodes(
  deps: QueryContinuityEpisodesDependencies,
  graph: EntityGraphV1,
  stack: ConversationStackV1,
  entityHints: readonly string[],
  maxEpisodes = 3,
  requestOptions: Omit<ProfileEpisodeContinuityQueryRequest, "entityHints" | "maxEpisodes"> = {}
) {
  if (!deps.profileMemoryStore) {
    return [];
  }

  try {
    return await deps.profileMemoryStore.queryEpisodesForContinuity(graph, stack, {
      entityHints,
      maxEpisodes,
      ...requestOptions
    });
  } catch {
    return [];
  }
}

/**
 * Queries bounded remembered profile facts linked to current continuity state.
 *
 * @param deps - Profile-memory query collaborators.
 * @param graph - Current entity graph.
 * @param stack - Current conversation stack.
 * @param entityHints - Re-mentioned entity/topic hints.
 * @param maxFacts - Maximum number of facts to surface.
 * @returns Continuity-linked facts or an empty list on failure.
 */
export async function queryOrchestratorContinuityFacts(
  deps: QueryContinuityFactsDependencies,
  graph: EntityGraphV1,
  stack: ConversationStackV1,
  entityHints: readonly string[],
  maxFacts = 3,
  requestOptions: Omit<ProfileFactContinuityQueryRequest, "entityHints" | "maxFacts"> = {}
) {
  if (!deps.profileMemoryStore) {
    return [];
  }

  try {
    return await deps.profileMemoryStore.queryFactsForContinuity(graph, stack, {
      entityHints,
      maxFacts,
      ...requestOptions
    });
  } catch {
    return [];
  }
}

/**
 * Reviews bounded remembered situations for explicit `/memory` user commands.
 *
 * @param deps - Memory-broker collaborators.
 * @param reviewTaskId - Synthetic task id used for audit linkage.
 * @param query - User-facing review query.
 * @param nowIso - Current timestamp.
 * @param maxEpisodes - Maximum number of situations to return.
 * @returns Remembered situations or an empty list on failure.
 */
export async function reviewRememberedSituations(
  deps: RememberedSituationDependencies,
  reviewTaskId: string,
  query: string,
  nowIso: string,
  maxEpisodes = 5
) {
  try {
    return await deps.memoryBroker.reviewRememberedSituations(
      reviewTaskId,
      query,
      nowIso,
      maxEpisodes
    );
  } catch {
    return [];
  }
}

/**
 * Reviews bounded remembered facts for explicit user review commands.
 *
 * @returns Remembered facts or an empty additive review result on failure.
 */
export async function reviewRememberedFacts(
  deps: RememberedSituationDependencies,
  reviewTaskId: string,
  query: string,
  nowIso: string,
  maxFacts = 5
) {
  try {
    return await deps.memoryBroker.reviewRememberedFacts(
      reviewTaskId,
      query,
      nowIso,
      maxFacts
    );
  } catch {
    return buildEmptyRememberedFactReviewResult();
  }
}

/**
 * Marks one remembered situation resolved via explicit user command.
 *
 * @param deps - Memory-broker collaborators.
 * @param episodeId - Situation identifier.
 * @param sourceTaskId - Synthetic task id for provenance.
 * @param sourceText - User command text.
 * @param nowIso - Current timestamp.
 * @param note - Optional bounded outcome note.
 * @returns Updated situation or `null` on failure.
 */
export async function resolveRememberedSituation(
  deps: RememberedSituationDependencies,
  episodeId: string,
  sourceTaskId: string,
  sourceText: string,
  nowIso: string,
  note?: string
) {
  try {
    return await deps.memoryBroker.resolveRememberedSituation(
      episodeId,
      sourceTaskId,
      sourceText,
      nowIso,
      note
    );
  } catch {
    return null;
  }
}

/**
 * Marks one remembered situation wrong/no longer relevant via explicit user command.
 *
 * @param deps - Memory-broker collaborators.
 * @param episodeId - Situation identifier.
 * @param sourceTaskId - Synthetic task id for provenance.
 * @param sourceText - User command text.
 * @param nowIso - Current timestamp.
 * @param note - Optional bounded correction note.
 * @returns Updated situation or `null` on failure.
 */
export async function markRememberedSituationWrong(
  deps: RememberedSituationDependencies,
  episodeId: string,
  sourceTaskId: string,
  sourceText: string,
  nowIso: string,
  note?: string
) {
  try {
    return await deps.memoryBroker.markRememberedSituationWrong(
      episodeId,
      sourceTaskId,
      sourceText,
      nowIso,
      note
    );
  } catch {
    return null;
  }
}

/**
 * Forgets one remembered situation via explicit user command.
 *
 * @param deps - Memory-broker collaborators.
 * @param episodeId - Situation identifier.
 * @param sourceTaskId - Synthetic task id for provenance.
 * @param sourceText - User command text.
 * @param nowIso - Current timestamp.
 * @returns Removed situation or `null` on failure.
 */
export async function forgetRememberedSituation(
  deps: RememberedSituationDependencies,
  episodeId: string,
  sourceTaskId: string,
  sourceText: string,
  nowIso: string
) {
  try {
    return await deps.memoryBroker.forgetRememberedSituation(
      episodeId,
      sourceTaskId,
      sourceText,
      nowIso
    );
  } catch {
    return null;
  }
}

/**
 * Corrects one remembered fact via explicit user review input.
 *
 * @returns Bounded fact-mutation result or `null` on failure.
 */
export async function correctRememberedFact(
  deps: RememberedSituationDependencies,
  factId: string,
  replacementValue: string,
  sourceTaskId: string,
  sourceText: string,
  nowIso: string,
  note?: string
) {
  try {
    return await deps.memoryBroker.correctRememberedFact(
      factId,
      replacementValue,
      sourceTaskId,
      sourceText,
      nowIso,
      note
    );
  } catch {
    return null;
  }
}

/**
 * Forgets one remembered fact via explicit user review input.
 *
 * @returns Bounded fact-mutation result or `null` on failure.
 */
export async function forgetRememberedFact(
  deps: RememberedSituationDependencies,
  factId: string,
  sourceTaskId: string,
  sourceText: string,
  nowIso: string
) {
  try {
    return await deps.memoryBroker.forgetRememberedFact(
      factId,
      sourceTaskId,
      sourceText,
      nowIso
    );
  } catch {
    return null;
  }
}
