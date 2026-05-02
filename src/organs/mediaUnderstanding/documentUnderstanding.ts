/**
 * @fileoverview Deterministic document-understanding helpers for PDF and text attachments.
 */

import type {
  ConversationInboundMediaAttachment,
  ConversationInboundMediaInterpretation,
  ConversationInboundMediaInterpretationLayer
} from "../../interfaces/mediaRuntime/contracts";
import type { MediaUnderstandingConfig } from "./contracts";
import {
  describeMediaAuthorizationSource,
  resolveMediaAuthorizationHeaders
} from "./auth";
import { buildFallbackMediaInterpretation } from "./mediaModelFallback";
import {
  buildBoundedTextExcerpt,
  collectEntityHintsFromTexts,
  parseStructuredMediaOutput,
  sanitizeEntityHints
} from "./interpretationSupport";
import { buildMediaInterpretationLayer } from "./interpretationLayers";
import {
  extractOllamaChatOutputText,
  extractResponsesOutputText
} from "./providerSupport";

const DOCUMENT_MEANING_PROMPT = [
  "Return JSON only with keys summary and entity_hints.",
  "Summarize the attached extracted document text in one sentence.",
  "Do not include private identifiers, account numbers, registration numbers, or filing numbers.",
  "Use entity_hints only for high-level names needed to connect related notes.",
  "Do not add markdown fences."
].join(" ");
const MAX_PDF_TEXT_PAGES = 25;
const MAX_PDF_EXTRACTED_TEXT_CHARS = 4_000;

interface PdfTextPage {
  getTextContent(): Promise<{ readonly items: readonly unknown[] }>;
}

interface PdfTextDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfTextPage>;
  destroy(): Promise<void> | void;
}

/**
 * Attempts bounded interpretation for one document attachment.
 *
 * @param _config - Media-understanding provider config.
 * @param attachment - Document attachment metadata.
 * @param buffer - Downloaded document bytes.
 * @returns Extracted-text interpretation, or deterministic fallback when unavailable.
 */
export async function interpretDocumentAttachment(
  config: MediaUnderstandingConfig,
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
    const layers = [
      buildMediaInterpretationLayer({
        kind: "raw_text_extraction",
        source: "document_text_extraction",
        text: boundedText,
        confidence: 0.72,
        provenance: "deterministic document text extraction",
        memoryAuthority: "candidate_only"
      }),
      buildMediaInterpretationLayer({
        kind: "deterministic_metadata",
        source: "document_text_extraction",
        text: summary,
        confidence: 0.72,
        provenance: "deterministic document text extraction",
        memoryAuthority: "not_memory_authority"
      }),
      await maybeBuildDocumentMeaningLayer(config, attachment, boundedText)
    ].filter((layer): layer is ConversationInboundMediaInterpretationLayer => Boolean(layer));

    return {
      summary,
      transcript: null,
      ocrText: boundedText,
      confidence: 0.72,
      provenance: "deterministic document text extraction",
      source: "document_text_extraction",
      entityHints,
      layers
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
  let document: PdfTextDocument | null = null;
  try {
    document = await loadingTask.promise;
    let extractedText = "";
    const pageLimit = Math.min(document.numPages, MAX_PDF_TEXT_PAGES);
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => getPdfTextItemString(item))
        .join(" ");
      const normalizedPageText = pageText.replace(/\s+/g, " ").trim();
      if (!normalizedPageText) {
        continue;
      }
      const separator = extractedText ? "\n\n" : "";
      const remainingBudget =
        MAX_PDF_EXTRACTED_TEXT_CHARS - extractedText.length - separator.length;
      if (remainingBudget <= 0) {
        break;
      }
      const boundedPageText =
        normalizedPageText.length <= remainingBudget
          ? normalizedPageText
          : normalizedPageText.slice(0, remainingBudget).trimEnd();
      if (boundedPageText) {
        extractedText = `${extractedText}${separator}${boundedPageText}`;
      }
      if (extractedText.length >= MAX_PDF_EXTRACTED_TEXT_CHARS) {
        break;
      }
    }
    const text = extractedText.trim();
    return text || null;
  } finally {
    await destroyPdfTextDocument(document);
  }
}

/**
 * Extracts a text item string from a pdfjs text-content item.
 *
 * @param item - Unknown pdfjs text item.
 * @returns Text item string or an empty string.
 */
function getPdfTextItemString(item: unknown): string {
  return (
    typeof item === "object" &&
    item !== null &&
    "str" in item &&
    typeof (item as { readonly str?: unknown }).str === "string"
  )
    ? (item as { readonly str: string }).str
    : "";
}

