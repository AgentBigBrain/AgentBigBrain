/**
 * @fileoverview Canonical episodic-memory contracts for profile-memory runtime state.
 */

export type ProfileEpisodeStatus =
  | "unresolved"
  | "partially_resolved"
  | "resolved"
  | "outcome_unknown"
  | "no_longer_relevant";

export type ProfileEpisodeSourceKind = "explicit_user_statement" | "assistant_inference";

export type ProfileEpisodeResolutionStatus = Exclude<ProfileEpisodeStatus, "unresolved">;

export interface ProfileEpisodeRecord {
  id: string;
  title: string;
  summary: string;
  status: ProfileEpisodeStatus;
  sourceTaskId: string;
  source: string;
  sourceKind: ProfileEpisodeSourceKind;
  sensitive: boolean;
  confidence: number;
  observedAt: string;
  lastMentionedAt: string;
  lastUpdatedAt: string;
  resolvedAt: string | null;
  entityRefs: string[];
  openLoopRefs: string[];
  tags: string[];
}

export interface CreateProfileEpisodeRecordInput {
  title: string;
  summary: string;
  sourceTaskId: string;
  source: string;
  sourceKind: ProfileEpisodeSourceKind;
  sensitive: boolean;
  observedAt: string;
  confidence?: number;
  status?: ProfileEpisodeStatus;
  lastMentionedAt?: string;
  lastUpdatedAt?: string;
  resolvedAt?: string | null;
  entityRefs?: readonly string[];
  openLoopRefs?: readonly string[];
  tags?: readonly string[];
}

export interface ProfileEpisodeResolutionInput {
  episodeId: string;
  status: ProfileEpisodeResolutionStatus;
  sourceTaskId: string;
  source: string;
  observedAt: string;
  confidence?: number;
  summary?: string;
  entityRefs?: readonly string[];
  openLoopRefs?: readonly string[];
  tags?: readonly string[];
}
