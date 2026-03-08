/**
 * @fileoverview Provides shared normalization, verification-prompt, and usage helpers reused across runtime surfaces.
 */

import { ModelClient, ModelUsageSnapshot } from "../models/types";
import { VerificationCategoryV1 } from "./types";
import { containsAgentPulseRequestMarker, extractActiveRequestSegment } from "./currentRequestExtraction";
import { isVerificationClaimPrompt, resolveVerificationCategoryFromPrompt } from "./verificationPromptClassifier";

/**
 * Converts an unknown metadata field into a trimmed non-empty string when possible.
 *
 * @param value - Candidate metadata value from planner or action params.
 * @returns Trimmed string when present, otherwise `null`.
 */
export function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolves verification category from the active user request segment.
 *
 * @param userInput - Full task user input, potentially wrapped with context markers.
 * @returns Verification category used by quality-gate enforcement.
 */
export function resolveVerificationCategoryForPrompt(
  userInput: string
): VerificationCategoryV1 {
  const promptText = extractActiveRequestSegment(userInput);
  return resolveVerificationCategoryFromPrompt(promptText);
}

/**
 * Determines whether respond-action verification gating should be enforced for this prompt.
 *
 * @param userInput - Full task user input.
 * @returns `true` when this prompt is an explicit completion-claim request.
 */
export function shouldEnforceVerificationGateForRespond(userInput: string): boolean {
  if (containsAgentPulseRequestMarker(userInput)) {
    return false;
  }
  const currentRequest = extractActiveRequestSegment(userInput);
  return isVerificationClaimPrompt(currentRequest);
}

/**
 * Returns a deterministic zeroed model-usage snapshot.
 *
 * @returns Usage snapshot with all counters initialized to zero.
 */
export function emptyUsageSnapshot(): ModelUsageSnapshot {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedSpendUsd: 0
  };
}

/**
 * Computes non-negative usage deltas between two model-usage snapshots.
 *
 * @param start - Snapshot captured before execution.
 * @param end - Snapshot captured after execution.
 * @returns Delta snapshot used for cumulative spend guards.
 */
export function diffUsageSnapshot(
  start: ModelUsageSnapshot,
  end: ModelUsageSnapshot
): ModelUsageSnapshot {
  return {
    calls: Math.max(0, end.calls - start.calls),
    promptTokens: Math.max(0, end.promptTokens - start.promptTokens),
    completionTokens: Math.max(0, end.completionTokens - start.completionTokens),
    totalTokens: Math.max(0, end.totalTokens - start.totalTokens),
    estimatedSpendUsd: Number(Math.max(0, end.estimatedSpendUsd - start.estimatedSpendUsd).toFixed(8))
  };
}

/**
 * Reads current model-usage counters from the model client when supported.
 *
 * @param modelClient - Runtime model client used by orchestrator or task runner.
 * @returns Snapshot from provider client or zeroed fallback snapshot.
 */
export function readModelUsageSnapshot(modelClient: ModelClient): ModelUsageSnapshot {
  if (typeof modelClient.getUsageSnapshot === "function") {
    return modelClient.getUsageSnapshot();
  }
  return emptyUsageSnapshot();
}
