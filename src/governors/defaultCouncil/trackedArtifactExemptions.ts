/**
 * @fileoverview Detects bounded tracked-artifact follow-up actions that should bypass generic model-advisory drift.
 */

import fs from "node:fs";

import { getParamString } from "./common";
import { DefaultGovernanceProposal } from "./contracts";

const CURRENT_USER_REQUEST_MARKER = "\nCurrent user request:";
const STATUS_SUFFIX_PATTERN =
  /\s+\((?:updated|created|completed|failed|running|open|closed)\)\s*$/i;
const TRACKED_ARTIFACT_FOLLOW_UP_MARKER = "Natural artifact-edit follow-up:";

/**
 * Trims the raw current-user request from execution input so only system-provided continuity context
 * contributes tracked-path authorizations.
 *
 * @param taskUserInput - Full execution input presented to governance.
 * @returns Continuity prefix without the raw current-user request.
 */
function getContinuityContextPrefix(taskUserInput: string): string {
  const markerIndex = taskUserInput.indexOf(CURRENT_USER_REQUEST_MARKER);
  return markerIndex >= 0 ? taskUserInput.slice(0, markerIndex) : taskUserInput;
}

/**
 * Normalizes a filesystem path for case-insensitive comparison across Windows and POSIX strings.
 *
 * @param candidatePath - Raw filesystem path candidate.
 * @returns Normalized comparison form.
 */
function normalizeFilesystemPath(candidatePath: string): string {
  return candidatePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
}

/**
 * Reads a local filesystem path from one continuity-context value when present.
 *
 * @param value - Raw value extracted from a continuity-context bullet line.
 * @returns Local filesystem path, or `null` for URLs and non-path metadata.
 */
function extractFilesystemPathCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed) || /^sessionid=/i.test(trimmed)) {
    return null;
  }
  if (/^[a-z]:\\/i.test(trimmed) || trimmed.startsWith("/")) {
    return trimmed.replace(STATUS_SUFFIX_PATTERN, "").trim();
  }
  return null;
}

/**
 * Reads tracked local filesystem paths from system-provided continuity blocks.
 *
 * @param taskUserInput - Full execution input presented to governance.
 * @returns Distinct remembered filesystem paths from the continuity prefix.
 */
function extractTrackedFilesystemPaths(taskUserInput: string): readonly string[] {
  const trackedPaths = new Set<string>();
  const contextPrefix = getContinuityContextPrefix(taskUserInput);

  for (const rawLine of contextPrefix.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) {
      continue;
    }

    let candidate: string | null = null;
    if (/^- Preferred edit destination:/i.test(line)) {
      candidate = extractFilesystemPathCandidate(
        line.replace(/^- Preferred edit destination:\s*/i, "")
      );
    } else if (/^- Most recent concrete artifact:/i.test(line) && /\s+at\s+/i.test(line)) {
      candidate = extractFilesystemPathCandidate(
        line.replace(/^.*\s+at\s+/i, "")
      );
    } else {
      const separatorIndex = line.indexOf(": ");
      if (separatorIndex >= 0) {
        candidate = extractFilesystemPathCandidate(line.slice(separatorIndex + 2));
      }
    }

    if (candidate) {
      trackedPaths.add(candidate);
    }
  }

  return [...trackedPaths];
}

/**
 * Evaluates whether a tracked path should authorize descendant file access.
 *
 * @param trackedPath - Context path authorizing a follow-up action.
 * @returns `true` when the tracked path behaves like a folder.
 */
function isDirectoryLikeTrackedPath(trackedPath: string): boolean {
  try {
    if (fs.existsSync(trackedPath)) {
      return fs.statSync(trackedPath).isDirectory();
    }
  } catch {
    // Fall back to lexical heuristics when filesystem metadata is unavailable.
  }

  return !/\.[a-z0-9_-]{1,12}$/i.test(trackedPath);
}

/**
 * Evaluates whether a proposal path stays within one tracked continuity path.
 *
 * @param proposalPath - Action path under governor review.
 * @param trackedPath - Tracked continuity path extracted from execution input.
 * @returns `true` when the proposal path is the same tracked file or a descendant of a tracked folder.
 */
function isAuthorizedTrackedPath(
  proposalPath: string,
  trackedPath: string
): boolean {
  const normalizedProposalPath = normalizeFilesystemPath(proposalPath);
  const normalizedTrackedPath = normalizeFilesystemPath(trackedPath);
  if (!normalizedProposalPath || !normalizedTrackedPath) {
    return false;
  }
  if (normalizedProposalPath === normalizedTrackedPath) {
    return true;
  }
  if (!isDirectoryLikeTrackedPath(trackedPath)) {
    return false;
  }
  return normalizedProposalPath.startsWith(`${normalizedTrackedPath}/`);
}

/**
 * Evaluates whether a proposal is a bounded tracked-artifact continuity read/write action.
 *
 * @param proposal - Proposal under governor review.
 * @param taskUserInput - Full execution input presented to governance.
 * @returns `true` when the proposal path is already tracked in the continuity context.
 */
export function isTrackedArtifactContinuityAction(
  proposal: DefaultGovernanceProposal,
  taskUserInput: string
): boolean {
  if (!taskUserInput.includes(TRACKED_ARTIFACT_FOLLOW_UP_MARKER)) {
    return false;
  }

  if (
    proposal.action.type !== "read_file" &&
    proposal.action.type !== "write_file" &&
    proposal.action.type !== "list_directory"
  ) {
    return false;
  }

  const targetPath = getParamString(proposal.action.params, "path");
  if (!targetPath) {
    return false;
  }

  const trackedPaths = extractTrackedFilesystemPaths(taskUserInput);
  return trackedPaths.some((trackedPath) => isAuthorizedTrackedPath(targetPath, trackedPath));
}
