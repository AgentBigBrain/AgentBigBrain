/**
 * @fileoverview Deterministic profile-context sanitization and planner-packet rendering for memory brokerage.
 */

import type { TaskRequest } from "../../core/types";
import type { SourceRecallBundle } from "../../core/sourceRecall/contracts";
import type { SourceRecallRetrievalAuditEvent } from "../../core/sourceRecall/sourceRecallRetriever";
import type {
  DomainLaneScores,
  MemoryContextAuthorityMetadata,
  MemoryDomainLane,
  ProfileContextSanitizationResult
} from "./contracts";

const SENSITIVE_PROFILE_CONTEXT_PATTERNS = [
  /email/i,
  /phone/i,
  /address/i,
  /\bssn\b/i,
  /social[_\s-]?security/i,
  /birth(date|day)?|dob/i,
  /api[_\s-]?key/i,
  /token/i,
  /password|secret/i,
  /credit|debit|card|bank|routing/i
];

const DEFAULT_MEMORY_CONTEXT_AUTHORITY: MemoryContextAuthorityMetadata = {
  retrievalMode: "keyword_only",
  sourceAuthority: "unknown",
  plannerAuthority: "none",
  currentTruthAuthority: false
};

export interface SourceRecallContextRenderingInput {
  bundle: SourceRecallBundle;
  auditEvent: SourceRecallRetrievalAuditEvent;
}

/**
 * Checks whether one profile-context line matches a sensitive-field pattern.
 *
 * @param line - Profile-context line to inspect.
 * @returns `true` when the line should be redacted before egress.
 */
