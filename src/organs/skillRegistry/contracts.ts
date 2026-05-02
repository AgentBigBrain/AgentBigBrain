/**
 * @fileoverview Canonical skill manifest and inventory contracts for governed skill runtime state.
 */

export type SkillRiskLevel = "low" | "moderate" | "high";

export type SkillVerificationStatus = "unverified" | "verified" | "failed";

export type SkillLifecycleStatus =
  | "active"
  | "draft"
  | "pending_approval"
  | "rejected"
  | "deprecated";

export type SkillKind = "executable_module" | "markdown_instruction";

export type SkillOrigin = "builtin" | "runtime_user";

export type SkillActivationSource =
  | "builtin"
  | "legacy_migration"
  | "explicit_user_request"
  | "agent_suggestion"
  | "operator_approval";

export type SkillMemoryPolicy =
  | "none"
  | "candidate_only"
  | "operator_approved";

export type SkillProjectionPolicy =
  | "metadata_only"
  | "review_safe_excerpt"
  | "operator_full_content";

export type SkillAllowedSideEffect =
  | "filesystem_read"
  | "filesystem_write"
  | "shell"
  | "process"
  | "network"
  | "memory";

export interface SkillVerificationConfig {
  testInput: string | null;
  expectedOutputContains: string | null;
}

export interface SkillManifest {
  name: string;
  kind: SkillKind;
  origin: SkillOrigin;
  description: string;
  purpose: string;
  inputSummary: string;
  outputSummary: string;
  riskLevel: SkillRiskLevel;
  allowedSideEffects: readonly SkillAllowedSideEffect[];
  tags: readonly string[];
  capabilities: readonly string[];
  version: string;
  createdAt: string;
  updatedAt: string;
  verificationStatus: SkillVerificationStatus;
  verificationVerifiedAt: string | null;
  verificationFailureReason: string | null;
  verificationTestInput: string | null;
  verificationExpectedOutputContains: string | null;
  userSummary: string;
  invocationHints: readonly string[];
  lifecycleStatus: SkillLifecycleStatus;
  activationSource: SkillActivationSource;
  instructionPath: string | null;
  primaryPath: string;
  compatibilityPath: string;
  memoryPolicy: SkillMemoryPolicy;
  projectionPolicy: SkillProjectionPolicy;
}

export interface SkillInventoryEntry {
  name: string;
  kind?: SkillKind;
  origin?: SkillOrigin;
  description: string;
  userSummary: string;
  verificationStatus: SkillVerificationStatus;
  riskLevel: SkillRiskLevel;
  tags: readonly string[];
  invocationHints: readonly string[];
  lifecycleStatus: SkillLifecycleStatus;
  activationSource?: SkillActivationSource;
  updatedAt: string;
  memoryPolicy?: SkillMemoryPolicy;
  projectionPolicy?: SkillProjectionPolicy;
}

export interface PlannerSkillGuidanceEntry {
  name: string;
  origin: SkillOrigin;
  description: string;
  tags: readonly string[];
  invocationHints: readonly string[];
  guidance: string;
}

export type SkillProjectionContentMode =
  | "metadata_only"
  | "review_safe_excerpt"
  | "operator_full_content";

export interface SkillProjectionEntry {
  name: string;
  kind: SkillKind;
  origin: SkillOrigin;
  description: string;
  userSummary: string;
  tags: readonly string[];
  invocationHints: readonly string[];
  verificationStatus: SkillVerificationStatus;
  lifecycleStatus: SkillLifecycleStatus;
  memoryPolicy: SkillMemoryPolicy;
  projectionPolicy: SkillProjectionPolicy;
  contentMode: SkillProjectionContentMode;
  projectedContent: string | null;
}
