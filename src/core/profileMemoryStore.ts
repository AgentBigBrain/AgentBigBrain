/**
 * @fileoverview Persists encrypted local profile memory with deterministic temporal freshness and access controls.
 */

import { sha256HexFromCanonicalJson } from "./normalizers/canonicalizationRules";
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
import {
  buildProfileMemorySourceFingerprint
} from "./profileMemoryRuntime/profileMemoryIngestProvenance";
import { isCompatibilityVisibleFactLike } from "./profileMemoryRuntime/profileMemoryCompatibilityVisibility";
import { recordProfileMemoryStoreLoad } from "./profileMemoryRuntime/profileMemoryRequestTelemetry";
import {
  findProfileMemoryIngestReceipt,
  recordProfileMemoryIngestReceipt
} from "./profileMemoryRuntime/profileMemoryIngestIdempotency";
import {
  buildProfileMemoryIngestMutationEnvelope,
  buildProfileMemoryFactReviewMutationEnvelope,
  buildProfileMemoryReviewMutationEnvelope
} from "./profileMemoryRuntime/profileMemoryMutationEnvelope";
import {
  applyProfileEpisodeCandidates,
  applyProfileEpisodeResolutions
} from "./profileMemoryRuntime/profileMemoryEpisodeMutations";
import { upsertTemporalProfileFact } from "./profileMemoryRuntime/profileMemoryFactLifecycle";
import { governProfileMemoryCandidates } from "./profileMemoryRuntime/profileMemoryTruthGovernance";
import type { GovernedProfileFactCandidate } from "./profileMemoryRuntime/profileMemoryTruthGovernanceContracts";
import {
  applyProfileFactCandidates,
  buildInferredCommitmentResolutionCandidates,
  buildStateReconciliationResolutionCandidates,
  countUnresolvedCommitments,
  extractUnresolvedCommitmentTopics
} from "./profileMemoryRuntime/profileMemoryMutations";
import { applySupportOnlyTransitionFactCandidates } from "./profileMemoryRuntime/profileMemorySupportOnlyTransitionLifecycle";
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
  type ProfileFactReviewMutationRequest,
  type ProfileFactReviewMutationResult,
  type ProfileFactReviewRequest,
  type ProfileFactReviewResult,
  type ProfileEpisodeReviewMutationResult,
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
import type { ProfileFactContinuityQueryRequest } from "./profileMemoryRuntime/profileMemoryQueryContracts";
import { readProfileFacts } from "./profileMemoryRuntime/profileMemoryQueries";
import { consolidateProfileEpisodes } from "./profileMemoryRuntime/profileMemoryEpisodeConsolidation";
import type { ProfileEpisodeResolutionStatus } from "./profileMemoryRuntime/profileMemoryEpisodeContracts";
import {
  getProfileMemoryFamilyRegistryEntry
} from "./profileMemoryRuntime/profileMemoryFamilyRegistry";
import {
  applyProfileMemoryGraphMutations,
  applyProfileMemoryGraphStableRefRekey
} from "./profileMemoryRuntime/profileMemoryGraphMutations";
import {
  queryProfileMemoryGraphAlignedStableRefGroups,
  type ProfileMemoryGraphAlignedStableRefGroup
} from "./profileMemoryRuntime/profileMemoryGraphAlignmentSupport";
import {
  queryProfileMemoryGraphResolvedCurrentClaims,
  queryProfileMemoryGraphStableRefGroups,
  type ProfileMemoryGraphStableRefGroup
} from "./profileMemoryRuntime/profileMemoryGraphQueries";
import {
  resolveProfileMemoryEffectiveSensitivity
} from "./profileMemoryRuntime/profileMemoryFactSensitivity";
import { inferGovernanceFamilyForNormalizedKey } from "./profileMemoryRuntime/profileMemoryGovernanceFamilyInference";
import { normalizeProfileValue } from "./profileMemoryRuntime/profileMemoryNormalization";
import { MEMORY_REVIEW_FACT_CORRECTION_SOURCE } from "./profileMemoryRuntime/profileMemoryTruthGovernanceSources";
import type { CreateProfileEpisodeRecordInput } from "./profileMemory";
import type { ProfileMemoryGraphClaimRecord } from "./profileMemoryRuntime/profileMemoryGraphContracts";
import type {
  ConversationStackV1,
  EntityGraphV1
} from "./types";

