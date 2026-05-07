/**
 * @fileoverview Typed proactive inquiry candidates for dynamic pulse.
 */

import type { PulseCandidateV1, PulseReasonCodeV1 } from "../types";

export type ProactiveInquiryType =
  | "clarify_memory"
  | "resume_open_loop"
  | "ask_missing_constraint"
  | "revalidate_stale_fact"
  | "surface_pattern"
  | "suggest_workflow_improvement"
  | "follow_up_user_requested"
  | "ask_review_priority";

export type PulseUserValueReason =
  | "prevents_stale_work"
  | "clarifies_ambiguous_memory"
  | "unblocks_saved_work"
  | "revalidates_likely_stale_fact"
  | "captures_user_preference"
  | "surfaces_useful_pattern"
  | "asks_for_missing_constraint"
  | "protects_against_wrong_assumption";

export type ProactiveInquirySourceRecallStatus =
  | "not_used"
  | "available"
  | "disabled"
  | "blocked"
  | "unavailable";

export type ProactiveInquiryEvidenceBlockReason =
  | "forgotten"
  | "redacted"
  | "expired"
  | "quarantined"
  | "public_unsafe"
  | "assistant_only"
  | "task_summary_only"
  | "media_document_without_policy"
  | "source_recall_disabled"
  | "source_recall_blocked"
  | "source_recall_unavailable";

export interface ProactiveInquiryQuestionPlan {
  userFacingGoal: string;
  allowedTopic: string;
  forbiddenDetails: readonly string[];
  suggestedTone: "direct" | "tentative" | "casual" | "formal";
  boundedDraft: string | null;
}

export interface ProactiveInquiryCandidate {
  candidateId: string;
  sourcePulseCandidateId: string | null;
  inquiryType: ProactiveInquiryType;
  userValueReason: PulseUserValueReason;
  userValueRationale: string;
  questionPlan: ProactiveInquiryQuestionPlan;
  evidence: {
    sourceRecallRefs: readonly string[];
    memoryRefs: readonly string[];
    graphRefs: readonly string[];
    recentTurnRefs: readonly string[];
  };
  evidencePolicy: {
    sourceRecallStatus: ProactiveInquirySourceRecallStatus;
    sourceRecallUsable: boolean;
    blockedSourceRecallRefs: readonly string[];
    blockReasons: readonly ProactiveInquiryEvidenceBlockReason[];
  };
  risk: {
    interruptionRisk: "low" | "medium" | "high";
    privacyRisk: "none" | "private_only" | "sensitive" | "blocked";
    publicSafe: boolean;
    activeMissionSafe: boolean;
  };
  confidence: number;
  novelty: number;
  expectedUserValue: number;
  authority: {
    outreachAuthority: false;
    memoryWriteAuthority: false;
    truthAuthority: false;
    approvalAuthority: false;
    deliveryPermission: false;
  };
}

export interface ProactiveInquiryCandidateDraft {
  candidateId?: unknown;
  sourcePulseCandidateId?: unknown;
  inquiryType?: unknown;
  userValueReason?: unknown;
  userValueRationale?: unknown;
  questionPlan?: unknown;
  evidence?: unknown;
  evidencePolicy?: unknown;
  risk?: unknown;
  confidence?: unknown;
  novelty?: unknown;
  expectedUserValue?: unknown;
}

const MAX_RATIONALE_CHARS = 360;
const MAX_GOAL_CHARS = 180;
const MAX_TOPIC_CHARS = 120;
const MAX_DRAFT_CHARS = 240;
const MAX_FORBIDDEN_DETAILS = 8;
const MIN_CONFIDENCE = 0.7;
const MIN_EXPECTED_USER_VALUE = 0.35;

const INQUIRY_TYPES: readonly ProactiveInquiryType[] = [
  "clarify_memory",
  "resume_open_loop",
  "ask_missing_constraint",
  "revalidate_stale_fact",
  "surface_pattern",
  "suggest_workflow_improvement",
  "follow_up_user_requested",
  "ask_review_priority"
] as const;

