/**
 * @fileoverview Request-scoped read-session helpers for reusing one reconciled profile-memory snapshot.
 */

import type { ProfileMemoryState } from "../profileMemory";
import type {
  ConversationStackV1,
  EntityGraphV1
} from "../types";
import type {
  ProfileAccessRequest,
  ProfileFactPlanningInspectionRequest,
  ProfileFactPlanningInspectionResult,
  ProfileFactReviewRequest,
  ProfileFactReviewResult,
  ProfileReadableEpisode,
  ProfileReadableFact
} from "./contracts";
import {
  buildProfileEpisodePlanningContext,
  selectProfileEpisodesForPlanningQuery
} from "./profileMemoryEpisodePlanningContext";
import {
  queryProfileEpisodesForContinuity,
  readProfileEpisodes,
  type ProfileEpisodeContinuityQueryRequest
} from "./profileMemoryEpisodeQueries";
import type { LinkedProfileEpisodeRecord } from "./profileMemoryEpisodeLinking";
import {
  buildProfilePlanningContext,
  inspectProfileFactsForPlanningContext,
  queryProfileFactsForContinuity,
  readProfileFacts,
  reviewProfileFactsForUser
} from "./profileMemoryQueries";
import { queryProfileTemporalPlanningSynthesis } from "./profileMemoryPlanningSynthesis";
import type {
  ProfileFactContinuityQueryRequest,
  ProfileFactContinuityResult
} from "./profileMemoryQueryContracts";
import type { TemporalMemorySynthesis } from "./profileMemoryTemporalQueryContracts";

/**
 * Stable request-scoped read facade over one already-reconciled profile-memory snapshot.
 *
 * Reads through this facade must stay pure: they may rank, filter, and project, but they must not
 * persist or mutate canonical truth.
 */
export class ProfileMemoryReadSession {
  /**
   * Creates a request-scoped facade over one reconciled profile-memory snapshot.
   *
   * @param state - Loaded profile-memory snapshot that is already normalized/reconciled.
   * @param staleAfterDays - Staleness policy reused by episode ranking helpers.
   */
  constructor(
    private readonly state: ProfileMemoryState,
    private readonly staleAfterDays: number
  ) {}

  /**
   * Builds planner-facing fact context from the shared request snapshot.
   *
   * @param maxFacts - Maximum number of facts to include.
   * @param queryInput - Current query text used for ranking.
   * @returns Rendered planning-context block.
   */
  getPlanningContext(maxFacts = 6, queryInput = ""): string {
    return buildProfilePlanningContext(this.state, maxFacts, queryInput);
  }

  /**
   * Returns bounded readable facts for query-aware planning from the shared request snapshot.
   *
   * @param maxFacts - Maximum number of facts to return.
   * @param queryInput - Current query text used for ranking.
   * @returns Deterministically selected readable facts.
   */
  queryFactsForPlanningContext(
    maxFacts = 6,
    queryInput = ""
  ): readonly ProfileReadableFact[] {
    return inspectProfileFactsForPlanningContext(this.state, {
      queryInput,
      maxFacts
    }).entries.map((entry) => entry.fact);
  }

  /**
   * Returns bounded planning-query facts plus decision-record proof from the shared request
   * snapshot.
   *
   * @param request - Planning inspection request with optional as-of controls.
   * @returns Selected readable facts plus hidden decision records.
   */
  inspectFactsForPlanningContext(
    request: ProfileFactPlanningInspectionRequest
  ): ProfileFactPlanningInspectionResult {
    return inspectProfileFactsForPlanningContext(this.state, request);
  }

  /**
   * Builds planner-facing canonical temporal synthesis from the shared request snapshot.
   *
   * @param queryInput - Current query text used for graph-backed temporal retrieval.
   * @param asOfObservedTime - Optional observed-time boundary for the bounded temporal proof.
   * @returns Canonical temporal synthesis or `null` when nothing relevant is available.
   */
  queryTemporalPlanningSynthesis(
    queryInput = "",
    asOfObservedTime = this.state.updatedAt
  ): TemporalMemorySynthesis | null {
    return queryProfileTemporalPlanningSynthesis(this.state, {
      queryInput,
      asOfObservedTime
    });
  }

