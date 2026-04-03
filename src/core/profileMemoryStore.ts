/**
 * @fileoverview Persists encrypted local profile memory with deterministic temporal freshness and access controls.
 */

import {
  type ProfileFactUpsertInput,
  DEFAULT_PROFILE_STALE_AFTER_DAYS,
  markStaleFactsAsUncertain,
  ProfileMemoryState
} from "./profileMemory";
import {
  assertProfileMemoryKeyLength
} from "./profileMemoryRuntime/profileMemoryEncryption";
import {
  AgentPulsePolicyConfig,
  evaluateAgentPulsePolicy
} from "./agentPulse";
import {
  buildValidatedProfileFactCandidates,
  extractProfileFactCandidatesFromUserInput
} from "./profileMemoryRuntime/profileMemoryExtraction";
import {
  extractProfileEpisodeCandidatesFromUserInput
} from "./profileMemoryRuntime/profileMemoryEpisodeExtraction";
import {
  parseProfileMediaIngestInput
} from "./profileMemoryRuntime/profileMemoryMediaIngest";
import {
  createProfileMemoryPersistenceConfigFromEnv,
  loadPersistedProfileMemoryState,
  saveProfileMemoryState
} from "./profileMemoryRuntime/profileMemoryPersistence";
import {
  createProfileMemoryReadSession,
  type ProfileMemoryReadSession
} from "./profileMemoryRuntime/profileMemoryReadSession";
import { isCompatibilityVisibleFactLike } from "./profileMemoryRuntime/profileMemoryCompatibilityVisibility";
import { recordProfileMemoryStoreLoad } from "./profileMemoryRuntime/profileMemoryRequestTelemetry";
import {
  findProfileMemoryIngestReceipt,
  recordProfileMemoryIngestReceipt
} from "./profileMemoryRuntime/profileMemoryIngestIdempotency";
import {
  applyProfileEpisodeCandidates,
  applyProfileEpisodeResolutions
} from "./profileMemoryRuntime/profileMemoryEpisodeMutations";
import { governProfileMemoryCandidates } from "./profileMemoryRuntime/profileMemoryTruthGovernance";
import {
  applyProfileFactCandidates,
  buildInferredCommitmentResolutionCandidates,
  buildStateReconciliationResolutionCandidates,
  countUnresolvedCommitments,
  extractUnresolvedCommitmentTopics
} from "./profileMemoryRuntime/profileMemoryMutations";
import {
  buildInferredProfileEpisodeResolutionCandidates
} from "./profileMemoryRuntime/profileMemoryEpisodeResolution";
import {
  applyRelationshipAwareTemporalNudging,
  assessContextDrift,
  assessRelationshipRole,
  countStaleActiveFacts,
  selectRelevantEpisodesForPulse
} from "./profileMemoryRuntime/profileMemoryPulse";
import {
  type AgentPulseEvaluationRequest,
  type AgentPulseEvaluationResult,
  type ProfileAccessRequest,
  type ProfileIngestResult,
  type ProfileMemoryRequestTelemetry,
  type ProfileMemoryWriteProvenance,
  type ProfileValidatedFactCandidateInput,
  type ProfileReadableEpisode,
  type ProfileReadableFact
} from "./profileMemoryRuntime/contracts";
import {
  type ProfileEpisodeContinuityQueryRequest
} from "./profileMemoryRuntime/profileMemoryEpisodeQueries";
import type { ProfileFactContinuityQueryRequest } from "./profileMemoryRuntime/profileMemoryQueries";
import { consolidateProfileEpisodes } from "./profileMemoryRuntime/profileMemoryEpisodeConsolidation";
import type { ProfileEpisodeResolutionStatus } from "./profileMemoryRuntime/profileMemoryEpisodeContracts";
import type { CreateProfileEpisodeRecordInput } from "./profileMemory";
import type {
  ConversationStackV1,
  EntityGraphV1
} from "./types";

