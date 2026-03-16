/**
 * @fileoverview Owns bounded workspace-recovery context blocks used by conversation execution input assembly.
 */

import path from "node:path";

import { normalizeWhitespace } from "../conversationManagerHelpers";
import type { ConversationSession } from "../sessionStore";
import type { ManagedProcessSnapshot } from "../../organs/liveRun/managedProcessRegistry";
import {
  renderAttributableRootReason,
  selectAttributableWorkspaceRoots,
  type AttributableWorkspaceRootCandidate
} from "./workspaceRecoveryRoots";

const NATURAL_LOCAL_ORGANIZATION_VERB_PATTERN =
  /\b(?:organize|move|group|gather|sort|clean up|put)\b/i;
const NATURAL_LOCAL_ORGANIZATION_TARGET_PATTERN =
  /\b(?:folder|folders|directory|directories|desktop|documents|downloads|workspace|workspaces|project|projects)\b/i;
const ORGANIZATION_MATCH_TOKEN_PATTERN = /[a-z0-9][a-z0-9-]{2,}/gi;
const ORGANIZATION_MATCH_STOP_WORDS = new Set([
  "organize",
  "folder",
  "folders",
  "directory",
  "directories",
  "project",
  "projects",
  "workspace",
  "workspaces",
  "desktop",
  "documents",
  "downloads",
  "earlier",
  "into",
  "called",
  "made",
  "the",
  "you"
]);

/**
 * Detects whether the current request is asking to reorganize local folders or project workspaces.
 *
 * @param userInput - Raw current user wording.
 * @returns `true` when the request looks like local workspace organization.
 */
function isLikelyLocalWorkspaceOrganizationRequest(userInput: string): boolean {
  const normalizedInput = normalizeWhitespace(userInput);
  if (!normalizedInput) {
    return false;
  }
  return (
    NATURAL_LOCAL_ORGANIZATION_VERB_PATTERN.test(normalizedInput) &&
    NATURAL_LOCAL_ORGANIZATION_TARGET_PATTERN.test(normalizedInput)
  );
}

/**
 * Extracts stable lowercase folder-match tokens from the current organization request.
 *
 * @param userInput - Raw current user wording.
 * @returns Deduplicated match tokens with low-signal stop words removed.
 */
function extractOrganizationMatchTokens(userInput: string): readonly string[] {
  const matches = userInput.toLowerCase().match(ORGANIZATION_MATCH_TOKEN_PATTERN) ?? [];
  return [...new Set(
    matches.filter((token) => !ORGANIZATION_MATCH_STOP_WORDS.has(token))
  )];
}

/**
 * Deduplicates non-empty strings while preserving first-seen order.
 *
 * @param values - Candidate values that may include duplicates or empties.
 * @returns Unique non-empty strings.
 */
