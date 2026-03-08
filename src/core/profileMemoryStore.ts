/**
 * @fileoverview Persists encrypted local profile memory with deterministic temporal freshness and access controls.
 */

import {
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
  buildProfilePlanningContext,
  readProfileFacts
} from "./profileMemoryRuntime/profileMemoryQueries";
import {
  extractProfileFactCandidatesFromUserInput
} from "./profileMemoryRuntime/profileMemoryExtraction";
import {
  createProfileMemoryPersistenceConfigFromEnv,
  loadPersistedProfileMemoryState,
  saveProfileMemoryState
} from "./profileMemoryRuntime/profileMemoryPersistence";
import {
  applyProfileFactCandidates,
  buildInferredCommitmentResolutionCandidates,
  buildStateReconciliationResolutionCandidates,
  countUnresolvedCommitments,
  extractUnresolvedCommitmentTopics
} from "./profileMemoryRuntime/profileMemoryMutations";
import {
  applyRelationshipAwareTemporalNudging,
  assessContextDrift,
  assessRelationshipRole,
  countStaleActiveFacts
} from "./profileMemoryRuntime/profileMemoryPulse";
import {
  type AgentPulseEvaluationRequest,
  type AgentPulseEvaluationResult,
  type ProfileAccessRequest,
  type ProfileIngestResult,
  type ProfileReadableFact
} from "./profileMemoryRuntime/contracts";

export type {
  AgentPulseEvaluationRequest,
  AgentPulseEvaluationResult,
  ProfileAccessRequest,
  ProfileIngestResult,
  ProfileReadableFact
} from "./profileMemoryRuntime/contracts";

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
  async load(): Promise<ProfileMemoryState> {
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

    if (shouldPersist) {
      await this.save(nextState);
    }
    return nextState;
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
    observedAt: string
  ): Promise<ProfileIngestResult> {
    const state = await this.load();
    const extractedCandidates = extractProfileFactCandidatesFromUserInput(
      userInput,
      taskId,
      observedAt
    );
    const inferredResolutionCandidates = buildInferredCommitmentResolutionCandidates(
      state,
      userInput,
      taskId,
      observedAt
    );
    const candidates = [
      ...extractedCandidates,
      ...inferredResolutionCandidates
    ];
    const applyResult = applyProfileFactCandidates(state, candidates);
    if (applyResult.appliedFacts === 0) {
      return {
        appliedFacts: 0,
        supersededFacts: 0
      };
    }

    await this.save(applyResult.nextState);
    return {
      appliedFacts: applyResult.appliedFacts,
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
    const state = await this.load();
    return buildProfilePlanningContext(state, maxFacts, queryInput);
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
      overrideQuietHours: request.overrideQuietHours === true
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
    const state = await this.load();
    return readProfileFacts(state, request);
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
}