const USER_VALUE_REASONS: readonly PulseUserValueReason[] = [
  "prevents_stale_work",
  "clarifies_ambiguous_memory",
  "unblocks_saved_work",
  "revalidates_likely_stale_fact",
  "captures_user_preference",
  "surfaces_useful_pattern",
  "asks_for_missing_constraint",
  "protects_against_wrong_assumption"
] as const;

const BLOCK_REASONS: readonly ProactiveInquiryEvidenceBlockReason[] = [
  "forgotten",
  "redacted",
  "expired",
  "quarantined",
  "public_unsafe",
  "assistant_only",
  "task_summary_only",
  "media_document_without_policy",
  "source_recall_disabled",
  "source_recall_blocked",
  "source_recall_unavailable"
] as const;

/**
 * Builds the non-authority flags every proactive inquiry candidate must carry.
 *
 * @returns Non-authority flags.
 */
export function buildProactiveInquiryAuthorityFlags(): ProactiveInquiryCandidate["authority"] {
  return {
    outreachAuthority: false,
    memoryWriteAuthority: false,
    truthAuthority: false,
    approvalAuthority: false,
    deliveryPermission: false
  };
}

/**
 * Converts one deterministic pulse candidate into a typed inquiry candidate.
 *
 * @param candidate - Deterministic Stage 6.86 pulse candidate.
 * @param options - Source Recall state and optional rationale overrides.
 * @returns Proactive inquiry candidate.
 */
export function buildProactiveInquiryCandidateFromPulseCandidate(
  candidate: PulseCandidateV1,
  options: {
    sourceRecallStatus?: ProactiveInquirySourceRecallStatus;
    sourceRecallRefs?: readonly string[];
    blockedSourceRecallRefs?: readonly string[];
    blockReasons?: readonly ProactiveInquiryEvidenceBlockReason[];
    userValueRationale?: string;
  } = {}
): ProactiveInquiryCandidate {
  const inquiryType = mapPulseReasonToInquiryType(candidate.reasonCode);
  const userValueReason = mapPulseReasonToUserValueReason(candidate.reasonCode);
  const sourceRecallStatus = options.sourceRecallStatus ?? "not_used";
  const blockReasons = normalizeBlockReasons(options.blockReasons ?? []);
  const sourceRecallUsable = sourceRecallStatus === "available" && blockReasons.length === 0;

  return {
    candidateId: `inquiry_${candidate.candidateId}`,
    sourcePulseCandidateId: candidate.candidateId,
    inquiryType,
    userValueReason,
    userValueRationale: boundText(
      options.userValueRationale ?? defaultUserValueRationale(candidate.reasonCode),
      MAX_RATIONALE_CHARS
    ),
    questionPlan: {
      userFacingGoal: defaultQuestionGoal(inquiryType),
      allowedTopic: candidate.threadKey ?? candidate.entityRefs[0] ?? "current conversation",
      forbiddenDetails: candidate.sensitive ? ["private or sensitive details"] : [],
      suggestedTone: candidate.score >= 0.6 ? "direct" : "tentative",
      boundedDraft: null
    },
    evidence: {
      sourceRecallRefs: normalizeStringList(options.sourceRecallRefs ?? []),
      memoryRefs: [],
      graphRefs: normalizeStringList(candidate.entityRefs),
      recentTurnRefs: normalizeStringList(candidate.evidenceRefs)
    },
    evidencePolicy: {
      sourceRecallStatus,
      sourceRecallUsable,
      blockedSourceRecallRefs: normalizeStringList(options.blockedSourceRecallRefs ?? []),
      blockReasons
    },
    risk: {
      interruptionRisk: candidate.score >= 0.6 ? "low" : "medium",
      privacyRisk: candidate.sensitive ? "sensitive" : "none",
      publicSafe: !candidate.sensitive && sourceRecallStatus !== "available",
      activeMissionSafe: !candidate.activeMissionSuppressed
    },
    confidence: clamp01(candidate.score),
    novelty: clamp01(1 - candidate.scoreBreakdown.cooldownPenalty),
    expectedUserValue: clamp01(candidate.score),
    authority: buildProactiveInquiryAuthorityFlags()
  };
}

