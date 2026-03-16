/**
 * @fileoverview Truthful runtime capability summaries for natural-language “what can you do here?” questions.
 */

import type { TelegramInterfaceConfig } from "../runtimeConfig";
import type {
  ConversationCapabilityRecord,
  ConversationCapabilitySummary
} from "./managerContracts";

/**
 * Builds a human-facing capability record with one stable status and summary.
 *
 * @param record - Capability metadata to normalize.
 * @returns Stable capability record for user-facing rendering.
 */
function buildCapabilityRecord(
  record: ConversationCapabilityRecord
): ConversationCapabilityRecord {
  return record;
}

/**
 * Builds the Telegram capability summary used by the conversation front door.
 *
 * @param config - Active Telegram runtime configuration.
 * @returns Truthful summary of what this runtime can currently do in Telegram.
 */
export function buildTelegramCapabilitySummary(
  config: TelegramInterfaceConfig
): ConversationCapabilitySummary {
  const capabilities: ConversationCapabilityRecord[] = [
    buildCapabilityRecord({
      id: "natural_chat",
      label: "Natural conversation",
      status: "available",
      summary:
        "You can talk naturally in text or voice. I do not need exact command phrasing for normal conversation."
    }),
    buildCapabilityRecord({
      id: "plan_and_build",
      label: "Plan and build requests",
      status: "available",
      summary:
        "I can explain, plan, build, or review work from normal language. If your request is unclear, I should ask a short follow-up question."
    }),
    buildCapabilityRecord({
      id: "autonomous_execution",
      label: "Autonomous execution",
      status: config.security.allowAutonomousViaInterface ? "available" : "limited",
      summary: config.security.allowAutonomousViaInterface
        ? "I can take a request end to end when the request is clear and still stay inside the normal safety and approval rules."
        : "I can still plan and help from chat, but full autonomous runs through the interface are currently turned off in this environment."
    }),
    buildCapabilityRecord({
      id: "memory_review",
      label: "Memory review and correction",
      status: "available",
      summary:
        "You can ask what I remember, mark something wrong, resolve an older situation, or tell me to forget a memory."
    }),
    buildCapabilityRecord({
      id: "skill_discovery",
      label: "Skill and tool discovery",
      status: "available",
      summary:
        "You can ask what reusable skills or tools I already know, and voice can use phrases like 'command skills' for the same thing."
    }),
    buildCapabilityRecord({
      id: "images",
      label: "Images",
      status:
        config.media.enabled && config.media.allowImages ? "available" : "unavailable",
      summary:
        config.media.enabled && config.media.allowImages
          ? "Screenshots and images can be read when the current media vision model is available."
          : "Image ingest is turned off in this Telegram setup."
    }),
    buildCapabilityRecord({
      id: "voice_notes",
      label: "Voice notes",
      status:
        config.media.enabled && config.media.allowVoiceNotes
          ? "available"
          : "unavailable",
      summary:
        config.media.enabled && config.media.allowVoiceNotes
          ? "Voice notes are accepted and transcribed when transcription is available."
          : "Voice-note ingest is turned off in this Telegram setup."
    }),
    buildCapabilityRecord({
      id: "video_attachments",
      label: "Video attachments",
      status:
        config.media.enabled && config.media.allowVideos ? "limited" : "unavailable",
      summary:
        config.media.enabled && config.media.allowVideos
          ? "Short video is accepted, but today it uses simple clip metadata and caption context instead of full video analysis."
          : "Video ingest is turned off in this Telegram setup."
    }),
    buildCapabilityRecord({
      id: "document_attachments",
      label: "Documents",
      status:
        config.media.enabled && config.media.allowDocuments
          ? "limited"
          : "unavailable",
      summary:
        config.media.enabled && config.media.allowDocuments
          ? "Documents are accepted when enabled, but interpretation still depends on the file type and safe parsing support."
          : "Document ingest is turned off in this Telegram setup."
    })
  ];

  return {
    provider: "telegram",
    privateChatAliasOptional: !config.security.invocation.requireNameCall,
    supportsNaturalConversation: true,
    supportsAutonomousExecution: config.security.allowAutonomousViaInterface,
    supportsMemoryReview: true,
    capabilities
  };
}

/**
 * Builds the Discord capability summary used by the conversation front door.
 *
 * @param allowAutonomousViaInterface - Whether autonomous runs are allowed from interface chat.
 * @returns Truthful summary of what this runtime can currently do in Discord.
 */
export function buildDiscordCapabilitySummary(
  allowAutonomousViaInterface: boolean
): ConversationCapabilitySummary {
  return {
    provider: "discord",
    privateChatAliasOptional: false,
    supportsNaturalConversation: true,
    supportsAutonomousExecution: allowAutonomousViaInterface,
    supportsMemoryReview: true,
    capabilities: [
      buildCapabilityRecord({
        id: "natural_chat",
        label: "Natural conversation",
        status: "available",
        summary:
          "You can talk naturally in chat. I should infer whether you want an explanation, a plan, a build, or a correction."
      }),
      buildCapabilityRecord({
        id: "plan_and_build",
        label: "Plan and build requests",
        status: "available",
        summary:
          "I can plan, build, review, and explain through Discord chat when the request is clear."
      }),
      buildCapabilityRecord({
        id: "autonomous_execution",
        label: "Autonomous execution",
        status: allowAutonomousViaInterface ? "available" : "limited",
        summary: allowAutonomousViaInterface
          ? "I can take a request end to end while still following the same safety and approval rules."
          : "Full autonomous runs through Discord are currently turned off in this environment."
      }),
      buildCapabilityRecord({
        id: "memory_review",
        label: "Memory review and correction",
        status: "available",
        summary:
          "You can ask what I remember, correct it, resolve a situation, or tell me to forget something."
      }),
      buildCapabilityRecord({
        id: "skill_discovery",
        label: "Skill and tool discovery",
        status: "available",
        summary:
          "You can ask what reusable skills or tools I already know. In voice-style phrasing, the same discovery can come through the command layer."
      }),
      buildCapabilityRecord({
        id: "images",
        label: "Images",
        status: "unavailable",
        summary: "Rich media ingest is not active through the current Discord runtime."
      }),
      buildCapabilityRecord({
        id: "voice_notes",
        label: "Voice notes",
        status: "unavailable",
        summary: "Voice-note ingest is not active through the current Discord runtime."
      }),
      buildCapabilityRecord({
        id: "video_attachments",
        label: "Video attachments",
        status: "unavailable",
        summary: "Video ingest is not active through the current Discord runtime."
      }),
      buildCapabilityRecord({
        id: "document_attachments",
        label: "Documents",
        status: "unavailable",
        summary: "Document ingest is not active through the current Discord runtime."
      })
    ]
  };
}
