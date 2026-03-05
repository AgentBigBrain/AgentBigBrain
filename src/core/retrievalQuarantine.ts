/**
 * @fileoverview Deterministic Stage 6.75 retrieval-quarantine gate that distills external text into `DistilledPacketV1` and fails closed on policy violations.
 */

import {
  DistilledPacketV1,
  Stage675BlockCode
} from "./types";
import {
  canonicalJson,
  sha256Hex,
  sha256HexFromCanonicalJson
} from "./normalizers/canonicalizationRules";

interface RiskSignalRule {
  signal: string;
  pattern: RegExp;
}

const DEFAULT_ALLOWED_CONTENT_TYPES = [
  "text/plain",
  "text/markdown",
  "application/json"
] as const;

const RISK_SIGNAL_RULES: readonly RiskSignalRule[] = [
  {
    signal: "prompt_injection_ignore_previous",
    pattern: /ignore(?:\s+all)?\s+previous\s+instructions/i
  },
  {
    signal: "tooling_command_injection",
    pattern: /\b(?:sudo|powershell|cmd\.exe|bash|curl\s+\|)\b/i
  },
  {
    signal: "private_range_target",
    pattern: /\b(?:169\.254\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|[a-z0-9-]+\.local)\b/i
  },
  {
    signal: "script_payload",
    pattern: /<script\b|javascript:/i
  }
] as const;

export interface RetrievalQuarantineInput {
  sourceKind: DistilledPacketV1["sourceKind"];
  sourceId: string;
  contentType: string;
  rawContent: string;
  observedAt: string;
}

export interface RetrievalQuarantinePolicy {
  nowIso: string;
  maxBytes: number;
  summaryMaxChars: number;
  excerptMaxChars: number;
  allowedContentTypes: readonly string[];
  escalationPathEnabled: boolean;
  securityAcknowledged: boolean;
}

export interface RetrievalQuarantineFailure {
  ok: false;
  blockCode: Stage675BlockCode;
  reason: string;
  riskSignals: readonly string[];
}

export interface RetrievalQuarantineSuccess {
  ok: true;
  packet: DistilledPacketV1;
}

export type RetrievalQuarantineResult = RetrievalQuarantineFailure | RetrievalQuarantineSuccess;

/**
 * Builds default retrieval quarantine policy for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of default retrieval quarantine policy consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param nowIso - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed `RetrievalQuarantinePolicy` result.
 */
export function buildDefaultRetrievalQuarantinePolicy(nowIso: string): RetrievalQuarantinePolicy {
  return {
    nowIso,
    maxBytes: 1_048_576,
    summaryMaxChars: 1_000,
    excerptMaxChars: 240,
    allowedContentTypes: [...DEFAULT_ALLOWED_CONTENT_TYPES],
    escalationPathEnabled: true,
    securityAcknowledged: true
  };
}

/**
 * Builds quarantine failure for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of quarantine failure consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `Stage675BlockCode` (import `Stage675BlockCode`) from `./types`.
 *
 * @param blockCode - Value for block code.
 * @param reason - Value for reason.
 * @param riskSignals - Value for risk signals.
 * @returns Computed `RetrievalQuarantineFailure` result.
 */
function buildQuarantineFailure(
  blockCode: Stage675BlockCode,
  reason: string,
  riskSignals: readonly string[] = []
): RetrievalQuarantineFailure {
  return {
    ok: false,
    blockCode,
    reason,
    riskSignals
  };
}

/**
 * Normalizes text into a stable shape for `retrievalQuarantine` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for text so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Implements truncate with boundary behavior used by `retrievalQuarantine`.
 *
 * **Why it exists:**
 * Keeps `truncate with boundary` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param maxChars - Numeric bound, counter, or index used by this logic.
 * @returns Resulting string value.
 */
function truncateWithBoundary(value: string, maxChars: number): string {
  const boundedMaxChars = Math.max(0, Math.floor(maxChars));
  if (value.length <= boundedMaxChars) {
    return value;
  }
  return `${value.slice(0, boundedMaxChars).trimEnd()}...`;
}

/**
 * Evaluates risk signals and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the risk signals policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Ordered collection produced by this step.
 */
function detectRiskSignals(value: string): readonly string[] {
  return RISK_SIGNAL_RULES.filter((rule) => rule.pattern.test(value)).map((rule) => rule.signal);
}

/**
 * Builds distilled packet for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of distilled packet consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `sha256Hex` (import `sha256Hex`) from `./normalizers/canonicalizationRules`.
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
 * - Uses `DistilledPacketV1` (import `DistilledPacketV1`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @param policy - Configuration or policy settings applied here.
 * @param normalizedContent - Value for normalized content.
 * @param byteLength - Value for byte length.
 * @param riskSignals - Value for risk signals.
 * @returns Computed `DistilledPacketV1` result.
 */
