/**
 * @fileoverview Retention, disablement, and production-default policy for Source Recall.
 */

import type {
  SourceRecallCaptureClass,
  SourceRecallSourceKind,
  SourceRecallSourceRole
} from "./contracts";

export type SourceRecallProjectionMode = "review_safe" | "operator_full";

export interface SourceRecallRetentionPolicy {
  captureEnabled: boolean;
  retrievalEnabled: boolean;
  projectionEnabled: boolean;
  operatorFullProjectionEnabled: boolean;
  indexEnabled: boolean;
  evidenceModeEnabled: boolean;
  encryptedPayloadsRequired: boolean;
  encryptedPayloadsAvailable: boolean;
  sourceKindCaptureAllowlist: readonly SourceRecallSourceKind[];
  captureClassAllowlist: readonly SourceRecallCaptureClass[];
}

export interface SourceRecallPolicyDecision {
  allowed: boolean;
  reasons: readonly string[];
}

export interface SourceRecallCaptureDecisionInput {
  sourceKind: SourceRecallSourceKind;
  sourceRole: SourceRecallSourceRole;
  captureClass: SourceRecallCaptureClass;
}

export interface SourceRecallCaptureFailureDiagnostic {
  sourceKind: SourceRecallSourceKind;
  sourceRole: SourceRecallSourceRole;
  captureClass: SourceRecallCaptureClass;
  errorCode: string;
  originRefId?: string;
  sourceHashPrefix?: string;
}

export const DEFAULT_SOURCE_RECALL_CAPTURE_SOURCE_KINDS: readonly SourceRecallSourceKind[] = [
  "conversation_turn",
  "assistant_turn",
  "task_input",
  "task_summary",
  "document_text",
  "document_model_summary",
  "media_transcript",
  "ocr_text",
  "media_model_summary",
  "review_note",
  "execution_receipt_excerpt"
] as const;

export const DEFAULT_SOURCE_RECALL_CAPTURE_CLASSES: readonly SourceRecallCaptureClass[] = [
  "ordinary_source",
  "assistant_output"
] as const;

export const SOURCE_RECALL_PRODUCTION_REJECTED_CAPTURE_CLASSES: readonly SourceRecallCaptureClass[] = [
  "excluded_by_default",
  "test_fixture",
  "policy_metadata",
  "runtime_control_metadata",
  "projection_metadata",
  "repository_reference",
  "operational_output",
  "external_output"
] as const;

/**
 * Builds the fail-closed production default for Source Recall.
 *
 * **Why it exists:**
 * Source Recall stores sensitive source text, so production capture, retrieval, projection, and
 * indexing must remain disabled until explicit configuration and encryption readiness exist.
 *
 * **What it talks to:**
 * - Uses local default allowlists within this module.
 *
 * @returns Fail-closed Source Recall retention policy.
 */
export function createDefaultSourceRecallRetentionPolicy(): SourceRecallRetentionPolicy {
  return {
    captureEnabled: false,
    retrievalEnabled: false,
    projectionEnabled: false,
    operatorFullProjectionEnabled: false,
    indexEnabled: false,
    evidenceModeEnabled: false,
    encryptedPayloadsRequired: true,
    encryptedPayloadsAvailable: false,
    sourceKindCaptureAllowlist: DEFAULT_SOURCE_RECALL_CAPTURE_SOURCE_KINDS,
    captureClassAllowlist: DEFAULT_SOURCE_RECALL_CAPTURE_CLASSES
  };
}

/**
 * Builds Source Recall retention policy from environment flags.
 *
 * **Why it exists:**
 * The runtime needs a deterministic config seam before any future capture path can check whether
 * Source Recall is enabled.
 *
 * **What it talks to:**
 * - Uses `createDefaultSourceRecallRetentionPolicy` from this module.
 *
 * @param env - Environment source.
 * @returns Source Recall retention policy.
 */
