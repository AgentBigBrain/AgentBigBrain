/**
 * @fileoverview Deterministic Stage 6.86 UX rendering helpers for checkpoint 6.86.H thread-context strip and pulse summary formatting.
 */

import { ConversationStackV1, PulseCandidateV1, PulseDecisionV1 } from "../core/types";

const DEFAULT_MAX_PREVIEW_CHARS = 140;
const MIN_PREVIEW_CHARS = 40;
const MAX_PREVIEW_CHARS = 280;

export interface ThreadContextStripV1 {
  activeThreadKey: string | null;
  activeThreadLabel: string | null;
  pausedThreadCount: number;
  openLoopCount: number;
  summaryText: string;
}

export interface RenderPulseSummaryInputV1 {
  candidate: PulseCandidateV1;
  updatePreview: string;
  maxPreviewChars?: number;
}

/**
 * Normalizes whitespace into a stable shape for `stage6_86UxRendering` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for whitespace so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Normalizes preview limit into a stable shape for `stage6_86UxRendering` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for preview limit so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed numeric value.
 */
function normalizePreviewLimit(value: number | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return DEFAULT_MAX_PREVIEW_CHARS;
  }
  const parsed = Math.floor(value as number);
  return Math.max(MIN_PREVIEW_CHARS, Math.min(MAX_PREVIEW_CHARS, parsed));
}

/**
 * Implements truncate preview behavior used by `stage6_86UxRendering`.
 *
 * **Why it exists:**
 * Keeps `truncate preview` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param maxChars - Numeric bound, counter, or index used by this logic.
 * @returns Resulting string value.
 */
function truncatePreview(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const slice = normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd();
  return `${slice}...`;
}

/**
 * Builds thread context strip v1 for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of thread context strip v1 consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ConversationStackV1` (import `ConversationStackV1`) from `../core/types`.
 *
 * @param stack - Value for stack.
 * @returns Computed `ThreadContextStripV1` result.
 */
export function buildThreadContextStripV1(stack: ConversationStackV1): ThreadContextStripV1 {
  const activeThread = stack.activeThreadKey
    ? stack.threads.find((thread) => thread.threadKey === stack.activeThreadKey) ?? null
    : null;
  const pausedThreadCount = stack.threads.filter((thread) => thread.state === "paused").length;
  const openLoopCount = stack.threads.reduce((total, thread) => {
    return total + thread.openLoops.filter((loop) => loop.status === "open").length;
  }, 0);
  const activeThreadLabel = activeThread?.topicLabel ?? null;
  const activeLabelText = activeThreadLabel ?? "none";

  return {
    activeThreadKey: activeThread?.threadKey ?? null,
    activeThreadLabel,
    pausedThreadCount,
    openLoopCount,
    summaryText: `Thread context: active=${activeLabelText}; paused=${pausedThreadCount}; open_loops=${openLoopCount}`
  };
}

/**
 * Transforms pulse summary v1 into a stable output representation.
 *
 * **Why it exists:**
 * Defines public behavior from `stage6_86UxRendering.ts` for other modules/tests.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Resulting string value.
 */
export function renderPulseSummaryV1(input: RenderPulseSummaryInputV1): string {
  const maxPreviewChars = normalizePreviewLimit(input.maxPreviewChars);
  const preview = truncatePreview(input.updatePreview, maxPreviewChars);
  return [
    "Continuity pulse:",
    `- reasonCode: ${input.candidate.reasonCode}`,
    `- preview: ${preview}`
  ].join("\n");
}

/**
 * Evaluates render pulse decision v1 and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the render pulse decision v1 policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `PulseDecisionV1` (import `PulseDecisionV1`) from `../core/types`.
 *
 * @param decision - Value for decision.
 * @returns `true` when this check passes.
 */
export function shouldRenderPulseDecisionV1(decision: PulseDecisionV1): boolean {
  return decision.decisionCode === "EMIT";
}
