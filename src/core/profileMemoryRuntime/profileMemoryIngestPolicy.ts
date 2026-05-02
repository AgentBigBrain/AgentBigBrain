/**
 * @fileoverview Source-lane policy helpers for profile-memory ingestion.
 */

import type {
  ProfileMemoryIngestMemoryIntent,
  ProfileMemoryIngestPolicy,
  ProfileMemoryIngestSourceLane,
  ProfileMemorySourceAuthority,
  ProfileMemorySourceSurface
} from "./contracts";
import { normalizeSourceAuthority } from "../sourceAuthority";
import type { NormalizeSourceAuthorityOptions } from "../sourceAuthority";
import type {
  ProfileMemorySourceDefaultAuthority,
  ProfileMemorySourceFamily
} from "./profileMemoryTruthGovernanceSources";

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
  sourceLane?: ProfileMemoryIngestSourceLane;
  hasValidatedFactCandidates?: boolean;
}

interface NormalizeProfileMemoryIngestPolicyOptions {
  allowLegacyCompatibility?: boolean;
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
 * Maps one ingest source lane onto the same source-family defaults used by truth governance.
 *
 * **Why it exists:**
 * Ingest decides which extractors may run before candidates reach truth governance. Keeping source
 * lanes aligned with source families prevents media/document fragments from gaining durable
 * authority before governance sees them.
 *
 * @param sourceLane - Source lane attached to an ingest request.
 * @returns Source-family bucket used for default authority decisions.
 */
export function classifyProfileMemoryIngestSourceFamily(
  sourceLane: ProfileMemoryIngestSourceLane
): ProfileMemorySourceFamily {
  switch (sourceLane) {
    case "direct_user_text":
      return "explicit_user_statement";
    case "voice_transcript":
      return "conversation_context";
    case "document_text":
      return "document_text_extraction";
    case "document_summary":
      return "document_model_summary";
    case "image_ocr":
    case "image_summary":
      return "media_model_summary";
    case "validated_model_candidate":
      return "conversation_context";
  }
}

/**
 * Returns the default authority for an ingest source lane before per-family extraction gates run.
 *
 * @param sourceLane - Source lane attached to an ingest request.
 * @returns Default authority for the lane.
 */
export function getProfileMemoryIngestSourceDefaultAuthority(
  sourceLane: ProfileMemoryIngestSourceLane
): ProfileMemorySourceDefaultAuthority {
  const family = classifyProfileMemoryIngestSourceFamily(sourceLane);
  switch (family) {
    case "explicit_user_statement":
      return "durable_narrow_fact";
    case "conversation_context":
      return "support_only";
    case "document_text_extraction":
    case "document_model_summary":
    case "media_model_summary":
    case "lexical_relationship_pattern":
    case "lexical_episode_pattern":
      return "candidate_only";
    case "memory_review":
      return "review_override";
    case "reconciliation_projection":
    case "unknown":
      return "quarantine";
  }
}

/**
 * Maps ingest source lanes onto the shared source-authority vocabulary.
 *
 * @param sourceLane - Source lane attached to an ingest request.
 * @returns Canonical source authority for memory gates.
 */
export function profileMemoryIngestSourceLaneToAuthority(
  sourceLane: ProfileMemoryIngestSourceLane
): ProfileMemorySourceAuthority {
  switch (sourceLane) {
    case "direct_user_text":
      return "explicit_user_statement";
    case "voice_transcript":
    case "image_ocr":
      return "media_transcript";
    case "image_summary":
      return "media_model_summary";
    case "document_text":
      return "document_text";
    case "document_summary":
      return "document_model_summary";
    case "validated_model_candidate":
      return "semantic_model";
  }
}

/**
 * Normalizes memory source authority with legacy compatibility disabled by default.
 *
 * @param value - Candidate authority value.
 * @param options - Compatibility controls for legacy-only values.
 * @returns Canonical memory source authority or `unknown`.
 */
export function normalizeProfileMemorySourceAuthority(
  value: unknown,
  options: NormalizeSourceAuthorityOptions = {}
): ProfileMemorySourceAuthority {
  return normalizeSourceAuthority(value, options);
}

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
    policySource: "legacy_compatibility",
    sourceAuthority: "legacy_compatibility"
  };
}

