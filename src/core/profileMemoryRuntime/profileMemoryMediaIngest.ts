/**
 * @fileoverview Bounded parsing helpers for media-derived user input entering profile memory.
 */

import { normalizeProfileValue } from "./profileMemoryNormalization";
import type { ProfileMediaIngestInput } from "./contracts";

export type { ProfileMediaIngestInput } from "./contracts";

const ATTACHED_MEDIA_CONTEXT_HEADER = "Attached media context:";
const INTERPRETED_MEDIA_CONTEXT_HEADER = "The user sent media with the following interpreted context:";
const INBOUND_MEDIA_CONTEXT_HEADER = "Inbound media context (interpreted once, bounded, no raw bytes):";
const GENERIC_MEDIA_ONLY_PROMPTS = new Set([
  "Please review the attached image and respond based on what it shows.",
  "Please transcribe the attached voice note and respond to its request.",
  "Please review the attached short video and respond based on what it shows.",
  "Please review the attached document and respond based on its content.",
  "Please review the attached media and respond based on its content."
]);

const VOICE_TRANSCRIPT_PREFIX = "Voice note transcript:";
const OCR_TEXT_PREFIX = "OCR text:";
const SUMMARY_PREFIX_PATTERN = /^(image|short video|video|document) summary:\s*/i;

interface ProfileMediaIngestEnvelopeLike {
  attachments?: readonly ProfileMediaIngestAttachmentLike[];
}

interface ProfileMediaIngestAttachmentLike {
  kind?: string;
  interpretation?: ProfileMediaIngestInterpretationLike | null;
}

interface ProfileMediaIngestInterpretationLike {
  summary?: string | null;
  transcript?: string | null;
  ocrText?: string | null;
  layers?: readonly ProfileMediaIngestLayerLike[] | null;
}

interface ProfileMediaIngestLayerLike {
  kind?: string;
  text?: string | null;
  memoryAuthority?: string;
}

/**
 * Parses canonical conversation input that may include interpreted media context.
 *
 * @param userInput - Current canonical user input.
 * @returns Direct text plus bounded interpreted-media fragments for memory brokerage.
 */