  /**
   * Builds planner-facing episodic context from the shared request snapshot.
   *
   * @param maxEpisodes - Maximum number of episodes to include.
   * @param queryInput - Current query text used for ranking.
   * @param nowIso - Timestamp used for lifecycle ordering.
   * @returns Rendered episodic-memory planning context.
   */
  getEpisodePlanningContext(
    maxEpisodes = 2,
    queryInput = "",
    nowIso = this.state.updatedAt
  ): string {
    return buildProfileEpisodePlanningContext(
      this.state,
      maxEpisodes,
      queryInput,
      nowIso,
      this.staleAfterDays
    );
  }

  /**
   * Returns bounded readable episodes for query-aware planning from the shared request snapshot.
   *
   * @param maxEpisodes - Maximum number of episodes to return.
   * @param queryInput - Current query text used for ranking.
   * @param nowIso - Timestamp used for lifecycle ordering.
   * @returns Deterministically selected readable episodes.
   */
  queryEpisodesForPlanningContext(
    maxEpisodes = 2,
    queryInput = "",
    nowIso = this.state.updatedAt
  ): readonly ProfileReadableEpisode[] {
    return selectProfileEpisodesForPlanningQuery(
      this.state,
      maxEpisodes,
      queryInput,
      nowIso,
      this.staleAfterDays
    ).map((episode) => ({
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
    }));
  }

  /**
   * Returns readable facts under approval-aware gating from the shared request snapshot.
   *
   * @param request - Fact read request.
   * @returns Readable facts.
   */
  readFacts(request: ProfileAccessRequest): ProfileReadableFact[] {
    return readProfileFacts(this.state, request);
  }

  /**
   * Returns bounded approval-aware fact-review entries from the shared request snapshot.
   *
   * @param request - Fact-review request with query, approval, and as-of controls.
   * @returns Reviewable fact entries plus hidden decision records.
   */
  reviewFactsForUser(request: ProfileFactReviewRequest): ProfileFactReviewResult {
    return reviewProfileFactsForUser(this.state, request);
  }

  /**
   * Returns continuity-ranked readable facts from the shared request snapshot.
   *
   * @param graph - Current entity graph. Present for signature parity with the stable store surface.
   * @param stack - Current conversation stack. Present for signature parity with the stable store surface.
   * @param request - Continuity request.
   * @returns Deterministically selected readable facts.
   */
  queryFactsForContinuity(
    graph: EntityGraphV1,
    stack: ConversationStackV1,
    request: ProfileFactContinuityQueryRequest
  ): ProfileFactContinuityResult {
    return queryProfileFactsForContinuity(this.state, graph, request, stack);
  }

  /**
   * Returns readable episodic-memory records under approval-aware gating from the shared snapshot.
   *
   * @param request - Episode read request.
   * @param nowIso - Timestamp used for lifecycle ordering.
   * @returns Readable episodes.
   */
  readEpisodes(
    request: ProfileAccessRequest,
    nowIso = this.state.updatedAt
  ): ProfileReadableEpisode[] {
    return readProfileEpisodes(this.state, request, nowIso, this.staleAfterDays);
  }

  /**
   * Returns continuity-ranked episodic-memory records from the shared request snapshot.
   *
   * @param graph - Current entity graph.
   * @param stack - Current conversation stack.
   * @param request - Continuity request.
   * @param nowIso - Timestamp used for lifecycle ordering.
   * @returns Deterministically ranked linked episodic-memory records.
   */
  queryEpisodesForContinuity(
    graph: EntityGraphV1,
    stack: ConversationStackV1,
    request: ProfileEpisodeContinuityQueryRequest,
    nowIso = this.state.updatedAt
  ): readonly LinkedProfileEpisodeRecord[] {
    return queryProfileEpisodesForContinuity(
      this.state,
      graph,
      stack,
      request,
      nowIso,
      this.staleAfterDays
    );
  }
}

/**
 * Creates one request-scoped read facade over an already-reconciled profile-memory snapshot.
 *
 * @param state - Loaded profile-memory snapshot.
 * @param staleAfterDays - Staleness policy reused by read helpers.
 * @returns Request-scoped read session.
 */
export function createProfileMemoryReadSession(
  state: ProfileMemoryState,
  staleAfterDays: number
): ProfileMemoryReadSession {
  return new ProfileMemoryReadSession(state, staleAfterDays);
}
