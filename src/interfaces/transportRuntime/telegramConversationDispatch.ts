/**
 * @fileoverview Shared Telegram gateway helpers for media enrichment and chat-id derivation before conversation dispatch.
 */

import {
  buildConversationCommandRoutingInput,
  buildConversationInboundUserInput
} from "../mediaRuntime/mediaNormalization";
import {
  downloadTelegramFileBuffer,
  resolveTelegramFileDescriptor
} from "../mediaRuntime/telegramFileDownload";
import type { TelegramInterfaceConfig } from "../runtimeConfig";
import type {
  PreparedTelegramAcceptedUpdate,
  PreparedTelegramRejectedUpdate
} from "./telegramGatewayRuntime";
import type { MediaUnderstandingOrgan } from "../../organs/mediaUnderstanding/mediaInterpretation";
import {
  captureMediaInterpretationLayersSourceRecall,
  type MediaLayerSourceRecallCaptureResult
} from "../../core/sourceRecall/sourceRecallMediaCapture";
import type {
  ConversationInboundMediaAttachment,
  ConversationInboundMediaEnvelope,
  ConversationInboundMediaInterpretationLayer
} from "../mediaRuntime/contracts";
import type { MediaArtifactStore } from "../../core/mediaArtifactStore";
import type { ConversationSourceRecallCaptureDependencies } from "../conversationRuntime/managerContracts";
import {
  derivePrincipalContextFromIngress,
  requirePrincipalAccessForOperation
} from "../principalRuntime/principalAccess";

const SOURCE_RECALL_MEDIA_SOURCE_KINDS = new Set([
  "media_transcript",
  "ocr_text",
  "document_text",
  "document_model_summary",
  "media_model_summary"
]);

/**
 * Derives one Telegram chat id from a canonical conversation key.
 *
 * @param conversationKey - Canonical conversation key emitted by interface runtime state.
 * @returns Telegram chat id, or `null` when the key does not represent one Telegram chat.
 */
export function extractTelegramChatIdFromConversationKey(
  conversationKey: string
): string | null {
  const segments = conversationKey.split(":");
  if (segments.length < 3 || segments[0] !== "telegram") {
    return null;
  }
  return segments[1] || null;
}

export interface EnrichAcceptedTelegramUpdateWithMediaInput {
  prepared: PreparedTelegramAcceptedUpdate;
  config: TelegramInterfaceConfig;
  mediaUnderstandingOrgan?: MediaUnderstandingOrgan;
  mediaArtifactStore?: MediaArtifactStore;
  sourceRecallCapture?: ConversationSourceRecallCaptureDependencies;
}

/**
 * Returns whether a Telegram media-only turn is an unsupported voice note with no usable
 * transcript, so the transport should fail closed instead of inventing semantic user input.
 *
 * @param canonicalText - Current canonical text assembled before media enrichment.
 * @param media - Interpreted media envelope for the accepted Telegram update.
 * @returns `true` when the turn is a voice-only fallback with no transcript and no explicit text.
 */
function isUntranscribedMediaOnlyVoiceNote(
  canonicalText: string,
  media: ConversationInboundMediaEnvelope | null
): boolean {
  if (canonicalText.trim().length > 0) {
    return false;
  }
  if (!media || media.attachments.length !== 1) {
    return false;
  }
  const [attachment] = media.attachments;
  if (attachment?.kind !== "voice") {
    return false;
  }
  const interpretation = attachment.interpretation;
  if (!interpretation || interpretation.transcript?.trim()) {
    return false;
  }
  return (
    interpretation.source === "metadata_fallback" ||
    interpretation.source === "unavailable"
  );
}

/**
 * Downloads and interprets accepted Telegram media before it enters the shared conversation path.
 *
 * @param input - Accepted Telegram update plus media/runtime dependencies.
 * @returns Accepted update with interpreted media folded into canonical input, or one rejection
 *   when media cannot be safely read.
 */