/**
 * Normalizes model/schema output into one proactive inquiry candidate.
 *
 * @param raw - Model or fixture output.
 * @returns Candidate, or `null` when output is malformed or low confidence.
 */
export function normalizeProactiveInquiryCandidate(
  raw: ProactiveInquiryCandidateDraft
): ProactiveInquiryCandidate | null {
  const candidateId = normalizeRequiredText(raw.candidateId, 80);
  const inquiryType = normalizeInquiryType(raw.inquiryType);
  const userValueReason = normalizeUserValueReason(raw.userValueReason);
  const userValueRationale = normalizeRequiredText(raw.userValueRationale, MAX_RATIONALE_CHARS);
  const questionPlan = normalizeQuestionPlan(raw.questionPlan);
  const evidence = normalizeEvidence(raw.evidence);
  const evidencePolicy = normalizeEvidencePolicy(raw.evidencePolicy);
  const risk = normalizeRisk(raw.risk);
  const confidence = normalizeScore(raw.confidence);
  const novelty = normalizeScore(raw.novelty);
  const expectedUserValue = normalizeScore(raw.expectedUserValue);

  if (
    !candidateId ||
    !inquiryType ||
    !userValueReason ||
    !userValueRationale ||
    !questionPlan ||
    !evidence ||
    !evidencePolicy ||
    !risk ||
    confidence < MIN_CONFIDENCE ||
    expectedUserValue < MIN_EXPECTED_USER_VALUE
  ) {
    return null;
  }

  return {
    candidateId,
    sourcePulseCandidateId: normalizeOptionalText(raw.sourcePulseCandidateId, 80),
    inquiryType,
    userValueReason,
    userValueRationale,
    questionPlan,
    evidence,
    evidencePolicy,
    risk,
    confidence,
    novelty,
    expectedUserValue,
    authority: buildProactiveInquiryAuthorityFlags()
  };
}

/**
 * Maps Stage 6.86 reason codes into proactive inquiry types.
 *
 * @param reasonCode - Pulse reason code.
 * @returns Inquiry type.
 */
function mapPulseReasonToInquiryType(reasonCode: PulseReasonCodeV1): ProactiveInquiryType {
  switch (reasonCode) {
    case "RELATIONSHIP_CLARIFICATION":
      return "clarify_memory";
    case "STALE_FACT_REVALIDATION":
      return "revalidate_stale_fact";
    case "USER_REQUESTED_FOLLOWUP":
      return "follow_up_user_requested";
    case "TOPIC_DRIFT_RESUME":
    case "OPEN_LOOP_RESUME":
      return "resume_open_loop";
    default:
      return "ask_missing_constraint";
  }
}

/**
 * Maps Stage 6.86 reason codes into user-value reasons.
 *
 * @param reasonCode - Pulse reason code.
 * @returns User-value reason.
 */
function mapPulseReasonToUserValueReason(reasonCode: PulseReasonCodeV1): PulseUserValueReason {
  switch (reasonCode) {
    case "RELATIONSHIP_CLARIFICATION":
      return "clarifies_ambiguous_memory";
    case "STALE_FACT_REVALIDATION":
      return "revalidates_likely_stale_fact";
    case "USER_REQUESTED_FOLLOWUP":
      return "unblocks_saved_work";
    case "TOPIC_DRIFT_RESUME":
    case "OPEN_LOOP_RESUME":
      return "prevents_stale_work";
    default:
      return "asks_for_missing_constraint";
  }
}

