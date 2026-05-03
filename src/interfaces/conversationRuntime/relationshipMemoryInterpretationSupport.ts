/**
 * @fileoverview Model-confirmed relationship memory candidate support for direct conversation turns.
 */

import {
  buildValidatedSemanticRelationshipFactCandidates
} from "../../core/profileMemoryRuntime/profileMemoryExtraction";
import type {
  ProfileValidatedFactCandidateInput
} from "../../core/profileMemoryRuntime/contracts";
import type {
  CreateProfileEpisodeRecordInput
} from "../../core/profileMemoryRuntime/profileMemoryEpisodeContracts";
import type {
  RelationshipInterpretationEpisodeCandidate,
  RelationshipInterpretationResolver
} from "../../organs/languageUnderstanding/localIntentModelContracts";
import {
  routeRelationshipInterpretationModel
} from "../../organs/languageUnderstanding/localIntentModelRouter";
import type { RoutingMapClassificationV1 } from "../routingMap";
import type { ConversationSession } from "../sessionStore";
import { buildLocalIntentSessionHints } from "./conversationRoutingSupport";

const MAX_RELATIONSHIP_INTERPRETATION_RECENT_TURNS = 6;

export interface RelationshipMemoryInterpretationCandidates {
  validatedFactCandidates: readonly ProfileValidatedFactCandidateInput[];
  additionalEpisodeCandidates: readonly CreateProfileEpisodeRecordInput[];
}

/**
 * Builds bounded recent-turn context for the relationship interpreter.
 *
 * @param session - Current conversation session.
 * @returns Recent user/assistant turns safe for local semantic interpretation.
 */
function buildRelationshipInterpretationRecentTurns(
  session: ConversationSession
): readonly { role: "user" | "assistant"; text: string }[] {
  return session.conversationTurns
    .slice(-MAX_RELATIONSHIP_INTERPRETATION_RECENT_TURNS)
    .map((turn) => ({
      role: turn.role,
      text: turn.text
    }));
}

/**
 * Asks the optional semantic relationship interpreter for typed memory candidates.
 *
 * The caller may use lexical relationship cues to decide whether this interpreter is worth calling,
 * but memory authority comes only from typed candidates returned here and accepted by governance.
 *
 * @param input - Current direct-conversation turn context.
 * @returns Validated fact candidates safe for the profile-memory write seam.
 */
export async function buildRelationshipValidatedFactCandidates(input: {
  session: ConversationSession;
  userInput: string;
  receivedAt: string;
  routingClassification: RoutingMapClassificationV1 | null;
  relationshipInterpretationResolver?: RelationshipInterpretationResolver;
}): Promise<RelationshipMemoryInterpretationCandidates> {
  const interpreted = await routeRelationshipInterpretationModel(
    {
      userInput: input.userInput,
      routingClassification: input.routingClassification,
      sessionHints: buildLocalIntentSessionHints(input.session),
      recentTurns: buildRelationshipInterpretationRecentTurns(input.session)
    },
    input.relationshipInterpretationResolver
  );
  if (
    !interpreted ||
    interpreted.kind !== "relationship_candidates" ||
    interpreted.confidence === "low"
  ) {
    return {
      validatedFactCandidates: [],
      additionalEpisodeCandidates: []
    };
  }
  return {
    validatedFactCandidates: buildValidatedSemanticRelationshipFactCandidates(interpreted.candidates),
    additionalEpisodeCandidates: buildSemanticEpisodeCandidates(
      interpreted.episodeCandidates ?? [],
      input.receivedAt
    )
  };
}

/**
 * Converts typed semantic episode candidates into canonical profile-memory episode candidates.
 *
 * @param candidates - Model-confirmed event candidates emitted by the relationship interpreter.
 * @param observedAt - Observation timestamp for the current conversation turn.
 * @returns Bounded episode candidates safe for governed profile-memory ingest.
 */
function buildSemanticEpisodeCandidates(
  candidates: readonly RelationshipInterpretationEpisodeCandidate[],
  observedAt: string
): readonly CreateProfileEpisodeRecordInput[] {
  return candidates
    .map((candidate): CreateProfileEpisodeRecordInput | null => {
      const title = candidate.title.trim();
      const summary = candidate.summary.trim();
      const evidenceText = candidate.evidenceText.trim();
      if (!title || !summary || !evidenceText || title.length > 120 || summary.length > 320) {
        return null;
      }
      return {
        title,
        summary,
        sourceTaskId: `conversation_episode_interpretation:${observedAt}`,
        source: "conversation.episode_interpretation",
        sourceKind: "assistant_inference",
        sensitive: candidate.sensitive === true,
        observedAt,
        confidence: candidate.confidence ?? 0.85,
        entityRefs: candidate.entityRefs ?? [],
        tags: candidate.tags ?? []
      };
    })
    .filter((candidate): candidate is CreateProfileEpisodeRecordInput => candidate !== null);
}