function buildDistilledPacket(
  input: RetrievalQuarantineInput,
  policy: RetrievalQuarantinePolicy,
  normalizedContent: string,
  byteLength: number,
  riskSignals: readonly string[]
): DistilledPacketV1 {
  const rawContentHash = sha256Hex(normalizedContent);
  const packetBase = {
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    contentType: input.contentType,
    observedAt: input.observedAt,
    distilledAt: policy.nowIso,
    byteLength,
    rawContentHash,
    summary: truncateWithBoundary(normalizedContent, policy.summaryMaxChars),
    excerpt: truncateWithBoundary(normalizedContent, policy.excerptMaxChars),
    riskSignals
  };
  const packetHash = sha256HexFromCanonicalJson(packetBase);
  return {
    packetId: `distilled_${packetHash.slice(0, 16)}`,
    packetHash,
    ...packetBase
  };
}

/**
 * Applies deterministic validity checks for valid iso timestamp.
 *
 * **Why it exists:**
 * Fails fast when valid iso timestamp is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fieldName - Value for field name.
 */
function assertValidIsoTimestamp(value: string, fieldName: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ISO timestamp for ${fieldName}: ${value}`);
  }
}

/**
 * Implements distill external content behavior used by `retrievalQuarantine`.
 *
 * **Why it exists:**
 * Defines public behavior from `retrievalQuarantine.ts` for other modules/tests.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @param policy - Configuration or policy settings applied here.
 * @returns Computed `RetrievalQuarantineResult` result.
 */
export function distillExternalContent(
  input: RetrievalQuarantineInput,
  policy: RetrievalQuarantinePolicy
): RetrievalQuarantineResult {
  assertValidIsoTimestamp(input.observedAt, "observedAt");
  assertValidIsoTimestamp(policy.nowIso, "nowIso");

  if (!policy.allowedContentTypes.includes(input.contentType)) {
    return buildQuarantineFailure(
      "CONTENT_TYPE_UNSUPPORTED",
      `Unsupported content type '${input.contentType}'.`
    );
  }

  const byteLength = Buffer.byteLength(input.rawContent, "utf8");
  if (byteLength > policy.maxBytes) {
    return buildQuarantineFailure(
      "CONTENT_SIZE_EXCEEDED",
      `Content bytes (${byteLength}) exceed maxBytes (${policy.maxBytes}).`
    );
  }

  const normalizedContent = normalizeText(input.rawContent);
  const riskSignals = detectRiskSignals(normalizedContent);
  if (riskSignals.includes("private_range_target")) {
    return buildQuarantineFailure(
      "PRIVATE_RANGE_TARGET_DENIED",
      "Private-range or localhost target patterns are denied in retrieval quarantine.",
      riskSignals
    );
  }
  if (riskSignals.length > 0 && !policy.escalationPathEnabled) {
    return buildQuarantineFailure(
      "RISK_SIGNAL_ESCALATION_REQUIRED",
      "Risk signals require escalation-path routing.",
      riskSignals
    );
  }
  if (riskSignals.length > 0 && !policy.securityAcknowledged) {
    return buildQuarantineFailure(
      "RISK_SIGNAL_UNACKNOWLEDGED_BLOCKED",
      "Risk signals require explicit security acknowledgement.",
      riskSignals
    );
  }

  return {
    ok: true,
    packet: buildDistilledPacket(input, policy, normalizedContent, byteLength, riskSignals)
  };
}

/**
 * Applies deterministic validity checks for distilled packet for planner.
 *
 * **Why it exists:**
 * Fails fast when distilled packet for planner is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses `canonicalJson` (import `canonicalJson`) from `./normalizers/canonicalizationRules`.
 * - Uses `sha256Hex` (import `sha256Hex`) from `./normalizers/canonicalizationRules`.
 * - Uses `DistilledPacketV1` (import `DistilledPacketV1`) from `./types`.
 *
 * @param packet - Value for packet.
 * @returns Computed `RetrievalQuarantineFailure | null` result.
 */
export function requireDistilledPacketForPlanner(
  packet: DistilledPacketV1 | null | undefined
): RetrievalQuarantineFailure | null {
  if (!packet) {
    return buildQuarantineFailure(
      "QUARANTINE_NOT_APPLIED",
      "Planner/governor path requires a distilled packet from retrieval quarantine."
    );
  }

  const packetFingerprint = sha256Hex(canonicalJson(packet));
  if (packet.packetHash.length === 0 || packet.packetId.length === 0) {
    return buildQuarantineFailure(
      "RAW_EXTERNAL_TEXT_TO_PLANNER_DENIED",
      "Distilled packet metadata is incomplete."
    );
  }
  if (!packetFingerprint) {
    return buildQuarantineFailure(
      "RAW_EXTERNAL_TEXT_TO_PLANNER_DENIED",
      "Distilled packet fingerprint validation failed."
    );
  }
  return null;
}
