/**
 * @fileoverview Canonical media-ingest contracts shared by Telegram transport and conversation runtime helpers.
 */

export type ConversationInboundMediaKind = "image" | "voice" | "video" | "document";
export type ConversationInboundMediaInterpretationSource =
  | "openai_image"
  | "ollama_image"
  | "document_text_extraction"
  | "openai_transcription"
  | "multimodal_audio"
  | "fixture_catalog"
  | "caption_fallback"
  | "metadata_fallback"
  | "unavailable";

export interface ConversationInboundMediaInterpretation {
  summary: string;
  transcript: string | null;
  ocrText: string | null;
  confidence: number | null;
  provenance: string;
  source: ConversationInboundMediaInterpretationSource;
  entityHints: readonly string[];
}

export interface ConversationInboundMediaAttachment {
  kind: ConversationInboundMediaKind;
  provider: "telegram";
  fileId: string;
  fileUniqueId: string | null;
  artifactId?: string | null;
  checksumSha256?: string | null;
  ownedAssetPath?: string | null;
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  caption: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  interpretation?: ConversationInboundMediaInterpretation | null;
}

export interface ConversationInboundMediaEnvelope {
  attachments: readonly ConversationInboundMediaAttachment[];
}

/**
 * Returns `true` when a bounded inbound media envelope contains at least one attachment.
 *
 * @param media - Optional media envelope attached to one inbound message.
 * @returns `true` when at least one attachment is present.
 */
export function hasConversationMedia(
  media: ConversationInboundMediaEnvelope | null | undefined
): boolean {
  return Boolean(media && media.attachments.length > 0);
}
