/**
 * @fileoverview Deterministic Stage 6.85 clone-workflow policy helpers for parallel-spike bounds, typed queue validation, packet envelopes, and merge eligibility.
 */

import { clampConfidence, toSortedUnique } from "./cryptoUtils";
import { createSchemaEnvelopeV1, verifySchemaEnvelopeV1 } from "./schemaEnvelope";
import {
  ActionType,
  ClonePacketContentKindV1,
  CloneQueueRequestV1,
  FindingsPacketV1,
  OptionPacketV1,
  ParallelSpikeBoundsV1,
  SchemaEnvelopeV1,
  Stage685CloneBlockCode
} from "./types";

export const STAGE_6_85_DEFAULT_MAX_CLONE_BUDGET_USD = 1;
export const STAGE_6_85_DEFAULT_MAX_PACKETS_PER_CLONE = 4;
export const STAGE_6_85_MAX_CLONE_BUDGET_USD_CAP = 1;
export const STAGE_6_85_MAX_PACKETS_PER_CLONE_CAP = 4;

const MERGEABLE_PACKET_KINDS = new Set<ClonePacketContentKindV1>([
  "pattern",
  "plan_variant",
  "test_idea",
  "selector_strategy",
  "lesson"
]);

const CLONE_ROLE_SET = new Set<CloneQueueRequestV1["cloneRole"]>([
  "creative",
  "researcher",
  "critic",
  "builder"
]);

export interface ParallelSpikeBoundsInput {
  configMaxSubagentsPerTask: number;
  configMaxSubagentDepth: number;
  requestedBounds?: Partial<ParallelSpikeBoundsV1>;
}

export interface ParallelSpikeBoundsDecision {
  allowed: boolean;
  bounds: ParallelSpikeBoundsV1 | null;
  blockCode: Stage685CloneBlockCode | null;
  reasons: readonly string[];
}

export interface CloneQueueValidationDecision {
  valid: boolean;
  normalizedRequest: CloneQueueRequestV1 | null;
  blockCode: Stage685CloneBlockCode | null;
  reasons: readonly string[];
}

export interface ClonePacketDraftInput {
  packetId: string;
  cloneId: string;
  recommendation: string;
  tradeoffs: readonly string[];
  risks: readonly string[];
  evidenceRefs: readonly string[];
  confidence: number;
  contentKind: ClonePacketContentKindV1;
}

export interface ClonePacketMergeDecision {
  mergeable: boolean;
  blockCode: Stage685CloneBlockCode | null;
  reason: string;
}

export interface CloneActionSurfaceDecision {
  allowed: boolean;
  blockCode: Stage685CloneBlockCode | null;
  reason: string;
}

/**
 * Normalizes positive integer into a stable shape for `stage6_85CloneWorkflowPolicy` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for positive integer so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `number | null` result.
 */
function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

/**
 * Normalizes positive budget usd into a stable shape for `stage6_85CloneWorkflowPolicy` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for positive budget usd so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `number | null` result.
 */
function normalizePositiveBudgetUsd(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Number(value.toFixed(4));
}

/**
 * Normalizes text into a stable shape for `stage6_85CloneWorkflowPolicy` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for text so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Resulting string value.
 */
