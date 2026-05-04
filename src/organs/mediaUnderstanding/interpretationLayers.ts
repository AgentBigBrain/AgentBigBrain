/**
 * @fileoverview Canonical media interpretation layer normalization for memory and projection.
 */

import type {
  ConversationInboundMediaAttachment,
  ConversationInboundMediaInterpretation,
  ConversationInboundMediaInterpretationLayer,
  ConversationInboundMediaInterpretationLayerKind,
  ConversationInboundMediaInterpretationSource,
  ConversationInboundMediaMemoryAuthority,
  ConversationInboundMediaSourceRecallRef
} from "../../interfaces/mediaRuntime/contracts";
import { buildBoundedTextExcerpt } from "./interpretationSupport";

const MAX_LAYER_TEXT_CHARS = 1_500;

interface MediaInterpretationLayerInput {
  kind: ConversationInboundMediaInterpretationLayerKind;
  source: ConversationInboundMediaInterpretationSource;
  text: string | null | undefined;
  confidence: number | null;
  provenance: string;
  memoryAuthority: ConversationInboundMediaMemoryAuthority;
  sourceRecall?: ConversationInboundMediaSourceRecallRef;
}

/**
 * Builds one bounded interpretation layer, dropping empty text.
 *
 * @param input - Candidate layer attributes from an interpretation source.
 * @returns Canonical bounded layer, or `null` when no text is available.
 */
export function buildMediaInterpretationLayer(
  input: MediaInterpretationLayerInput
): ConversationInboundMediaInterpretationLayer | null {
  const text = buildBoundedTextExcerpt(input.text ?? "", MAX_LAYER_TEXT_CHARS);
  if (!text) {
    return null;
  }
  return {
    kind: input.kind,
    source: input.source,
    text,
    confidence: input.confidence,
    provenance: input.provenance,
    memoryAuthority: input.memoryAuthority,
    ...(input.sourceRecall ? { sourceRecall: input.sourceRecall } : {})
  };
}

/**
 * Ensures every media interpretation carries canonical layer metadata.
 *
 * @param interpretation - Provider, deterministic, fixture, or fallback interpretation.
 * @param attachment - Attachment metadata used to resolve default layer authority.
 * @returns Interpretation with bounded canonical layers.
 */
export function normalizeMediaInterpretationLayers(
  interpretation: ConversationInboundMediaInterpretation,
  attachment: ConversationInboundMediaAttachment
): ConversationInboundMediaInterpretation {
  const existingLayers = (interpretation.layers ?? [])
    .map((layer) =>
      buildMediaInterpretationLayer({
        kind: layer.kind,
        source: layer.source,
        text: layer.text,
        confidence: layer.confidence,
        provenance: layer.provenance,
        memoryAuthority: layer.memoryAuthority,
        sourceRecall: layer.sourceRecall
      })
    )
    .filter((layer): layer is ConversationInboundMediaInterpretationLayer => Boolean(layer));
  if (existingLayers.length > 0) {
    return {
      ...interpretation,
      layers: existingLayers
    };
  }

  const inferredLayers = buildInferredMediaInterpretationLayers(interpretation, attachment);
  return {
    ...interpretation,
    layers: inferredLayers
  };
}

/**
 * Converts legacy top-level interpretation fields into canonical layers.
 *
 * @param interpretation - Legacy interpretation shape.
 * @param attachment - Attachment being interpreted.
 * @returns Canonical inferred layers.
 */
function buildInferredMediaInterpretationLayers(
  interpretation: ConversationInboundMediaInterpretation,
  attachment: ConversationInboundMediaAttachment
): readonly ConversationInboundMediaInterpretationLayer[] {
  const layers: ConversationInboundMediaInterpretationLayer[] = [];
  const source = interpretation.source;

  if (interpretation.transcript) {
    const transcriptLayer = buildMediaInterpretationLayer({
      kind: "raw_text_extraction",
      source,
      text: interpretation.transcript,
      confidence: interpretation.confidence,
      provenance: interpretation.provenance,
      memoryAuthority: attachment.kind === "voice" ? "direct_user_text" : "candidate_only"
    });
    if (transcriptLayer) {
      layers.push(transcriptLayer);
    }
  }

  if (interpretation.ocrText) {
    const rawTextLayer = buildMediaInterpretationLayer({
      kind: "raw_text_extraction",
      source,
      text: interpretation.ocrText,
      confidence: interpretation.confidence,
      provenance: interpretation.provenance,
      memoryAuthority: "candidate_only"
    });
    if (rawTextLayer) {
      layers.push(rawTextLayer);
    }
  }

  const summaryLayer = buildMediaInterpretationLayer({
    kind: resolveSummaryLayerKind(source),
    source,
    text: interpretation.summary,
    confidence: interpretation.confidence,
    provenance: interpretation.provenance,
    memoryAuthority: resolveSummaryLayerMemoryAuthority(source, attachment.kind)
  });
  if (summaryLayer) {
    layers.push(summaryLayer);
  }

  return dedupeLayers(layers);
}

/**
 * Resolves the layer kind for a top-level summary.
 *
 * @param source - Interpretation source.
 * @returns Canonical layer kind.
 */
function resolveSummaryLayerKind(
  source: ConversationInboundMediaInterpretationSource
): ConversationInboundMediaInterpretationLayerKind {
  if (source === "openai_image" || source === "ollama_image" || source === "document_model_summary") {
    return "model_summary";
  }
  if (source === "fixture_catalog") {
    return "fixture_catalog";
  }
  if (source === "caption_fallback" || source === "metadata_fallback" || source === "unavailable") {
    return "fallback_note";
  }
  return "deterministic_metadata";
}

/**
 * Resolves memory authority for a top-level summary.
 *
 * @param source - Interpretation source.
 * @param kind - Attachment kind.
 * @returns Memory authority attached to the inferred layer.
 */
function resolveSummaryLayerMemoryAuthority(
  source: ConversationInboundMediaInterpretationSource,
  kind: ConversationInboundMediaAttachment["kind"]
): ConversationInboundMediaMemoryAuthority {
  if (kind === "voice" && source === "fixture_catalog") {
    return "direct_user_text";
  }
  if (source === "openai_image" || source === "ollama_image" || source === "document_model_summary") {
    return "candidate_only";
  }
  return "not_memory_authority";
}

/**
 * Deduplicates layers by semantic source, authority, and text.
 *
 * @param layers - Candidate layers.
 * @returns Stable unique layers.
 */
function dedupeLayers(
  layers: readonly ConversationInboundMediaInterpretationLayer[]
): readonly ConversationInboundMediaInterpretationLayer[] {
  const seen = new Set<string>();
  const ordered: ConversationInboundMediaInterpretationLayer[] = [];
  for (const layer of layers) {
    const signature = [
      layer.kind,
      layer.source,
      layer.memoryAuthority,
      layer.text.toLowerCase()
    ].join("\n");
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    ordered.push(layer);
  }
  return ordered;
}
