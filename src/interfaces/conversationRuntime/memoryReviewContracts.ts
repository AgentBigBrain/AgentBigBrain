/**
 * @fileoverview Bounded remembered-situation and remembered-fact review contracts.
 */

import type {
  ProfileEpisodeStatus,
  ProfileFactReviewRequest,
  ProfileFactReviewResult,
  ProfileMemoryMutationEnvelope,
  ProfileMemoryQueryDecisionRecord
} from "../../core/profileMemory";

export interface ConversationMemoryReviewRecord {
  episodeId: string;
  title: string;
  summary: string;
  status: ProfileEpisodeStatus;
  lastMentionedAt: string;
  resolvedAt: string | null;
  confidence: number;
  sensitive: boolean;
}

export interface ConversationMemoryReviewRequest {
  reviewTaskId: string;
  query: string;
  nowIso: string;
  maxEpisodes?: number;
}

export type ReviewConversationMemory = (
  request: ConversationMemoryReviewRequest
) => Promise<readonly ConversationMemoryReviewRecord[]>;

export interface ConversationMemoryFactReviewRecord {
  factId: string;
  key: string;
  value: string;
  status: string;
  confidence: number;
  sensitive: boolean;
  observedAt: string;
  lastUpdatedAt: string;
  decisionRecord?: ProfileMemoryQueryDecisionRecord;
  mutationEnvelope?: ProfileMemoryMutationEnvelope;
}

export interface ConversationMemoryFactReviewRequest
  extends Pick<ProfileFactReviewRequest, "asOfObservedTime" | "asOfValidTime"> {
  reviewTaskId: string;
  query: string;
  nowIso: string;
  maxFacts?: number;
}

export interface ConversationMemoryFactReviewResult
  extends Pick<ProfileFactReviewResult, "asOfObservedTime" | "asOfValidTime">,
    ReadonlyArray<ConversationMemoryFactReviewRecord> {
  hiddenDecisionRecords: readonly ProfileMemoryQueryDecisionRecord[];
}

export type ReviewConversationMemoryFacts = (
  request: ConversationMemoryFactReviewRequest
) => Promise<ConversationMemoryFactReviewResult>;

export interface ConversationMemoryMutationRequest {
  episodeId: string;
  note?: string;
  nowIso: string;
  sourceTaskId: string;
  sourceText: string;
}

export type ResolveConversationMemoryEpisode = (
  request: ConversationMemoryMutationRequest
) => Promise<ConversationMemoryReviewRecord | null>;

export type MarkConversationMemoryEpisodeWrong = (
  request: ConversationMemoryMutationRequest
) => Promise<ConversationMemoryReviewRecord | null>;

export type ForgetConversationMemoryEpisode = (
  request: Pick<
    ConversationMemoryMutationRequest,
    "episodeId" | "nowIso" | "sourceTaskId" | "sourceText"
  >
) => Promise<ConversationMemoryReviewRecord | null>;

export interface ConversationMemoryFactMutationRequest {
  factId: string;
  note?: string;
  nowIso: string;
  sourceTaskId: string;
  sourceText: string;
}

export interface ConversationMemoryFactCorrectionRequest
  extends ConversationMemoryFactMutationRequest {
  replacementValue: string;
}

export type CorrectConversationMemoryFact = (
  request: ConversationMemoryFactCorrectionRequest
) => Promise<ConversationMemoryFactReviewRecord | null>;

export type ForgetConversationMemoryFact = (
  request: Pick<
    ConversationMemoryFactMutationRequest,
    "factId" | "nowIso" | "sourceTaskId" | "sourceText"
  >
) => Promise<ConversationMemoryFactReviewRecord | null>;
