/**
 * @fileoverview Prompt builders extracted from live-run recovery to keep autonomy modules thin.
 */

import type { LoopbackTargetHint } from "./liveRunRecovery";

/** Escapes a string for inclusion inside quoted browser-open recovery instructions. */
function escapeRecoveryQuotedString(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Formats one tracked loopback target into a single recovery-friendly label. */
function describeLoopbackTarget(target: LoopbackTargetHint | null): string | null {
  if (!target) {
    return null;
  }
  if (target.url) {
    return target.url;
  }
  if (target.host && target.port !== null) {
    return `${target.host}:${target.port}`;
  }
  return null;
}

/** Builds the bounded browser-open follow-up once readiness is already proven. */
export function buildManagedProcessBrowserOpenRetryInput(input: {
  target: LoopbackTargetHint | null;
  rootPath: string | null;
  previewProcessLeaseId: string | null;
}): string {
  const targetUrl = describeLoopbackTarget(input.target);
  const rootPathClause = input.rootPath
    ? ` rootPath="${escapeRecoveryQuotedString(input.rootPath)}"`
    : "";
  const previewLeaseClause = input.previewProcessLeaseId
    ? ` previewProcessLeaseId="${escapeRecoveryQuotedString(input.previewProcessLeaseId)}"`
    : "";
  return (
    `${targetUrl ? `open_browser url="${targetUrl}"${rootPathClause}${previewLeaseClause}. ` : "Open the tracked live preview in the browser. "}` +
    "Local readiness is already proven. " +
    "Open the exact live preview in a visible browser window and leave it open for review. " +
    "Do not substitute verify_browser for this step, and do not switch to a different workspace or URL."
  );
}
