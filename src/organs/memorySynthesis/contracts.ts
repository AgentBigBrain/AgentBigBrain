/**
 * @fileoverview Canonical bounded contracts for cross-memory synthesis.
 */

import type { ProfileEpisodeStatus } from "../../core/profileMemory";
import type {
  ProfileMemoryQueryDecisionRecord
} from "../../core/profileMemoryRuntime/profileMemoryDecisionRecordContracts";

export interface MemorySynthesisEpisodeEntityLink {
  entityKey: string;
  canonicalName: string;
}

export interface MemorySynthesisEpisodeOpenLoopLink {
  loopId: string;
  threadKey: string;
  status: "open" | "resolved" | "superseded";
  priority: number;
}

export interface MemorySynthesisEpisodeRecord {
  episodeId: string;
  title: string;
  summary: string;
  status: ProfileEpisodeStatus;
  lastMentionedAt: string;
  entityRefs: readonly string[];
  entityLinks: readonly MemorySynthesisEpisodeEntityLink[];
  openLoopLinks: readonly MemorySynthesisEpisodeOpenLoopLink[];
}

export interface MemorySynthesisFactRecord {
  factId: string;
  key: string;
  value: string;
  status: string;
  observedAt: string;
  lastUpdatedAt: string;
  confidence: number;
  decisionRecord?: TemporalMemorySynthesisDecisionRecord;
}

export type MemorySynthesisEvidenceKind =
  | "episode"
  | "fact"
  | "open_loop"
  | "entity_link";

export interface MemorySynthesisEvidence {
  kind: MemorySynthesisEvidenceKind;
  label: string;
  detail: string;
}

export type TemporalMemorySynthesisDecisionDisposition =
  | "selected_current_state"
  | "selected_supporting_history"
  | "ambiguous_contested"
  | "insufficient_evidence"
  | "needs_corroboration"
  | "quarantined";

export type TemporalMemorySynthesisDecisionRecord = ProfileMemoryQueryDecisionRecord;

export type BoundedMemorySynthesisContractMode = "legacy_adapter_only";

export interface BoundedMemorySynthesis {
  contractMode: BoundedMemorySynthesisContractMode;
  topicLabel: string;
  summary: string;
  confidence: number;
  openLoopCount: number;
  primaryEpisode: MemorySynthesisEpisodeRecord;
  supportingFacts: readonly MemorySynthesisFactRecord[];
  evidence: readonly MemorySynthesisEvidence[];
  decisionRecords?: readonly TemporalMemorySynthesisDecisionRecord[];
}
