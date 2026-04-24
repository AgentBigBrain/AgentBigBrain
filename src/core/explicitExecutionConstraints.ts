/**
 * @fileoverview Parses bounded user-authored execution restrictions that must survive planner and
 * task-runner layers without turning into a broad lexical permission system.
 */

import { extractActiveRequestSegment } from "./currentRequestExtraction";
import type { ConstraintViolation, PlannedAction } from "./types";

const NEGATED_EXECUTION_PREFIX_PATTERN = /\b(?:do\s+not|don't|dont|without)\b/i;
const SEGMENT_TERMINATOR_PATTERN = /[.!?;\n]/;
const GENERIC_TARGET_PATTERN = /\b(?:anything|it|that|them|the project)\b/i;
const BROWSER_TARGET_PATTERN =
  /\b(?:browser|tab|window|preview|page|site|app|homepage|localhost)\b/i;
const PREVIEW_TARGET_PATTERN =
  /\b(?:preview|app|site|page|server|dev\s+server|localhost|project)\b/i;
const BROWSER_OPEN_VERB_PATTERN = /\b(?:open|opening|reopen|reopening|show)\b/i;
const PREVIEW_START_VERB_PATTERN =
  /\b(?:run|running|start|starting|launch|launching|serve|serving)\b/i;

export interface ExplicitExecutionConstraints {
  disallowVisibleBrowserOpen: boolean;
  disallowPreviewStart: boolean;
}

/**
 * Normalizes input.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function normalizeInput(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Extracts negated execution segments.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function extractNegatedExecutionSegments(
  value: string
): readonly string[] {
  const segments: string[] = [];
  let searchStart = 0;
  const normalizedValue = normalizeInput(value);
  while (searchStart < normalizedValue.length) {
    const remaining = normalizedValue.slice(searchStart);
    const prefixMatch = NEGATED_EXECUTION_PREFIX_PATTERN.exec(remaining);
    if (!prefixMatch || typeof prefixMatch.index !== "number") {
      break;
    }
    const segmentStart = searchStart + prefixMatch.index;
    const segmentTail = normalizedValue.slice(segmentStart);
    const terminatorMatch = SEGMENT_TERMINATOR_PATTERN.exec(segmentTail);
    const rawSegment =
      terminatorMatch && typeof terminatorMatch.index === "number"
        ? segmentTail.slice(0, terminatorMatch.index)
        : segmentTail;
    const boundedSegment = rawSegment.trim();
    if (boundedSegment.length > 0) {
      segments.push(boundedSegment);
    }
    searchStart =
      segmentStart + Math.max(rawSegment.length, prefixMatch[0].length);
  }
  return segments;
}

/**
 * Segments targets browser open.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param segment - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function segmentTargetsBrowserOpen(segment: string): boolean {
  return (
    BROWSER_OPEN_VERB_PATTERN.test(segment) &&
    (BROWSER_TARGET_PATTERN.test(segment) || GENERIC_TARGET_PATTERN.test(segment))
  );
}

/**
 * Segments targets preview start.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param segment - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function segmentTargetsPreviewStart(segment: string): boolean {
  return (
    PREVIEW_START_VERB_PATTERN.test(segment) &&
    (PREVIEW_TARGET_PATTERN.test(segment) || GENERIC_TARGET_PATTERN.test(segment))
  );
}

/**
 * Evaluates whether loopback host.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function isLoopbackHost(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

/**
 * Evaluates whether loopback url.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function isLoopbackUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Evaluates whether preview verification action.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `PlannedAction` (import `PlannedAction`) from `./types`.
 * @param action - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function isPreviewVerificationAction(action: PlannedAction): boolean {
  switch (action.type) {
    case "probe_port":
      return (
        isLoopbackHost(action.params.host) ||
        typeof action.params.host !== "string" ||
        action.params.host.trim().length === 0
      );
    case "probe_http":
    case "verify_browser":
      return isLoopbackUrl(action.params.url);
    default:
      return false;
  }
}

/**
 * Extracts explicit user-authored execution restrictions from one raw task/request input.
 *
 * This stays intentionally narrow. It only captures direct prohibitions like "do not run it" or
 * "do not open anything yet", which are explicit user constraints rather than fuzzy meaning.
 */
export function parseExplicitExecutionConstraints(
  userInput: string | null | undefined
): ExplicitExecutionConstraints {
  const normalized = normalizeInput(
    typeof userInput === "string" ? extractActiveRequestSegment(userInput) : userInput
  );
  if (!normalized) {
    return {
      disallowVisibleBrowserOpen: false,
      disallowPreviewStart: false
    };
  }

  const negatedSegments = extractNegatedExecutionSegments(normalized);
  return {
    disallowVisibleBrowserOpen: negatedSegments.some(segmentTargetsBrowserOpen),
    disallowPreviewStart: negatedSegments.some(segmentTargetsPreviewStart)
  };
}

/**
 * Builds a bounded execution-context block so planner/runtime layers keep explicit negative
 * user constraints in scope for the current run.
 */
export function buildExplicitExecutionConstraintContextBlock(
  userInput: string | null | undefined
): string | null {
  const constraints = parseExplicitExecutionConstraints(userInput);
  if (!constraints.disallowVisibleBrowserOpen && !constraints.disallowPreviewStart) {
    return null;
  }

  const lines = ["Explicit execution constraints for this run:"];
  if (constraints.disallowPreviewStart) {
    lines.push(
      "- The user explicitly said not to run, start, or launch the project yet."
    );
    lines.push(
      "- Do not start preview/dev servers or other long-running project runtime processes in this run."
    );
    lines.push(
      "- Do not probe or verify localhost preview URLs in this run because that would depend on starting the runtime the user deferred."
    );
  }
  if (constraints.disallowVisibleBrowserOpen) {
    lines.push(
      "- The user explicitly said not to open the project/browser yet."
    );
    lines.push(
      "- Do not open a browser window or page in this run unless a later user turn removes that restriction."
    );
  }
  return lines.join("\n");
}

/**
 * Converts explicit user-authored execution restrictions into deterministic action blocks during
 * task-runner preflight.
 */
export function evaluateExplicitExecutionConstraintViolation(
  action: PlannedAction,
  userInput: string | null | undefined
): ConstraintViolation | null {
  const constraints = parseExplicitExecutionConstraints(userInput);
  if (!constraints.disallowVisibleBrowserOpen && !constraints.disallowPreviewStart) {
    return null;
  }

  if (constraints.disallowVisibleBrowserOpen && action.type === "open_browser") {
    return {
      code: "EXPLICIT_BROWSER_OPEN_DISALLOWED",
      message:
        "User explicitly said not to open the project or browser yet, so open_browser is blocked for this run."
    };
  }

  if (constraints.disallowPreviewStart) {
    if (action.type === "start_process") {
      return {
        code: "EXPLICIT_PREVIEW_START_DISALLOWED",
        message:
          "User explicitly said not to run or launch the project yet, so preview/runtime start is blocked for this run."
      };
    }
    if (isPreviewVerificationAction(action)) {
      return {
        code: "EXPLICIT_PREVIEW_VERIFICATION_DISALLOWED",
        message:
          "User explicitly deferred running the project, so localhost preview verification is blocked for this run."
      };
    }
  }

  return null;
}
