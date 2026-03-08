/**
 * @fileoverview Canonical contracts for bounded model-assisted language understanding.
 */

import type { CreateProfileEpisodeRecordInput, ProfileEpisodeStatus } from "../../core/profileMemory";

export const DEFAULT_LANGUAGE_UNDERSTANDING_MODEL = "small-fast-model";
export const LANGUAGE_EPISODE_EXTRACTION_SCHEMA_NAME = "language_episode_extraction_v1";
export const MAX_LANGUAGE_EPISODE_CANDIDATES = 2;

export interface LanguageUnderstandingEpisodeExtractionRequest {
  text: string;
  sourceTaskId: string;
  observedAt: string;
  model?: string;
}

export interface LanguageEpisodeExtractionModelCandidate {
  subjectName: string;
  eventSummary: string;
  supportingSnippet: string;
  status: ProfileEpisodeStatus;
  confidence: number;
  tags: string[];
}

export interface LanguageEpisodeExtractionModelOutput {
  episodes: LanguageEpisodeExtractionModelCandidate[];
}

export interface LanguageUnderstandingEpisodeCandidate
  extends CreateProfileEpisodeRecordInput {}