export type {
  AgentPulseEvaluationRequest,
  AgentPulseEvaluationResult,
  ProfileAccessRequest,
  ProfileIngestResult,
  ProfileReadableEpisode,
  ProfileReadableFact
} from "./profileMemoryRuntime/contracts";

export interface ProfileMemoryIngestOptions {
  additionalEpisodeCandidates?: readonly CreateProfileEpisodeRecordInput[];
  validatedFactCandidates?: readonly ProfileValidatedFactCandidateInput[];
  provenance?: ProfileMemoryWriteProvenance;
  requestTelemetry?: ProfileMemoryRequestTelemetry;
}

export class ProfileMemoryStore {
  /**
   * Creates the encrypted profile-memory persistence service.
   *
   * **Why it exists:**
   * Runtime profile features (planning context, fact reads, pulse continuity) need one deterministic
   * service that enforces key length, storage path, and stale-fact policy.
   *
   * **What it talks to:**
   * - Validates encryption key length via `assertProfileMemoryKeyLength`.
   */
  constructor(
    private readonly filePath: string,
    private readonly encryptionKey: Buffer,
    private readonly staleAfterDays: number = DEFAULT_PROFILE_STALE_AFTER_DAYS
  ) {
    assertProfileMemoryKeyLength(encryptionKey);
  }

  /**
   * Builds a `ProfileMemoryStore` from environment configuration.
   *
   * **Why it exists:**
   * Startup wiring needs one place that interprets enable/disable flags, key requirements, and
   * stale-threshold defaults before constructing the store.
   *
   * **What it talks to:**
   * - Uses `createProfileMemoryPersistenceConfigFromEnv` (import
   *   `createProfileMemoryPersistenceConfigFromEnv`) from
   *   `./profileMemoryRuntime/profileMemoryPersistence`.
   *
   * @param env - Environment source (defaults to process env).
   * @returns Configured store instance, or `undefined` when profile memory is disabled.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ProfileMemoryStore | undefined {
    const persistenceConfig = createProfileMemoryPersistenceConfigFromEnv(env);
    if (!persistenceConfig) {
      return undefined;
    }

    return new ProfileMemoryStore(
      persistenceConfig.filePath,
      persistenceConfig.encryptionKey,
      persistenceConfig.staleAfterDays
    );
  }

  /**
   * Loads encrypted profile memory, applies deterministic reconciliation, and returns state.
   *
   * **Why it exists:**
   * Profile reads are not a pure file fetch: stale-fact downgrades and commitment reconciliation
   * can mutate state and must be persisted immediately to keep subsequent reads consistent.
   *
   * **What it talks to:**
   * - Uses `markStaleFactsAsUncertain` (import `markStaleFactsAsUncertain`) from `./profileMemory`.
   * - Uses `ProfileMemoryState` (import `ProfileMemoryState`) from `./profileMemory`.
   * - Uses `loadPersistedProfileMemoryState` (import `loadPersistedProfileMemoryState`) from
   *   `./profileMemoryRuntime/profileMemoryPersistence`.
   * @returns Normalized profile state, persisted if reconciliation made deterministic changes.
   */
  async load(requestTelemetry?: ProfileMemoryRequestTelemetry): Promise<ProfileMemoryState> {
    recordProfileMemoryStoreLoad(requestTelemetry);
    const nowIso = new Date().toISOString();
    const state = await loadPersistedProfileMemoryState(this.filePath, this.encryptionKey);
    const staleResult = markStaleFactsAsUncertain(
      state,
      this.staleAfterDays
    );
    let nextState = staleResult.nextState;
    let shouldPersist = staleResult.updatedFactIds.length > 0;

    const reconciliationCandidates = buildStateReconciliationResolutionCandidates(
      nextState,
      new Date().toISOString()
    );
    const reconciliationResult = applyProfileFactCandidates(
      nextState,
      reconciliationCandidates
    );
    if (reconciliationResult.appliedFacts > 0) {
      nextState = reconciliationResult.nextState;
      shouldPersist = true;
    }

    const consolidationResult = consolidateProfileEpisodes(nextState.episodes);
    if (consolidationResult.consolidatedEpisodeCount > 0) {
      nextState = {
        ...nextState,
        updatedAt: nowIso,
        episodes: consolidationResult.episodes
      };
      shouldPersist = true;
    }

    if (shouldPersist) {
      await this.save(nextState);
    }
    return nextState;
  }

