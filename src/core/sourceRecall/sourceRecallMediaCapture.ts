/**
 * @fileoverview Source Recall capture helpers for media interpretation layers.
 */

import type {
  SourceRecallCaptureClass,
  SourceRecallSourceKind,
  SourceRecallSourceRole,
  SourceRecallSourceTimeKind
} from "./contracts";
import type { SourceRecallRetentionPolicy } from "./sourceRecallRetention";
import {
  captureLowerAuthoritySourceRecall,
  type LowerAuthoritySourceRecallCaptureResult,
  type SourceRecallRecordWriter
} from "./sourceRecallConversationCapture";
import type { SourceAuthority } from "../sourceAuthority";

interface MediaLayerSourceRecallAttachmentLike {
  kind: "image" | "voice" | "video" | "document";
  provider: string;
  artifactId?: string | null;
  checksumSha256?: string | null;
  fileUniqueId?: string | null;
  interpretation?: {
    layers?: readonly MediaLayerSourceRecallLayerLike[] | null;
  } | null;
}

interface MediaLayerSourceRecallLayerLike {
  kind: string;
  source: string;
  text: string;
  memoryAuthority: "direct_user_text" | "support_only" | "candidate_only" | "not_memory_authority";
}

type MediaLayerSourceRecallSourceAuthority = Extract<
  SourceAuthority,
  "semantic_model" | "media_transcript" | "media_model_summary" | "document_text" | "document_model_summary"
>;

interface MediaLayerSourceRecallMapping {
  sourceKind: Extract<
    SourceRecallSourceKind,
    "media_transcript" | "ocr_text" | "media_model_summary" | "document_text" | "document_model_summary"
  >;
  sourceRole: Extract<SourceRecallSourceRole, "user" | "tool" | "runtime">;
  captureClass: Extract<SourceRecallCaptureClass, "ordinary_source" | "external_output">;
  sourceAuthority: MediaLayerSourceRecallSourceAuthority;
  sourceTimeKind: SourceRecallSourceTimeKind;
}

export interface CaptureMediaInterpretationLayersSourceRecallInput {
  scopeId: string;
  threadId: string;
  observedAt: string;
  attachment: MediaLayerSourceRecallAttachmentLike;
  policy: SourceRecallRetentionPolicy;
  writer: SourceRecallRecordWriter;
  capturedAt?: string;
}

export interface MediaLayerSourceRecallCaptureResult {
  layerIndex: number;
  sourceKind: MediaLayerSourceRecallMapping["sourceKind"];
  memoryAuthority: MediaLayerSourceRecallLayerLike["memoryAuthority"];
  result: LowerAuthoritySourceRecallCaptureResult;
  sourceRecallRef: {
    status: LowerAuthoritySourceRecallCaptureResult["status"];
    sourceRecordId?: string;
    sourceKind: MediaLayerSourceRecallMapping["sourceKind"];
    sourceRole: MediaLayerSourceRecallMapping["sourceRole"];
    captureClass: MediaLayerSourceRecallMapping["captureClass"];
    sourceAuthority: MediaLayerSourceRecallSourceAuthority;
    sourceTimeKind: SourceRecallSourceTimeKind;
    sourceRefAvailable: boolean;
    memoryAuthority: MediaLayerSourceRecallLayerLike["memoryAuthority"];
  };
}

/**
 * Captures supported media interpretation layers as Source Recall quoted evidence.
 *
 * **Why it exists:**
 * Media transcripts, OCR, and model summaries are useful recall evidence, but they must retain
 * their existing memory authority and remain separate from command routing or durable memory truth.
 *
 * **What it talks to:**
 * - Uses `captureLowerAuthoritySourceRecall` from `./sourceRecallConversationCapture`.
 *
 * @param input - Media attachment, policy, writer, and source scope metadata.
 * @returns Capture results for supported layers.
 */
