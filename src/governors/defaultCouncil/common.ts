/**
 * @fileoverview Shared helpers for default governor votes, parameter reads, and normalization.
 */

import { createSafetyLexiconRuleContext } from "../safetyLexicon";
import {
  DefaultGovernorId,
  DefaultGovernorRejectCategory,
  DefaultGovernorVote
} from "./contracts";

export const SAFETY_LEXICON_RULE_CONTEXT = createSafetyLexiconRuleContext();

/**
 * Builds an approval outcome for input with typed metadata.
 *
 * **Why it exists:**
 * Standardizes input vote/result construction so downstream governance handling stays uniform.
 *
 * **What it talks to:**
 * - Uses default governor contract types within this subsystem.
 *
 * @param governorId - Stable identifier used to reference an entity or record.
 * @param reason - Value for reason.
 * @param confidence - Stable identifier used to reference an entity or record.
 * @returns Computed `DefaultGovernorVote` result.
 */
export function approve(
  governorId: DefaultGovernorId,
  reason: string,
  confidence = 0.85
): DefaultGovernorVote {
  return { governorId, approve: true, reason, confidence };
}

/**
 * Builds a rejection outcome for with category with typed metadata.
 *
 * **Why it exists:**
 * Standardizes with category vote/result construction so downstream governance handling stays uniform.
 *
 * **What it talks to:**
 * - Uses default governor contract types within this subsystem.
 *
 * @param governorId - Stable identifier used to reference an entity or record.
 * @param reason - Value for reason.
 * @param rejectCategory - Value for reject category.
 * @param confidence - Stable identifier used to reference an entity or record.
 * @returns Computed `DefaultGovernorVote` result.
 */
export function rejectWithCategory(
  governorId: DefaultGovernorId,
  reason: string,
  rejectCategory: DefaultGovernorRejectCategory,
  confidence = 0.9
): DefaultGovernorVote {
  return {
    governorId,
    approve: false,
    reason,
    confidence,
    rejectCategory
  };
}

/**
 * Normalizes input into a stable shape for default-governor logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for input so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local string normalization only.
 *
 * @param input - Structured input object for this operation.
 * @returns Resulting string value.
 */
export function normalize(input: string): string {
  return input.toLowerCase();
}

/**
 * Reads param string needed for this execution step.
 *
 * **Why it exists:**
 * Separates param string read-path handling from orchestration and mutation code.
 *
 * **What it talks to:**
 * - Uses local object access only.
 *
 * @param params - Structured input object for this operation.
 * @param key - Lookup key or map field identifier.
 * @returns Computed `string | undefined` result.
 */
export function getParamString(
  params: Record<string, unknown>,
  key: string
): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Normalizes confidence into a stable shape for default-governor logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for confidence so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local finite-number guard and clamp logic.
 *
 * @param value - Primary input consumed by this function.
 * @returns Numeric result used by downstream logic.
 */
export function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.8;
  }

  return Math.max(0, Math.min(1, value));
}