  /**
   * Opens one request-scoped read facade over a reconciled profile-memory snapshot.
   *
   * **Why it exists:**
   * Higher-level request paths such as brokered planner assembly may need multiple read projections
   * from the same canonical state. This method lets them reuse one reconciled snapshot without
   * stacking independent `load()` calls.
   *
   * @returns Request-scoped read session over the current reconciled profile state.
   */
  async openReadSession(
    requestTelemetry?: ProfileMemoryRequestTelemetry
  ): Promise<ProfileMemoryReadSession> {
    return createProfileMemoryReadSession(
      await this.load(requestTelemetry),
      this.staleAfterDays
    );
  }

  /**
   * Extracts and applies profile-memory mutations from one task/user input.
   *
   * **Why it exists:**
   * Ingestion combines multiple deterministic candidate sources (pattern extraction + commitment
   * resolution inference) and persists the merged result as one atomic update path.
   *
   * **What it talks to:**
   * - Uses `extractProfileFactCandidatesFromUserInput` (import `extractProfileFactCandidatesFromUserInput`) from `./profileMemory`.
   *
   * @param taskId - Task identifier attached to generated fact metadata.
   * @param userInput - Raw user text to mine for profile candidates.
   * @param observedAt - Observation timestamp for generated candidates.
   * @returns Counts of applied and superseded facts.
   */
  async ingestFromTaskInput(
    taskId: string,
    userInput: string,
    observedAt: string,
    options: ProfileMemoryIngestOptions = {}
  ): Promise<ProfileIngestResult> {
    const state = await this.load(options.requestTelemetry);
    if (findProfileMemoryIngestReceipt(state, options.provenance)) {
      return {
        appliedFacts: 0,
        supersededFacts: 0
      };
    }
    const mediaIngest = parseProfileMediaIngestInput(userInput);
    const factSourceTexts = dedupeProfileIngestTexts([
      mediaIngest.directUserText,
      ...mediaIngest.transcriptFragments
    ]);
    const extractedCandidates = factSourceTexts.flatMap((text) =>
      extractProfileFactCandidatesFromUserInput(text, taskId, observedAt)
    );
    const validatedCandidates = buildValidatedProfileFactCandidates(
      options.validatedFactCandidates ?? [],
      taskId,
      observedAt
    );
    const inferredResolutionCandidates = factSourceTexts.flatMap((text) =>
      buildInferredCommitmentResolutionCandidates(state, text, taskId, observedAt)
    );
    const candidates = [
      ...extractedCandidates,
      ...validatedCandidates,
      ...inferredResolutionCandidates
    ];
    const extractedEpisodeCandidates = mediaIngest.allNarrativeFragments.flatMap((text) =>
      extractProfileEpisodeCandidatesFromUserInput(text, taskId, observedAt)
    );
    const mergedEpisodeCandidates = [
      ...extractedEpisodeCandidates,
      ...(options.additionalEpisodeCandidates ?? [])
    ];
    const preResolutionGovernance = governProfileMemoryCandidates({
      factCandidates: candidates,
      episodeCandidates: mergedEpisodeCandidates,
      episodeResolutionCandidates: []
    });
    const applyResult = applyProfileFactCandidates(state, [
      ...preResolutionGovernance.allowedCurrentStateFactCandidates,
      ...selectCompatibilitySafeSupportOnlyFactCandidates(
        preResolutionGovernance.allowedSupportOnlyFactCandidates
      )
    ]);
    const inferredEpisodeResolutionCandidates = factSourceTexts.flatMap((text) =>
      buildInferredProfileEpisodeResolutionCandidates(
        applyResult.nextState,
        text,
        taskId,
        observedAt
      )
    );
    const resolutionGovernance = governProfileMemoryCandidates({
      factCandidates: [],
      episodeCandidates: [],
      episodeResolutionCandidates: inferredEpisodeResolutionCandidates
    });
    const episodeCandidateResult = applyProfileEpisodeCandidates(
      applyResult.nextState,
      [...preResolutionGovernance.allowedEpisodeCandidates]
    );
    const episodeResolutionResult = applyProfileEpisodeResolutions(
      episodeCandidateResult.nextState,
      [...resolutionGovernance.allowedEpisodeResolutionCandidates]
    );

    const totalAppliedFacts = applyResult.appliedFacts +
      episodeCandidateResult.createdEpisodes +
      episodeCandidateResult.updatedEpisodes +
      episodeResolutionResult.resolvedEpisodes;
    if (totalAppliedFacts === 0) {
      return {
        appliedFacts: 0,
        supersededFacts: 0
      };
    }

    await this.save(
      recordProfileMemoryIngestReceipt(episodeResolutionResult.nextState, {
        provenance: options.provenance,
        sourceTaskId: taskId,
        recordedAt: observedAt
      })
    );
    return {
      appliedFacts: totalAppliedFacts,
      supersededFacts: applyResult.supersededFacts
    };
  }

