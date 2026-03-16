/**
 * @fileoverview Owns attributable workspace-root selection and explanation for workspace recovery.
 */

import {
  basenameCrossPlatformPath,
  dirnameCrossPlatformPath,
  extnameCrossPlatformPath,
  normalizeCrossPlatformPath
} from "../../core/crossPlatformPath";
import type { ConversationSession } from "../sessionStore";

export interface AttributableWorkspaceRootCandidate {
  rootPath: string;
  reason:
    | "active_workspace"
    | "active_workspace_artifact"
    | "active_workspace_change"
    | "return_handoff_workspace"
    | "return_handoff_artifact"
    | "return_handoff_change"
    | "path_destination"
    | "browser_linked_process"
    | "browser_workspace"
    | "recent_action";
}

/**
 * Normalizes a candidate workspace path into a deterministic root-like path.
 *
 * @param candidatePath - Candidate file or folder path.
 * @returns Normalized workspace root path, or `null` when the input is empty.
 */
function normalizeWorkspaceRootPath(candidatePath: string | null | undefined): string | null {
  if (!candidatePath) {
    return null;
  }
  const normalized = normalizeCrossPlatformPath(candidatePath);
  if (!normalized) {
    return null;
  }
  return extnameCrossPlatformPath(normalized) ? dirnameCrossPlatformPath(normalized) : normalized;
}

/**
 * Selects attributable workspace roots already remembered in this chat.
 *
 * @param session - Current conversation session.
 * @param matchTokens - Stable organization match tokens extracted from the current request.
 * @returns Bounded attributable workspace root candidates.
 */
export function selectAttributableWorkspaceRoots(
  session: ConversationSession,
  matchTokens: readonly string[]
): readonly AttributableWorkspaceRootCandidate[] {
  const candidates: AttributableWorkspaceRootCandidate[] = [];
  const seen = new Set<string>();

  const pushCandidate = (
    rawPath: string | null | undefined,
    reason: AttributableWorkspaceRootCandidate["reason"]
  ): void => {
    const rootPath = normalizeWorkspaceRootPath(rawPath);
    if (!rootPath) {
      return;
    }
    const comparableRoot = rootPath.toLowerCase();
    const basename = basenameCrossPlatformPath(rootPath).toLowerCase();
    if (
      matchTokens.length > 0 &&
      !matchTokens.some(
        (token) =>
          comparableRoot.includes(token) ||
          basename.includes(token) ||
          token.includes(basename)
      )
    ) {
      return;
    }
    if (seen.has(comparableRoot)) {
      return;
    }
    seen.add(comparableRoot);
    candidates.push({
      rootPath,
      reason
    });
  };

  const pushCandidates = (
    rawPaths: readonly (string | null | undefined)[],
    reason: AttributableWorkspaceRootCandidate["reason"]
  ): void => {
    for (const rawPath of rawPaths) {
      pushCandidate(rawPath, reason);
    }
  };

  pushCandidate(session.activeWorkspace?.rootPath, "active_workspace");
  pushCandidate(session.activeWorkspace?.primaryArtifactPath, "active_workspace_artifact");
  pushCandidates(session.activeWorkspace?.lastChangedPaths ?? [], "active_workspace_change");
  pushCandidate(session.returnHandoff?.workspaceRootPath, "return_handoff_workspace");
  pushCandidate(session.returnHandoff?.primaryArtifactPath, "return_handoff_artifact");
  pushCandidates(session.returnHandoff?.changedPaths ?? [], "return_handoff_change");
  for (const destination of session.pathDestinations) {
    pushCandidate(destination.resolvedPath, "path_destination");
  }
  for (const browserSession of session.browserSessions) {
    pushCandidate(browserSession.linkedProcessCwd, "browser_linked_process");
    pushCandidate(browserSession.workspaceRootPath, "browser_workspace");
  }
  for (const action of session.recentActions) {
    if (action.kind !== "file" && action.kind !== "folder" && action.kind !== "process") {
      continue;
    }
    pushCandidate(action.location, "recent_action");
  }

  return candidates.slice(0, 6);
}

/**
 * Renders one short explanation for why a workspace root is attributable to this chat.
 *
 * @param reason - Candidate reason code.
 * @returns Human-readable explanation.
 */
export function renderAttributableRootReason(
  reason: AttributableWorkspaceRootCandidate["reason"]
): string {
  switch (reason) {
    case "active_workspace":
      return "current workspace memory";
    case "active_workspace_artifact":
      return "current workspace artifact";
    case "active_workspace_change":
      return "current workspace changed file";
    case "return_handoff_workspace":
      return "durable handoff workspace";
    case "return_handoff_artifact":
      return "durable handoff artifact";
    case "return_handoff_change":
      return "durable handoff changed file";
    case "path_destination":
      return "remembered destination";
    case "browser_linked_process":
      return "linked browser preview";
    case "browser_workspace":
      return "remembered browser workspace";
    case "recent_action":
      return "recent action location";
  }
}
