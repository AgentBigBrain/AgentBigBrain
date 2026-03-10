/**
 * @fileoverview Deterministic fallback helpers for bounded media interpretation when provider-backed understanding is unavailable.
 */

import type {
  ConversationInboundMediaAttachment,
  ConversationInboundMediaInterpretation
} from "../../interfaces/mediaRuntime/contracts";

/**
 * Extracts simple entity-name hints from one caption for fallback media interpretation.
 *
 * @param caption - Optional attachment caption.
 * @returns Bounded list of probable entity hints.
 */
function collectCaptionEntityHints(caption: string | null): string[] {
  if (!caption) {
    return [];
  }
  const matches = caption.match(/\b[A-Z][A-Za-z'’-]{1,40}\b/g) ?? [];
  return [...new Set(matches.map((entry) => entry.trim()).filter((entry) => entry.length > 1))].slice(0, 4);
}

/**
 * Renders one optional caption suffix for fallback media summaries.
 *
 * @param attachment - Attachment being summarized.
 * @returns Caption suffix text, or an empty string when no caption exists.
 */
function renderCaptionSuffix(attachment: ConversationInboundMediaAttachment): string {
  if (!attachment.caption) {
    return "";
  }
  return ` Caption: ${attachment.caption.trim()}`;
}

/**
 * Returns deterministic bounded media interpretation when richer understanding is unavailable.
 *
 * @param attachment - Attachment metadata being interpreted.
 * @returns Stable fallback interpretation.
 */
export function buildFallbackMediaInterpretation(
  attachment: ConversationInboundMediaAttachment
): ConversationInboundMediaInterpretation {
  const entityHints = collectCaptionEntityHints(attachment.caption);
  const fileNameHint = attachment.fileName ? ` File name: ${attachment.fileName}.` : "";
  if (attachment.kind === "voice") {
    if (attachment.caption) {
      return {
        summary: `The user attached a voice note.${renderCaptionSuffix(attachment)}`.trim(),
        transcript: attachment.caption.trim(),
        ocrText: null,
        confidence: 0.45,
        provenance: "caption fallback",
        source: "caption_fallback",
        entityHints
      };
    }
    return {
      summary: "The user attached a voice note, but transcription is unavailable in this environment.",
      transcript: null,
      ocrText: null,
      confidence: 0.1,
      provenance: "metadata fallback",
      source: "metadata_fallback",
      entityHints
    };
  }
  if (attachment.kind === "image") {
    return {
      summary: `The user attached an image.${renderCaptionSuffix(attachment)}${fileNameHint}`.trim(),
      transcript: null,
      ocrText: null,
      confidence: attachment.caption ? 0.4 : 0.1,
      provenance: attachment.caption ? "caption fallback" : "metadata fallback",
      source: attachment.caption ? "caption_fallback" : "metadata_fallback",
      entityHints
    };
  }
  if (attachment.kind === "video") {
    return {
      summary: `The user attached a short video.${renderCaptionSuffix(attachment)}${fileNameHint}`.trim(),
      transcript: null,
      ocrText: null,
      confidence: attachment.caption ? 0.35 : 0.1,
      provenance: attachment.caption ? "caption fallback" : "metadata fallback",
      source: attachment.caption ? "caption_fallback" : "metadata_fallback",
      entityHints
    };
  }
  return {
    summary: `The user attached a document.${renderCaptionSuffix(attachment)}${fileNameHint}`.trim(),
    transcript: null,
    ocrText: null,
    confidence: attachment.caption ? 0.35 : 0.1,
    provenance: attachment.caption ? "caption fallback" : "metadata fallback",
    source: attachment.caption ? "caption_fallback" : "metadata_fallback",
    entityHints
  };
}

