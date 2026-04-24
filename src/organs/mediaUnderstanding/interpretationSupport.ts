/**
 * @fileoverview Shared parsing and low-signal filtering helpers for bounded media interpretation.
 */

const LOW_SIGNAL_MEDIA_ENTITY_HINTS = new Set([
  "a",
  "an",
  "and",
  "attached",
  "caption",
  "describe",
  "do",
  "document",
  "file",
  "help",
  "if",
  "image",
  "include",
  "it",
  "keep",
  "ocr",
  "pdf",
  "please",
  "reply",
  "review",
  "show",
  "summary",
  "tell",
  "text",
  "the",
  "this",
  "visible",
  "what"
]);

const JSON_CODE_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;
const IDENTIFIER_PATTERN = /\b\d{6,}\b/g;
const UPPERCASE_PHRASE_PATTERN = /\b[A-Z][A-Z0-9&.,'/-]*(?:\s+[A-Z][A-Z0-9&.,'/-]*){0,5}\b/g;
const TITLE_CASE_PHRASE_PATTERN = /\b[A-Z][a-z0-9&.,'/-]*(?:\s+[A-Z][a-z0-9&.,'/-]*){0,4}\b/g;

export interface ParsedStructuredMediaOutput {
  summary: string;
  ocrText: string | null;
  entityHints: readonly string[];
}

/**
 * Extracts one structured interpretation object from provider text when present.
 *
 * @param rawText - Provider output text.
 * @returns Parsed structured interpretation, or `null` when the text is not JSON-shaped.
 */
export function parseStructuredMediaOutput(
  rawText: string
): ParsedStructuredMediaOutput | null {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }

  const candidate = resolveJsonCandidate(trimmed);
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      const ocrTextRaw = typeof parsed.ocr_text === "string"
        ? parsed.ocr_text
        : typeof parsed.ocrText === "string"
          ? parsed.ocrText
          : null;
      const rawEntityHints = Array.isArray(parsed.entity_hints)
        ? parsed.entity_hints
        : Array.isArray(parsed.entityHints)
          ? parsed.entityHints
          : [];
      const entityHints = sanitizeEntityHints(
        rawEntityHints.map((value) => String(value))
      );
      if (summary) {
        return {
          summary,
          ocrText: ocrTextRaw?.trim() || null,
          entityHints
        };
      }
    } catch {
      // Fall through to line-based parsing below.
    }
  }
  return parseStructuredMediaOutputLines(trimmed);
}

/**
 * Builds bounded entity hints from free text using conservative phrase extraction.
 *
 * @param texts - Free-text sources such as OCR, extracted PDF text, or model summaries.
 * @param maxCount - Maximum number of hints to retain.
 * @returns Stable filtered entity-hint list.
 */
export function collectEntityHintsFromTexts(
  texts: readonly (string | null | undefined)[],
  maxCount = 6
): readonly string[] {
  const candidates: string[] = [];
  for (const text of texts) {
    if (!text) {
      continue;
    }
    const normalizedText = text.replace(/\s+/g, " ").trim();
    if (!normalizedText) {
      continue;
    }
    for (const match of normalizedText.match(UPPERCASE_PHRASE_PATTERN) ?? []) {
      candidates.push(match);
    }
    for (const match of normalizedText.match(TITLE_CASE_PHRASE_PATTERN) ?? []) {
      candidates.push(match);
    }
    for (const match of normalizedText.match(IDENTIFIER_PATTERN) ?? []) {
      candidates.push(match);
    }
  }
  return sanitizeEntityHints(candidates).slice(0, maxCount);
}

/**
 * Returns a bounded excerpt suitable for persisted OCR or extracted-text display.
 *
 * @param text - Raw OCR or extracted document text.
 * @param maxLength - Maximum number of characters to keep.
 * @returns Normalized bounded excerpt.
 */
export function buildBoundedTextExcerpt(text: string, maxLength = 4_000): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

/**
 * Sanitizes raw entity-hint candidates into a bounded, low-noise list.
 *
 * @param candidates - Raw hint candidates from captions, OCR, or provider output.
 * @returns Filtered unique entity hints.
 */
export function sanitizeEntityHints(candidates: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeHint(candidate);
    if (!normalized) {
      continue;
    }
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    sanitized.push(normalized);
  }
  return sanitized;
}

/**
 * Resolves json candidate.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param rawText - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function resolveJsonCandidate(rawText: string): string | null {
  const codeBlockMatch = rawText.match(JSON_CODE_BLOCK_PATTERN);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }
  if (rawText.startsWith("{") && rawText.endsWith("}")) {
    return rawText;
  }
  const firstBraceIndex = rawText.indexOf("{");
  const lastBraceIndex = rawText.lastIndexOf("}");
  if (firstBraceIndex >= 0 && lastBraceIndex > firstBraceIndex) {
    return rawText.slice(firstBraceIndex, lastBraceIndex + 1).trim();
  }
  return null;
}

/**
 * Normalizes hint.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function normalizeHint(value: string): string | null {
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.]+$/g, "")
    .trim();
  if (!normalized) {
    return null;
  }
  if (/^\d{1,5}$/.test(normalized)) {
    return null;
  }
  if (/\.(pdf|png|jpg|jpeg|webp)$/i.test(normalized)) {
    return null;
  }
  if (normalized.length <= 1) {
    return null;
  }
  const lowercase = normalized.toLowerCase();
  if (LOW_SIGNAL_MEDIA_ENTITY_HINTS.has(lowercase)) {
    return null;
  }
  const tokens = lowercase.split(/\s+/);
  if (tokens.every((token) => LOW_SIGNAL_MEDIA_ENTITY_HINTS.has(token))) {
    return null;
  }
  if (lowercase.startsWith("i hereby swear")) {
    return null;
  }
  if (lowercase === "certificate" || lowercase === "trade name" || lowercase === "state agency") {
    return null;
  }
  if (/^[a-z]+$/.test(normalized) && normalized.length <= 3) {
    return null;
  }
  return normalized;
}

/**
 * Parses structured media output lines.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param rawText - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function parseStructuredMediaOutputLines(
  rawText: string
): ParsedStructuredMediaOutput | null {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  const values = new Map<string, string>();
  for (const line of lines) {
    const match = line.match(/^(summary|ocr_text|entity_hints)\s*[:=-]?\s*(.+)$/i);
    if (!match) {
      continue;
    }
    values.set(match[1].toLowerCase(), match[2].trim());
  }
  const summary = values.get("summary") ?? "";
  if (!summary) {
    return null;
  }
  const rawEntityHints = values.get("entity_hints")
    ?.split(/[|,;]+/)
    .map((hint) => hint.trim())
    .filter((hint) => hint.length > 0) ?? [];
  return {
    summary,
    ocrText: values.get("ocr_text") ?? null,
    entityHints: sanitizeEntityHints(rawEntityHints)
  };
}
