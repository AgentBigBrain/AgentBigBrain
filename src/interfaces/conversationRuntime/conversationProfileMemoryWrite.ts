/**
 * @fileoverview Shared helpers for building bounded conversational profile-memory ingest requests.
 */

import type { ConversationSession } from "../sessionStore";
import type { ConversationInboundMediaEnvelope } from "../mediaRuntime/contracts";
import type {
  ProfileMemoryIngestRequest,
  ProfileMemoryIngestSourceLane,
  ProfileMediaIngestInput,
  ProfileValidatedFactCandidateInput
} from "../../core/profileMemoryRuntime/contracts";
import type {
  CreateProfileEpisodeRecordInput
} from "../../core/profileMemoryRuntime/profileMemoryEpisodeContracts";
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
  additionalEpisodeCandidates?: readonly CreateProfileEpisodeRecordInput[];
  memoryIntent?: ConversationRouteMemoryIntent | null;
}

/**
 * Resolves the dominant profile-memory source lane for one conversation write.
 *
 * **Why it exists:**
 * Direct user text can still use narrow durable extraction, but media-only turns should enter the
 * profile-memory store through candidate/support lanes instead of inheriting direct-text authority.
 *
 * @param mediaIngest - Structured media ingest split by authority.
 * @returns Source lane used by the ingest policy.
 */
function resolveConversationProfileMemorySourceLane(
  mediaIngest: ProfileMediaIngestInput
): ProfileMemoryIngestSourceLane {
  if (mediaIngest.directUserText) {
    return "direct_user_text";
  }
  if (mediaIngest.transcriptFragments.length > 0) {
    return "voice_transcript";
  }
  if (mediaIngest.ocrFragments.length > 0) {
    return "image_ocr";
  }
  if (mediaIngest.summaryFragments.length > 0) {
    return "image_summary";
  }
  return "direct_user_text";
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
    ...((input.additionalEpisodeCandidates?.length ?? 0) > 0
      ? { additionalEpisodeCandidates: input.additionalEpisodeCandidates }
      : {}),
    mediaIngest,
    ingestPolicy: buildProfileMemoryIngestPolicy({
      memoryIntent: input.memoryIntent ?? null,
      sourceSurface,
      sourceLane: resolveConversationProfileMemorySourceLane(mediaIngest),
      hasValidatedFactCandidates: validatedFactCandidates.length > 0,
      hasStructuredEpisodeCandidates: (input.additionalEpisodeCandidates?.length ?? 0) > 0
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
