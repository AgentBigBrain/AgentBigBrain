/**
 * @fileoverview Bounded short-video understanding helpers.
 */

import type {
  ConversationInboundMediaAttachment,
  ConversationInboundMediaInterpretation
} from "../../interfaces/mediaRuntime/contracts";
import { buildFallbackMediaInterpretation } from "./mediaModelFallback";

/**
 * Interprets a short video attachment using bounded metadata/caption fallback.
 *
 * @param attachment - Video attachment metadata.
 * @returns Deterministic bounded interpretation.
 */
export async function interpretVideoAttachment(
  attachment: ConversationInboundMediaAttachment
): Promise<ConversationInboundMediaInterpretation> {
  const fallback = buildFallbackMediaInterpretation(attachment);
  if (attachment.durationSeconds) {
    return {
      ...fallback,
      summary: `${fallback.summary} Duration: approximately ${attachment.durationSeconds} seconds.`.trim(),
      provenance: fallback.provenance === "metadata fallback"
        ? "video metadata fallback"
        : fallback.provenance,
      source: fallback.source === "metadata_fallback" ? "metadata_fallback" : fallback.source
    };
  }
  return fallback;
}