/**
 * Releases pdfjs document resources after bounded extraction.
 *
 * @param document - Loaded pdfjs document, when available.
 */
async function destroyPdfTextDocument(document: PdfTextDocument | null): Promise<void> {
  if (!document) {
    return;
  }
  await Promise.resolve(document.destroy()).catch(() => undefined);
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

  const summaryParts: string[] = [];
  if (fileName) {
    summaryParts.push(`The document ${fileName} contains readable extracted text`);
  } else {
    summaryParts.push("The document contains readable extracted text");
  }
  if (normalizedText.length > 0) {
    summaryParts.push("that can be used as candidate supporting context");
  }
  return `${summaryParts.join(" ")}.`;
}

/**
 * Builds optional model-assisted document meaning when explicitly enabled.
 *
 * @param config - Media-understanding runtime config.
 * @param attachment - Document attachment metadata.
 * @param boundedText - Bounded extracted document text.
 * @returns Candidate-only model summary layer, or `null` when unavailable/disabled.
 */
async function maybeBuildDocumentMeaningLayer(
  config: MediaUnderstandingConfig,
  attachment: ConversationInboundMediaAttachment,
  boundedText: string
): Promise<ConversationInboundMediaInterpretationLayer | null> {
  const resolvedDocumentMeaningBackend = config.resolvedDocumentMeaningBackend ?? "disabled";
  if (resolvedDocumentMeaningBackend === "disabled") {
    return null;
  }
  const documentMeaningModel = config.documentMeaningModel ?? "gpt-4.1-mini";
  if (resolvedDocumentMeaningBackend === "mock") {
    return buildMediaInterpretationLayer({
      kind: "model_summary",
      source: "document_model_summary",
      text: "The document appears to contain structured business or administrative text.",
      confidence: 0.61,
      provenance: "mock document meaning model",
      memoryAuthority: "candidate_only"
    });
  }

  const authorizationHeaders = await resolveMediaAuthorizationHeaders(config, "document_meaning");
  if (!authorizationHeaders) {
    return null;
  }
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    config.documentMeaningTimeoutMs ?? config.requestTimeoutMs
  );
  try {
    const prompt = [
      DOCUMENT_MEANING_PROMPT,
      "",
      `File name: ${attachment.fileName ?? "unknown"}`,
      "Extracted document text:",
      boundedText
    ].join("\n");
    const response = resolvedDocumentMeaningBackend === "ollama"
      ? await fetchOllamaDocumentMeaning(config, prompt, authorizationHeaders, abortController.signal)
      : await fetchOpenAIDocumentMeaning(config, prompt, authorizationHeaders, abortController.signal);
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    const rawOutput = resolvedDocumentMeaningBackend === "ollama"
      ? extractOllamaChatOutputText(payload)
      : extractResponsesOutputText(payload);
    if (!rawOutput) {
      return null;
    }
    const structured = parseStructuredMediaOutput(rawOutput);
    const summary = structured?.summary ?? rawOutput;
    const entityHints = sanitizeEntityHints(structured?.entityHints ?? []);
    const text = entityHints.length > 0
      ? `${summary} Entity hints: ${entityHints.join(", ")}.`
      : summary;
    return buildMediaInterpretationLayer({
      kind: "model_summary",
      source: "document_model_summary",
      text,
      confidence: 0.66,
      provenance: `${describeMediaAuthorizationSource(config, "document_meaning")} document meaning model ${documentMeaningModel}`,
      memoryAuthority: "candidate_only"
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Calls an OpenAI-compatible document meaning endpoint.
 *
 * @param config - Media-understanding runtime config.
 * @param prompt - Bounded model prompt.
 * @param authorizationHeaders - Provider auth headers.
 * @param signal - Request abort signal.
 * @returns Provider response.
 */
function fetchOpenAIDocumentMeaning(
  config: MediaUnderstandingConfig,
  prompt: string,
  authorizationHeaders: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  return fetch(`${config.openAIBaseUrl}/responses`, {
    method: "POST",
    headers: {
      ...authorizationHeaders,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.documentMeaningModel ?? "gpt-4.1-mini",
      input: prompt
    }),
    signal
  });
}

/**
 * Calls an Ollama document meaning endpoint.
 *
 * @param config - Media-understanding runtime config.
 * @param prompt - Bounded model prompt.
 * @param authorizationHeaders - Provider auth headers.
 * @param signal - Request abort signal.
 * @returns Provider response.
 */
function fetchOllamaDocumentMeaning(
  config: MediaUnderstandingConfig,
  prompt: string,
  authorizationHeaders: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  return fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: {
      ...authorizationHeaders,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.documentMeaningModel ?? "gpt-4.1-mini",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      stream: false
    }),
    signal
  });
}
