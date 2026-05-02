/**
 * @fileoverview Renders bounded interpreted media context for conversation execution surfaces.
 */

import type {
  ConversationInboundMediaAttachment,
  ConversationInboundMediaEnvelope
} from "../mediaRuntime/contracts";

/**
 * Returns a short natural-language label for one interpreted media attachment.
 *
 * @param attachment - Attachment being rendered.
 * @returns Human-readable attachment label.
 */
function describeAttachment(attachment: ConversationInboundMediaAttachment): string {
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
 * Builds bounded execution-input context lines for one interpreted media attachment.
 *
 * @param attachment - Attachment metadata plus optional interpretation.
 * @param index - One-based attachment position for rendering.
 * @returns Execution-input lines describing the attachment.
 */
function buildAttachmentContextLines(
  attachment: ConversationInboundMediaAttachment,
  index: number
): string[] {
  const interpretation = attachment.interpretation;
  const lines = [
    `- Attachment ${index}: ${describeAttachment(attachment)}`,
    `  - kind: ${attachment.kind}`,
    `  - provider: ${attachment.provider}`,
    `  - mime: ${attachment.mimeType ?? "unknown"}`,
    `  - filename: ${attachment.fileName ?? "none"}`,
    `  - sizeBytes: ${attachment.sizeBytes ?? "unknown"}`,
    `  - durationSeconds: ${attachment.durationSeconds ?? "n/a"}`,
    `  - width: ${attachment.width ?? "n/a"}`,
    `  - height: ${attachment.height ?? "n/a"}`,
    `  - caption: ${attachment.caption ?? "none"}`
  ];

  if (!interpretation) {
    lines.push("  - interpretation: unavailable");
    return lines;
  }

  lines.push(
    `  - interpretation.source: ${interpretation.source}`,
    `  - interpretation.confidence: ${interpretation.confidence === null ? "unknown" : interpretation.confidence.toFixed(2)}`,
    `  - interpretation.provenance: ${interpretation.provenance}`,
    `  - interpretation.summary: ${interpretation.summary}`,
    `  - interpretation.transcript: ${interpretation.transcript ?? "none"}`,
    `  - interpretation.ocrText: ${interpretation.ocrText ?? "none"}`,
    `  - interpretation.entityHints: ${
      interpretation.entityHints.length > 0
        ? interpretation.entityHints.join(", ")
        : "none"
    }`,
    `  - interpretation.layers: ${
      (interpretation.layers ?? []).length > 0
        ? (interpretation.layers ?? [])
            .map((layer) =>
              `${layer.kind}/${layer.source}/${layer.memoryAuthority}: ${layer.text}`
            )
            .join(" | ")
        : "none"
    }`
  );
  return lines;
}

/**
 * Renders a bounded execution-input block for interpreted inbound media.
 *
 * @param media - Optional inbound media envelope.
 * @returns Execution-input block, or `null` when no media is attached.
 */
export function buildConversationMediaContextBlock(
  media: ConversationInboundMediaEnvelope | null | undefined
): string | null {
  const attachments = media?.attachments ?? [];
  if (attachments.length === 0) {
    return null;
  }

  const lines = [
    "Inbound media context (interpreted once, bounded, no raw bytes):",
    "- Use the interpreted media details as supporting context only.",
    "- Treat candidate-only layers as unverified media-derived meaning, not durable user memory.",
    "- Do not claim details that are absent from the interpretation summary/transcript/OCR/layer fields."
  ];

  for (const [index, attachment] of attachments.entries()) {
    lines.push(...buildAttachmentContextLines(attachment, index + 1));
  }
  return lines.join("\n");
}

