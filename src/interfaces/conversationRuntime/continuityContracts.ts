/**
 * @fileoverview Shared conversation continuity contracts for episode and fact recall surfaces.
 */

import type { ConversationStackV1, EntityGraphV1, OpenLoopV1 } from "../../core/types";
import type { ProfileEpisodeStatus } from "../../core/profileMemory";
import type {
  ProfileMemoryTemporalRelevanceScope,
  ProfileMemoryTemporalSemanticMode,
  TemporalMemorySynthesis
} from "../../core/profileMemoryRuntime/profileMemoryTemporalQueryContracts";
import type { MemoryBoundaryLaneOutput } from "../../organs/memoryContext/contracts";

export interface ConversationContinuityEpisodeEntityLink {
  entityKey: string;
  canonicalName: string;
}

export interface ConversationContinuityEpisodeOpenLoopLink {
  loopId: string;
  threadKey: string;
  status: OpenLoopV1["status"];
  priority: number;
}

export interface ConversationContinuityEpisodeRecord {
  episodeId: string;
  title: string;
  summary: string;
  status: ProfileEpisodeStatus;
  lastMentionedAt: string;
  entityRefs: readonly string[];
  entityLinks: readonly ConversationContinuityEpisodeEntityLink[];
  openLoopLinks: readonly ConversationContinuityEpisodeOpenLoopLink[];
}

export interface ConversationContinuityFactRecord {
  factId: string;
  key: string;
  value: string;
  status: string;
  observedAt: string;
  lastUpdatedAt: string;
  confidence: number;
}

export interface ConversationContinuityFactResult extends ReadonlyArray<ConversationContinuityFactRecord> {
  semanticMode: ProfileMemoryTemporalSemanticMode;
  relevanceScope: ProfileMemoryTemporalRelevanceScope;
  scopedThreadKeys: readonly string[];
  temporalSynthesis: TemporalMemorySynthesis | null;
  laneBoundaries: readonly MemoryBoundaryLaneOutput[];
}

export interface ConversationContinuityEpisodeQueryRequest {
  stack: ConversationStackV1;
  entityHints: readonly string[];
  semanticMode?: ProfileMemoryTemporalSemanticMode;
  relevanceScope?: ProfileMemoryTemporalRelevanceScope;
  asOfValidTime?: string;
  asOfObservedTime?: string;
  maxEpisodes?: number;
}

export type QueryConversationContinuityEpisodes = (
  request: ConversationContinuityEpisodeQueryRequest
) => Promise<readonly ConversationContinuityEpisodeRecord[]>;

export interface ConversationContinuityFactQueryRequest {
  stack: ConversationStackV1;
  entityHints: readonly string[];
  semanticMode?: ProfileMemoryTemporalSemanticMode;
  relevanceScope?: ProfileMemoryTemporalRelevanceScope;
  asOfValidTime?: string;
  asOfObservedTime?: string;
  maxFacts?: number;
}

export type QueryConversationContinuityFacts = (
  request: ConversationContinuityFactQueryRequest
) => Promise<ConversationContinuityFactResult | readonly ConversationContinuityFactRecord[]>;

export interface ConversationContinuityReadSession {
  queryContinuityEpisodes(request: ConversationContinuityEpisodeQueryRequest): Promise<readonly ConversationContinuityEpisodeRecord[]>;
  queryContinuityFacts(request: ConversationContinuityFactQueryRequest): Promise<ConversationContinuityFactResult | readonly ConversationContinuityFactRecord[]>;
}

export type OpenConversationContinuityReadSession = () => Promise<ConversationContinuityReadSession | null>;

export type GetConversationEntityGraph = () => Promise<EntityGraphV1>;
