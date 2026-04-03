/**
 * @fileoverview Builds bounded per-turn continuity query wrappers over an optional shared read session.
 */

import type {
  ConversationContinuityReadSession,
  OpenConversationContinuityReadSession,
  QueryConversationContinuityEpisodes,
  QueryConversationContinuityFacts
} from "./managerContracts";

export interface BoundConversationContinuityQueries {
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  queryContinuityFacts?: QueryConversationContinuityFacts;
}

interface BuildBoundConversationContinuityQueriesInput {
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  queryContinuityFacts?: QueryConversationContinuityFacts;
  openContinuityReadSession?: OpenConversationContinuityReadSession;
}

/**
 * Lazily binds continuity queries to one optional shared read session for the current turn.
 *
 * When the read session is unavailable or fails closed, the wrappers fall back to the existing
 * independent continuity callbacks so current call sites remain compatible.
 *
 * @param input - Existing continuity callbacks plus the optional shared-session opener.
 * @returns Continuity query wrappers scoped to one execution-input build.
 */
export function buildBoundConversationContinuityQueries(
  input: BuildBoundConversationContinuityQueriesInput
): BoundConversationContinuityQueries {
  let sessionPromise: Promise<ConversationContinuityReadSession | null> | null = null;

  /**
   * Resolves the optional shared continuity session once for the current execution-input build.
   *
   * @returns Shared read session, or `null` when unavailable.
   */
  async function resolveSession(): Promise<ConversationContinuityReadSession | null> {
    if (!input.openContinuityReadSession) {
      return null;
    }
    sessionPromise ??= input.openContinuityReadSession().catch(() => null);
    return sessionPromise;
  }

  return {
    queryContinuityEpisodes:
      input.queryContinuityEpisodes || input.openContinuityReadSession
        ? async (request) => {
            const session = await resolveSession();
            if (session) {
              return session.queryContinuityEpisodes(request);
            }
            return input.queryContinuityEpisodes
              ? input.queryContinuityEpisodes(request)
              : [];
          }
        : undefined,
    queryContinuityFacts:
      input.queryContinuityFacts || input.openContinuityReadSession
        ? async (request) => {
            const session = await resolveSession();
            if (session) {
              return session.queryContinuityFacts(request);
            }
            return input.queryContinuityFacts
              ? input.queryContinuityFacts(request)
              : [];
          }
        : undefined
  };
}