export function createSourceRecallRetentionPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SourceRecallRetentionPolicy {
  const defaults = createDefaultSourceRecallRetentionPolicy();
  return {
    ...defaults,
    captureEnabled: parseBooleanEnvFlag(env.BRAIN_SOURCE_RECALL_CAPTURE_ENABLED, false),
    retrievalEnabled: parseBooleanEnvFlag(env.BRAIN_SOURCE_RECALL_RETRIEVAL_ENABLED, false),
    projectionEnabled: parseBooleanEnvFlag(env.BRAIN_SOURCE_RECALL_PROJECTION_ENABLED, false),
    operatorFullProjectionEnabled: parseBooleanEnvFlag(
      env.BRAIN_SOURCE_RECALL_OPERATOR_FULL_PROJECTION_ENABLED,
      false
    ),
    indexEnabled: parseBooleanEnvFlag(env.BRAIN_SOURCE_RECALL_INDEX_ENABLED, false),
    evidenceModeEnabled: parseBooleanEnvFlag(env.BRAIN_SOURCE_RECALL_EVIDENCE_MODE, false),
    encryptedPayloadsRequired: parseBooleanEnvFlag(
      env.BRAIN_SOURCE_RECALL_ENCRYPTED_PAYLOADS_REQUIRED,
      true
    ),
    encryptedPayloadsAvailable: parseBooleanEnvFlag(
      env.BRAIN_SOURCE_RECALL_ENCRYPTED_PAYLOADS_AVAILABLE,
      false
    )
  };
}

/**
 * Decides whether one Source Recall capture is allowed by policy.
 *
 * **Why it exists:**
 * Future runtime capture paths need a single fail-closed gate that blocks production capture unless
 * Source Recall is enabled, encryption is available, and the source class is explicitly allowed.
 *
 * **What it talks to:**
 * - Uses local policy contracts within this module.
 *
 * @param policy - Current Source Recall retention policy.
 * @param input - Source kind, role, and capture class under review.
 * @returns Allow/block decision with stable reasons.
 */
export function decideSourceRecallCapture(
  policy: SourceRecallRetentionPolicy,
  input: SourceRecallCaptureDecisionInput
): SourceRecallPolicyDecision {
  const reasons: string[] = [];
  if (!policy.captureEnabled) {
    reasons.push("source_recall_capture_disabled");
  }
  if (policy.encryptedPayloadsRequired && !policy.encryptedPayloadsAvailable) {
    reasons.push("source_recall_encryption_unavailable");
  }
  if (!policy.sourceKindCaptureAllowlist.includes(input.sourceKind)) {
    reasons.push("source_recall_source_kind_not_allowed");
  }
  if (!policy.captureClassAllowlist.includes(input.captureClass)) {
    reasons.push("source_recall_capture_class_not_allowed");
  }
  if (
    (input.sourceRole === "test_fixture" || isSourceRecallProductionRejectedFixture(input)) &&
    !policy.evidenceModeEnabled
  ) {
    reasons.push("source_recall_test_fixture_rejected");
  }
  return {
    allowed: reasons.length === 0,
    reasons
  };
}

/**
 * Builds a bounded diagnostic for a blocked Source Recall capture.
 *
 * **Why it exists:**
 * Capture failures should be observable without creating a plaintext leak path for rejected source
 * material.
 *
 * **What it talks to:**
 * - Uses local policy contracts within this module.
 *
 * @param input - Capture input that failed policy.
 * @param errorCode - Stable failure code.
 * @param options - Optional non-sensitive origin and hash-prefix metadata.
 * @returns Capture failure diagnostic with no raw source text.
 */
export function buildSourceRecallCaptureFailureDiagnostic(
  input: SourceRecallCaptureDecisionInput,
  errorCode: string,
  options: {
    originRefId?: string;
    sourceHashPrefix?: string;
  } = {}
): SourceRecallCaptureFailureDiagnostic {
  return {
    sourceKind: input.sourceKind,
    sourceRole: input.sourceRole,
    captureClass: input.captureClass,
    errorCode,
    originRefId: options.originRefId,
    sourceHashPrefix: options.sourceHashPrefix
  };
}