export function parseProfileMediaIngestInput(userInput: string): ProfileMediaIngestInput {
  const normalizedInput = userInput.trim();
  if (!normalizedInput) {
    return emptyProfileMediaIngestInput();
  }

  if (GENERIC_MEDIA_ONLY_PROMPTS.has(normalizedInput)) {
    return emptyProfileMediaIngestInput();
  }

  const directUserText = extractDirectUserText(normalizedInput);
  const mediaLines = extractMediaContextLines(normalizedInput);
  if (mediaLines.length === 0) {
    return {
      directUserText,
      transcriptFragments: [],
      summaryFragments: [],
      ocrFragments: [],
      candidateOnlyFragments: [],
      allNarrativeFragments: directUserText ? [directUserText] : []
    };
  }

  const transcriptFragments: string[] = [];
  const summaryFragments: string[] = [];
  const ocrFragments: string[] = [];
  const memoryEligibleSummaryFragments: string[] = [];
  const memoryEligibleOcrFragments: string[] = [];
  const candidateOnlyFragments: string[] = [];
  let previousLineWasDocumentDerived = false;
  let currentAttachmentKind: string | null = null;
  let currentLayerMemoryAuthority: string | null = null;

  for (const line of mediaLines) {
    const normalizedLine = normalizeProfileValue(stripBulletPrefix(line));
    if (!normalizedLine) {
      continue;
    }
    const attachmentKind = extractRenderedAttachmentKind(normalizedLine);
    if (attachmentKind) {
      currentAttachmentKind = attachmentKind;
      currentLayerMemoryAuthority = null;
      continue;
    }
    const renderedKind = extractRenderedKindField(normalizedLine);
    if (renderedKind) {
      currentAttachmentKind = renderedKind;
      continue;
    }
    const renderedLayerAuthority = extractRenderedLayerAuthority(normalizedLine);
    if (renderedLayerAuthority) {
      currentLayerMemoryAuthority = renderedLayerAuthority;
      continue;
    }

    const renderedSummary = extractRenderedQuotedField(
      normalizedLine,
      "interpretation.summary"
    );
    if (renderedSummary) {
      summaryFragments.push(renderedSummary);
      if (currentAttachmentKind === "document") {
        candidateOnlyFragments.push(renderedSummary);
      } else {
        memoryEligibleSummaryFragments.push(renderedSummary);
      }
      previousLineWasDocumentDerived = currentAttachmentKind === "document";
      continue;
    }

    const renderedTranscript = extractRenderedQuotedField(
      normalizedLine,
      "interpretation.transcript"
    );
    if (renderedTranscript) {
      transcriptFragments.push(renderedTranscript);
      previousLineWasDocumentDerived = false;
      continue;
    }

    const renderedOcr = extractRenderedQuotedField(
      normalizedLine,
      "interpretation.ocrText"
    );
    if (renderedOcr) {
      ocrFragments.push(renderedOcr);
      if (currentAttachmentKind === "document") {
        candidateOnlyFragments.push(renderedOcr);
      } else {
        memoryEligibleOcrFragments.push(renderedOcr);
      }
      previousLineWasDocumentDerived = currentAttachmentKind === "document";
      continue;
    }

    const renderedLayerText = extractRenderedQuotedField(normalizedLine, "text");
    if (renderedLayerText) {
      if (currentLayerMemoryAuthority === "direct_user_text") {
        transcriptFragments.push(renderedLayerText);
        memoryEligibleSummaryFragments.push(renderedLayerText);
      } else if (currentLayerMemoryAuthority === "support_only") {
        memoryEligibleSummaryFragments.push(renderedLayerText);
      } else if (currentLayerMemoryAuthority === "candidate_only") {
        candidateOnlyFragments.push(renderedLayerText);
      }
      previousLineWasDocumentDerived = currentAttachmentKind === "document";
      continue;
    }

    if (normalizedLine.startsWith(VOICE_TRANSCRIPT_PREFIX)) {
      const transcript = normalizeProfileValue(
        normalizedLine.slice(VOICE_TRANSCRIPT_PREFIX.length)
      );
      if (transcript) {
        transcriptFragments.push(transcript);
      }
      previousLineWasDocumentDerived = false;
      continue;
    }

    const isDocumentDerivedLine =
      /^document summary:\s*/i.test(normalizedLine) ||
      (normalizedLine.startsWith(OCR_TEXT_PREFIX) && previousLineWasDocumentDerived);
    const ocrIndex = normalizedLine.indexOf(` ${OCR_TEXT_PREFIX}`);
    if (SUMMARY_PREFIX_PATTERN.test(normalizedLine)) {
      const summarySection = ocrIndex >= 0
        ? normalizedLine.slice(0, ocrIndex)
        : normalizedLine;
      const summary = normalizeProfileValue(
        summarySection.replace(SUMMARY_PREFIX_PATTERN, "")
      );
      if (summary) {
        summaryFragments.push(summary);
        if (isDocumentDerivedLine) {
          candidateOnlyFragments.push(summary);
        } else {
          memoryEligibleSummaryFragments.push(summary);
        }
      }
    }

    const rawOcr = ocrIndex >= 0
      ? normalizedLine.slice(ocrIndex + 1 + OCR_TEXT_PREFIX.length)
      : normalizedLine.startsWith(OCR_TEXT_PREFIX)
        ? normalizedLine.slice(OCR_TEXT_PREFIX.length)
        : "";
    const ocr = normalizeProfileValue(rawOcr);
    if (ocr) {
      ocrFragments.push(ocr);
      if (isDocumentDerivedLine) {
        candidateOnlyFragments.push(ocr);
      } else {
        memoryEligibleOcrFragments.push(ocr);
      }
    }
    previousLineWasDocumentDerived = /^document summary:\s*/i.test(normalizedLine);
  }

  const allNarrativeFragments = dedupeProfileMediaNarrativeFragments([
    directUserText,
    ...transcriptFragments,
    ...memoryEligibleSummaryFragments,
    ...memoryEligibleOcrFragments
  ]);

  return {
    directUserText,
    transcriptFragments,
    summaryFragments,
    ocrFragments,
    candidateOnlyFragments: dedupeProfileMediaNarrativeFragments(candidateOnlyFragments),
    allNarrativeFragments
  };
}

/**
 * Builds profile-memory media ingest from the structured inbound media envelope.
 *
 * @param userInput - Direct user-authored text for the turn.
 * @param media - Structured media envelope with canonical interpretation layers.
 * @returns Direct text plus media fragments split by memory authority.
 */
