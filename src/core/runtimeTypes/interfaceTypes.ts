/**
 * @fileoverview Canonical interface-facing runtime contracts extracted from the shared runtime type surface.
 */

export const STAGE_6_86_BLOCK_CODES = ["MEMORY_MUTATION_BLOCKED", "PULSE_BLOCKED"] as const;

export type Stage686BlockCodeV1 = (typeof STAGE_6_86_BLOCK_CODES)[number];

export const STAGE_6_86_PRIVACY_BLOCK_REASONS = ["PRIVACY_SENSITIVE"] as const;

export type Stage686PrivacyBlockReasonV1 = (typeof STAGE_6_86_PRIVACY_BLOCK_REASONS)[number];

export const STAGE_6_86_MEMORY_CONFLICT_CODES = [
  "ALIAS_COLLISION",
  "MERGE_AMBIGUITY",
  "STALE_THREAD_FRAME",
  "SESSION_SCHEMA_MISMATCH",
  "CANONICALIZATION_CONFLICT"
] as const;

export type MemoryConflictCodeV1 = (typeof STAGE_6_86_MEMORY_CONFLICT_CODES)[number];

export const STAGE_6_86_BRIDGE_CONFLICT_CODES = [
  "INSUFFICIENT_EVIDENCE",
  "COOLDOWN_ACTIVE",
  "DERAILS_ACTIVE_MISSION",
  "PRIVACY_SENSITIVE",
  "CAP_REACHED"
] as const;

export type BridgeConflictCodeV1 = (typeof STAGE_6_86_BRIDGE_CONFLICT_CODES)[number];

export const STAGE_6_86_PULSE_BLOCK_CODES = [
  "PULSE_CAP_REACHED",
  "PULSE_COOLDOWN_ACTIVE",
  "DERAILS_ACTIVE_MISSION",
  "PRIVACY_SENSITIVE",
  "OPEN_LOOP_CAP_REACHED"
] as const;

export type PulseBlockCodeV1 = (typeof STAGE_6_86_PULSE_BLOCK_CODES)[number];

export const STAGE_6_86_BRIDGE_BLOCK_CODES = [
  "BRIDGE_INSUFFICIENT_EVIDENCE",
  "BRIDGE_COOLDOWN_ACTIVE",
  "BRIDGE_PRIVACY_SENSITIVE",
  "BRIDGE_CAP_REACHED",
  "DERAILS_ACTIVE_MISSION"
] as const;

export type BridgeBlockCodeV1 = (typeof STAGE_6_86_BRIDGE_BLOCK_CODES)[number];

export type EntityTypeV1 = "person" | "place" | "org" | "event" | "thing" | "concept";

export type RelationTypeV1 =
  | "co_mentioned"
  | "unknown"
  | "friend"
  | "family"
  | "coworker"
  | "project_related"
  | "other";

export type MemoryStatusV1 = "uncertain" | "confirmed" | "superseded";

export const STAGE_6_86_PULSE_REASON_CODES = [
  "OPEN_LOOP_RESUME",
  "RELATIONSHIP_CLARIFICATION",
  "TOPIC_DRIFT_RESUME",
  "STALE_FACT_REVALIDATION",
  "USER_REQUESTED_FOLLOWUP",
  "SAFETY_HOLD"
] as const;

export type PulseReasonCodeV1 = (typeof STAGE_6_86_PULSE_REASON_CODES)[number];

export const STAGE_6_86_PULSE_DECISION_CODES = ["EMIT", "SUPPRESS", "DEFER"] as const;

export type PulseDecisionCodeV1 = (typeof STAGE_6_86_PULSE_DECISION_CODES)[number];

export interface EntityNodeV1 {
  entityKey: string;
  canonicalName: string;
  entityType: EntityTypeV1;
  disambiguator: string | null;
  aliases: readonly string[];
  firstSeenAt: string;
  lastSeenAt: string;
  salience: number;
  evidenceRefs: readonly string[];
}

export interface RelationEdgeV1 {
  edgeKey: string;
  sourceEntityKey: string;
  targetEntityKey: string;
  relationType: RelationTypeV1;
  status: MemoryStatusV1;
  coMentionCount: number;
  strength: number;
  firstObservedAt: string;
  lastObservedAt: string;
  evidenceRefs: readonly string[];
}

export interface EntityGraphV1 {
  schemaVersion: "v1";
  updatedAt: string;
  entities: readonly EntityNodeV1[];
  edges: readonly RelationEdgeV1[];
}

export interface TopicNodeV1 {
  topicKey: string;
  label: string;
  firstSeenAt: string;
  lastSeenAt: string;
  mentionCount: number;
}

export interface TopicKeyCandidateV1 {
  topicKey: string;
  label: string;
  confidence: number;
  source: "heuristic_tokens" | "heuristic_phrase" | "fallback_model";
  observedAt: string;
}

export interface OpenLoopV1 {
  loopId: string;
  threadKey: string;
  entityRefs: readonly string[];
  createdAt: string;
  lastMentionedAt: string;
  priority: number;
  status: "open" | "resolved" | "superseded";
}

export interface ThreadFrameV1 {
  threadKey: string;
  topicKey: string;
  topicLabel: string;
  state: "active" | "paused" | "resolved";
  resumeHint: string;
  openLoops: readonly OpenLoopV1[];
  lastTouchedAt: string;
}

export interface ConversationStackV1 {
  schemaVersion: "v1";
  updatedAt: string;
  activeThreadKey: string | null;
  threads: readonly ThreadFrameV1[];
  topics: readonly TopicNodeV1[];
}

export type SessionSchemaVersionV1 = "v1" | "v2";

export interface PulseScoreBreakdownV1 {
  recency: number;
  frequency: number;
  unresolvedImportance: number;
  sensitivityPenalty: number;
  cooldownPenalty: number;
}

export interface PulseCandidateV1 {
  candidateId: string;
  reasonCode: PulseReasonCodeV1;
  score: number;
  scoreBreakdown: PulseScoreBreakdownV1;
  lastTouchedAt: string;
  threadKey: string | null;
  entityRefs: readonly string[];
  evidenceRefs: readonly string[];
  stableHash: string;
}

export interface PulseDecisionV1 {
  decisionCode: PulseDecisionCodeV1;
  candidateId: string;
  blockCode: Extract<Stage686BlockCodeV1, "PULSE_BLOCKED"> | null;
  blockDetailReason: PulseBlockCodeV1 | BridgeBlockCodeV1 | null;
  evidenceRefs: readonly string[];
}

export interface BridgeCandidateV1 {
  candidateId: string;
  sourceEntityKey: string;
  targetEntityKey: string;
  coMentionCount: number;
  lastObservedAt: string;
  evidenceRefs: readonly string[];
}

export interface BridgeQuestionV1 {
  questionId: string;
  sourceEntityKey: string;
  targetEntityKey: string;
  prompt: string;
  createdAt: string;
  cooldownUntil: string;
  threadKey: string | null;
  evidenceRefs: readonly string[];
}
