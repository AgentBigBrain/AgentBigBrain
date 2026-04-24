/**
 * @fileoverview Defines neutral projection contracts for mirroring runtime state into external inspection targets such as Obsidian.
 */

import type { ExecutionReceipt } from "../executionReceipts";
import type { GovernanceMemoryReadView } from "../types";
import type { MediaArtifactRecord } from "../mediaArtifacts";
import type { ProfileMemoryState, ProfileMemoryGraphClaimRecord } from "../profileMemory";
import type { Stage686RuntimeStateSnapshot } from "../stage6_86/runtimeState";
import type { EntityGraphV1, WorkflowPattern } from "../types";

export type ProjectionMode = "review_safe" | "operator_full";

export type ProjectionChangeKind =
  | "profile_memory_changed"
  | "continuity_changed"
  | "entity_graph_changed"
  | "governance_changed"
  | "execution_receipts_changed"
  | "workflow_learning_changed"
  | "media_artifact_changed"
  | "review_actions_applied"
  | "manual_rebuild";

export interface ProjectionChangeSet {
  changeId: string;
  observedAt: string;
  kinds: readonly ProjectionChangeKind[];
  reasons: readonly string[];
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ProjectionSnapshot {
  generatedAt: string;
  mode: ProjectionMode;
  profileMemory: ProfileMemoryState | null;
  currentSurfaceClaims: readonly ProfileMemoryGraphClaimRecord[];
  resolvedCurrentClaims: readonly ProfileMemoryGraphClaimRecord[];
  runtimeState: Stage686RuntimeStateSnapshot;
  entityGraph: EntityGraphV1;
  governanceReadView: GovernanceMemoryReadView;
  executionReceipts: readonly ExecutionReceipt[];
  workflowPatterns: readonly WorkflowPattern[];
  mediaArtifacts: readonly MediaArtifactRecord[];
}

export interface ProjectionHealth {
  healthy: boolean;
  detail: string;
}

export interface ProjectionSink {
  readonly id: string;
  sync(changeSet: ProjectionChangeSet, snapshot: ProjectionSnapshot): Promise<void>;
  rebuild(snapshot: ProjectionSnapshot): Promise<void>;
  healthCheck?(): Promise<ProjectionHealth>;
}

export interface ProjectionSinkSyncState {
  lastAttemptedAt: string | null;
  lastSucceededAt: string | null;
  lastError: string | null;
}

export interface ProjectionStateSnapshot {
  schemaVersion: "v1";
  updatedAt: string;
  lastChangeId: string | null;
  lastRebuildAt: string | null;
  sinkStates: Record<string, ProjectionSinkSyncState>;
}

export interface ProjectionServiceSnapshotProvider {
  (): Promise<ProjectionSnapshot>;
}