/**
 * Provides a bounded default user-value rationale.
 *
 * @param reasonCode - Pulse reason code.
 * @returns User-value rationale.
 */
function defaultUserValueRationale(reasonCode: PulseReasonCodeV1): string {
  switch (reasonCode) {
    case "RELATIONSHIP_CLARIFICATION":
      return "Clarifying this could prevent the assistant from carrying an ambiguous memory forward.";
    case "STALE_FACT_REVALIDATION":
      return "Revalidating this could prevent stale context from guiding future work.";
    case "USER_REQUESTED_FOLLOWUP":
      return "The user previously asked for a follow-up, so this may unblock saved work.";
    case "TOPIC_DRIFT_RESUME":
    case "OPEN_LOOP_RESUME":
      return "Resuming this could prevent useful work context from going stale.";
    default:
      return "A missing constraint may block a better answer or workflow.";
  }
}

/**
 * Provides a bounded question goal for an inquiry type.
 *
 * @param inquiryType - Inquiry type.
 * @returns User-facing goal.
 */
function defaultQuestionGoal(inquiryType: ProactiveInquiryType): string {
  switch (inquiryType) {
    case "clarify_memory":
      return "Ask one concise question that clarifies ambiguous memory context.";
    case "resume_open_loop":
      return "Ask whether the user wants to resume the open loop.";
    case "revalidate_stale_fact":
      return "Ask whether older context is still accurate.";
    case "follow_up_user_requested":
      return "Ask one concise follow-up tied to the user's prior request.";
    default:
      return "Ask for the missing constraint before making assumptions.";
  }
}

/**
 * Normalizes one model-provided question plan.
 *
 * @param value - Candidate plan.
 * @returns Normalized plan or `null`.
 */
function normalizeQuestionPlan(value: unknown): ProactiveInquiryQuestionPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const userFacingGoal = normalizeRequiredText(record.userFacingGoal, MAX_GOAL_CHARS);
  const allowedTopic = normalizeRequiredText(record.allowedTopic, MAX_TOPIC_CHARS);
  const suggestedTone = normalizeTone(record.suggestedTone);
  if (!userFacingGoal || !allowedTopic || !suggestedTone) {
    return null;
  }
  return {
    userFacingGoal,
    allowedTopic,
    forbiddenDetails: normalizeStringList(record.forbiddenDetails).slice(0, MAX_FORBIDDEN_DETAILS),
    suggestedTone,
    boundedDraft: normalizeOptionalText(record.boundedDraft, MAX_DRAFT_CHARS)
  };
}

/**
 * Normalizes one evidence block.
 *
 * @param value - Candidate evidence payload.
 * @returns Normalized evidence or `null`.
 */
function normalizeEvidence(value: unknown): ProactiveInquiryCandidate["evidence"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    sourceRecallRefs: normalizeStringList(record.sourceRecallRefs),
    memoryRefs: normalizeStringList(record.memoryRefs),
    graphRefs: normalizeStringList(record.graphRefs),
    recentTurnRefs: normalizeStringList(record.recentTurnRefs)
  };
}

/**
 * Normalizes one evidence policy block.
 *
 * @param value - Candidate evidence policy.
 * @returns Normalized evidence policy or `null`.
 */
function normalizeEvidencePolicy(value: unknown): ProactiveInquiryCandidate["evidencePolicy"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const status = normalizeSourceRecallStatus(record.sourceRecallStatus);
  if (!status) {
    return null;
  }
  const blockReasons = normalizeBlockReasons(record.blockReasons);
  return {
    sourceRecallStatus: status,
    sourceRecallUsable: status === "available" && blockReasons.length === 0,
    blockedSourceRecallRefs: normalizeStringList(record.blockedSourceRecallRefs),
    blockReasons
  };
}

/**
 * Normalizes one risk block.
 *
 * @param value - Candidate risk payload.
 * @returns Normalized risk or `null`.
 */
