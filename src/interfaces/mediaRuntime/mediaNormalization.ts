/**
 * @fileoverview Normalizes bounded inbound media metadata into user-input and execution-context surfaces.
 */

import type {
  ConversationInboundMediaAttachment,
  ConversationInboundMediaEnvelope
} from "./contracts";

const VOICE_COMMAND_ALIASES = new Set([
  "help",
  "status",
  "chat",
  "auto",
  "skills",
  "pulse",
  "review",
  "memory",
  "propose",
  "approve",
  "adjust",
  "cancel"
]);

const VOICE_COMMAND_PREFIX_PATTERN =
  /^(?:(?:hey|hi|hello)\s+)?(?:bigbrain[\s,.:;!-]+)?command\s+([a-z]+)\b[\s,.:;!-]*(.*)$/i;

/**
 * Returns a short user-input noun phrase for one media attachment kind.
 *
 * @param attachment - Attachment being rendered.
 * @returns Short natural-language descriptor for the attachment.
 */
function describeAttachmentForInput(attachment: ConversationInboundMediaAttachment): string {
  switch (attachment.kind) {
    case "image":
      return "image";
    case "voice":
      return "voice note";
    case "video":
      return "short video";
    case "document":
      return "document";
  }
}

/**
 * Renders one interpreted attachment into a bounded text fragment for canonical user input.
 *
 * @param attachment - Attachment with optional interpretation metadata.
 * @returns One bounded input fragment, or `null` when no interpretation exists.
 */
function buildAttachmentInputFragment(
  attachment: ConversationInboundMediaAttachment
): string | null {
  const interpretation = attachment.interpretation;
  if (!interpretation) {
    return null;
  }

  if (attachment.kind === "voice" && interpretation.transcript) {
    return `Voice note transcript: ${interpretation.transcript}`;
  }

  const parts = [
    `${describeAttachmentForInput(attachment)} summary: ${interpretation.summary}`
  ];
  if (interpretation.ocrText) {
    parts.push(`OCR text: ${interpretation.ocrText}`);
  }
  return parts.join(" ");
}

/**
 * Builds bounded interpreted-media fragments for one inbound envelope.
 *
 * @param media - Optional inbound media envelope.
 * @returns Canonical media fragments used in conversation input surfaces.
 */
function buildMediaInputFragments(
  media: ConversationInboundMediaEnvelope | null | undefined
): string[] {
  return (media?.attachments ?? [])
    .map((attachment) => buildAttachmentInputFragment(attachment))
    .filter((fragment): fragment is string => Boolean(fragment));
}

/**
 * Promotes a voice-note transcript into canonical slash-command text when the transcript begins
 * with the explicit voice-only `command <name>` namespace.
 *
 * @param media - Optional inbound media envelope.
 * @returns Slash-command text when the transcript is an explicit voice command; otherwise `null`.
 */
function buildVoiceOnlyCommandText(
  media: ConversationInboundMediaEnvelope | null | undefined
): string | null {
  const attachments = media?.attachments ?? [];
  if (attachments.length !== 1) {
    return null;
  }

  const [attachment] = attachments;
  const transcript =
    attachment?.kind === "voice"
      ? attachment.interpretation?.transcript?.trim() ?? ""
      : "";
  if (!transcript) {
    return null;
  }

  const match = transcript.match(VOICE_COMMAND_PREFIX_PATTERN);
  if (!match) {
    return null;
  }

  const commandName = (match[1] ?? "").trim().toLowerCase();
  if (!VOICE_COMMAND_ALIASES.has(commandName)) {
    return null;
  }

  const remainder = (match[2] ?? "").trim();
  return remainder ? `/${commandName} ${remainder}` : `/${commandName}`;
}

/**
 * Builds the fallback user-input text used when an inbound message carries media without any
 * direct text or caption.
 *
 * @param media - Optional inbound media envelope attached to the current message.
 * @returns Natural-language fallback request for media-only messages.
 */
export function buildMediaOnlyUserInput(
  media: ConversationInboundMediaEnvelope | null | undefined
): string {
  const attachments = media?.attachments ?? [];
  if (attachments.length === 0) {
    return "";
  }

  const voiceOnlyCommand = buildVoiceOnlyCommandText(media);
  if (voiceOnlyCommand) {
    return voiceOnlyCommand;
  }

  const interpretedFragments = buildMediaInputFragments(media);
  if (interpretedFragments.length > 0) {
    if (interpretedFragments.length === 1) {
      return interpretedFragments[0] ?? "";
    }
    return [
      "The user sent media with the following interpreted context:",
      ...interpretedFragments.map((fragment) => `- ${fragment}`)
    ].join("\n");
  }

  const [firstAttachment] = attachments;
  if (attachments.length === 1 && firstAttachment) {
    switch (firstAttachment.kind) {
      case "image":
        return "Please review the attached image and respond based on what it shows.";
      case "voice":
        return "Please transcribe the attached voice note and respond to its request.";
      case "video":
        return "Please review the attached short video and respond based on what it shows.";
      case "document":
        return "Please review the attached document and respond based on its content.";
    }
  }

  return "Please review the attached media and respond based on its content.";
}

/**
 * Resolves the bounded user-input text for one inbound message, preferring explicit text/caption
 * and falling back to a natural media-only request when necessary.
 *
 * @param text - Explicit inbound text or caption.
 * @param media - Optional inbound media envelope.
 * @returns Canonical user-input text for conversation/runtime helpers.
 */
export function buildConversationInboundUserInput(
  text: string,
  media: ConversationInboundMediaEnvelope | null | undefined
): string {
  const normalizedText = text.trim();
  const interpretedFragments = buildMediaInputFragments(media);
  if (normalizedText.length > 0) {
    if (interpretedFragments.length === 0) {
      return normalizedText;
    }
    return [
      normalizedText,
      "",
      "Attached media context:",
      ...interpretedFragments.map((fragment) => `- ${fragment}`)
    ].join("\n");
  }
  return buildMediaOnlyUserInput(media);
}
