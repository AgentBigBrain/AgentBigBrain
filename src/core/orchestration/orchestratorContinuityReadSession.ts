/**
 * @fileoverview Opens bounded continuity read sessions over one shared profile-memory snapshot.
 */

import type { ProfileMemoryStore } from "../profileMemoryStore";
import type {
  ProfileReadableFact
} from "../profileMemoryRuntime/contracts";
import type { LinkedProfileEpisodeRecord } from "../profileMemoryRuntime/profileMemoryEpisodeLinking";
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
    maxEpisodes?: number
  ): Promise<readonly LinkedProfileEpisodeRecord[]>;
  queryContinuityFacts(
    stack: ConversationStackV1,
    entityHints: readonly string[],
    maxFacts?: number
  ): Promise<readonly ProfileReadableFact[]>;
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
        maxEpisodes = 3
      ) =>
        readSession.queryEpisodesForContinuity(graph, stack, {
          entityHints,
          maxEpisodes
        }),
      queryContinuityFacts: async (
        stack: ConversationStackV1,
        entityHints: readonly string[],
        maxFacts = 3
      ) =>
        readSession.queryFactsForContinuity(graph, stack, {
          entityHints,
          maxFacts
        })
    };
  } catch {
    return null;
  }
}
