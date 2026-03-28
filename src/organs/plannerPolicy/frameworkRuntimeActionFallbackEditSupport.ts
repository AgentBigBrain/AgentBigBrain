/**
 * @fileoverview Bounded deterministic live-edit fallback actions for tracked framework pages.
 */

import { existsSync, readFileSync } from "node:fs";

import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import { makeId } from "../../core/ids";
import { PlannedAction } from "../../core/types";
import { resolveFrameworkLandingPageTargetPaths } from "./frameworkRuntimeActionFallbackWriteSupport";

type FrameworkFallbackKind = "vite_react" | "next_js";

interface FrameworkTrackedEditActionInput {
  readonly kind: FrameworkFallbackKind;
  readonly activeRequest: string;
  readonly finalFolderPath: string;
  readonly liveUrl: string;
  readonly trackedPreviewProcessLeaseId: string | null;
  readonly trackedBrowserSessionId: string | null;
  readonly requestedShellKind: "powershell" | "pwsh" | "bash" | "zsh" | "wsl_bash";
  readonly startCommand: string;
}

interface FrameworkTrackedSectionEditIntent {
  readonly sectionIndex: number;
  readonly heading: string | null;
  readonly body: string | null;
}

const TRACKED_BROWSER_SESSION_ID_PATTERN =
  /(?:^|\n)-\s+Browser session id:\s+(?!none\b)([^\r\n]+)\s*$/im;
const SECTION_ENTRY_PATTERN =
  /\{\s*title:\s*'((?:\\'|[^'])*)',\s*text:\s*'((?:\\'|[^'])*)'\s*\}/g;
const HEADING_REPLACEMENT_PATTERN =
  /\b(?:change|edit|update|tweak|replace|rewrite|make)\b[\s\S]{0,60}\b(?:section\s+heading|heading|title)\b[\s\S]{0,20}\bto\b\s*["“']([^"”']+)["”']/i;
const SECTION_BODY_REPLACEMENT_PATTERN =
  /\b(?:make|have|let|update|change)\s+that\s+section\s+(?:mention|say|include|read)\b[\s\S]{0,12}["“']([^"”']+)["”']/i;
const SECTION_ORDINAL_PATTERNS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bfirst\b|\b1st\b|\bsection\s+one\b|\bsection\s+1\b/i, 0],
  [/\bsecond\b|\b2nd\b|\bsection\s+two\b|\bsection\s+2\b/i, 1],
  [/\bthird\b|\b3rd\b|\bsection\s+three\b|\bsection\s+3\b/i, 2],
  [/\bfourth\b|\b4th\b|\bsection\s+four\b|\bsection\s+4\b/i, 3],
  [/\bfifth\b|\b5th\b|\bsection\s+five\b|\bsection\s+5\b/i, 4]
] as const;

/**
 * Escapes one single-quoted JavaScript literal fragment.
 *
 * @param value - Raw literal content.
 * @returns Escaped single-quoted JavaScript content.
 */
function escapeJavaScriptSingleQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Extracts the tracked browser session id from wrapped conversation execution input when present.
 *
 * @param requestContext - Planner request text, which may include wrapped conversation context.
 * @returns Tracked browser session id, or `null` when none is present.
 */
export function extractTrackedBrowserSessionId(requestContext: string): string | null {
  const rawBrowserSessionId =
    requestContext.match(TRACKED_BROWSER_SESSION_ID_PATTERN)?.[1]?.trim() ?? null;
  return rawBrowserSessionId && rawBrowserSessionId.length > 0 ? rawBrowserSessionId : null;
}

/**
 * Extracts one bounded live section-edit intent from the active request text.
 *
 * @param activeRequest - Active request segment.
 * @returns Parsed edit intent, or `null` when the turn is not a supported tracked edit.
 */
function extractTrackedSectionEditIntent(
  activeRequest: string
): FrameworkTrackedSectionEditIntent | null {
  const sectionIndex = SECTION_ORDINAL_PATTERNS.find(([pattern]) => pattern.test(activeRequest))?.[1];
  if (typeof sectionIndex !== "number") {
    return null;
  }
  const heading = activeRequest.match(HEADING_REPLACEMENT_PATTERN)?.[1]?.trim() ?? null;
  const body = activeRequest.match(SECTION_BODY_REPLACEMENT_PATTERN)?.[1]?.trim() ?? null;
  if (!heading && !body) {
    return null;
  }
  return {
    sectionIndex,
    heading,
    body
  };
}

/**
 * Applies one bounded section edit to the deterministic framework page source.
 *
 * @param sourceText - Existing page source text.
 * @param editIntent - Parsed section edit intent.
 * @returns Updated source text, or `null` when the file could not be patched safely.
 */
function applyTrackedSectionEdit(
  sourceText: string,
  editIntent: FrameworkTrackedSectionEditIntent
): string | null {
  const entries = [...sourceText.matchAll(SECTION_ENTRY_PATTERN)];
  if (entries.length === 0 || editIntent.sectionIndex >= entries.length) {
    return null;
  }
  const targetEntry = entries[editIntent.sectionIndex];
  if (!targetEntry || typeof targetEntry.index !== "number") {
    return null;
  }

  const nextTitle = editIntent.heading ?? targetEntry[1] ?? "";
  const nextBody = editIntent.body ?? targetEntry[2] ?? "";
  const replacement =
    `{ title: '${escapeJavaScriptSingleQuoted(nextTitle)}', ` +
    `text: '${escapeJavaScriptSingleQuoted(nextBody)}' }`;
  return (
    sourceText.slice(0, targetEntry.index) +
    replacement +
    sourceText.slice(targetEntry.index + targetEntry[0].length)
  );
}