  /**
   * Builds planner-facing profile context with query-aware ranking/selection.
   *
   * **Why it exists:**
   * Planner prompts should include only a bounded, relevant subset of active non-sensitive facts,
   * and that selection should remain deterministic for similar query inputs.
   *
   * **What it talks to:**
   * - Uses `buildProfilePlanningContext` (import `buildProfilePlanningContext`) from
   *   `./profileMemoryRuntime/profileMemoryQueries`.
   *
   * @param maxFacts - Maximum number of facts to include in returned context.
   * @param queryInput - Current user/planner query used for relevance scoring.
   * @returns Rendered profile context block for planner prompt injection.
   */
  async getPlanningContext(maxFacts = 6, queryInput = ""): Promise<string> {
    return (await this.openReadSession()).getPlanningContext(maxFacts, queryInput);
  }

  /**
   * Returns bounded non-sensitive facts selected for the current planner query.
   *
   * @param maxFacts - Maximum number of facts to return.
   * @param queryInput - Current planner query text.
   * @returns Readable fact entries selected for query-aware planning.
   */
  async queryFactsForPlanningContext(
    maxFacts = 6,
    queryInput = ""
  ): Promise<readonly ProfileReadableFact[]> {
    return (await this.openReadSession()).queryFactsForPlanningContext(maxFacts, queryInput);
  }

  /**
   * Builds planner-facing episodic-memory context with bounded unresolved-situation summaries.
   *
   * **Why it exists:**
   * Planner/model prompts sometimes need a small number of relevant unresolved situations, but only
   * when the current query makes them relevant and only when they remain non-sensitive.
   *
   * **What it talks to:**
   * - Uses `buildProfileEpisodePlanningContext` from
   *   `./profileMemoryRuntime/profileMemoryEpisodePlanningContext`.
   *
   * @param maxEpisodes - Maximum number of episode summaries to include.
   * @param queryInput - Current user/planner query used for relevance scoring.
   * @returns Rendered episodic-memory planning context block.
   */
  async getEpisodePlanningContext(
    maxEpisodes = 2,
    queryInput = "",
    nowIso = new Date().toISOString()
  ): Promise<string> {
    return (await this.openReadSession()).getEpisodePlanningContext(maxEpisodes, queryInput, nowIso);
  }