export async function enrichAcceptedTelegramUpdateWithMedia(
  input: EnrichAcceptedTelegramUpdateWithMediaInput
): Promise<PreparedTelegramAcceptedUpdate | PreparedTelegramRejectedUpdate> {
  const originalMedia = input.prepared.inbound.media ?? null;
  if (!originalMedia) {
    return input.prepared;
  }

  let interpretedMedia = originalMedia;
  const buffersByFileId = new Map<string, Buffer>();
  if (input.mediaUnderstandingOrgan || input.mediaArtifactStore) {
    try {
      for (const attachment of originalMedia.attachments) {
        const descriptor = await resolveTelegramFileDescriptor(
          input.config.apiBaseUrl,
          input.config.botToken,
          attachment.fileId
        );
        const buffer = await downloadTelegramFileBuffer(
          descriptor,
          input.config.media.maxDownloadBytes
        );
        buffersByFileId.set(attachment.fileId, buffer);
      }
      if (input.mediaUnderstandingOrgan) {
        interpretedMedia =
          (await input.mediaUnderstandingOrgan.interpretEnvelope(
            originalMedia,
            buffersByFileId
          )) ?? originalMedia;
      }
    } catch (error) {
      console.warn(
        `[TelegramGateway] media ingest rejected: ${(error as Error).message}`
      );
      return {
        kind: "rejected",
        chatId: input.prepared.chatId,
        responseText:
          "I couldn't safely read that media attachment. Please resend it or describe it in text."
      };
    }
  }

  if (input.mediaArtifactStore && interpretedMedia.attachments.length > 0) {
    const artifactAttachments = [];
    for (const attachment of interpretedMedia.attachments) {
      const buffer = buffersByFileId.get(attachment.fileId);
      if (!buffer) {
        artifactAttachments.push(attachment);
        continue;
      }
      const artifact = await input.mediaArtifactStore.recordArtifact({
        attachment,
        buffer,
        sourceSurface: "telegram_interface",
        sourceConversationKey: `telegram:${input.prepared.chatId}:${input.prepared.userId}`,
        sourceUserId: input.prepared.userId,
        recordedAt: input.prepared.inbound.receivedAt ?? new Date().toISOString()
      });
      artifactAttachments.push({
        ...attachment,
        artifactId: artifact.artifactId,
        checksumSha256: artifact.checksumSha256,
        ownedAssetPath: artifact.ownedAssetPath
      });
    }
    interpretedMedia = {
      attachments: artifactAttachments
    };
  }

  const sourceRecallCapture = input.sourceRecallCapture;
  if (
    sourceRecallCapture &&
    shouldAttemptTelegramMediaSourceRecall(sourceRecallCapture) &&
    interpretedMedia.attachments.length > 0
  ) {
    interpretedMedia = {
      attachments: await Promise.all(
        interpretedMedia.attachments.map((attachment) =>
          attachTelegramMediaSourceRecallRefs({
            attachment,
            sourceRecallCapture,
            prepared: input.prepared,
            config: input.config
          })
        )
      )
    };
  }

  if (
    isUntranscribedMediaOnlyVoiceNote(
      input.prepared.inbound.text,
      interpretedMedia
    )
  ) {
    return {
      kind: "rejected",
      chatId: input.prepared.chatId,
      responseText:
        "I received your voice note, but I couldn't transcribe it in this environment. Please resend it as text or try again where voice transcription is available."
    };
  }

  const canonicalUserInput = buildConversationInboundUserInput(
    input.prepared.inbound.text,
    interpretedMedia
  );
  return {
    ...input.prepared,
    inbound: {
      ...input.prepared.inbound,
      text: input.prepared.inbound.text,
      commandRoutingText: buildConversationCommandRoutingInput(
        input.prepared.inbound.text,
        interpretedMedia
      ),
      media: interpretedMedia
    },
    entityGraphEvent: {
      ...input.prepared.entityGraphEvent,
      text: canonicalUserInput
    }
  };
}

/**
 * Returns whether the explicit Source Recall policy has a media/document allowlist.
 *
 * @param sourceRecallCapture - Active Source Recall capture dependencies.
 * @returns `true` when media/document capture should be attempted.
 */
function shouldAttemptTelegramMediaSourceRecall(
  sourceRecallCapture: ConversationSourceRecallCaptureDependencies
): boolean {
  return (
    sourceRecallCapture.policy.sourceKindCaptureAllowlist.some((sourceKind) =>
      SOURCE_RECALL_MEDIA_SOURCE_KINDS.has(sourceKind)
    ) &&
    (sourceRecallCapture.policy.captureClassAllowlist.includes("ordinary_source") ||
      sourceRecallCapture.policy.captureClassAllowlist.includes("external_output"))
  );
}