export function buildProfileMediaIngestInputFromEnvelope(
  userInput: string,
  media: ProfileMediaIngestEnvelopeLike | null | undefined
): ProfileMediaIngestInput {
  const normalizedUserInput = userInput.trim();
  const directUserText = GENERIC_MEDIA_ONLY_PROMPTS.has(normalizedUserInput)
    ? ""
    : extractDirectUserText(normalizedUserInput);
  const transcriptFragments: string[] = [];
  const summaryFragments: string[] = [];
  const ocrFragments: string[] = [];
  const candidateOnlyFragments: string[] = [];
  const supportOnlyFragments: string[] = [];
  const directMediaFragments: string[] = [];

  for (const attachment of media?.attachments ?? []) {
    const interpretation = attachment.interpretation;
    if (!interpretation) {
      continue;
    }
    const layers = interpretation.layers?.length
      ? interpretation.layers
      : buildLegacyMediaLayers(attachment);
    for (const layer of layers) {
      const text = normalizeProfileValue(layer.text ?? "");
      if (!text) {
        continue;
      }
      if (layer.kind === "raw_text_extraction" && attachment.kind === "voice") {
        transcriptFragments.push(text);
      } else if (layer.kind === "raw_text_extraction") {
        ocrFragments.push(text);
      } else {
        summaryFragments.push(text);
      }

      if (layer.memoryAuthority === "direct_user_text") {
        directMediaFragments.push(text);
      } else if (layer.memoryAuthority === "support_only") {
        supportOnlyFragments.push(text);
      } else if (layer.memoryAuthority === "candidate_only") {
        candidateOnlyFragments.push(text);
      }
    }
  }

  const allNarrativeFragments = dedupeProfileMediaNarrativeFragments([
    directUserText,
    ...directMediaFragments,
    ...supportOnlyFragments
  ]);

  return {
    directUserText,
    transcriptFragments: dedupeProfileMediaNarrativeFragments(transcriptFragments),
    summaryFragments: dedupeProfileMediaNarrativeFragments(summaryFragments),
    ocrFragments: dedupeProfileMediaNarrativeFragments(ocrFragments),
    candidateOnlyFragments: dedupeProfileMediaNarrativeFragments(candidateOnlyFragments),
    allNarrativeFragments
  };
}

/**
 * Adapts legacy top-level media interpretation fields into structured ingest layers.
 *
 * @param attachment - Media attachment with legacy top-level interpretation fields.
 * @returns Bounded layer-like fragments.
 */
function buildLegacyMediaLayers(
  attachment: ProfileMediaIngestAttachmentLike
): readonly ProfileMediaIngestLayerLike[] {
  const interpretation = attachment.interpretation;
  if (!interpretation) {
    return [];
  }
  const layers: ProfileMediaIngestLayerLike[] = [];
  if (interpretation.transcript) {
    layers.push({
      kind: "raw_text_extraction",
      text: interpretation.transcript,
      memoryAuthority: attachment.kind === "voice" ? "direct_user_text" : "candidate_only"
    });
  }
  if (interpretation.ocrText) {
    layers.push({
      kind: "raw_text_extraction",
      text: interpretation.ocrText,
      memoryAuthority: "candidate_only"
    });
  }
  if (interpretation.summary) {
    layers.push({
      kind: "deterministic_metadata",
      text: interpretation.summary,
      memoryAuthority: "not_memory_authority"
    });
  }
  return layers;
}

/**
 * Returns an empty parsed media-ingest structure for blank or unsupported user input.
 *
 * @returns Zero-value media-ingest input record.
 */
function emptyProfileMediaIngestInput(): ProfileMediaIngestInput {
  return {
    directUserText: "",
    transcriptFragments: [],
    summaryFragments: [],
    ocrFragments: [],
    candidateOnlyFragments: [],
    allNarrativeFragments: []
  };
}

/**
 * Removes attached interpreted-media sections from canonical user input.
 *
 * @param userInput - Canonical user input that may include attached media context blocks.
 * @returns Direct user-authored text only.
 */
function extractDirectUserText(userInput: string): string {
  const attachedMediaIndex = userInput.indexOf(`\n\n${ATTACHED_MEDIA_CONTEXT_HEADER}`);
  if (attachedMediaIndex >= 0) {
    return normalizeProfileValue(userInput.slice(0, attachedMediaIndex));
  }
  const inboundMediaIndex = userInput.indexOf(`\n\n${INBOUND_MEDIA_CONTEXT_HEADER}`);
  if (inboundMediaIndex >= 0) {
    return normalizeProfileValue(userInput.slice(0, inboundMediaIndex));
  }
  if (userInput.startsWith(INTERPRETED_MEDIA_CONTEXT_HEADER)) {
    return "";
  }
  if (userInput.startsWith(INBOUND_MEDIA_CONTEXT_HEADER)) {
    return "";
  }
  if (
    userInput.startsWith(VOICE_TRANSCRIPT_PREFIX)
    || SUMMARY_PREFIX_PATTERN.test(userInput)
    || userInput.startsWith(OCR_TEXT_PREFIX)
  ) {
    return "";
  }
  return normalizeProfileValue(userInput);
}

/**
 * Extracts interpreted media context lines from canonical user input.
 *
 * @param userInput - Canonical user input that may embed media context blocks.
 * @returns Individual interpreted-media lines.
 */