export type {
  AgentPulseEvaluationRequest,
  AgentPulseEvaluationResult,
  ProfileAccessRequest,
  ProfileFactReviewMutationRequest,
  ProfileFactReviewMutationResult,
  ProfileFactReviewRequest,
  ProfileFactReviewResult,
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
    const sourceFingerprint =
      options.provenance?.sourceFingerprint ??
      buildProfileMemorySourceFingerprint(
        userInput,
        options.validatedFactCandidates ?? []
      );
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
    const supportOnlyTransitionResult = applySupportOnlyTransitionFactCandidates(
      state,
      preResolutionGovernance.allowedSupportOnlyFactCandidates
    );
    const applyResult = applyProfileFactCandidates(supportOnlyTransitionResult.nextState, [
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
    const mutationEnvelope = options.provenance
      ? buildProfileMemoryIngestMutationEnvelope({
          sourceTaskId: taskId,
          userInput,
          provenance: options.provenance,
          finalState: episodeResolutionResult.nextState,
          factDecisions: preResolutionGovernance.factDecisions,
          episodeDecisions: preResolutionGovernance.episodeDecisions,
          episodeResolutionDecisions: resolutionGovernance.episodeResolutionDecisions
        })
      : undefined;
    const touchedEpisodeIds = new Set([
      ...episodeCandidateResult.touchedEpisodeIds,
      ...episodeResolutionResult.touchedEpisodeIds
    ]);
    const graphMutationResult = applyProfileMemoryGraphMutations({
      state: episodeResolutionResult.nextState,
      factDecisions: preResolutionGovernance.factDecisions,
      touchedEpisodes: episodeResolutionResult.nextState.episodes.filter((episode) =>
        touchedEpisodeIds.has(episode.id)
      ),
      sourceFingerprint,
      mutationEnvelopeHash: mutationEnvelope
        ? sha256HexFromCanonicalJson(mutationEnvelope)
        : null,
      recordedAt: observedAt
    });

    const totalAppliedFacts = applyResult.appliedFacts +
      episodeCandidateResult.createdEpisodes +
      episodeCandidateResult.updatedEpisodes +
      episodeResolutionResult.resolvedEpisodes;
    if (totalAppliedFacts === 0 && !graphMutationResult.changed) {
      return {
        appliedFacts: 0,
        supersededFacts: 0,
        ...(mutationEnvelope ? { mutationEnvelope } : {})
      };
    }

    await this.save(
      recordProfileMemoryIngestReceipt(graphMutationResult.nextState, {
        provenance: options.provenance,
        sourceTaskId: taskId,
        recordedAt: observedAt
      })
    );
    return {
      appliedFacts: totalAppliedFacts,
      supersededFacts: supportOnlyTransitionResult.supersededFacts + applyResult.supersededFacts,
      ...(mutationEnvelope ? { mutationEnvelope } : {})
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
   * Returns bounded planning-query facts plus hidden decision records from the shared read seam.
   *
   * @param queryInput - Current query used for bounded relevance ranking.
   * @param maxFacts - Maximum number of facts to surface.
   * @param asOfValidTime - Optional valid-time boundary for proof records.
   * @param asOfObservedTime - Optional observed-time boundary for proof records.
   * @returns Selected readable facts plus hidden bounded decision records.
   */
  async inspectFactsForPlanningContext(
    queryInput = "",
    maxFacts = 6,
    asOfValidTime?: string,
    asOfObservedTime?: string
  ) {
    return (await this.openReadSession()).inspectFactsForPlanningContext({
      queryInput,
      maxFacts,
      asOfValidTime,
      asOfObservedTime
    });
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
   * Returns bounded approval-aware fact-review entries for the existing private review posture.
   *
   * @param queryInput - Optional query text used for relevance ranking.
   * @param maxFacts - Maximum number of reviewable facts to surface.
   * @param nowIso - Timestamp used to mint the bounded approval handle.
   * @returns Reviewable facts plus hidden decision records.
   */
  async reviewFactsForUser(
    queryInput = "",
    maxFacts = 5,
    nowIso = new Date().toISOString()
  ): Promise<ProfileFactReviewResult> {
    return (await this.openReadSession()).reviewFactsForUser({
      queryInput,
      maxFacts,
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: `memory_review:${nowIso}`
    });
  }

  /**
   * Applies one bounded explicit user-driven fact review mutation against canonical truth.
   *
   * Correction overrides are limited to current-state-eligible families; forget/delete remains
   * available for any targeted visible fact because it retracts rather than creates truth.
   *
   * @param request - Fact-review mutation request.
   * @returns Updated readable fact plus bounded mutation proof, or `null` when the fact is absent.
   */
  async mutateFactFromUser(
    request: ProfileFactReviewMutationRequest
  ): Promise<ProfileFactReviewMutationResult> {
    const state = await this.load();
    const targetFact = state.facts.find(
      (fact) => fact.id === request.factId && fact.status !== "superseded" && fact.supersededAt === null
    );
    if (!targetFact) {
      return {
        fact: null
      };
    }

    const family = inferGovernanceFamilyForNormalizedKey(
      targetFact.key.trim().toLowerCase(),
      targetFact.value
    );

    if (request.action === "correct") {
      const replacementValue = normalizeProfileValue(request.replacementValue ?? "");
      if (!replacementValue) {
        throw new Error("Fact correction requires a non-empty replacement value.");
      }
      if (!isCurrentStateEligibleFamily(family)) {
        throw new Error(
          `Fact family ${family} does not support correction override through bounded fact review.`
        );
      }

      const applyResult = upsertTemporalProfileFact(state, {
        key: targetFact.key,
        value: replacementValue,
        sensitive: resolveProfileMemoryEffectiveSensitivity(
          targetFact.key,
          targetFact.sensitive,
          family
        ),
        sourceTaskId: request.sourceTaskId,
        source: MEMORY_REVIEW_FACT_CORRECTION_SOURCE,
        observedAt: request.nowIso,
        confidence: 1,
        mutationAudit: null
      });
      if (!applyResult.applied) {
        throw new Error(
          "Fact correction did not produce a canonical successor under profile-memory displacement policy."
        );
      }
      const mutationEnvelope = buildProfileMemoryFactReviewMutationEnvelope({
        fact: targetFact,
        sourceTaskId: request.sourceTaskId,
        sourceText: request.sourceText,
        observedAt: request.nowIso,
        action: "correct",
        resultingFact: applyResult.upsertedFact
      });
      const graphMutationResult = applyProfileMemoryGraphMutations({
        state: applyResult.nextState,
        factDecisions: [buildFactReviewCorrectionGraphDecision(applyResult.upsertedFact)],
        touchedEpisodes: [],
        sourceTaskId: request.sourceTaskId,
        sourceFingerprint: buildProfileMemorySourceFingerprint(request.sourceText),
        mutationEnvelopeHash: sha256HexFromCanonicalJson(mutationEnvelope),
        recordedAt: request.nowIso
      });
      await this.save(graphMutationResult.nextState);
      const fact = this.findReadableFactById(
        graphMutationResult.nextState,
        applyResult.upsertedFact.id,
        request.nowIso
      );
      return {
        fact,
        mutationEnvelope
      };
    }

    const nextState: ProfileMemoryState = {
      ...state,
      updatedAt: request.nowIso,
      facts: state.facts.filter((fact) => fact.id !== request.factId)
    };
    const mutationEnvelope = buildProfileMemoryFactReviewMutationEnvelope({
      fact: targetFact,
      sourceTaskId: request.sourceTaskId,
      sourceText: request.sourceText,
      observedAt: request.nowIso,
      action: "forget"
    });
    const graphMutationResult = applyProfileMemoryGraphMutations({
      state: nextState,
      factDecisions: [],
      touchedEpisodes: [],
      redactedFacts: [targetFact],
      sourceTaskId: request.sourceTaskId,
      sourceFingerprint: buildProfileMemorySourceFingerprint(request.sourceText),
      mutationEnvelopeHash: sha256HexFromCanonicalJson(mutationEnvelope),
      recordedAt: request.nowIso
    });
    await this.save(graphMutationResult.nextState);
    return {
      fact: toReadableFact(targetFact),
      mutationEnvelope
    };
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
   * @returns Updated readable episode plus bounded mutation proof, or a null episode when the
   * target is unavailable.
   */
  async updateEpisodeFromUser(
    episodeId: string,
    status: ProfileEpisodeResolutionStatus,
    sourceTaskId: string,
    sourceText: string,
    note?: string,
    nowIso = new Date().toISOString()
  ): Promise<ProfileEpisodeReviewMutationResult> {
    const state = await this.load();
    if (!state.episodes.some((episode) => episode.id === episodeId)) {
      return {
        episode: null
      };
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
    const episode = this.findReadableEpisodeById(applyResult.nextState, episodeId);
    if (applyResult.resolvedEpisodes === 0) {
      return {
        episode
      };
    }

    const mutationEnvelope = buildProfileMemoryReviewMutationEnvelope({
      episodeId,
      sourceTaskId,
      sourceText,
      observedAt: nowIso,
      action: status === "no_longer_relevant" ? "wrong" : "resolve",
      resultingEpisode: applyResult.nextState.episodes.find((entry) => entry.id === episodeId)
    });
    const graphMutationResult = applyProfileMemoryGraphMutations({
      state: applyResult.nextState,
      factDecisions: [],
      touchedEpisodes: applyResult.nextState.episodes.filter((entry) =>
        applyResult.touchedEpisodeIds.includes(entry.id)
      ),
      sourceFingerprint: buildProfileMemorySourceFingerprint(sourceText),
      mutationEnvelopeHash: sha256HexFromCanonicalJson(mutationEnvelope),
      recordedAt: nowIso
    });
    await this.save(graphMutationResult.nextState);
    return {
      episode,
      mutationEnvelope
    };
  }

  /**
   * Forgets one remembered episodic-memory record entirely.
   *
   * @param episodeId - Episode identifier targeted by the user.
   * @param nowIso - Timestamp applied to the mutation.
   * @returns Removed readable episode plus bounded mutation proof, or a null episode when no
   * matching episode exists.
   */
  async forgetEpisodeFromUser(
    episodeId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso = new Date().toISOString()
  ): Promise<ProfileEpisodeReviewMutationResult> {
    const state = await this.load();
    const removedEpisode = state.episodes.find((episode) => episode.id === episodeId);
    if (!removedEpisode) {
      return {
        episode: null
      };
    }

    const nextState: ProfileMemoryState = {
      ...state,
      updatedAt: nowIso,
      episodes: state.episodes.filter((episode) => episode.id !== episodeId)
    };
    const mutationEnvelope = buildProfileMemoryReviewMutationEnvelope({
      episodeId,
      sourceTaskId,
      sourceText,
      observedAt: nowIso,
      action: "forget"
    });
    const graphMutationResult = applyProfileMemoryGraphMutations({
      state: nextState,
      factDecisions: [],
      touchedEpisodes: [],
      redactedEpisodes: [removedEpisode],
      sourceTaskId,
      sourceFingerprint: buildProfileMemorySourceFingerprint(sourceText),
      mutationEnvelopeHash: sha256HexFromCanonicalJson(mutationEnvelope),
      recordedAt: nowIso
    });
    await this.save(graphMutationResult.nextState);
    return {
      episode: toReadableEpisode(removedEpisode),
      mutationEnvelope
    };
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
   * Returns graph-backed truth grouped by effective personal-memory stable ref.
   *
   * **Why it exists:**
   * Phase 5a needs one public store seam that surfaces self/contact identity grouping before
   * Stage 6.86 alignment or full temporal retrieval cutover.
   *
   * **What it talks to:**
   * - Uses `queryProfileMemoryGraphStableRefGroups` (import
   *   `queryProfileMemoryGraphStableRefGroups`) from
   *   `./profileMemoryRuntime/profileMemoryGraphQueries`.
   *
   * @returns Stable-ref groups derived from canonical graph-backed state.
   */
  async queryGraphStableRefGroups(): Promise<readonly ProfileMemoryGraphStableRefGroup[]> {
    return queryProfileMemoryGraphStableRefGroups((await this.load()).graph);
  }

  /**
   * Returns graph-backed stable-ref groups with bounded Stage 6.86 entity-key attachment.
   *
   * **Why it exists:**
   * Phase 5b needs one additive public seam that can expose conservative `primaryEntityKey` /
   * `observedEntityKey` alignment while keeping truth ownership inside encrypted profile memory.
   *
   * **What it talks to:**
   * - Uses `queryProfileMemoryGraphAlignedStableRefGroups` (import
   *   `queryProfileMemoryGraphAlignedStableRefGroups`) from
   *   `./profileMemoryRuntime/profileMemoryGraphAlignmentSupport`.
   *
   * @param entityGraph - Shared Stage 6.86 entity graph snapshot used only for bounded alignment.
   * @returns Stable-ref groups annotated with conservative entity-key attachment.
   */
  async queryAlignedGraphStableRefGroups(
    entityGraph: EntityGraphV1
  ): Promise<readonly ProfileMemoryGraphAlignedStableRefGroup[]> {
    return queryProfileMemoryGraphAlignedStableRefGroups({
      graph: (await this.load()).graph,
      entityGraph
    });
  }

  /**
   * Returns only current-surface-eligible graph claims whose stable refs are resolved-current.
   *
   * **Why it exists:**
   * Phase 5a must keep provisional or quarantined identity out of resolved-current outputs until
   * later alignment or policy explicitly promotes it.
   *
   * **What it talks to:**
   * - Uses `queryProfileMemoryGraphResolvedCurrentClaims` (import
   *   `queryProfileMemoryGraphResolvedCurrentClaims`) from
   *   `./profileMemoryRuntime/profileMemoryGraphQueries`.
   *
   * @returns Resolved-current graph claim records.
   */
  async queryResolvedCurrentGraphClaims(): Promise<readonly ProfileMemoryGraphClaimRecord[]> {
    return queryProfileMemoryGraphResolvedCurrentClaims((await this.load()).graph);
  }

  /**
   * Rekeys one explicit personal-memory stable-ref lane without invoking Stage 6.86 merge logic.
   *
   * **Why it exists:**
   * Phase 5a needs a bounded deterministic rekey seam that can rewrite already-issued stable refs
   * inside personal memory while keeping truth ownership local to the encrypted profile-memory
   * store.
   *
   * **What it talks to:**
   * - Uses `applyProfileMemoryGraphStableRefRekey` (import
   *   `applyProfileMemoryGraphStableRefRekey`) from
   *   `./profileMemoryRuntime/profileMemoryGraphMutations`.
   *
   * @param fromStableRefId - Existing stable ref to rewrite.
   * @param toStableRefId - Replacement stable ref id.
   * @param sourceTaskId - Canonical source task id for the explicit rekey request.
   * @param sourceText - Bounded operator text describing the rekey.
   * @param nowIso - Timestamp applied to the mutation.
   * @returns Change flag plus bounded mutation proof when a rekey occurs.
   */
  async rekeyGraphStableRef(
    fromStableRefId: string,
    toStableRefId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso = new Date().toISOString()
  ): Promise<{
    changed: boolean;
    mutationEnvelope?: {
      schemaVersion: "v1";
      action: "stable_ref_rekey";
      fromStableRefId: string;
      toStableRefId: string;
      sourceTaskId: string;
      sourceText: string;
      observedAt: string;
    };
  }> {
    const normalizedFromStableRefId = fromStableRefId.trim();
    const normalizedToStableRefId = toStableRefId.trim();
    if (!normalizedFromStableRefId.startsWith("stable_")) {
      throw new Error("Stable-ref rekey requires a canonical source stable ref id.");
    }
    if (!normalizedToStableRefId.startsWith("stable_")) {
      throw new Error("Stable-ref rekey requires a canonical replacement stable ref id.");
    }
    if (normalizedFromStableRefId === normalizedToStableRefId) {
      return { changed: false };
    }
    const state = await this.load();
    const mutationEnvelope = {
      schemaVersion: "v1" as const,
      action: "stable_ref_rekey" as const,
      fromStableRefId: normalizedFromStableRefId,
      toStableRefId: normalizedToStableRefId,
      sourceTaskId,
      sourceText,
      observedAt: nowIso
    };
    const rekeyResult = applyProfileMemoryGraphStableRefRekey({
      state,
      fromStableRefId: normalizedFromStableRefId,
      toStableRefId: normalizedToStableRefId,
      sourceTaskId,
      sourceFingerprint: buildProfileMemorySourceFingerprint(sourceText),
      mutationEnvelopeHash: sha256HexFromCanonicalJson(mutationEnvelope),
      recordedAt: nowIso
    });
    if (!rekeyResult.changed) {
      return { changed: false };
    }
    await this.save(rekeyResult.nextState);
    return {
      changed: true,
      mutationEnvelope
    };
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

  /**
   * Finds one readable fact by identifier under the existing approval-aware fact projection rules.
   *
   * @param state - Loaded profile-memory state.
   * @param factId - Target fact identifier.
   * @param nowIso - Timestamp used to mint the bounded approval handle.
   * @returns Readable fact, or `null` when absent.
   */
  private findReadableFactById(
    state: ProfileMemoryState,
    factId: string,
    nowIso: string
  ): ProfileReadableFact | null {
    return readProfileFacts(state, {
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: `memory_review:${nowIso}`,
      maxFacts: Math.max(20, state.facts.length)
    }).find((fact) => fact.factId === factId) ?? null;
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

/**
 * Converts one stored fact into the bounded operator-facing review shape.
 *
 * @param fact - Stored fact record.
 * @returns Readable fact payload used by fact-review mutation results.
 */
function toReadableFact(
  fact: ProfileMemoryState["facts"][number]
): ProfileReadableFact {
  const family = inferGovernanceFamilyForNormalizedKey(
    fact.key.trim().toLowerCase(),
    fact.value
  );
  return {
    factId: fact.id,
    key: fact.key,
    value: fact.value,
    status: fact.status,
    sensitive: resolveProfileMemoryEffectiveSensitivity(
      fact.key,
      fact.sensitive,
      family
    ),
    observedAt: fact.observedAt,
    lastUpdatedAt: fact.lastUpdatedAt,
    confidence: fact.confidence,
    mutationAudit: fact.mutationAudit
  };
}

/**
 * Evaluates whether one governed family may accept explicit fact-correction overrides.
 *
 * @param family - Canonical governed family under evaluation.
 * @returns `true` when bounded fact review may create replacement truth for the family.
 */
function isCurrentStateEligibleFamily(
  family: ReturnType<typeof inferGovernanceFamilyForNormalizedKey>
): boolean {
  return getProfileMemoryFamilyRegistryEntry(family).currentStateEligible;
}

/**
 * Builds one bounded governed fact decision for explicit review-driven correction so the stable
 * graph mutation seam can persist the same current-state change as the flat compatibility surface.
 *
 * @param fact - Canonical successor fact produced by bounded review correction.
 * @returns Governed fact decision compatible with graph observation and claim persistence.
 */
function buildFactReviewCorrectionGraphDecision(
  fact: ProfileFactUpsertInput & { id: string }
): GovernedProfileFactCandidate {
  return {
    candidate: {
      key: fact.key,
      value: fact.value,
      sensitive: fact.sensitive,
      sourceTaskId: fact.sourceTaskId,
      source: fact.source,
      observedAt: fact.observedAt
    },
    decision: {
      family: inferGovernanceFamilyForNormalizedKey(
        fact.key.trim().toLowerCase(),
        fact.value
      ),
      evidenceClass: "user_explicit_fact",
      action: "allow_current_state",
      reason: "memory_review_correction_override"
    }
  };
}