function uniqueNonEmpty(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * Selects managed-process snapshots that map to remembered attributable workspace roots.
 *
 * @param roots - Attributable workspace roots remembered in this chat.
 * @param managedProcessSnapshots - Runtime-owned managed-process snapshots.
 * @returns Bounded matching managed-process snapshots.
 */
function selectSnapshotsForAttributableRoots(
  roots: readonly AttributableWorkspaceRootCandidate[],
  managedProcessSnapshots: readonly ManagedProcessSnapshot[] | undefined
): readonly ManagedProcessSnapshot[] {
  if (!managedProcessSnapshots || managedProcessSnapshots.length === 0 || roots.length === 0) {
    return [];
  }
  const rootSet = new Set(roots.map((entry) => entry.rootPath.toLowerCase()));
  return managedProcessSnapshots
    .filter((snapshot) => snapshot.cwd.trim().length > 0)
    .filter((snapshot) => rootSet.has(snapshot.cwd.toLowerCase()))
    .sort((left, right) => left.cwd.localeCompare(right.cwd))
    .slice(0, 6);
}

/**
 * Selects exact tracked managed-process snapshots for the lease ids already tied to this workspace.
 *
 * @param leaseIds - Exact tracked preview-process lease ids from workspace state.
 * @param managedProcessSnapshots - Runtime-owned managed-process snapshots.
 * @returns Matching managed snapshots for those exact lease ids.
 */
function selectTrackedRecoverySnapshots(
  leaseIds: readonly string[],
  managedProcessSnapshots: readonly ManagedProcessSnapshot[] | undefined
): readonly ManagedProcessSnapshot[] {
  if (!managedProcessSnapshots || managedProcessSnapshots.length === 0 || leaseIds.length === 0) {
    return [];
  }
  return managedProcessSnapshots.filter((snapshot) => leaseIds.includes(snapshot.leaseId));
}

/**
 * Selects fallback managed-process candidates by matching organization tokens against process roots.
 *
 * @param userInput - Raw current user wording.
 * @param managedProcessSnapshots - Runtime-owned managed-process snapshots.
 * @returns Bounded matching snapshots used only as inspection hints.
 */
function selectFallbackMatchingSnapshots(
  userInput: string,
  managedProcessSnapshots: readonly ManagedProcessSnapshot[] | undefined
): readonly ManagedProcessSnapshot[] {
  if (!managedProcessSnapshots || managedProcessSnapshots.length === 0) {
    return [];
  }
  const matchTokens = extractOrganizationMatchTokens(userInput);
  if (matchTokens.length === 0) {
    return [];
  }
  return managedProcessSnapshots
    .filter((snapshot) => snapshot.statusCode !== "PROCESS_STOPPED")
    .filter((snapshot) => snapshot.cwd.trim().length > 0)
    .filter((snapshot) => {
      const cwdLower = snapshot.cwd.toLowerCase();
      const basename = path.basename(snapshot.cwd).toLowerCase();
      return matchTokens.some(
        (token) =>
          cwdLower.includes(token) ||
          basename.includes(token) ||
          token.includes(basename)
      );
    })
    .sort((left, right) => left.cwd.localeCompare(right.cwd))
    .slice(0, 6);
}

/**
 * Builds the bounded workspace-recovery context block for local organization requests.
 *
 * @param session - Current conversation session.
 * @param userInput - Current raw user wording.
 * @param managedProcessSnapshots - Runtime-owned process snapshots available to this interface.
 * @returns Workspace-recovery guidance block, or `null` when the turn does not look like local organization.
 */
export function buildWorkspaceRecoveryContextBlock(
  session: ConversationSession,
  userInput: string,
  managedProcessSnapshots: readonly ManagedProcessSnapshot[] | undefined
): string | null {
  if (!isLikelyLocalWorkspaceOrganizationRequest(userInput)) {
    return null;
  }

  const activeWorkspace = session.activeWorkspace;
  const attributableRoots = selectAttributableWorkspaceRoots(
    session,
    extractOrganizationMatchTokens(userInput)
  );
  const attributableSnapshots = selectSnapshotsForAttributableRoots(
    attributableRoots,
    managedProcessSnapshots
  );
  const exactTrackedLeaseIds = uniqueNonEmpty([
    activeWorkspace?.previewProcessLeaseId ?? null,
    ...(activeWorkspace?.previewProcessLeaseIds ?? []),
    ...session.browserSessions
      .filter((browserSession) =>
        activeWorkspace?.browserSessionIds.includes(browserSession.id) ||
        browserSession.id === activeWorkspace?.browserSessionId
      )
      .map((browserSession) => browserSession.linkedProcessLeaseId)
  ]);
  const exactTrackedBrowserSessionIds = uniqueNonEmpty([
    activeWorkspace?.browserSessionId ?? null,
    ...(activeWorkspace?.browserSessionIds ?? [])
  ]);
  const trackedSnapshots = selectTrackedRecoverySnapshots(
    exactTrackedLeaseIds,
    managedProcessSnapshots
  );
  const liveTrackedSnapshots = trackedSnapshots.filter(
    (snapshot) => snapshot.statusCode !== "PROCESS_STOPPED"
  );
  const rememberedTrackedSnapshots = trackedSnapshots.filter(
    (snapshot) => snapshot.statusCode === "PROCESS_STOPPED"
  );
  const shouldTreatLeaseIdsAsExactTracked =
    activeWorkspace?.stillControllable === true &&
    (liveTrackedSnapshots.length > 0 || managedProcessSnapshots === undefined);

  if (activeWorkspace?.rootPath || exactTrackedLeaseIds.length > 0 || exactTrackedBrowserSessionIds.length > 0) {
    const lines = [
      "Workspace recovery context for this chat:",
      `- Preferred workspace root: ${activeWorkspace?.rootPath ?? "unknown"}`,
      `- Ownership state: ${activeWorkspace?.ownershipState ?? "unknown"}`,
      `- Still controllable: ${activeWorkspace?.stillControllable ? "yes" : "no"}`
    ];
    if (activeWorkspace?.previewUrl) {
      lines.push(`- Preferred preview URL: ${activeWorkspace.previewUrl}`);
    }
    if (exactTrackedBrowserSessionIds.length > 0) {
      lines.push(`- Exact tracked browser session ids: ${exactTrackedBrowserSessionIds.join(", ")}`);
    }
    if (exactTrackedLeaseIds.length > 0) {
      lines.push(
        shouldTreatLeaseIdsAsExactTracked
          ? `- Exact tracked preview lease ids: ${exactTrackedLeaseIds.join(", ")}`
          : `- Remembered preview lease ids from earlier assistant work: ${exactTrackedLeaseIds.join(", ")}`
      );
    }
    if (attributableRoots.length > 1 || (attributableRoots.length === 1 && !activeWorkspace?.rootPath)) {
      lines.push("- Attributable workspace roots already remembered in this chat:");
      for (const candidate of attributableRoots) {
        lines.push(
          `- root=${candidate.rootPath}; reason=${renderAttributableRootReason(candidate.reason)}`
        );
      }
    }
    if (liveTrackedSnapshots.length > 0) {
      lines.push("- Exact tracked preview lease status:");
      for (const snapshot of liveTrackedSnapshots) {
        lines.push(
          `- leaseId=${snapshot.leaseId}; cwd=${snapshot.cwd}; status=${snapshot.statusCode}; stopRequested=${snapshot.stopRequested ? "yes" : "no"}`
        );
      }
    }
    if (rememberedTrackedSnapshots.length > 0) {
      lines.push("- Remembered preview lease status from earlier assistant work:");
      for (const snapshot of rememberedTrackedSnapshots) {
        lines.push(
          `- leaseId=${snapshot.leaseId}; cwd=${snapshot.cwd}; status=${snapshot.statusCode}; stopRequested=${snapshot.stopRequested ? "yes" : "no"}`
        );
      }
    }
    const attributableNonExactSnapshots = attributableSnapshots.filter(
      (snapshot) => !exactTrackedLeaseIds.includes(snapshot.leaseId)
    );
    if (attributableNonExactSnapshots.length > 0) {
      lines.push("- Attributable remembered preview lease status:");
      for (const snapshot of attributableNonExactSnapshots) {
        lines.push(
          `- leaseId=${snapshot.leaseId}; cwd=${snapshot.cwd}; status=${snapshot.statusCode}; stopRequested=${snapshot.stopRequested ? "yes" : "no"}`
        );
      }
    }
    lines.push(
      "- Safe recovery order: inspect_workspace_resources first with the preferred workspace root and any exact known previewUrl, browserSessionId, or previewProcessLeaseId values from this context."
    );
    if (shouldTreatLeaseIdsAsExactTracked && exactTrackedLeaseIds.length > 0) {
      lines.push(
        "- If inspection proves the move is blocked by these same exact tracked preview leases, stop only those exact lease ids with stop_process, verify they stopped, then retry the move. Do not stop unrelated apps by name."
      );
    } else {
      lines.push(
        "- If no exact tracked holder is proven, inspect first and then clarify before touching untracked local processes."
      );
      if (attributableRoots.length > 0) {
        lines.push(
          "- If the user is referring to older assistant work, inspect these remembered roots and remembered lease ids directly before falling back to looser token-matched process hints."
        );
      }
    }
    return lines.join("\n");
  }

  const matchingSnapshots = selectFallbackMatchingSnapshots(userInput, managedProcessSnapshots);
  if (matchingSnapshots.length === 0 && attributableRoots.length === 0) {
    return null;
  }

  const lines = [
    "Workspace recovery context for this chat:",
    "- No exact tracked workspace holder is currently known for this request.",
    ...(attributableRoots.length > 0
      ? [
          "- Attributable workspace roots already remembered in this chat:",
          ...attributableRoots.map(
            (candidate) =>
              `- root=${candidate.rootPath}; reason=${renderAttributableRootReason(candidate.reason)}`
          )
        ]
      : []),
    ...attributableSnapshots.map(
      (snapshot) =>
        `- Attributable remembered preview lease: leaseId=${snapshot.leaseId}; cwd=${snapshot.cwd}; status=${snapshot.statusCode}; stopRequested=${snapshot.stopRequested ? "yes" : "no"}`
    ),
    ...matchingSnapshots.map(
      (snapshot) =>
        `- Candidate runtime-managed preview lease: leaseId=${snapshot.leaseId}; cwd=${snapshot.cwd}; status=${snapshot.statusCode}; stopRequested=${snapshot.stopRequested ? "yes" : "no"}`
    ),
    attributableRoots.length > 0
      ? "- Safe recovery order: inspect_path_holders or inspect_workspace_resources against these exact remembered roots first, then fall back to looser candidate process hints only if those exact roots still do not explain the blocker."
      : "- Use these only as inspection hints. Prefer inspect_workspace_resources or inspect_path_holders before any shutdown, and do not stop unrelated processes.",
    "- Use these only as inspection hints. Prefer inspect_workspace_resources or inspect_path_holders before any shutdown, and do not stop unrelated processes.",
    "- Do not stop those candidate preview leases directly from this hint block alone. If inspection still leaves only likely holders, ask for confirmation before shutdown."
  ];
  if (attributableRoots.length > 0) {
    lines.splice(lines.length - 2, 1);
  }
  return lines.join("\n");
}
