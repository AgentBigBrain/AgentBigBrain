/**
 * @fileoverview Deterministic profile-context sanitization and planner-packet rendering for memory brokerage.
 */

import type { TaskRequest } from "../../core/types";
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
  metadata: MemoryContextAuthorityMetadata = DEFAULT_MEMORY_CONTEXT_AUTHORITY
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

  return packet.join("\n");
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