function normalizeRisk(value: unknown): ProactiveInquiryCandidate["risk"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const interruptionRisk = normalizeEnum(record.interruptionRisk, ["low", "medium", "high"] as const);
  const privacyRisk = normalizeEnum(record.privacyRisk, ["none", "private_only", "sensitive", "blocked"] as const);
  if (!interruptionRisk || !privacyRisk) {
    return null;
  }
  return {
    interruptionRisk,
    privacyRisk,
    publicSafe: record.publicSafe === true,
    activeMissionSafe: record.activeMissionSafe === true
  };
}

/**
 * Normalizes source recall status.
 *
 * @param value - Candidate status.
 * @returns Normalized status or `null`.
 */
function normalizeSourceRecallStatus(value: unknown): ProactiveInquirySourceRecallStatus | null {
  return normalizeEnum(value, ["not_used", "available", "disabled", "blocked", "unavailable"] as const);
}

/**
 * Normalizes inquiry type.
 *
 * @param value - Candidate type.
 * @returns Inquiry type or `null`.
 */
function normalizeInquiryType(value: unknown): ProactiveInquiryType | null {
  return normalizeEnum(value, INQUIRY_TYPES);
}

/**
 * Normalizes user-value reason.
 *
 * @param value - Candidate value reason.
 * @returns User-value reason or `null`.
 */
function normalizeUserValueReason(value: unknown): PulseUserValueReason | null {
  return normalizeEnum(value, USER_VALUE_REASONS);
}

/**
 * Normalizes suggested tone.
 *
 * @param value - Candidate tone.
 * @returns Tone or `null`.
 */
function normalizeTone(value: unknown): ProactiveInquiryQuestionPlan["suggestedTone"] | null {
  return normalizeEnum(value, ["direct", "tentative", "casual", "formal"] as const);
}

/**
 * Normalizes block reasons.
 *
 * @param value - Candidate block reason list.
 * @returns Bounded block reason list.
 */
function normalizeBlockReasons(value: unknown): ProactiveInquiryEvidenceBlockReason[] {
  return normalizeStringList(value)
    .filter((reason): reason is ProactiveInquiryEvidenceBlockReason =>
      BLOCK_REASONS.includes(reason as ProactiveInquiryEvidenceBlockReason)
    );
}

/**
 * Normalizes a string enum.
 *
 * @param value - Candidate enum value.
 * @param allowed - Allowed values.
 * @returns Normalized enum value or `null`.
 */
function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : null;
}

/**
 * Normalizes a required bounded text field.
 *
 * @param value - Candidate text.
 * @param maxChars - Maximum characters.
 * @returns Normalized text or `null`.
 */
function normalizeRequiredText(value: unknown, maxChars: number): string | null {
  const normalized = normalizeOptionalText(value, maxChars);
  return normalized && normalized.length > 0 ? normalized : null;
}

/**
 * Normalizes an optional bounded text field.
 *
 * @param value - Candidate text.
 * @param maxChars - Maximum characters.
 * @returns Normalized text or `null`.
 */
function normalizeOptionalText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = boundText(value, maxChars);
  return normalized.length > 0 ? normalized : null;
}

/**
 * Normalizes a string list.
 *
 * @param value - Candidate list.
 * @returns Bounded string list.
 */
function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? boundText(entry, 120) : ""))
    .filter((entry) => entry.length > 0);
}

/**
 * Normalizes a numeric score.
 *
 * @param value - Candidate score.
 * @returns Clamped score.
 */
function normalizeScore(value: unknown): number {
  return typeof value === "number" ? clamp01(value) : 0;
}

/**
 * Bounds text and collapses whitespace.
 *
 * @param value - Candidate text.
 * @param maxChars - Maximum characters.
 * @returns Bounded text.
 */
function boundText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 3)}...`;
}

/**
 * Clamps a score to [0, 1].
 *
 * @param value - Candidate score.
 * @returns Clamped score.
 */
function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value >= 1 ? 1 : value;
}