function extractMediaContextLines(userInput: string): readonly string[] {
  const attachedMediaIndex = userInput.indexOf(`\n\n${ATTACHED_MEDIA_CONTEXT_HEADER}`);
  if (attachedMediaIndex >= 0) {
    return splitMediaLines(
      userInput.slice(attachedMediaIndex + `\n\n${ATTACHED_MEDIA_CONTEXT_HEADER}`.length)
    );
  }
  const inboundMediaIndex = userInput.indexOf(`\n\n${INBOUND_MEDIA_CONTEXT_HEADER}`);
  if (inboundMediaIndex >= 0) {
    return splitMediaLines(
      userInput.slice(inboundMediaIndex + `\n\n${INBOUND_MEDIA_CONTEXT_HEADER}`.length)
    );
  }
  if (userInput.startsWith(INTERPRETED_MEDIA_CONTEXT_HEADER)) {
    return splitMediaLines(
      userInput.slice(INTERPRETED_MEDIA_CONTEXT_HEADER.length)
    );
  }
  if (userInput.startsWith(INBOUND_MEDIA_CONTEXT_HEADER)) {
    return splitMediaLines(
      userInput.slice(INBOUND_MEDIA_CONTEXT_HEADER.length)
    );
  }
  if (
    userInput.startsWith(VOICE_TRANSCRIPT_PREFIX)
    || SUMMARY_PREFIX_PATTERN.test(userInput)
    || userInput.startsWith(OCR_TEXT_PREFIX)
  ) {
    return [userInput];
  }
  return [];
}

/**
 * Splits one interpreted-media block into non-empty trimmed lines.
 *
 * @param input - Raw interpreted-media block.
 * @returns Normalized non-empty lines.
 */
function splitMediaLines(input: string): readonly string[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Removes one leading Markdown-style bullet prefix from a media context line.
 *
 * @param value - Raw line that may start with `- `.
 * @returns Trimmed line without the leading bullet marker.
 */
function stripBulletPrefix(value: string): string {
  return value.replace(/^-\s*/, "").trim();
}

/**
 * Extracts the current attachment kind from one rendered attachment header.
 *
 * @param line - Normalized rendered media context line.
 * @returns Attachment kind label, or `null`.
 */
function extractRenderedAttachmentKind(line: string): string | null {
  const match = line.match(/^Attachment\s+\d+:\s+(image|voice note|short video|document)$/i);
  if (!match?.[1]) {
    return null;
  }
  switch (match[1].toLowerCase()) {
    case "voice note":
      return "voice";
    case "short video":
      return "video";
    default:
      return match[1].toLowerCase();
  }
}

/**
 * Extracts the canonical kind field from rendered media context.
 *
 * @param line - Normalized rendered media context line.
 * @returns Attachment kind, or `null`.
 */
function extractRenderedKindField(line: string): string | null {
  const match = line.match(/^kind:\s+(image|voice|video|document)$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Extracts one rendered layer memory authority.
 *
 * @param line - Normalized rendered media context line.
 * @returns Layer authority, or `null`.
 */
function extractRenderedLayerAuthority(line: string): string | null {
  const match = line.match(/(?:^|;\s*)authority=([a-z_]+)(?:;|$)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Extracts and unquotes one rendered media data field.
 *
 * @param line - Normalized rendered media context line.
 * @param fieldName - Rendered field name before `(quoted data)`.
 * @returns Unquoted field text, or an empty string when absent or `none`.
 */
function extractRenderedQuotedField(line: string, fieldName: string): string {
  const prefix = `${fieldName} (quoted data):`;
  if (!line.startsWith(prefix)) {
    return "";
  }
  const rawValue = line.slice(prefix.length).trim();
  const parsed = parseRenderedQuotedScalar(rawValue);
  return parsed === "none" ? "" : parsed;
}

/**
 * Parses one JSON-quoted scalar emitted by media context rendering.
 *
 * @param value - Raw rendered value.
 * @returns Parsed scalar when possible, otherwise an unwrapped fallback.
 */
function parseRenderedQuotedScalar(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "string") {
      return normalizeProfileValue(parsed);
    }
  } catch {
    // Fall through to the bounded compatibility unwrapping below.
  }
  return normalizeProfileValue(value.replace(/^["']|["']$/g, ""));
}

/**
 * Deduplicates interpreted media narrative fragments while preserving their first-seen order.
 *
 * @param fragments - Candidate narrative fragments collected from text, transcripts, summaries,
 *   and OCR.
 * @returns Ordered unique fragments suitable for memory brokerage.
 */
function dedupeProfileMediaNarrativeFragments(fragments: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const fragment of fragments) {
    const normalized = normalizeProfileValue(fragment);
    if (!normalized) {
      continue;
    }
    const signature = normalized.toLowerCase();
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    ordered.push(normalized);
  }
  return ordered;
}
