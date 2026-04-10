/**
 * @fileoverview Opens bounded continuity read sessions over one shared profile-memory snapshot.
 */

import type { ProfileMemoryStore } from "../profileMemoryStore";
import type { LinkedProfileEpisodeRecord } from "../profileMemoryRuntime/profileMemoryEpisodeLinking";
import type { ProfileEpisodeContinuityQueryRequest } from "../profileMemoryRuntime/profileMemoryEpisodeQueries";
import type {
  ProfileFactContinuityQueryRequest,
  ProfileFactContinuityResult
} from "../profileMemoryRuntime/profileMemoryQueryContracts";
import type {
  ConversationStackV1,
  EntityGraphV1
} from "../types";

export interface OpenOrchestratorContinuityReadSessionDependencies {
  profileMemoryStore?: Pick<ProfileMemoryStore, "openReadSession">;
}

export interface OrchestratorContinuityReadSession {
  queryContinuityEpisodes(
    stack: ConversationStackV1,
    entityHints: readonly string[],
    maxEpisodes?: number,
    requestOptions?: Omit<ProfileEpisodeContinuityQueryRequest, "entityHints" | "maxEpisodes">
  ): Promise<readonly LinkedProfileEpisodeRecord[]>;
  queryContinuityFacts(
    stack: ConversationStackV1,
    entityHints: readonly string[],
    maxFacts?: number,
    requestOptions?: Omit<ProfileFactContinuityQueryRequest, "entityHints" | "maxFacts">
  ): Promise<ProfileFactContinuityResult>;
}

/**
 * Opens one continuity read session that reuses a shared reconciled profile-memory snapshot for
 * bounded continuity reads during one request.
 *
 * @param deps - Orchestrator continuity collaborators.
 * @param graph - Current Stage 6.86 entity graph reused across this request.
 * @returns Shared continuity read session, or `null` when profile memory is unavailable.
 */
export async function openOrchestratorContinuityReadSession(
  deps: OpenOrchestratorContinuityReadSessionDependencies,
  graph: EntityGraphV1
): Promise<OrchestratorContinuityReadSession | null> {
  if (!deps.profileMemoryStore) {
    return null;
  }

  try {
    const readSession = await deps.profileMemoryStore.openReadSession();
    return {
      queryContinuityEpisodes: async (
        stack: ConversationStackV1,
        entityHints: readonly string[],
        maxEpisodes = 3,
        requestOptions: Omit<ProfileEpisodeContinuityQueryRequest, "entityHints" | "maxEpisodes"> = {}
      ) =>
        readSession.queryEpisodesForContinuity(graph, stack, {
          entityHints,
          maxEpisodes,
          ...requestOptions
        }),
      queryContinuityFacts: async (
        stack: ConversationStackV1,
        entityHints: readonly string[],
        maxFacts = 3,
        requestOptions: Omit<ProfileFactContinuityQueryRequest, "entityHints" | "maxFacts"> = {}
      ) =>
        readSession.queryFactsForContinuity(graph, stack, {
          entityHints,
          maxFacts,
          ...requestOptions
        })
    };
  } catch {
    return null;
  }
}
