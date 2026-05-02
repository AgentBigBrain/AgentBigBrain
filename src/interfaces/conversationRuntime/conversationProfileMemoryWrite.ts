/**
 * @fileoverview Shared helpers for building bounded conversational profile-memory ingest requests.
 */

import type { ConversationSession } from "../sessionStore";
import type { ConversationInboundMediaEnvelope } from "../mediaRuntime/contracts";
import type {
  ProfileMemoryIngestRequest,
  ProfileValidatedFactCandidateInput
} from "../../core/profileMemoryRuntime/contracts";
import {
  buildProfileMediaIngestInputFromEnvelope
} from "../../core/profileMemory";
import {
  buildProfileMemoryIngestPolicy
} from "../../core/profileMemoryRuntime/profileMemoryIngestPolicy";
import {
  buildConversationProfileMemoryTurnId,
  buildProfileMemorySourceFingerprint
} from "../../core/profileMemoryRuntime/profileMemoryIngestProvenance";
import type { ConversationRouteMemoryIntent } from "./intentModeContracts";

export interface ConversationProfileMemoryWriteRequestInput {
  session: ConversationSession;
  receivedAt: string;
  userInput?: string;
  media?: ConversationInboundMediaEnvelope | null;
  validatedFactCandidates?: readonly ProfileValidatedFactCandidateInput[];
  memoryIntent?: ConversationRouteMemoryIntent | null;
}

/**
 * Builds the bounded conversational write request used by direct chat and self-identity helpers so
 * they share the same canonical profile-memory seam and minimum stream-local provenance.
 *
 * @param input - Session-local write inputs for the current conversational turn.
 * @returns Canonical profile-memory ingest request with bounded conversational provenance.
 */
export function buildConversationProfileMemoryWriteRequest(
  input: ConversationProfileMemoryWriteRequestInput
): ProfileMemoryIngestRequest {
  const validatedFactCandidates = input.validatedFactCandidates ?? [];
  const sourceFingerprint = buildProfileMemorySourceFingerprint(
    input.userInput,
    validatedFactCandidates
  );
  const sourceSurface = "conversation_profile_input";
  const mediaIngest = buildProfileMediaIngestInputFromEnvelope(
    input.userInput ?? "",
    input.media ?? null
  );
  return {
    ...(typeof input.userInput === "string" && input.userInput.trim().length > 0
      ? { userInput: input.userInput }
      : {}),
    ...(validatedFactCandidates.length > 0
      ? { validatedFactCandidates }
      : {}),
    mediaIngest,
    ingestPolicy: buildProfileMemoryIngestPolicy({
      memoryIntent: input.memoryIntent ?? null,
      sourceSurface,
      hasValidatedFactCandidates: validatedFactCandidates.length > 0
    }),
    provenance: {
      conversationId: input.session.conversationId,
      turnId: buildConversationProfileMemoryTurnId(
        input.session.conversationId,
        input.receivedAt,
        sourceFingerprint
      ),
      dominantLaneAtWrite: input.session.domainContext.dominantLane,
      threadKey: input.session.conversationStack?.activeThreadKey ?? null,
      sourceSurface,
      sourceFingerprint
    }
  };
}