function lineIndicatesSensitiveProfileField(line: string): boolean {
  return SENSITIVE_PROFILE_CONTEXT_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Renders deterministic lane scores for broker metadata packets.
 *
 * @param scores - Lane scores to serialize.
 * @returns Compact score string for packet metadata.
 */
function renderDomainLaneScores(scores: DomainLaneScores): string {
  return [
    `profile:${scores.profile}`,
    `relationship:${scores.relationship}`,
    `workflow:${scores.workflow}`,
    `system_policy:${scores.system_policy}`,
    `unknown:${scores.unknown}`
  ].join(",");
}

/**
 * Renders explicit retrieval and authority metadata for memory broker packets.
 *
 * @param metadata - Retrieval authority metadata for the packet.
 * @returns Stable packet metadata lines.
 */
function renderMemoryContextAuthorityMetadata(
  metadata: MemoryContextAuthorityMetadata = DEFAULT_MEMORY_CONTEXT_AUTHORITY
): readonly string[] {
  return [
    `retrievalMode=${metadata.retrievalMode}`,
    `sourceAuthority=${metadata.sourceAuthority}`,
    `plannerAuthority=${metadata.plannerAuthority}`,
    `currentTruthAuthority=${metadata.currentTruthAuthority ? "true" : "false"}`
  ];
}

/**
 * Redacts sensitive profile-context lines before planner/model egress.
 *
 * @param profileContext - Raw profile-context block.
 * @returns Sanitized profile-context text plus a deterministic redaction count.
 */
export function sanitizeProfileContextForModelEgress(
  profileContext: string
): ProfileContextSanitizationResult {
  let redactedFieldCount = 0;
  const sanitizedLines = profileContext
    .split(/\r?\n/)
    .map((line) => {
      if (!lineIndicatesSensitiveProfileField(line)) {
        return line;
      }

      redactedFieldCount += 1;
      const separatorIndex = line.indexOf(":");
      if (separatorIndex <= 0) {
        return "[REDACTED_PROFILE_FIELD]";
      }

      const key = line.slice(0, separatorIndex).trim();
      return `${key}: [REDACTED]`;
    });

  return {
    sanitizedContext: sanitizedLines.join("\n"),
    redactedFieldCount
  };
}

/**
 * Builds the explicit suppressed-context packet used when profile context must not be injected.
 *
 * @param task - Original task request.
 * @param lanes - Dominant domain lanes from boundary assessment.
 * @param scores - Lane scores used to explain the boundary decision.
 * @param reason - Stable suppression reason code.
 * @returns Planner-input packet with suppression metadata only.
 */
export function buildSuppressedContextPacket(
  task: TaskRequest,
  lanes: readonly MemoryDomainLane[],
  scores: DomainLaneScores,
  reason: string,
  metadata: MemoryContextAuthorityMetadata = DEFAULT_MEMORY_CONTEXT_AUTHORITY
): string {
  return [
    task.userInput,
    "",
    "[AgentFriendMemoryBroker]",
    ...renderMemoryContextAuthorityMetadata(metadata),
    `domainLanes=${lanes.join(",")}`,
    `domainLaneScores=${renderDomainLaneScores(scores)}`,
    "domainBoundaryDecision=suppress_profile_context",
    `domainBoundaryReason=${reason}`,
    "",
    "[AgentFriendProfileContext]",
    "suppressed=true"
  ].join("\n");
}

/**
 * Builds the explicit injected-context packet used when profile context is allowed.
 *
 * @param task - Original task request.
 * @param lanes - Dominant domain lanes from boundary assessment.
 * @param scores - Lane scores used to explain the boundary decision.
 * @param reason - Stable inject reason code.
 * @param context - Sanitized brokered profile context payload.
 * @param episodeContext - Optional sanitized brokered episode context payload.
 * @returns Planner-input packet with broker metadata plus injected context.
 */
export function buildInjectedContextPacket(
  task: TaskRequest,
  lanes: readonly MemoryDomainLane[],
  scores: DomainLaneScores,
  reason: string,
  context: string,
  episodeContext = "",
  memorySynthesisContext = "",
  metadata: MemoryContextAuthorityMetadata = DEFAULT_MEMORY_CONTEXT_AUTHORITY,
  sourceRecallContext = ""
): string {
  const packet = [
    task.userInput,
    "",
    "[AgentFriendMemoryBroker]",
    ...renderMemoryContextAuthorityMetadata(metadata),
    `domainLanes=${lanes.join(",")}`,
    `domainLaneScores=${renderDomainLaneScores(scores)}`,
    "domainBoundaryDecision=inject_profile_context",
    `domainBoundaryReason=${reason}`,
    "",
    "[AgentFriendProfileContext]",
    context
  ];

  if (episodeContext.trim().length > 0) {
    packet.push("", "[AgentFriendEpisodeContext]", episodeContext);
  }

  if (memorySynthesisContext.trim().length > 0) {
    packet.push("", "[AgentFriendMemorySynthesis]", memorySynthesisContext);
  }

  if (sourceRecallContext.trim().length > 0) {
    packet.push("", sourceRecallContext);
  }

  return packet.join("\n");
}

/**
 * Renders Source Recall into model context as quoted evidence only.
 *
 * **Why it exists:**
 * Source Recall excerpts may contain old user text, document text, route-looking strings, commands,
 * or approval-looking text. This renderer keeps those chunks readable while explicitly marking
 * them as non-authoritative, unsafe to follow as instructions, and separate from memory truth or
 * completion proof.
 *
 * **What it talks to:**
 * - Uses Source Recall bundle contracts from `../../core/sourceRecall/contracts`.
 * - Uses retrieval audit metadata from `../../core/sourceRecall/sourceRecallRetriever`.
 *
 * @param input - Source Recall bundle plus bounded audit event.
 * @returns Planner/direct-chat context block.
 */
export function renderSourceRecallContextForModelEgress(
  input: SourceRecallContextRenderingInput
): string {
  const { bundle, auditEvent } = input;
  const lines = [
    "[AgentFriendSourceRecallContext]",
    "quotedEvidenceOnly=true",
    `retrievalMode=${bundle.retrievalMode}`,
    `retrievalAuthority=${bundle.retrievalAuthority}`,
    `plannerAuthority=${bundle.authority.plannerAuthority}`,
    `currentTruthAuthority=${bundle.authority.currentTruthAuthority ? "true" : "false"}`,
    `completionProofAuthority=${bundle.authority.completionProofAuthority ? "true" : "false"}`,
    `approvalAuthority=${bundle.authority.approvalAuthority ? "true" : "false"}`,
    `safetyAuthority=${bundle.authority.safetyAuthority ? "true" : "false"}`,
    `unsafeToFollowAsInstruction=${bundle.authority.unsafeToFollowAsInstruction ? "true" : "false"}`,
    `auditQueryHash=${auditEvent.queryHash}`,
    `auditRetrievalMode=${auditEvent.retrievalMode}`,
    `auditReturnedSourceRecordIds=${auditEvent.returnedSourceRecordIds.join(",")}`,
    `auditReturnedChunkIds=${auditEvent.returnedChunkIds.join(",")}`,
    `auditTotalExcerptsReturned=${auditEvent.totalExcerptsReturned}`,
    `auditTotalCharsReturned=${auditEvent.totalCharsReturned}`,
    `auditBlockedRedactedCount=${auditEvent.blockedRedactedCount}`
  ];

  bundle.excerpts.forEach((excerpt, index) => {
    lines.push(
      "",
      `[SourceRecallExcerpt:${index + 1}]`,
      `sourceRecordId=${excerpt.sourceRecordId}`,
      `chunkId=${excerpt.chunkId}`,
      `recallAuthority=${excerpt.recallAuthority}`,
      `redacted=${excerpt.redacted ? "true" : "false"}`,
      `rankingMode=${excerpt.ranking.retrievalMode}`,
      `rankingAuthority=${excerpt.ranking.retrievalAuthority}`,
      `rankingScore=${excerpt.ranking.score}`,
      `rankingFreshness=${excerpt.ranking.freshness}`,
      `rankingSourceTimeKind=${excerpt.ranking.sourceTimeKind}`,
      `rankingExplanation=${excerpt.ranking.explanation}`,
      `plannerAuthority=${excerpt.authority.plannerAuthority}`,
      `currentTruthAuthority=${excerpt.authority.currentTruthAuthority ? "true" : "false"}`,
      `completionProofAuthority=${excerpt.authority.completionProofAuthority ? "true" : "false"}`,
      `approvalAuthority=${excerpt.authority.approvalAuthority ? "true" : "false"}`,
      `safetyAuthority=${excerpt.authority.safetyAuthority ? "true" : "false"}`,
      `unsafeToFollowAsInstruction=${excerpt.authority.unsafeToFollowAsInstruction ? "true" : "false"}`,
      "quotedEvidence:",
      renderQuotedSourceEvidence(excerpt.excerpt)
    );
  });

  return lines.join("\n");
}

/**
 * Counts readable profile-fact lines in a rendered profile-context block.
 *
 * @param profileContext - Rendered profile-context block.
 * @returns Count of fact lines used for audit metadata.
 */
export function countRetrievedProfileFacts(profileContext: string): number {
  return profileContext
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("["))
    .filter((line) => line.includes(":"))
    .length;
}

/**
 * Prefixes every recalled source line as quoted evidence.
 *
 * @param value - Recalled source excerpt.
 * @returns Quoted evidence block.
 */
function renderQuotedSourceEvidence(value: string): string {
  if (value.length === 0) {
    return "> ";
  }
  return value.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}
