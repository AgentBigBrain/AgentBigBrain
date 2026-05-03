/**
 * @fileoverview Shared helpers for extracting the active request segment from wrapped conversation input.
 */

import { isSourceAuthority, type SourceAuthority } from "./sourceAuthority";

const CURRENT_USER_REQUEST_MARKER = "Current user request:";
const USER_FOLLOW_UP_ANSWER_MARKER = "User follow-up answer:";
const USER_QUESTION_MARKER = "User question:";
const AGENT_PULSE_REQUEST_MARKER = "Agent Pulse request:";
const RECENT_CONVERSATION_CONTEXT_MARKER = "Recent conversation context (oldest to newest):";
const RESOLVED_SEMANTIC_ROUTE_MARKER = "Resolved semantic route:";
const RESOLVED_BUILD_FORMAT_MARKER = "Resolved build format:";
const TRAILING_AGENTFRIEND_SECTION_PATTERN = /^\[AgentFriend[A-Za-z]+\]/;
const AUTONOMOUS_EXECUTION_PREFIX = "[AUTONOMOUS_LOOP_GOAL]";
const CLARIFICATION_METADATA_LINE_PATTERN = /^\[Clarification resolved:/i;
const RESOLVED_SEMANTIC_ROUTE_LINE_PATTERN = /^- routeId:\s*([a-z_]+)\s*$/im;
const RESOLVED_ROUTE_MEMORY_INTENT_LINE_PATTERN = /^- memoryIntent:\s*([a-z_]+)\s*$/im;
const RESOLVED_ROUTE_SOURCE_AUTHORITY_LINE_PATTERN = /^- sourceAuthority:\s*([a-z_]+)\s*$/im;
const RESOLVED_ROUTE_RUNTIME_CONTROL_INTENT_LINE_PATTERN =
  /^- runtimeControlIntent:\s*([a-z_]+)\s*$/im;
const RESOLVED_ROUTE_EXECUTION_MODE_LINE_PATTERN =
  /^- executionMode:\s*([a-z_]+)\s*$/im;
const RESOLVED_ROUTE_CONTINUATION_KIND_LINE_PATTERN =
  /^- continuationKind:\s*([a-z_]+)\s*$/im;
const RESOLVED_BUILD_FORMAT_LINE_PATTERN = /^- format:\s*([a-z_]+)\s*$/im;
const RESOLVED_ROUTE_BOOLEAN_LINE_PATTERNS = {
  disallowBrowserOpen: /^- disallowBrowserOpen:\s*(true|false)\s*$/im,
  disallowServerStart: /^- disallowServerStart:\s*(true|false)\s*$/im,
  requiresUserOwnedLocation: /^- requiresUserOwnedLocation:\s*(true|false)\s*$/im
} as const;
const SUPPORTED_RESOLVED_SEMANTIC_ROUTE_IDS = new Set([
  "chat_answer",
  "relationship_recall",
  "status_recall",
  "plan_request",
  "build_request",
  "static_html_build",
  "framework_app_build",
  "clarify_build_format",
  "clarify_execution_mode",
  "autonomous_execution",
  "review_feedback",
  "capability_discovery"
]);
const SUPPORTED_RESOLVED_MEMORY_INTENTS = new Set([
  "none",
  "relationship_recall",
  "profile_update",
  "contextual_recall",
  "document_derived_recall"
]);
const SUPPORTED_RESOLVED_RUNTIME_CONTROL_INTENTS = new Set([
  "none",
  "open_browser",
  "close_browser",
  "verify_browser",
  "inspect_runtime",
  "stop_runtime"
]);
const SUPPORTED_RESOLVED_EXECUTION_MODES = new Set([
  "chat",
  "plan",
  "build",
  "autonomous",
  "status_or_recall",
  "review",
  "capability_discovery",
  "unclear"
]);
const SUPPORTED_RESOLVED_CONTINUATION_KINDS = new Set([
  "none",
  "answer_thread",
  "workflow_resume",
  "return_handoff",
  "contextual_followup",
  "relationship_memory"
]);
const SUPPORTED_RESOLVED_BUILD_FORMATS = new Set([
  "static_html",
  "framework_app",
  "nextjs",
  "react",
  "vite"
]);

export interface ExtractedResolvedRouteConstraints {
  disallowBrowserOpen: boolean;
  disallowServerStart: boolean;
  requiresUserOwnedLocation: boolean;
}

/**
 * Extracts the trailing section after the last occurrence of a marker.
 *
 * **Why it exists:**
 * Keeps marker slicing behavior centralized so core and interface checks evaluate the same active
 * request segment.
 *
 * **What it talks to:**
 * - Local string operations only; no cross-module collaborators.
 *
 * @param value - Full wrapped input that may contain marker-prefixed sections.
 * @param marker - Marker label used to isolate the newest segment.
 * @returns Extracted section text, or `null` when marker is absent/empty.
 */
function extractSectionAfterMarker(value: string, marker: string): string | null {
  const markerIndex = value.toLowerCase().lastIndexOf(marker.toLowerCase());
  if (markerIndex < 0) {
    return null;
  }
  const extracted = value.slice(markerIndex + marker.length).trim();
  return extracted.length > 0 ? extracted : null;
}

/**
 * Returns the prefix before the active user-request marker.
 *
 * **Why it exists:**
 * Resolved route/build metadata is trusted only when it is machine-authored before the active user
 * text. A user can paste marker-shaped text inside the current request, and that prose must not
 * become route authority.
 *
 * @param value - Normalized execution-context payload.
 * @returns Machine-authored prefix before active user text, or `null` when no active marker exists.
 */
function extractMachineAuthoredPrefixBeforeActiveRequest(value: string): string | null {
  const lower = value.toLowerCase();
  const markerIndexes = [
    CURRENT_USER_REQUEST_MARKER,
    USER_FOLLOW_UP_ANSWER_MARKER,
    USER_QUESTION_MARKER,
    AGENT_PULSE_REQUEST_MARKER
  ]
    .map((marker) => lower.indexOf(marker.toLowerCase()))
    .filter((index) => index >= 0);
  if (markerIndexes.length === 0) {
    return null;
  }
  const activeRequestIndex = Math.min(...markerIndexes);
  return value.slice(0, activeRequestIndex).trim();
}

/**
 * Extracts trusted machine-authored metadata before active user text.
 *
 * @param userInput - Wrapped execution input.
 * @param marker - Metadata marker to locate.
 * @returns Trusted metadata payload beginning at the last marker occurrence, or `null`.
 */
function extractTrustedMetadataPayload(userInput: string, marker: string): string | null {
  const normalized = extractExecutionContextPayload(userInput);
  if (!normalized) {
    return null;
  }
  const machinePrefix = extractMachineAuthoredPrefixBeforeActiveRequest(normalized);
  if (!machinePrefix) {
    return null;
  }
  const markerIndex = machinePrefix.toLowerCase().lastIndexOf(marker.toLowerCase());
  if (markerIndex < 0) {
    return null;
  }
  return machinePrefix.slice(markerIndex).trim();
}

/**
 * Extracts an Agent Pulse request while excluding appended historical-context blocks.
 *
 * **Why it exists:**
 * Prevents historical context payloads from being misread as the active pulse request segment.
 *
 * **What it talks to:**
 * - Uses local marker constants for pulse and historical-context sections.
 *
 * @param userInput - Full wrapped input string for the active operation.
 * @returns Bounded pulse request text, or `null` when no pulse request exists.
 */
function extractAgentPulseRequestSegment(userInput: string): string | null {
  const pulseSection = extractSectionAfterMarker(userInput, AGENT_PULSE_REQUEST_MARKER);
  if (!pulseSection) {
    return null;
  }
  const contextIndex = pulseSection
    .toLowerCase()
    .indexOf(RECENT_CONVERSATION_CONTEXT_MARKER.toLowerCase());
  if (contextIndex < 0) {
    return pulseSection;
  }
  const boundedSection = pulseSection.slice(0, contextIndex).trim();
  return boundedSection.length > 0 ? boundedSection : null;
}

/**
 * Bounds a request-like segment before any trailing AgentFriend broker packets.
 *
 * **Why it exists:**
 * Brokered planner input can append `[AgentFriend...]` sections after the wrapped
 * `Current user request:` block. Those packets must not leak into the active request segment used
 * by routing and planner policy.
 *
 * **What it talks to:**
 * - Uses local AgentFriend section marker pattern only.
 *
 * @param value - Extracted request-like segment that may contain appended broker packets.
 * @returns Bounded request text without trailing AgentFriend sections.
 */
function boundRequestBeforeAgentFriendSections(value: string): string {
  const lines = value.split(/\r?\n/);
  const boundedLines: string[] = [];
  for (const line of lines) {
    if (
      boundedLines.length > 0 &&
      TRAILING_AGENTFRIEND_SECTION_PATTERN.test(line.trim())
    ) {
      break;
    }
    boundedLines.push(line);
  }
  return boundedLines.join("\n").trim();
}

/**
 * Removes deterministic clarification-display lines that describe the runtime's own question rather
 * than the user's semantic request.
 *
 * **Why it exists:**
 * Clarification questions can mention alternate routes such as Next.js or React. Downstream
 * semantic planners should not treat that runtime-authored wording as if the user asked for it.
 *
 * **What it talks to:**
 * - Local line-oriented filtering only.
 *
 * @param value - Extracted active request segment that may contain clarification-display metadata.
 * @returns Request text without clarification-display lines.
 */
function stripClarificationDisplayMetadata(value: string): string {
  const filteredLines = value
    .split(/\r?\n/)
    .filter((line) => !CLARIFICATION_METADATA_LINE_PATTERN.test(line.trim()));
  return filteredLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Extracts the active request payload from an autonomous-loop execution envelope.
 *
 * **Why it exists:**
 * Autonomous runtime packets can wrap the first user turn in a JSON envelope that includes both
 * the high-level goal and a richer `initialExecutionInput`. Downstream routing and planner policy
 * need the inner active request, not the raw envelope text.
 *
 * **What it talks to:**
 * - Local autonomous execution prefix only; does not import interface-runtime contracts.
 *
 * @param userInput - Raw execution input that may be tagged as an autonomous loop goal.
 * @returns Inner request-like payload, or `null` when the input is not an autonomous envelope.
 */
function extractAutonomousExecutionPayload(userInput: string): string | null {
  if (!userInput.startsWith(AUTONOMOUS_EXECUTION_PREFIX)) {
    return null;
  }

  const payload = userInput.slice(AUTONOMOUS_EXECUTION_PREFIX.length).trim();
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as {
      goal?: unknown;
      initialExecutionInput?: unknown;
    };
    if (
      typeof parsed.initialExecutionInput === "string" &&
      parsed.initialExecutionInput.trim().length > 0
    ) {
      return parsed.initialExecutionInput.trim();
    }
    if (typeof parsed.goal === "string" && parsed.goal.trim().length > 0) {
      return parsed.goal.trim();
    }
  } catch {
    // Fall back to the legacy plain-text autonomous goal payload below.
  }

  return payload;
}

/**
 * Unwraps execution-input envelopes that carry richer autonomous-loop context.
 *
 * **Why it exists:**
 * Planner-policy and runtime-inspection helpers sometimes need the full embedded execution-input
 * context, not only the active current-user request segment. This helper normalizes that surface
 * before downstream line-oriented matching runs.
 *
 * **What it talks to:**
 * - Uses the local autonomous execution prefix parser only.
 *
 * @param userInput - Raw execution input that may contain an autonomous execution envelope.
 * @returns Unwrapped execution payload when present, otherwise the trimmed original input.
 */
export function extractExecutionContextPayload(userInput: string): string {
  const normalized = userInput.trim();
  if (!normalized) {
    return "";
  }
  return extractAutonomousExecutionPayload(normalized) ?? normalized;
}

/**
 * Checks whether user input includes the agent-pulse request marker.
 *
 * **Why it exists:**
 * Centralizes pulse-marker detection so gate checks do not drift across modules.
 *
 * **What it talks to:**
 * - Uses local `AGENT_PULSE_REQUEST_MARKER` constant.
 *
 * @param userInput - Raw user input string from the runtime/request wrapper.
 * @returns `true` when the pulse marker is present.
 */
export function containsAgentPulseRequestMarker(userInput: string): boolean {
  return userInput.includes(AGENT_PULSE_REQUEST_MARKER);
}

/**
 * Extracts the active request segment from wrapped conversation input.
 *
 * **Why it exists:**
 * Keeps current-request extraction deterministic and shared across execution and rendering paths.
 *
 * **What it talks to:**
 * - Uses local marker helpers to parse current request, follow-up answers, proposal questions, and pulse requests.
 *
 * @param userInput - Wrapped user input that can include stage/interface context sections.
 * @returns Active request segment used for routing, verification, and diagnostics checks.
 */
export function extractActiveRequestSegment(userInput: string): string {
  const normalized = extractExecutionContextPayload(userInput);
  if (!normalized) {
    return "";
  }

  const currentRequest = extractSectionAfterMarker(normalized, CURRENT_USER_REQUEST_MARKER);
  if (currentRequest) {
    return boundRequestBeforeAgentFriendSections(currentRequest);
  }

  const followUpAnswer = extractSectionAfterMarker(normalized, USER_FOLLOW_UP_ANSWER_MARKER);
  if (followUpAnswer) {
    return followUpAnswer;
  }

  const proposalQuestion = extractSectionAfterMarker(normalized, USER_QUESTION_MARKER);
  if (proposalQuestion) {
    return proposalQuestion;
  }

  const pulseRequest = extractAgentPulseRequestSegment(normalized);
  if (pulseRequest) {
    return pulseRequest;
  }

  return normalized;
}

/**
 * Extracts the active request segment while removing clarification-display metadata that should not
 * influence semantic route selection.
 *
 * **Why it exists:**
 * Planner-policy routing and memory brokerage need the user's request plus deterministic lane
 * markers, but not the natural-language clarification question the runtime asked on its own.
 *
 * **What it talks to:**
 * - Uses `extractActiveRequestSegment` from this module.
 *
 * @param userInput - Wrapped user input that can include clarification-display metadata.
 * @returns Semantically relevant request text for downstream routing and planner policy.
 */
export function extractSemanticRequestSegment(userInput: string): string {
  return stripClarificationDisplayMetadata(extractActiveRequestSegment(userInput));
}

/**
 * Extracts the deterministic semantic route chosen by the conversation front door when execution
 * input carries that metadata.
 *
 * **Why it exists:**
 * Planner-policy and runtime helpers should consume the already-resolved semantic route instead of
 * re-inferring HTML/framework/build meaning from natural-language wording.
 *
 * **What it talks to:**
 * - Uses `extractExecutionContextPayload` from this module.
 *
 * @param userInput - Wrapped execution input that may include resolved semantic route metadata.
 * @returns Supported semantic route id, or `null` when none is present.
 */
export function extractResolvedSemanticRouteId(userInput: string): string | null {
  const normalized = extractTrustedMetadataPayload(userInput, RESOLVED_SEMANTIC_ROUTE_MARKER);
  if (!normalized) {
    return null;
  }
  const match = normalized.match(RESOLVED_SEMANTIC_ROUTE_LINE_PATTERN);
  const candidate = match?.[1]?.trim() ?? "";
  if (!candidate || !SUPPORTED_RESOLVED_SEMANTIC_ROUTE_IDS.has(candidate)) {
    return null;
  }
  return candidate;
}

/**
 * Returns whether wrapped execution input carries front-door route metadata.
 *
 * **Why it exists:**
 * Planner policy can use this as a hard boundary: when route metadata exists, compatibility
 * natural-language fallbacks should not re-own semantic route decisions.
 *
 * **What it talks to:**
 * - Uses `extractExecutionContextPayload` from this module.
 *
 * @param userInput - Wrapped execution input that may include resolved semantic route metadata.
 * @returns `true` when the resolved semantic route marker is present.
 */
export function hasResolvedSemanticRouteMetadata(userInput: string): boolean {
  return extractTrustedMetadataPayload(userInput, RESOLVED_SEMANTIC_ROUTE_MARKER) !== null;
}

/**
 * Extracts the resolved build format selected by the conversation front door.
 *
 * **Why it exists:**
 * Planner framework/static policy should consume the typed build-format block rather than
 * re-classifying framework names or static HTML wording from the request text.
 *
 * **What it talks to:**
 * - Uses `extractExecutionContextPayload` from this module.
 *
 * @param userInput - Wrapped execution input that may include resolved build-format metadata.
 * @returns Supported build format id, or `null` when none is present.
 */
export function extractResolvedBuildFormat(userInput: string): string | null {
  const normalized = extractTrustedMetadataPayload(userInput, RESOLVED_BUILD_FORMAT_MARKER);
  if (!normalized) {
    return null;
  }
  const match = normalized.match(RESOLVED_BUILD_FORMAT_LINE_PATTERN);
  const candidate = match?.[1]?.trim() ?? "";
  if (!candidate || !SUPPORTED_RESOLVED_BUILD_FORMATS.has(candidate)) {
    return null;
  }
  return candidate;
}

/**
 * Extracts the route-approved memory intent from a wrapped execution input.
 *
 * **Why it exists:**
 * Memory helpers should use front-door route metadata as their access gate instead of re-reading
 * broad relationship or recall wording downstream.
 *
 * **What it talks to:**
 * - Uses `extractExecutionContextPayload` from this module.
 *
 * @param userInput - Wrapped execution input that may include resolved semantic route metadata.
 * @returns Supported memory intent, or `null` when none is present.
 */
export function extractResolvedRouteMemoryIntent(userInput: string): string | null {
  const normalized = extractTrustedMetadataPayload(userInput, RESOLVED_SEMANTIC_ROUTE_MARKER);
  if (!normalized) {
    return null;
  }
  const match = normalized.match(RESOLVED_ROUTE_MEMORY_INTENT_LINE_PATTERN);
  const candidate = match?.[1]?.trim() ?? "";
  if (!candidate || !SUPPORTED_RESOLVED_MEMORY_INTENTS.has(candidate)) {
    return null;
  }
  return candidate;
}

/**
 * Extracts the route source-authority class from trusted route metadata.
 *
 * @param userInput - Wrapped execution input that may include resolved semantic route metadata.
 * @returns Source authority, or `null` when missing, untrusted, or unsupported.
 */
export function extractResolvedRouteSourceAuthority(userInput: string): SourceAuthority | null {
  const normalized = extractTrustedMetadataPayload(userInput, RESOLVED_SEMANTIC_ROUTE_MARKER);
  if (!normalized) {
    return null;
  }
  const match = normalized.match(RESOLVED_ROUTE_SOURCE_AUTHORITY_LINE_PATTERN);
  const candidate = match?.[1]?.trim() ?? "";
  if (!isSourceAuthority(candidate)) {
    return null;
  }
  return candidate;
}

/**
 * Extracts the route-approved runtime-control intent from a wrapped execution input.
 *
 * **Why it exists:**
 * Planner explicit-action policy should consume typed runtime-control metadata before considering
 * compatibility natural-language follow-up matching.
 *
 * **What it talks to:**
 * - Uses `extractExecutionContextPayload` from this module.
 *
 * @param userInput - Wrapped execution input that may include resolved semantic route metadata.
 * @returns Supported runtime-control intent, or `null` when none is present.
 */
export function extractResolvedRuntimeControlIntent(userInput: string): string | null {
  const normalized = extractTrustedMetadataPayload(userInput, RESOLVED_SEMANTIC_ROUTE_MARKER);
  if (!normalized) {
    return null;
  }
  const match = normalized.match(RESOLVED_ROUTE_RUNTIME_CONTROL_INTENT_LINE_PATTERN);
  const candidate = match?.[1]?.trim() ?? "";
  if (!candidate || !SUPPORTED_RESOLVED_RUNTIME_CONTROL_INTENTS.has(candidate)) {
    return null;
  }
  return candidate;
}

/**
 * Extracts the route-approved execution mode from a wrapped execution input.
 *
 * **Why it exists:**
 * Planner policy should treat the front-door execution mode as the route contract and avoid
 * re-inferring build, chat, status, or autonomous behavior from broad wording.
 *
 * **What it talks to:**
 * - Uses `extractExecutionContextPayload` from this module.
 *
 * @param userInput - Wrapped execution input that may include resolved semantic route metadata.
 * @returns Supported execution mode, or `null` when none is present.
 */
export function extractResolvedRouteExecutionMode(userInput: string): string | null {
  const normalized = extractTrustedMetadataPayload(userInput, RESOLVED_SEMANTIC_ROUTE_MARKER);
  if (!normalized) {
    return null;
  }
  const match = normalized.match(RESOLVED_ROUTE_EXECUTION_MODE_LINE_PATTERN);
  const candidate = match?.[1]?.trim() ?? "";
  if (!candidate || !SUPPORTED_RESOLVED_EXECUTION_MODES.has(candidate)) {
    return null;
  }
  return candidate;
}

/**
 * Extracts the route-approved continuation kind from a wrapped execution input.
 *
 * @param userInput - Wrapped execution input that may include resolved semantic route metadata.
 * @returns Supported continuation kind, or `null` when none is present.
 */
export function extractResolvedRouteContinuationKind(userInput: string): string | null {
  const normalized = extractTrustedMetadataPayload(userInput, RESOLVED_SEMANTIC_ROUTE_MARKER);
  if (!normalized) {
    return null;
  }
  const match = normalized.match(RESOLVED_ROUTE_CONTINUATION_KIND_LINE_PATTERN);
  const candidate = match?.[1]?.trim() ?? "";
  if (!candidate || !SUPPORTED_RESOLVED_CONTINUATION_KINDS.has(candidate)) {
    return null;
  }
  return candidate;
}

/**
 * Extracts route-approved explicit constraints from wrapped execution input.
 *
 * @param userInput - Wrapped execution input that may include resolved semantic route metadata.
 * @returns Constraint object, or `null` when route metadata is absent or incomplete.
 */
export function extractResolvedRouteConstraints(
  userInput: string
): ExtractedResolvedRouteConstraints | null {
  const normalized = extractTrustedMetadataPayload(userInput, RESOLVED_SEMANTIC_ROUTE_MARKER);
  if (!normalized) {
    return null;
  }
  const readBoolean = (
    key: keyof typeof RESOLVED_ROUTE_BOOLEAN_LINE_PATTERNS
  ): boolean | null => {
    const match = normalized.match(RESOLVED_ROUTE_BOOLEAN_LINE_PATTERNS[key]);
    const value = match?.[1]?.trim().toLowerCase();
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
    return null;
  };
  const disallowBrowserOpen = readBoolean("disallowBrowserOpen");
  const disallowServerStart = readBoolean("disallowServerStart");
  const requiresUserOwnedLocation = readBoolean("requiresUserOwnedLocation");
  if (
    disallowBrowserOpen === null ||
    disallowServerStart === null ||
    requiresUserOwnedLocation === null
  ) {
    return null;
  }
  return {
    disallowBrowserOpen,
    disallowServerStart,
    requiresUserOwnedLocation
  };
}
