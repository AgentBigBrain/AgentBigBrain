/**
 * @fileoverview User-facing rendering for capability introspection and skill inventory discovery.
 */

import type {
  ConversationCapabilityRecord,
  ConversationCapabilitySummary
} from "./managerContracts";

export interface RenderCapabilityDiscoveryResponseInput {
  capabilitySummary: ConversationCapabilitySummary | null;
  skillInventoryText: string | null;
}

/**
 * Renders one capability status into a short natural-language label.
 *
 * @param status - Canonical capability availability status.
 * @returns Human-readable status label for capability replies.
 */
function renderCapabilityStatus(status: ConversationCapabilityRecord["status"]): string {
  switch (status) {
    case "available":
      return "Available";
    case "limited":
      return "Partly available";
    default:
      return "Not available right now";
  }
}

/**
 * Builds the opening sentence for natural capability replies.
 *
 * @param provider - Runtime provider used for the current conversation.
 * @returns Human-readable introduction scoped to the active chat surface.
 */
function renderCapabilityIntro(provider: ConversationCapabilitySummary["provider"]): string {
  switch (provider) {
    case "telegram":
      return "Here is what I can help with in this Telegram chat right now:";
    case "discord":
      return "Here is what I can help with in this Discord chat right now:";
    default:
      return "Here is what I can help with right now:";
  }
}

/**
 * Rephrases raw skill inventory output for capability-discovery replies so it reads naturally.
 *
 * @param skillInventoryText - Raw inventory text returned by the skill renderer.
 * @returns Discovery-specific skill section text.
 */
function humanizeSkillInventoryForDiscovery(skillInventoryText: string): string {
  const trimmed = skillInventoryText.trim();
  if (!trimmed) {
    return trimmed;
  }
  const lines = trimmed.split(/\r?\n/u);
  if (lines[0]?.trim().toLowerCase() === "available skills:") {
    lines[0] = "Reusable skills I can lean on:";
  }
  return lines.join("\n");
}

/**
 * Renders the runtime capability summary for natural-language introspection questions.
 *
 * @param summary - Optional runtime capability snapshot.
 * @returns Human-readable capability overview or `null` when unavailable.
 */
export function renderCapabilitySummary(
  summary: ConversationCapabilitySummary | null
): string | null {
  if (!summary) {
    return null;
  }

  const lines: string[] = [renderCapabilityIntro(summary.provider)];

  for (const capability of summary.capabilities) {
    lines.push(
      `- ${capability.label}: ${renderCapabilityStatus(capability.status)}. ${capability.summary}`
    );
  }

  if (summary.privateChatAliasOptional) {
    lines.push("In this private chat, you can message me naturally without saying BigBrain first.");
  } else {
    lines.push("In shared chats, say BigBrain first so the message is clearly addressed to me.");
  }

  return lines.join("\n");
}

/**
 * Renders a canonical capability-discovery reply that combines environment limits and reusable skills.
 *
 * @param input - Optional capability summary plus optional skill inventory text.
 * @returns Human-readable capability discovery response.
 */
export function renderCapabilityDiscoveryResponse(
  input: RenderCapabilityDiscoveryResponseInput
): string {
  const sections: string[] = [];
  const capabilitySection = renderCapabilitySummary(input.capabilitySummary);
  if (capabilitySection) {
    sections.push(capabilitySection);
  }
  if (input.skillInventoryText) {
    sections.push(humanizeSkillInventoryForDiscovery(input.skillInventoryText));
  }
  if (sections.length === 0) {
    return "I can still help with planning, building, and review in this chat, but capability details are unavailable right now.";
  }
  return sections.join("\n\n");
}