export async function captureMediaInterpretationLayersSourceRecall(
  input: CaptureMediaInterpretationLayersSourceRecallInput
): Promise<MediaLayerSourceRecallCaptureResult[]> {
  const results: MediaLayerSourceRecallCaptureResult[] = [];
  const layers = input.attachment.interpretation?.layers ?? [];
  for (const [layerIndex, layer] of layers.entries()) {
    const mapping = mapMediaLayerToSourceRecall(input.attachment, layer);
    if (!mapping) {
      continue;
    }
    const result = await captureLowerAuthoritySourceRecall({
      scopeId: input.scopeId,
      threadId: input.threadId,
      text: layer.text,
      observedAt: input.observedAt,
      sourceKind: mapping.sourceKind,
      sourceRole: mapping.sourceRole,
      captureClass: mapping.captureClass,
      sourceAuthority: mapping.sourceAuthority,
      sourceTimeKind: mapping.sourceTimeKind,
      freshness: input.attachment.kind === "voice" ? "current_turn" : "recent",
      originSurface: "media_interpretation_layer",
      originRefId: buildMediaLayerOriginRef(input.attachment, layer, layerIndex),
      originParentRefId: input.attachment.artifactId ?? input.attachment.checksumSha256 ?? undefined,
      policy: input.policy,
      writer: input.writer,
      capturedAt: input.capturedAt
    });
    results.push({
      layerIndex,
      sourceKind: mapping.sourceKind,
      memoryAuthority: layer.memoryAuthority,
      result,
      sourceRecallRef: {
        status: result.status,
        sourceRecordId: result.status === "captured" ? result.sourceRecordId : undefined,
        sourceKind: mapping.sourceKind,
        sourceRole: mapping.sourceRole,
        captureClass: mapping.captureClass,
        sourceAuthority: mapping.sourceAuthority,
        sourceTimeKind: mapping.sourceTimeKind,
        sourceRefAvailable: result.status === "captured",
        memoryAuthority: layer.memoryAuthority
      }
    });
  }
  return results;
}

/**
 * Resolves Source Recall metadata for one supported media layer.
 *
 * @param attachment - Media attachment carrying the layer.
 * @param layer - Interpretation layer.
 * @returns Source Recall mapping, or `null` when the layer should not be captured by S4A.
 */
function mapMediaLayerToSourceRecall(
  attachment: MediaLayerSourceRecallAttachmentLike,
  layer: MediaLayerSourceRecallLayerLike
): MediaLayerSourceRecallMapping | null {
  if (layer.kind === "raw_text_extraction" && attachment.kind === "voice") {
    return {
      sourceKind: "media_transcript",
      sourceRole: "user",
      captureClass: "ordinary_source",
      sourceAuthority: "media_transcript",
      sourceTimeKind: "observed_event"
    };
  }
  if (layer.kind === "raw_text_extraction") {
    return {
      sourceKind: attachment.kind === "document" ? "document_text" : "ocr_text",
      sourceRole: "tool",
      captureClass: "external_output",
      sourceAuthority: attachment.kind === "document" ? "document_text" : "semantic_model",
      sourceTimeKind: "captured_record"
    };
  }
  if (layer.kind === "model_summary") {
    return {
      sourceKind: attachment.kind === "document" ? "document_model_summary" : "media_model_summary",
      sourceRole: "tool",
      captureClass: "external_output",
      sourceAuthority:
        attachment.kind === "document" ? "document_model_summary" : "media_model_summary",
      sourceTimeKind: "generated_summary"
    };
  }
  return null;
}

/**
 * Builds a hashed media origin reference input without storing raw provider handles.
 *
 * @param attachment - Media attachment.
 * @param layer - Interpretation layer.
 * @param layerIndex - Layer index within the attachment.
 * @returns Origin reference input that will be hashed by the lower-authority capture helper.
 */
function buildMediaLayerOriginRef(
  attachment: MediaLayerSourceRecallAttachmentLike,
  layer: MediaLayerSourceRecallLayerLike,
  layerIndex: number
): string {
  return [
    attachment.provider,
    attachment.kind,
    attachment.artifactId ?? "",
    attachment.checksumSha256 ?? "",
    attachment.fileUniqueId ?? "",
    layer.kind,
    layer.source,
    layerIndex.toString()
  ].join(":");
}