/**
 * Returns whether one capture class is rejected in production by default.
 *
 * **Why it exists:**
 * The non-capture firewall needs one explicit list for generated, fixture, policy, runtime, and
 * projection surfaces that require evidence mode or future structured review before capture.
 *
 * **What it talks to:**
 * - Uses local rejected-class constants within this module.
 *
 * @param captureClass - Capture class under review.
 * @returns `true` when production capture rejects the class by default.
 */
export function isSourceRecallProductionRejectedCaptureClass(
  captureClass: SourceRecallCaptureClass
): boolean {
  return SOURCE_RECALL_PRODUCTION_REJECTED_CAPTURE_CLASSES.includes(captureClass);
}

/**
 * Decides whether Source Recall retrieval is available.
 *
 * **Why it exists:**
 * Retrieval should not become active until storage and retention initialization has explicitly
 * enabled it.
 *
 * **What it talks to:**
 * - Uses local policy contracts within this module.
 *
 * @param policy - Current Source Recall retention policy.
 * @returns Allow/block decision.
 */
export function decideSourceRecallRetrieval(
  policy: SourceRecallRetentionPolicy
): SourceRecallPolicyDecision {
  return policy.retrievalEnabled
    ? { allowed: true, reasons: [] }
    : { allowed: false, reasons: ["source_recall_retrieval_disabled"] };
}

/**
 * Decides whether Source Recall projection is available.
 *
 * **Why it exists:**
 * Review-safe projection must remain the default, while operator-full projection needs its own
 * explicit latch before fuller excerpts can leave the runtime.
 *
 * **What it talks to:**
 * - Uses local policy contracts within this module.
 *
 * @param policy - Current Source Recall retention policy.
 * @param mode - Projection visibility mode under review.
 * @returns Allow/block decision.
 */
export function decideSourceRecallProjection(
  policy: SourceRecallRetentionPolicy,
  mode: SourceRecallProjectionMode
): SourceRecallPolicyDecision {
  const reasons: string[] = [];
  if (!policy.projectionEnabled) {
    reasons.push("source_recall_projection_disabled");
  }
  if (mode === "operator_full" && !policy.operatorFullProjectionEnabled) {
    reasons.push("source_recall_operator_full_projection_disabled");
  }
  return {
    allowed: reasons.length === 0,
    reasons
  };
}

/**
 * Decides whether Source Recall indexing is available.
 *
 * **Why it exists:**
 * Index and embedding state must remain disabled until Source Recall is initialized and lifecycle
 * cleanup exists.
 *
 * **What it talks to:**
 * - Uses local policy contracts within this module.
 *
 * @param policy - Current Source Recall retention policy.
 * @returns Allow/block decision.
 */
export function decideSourceRecallIndexing(
  policy: SourceRecallRetentionPolicy
): SourceRecallPolicyDecision {
  return policy.indexEnabled
    ? { allowed: true, reasons: [] }
    : { allowed: false, reasons: ["source_recall_indexing_disabled"] };
}

/**
 * Parses one boolean environment flag with an explicit default.
 *
 * **Why it exists:**
 * Source Recall config should fail closed on absent or ambiguous values instead of relying on
 * truthy string behavior.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Candidate environment value.
 * @param defaultValue - Default when the value is absent or unknown.
 * @returns Parsed boolean.
 */
function parseBooleanEnvFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

/**
 * Returns whether one capture input represents fixture evidence.
 *
 * **Why it exists:**
 * Fixture rejection should consider both source role and capture class so tests cannot enter
 * production recall by changing only one field.
 *
 * **What it talks to:**
 * - Uses local type contracts within this module.
 *
 * @param input - Capture input under review.
 * @returns `true` when input is fixture-labeled.
 */
function isSourceRecallProductionRejectedFixture(input: SourceRecallCaptureDecisionInput): boolean {
  return input.captureClass === "test_fixture";
}
