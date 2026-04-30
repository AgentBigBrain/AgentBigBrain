/**
 * @fileoverview Source-lane policy helpers for profile-memory ingestion.
 */

import type {
  ProfileMemoryIngestMemoryIntent,
  ProfileMemoryIngestPolicy,
  ProfileMemorySourceSurface
} from "./contracts";

export interface ProfileMemoryExtractionStageSelection {
  exactSelfFacts: boolean;
  directRelationshipFacts: boolean;
  genericProfileFacts: boolean;
  commitments: boolean;
  episodeSupport: boolean;
  inferredEpisodeResolution: boolean;
  validatedCandidates: boolean;
}

interface BuildProfileMemoryIngestPolicyInput {
  memoryIntent: ProfileMemoryIngestMemoryIntent | null;
  sourceSurface: ProfileMemorySourceSurface;
  hasValidatedFactCandidates?: boolean;
}

const INACTIVE_STAGE_SELECTION: ProfileMemoryExtractionStageSelection = {
  exactSelfFacts: false,
  directRelationshipFacts: false,
  genericProfileFacts: false,
  commitments: false,
  episodeSupport: false,
  inferredEpisodeResolution: false,
  validatedCandidates: false
};

/**
 * Builds the temporary compatibility policy used only while older callers are migrated.
 *
 * **Why it exists:**
 * Phase 1 needs to add an explicit policy contract without changing every historical direct store
 * test at once. Keeping the permissive default here makes later removal auditable.
 *
 * **What it talks to:**
 * - Uses local type contracts from `./contracts`.
 *
 * @param sourceSurface - Source surface attached to the legacy write seam.
 * @returns Permissive legacy ingest policy.
 */
export function buildLegacyProfileMemoryIngestPolicy(
  sourceSurface: ProfileMemorySourceSurface = "broker_task_ingest"
): ProfileMemoryIngestPolicy {
  return {
    memoryIntent: "profile_update",
    sourceLane: "direct_user_text",
    sourceSurface,
    allowExactSelfFactExtraction: true,
    allowDirectRelationshipExtraction: true,
    allowGenericProfileFactExtraction: true,
    allowCommitmentExtraction: true,
    allowEpisodeSupportExtraction: true,
    allowInferredResolution: true,
    fragmentPolicy: "current_truth_allowed",
    policySource: "legacy_compatibility"
  };
}

/**
 * Builds the explicit write policy for conversation and broker profile-memory ingest.
 *
 * **Why it exists:**
 * Memory writes should consume typed route memory intent before extraction begins, while structured
 * identity candidates still need a narrow path that does not reopen broad text extraction.
 *
 * **What it talks to:**
 * - Uses local type contracts from `./contracts`.
 *
 * @param input - Route memory intent, surface, and candidate-shape metadata for this write.
 * @returns Explicit ingest policy for the canonical store seam.
 */
export function buildProfileMemoryIngestPolicy(
  input: BuildProfileMemoryIngestPolicyInput
): ProfileMemoryIngestPolicy {
  if (input.hasValidatedFactCandidates && input.memoryIntent !== "none") {
    return {
      memoryIntent: input.memoryIntent ?? "profile_update",
      sourceLane: "validated_model_candidate",
      sourceSurface: input.sourceSurface,
      allowExactSelfFactExtraction: false,
      allowDirectRelationshipExtraction: false,
      allowGenericProfileFactExtraction: false,
      allowCommitmentExtraction: false,
      allowEpisodeSupportExtraction: false,
      allowInferredResolution: false,
      fragmentPolicy: "current_truth_allowed",
      policySource: "structured_candidate"
    };
  }

  if (input.memoryIntent === "none") {
    return {
      memoryIntent: "none",
      sourceLane: "direct_user_text",
      sourceSurface: input.sourceSurface,
      allowExactSelfFactExtraction: false,
      allowDirectRelationshipExtraction: false,
      allowGenericProfileFactExtraction: false,
      allowCommitmentExtraction: false,
      allowEpisodeSupportExtraction: false,
      allowInferredResolution: false,
      fragmentPolicy: "ignore",
      policySource: "semantic_route"
    };
  }

  const memoryIntent = input.memoryIntent ?? "profile_update";
  const allowsProfileUpdate = memoryIntent === "profile_update";
  const allowsContextualMemory =
    memoryIntent === "contextual_recall" ||
    memoryIntent === "relationship_recall";

  return {
    memoryIntent,
    sourceLane: "direct_user_text",
    sourceSurface: input.sourceSurface,
    allowExactSelfFactExtraction: allowsProfileUpdate,
    allowDirectRelationshipExtraction: allowsProfileUpdate,
    allowGenericProfileFactExtraction: false,
    allowCommitmentExtraction: allowsProfileUpdate,
    allowEpisodeSupportExtraction: allowsProfileUpdate || allowsContextualMemory,
    allowInferredResolution: false,
    fragmentPolicy: allowsProfileUpdate ? "current_truth_allowed" : "support_only",
    policySource: input.memoryIntent ? "semantic_route" : "exact_command"
  };
}

/**
 * Normalizes an optional ingest policy before store extraction begins.
 *
 * **Why it exists:**
 * Centralizing fallback policy selection prevents each caller from inventing a different default
 * while the migration removes legacy compatibility from live write paths.
 *
 * **What it talks to:**
 * - Uses `buildLegacyProfileMemoryIngestPolicy` from this module.
 *
 * @param policy - Optional caller-supplied policy.
 * @param fallbackSourceSurface - Source surface used when legacy compatibility is required.
 * @returns Normalized ingest policy.
 */
export function normalizeProfileMemoryIngestPolicy(
  policy: ProfileMemoryIngestPolicy | null | undefined,
  fallbackSourceSurface: ProfileMemorySourceSurface = "broker_task_ingest"
): ProfileMemoryIngestPolicy {
  return policy ?? buildLegacyProfileMemoryIngestPolicy(fallbackSourceSurface);
}

/**
 * Selects extraction stages from the normalized ingest policy.
 *
 * **Why it exists:**
 * The store must decide which extraction lanes may run before broad text extractors execute.
 * Returning one stage record makes those gates easy to audit in the store.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param policy - Normalized ingest policy for the current write.
 * @returns Boolean stage-selection record consumed by extraction.
 */
export function selectProfileMemoryExtractionStages(
  policy: ProfileMemoryIngestPolicy
): ProfileMemoryExtractionStageSelection {
  if (policy.fragmentPolicy === "ignore" || policy.fragmentPolicy === "quarantine") {
    return { ...INACTIVE_STAGE_SELECTION };
  }

  return {
    exactSelfFacts: policy.allowExactSelfFactExtraction,
    directRelationshipFacts: policy.allowDirectRelationshipExtraction,
    genericProfileFacts: policy.allowGenericProfileFactExtraction,
    commitments: policy.allowCommitmentExtraction,
    episodeSupport: policy.allowEpisodeSupportExtraction,
    inferredEpisodeResolution: policy.allowInferredResolution,
    validatedCandidates:
      policy.memoryIntent !== "none" &&
      (
        policy.sourceLane === "validated_model_candidate" ||
        policy.policySource === "structured_candidate" ||
        policy.policySource === "legacy_compatibility"
      )
  };
}