  /**
   * Returns bounded non-sensitive episodes selected for the current planner query.
   *
   * @param maxEpisodes - Maximum number of episodes to return.
   * @param queryInput - Current planner query text.
   * @param nowIso - Timestamp used for lifecycle ranking.
   * @returns Readable episode entries selected for query-aware planning.
   */
  async queryEpisodesForPlanningContext(
    maxEpisodes = 2,
    queryInput = "",
    nowIso = new Date().toISOString()
  ): Promise<readonly ProfileReadableEpisode[]> {
    return (await this.openReadSession()).queryEpisodesForPlanningContext(
      maxEpisodes,
      queryInput,
      nowIso
    );
  }

  /**
   * Evaluates Agent Pulse eligibility using profile-derived continuity signals.
   *
   * **Why it exists:**
   * Pulse decisions combine policy-level gates with profile-specific continuity context (staleness,
   * unresolved commitments, relationship role, and context drift). This method composes those
   * signals into one deterministic decision payload.
   *
   * **What it talks to:**
   * - Uses `AgentPulsePolicyConfig` (import `AgentPulsePolicyConfig`) from `./agentPulse`.
   * - Uses `evaluateAgentPulsePolicy` (import `evaluateAgentPulsePolicy`) from `./agentPulse`.
   *
   * @param policy - Global pulse policy configuration.
   * @param request - Per-evaluation request context and reason metadata.
   * @returns Decision + supporting continuity diagnostics for traceability.
   */
  async evaluateAgentPulse(
    policy: AgentPulsePolicyConfig,
    request: AgentPulseEvaluationRequest
  ): Promise<AgentPulseEvaluationResult> {
    const state = await this.load();
    const staleFactCount = countStaleActiveFacts(state, this.staleAfterDays, request.nowIso);
    const unresolvedCommitmentCount = countUnresolvedCommitments(state);
    const unresolvedCommitmentTopics = extractUnresolvedCommitmentTopics(state);
    const relevantEpisodes = selectRelevantEpisodesForPulse(
      state,
      this.staleAfterDays,
      request.nowIso,
      2
    );
    const relationship = assessRelationshipRole(state);
    const contextDrift = assessContextDrift(state);

    const baseDecision = evaluateAgentPulsePolicy(policy, {
      nowIso: request.nowIso,
      userOptIn: request.userOptIn,
      reason: request.reason,
      staleFactCount,
      unresolvedCommitmentCount,
      contextualLinkageConfidence: request.contextualLinkageConfidence,
      lastPulseSentAtIso: request.lastPulseSentAtIso,
      overrideQuietHours: request.overrideQuietHours === true,
      sessionDominantLane: request.sessionDominantLane ?? null,
      sessionHasActiveWorkflowContinuity: request.sessionHasActiveWorkflowContinuity === true,
      overrideSessionDomainSuppression: request.overrideSessionDomainSuppression === true
    });
    const decision = applyRelationshipAwareTemporalNudging(
      baseDecision,
      request,
      relationship,
      contextDrift
    );

    return {
      decision,
      staleFactCount,
      unresolvedCommitmentCount,
      unresolvedCommitmentTopics,
      relevantEpisodes,
      relationship,
      contextDrift
    };
  }

  /**
   * Returns readable profile facts under approval-aware sensitivity gating.
   *
   * **Why it exists:**
   * Interfaces and operators need fact visibility, but sensitive facts must stay hidden unless the
   * access request carries explicit valid approval metadata.
   *
   * **What it talks to:**
   * - Uses `readProfileFacts` (import `readProfileFacts`) from
   *   `./profileMemoryRuntime/profileMemoryQueries`.
   *
   * @param request - Access request with purpose/approval/maxFacts controls.
   * @returns Sorted readable fact entries filtered by sensitivity rules.
   */
  async readFacts(request: ProfileAccessRequest): Promise<ProfileReadableFact[]> {
    return (await this.openReadSession()).readFacts(request);
  }