function normalizeText(value: string, fallback: string): string {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

/**
 * Normalizes string list into a stable shape for `stage6_85CloneWorkflowPolicy` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for string list so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `toSortedUnique` (import `toSortedUnique`) from `./cryptoUtils`.
 *
 * @param values - Value for values.
 * @returns Ordered collection produced by this step.
 */
function normalizeStringList(values: readonly string[]): string[] {
  return toSortedUnique(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

/**
 * Builds bounds decision for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of bounds decision consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param reasons - Value for reasons.
 * @returns Computed `ParallelSpikeBoundsDecision` result.
 */
function buildBoundsDecision(reasons: readonly string[]): ParallelSpikeBoundsDecision {
  if (reasons.length === 0) {
    return {
      allowed: true,
      bounds: null,
      blockCode: null,
      reasons: []
    };
  }
  return {
    allowed: false,
    bounds: null,
    blockCode: "PARALLEL_SPIKE_BOUNDS_INVALID",
    reasons
  };
}

/**
 * Resolves parallel spike bounds from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of parallel spike bounds by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `ParallelSpikeBoundsDecision` result.
 */
export function resolveParallelSpikeBounds(
  input: ParallelSpikeBoundsInput
): ParallelSpikeBoundsDecision {
  const reasons: string[] = [];
  const configMaxClones = normalizePositiveInteger(input.configMaxSubagentsPerTask);
  const configMaxDepth = normalizePositiveInteger(input.configMaxSubagentDepth);
  if (configMaxClones === null) {
    reasons.push("Config maxSubagentsPerTask is invalid.");
  }
  if (configMaxDepth === null) {
    reasons.push("Config maxSubagentDepth is invalid.");
  }
  if (reasons.length > 0 || configMaxClones === null || configMaxDepth === null) {
    return buildBoundsDecision(reasons);
  }

  const rawRequested = input.requestedBounds ?? {};
  const requestedCloneCount =
    rawRequested.maxClonesPerParallelSpike === undefined
      ? configMaxClones
      : normalizePositiveInteger(rawRequested.maxClonesPerParallelSpike);
  const requestedDepth =
    rawRequested.maxCloneDepth === undefined
      ? configMaxDepth
      : normalizePositiveInteger(rawRequested.maxCloneDepth);
  const requestedBudget =
    rawRequested.maxCloneBudgetUsd === undefined
      ? STAGE_6_85_DEFAULT_MAX_CLONE_BUDGET_USD
      : normalizePositiveBudgetUsd(rawRequested.maxCloneBudgetUsd);
  const requestedPacketBudget =
    rawRequested.maxPacketsPerClone === undefined
      ? STAGE_6_85_DEFAULT_MAX_PACKETS_PER_CLONE
      : normalizePositiveInteger(rawRequested.maxPacketsPerClone);

  if (requestedCloneCount === null) {
    reasons.push("maxClonesPerParallelSpike is invalid.");
  }
  if (requestedDepth === null) {
    reasons.push("maxCloneDepth is invalid.");
  }
  if (requestedBudget === null) {
    reasons.push("maxCloneBudgetUsd is invalid.");
  }
  if (requestedPacketBudget === null) {
    reasons.push("maxPacketsPerClone is invalid.");
  }

  if (reasons.length > 0) {
    return buildBoundsDecision(reasons);
  }

  if (
    requestedCloneCount === null ||
    requestedDepth === null ||
    requestedBudget === null ||
    requestedPacketBudget === null
  ) {
    return buildBoundsDecision(reasons);
  }

  if (requestedCloneCount > configMaxClones) {
    reasons.push("maxClonesPerParallelSpike exceeds BRAIN_MAX_SUBAGENTS_PER_TASK.");
  }
  if (requestedDepth > configMaxDepth) {
    reasons.push("maxCloneDepth exceeds BRAIN_MAX_SUBAGENT_DEPTH.");
  }
  if (requestedBudget > STAGE_6_85_MAX_CLONE_BUDGET_USD_CAP) {
    reasons.push("maxCloneBudgetUsd exceeds Stage 6.85 cap.");
  }
  if (requestedPacketBudget > STAGE_6_85_MAX_PACKETS_PER_CLONE_CAP) {
    reasons.push("maxPacketsPerClone exceeds Stage 6.85 cap.");
  }

  if (reasons.length > 0) {
    return buildBoundsDecision(reasons);
  }

  return {
    allowed: true,
    bounds: {
      maxClonesPerParallelSpike: requestedCloneCount,
      maxCloneDepth: requestedDepth,
      maxCloneBudgetUsd: requestedBudget,
      maxPacketsPerClone: requestedPacketBudget
    },
    blockCode: null,
    reasons: [
      "Parallel spike bounds resolved from deterministic config inheritance and stage caps."
    ]
  };
}

/**
 * Applies deterministic validity checks for clone queue request.
 *
 * **Why it exists:**
 * Fails fast when clone queue request is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses `CloneQueueRequestV1` (import `CloneQueueRequestV1`) from `./types`.
 * - Uses `ParallelSpikeBoundsV1` (import `ParallelSpikeBoundsV1`) from `./types`.
 *
 * @param request - Structured input object for this operation.
 * @param bounds - Value for bounds.
 * @returns Computed `CloneQueueValidationDecision` result.
 */
export function validateCloneQueueRequest(
  request: CloneQueueRequestV1,
  bounds: ParallelSpikeBoundsV1
): CloneQueueValidationDecision {
  const reasons: string[] = [];
  const missionId = normalizeText(request.missionId, "");
  const rootTaskId = normalizeText(request.rootTaskId, "");
  const missionAttemptId = normalizePositiveInteger(request.missionAttemptId);
  const requestedCloneCount = normalizePositiveInteger(request.requestedCloneCount);
  const requestedDepth = normalizePositiveInteger(request.requestedDepth);
  const requestedBudgetUsd = normalizePositiveBudgetUsd(request.requestedBudgetUsd);
  const packetBudgetPerClone = normalizePositiveInteger(request.packetBudgetPerClone);

  if (missionId.length === 0) {
    reasons.push("missionId is required.");
  }
  if (rootTaskId.length === 0) {
    reasons.push("rootTaskId is required.");
  }
  if (missionAttemptId === null) {
    reasons.push("missionAttemptId must be a positive integer.");
  }
  if (request.phase !== "parallel_spike") {
    reasons.push("phase must be parallel_spike.");
  }
  if (!CLONE_ROLE_SET.has(request.cloneRole)) {
    reasons.push("cloneRole is invalid.");
  }
  if (requestedCloneCount === null || requestedCloneCount > bounds.maxClonesPerParallelSpike) {
    reasons.push("requestedCloneCount exceeds resolved parallel-spike bounds.");
  }
  if (requestedDepth === null || requestedDepth > bounds.maxCloneDepth) {
    reasons.push("requestedDepth exceeds resolved parallel-spike bounds.");
  }
  if (requestedBudgetUsd === null || requestedBudgetUsd > bounds.maxCloneBudgetUsd) {
    reasons.push("requestedBudgetUsd exceeds resolved parallel-spike bounds.");
  }
  if (packetBudgetPerClone === null || packetBudgetPerClone > bounds.maxPacketsPerClone) {
    reasons.push("packetBudgetPerClone exceeds resolved parallel-spike bounds.");
  }

  if (reasons.length > 0) {
    return {
      valid: false,
      normalizedRequest: null,
      blockCode: "CLONE_QUEUE_OBJECT_INVALID",
      reasons
    };
  }

  return {
    valid: true,
    normalizedRequest: {
      missionId,
      missionAttemptId: missionAttemptId!,
      rootTaskId,
      phase: "parallel_spike",
      cloneRole: request.cloneRole,
      requestedCloneCount: requestedCloneCount!,
      requestedDepth: requestedDepth!,
      requestedBudgetUsd: requestedBudgetUsd!,
      packetBudgetPerClone: packetBudgetPerClone!
    },
    blockCode: null,
    reasons: ["Queue request is valid for orchestrator-managed parallel spike routing."]
  };
}

/**
 * Builds option packet v1 for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of option packet v1 consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `clampConfidence` (import `clampConfidence`) from `./cryptoUtils`.
 * - Uses `OptionPacketV1` (import `OptionPacketV1`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `OptionPacketV1` result.
 */
export function buildOptionPacketV1(input: ClonePacketDraftInput): OptionPacketV1 {
  return {
    packetId: normalizeText(input.packetId, "unknown_option_packet"),
    cloneId: normalizeText(input.cloneId, "unknown_clone"),
    recommendation: normalizeText(input.recommendation, "No recommendation provided."),
    tradeoffs: normalizeStringList(input.tradeoffs),
    risks: normalizeStringList(input.risks),
    evidenceRefs: normalizeStringList(input.evidenceRefs),
    confidence: clampConfidence(input.confidence),
    contentKind: input.contentKind
  };
}

/**
 * Builds findings packet v1 for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of findings packet v1 consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `clampConfidence` (import `clampConfidence`) from `./cryptoUtils`.
 * - Uses `FindingsPacketV1` (import `FindingsPacketV1`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `FindingsPacketV1` result.
 */
export function buildFindingsPacketV1(input: ClonePacketDraftInput): FindingsPacketV1 {
  return {
    packetId: normalizeText(input.packetId, "unknown_findings_packet"),
    cloneId: normalizeText(input.cloneId, "unknown_clone"),
    recommendation: normalizeText(input.recommendation, "No finding summary provided."),
    tradeoffs: normalizeStringList(input.tradeoffs),
    risks: normalizeStringList(input.risks),
    evidenceRefs: normalizeStringList(input.evidenceRefs),
    confidence: clampConfidence(input.confidence),
    contentKind: input.contentKind
  };
}

/**
 * Builds clone packet envelope v1 for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of clone packet envelope v1 consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `createSchemaEnvelopeV1` (import `createSchemaEnvelopeV1`) from `./schemaEnvelope`.
 * - Uses `verifySchemaEnvelopeV1` (import `verifySchemaEnvelopeV1`) from `./schemaEnvelope`.
 * - Uses `FindingsPacketV1` (import `FindingsPacketV1`) from `./types`.
 * - Uses `OptionPacketV1` (import `OptionPacketV1`) from `./types`.
 * - Uses `SchemaEnvelopeV1` (import `SchemaEnvelopeV1`) from `./types`.
 *
 * @param schemaName - Value for schema name.
 * @param payload - Structured input object for this operation.
 * @param createdAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed `SchemaEnvelopeV1<TPacket>` result.
 */
function createClonePacketEnvelopeV1<TPacket extends OptionPacketV1 | FindingsPacketV1>(
  schemaName: string,
  payload: TPacket,
  createdAt?: string
): SchemaEnvelopeV1<TPacket> {
  const envelope = createSchemaEnvelopeV1(schemaName, payload, createdAt);
  if (!verifySchemaEnvelopeV1(envelope)) {
    throw new Error("Clone packet envelope hash verification failed.");
  }
  return envelope;
}

/**
 * Builds option packet envelope v1 for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of option packet envelope v1 consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `OptionPacketV1` (import `OptionPacketV1`) from `./types`.
 * - Uses `SchemaEnvelopeV1` (import `SchemaEnvelopeV1`) from `./types`.
 *
 * @param payload - Structured input object for this operation.
 * @param createdAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed `SchemaEnvelopeV1<OptionPacketV1>` result.
 */
export function createOptionPacketEnvelopeV1(
  payload: OptionPacketV1,
  createdAt?: string
): SchemaEnvelopeV1<OptionPacketV1> {
  return createClonePacketEnvelopeV1("OptionPacketV1", payload, createdAt);
}

/**
 * Builds findings packet envelope v1 for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of findings packet envelope v1 consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `FindingsPacketV1` (import `FindingsPacketV1`) from `./types`.
 * - Uses `SchemaEnvelopeV1` (import `SchemaEnvelopeV1`) from `./types`.
 *
 * @param payload - Structured input object for this operation.
 * @param createdAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed `SchemaEnvelopeV1<FindingsPacketV1>` result.
 */
export function createFindingsPacketEnvelopeV1(
  payload: FindingsPacketV1,
  createdAt?: string
): SchemaEnvelopeV1<FindingsPacketV1> {
  return createClonePacketEnvelopeV1("FindingsPacketV1", payload, createdAt);
}

/**
 * Evaluates clone packet merge eligibility and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the clone packet merge eligibility policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ClonePacketContentKindV1` (import `ClonePacketContentKindV1`) from `./types`.
 *
 * @param contentKind - Value for content kind.
 * @returns Computed `ClonePacketMergeDecision` result.
 */
export function evaluateClonePacketMergeEligibility(
  contentKind: ClonePacketContentKindV1
): ClonePacketMergeDecision {
  if (MERGEABLE_PACKET_KINDS.has(contentKind)) {
    return {
      mergeable: true,
      blockCode: null,
      reason: "Clone packet content kind is merge-eligible under Stage 6.85 policy."
    };
  }
  return {
    mergeable: false,
    blockCode: "CLONE_PACKET_NON_MERGEABLE",
    reason: "Clone packet content kind is not merge-eligible under Stage 6.85 policy."
  };
}

/**
 * Evaluates clone action surface and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the clone action surface policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ActionType` (import `ActionType`) from `./types`.
 *
 * @param actionType - Value for action type.
 * @returns Computed `CloneActionSurfaceDecision` result.
 */
export function evaluateCloneActionSurface(actionType: ActionType): CloneActionSurfaceDecision {
  if (actionType === "respond") {
    return {
      allowed: true,
      blockCode: null,
      reason: "Clone action remains proposal-only without side effects."
    };
  }
  return {
    allowed: false,
    blockCode: "CLONE_DIRECT_SIDE_EFFECT_DENIED",
    reason: `Clone direct action '${actionType}' is denied to preserve no-side-effect policy.`
  };
}