/**
 * Builds the closed default used when no caller supplied an explicit memory-write policy.
 *
 * @param sourceSurface - Source surface attached to the attempted write.
 * @returns No-op ingest policy that leaves extraction disabled.
 */
export function buildClosedProfileMemoryIngestPolicy(
  sourceSurface: ProfileMemorySourceSurface = "broker_task_ingest"
): ProfileMemoryIngestPolicy {
  return {
    memoryIntent: "none",
    sourceLane: "direct_user_text",
    sourceSurface,
    allowExactSelfFactExtraction: false,
    allowDirectRelationshipExtraction: false,
    allowGenericProfileFactExtraction: false,
    allowCommitmentExtraction: false,
    allowEpisodeSupportExtraction: false,
    allowInferredResolution: false,
    fragmentPolicy: "ignore",
    policySource: "semantic_route",
    sourceAuthority: "unknown"
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
  const sourceLane = input.sourceLane ?? "direct_user_text";
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
      policySource: "structured_candidate",
      sourceAuthority: "semantic_model"
    };
  }

  if (input.memoryIntent === "none") {
    return {
      memoryIntent: "none",
      sourceLane,
      sourceSurface: input.sourceSurface,
      allowExactSelfFactExtraction: false,
      allowDirectRelationshipExtraction: false,
      allowGenericProfileFactExtraction: false,
      allowCommitmentExtraction: false,
      allowEpisodeSupportExtraction: false,
      allowInferredResolution: false,
      fragmentPolicy: "ignore",
      policySource: "semantic_route",
      sourceAuthority: profileMemoryIngestSourceLaneToAuthority(sourceLane)
    };
  }

  const memoryIntent = input.memoryIntent ?? "profile_update";
  const allowsProfileUpdate = memoryIntent === "profile_update";
  const allowsContextualMemory =
    memoryIntent === "contextual_recall" ||
    memoryIntent === "relationship_recall";
  const sourceAuthority = getProfileMemoryIngestSourceDefaultAuthority(sourceLane);

  if (sourceLane !== "direct_user_text") {
    return {
      memoryIntent,
      sourceLane,
      sourceSurface: input.sourceSurface,
      allowExactSelfFactExtraction: false,
      allowDirectRelationshipExtraction: false,
      allowGenericProfileFactExtraction: false,
      allowCommitmentExtraction: false,
      allowEpisodeSupportExtraction: sourceAuthority === "support_only" && allowsContextualMemory,
      allowInferredResolution: false,
      fragmentPolicy:
        sourceAuthority === "support_only"
          ? "support_only"
          : sourceAuthority === "candidate_only"
            ? "candidate_only"
            : "quarantine",
      policySource: input.memoryIntent ? "semantic_route" : "exact_command",
      sourceAuthority: profileMemoryIngestSourceLaneToAuthority(sourceLane)
    };
  }

  const policySource = input.memoryIntent ? "semantic_route" : "exact_command";
  return {
    memoryIntent,
    sourceLane,
    sourceSurface: input.sourceSurface,
    allowExactSelfFactExtraction: allowsProfileUpdate,
    allowDirectRelationshipExtraction: allowsProfileUpdate,
    allowGenericProfileFactExtraction: false,
    allowCommitmentExtraction: allowsProfileUpdate,
    allowEpisodeSupportExtraction: allowsProfileUpdate || allowsContextualMemory,
    allowInferredResolution: false,
    fragmentPolicy: allowsProfileUpdate ? "current_truth_allowed" : "support_only",
    policySource,
    sourceAuthority:
      policySource === "exact_command"
        ? "exact_command"
        : profileMemoryIngestSourceLaneToAuthority(sourceLane)
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
  fallbackSourceSurface: ProfileMemorySourceSurface = "broker_task_ingest",
  options: NormalizeProfileMemoryIngestPolicyOptions = {}
): ProfileMemoryIngestPolicy {
  if (policy) {
    return policy;
  }
  return options.allowLegacyCompatibility
    ? buildLegacyProfileMemoryIngestPolicy(fallbackSourceSurface)
    : buildClosedProfileMemoryIngestPolicy(fallbackSourceSurface);
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
