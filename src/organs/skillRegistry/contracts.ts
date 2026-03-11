/**
 * @fileoverview Canonical skill manifest and inventory contracts for governed skill runtime state.
 */

export type SkillRiskLevel = "low" | "moderate" | "high";

export type SkillVerificationStatus = "unverified" | "verified" | "failed";

export type SkillLifecycleStatus = "active" | "deprecated";

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
  primaryPath: string;
  compatibilityPath: string;
}

export interface SkillInventoryEntry {
  name: string;
  description: string;
  userSummary: string;
  verificationStatus: SkillVerificationStatus;
  riskLevel: SkillRiskLevel;
  tags: readonly string[];
  invocationHints: readonly string[];
  lifecycleStatus: SkillLifecycleStatus;
  updatedAt: string;
}
