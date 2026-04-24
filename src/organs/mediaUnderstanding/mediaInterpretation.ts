/**
 * @fileoverview Stable entrypoint for bounded media interpretation and envelope enrichment.
 */

import { createHash } from "node:crypto";
import type {
  ConversationInboundMediaAttachment,
  ConversationInboundMediaEnvelope,
  ConversationInboundMediaInterpretation
} from "../../interfaces/mediaRuntime/contracts";
import type {
  MediaAttachmentInterpretationInput,
  MediaInterpretationFixtureCatalog,
  MediaUnderstandingConfig
} from "./contracts";
import { createMediaUnderstandingConfigFromEnv } from "./contracts";
import { interpretDocumentAttachment } from "./documentUnderstanding";
import { interpretImageAttachment } from "./imageUnderstanding";
import { buildFallbackMediaInterpretation } from "./mediaModelFallback";
import { interpretVoiceAttachment } from "./speechToText";
import { interpretVideoAttachment } from "./videoUnderstanding";

/**
 * Calculates a stable fixture-catalog key for one downloaded media buffer.
 *
 * @param buffer - Downloaded media bytes.
 * @returns Lowercase SHA-256 digest.
 */
export function computeMediaFixtureKey(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Interprets one attachment using fixture catalogs, provider-backed helpers, or deterministic fallback.
 *
 * @param config - Media-understanding runtime config.
 * @param input - Attachment metadata plus optional downloaded bytes.
 * @param fixtureCatalog - Optional deterministic fixture catalog for tests/live smoke.
 * @returns Bounded interpretation record.
 */
export async function interpretMediaAttachment(
  config: MediaUnderstandingConfig,
  input: MediaAttachmentInterpretationInput,
  fixtureCatalog?: MediaInterpretationFixtureCatalog
): Promise<ConversationInboundMediaInterpretation> {
  const fixtureKey = input.buffer ? computeMediaFixtureKey(input.buffer) : null;
  if (fixtureKey && fixtureCatalog?.[fixtureKey]) {
    return {
      ...fixtureCatalog[fixtureKey],
      provenance: `${fixtureCatalog[fixtureKey].provenance} (fixture ${fixtureKey.slice(0, 8)})`,
      source: "fixture_catalog"
    };
  }

  if (input.attachment.kind === "voice") {
    return interpretVoiceAttachment(config, input.attachment, input.buffer);
  }
  if (input.attachment.kind === "image") {
    return interpretImageAttachment(config, input.attachment, input.buffer);
  }
  if (input.attachment.kind === "video") {
    return interpretVideoAttachment(input.attachment);
  }
  if (input.attachment.kind === "document") {
    return interpretDocumentAttachment(config, input.attachment, input.buffer);
  }
  return buildFallbackMediaInterpretation(input.attachment);
}

export class MediaUnderstandingOrgan {
  /**
   * Creates a bounded media-understanding organ.
   *
   * @param config - Provider/fallback configuration.
   * @param fixtureCatalog - Optional deterministic fixture catalog used by tests/live smoke.
   */
  constructor(
    private readonly config: MediaUnderstandingConfig = createMediaUnderstandingConfigFromEnv(),
    private readonly fixtureCatalog?: MediaInterpretationFixtureCatalog
  ) {}

  /**
   * Enriches one media envelope with bounded interpretations.
   *
   * @param envelope - Parsed inbound media envelope.
   * @param buffersByFileId - Optional downloaded bytes keyed by attachment file id.
   * @returns Enriched media envelope with bounded interpretations.
   */
  async interpretEnvelope(
    envelope: ConversationInboundMediaEnvelope | null | undefined,
    buffersByFileId: ReadonlyMap<string, Buffer> = new Map<string, Buffer>()
  ): Promise<ConversationInboundMediaEnvelope | null> {
    const attachments = envelope?.attachments ?? [];
    if (attachments.length === 0) {
      return null;
    }

    const interpretedAttachments: ConversationInboundMediaAttachment[] = [];
    for (const attachment of attachments) {
      const interpretation = await interpretMediaAttachment(
        this.config,
        {
          attachment,
          buffer: buffersByFileId.get(attachment.fileId) ?? null
        },
        this.fixtureCatalog
      );
      interpretedAttachments.push({
        ...attachment,
        interpretation
      });
    }
    return {
      attachments: interpretedAttachments
    };
  }
}