  /**
   * Returns bounded non-sensitive profile facts relevant to current continuity/entity hints.
   *
   * @param graph - Current Stage 6.86 entity graph.
   * @param stack - Current Stage 6.86 conversation stack.
   * @param request - Continuity-aware fact query request.
   * @returns Readable fact entries ranked for continuity-aware recall/planning.
   */
  async queryFactsForContinuity(
    graph: EntityGraphV1,
    stack: ConversationStackV1,
    request: ProfileFactContinuityQueryRequest
  ): Promise<readonly ProfileReadableFact[]> {
    return (await this.openReadSession()).queryFactsForContinuity(graph, stack, request);
  }

  /**
   * Returns readable episodic-memory records under approval-aware sensitivity gating.
   *
   * @param request - Access request with purpose/approval/maxEpisodes controls.
   * @returns Sorted readable episode entries filtered by sensitivity rules.
   */
  async readEpisodes(
    request: ProfileAccessRequest,
    nowIso = new Date().toISOString()
  ): Promise<ProfileReadableEpisode[]> {
    return (await this.openReadSession()).readEpisodes(request, nowIso);
  }

  /**
   * Returns bounded user-reviewable episodic-memory records under explicit review approval.
   *
   * @param maxEpisodes - Maximum number of remembered situations to surface.
   * @param nowIso - Timestamp used for stale/closed ranking.
   * @returns Readable episodic-memory records for direct user review.
   */
  async reviewEpisodesForUser(
    maxEpisodes = 5,
    nowIso = new Date().toISOString()
  ): Promise<ProfileReadableEpisode[]> {
    return this.readEpisodes(
      {
        purpose: "operator_view",
        includeSensitive: true,
        explicitHumanApproval: true,
        approvalId: `memory_review:${nowIso}`,
        maxEpisodes
      },
      nowIso
    );
  }

  /**
   * Applies one explicit user-driven episodic-memory status update.
   *
   * @param episodeId - Episode identifier targeted by the user.
   * @param status - Target terminal/non-terminal status to apply.
   * @param sourceTaskId - Command-scoped source task id.
   * @param sourceText - User command text that triggered the update.
   * @param note - Optional bounded outcome/correction note.
   * @param nowIso - Timestamp applied to the mutation.
   * @returns Updated readable episode, or `null` when the episode is unavailable.
   */
  async updateEpisodeFromUser(
    episodeId: string,
    status: ProfileEpisodeResolutionStatus,
    sourceTaskId: string,
    sourceText: string,
    note?: string,
    nowIso = new Date().toISOString()
  ): Promise<ProfileReadableEpisode | null> {
    const state = await this.load();
    if (!state.episodes.some((episode) => episode.id === episodeId)) {
      return null;
    }

    const applyResult = applyProfileEpisodeResolutions(state, [
      {
        episodeId,
        status,
        sourceTaskId,
        source: sourceText,
        observedAt: nowIso,
        confidence: 1,
        summary: note
      }
    ]);
    if (applyResult.resolvedEpisodes === 0) {
      return this.findReadableEpisodeById(applyResult.nextState, episodeId);
    }

    await this.save(applyResult.nextState);
    return this.findReadableEpisodeById(applyResult.nextState, episodeId);
  }

  /**
   * Forgets one remembered episodic-memory record entirely.
   *
   * @param episodeId - Episode identifier targeted by the user.
   * @param nowIso - Timestamp applied to the mutation.
   * @returns Removed readable episode, or `null` when no matching episode exists.
   */
  async forgetEpisodeFromUser(
    episodeId: string,
    _sourceTaskId: string,
    _sourceText: string,
    nowIso = new Date().toISOString()
  ): Promise<ProfileReadableEpisode | null> {
    const state = await this.load();
    const removedEpisode = state.episodes.find((episode) => episode.id === episodeId);
    if (!removedEpisode) {
      return null;
    }

    const nextState: ProfileMemoryState = {
      ...state,
      updatedAt: nowIso,
      episodes: state.episodes.filter((episode) => episode.id !== episodeId)
    };
    await this.save(nextState);
    return toReadableEpisode(removedEpisode);
  }

