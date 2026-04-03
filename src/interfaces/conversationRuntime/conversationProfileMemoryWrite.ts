/**
 * @fileoverview Shared helpers for building bounded conversational profile-memory ingest requests.
 */

import type { ConversationSession } from "../sessionStore";
import type {
  ProfileMemoryIngestRequest,
  ProfileValidatedFactCandidateInput
} from "../../core/profileMemoryRuntime/contracts";
import {
  buildConversationProfileMemoryTurnId,
  buildProfileMemorySourceFingerprint
} from "../../core/profileMemoryRuntime/profileMemoryIngestProvenance";

export interface ConversationProfileMemoryWriteRequestInput {
  session: ConversationSession;
  receivedAt: string;
  userInput?: string;
  validatedFactCandidates?: readonly ProfileValidatedFactCandidateInput[];
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
  return {
    ...(typeof input.userInput === "string" && input.userInput.trim().length > 0
      ? { userInput: input.userInput }
      : {}),
    ...(validatedFactCandidates.length > 0
      ? { validatedFactCandidates }
      : {}),
    provenance: {
      conversationId: input.session.conversationId,
      turnId: buildConversationProfileMemoryTurnId(
        input.session.conversationId,
        input.receivedAt,
        sourceFingerprint
      ),
      dominantLaneAtWrite: input.session.domainContext.dominantLane,
      threadKey: input.session.conversationStack?.activeThreadKey ?? null,
      sourceSurface: "conversation_profile_input",
      sourceFingerprint
    }
  };
}