/**
 * Builds a bounded deterministic action sequence for a tracked live framework-page edit.
 *
 * @param input - Tracked framework edit context.
 * @returns Ordered fallback actions, or an empty list when the edit cannot be synthesized safely.
 */
export function buildDeterministicFrameworkTrackedEditFallbackActions(
  input: FrameworkTrackedEditActionInput
): PlannedAction[] {
  const {
    kind,
    activeRequest,
    finalFolderPath,
    liveUrl,
    trackedPreviewProcessLeaseId,
    trackedBrowserSessionId,
    requestedShellKind,
    startCommand
  } = input;

  if (!trackedPreviewProcessLeaseId) {
    return [];
  }
  const editIntent = extractTrackedSectionEditIntent(activeRequest);
  if (!editIntent) {
    return [];
  }

  const targetPaths = resolveFrameworkLandingPageTargetPaths(kind, finalFolderPath);
  const primaryViewPath = targetPaths.primaryViewPath;
  if (!existsSync(primaryViewPath)) {
    return [];
  }

  let primaryViewContent: string;
  try {
    primaryViewContent = readFileSync(primaryViewPath, "utf8");
  } catch {
    return [];
  }
  const patchedPrimaryViewContent = applyTrackedSectionEdit(primaryViewContent, editIntent);
  if (!patchedPrimaryViewContent || patchedPrimaryViewContent === primaryViewContent) {
    return [];
  }

  const actions: PlannedAction[] = [
    {
      id: makeId("action"),
      type: "write_file",
      description: "Apply the requested section copy update to the tracked framework page.",
      params: {
        path: primaryViewPath,
        content: patchedPrimaryViewContent
      },
      estimatedCostUsd: estimateActionCostUsd({
        type: "write_file",
        params: {
          path: primaryViewPath,
          content: patchedPrimaryViewContent
        }
      })
    }
  ];

  if (targetPaths.primaryViewAliasPath) {
    actions.push({
      id: makeId("action"),
      type: "write_file",
      description:
        "Keep the alternate framework page route file aligned with the tracked live edit.",
      params: {
        path: targetPaths.primaryViewAliasPath,
        content: patchedPrimaryViewContent
      },
      estimatedCostUsd: estimateActionCostUsd({
        type: "write_file",
        params: {
          path: targetPaths.primaryViewAliasPath,
          content: patchedPrimaryViewContent
        }
      })
    });
  }

  if (kind === "next_js") {
    actions.push({
      id: makeId("action"),
      type: "probe_http",
      description:
        "Wait for the tracked Next.js live preview to stay ready after the in-place section edit.",
      params: { url: liveUrl, expectedStatus: 200, timeoutMs: 30_000 },
      estimatedCostUsd: estimateActionCostUsd({
        type: "probe_http",
        params: { url: liveUrl, expectedStatus: 200 }
      })
    });
  } else {
    actions.push(
      {
        id: makeId("action"),
        type: "shell_command",
        description: "Rebuild the tracked framework workspace after the live section edit.",
        params: {
          command: "npm run build",
          cwd: finalFolderPath,
          workdir: finalFolderPath,
          requestedShellKind,
          timeoutMs: 120_000
        },
        estimatedCostUsd: estimateActionCostUsd({
          type: "shell_command",
          params: { command: "npm run build", cwd: finalFolderPath }
        })
      },
      {
        id: makeId("action"),
        type: "stop_process",
        description:
          "Stop the exact tracked preview process so the edited framework build can restart cleanly.",
        params: {
          leaseId: trackedPreviewProcessLeaseId,
          preserveLinkedBrowserSessions: true
        },
        estimatedCostUsd: estimateActionCostUsd({
          type: "stop_process",
          params: {
            leaseId: trackedPreviewProcessLeaseId
          }
        })
      },
      {
        id: makeId("action"),
        type: "start_process",
        description: "Restart the tracked framework preview on the same loopback target.",
        params: {
          command: startCommand,
          cwd: finalFolderPath,
          workdir: finalFolderPath,
          requestedShellKind,
          timeoutMs: 120_000
        },
        estimatedCostUsd: estimateActionCostUsd({
          type: "start_process",
          params: { command: startCommand, cwd: finalFolderPath }
        })
      },
      {
        id: makeId("action"),
        type: "probe_http",
        description:
          "Wait for the restarted tracked framework preview to answer on its loopback URL.",
        params: { url: liveUrl, expectedStatus: 200, timeoutMs: 30_000 },
        estimatedCostUsd: estimateActionCostUsd({
          type: "probe_http",
          params: { url: liveUrl, expectedStatus: 200 }
        })
      }
    );
  }

  if (trackedBrowserSessionId) {
    actions.push({
      id: makeId("action"),
      type: "open_browser",
      description:
        "Reload the existing tracked browser page so the live framework edit is visible immediately.",
      params: {
        url: liveUrl,
        rootPath: finalFolderPath,
        timeoutMs: 30_000
      },
      estimatedCostUsd: estimateActionCostUsd({
        type: "open_browser",
        params: {
          url: liveUrl,
          rootPath: finalFolderPath
        }
      })
    });
  }

  return actions;
}