  /**
   * Selects bounded episodic-memory records relevant to the current continuity surfaces.
   *
   * @param graph - Current Stage 6.86 entity graph.
   * @param stack - Current Stage 6.86 conversation stack.
   * @param request - Entity-hint query parameters.
   * @returns Deterministically ranked linked episodic-memory records.
   */
  async queryEpisodesForContinuity(
    graph: EntityGraphV1,
    stack: ConversationStackV1,
    request: ProfileEpisodeContinuityQueryRequest,
    nowIso = new Date().toISOString()
  ) {
    return (await this.openReadSession()).queryEpisodesForContinuity(
      graph,
      stack,
      request,
      nowIso
    );
  }

  /**
   * Encrypts and persists profile state to local storage.
   *
   * **Why it exists:**
   * All profile writes must go through one path so encryption envelope format and directory/write
   * behavior remain consistent across ingestion, reconciliation, and pulse flows.
   *
   * **What it talks to:**
   * - Uses `ProfileMemoryState` (import `ProfileMemoryState`) from `./profileMemory`.
   * - Uses `saveProfileMemoryState` (import `saveProfileMemoryState`) from
   *   `./profileMemoryRuntime/profileMemoryPersistence`.
   *
   * @param state - Normalized profile state to persist.
   * @returns Promise resolving when encrypted state is flushed to disk.
   */
  private async save(state: ProfileMemoryState): Promise<void> {
    await saveProfileMemoryState(this.filePath, this.encryptionKey, state);
  }

  /**
   * Finds one readable episodic-memory record by identifier.
   *
   * @param state - Loaded profile-memory state.
   * @param episodeId - Target episode identifier.
   * @returns Readable episodic-memory record, or `null` when absent.
   */
  private findReadableEpisodeById(
    state: ProfileMemoryState,
    episodeId: string
  ): ProfileReadableEpisode | null {
    const episode = state.episodes.find((entry) => entry.id === episodeId);
    return episode ? toReadableEpisode(episode) : null;
  }
}

/**
 * Converts one canonical episode record into the public readable review shape.
 *
 * @param episode - Canonical stored episode record.
 * @returns Readable episodic-memory record.
 */
/**
 * Deduplicates bounded media/user text fragments before extraction or resolution inference.
 *
 * @param values - Candidate ingest fragments.
 * @returns Ordered unique text fragments.
 */
function dedupeProfileIngestTexts(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    const signature = normalized.toLowerCase();
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    ordered.push(normalized);
  }
  return ordered;
}

/**
 * Filters support-only legacy facts down to the subset that can still safely project into the
 * current flat compatibility store without pretending to be singular current-state truth.
 *
 * @param candidates - Governance-classified support-only fact candidates.
 * @returns Support-only candidates that remain compatibility-safe for flat fact projection.
 */
function selectCompatibilitySafeSupportOnlyFactCandidates(
  candidates: readonly ProfileFactUpsertInput[]
): readonly ProfileFactUpsertInput[] {
  return candidates.filter((candidate) => isCompatibilityVisibleFactLike(candidate));
}

/**
 * Converts one stored episode into the bounded operator-facing review shape.
 *
 * @param episode - Stored episode record.
 * @returns Readable episode payload used by memory review surfaces.
 */
function toReadableEpisode(
  episode: ProfileMemoryState["episodes"][number]
): ProfileReadableEpisode {
  return {
    episodeId: episode.id,
    title: episode.title,
    summary: episode.summary,
    status: episode.status,
    sensitive: episode.sensitive,
    sourceKind: episode.sourceKind,
    observedAt: episode.observedAt,
    lastMentionedAt: episode.lastMentionedAt,
    lastUpdatedAt: episode.lastUpdatedAt,
    resolvedAt: episode.resolvedAt,
    confidence: episode.confidence,
    entityRefs: [...episode.entityRefs],
    openLoopRefs: [...episode.openLoopRefs],
    tags: [...episode.tags]
  };
}

