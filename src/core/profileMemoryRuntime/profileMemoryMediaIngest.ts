/**
 * @fileoverview Bounded parsing helpers for media-derived user input entering profile memory.
 */

import { normalizeProfileValue } from "./profileMemoryNormalization";

const ATTACHED_MEDIA_CONTEXT_HEADER = "Attached media context:";
const INTERPRETED_MEDIA_CONTEXT_HEADER = "The user sent media with the following interpreted context:";
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

export interface ProfileMediaIngestInput {
  directUserText: string;
  transcriptFragments: readonly string[];
  summaryFragments: readonly string[];
  ocrFragments: readonly string[];
  candidateOnlyFragments: readonly string[];
  allNarrativeFragments: readonly string[];
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

  for (const line of mediaLines) {
    const normalizedLine = normalizeProfileValue(stripBulletPrefix(line));
    if (!normalizedLine) {
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
  if (userInput.startsWith(INTERPRETED_MEDIA_CONTEXT_HEADER)) {
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
  if (userInput.startsWith(INTERPRETED_MEDIA_CONTEXT_HEADER)) {
    return splitMediaLines(
      userInput.slice(INTERPRETED_MEDIA_CONTEXT_HEADER.length)
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