/**
 * Captures one owned Telegram media attachment's interpretation layers as Source Recall evidence.
 *
 * @param input - Media attachment plus Source Recall and conversation metadata.
 * @returns Attachment with per-layer Source Recall refs when capture was attempted.
 */
async function attachTelegramMediaSourceRecallRefs(input: {
  attachment: ConversationInboundMediaAttachment;
  sourceRecallCapture: ConversationSourceRecallCaptureDependencies;
  prepared: PreparedTelegramAcceptedUpdate;
  config: TelegramInterfaceConfig;
}): Promise<ConversationInboundMediaAttachment> {
  if (!input.attachment.artifactId || !input.attachment.interpretation?.layers?.length) {
    return input.attachment;
  }
  try {
    const results = await captureMediaInterpretationLayersSourceRecall({
      scopeId: buildTelegramMediaSourceRecallScopeId(input.prepared),
      threadId: buildTelegramMediaSourceRecallScopeId(input.prepared),
      observedAt: input.prepared.inbound.receivedAt ?? new Date().toISOString(),
      attachment: input.attachment,
      policy: input.sourceRecallCapture.policy,
      writer: input.sourceRecallCapture.writer,
      capturedAt: input.sourceRecallCapture.capturedAt,
      principalAccess: buildTelegramMediaSourceRecallPrincipalAccess(input.prepared, input.config)
    });
    if (results.length === 0) {
      return input.attachment;
    }
    return attachSourceRecallRefsToLayers(input.attachment, results);
  } catch {
    return input.attachment;
  }
}

/**
 * Implements `buildTelegramMediaSourceRecallScopeId` behavior within this module.
 */
export function buildTelegramMediaSourceRecallScopeId(
  prepared: Pick<PreparedTelegramAcceptedUpdate, "chatId" | "userId">
): string {
  return `conversation:telegram:${prepared.chatId}:${prepared.userId}`;
}

/**
 * Implements `buildTelegramMediaSourceRecallPrincipalAccess` behavior within this module.
 */
function buildTelegramMediaSourceRecallPrincipalAccess(
  prepared: PreparedTelegramAcceptedUpdate,
  config: TelegramInterfaceConfig
) {
  const principalContext = derivePrincipalContextFromIngress({
    provider: "telegram",
    conversationId: prepared.chatId,
    userId: prepared.userId,
    username: prepared.username,
    conversationVisibility: prepared.conversationVisibility,
    transportIdentity: prepared.transportIdentity,
    receivedAt: prepared.inbound.receivedAt ?? new Date().toISOString(),
    principalConfig: config.security.principalConfig,
    allowedUserIds: config.security.allowedUserIds,
    allowedUsernames: config.security.allowedUsernames
  });
  return requirePrincipalAccessForOperation({
    principalContext,
    operation: "source_recall_capture",
    accessClass: prepared.conversationVisibility === "public" ? "shared_public" : "speaker_private",
    allowed: true,
    reason: prepared.conversationVisibility === "public" ? "public_safe" : "speaker_scope_matched"
  });
}

/**
 * Adds Source Recall refs to the matching interpretation layers without changing layer text.
 *
 * @param attachment - Media attachment whose layers were captured.
 * @param results - Capture results indexed by media interpretation layer.
 * @returns Attachment with source refs on captured layers.
 */
function attachSourceRecallRefsToLayers(
  attachment: ConversationInboundMediaAttachment,
  results: readonly MediaLayerSourceRecallCaptureResult[]
): ConversationInboundMediaAttachment {
  const refsByLayerIndex = new Map(
    results.map((result) => [result.layerIndex, result.sourceRecallRef])
  );
  const layers = attachment.interpretation?.layers?.map(
    (layer, index): ConversationInboundMediaInterpretationLayer => {
      const sourceRecall = refsByLayerIndex.get(index);
      return sourceRecall ? { ...layer, sourceRecall } : layer;
    }
  );
  return {
    ...attachment,
    interpretation: attachment.interpretation
      ? {
          ...attachment.interpretation,
          layers
        }
      : attachment.interpretation
  };
}
