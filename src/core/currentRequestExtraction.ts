/**
 * @fileoverview Shared helpers for extracting the active request segment from wrapped conversation input.
 */

const CURRENT_USER_REQUEST_MARKER = "Current user request:";
const USER_FOLLOW_UP_ANSWER_MARKER = "User follow-up answer:";
const USER_QUESTION_MARKER = "User question:";
const AGENT_PULSE_REQUEST_MARKER = "Agent Pulse request:";
const RECENT_CONVERSATION_CONTEXT_MARKER = "Recent conversation context (oldest to newest):";
const TRAILING_AGENTFRIEND_SECTION_PATTERN = /^\[AgentFriend[A-Za-z]+\]/;

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
  const normalized = userInput.trim();
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
