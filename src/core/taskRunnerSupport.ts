/**
 * @fileoverview Provides shared normalization, verification-prompt, and usage helpers reused across runtime surfaces.
 */

import { ModelBillingMode, ModelClient, ModelUsageSnapshot } from "../models/types";
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
    billingMode: "unknown",
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
    billingMode: end.billingMode,
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

/**
 * Builds a user-facing model-usage summary string aligned with the billing mode.
 *
 * @param usage - Usage snapshot delta for the run.
 * @param maxSpendUsd - Configured API spend ceiling.
 * @returns Human-facing model-usage summary fragment.
 */
export function renderModelUsageSummary(
  usage: ModelUsageSnapshot,
  maxSpendUsd: number
): string {
  if (usage.billingMode === "api_usd") {
    return (
      `Model usage spend (provider-usage estimated) ${usage.estimatedSpendUsd.toFixed(6)}/` +
      `${maxSpendUsd.toFixed(2)} USD.`
    );
  }

  if (usage.billingMode === "subscription_quota") {
    return (
      `Model usage (subscription-backed) ${usage.calls} call(s), ` +
      `${usage.totalTokens} token(s).`
    );
  }

  if (usage.billingMode === "local") {
    return `Model usage (local backend) ${usage.calls} call(s), ${usage.totalTokens} token(s).`;
  }

  return `Model usage ${usage.calls} call(s), ${usage.totalTokens} token(s).`;
}

/**
 * Returns true when USD-based model-spend enforcement applies to the current billing mode.
 *
 * @param billingMode - Billing mode reported by the active model client.
 * @returns True when USD spend should be enforced.
 */
export function shouldEnforceUsdModelSpendLimit(billingMode: ModelBillingMode): boolean {
  return billingMode === "api_usd";
}
