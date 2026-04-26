/**
 * @fileoverview Deterministic document-understanding helpers for PDF and text attachments.
 */

import type {
  ConversationInboundMediaAttachment,
  ConversationInboundMediaInterpretation
} from "../../interfaces/mediaRuntime/contracts";
import type { MediaUnderstandingConfig } from "./contracts";
import { buildFallbackMediaInterpretation } from "./mediaModelFallback";
import {
  buildBoundedTextExcerpt,
  collectEntityHintsFromTexts
} from "./interpretationSupport";

const IDENTIFIER_PATTERN = /\b\d{6,}\b/g;

/**
 * Attempts bounded interpretation for one document attachment.
 *
 * @param _config - Media-understanding provider config.
 * @param attachment - Document attachment metadata.
 * @param buffer - Downloaded document bytes.
 * @returns Extracted-text interpretation, or deterministic fallback when unavailable.
 */
export async function interpretDocumentAttachment(
  _config: MediaUnderstandingConfig,
  attachment: ConversationInboundMediaAttachment,
  buffer: Buffer | null
): Promise<ConversationInboundMediaInterpretation> {
  if (!buffer) {
    return buildFallbackMediaInterpretation(attachment);
  }

  try {
    const extractedText = await extractDocumentText(attachment, buffer);
    if (!extractedText) {
      return buildFallbackMediaInterpretation(attachment);
    }

    const boundedText = buildBoundedTextExcerpt(extractedText);
    const summary = buildDeterministicDocumentSummary(extractedText, attachment);
    const entityHints = collectEntityHintsFromTexts([
      attachment.fileName,
      boundedText
    ]);

    return {
      summary,
      transcript: null,
      ocrText: boundedText,
      confidence: 0.72,
      provenance: "deterministic document text extraction",
      source: "document_text_extraction",
      entityHints
    };
  } catch {
    return buildFallbackMediaInterpretation(attachment);
  }
}

/**
 * Extracts document text.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ConversationInboundMediaAttachment` (import `ConversationInboundMediaAttachment`) from `../../interfaces/mediaRuntime/contracts`.
 * @param attachment - Input consumed by this helper.
 * @param buffer - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
async function extractDocumentText(
  attachment: ConversationInboundMediaAttachment,
  buffer: Buffer
): Promise<string | null> {
  const mimeType = (attachment.mimeType ?? "").trim().toLowerCase();
  const fileName = (attachment.fileName ?? "").trim().toLowerCase();
  if (mimeType === "text/plain" || fileName.endsWith(".txt") || fileName.endsWith(".md")) {
    return buffer.toString("utf8").trim() || null;
  }
  if (mimeType === "application/pdf" || fileName.endsWith(".pdf")) {
    return extractPdfText(buffer);
  }
  return null;
}

/**
 * Extracts pdf text.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param buffer - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
async function extractPdfText(buffer: Buffer): Promise<string | null> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true
  });
  const document = await loadingTask.promise;
  const pageTexts: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
      .join(" ");
    const normalizedPageText = pageText.replace(/\s+/g, " ").trim();
    if (normalizedPageText) {
      pageTexts.push(normalizedPageText);
    }
  }
  const text = pageTexts.join("\n\n").trim();
  return text || null;
}

/**
 * Builds deterministic document summary.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ConversationInboundMediaAttachment` (import `ConversationInboundMediaAttachment`) from `../../interfaces/mediaRuntime/contracts`.
 * - Uses `collectEntityHintsFromTexts` (import `collectEntityHintsFromTexts`) from `./interpretationSupport`.
 * @param extractedText - Input consumed by this helper.
 * @param attachment - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function buildDeterministicDocumentSummary(
  extractedText: string,
  attachment: ConversationInboundMediaAttachment
): string {
  const normalizedText = extractedText.replace(/\s+/g, " ").trim();
  const fileName = attachment.fileName?.trim();

  const identifiers = [...new Set(normalizedText.match(IDENTIFIER_PATTERN) ?? [])].slice(0, 3);
  const entityHints = collectEntityHintsFromTexts([fileName, normalizedText]).slice(0, 4);
  const summaryParts: string[] = [];
  if (fileName) {
    summaryParts.push(`The document ${fileName} contains readable extracted text`);
  } else {
    summaryParts.push("The document contains readable extracted text");
  }
  if (entityHints.length > 0) {
    summaryParts.push(`with references to ${entityHints.join(", ")}`);
  }
  if (identifiers.length > 0) {
    summaryParts.push(`and identifiers such as ${identifiers.join(", ")}`);
  }
  return `${summaryParts.join(" ")}.`;
}
