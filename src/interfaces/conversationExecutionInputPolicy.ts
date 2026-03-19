/**
 * @fileoverview Builds conversation-aware execution payloads and follow-up envelopes for conversation manager flows.
 */

import type { ConversationSession } from "./sessionStore";
import type { ConversationIntentSemanticHint } from "./conversationRuntime/intentModeContracts";
import type { ConversationInboundMediaEnvelope } from "./mediaRuntime/contracts";
import { buildConversationMediaContextBlock } from "./conversationRuntime/mediaContextRendering";
import { buildPathDestinationContextBlock } from "./conversationRuntime/pathDestinationContext";
import { buildWorkspaceRecoveryContextBlock } from "./conversationRuntime/workspaceRecoveryContext";
import {
  buildRoutingExecutionHintV1,
  type RoutingMapClassificationV1
} from "./routingMap";
import { buildReuseIntentContextBlock } from "./conversationRuntime/reuseIntentContext";
import { buildReturnHandoffContinuationBlock } from "./conversationRuntime/returnHandoffContinuation";
import {
  classifyFollowUp,
  isLikelyAssistantClarificationPrompt,
  type FollowUpClassification,
  type FollowUpRuleContext,
  normalizeAssistantTurnText,
  normalizeWhitespace,
  renderTurnsForContext
} from "./conversationManagerHelpers";
import { buildContextualRecallBlock } from "./conversationRuntime/contextualRecall";
import type {
  QueryConversationContinuityEpisodes,
  QueryConversationContinuityFacts
} from "./conversationRuntime/managerContracts";
import type { ManagedProcessSnapshot } from "../organs/liveRun/managedProcessRegistry";
import type { BrowserSessionSnapshot } from "../organs/liveRun/browserSessionRegistry";
import {
  basenameCrossPlatformPath,
  dirnameCrossPlatformPath,
  normalizeCrossPlatformPath
} from "../core/crossPlatformPath";
import { reconcileConversationExecutionRuntimeSession } from "./conversationRuntime/executionInputRuntimeOwnership";

const FIRST_PERSON_STATUS_UPDATE_PATTERN =
  /\bmy\s+[a-z0-9][a-z0-9_.\-/\s]{0,120}\s+is\s+[a-z0-9][^.!?\n]{0,120}/i;
const STATUS_UPDATE_VALUE_MARKER_PATTERN =
  /\b(?:pending|open|stuck|unresolved|incomplete|complete|completed|done|resolved)\b/i;
const NATURAL_BROWSER_CLOSE_REFERENCE_PATTERN =
  /\b(?:close|shut|dismiss|hide)\b[\s\S]{0,50}\b(?:browser|tab|window|preview|page|landing page|homepage)\b/i;
const NATURAL_BROWSER_OPEN_REFERENCE_PATTERN =
  /\b(?:open|reopen|show|bring\s+(?:back|up)|pull\s+up)\b[\s\S]{0,50}\b(?:browser|tab|window|preview|page|landing page|homepage)\b/i;
const NATURAL_BROWSER_CLOSE_VERB_PATTERN = /\b(?:close|shut|dismiss|hide)\b/i;
const NATURAL_BROWSER_OPEN_VERB_PATTERN =
  /\b(?:reopen|show|bring\s+(?:back|up)|pull\s+up)\b/i;
const EXPLICIT_URL_REFERENCE_PATTERN =
  /\b(?:https?:\/\/|file:\/\/\/)[^\s<>"')\]]+/gi;
const NATURAL_ARTIFACT_EDIT_VERB_PATTERN =
  /\b(?:change|edit|update|replace|swap|revise|tweak|adjust|make)\b/i;
const NATURAL_ARTIFACT_EDIT_TARGET_PATTERN =
  /\b(?:hero|header|homepage|landing page|page|site|slider|cta|call to action|section|image|copy|headline|button)\b/i;
const NATURAL_ARTIFACT_EDIT_DELTA_PATTERN =
  /\b(?:instead of|from earlier|from before|we were working on|we built|you made)\b/i;
const NATURAL_NEW_BUILD_PATTERN =
  /\b(?:build|create|generate|scaffold|start)\b[\s\S]{0,20}\b(?:new|another|fresh)\b/i;
const STRONG_LOCAL_ORGANIZATION_VERB_PATTERN =
  /\b(?:organize|move|group|gather|sort|clean up|collect|tidy)\b/i;
const WEAK_LOCAL_ORGANIZATION_VERB_PATTERN = /\bput\b/i;
const LOCAL_ORGANIZATION_TARGET_PATTERN =
  /\b(?:folder|folders|directory|directories|workspace|workspaces|project|projects)\b/i;
const LOCAL_ORGANIZATION_COLLECTION_PATTERN =
  /\b(?:every|all)\s+(?:folder|folders|directory|directories|workspace|workspaces|project|projects)\b/i;
const SIMPLE_DESKTOP_DESTINATION_PATTERN =
  /\b(?:into|inside|under|to)\s+(?:a\s+folder\s+called\s+)?["'`]?([a-z0-9][a-z0-9_-]{0,80})["'`]?/i;
const ORGANIZATION_PREFIX_PATTERN =
  /\bstarts?\s+with\s+["'`]?([a-z0-9._-]{2,80})["'`]?/i;
const EXPLICIT_ALL_MATCHING_FOLDERS_PATTERN =
  /\b(?:all of them|every folder|all matching folders)\b/i;
const RECENT_ACTION_CONTEXT_PRIORITY: Readonly<Record<string, number>> = {
  file: 0,
  folder: 1,
  browser_session: 2,
  url: 3,
  process: 4,
  task_summary: 5
};
const GENERIC_WORKSPACE_SEGMENT_NAMES = new Set(["dist", "build", "out", "public", "site", "app"]);

/**
 * Extracts stable human-readable workspace or artifact names from tracked browser metadata.
 *
 * @param candidates - Mutable candidate-name set accumulated for one session.
 * @param rawValue - Raw path or URL-derived location text from tracked workspace/browser state.
 */
function pushTrackedBrowserReferenceCandidate(
  candidates: Set<string>,
  rawValue: string | null | undefined
): void {
  if (typeof rawValue !== "string") {
    return;
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return;
  }
  const normalizedPath = normalizeCrossPlatformPath(
    trimmed.replace(/^file:\/\/\/?/i, "").replace(/\?.*$/, "")
  );
  const basename = basenameCrossPlatformPath(normalizedPath);
  const parentBasename = basenameCrossPlatformPath(
    dirnameCrossPlatformPath(normalizedPath)
  );
  const addCandidate = (value: string | null | undefined): void => {
    if (typeof value !== "string") {
      return;
    }
    const candidate = value.trim();
    if (candidate.length >= 3) {
      candidates.add(candidate.toLowerCase());
    }
  };

  addCandidate(
    basename.replace(/\.[a-z0-9]{1,8}$/i, "")
  );
  if (
    basename &&
    GENERIC_WORKSPACE_SEGMENT_NAMES.has(basename.toLowerCase()) &&
    parentBasename
  ) {
    addCandidate(parentBasename);
  }
}

/**
 * Collects names that users may naturally use to refer to the currently tracked browser target.
 *
 * @param session - Current conversation session.
 * @returns Lowercased candidate names derived from tracked workspace and browser metadata.
 */
function collectTrackedBrowserReferenceCandidates(
  session: ConversationSession
): readonly string[] {
  const candidates = new Set<string>();
  pushTrackedBrowserReferenceCandidate(candidates, session.activeWorkspace?.rootPath);
  pushTrackedBrowserReferenceCandidate(
    candidates,
    session.activeWorkspace?.primaryArtifactPath
  );
  pushTrackedBrowserReferenceCandidate(candidates, session.activeWorkspace?.previewUrl);
  for (const browserSession of session.browserSessions) {
    pushTrackedBrowserReferenceCandidate(candidates, browserSession.workspaceRootPath);
    pushTrackedBrowserReferenceCandidate(candidates, browserSession.url);
  }
  return [...candidates];
}

/**
 * Evaluates whether the current user wording names the tracked browser target by workspace/app name.
 *
 * @param normalizedInput - Current user wording normalized for follow-up analysis.
 * @param session - Current conversation session.
 * @returns `true` when the wording references the tracked browser target by name.
 */
function inputMentionsTrackedBrowserTarget(
  normalizedInput: string,
  session: ConversationSession
): boolean {
  const normalizedLower = normalizedInput.toLowerCase();
  return collectTrackedBrowserReferenceCandidates(session).some((candidate) =>
    normalizedLower.includes(candidate)
  );
}

/**
 * Normalizes browser-target URLs so explicit user URLs can be compared against tracked session URLs.
 *
 * @param rawUrl - Raw URL text from the user or tracked runtime state.
 * @returns Comparable normalized URL, or `null` when the text is not a supported URL.
 */
function normalizeComparableBrowserUrl(rawUrl: string | null | undefined): string | null {
  if (typeof rawUrl !== "string") {
    return null;
  }
  const trimmed = rawUrl.trim().replace(/[),.;!?]+$/g, "");
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const normalizedPath =
        parsed.pathname && parsed.pathname !== "/"
          ? parsed.pathname.replace(/\/+$/g, "")
          : "/";
      return `${parsed.protocol}//${parsed.host.toLowerCase()}${normalizedPath}${parsed.search}`;
    }
    if (parsed.protocol === "file:") {
      return `${parsed.protocol}//${parsed.pathname}${parsed.search}`;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Extracts explicit browser-target URLs named directly in the current user request.
 *
 * @param normalizedInput - Current user wording normalized for follow-up analysis.
 * @returns Deduplicated normalized URL references.
 */
function extractExplicitBrowserUrlReferences(
  normalizedInput: string
): readonly string[] {
  const matches = normalizedInput.match(EXPLICIT_URL_REFERENCE_PATTERN) ?? [];
  const normalizedMatches = matches
    .map((match) => normalizeComparableBrowserUrl(match))
    .filter((match): match is string => typeof match === "string" && match.length > 0);
  return [...new Set(normalizedMatches)];
}

/**
 * Returns whether the user named an explicit URL that does not match any tracked browser target.
 *
 * @param normalizedInput - Current user wording normalized for follow-up analysis.
 * @param session - Current conversation session.
 * @returns `true` when a precise foreign URL should override fuzzy tracked-browser follow-up heuristics.
 */
function inputReferencesUntrackedExplicitBrowserUrl(
  normalizedInput: string,
  session: ConversationSession
): boolean {
  const explicitUrls = extractExplicitBrowserUrlReferences(normalizedInput);
  if (explicitUrls.length === 0) {
    return false;
  }
  const trackedUrls = new Set<string>();
  const trackedPreviewUrl = normalizeComparableBrowserUrl(session.activeWorkspace?.previewUrl);
  if (trackedPreviewUrl) {
    trackedUrls.add(trackedPreviewUrl);
  }
  for (const browserSession of session.browserSessions) {
    const normalizedUrl = normalizeComparableBrowserUrl(browserSession.url);
    if (normalizedUrl) {
      trackedUrls.add(normalizedUrl);
    }
  }
  return explicitUrls.some((url) => !trackedUrls.has(url));
}

/**
 * Builds a fail-closed guard when the user names an explicit browser URL that the runtime cannot
 * prove belongs to the currently tracked project.
 *
 * @param session - Current conversation session.
 * @param userInput - Raw current user wording.
 * @returns Ownership guard block, or `null` when no foreign explicit browser URL was named.
 */
function buildExplicitBrowserUrlOwnershipGuardBlock(
  session: ConversationSession,
  userInput: string
): string | null {
  const normalizedInput = normalizeWhitespace(userInput);
  if (!normalizedInput) {
    return null;
  }
  const mentionsBrowserAction =
    NATURAL_BROWSER_CLOSE_VERB_PATTERN.test(normalizedInput) ||
    NATURAL_BROWSER_OPEN_VERB_PATTERN.test(normalizedInput) ||
    NATURAL_BROWSER_CLOSE_REFERENCE_PATTERN.test(normalizedInput) ||
    NATURAL_BROWSER_OPEN_REFERENCE_PATTERN.test(normalizedInput);
  if (!mentionsBrowserAction) {
    return null;
  }
  const explicitUrls = extractExplicitBrowserUrlReferences(normalizedInput);
  if (explicitUrls.length === 0) {
    return null;
  }

  const trackedUrls = [
    session.activeWorkspace?.previewUrl ?? null,
    ...session.browserSessions.map((browserSession) => browserSession.url)
  ]
    .map((url) => normalizeComparableBrowserUrl(url))
    .filter((url): url is string => typeof url === "string" && url.length > 0);
  const untrackedUrls = explicitUrls.filter((url) => !trackedUrls.includes(url));
  if (untrackedUrls.length === 0) {
    return null;
  }

  const lines = [
    "Explicit browser-ownership guard:",
    `- The user named an explicit browser target that is not one of the tracked project pages in this chat: ${untrackedUrls.join(", ")}`,
    "- Do not close, reopen, or stop the tracked project preview as a substitute for that foreign URL.",
    "- Unless this run can prove that exact explicit URL belongs to the current tracked project, leave it alone and explain that ownership was not proven."
  ];
  if (trackedUrls.length > 0) {
    lines.push(`- Tracked project browser targets in this chat: ${trackedUrls.join(", ")}`);
  }
  return lines.join("\n");
}

export interface FollowUpResolution {
  executionInput: string;
  classification: FollowUpClassification;
}

/**
 * Sorts recent actions so continuity prompts see concrete files and folders before supporting
 * browser or summary records.
 *
 * @param session - Current conversation session.
 * @returns Prioritized recent-action list for continuity context.
 */
function prioritizeRecentActionsForContext(session: ConversationSession) {
  return [...session.recentActions].sort((left, right) => {
    const leftPriority = RECENT_ACTION_CONTEXT_PRIORITY[left.kind] ?? 99;
    const rightPriority = RECENT_ACTION_CONTEXT_PRIORITY[right.kind] ?? 99;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return right.at.localeCompare(left.at);
  });
}

/**
 * Renders the currently remembered working mode so follow-up turns can stay aligned with prior build/plan state.
 *
 * @param session - Current conversation session.
 * @returns Context block for execution input, or `null` when no working mode is active.
 */
function buildModeContinuityBlock(session: ConversationSession): string | null {
  if (!session.modeContinuity) {
    return null;
  }
  return [
    "Current working mode from earlier in this chat:",
    `- Active mode: ${session.modeContinuity.activeMode}`,
    `- Confidence: ${session.modeContinuity.confidence.toLowerCase()}`,
    `- Last affirmed at: ${session.modeContinuity.lastAffirmedAt}`,
    `- Last user wording: ${session.modeContinuity.lastUserInput}`
  ].join("\n");
}

/**
 * Renders the current progress state so execution input can answer "what are you doing now?" consistently.
 *
 * @param session - Current conversation session.
 * @returns Progress block, or `null` when no progress state is tracked.
 */
function buildProgressStateBlock(session: ConversationSession): string | null {
  if (!session.progressState) {
    return null;
  }
  const progressJobId = session.progressState.jobId ?? "none";
  return [
    "Current progress state:",
    `- Status: ${session.progressState.status}`,
    `- Message: ${session.progressState.message}`,
    `- Job id: ${progressJobId}`,
    `- Updated at: ${session.progressState.updatedAt}`
  ].join("\n");
}

/**
 * Renders the latest durable work handoff so return turns can pick up from a real checkpoint.
 *
 * @param session - Current conversation session.
 * @returns Handoff block, or `null` when no durable handoff exists yet.
 */
function buildReturnHandoffBlock(session: ConversationSession): string | null {
  if (!session.returnHandoff) {
    return null;
  }
  const lines = [
    "Latest durable work handoff in this chat:",
    `- Status: ${session.returnHandoff.status}`,
    `- Goal: ${session.returnHandoff.goal}`,
    `- Summary: ${session.returnHandoff.summary}`,
    `- Updated at: ${session.returnHandoff.updatedAt}`
  ];
  if (session.returnHandoff.workspaceRootPath) {
    lines.push(`- Workspace root: ${session.returnHandoff.workspaceRootPath}`);
  }
  if (session.returnHandoff.primaryArtifactPath) {
    lines.push(`- Primary artifact: ${session.returnHandoff.primaryArtifactPath}`);
  }
  if (session.returnHandoff.previewUrl) {
    lines.push(`- Preview URL: ${session.returnHandoff.previewUrl}`);
  }
  if (session.returnHandoff.changedPaths.length > 0) {
    lines.push(`- Changed paths: ${session.returnHandoff.changedPaths.join(", ")}`);
  }
  if (session.returnHandoff.nextSuggestedStep) {
    lines.push(`- Next suggested step: ${session.returnHandoff.nextSuggestedStep}`);
  }
  return lines.join("\n");
}

/**
 * Summarizes the most recent user-visible actions from the current chat for natural recall and reuse prompts.
 *
 * @param session - Current conversation session.
 * @returns Recent action block, or `null` when no actions are tracked.
 */
function buildRecentActionBlock(session: ConversationSession): string | null {
  if (session.recentActions.length === 0) {
    return null;
  }
  const prioritizedActions = prioritizeRecentActionsForContext(session);
  const lines = prioritizedActions.slice(0, 3).map((action) =>
    action.location
      ? `- ${action.label}: ${action.location} (${action.status})`
      : `- ${action.label}: ${action.summary} (${action.status})`
  );
  return [
    "Recent user-visible actions in this chat:",
    ...lines
  ].join("\n");
}

/**
 * Renders the canonical tracked workspace so follow-up turns can act on one explicit project root.
 *
 * @param session - Current conversation session.
 * @returns Workspace block, or `null` when no workspace is currently tracked.
 */
function buildActiveWorkspaceBlock(session: ConversationSession): string | null {
  if (!session.activeWorkspace) {
    return null;
  }
  const lines = [
    "Current tracked workspace in this chat:",
    `- Label: ${session.activeWorkspace.label}`,
    `- Root path: ${session.activeWorkspace.rootPath ?? "unknown"}`,
    `- Primary artifact: ${session.activeWorkspace.primaryArtifactPath ?? "unknown"}`,
    `- Preview URL: ${session.activeWorkspace.previewUrl ?? "none"}`,
    `- Browser session id: ${session.activeWorkspace.browserSessionId ?? "none"}`,
    `- Browser session ids: ${session.activeWorkspace.browserSessionIds.length > 0 ? session.activeWorkspace.browserSessionIds.join(", ") : "none"}`,
    `- Browser session status: ${session.activeWorkspace.browserSessionStatus ?? "unknown"}`,
    `- Browser process pid: ${session.activeWorkspace.browserProcessPid ?? "unknown"}`,
    `- Preview process lease: ${session.activeWorkspace.previewProcessLeaseId ?? "none"}`,
    `- Preview process leases: ${session.activeWorkspace.previewProcessLeaseIds.length > 0 ? session.activeWorkspace.previewProcessLeaseIds.join(", ") : "none"}`,
    `- Last known preview pid: ${session.activeWorkspace.lastKnownPreviewProcessPid ?? "unknown"}`,
    `- Still controllable: ${session.activeWorkspace.stillControllable ? "yes" : "no"}`,
    `- Ownership state: ${session.activeWorkspace.ownershipState}`,
    `- Preview stack state: ${session.activeWorkspace.previewStackState}`,
    `- Updated at: ${session.activeWorkspace.updatedAt}`
  ];
  if (session.activeWorkspace.lastChangedPaths.length > 0) {
    lines.push(
      `- Recent changed paths: ${session.activeWorkspace.lastChangedPaths.join(", ")}`
    );
  }
  return lines.join("\n");
}

/**
 * Renders tracked browser sessions so execution can answer follow-up requests about visible pages or tabs.
 *
 * @param session - Current conversation session.
 * @returns Browser session block, or `null` when no browser sessions are tracked.
 */
function buildBrowserSessionBlock(session: ConversationSession): string | null {
  if (session.browserSessions.length === 0) {
    return null;
  }
  const lines = session.browserSessions.slice(0, 3).map((browserSession) =>
    `- ${browserSession.label}: sessionId=${browserSession.id}; url=${browserSession.url}; status=${browserSession.status}; visibility=${browserSession.visibility}; controller=${browserSession.controllerKind}; control=${browserSession.controlAvailable ? "available" : "unavailable"}${browserSession.browserProcessPid !== null ? `; browserPid=${browserSession.browserProcessPid}` : ""}${browserSession.workspaceRootPath ? `; workspaceRoot=${browserSession.workspaceRootPath}` : ""}${browserSession.linkedProcessLeaseId ? `; linkedPreviewLease=${browserSession.linkedProcessLeaseId}` : ""}${browserSession.linkedProcessPid !== null ? `; linkedPreviewPid=${browserSession.linkedProcessPid}` : ""}${browserSession.linkedProcessCwd ? `; linkedPreviewCwd=${browserSession.linkedProcessCwd}` : ""}`
  );
  return [
    "Tracked browser sessions:",
    ...lines
  ].join("\n");
}

/**
 * Builds a follow-up block when the user is naturally referring to an already tracked browser
 * window from this chat.
 *
 * @param session - Current conversation session.
 * @param userInput - Raw current user wording.
 * @returns Browser follow-up guidance block, or `null` when no natural browser follow-up is detected.
 */
function buildBrowserFollowUpIntentBlock(
  session: ConversationSession,
  userInput: string
): string | null {
  if (session.browserSessions.length === 0) {
    return null;
  }

  const normalizedInput = normalizeWhitespace(userInput);
  if (!normalizedInput) {
    return null;
  }

  const referencesTrackedBrowserTarget = inputMentionsTrackedBrowserTarget(
    normalizedInput,
    session
  );
  const wantsClose =
    NATURAL_BROWSER_CLOSE_REFERENCE_PATTERN.test(normalizedInput) ||
    (
      NATURAL_BROWSER_CLOSE_VERB_PATTERN.test(normalizedInput) &&
      referencesTrackedBrowserTarget
    );
  const wantsOpen =
    !wantsClose &&
    (
      NATURAL_BROWSER_OPEN_REFERENCE_PATTERN.test(normalizedInput) ||
      (
        NATURAL_BROWSER_OPEN_VERB_PATTERN.test(normalizedInput) &&
        referencesTrackedBrowserTarget
      )
    );
  if (!wantsClose && !wantsOpen) {
    return null;
  }
  if (inputReferencesUntrackedExplicitBrowserUrl(normalizedInput, session)) {
    return null;
  }

  const activeWorkspaceSession =
    (session.activeWorkspace?.browserSessionId
      ? session.browserSessions.find(
          (browserSession) => browserSession.id === session.activeWorkspace?.browserSessionId
        ) ?? null
      : null);
  const openBrowserSession =
    session.browserSessions.find((browserSession) => browserSession.status === "open") ??
    null;
  const activeWorkspaceSupportsReopenFollowUp =
    wantsOpen &&
    Boolean(
      session.activeWorkspace?.previewUrl &&
      (
        session.activeWorkspace.browserSessionStatus === "open" ||
        session.activeWorkspace.stillControllable ||
        session.activeWorkspace.ownershipState === "orphaned" ||
        session.activeWorkspace.previewStackState !== "detached"
      )
    );
  const preferredSession = wantsOpen
    ? (
        activeWorkspaceSupportsReopenFollowUp
          ? activeWorkspaceSession
          : null
      ) ??
      openBrowserSession
    : activeWorkspaceSession ??
      openBrowserSession ??
      session.browserSessions[0];
  if (!preferredSession) {
    return null;
  }

  const lines = [
    "Natural browser-session follow-up:",
    "- The user appears to be referring to a tracked browser window from earlier in this chat.",
    `- Preferred browser session: ${preferredSession.label}; sessionId=${preferredSession.id}; url=${preferredSession.url}; status=${preferredSession.status}; control=${preferredSession.controlAvailable ? "available" : "unavailable"}`
  ];
  const exactWorkspacePreviewLeaseIds =
    session.activeWorkspace?.previewProcessLeaseIds.filter((leaseId) => leaseId.trim().length > 0) ?? [];
  if (preferredSession.linkedProcessLeaseId) {
    lines.push(
      `- Linked preview process: leaseId=${preferredSession.linkedProcessLeaseId}${preferredSession.linkedProcessCwd ? `; cwd=${preferredSession.linkedProcessCwd}` : ""}`
    );
    lines.push(
      "- In this chat, closing that landing page should shut down the linked local preview stack, not only hide the browser window."
    );
  } else if (preferredSession.workspaceRootPath) {
    lines.push(
      `- Remembered browser workspace root: ${preferredSession.workspaceRootPath}`
    );
  }
  if (exactWorkspacePreviewLeaseIds.length > 1) {
    lines.push(
      `- Exact tracked preview process leases for this workspace: ${exactWorkspacePreviewLeaseIds.join(", ")}`
    );
  }
  if (wantsClose) {
    if (exactWorkspacePreviewLeaseIds.length > 1) {
      const stopAllLeasesInstruction = exactWorkspacePreviewLeaseIds
        .map((leaseId) => `stop_process with params.leaseId=${leaseId}`)
        .join(", then ");
      if (preferredSession.controlAvailable) {
        lines.push(
          `- If the user wants that visible page closed now, prefer close_browser with params.sessionId=${preferredSession.id} and then stop each exact tracked preview lease for this workspace: ${stopAllLeasesInstruction}. Do not stop unrelated processes.`
        );
      } else {
        lines.push(
          `- If the user wants that visible page closed now, the browser session is no longer directly controllable. Prefer stopping each exact tracked preview lease for this workspace first: ${stopAllLeasesInstruction}. Then only use close_browser with params.sessionId=${preferredSession.id} if the runtime still proves direct browser control afterward. Do not stop unrelated processes.`
        );
      }
    } else if (preferredSession.linkedProcessLeaseId) {
      if (preferredSession.controlAvailable) {
        lines.push(
          `- If the user wants that visible page closed now, prefer close_browser with params.sessionId=${preferredSession.id} and then stop_process with params.leaseId=${preferredSession.linkedProcessLeaseId} so the linked local preview stack shuts down fully. Do not stop unrelated processes.`
        );
      } else {
        lines.push(
          `- If the user wants that visible page closed now, the browser session is no longer directly controllable. Prefer stop_process with params.leaseId=${preferredSession.linkedProcessLeaseId} first so the linked local preview stack shuts down, then only use close_browser with params.sessionId=${preferredSession.id} if the runtime still proves direct browser control afterward. Do not stop unrelated processes.`
        );
      }
    } else {
      lines.push(
        `- If the user wants that visible page closed now, prefer close_browser with params.sessionId=${preferredSession.id} over unrelated file, shell, or process actions.`
      );
    }
  } else {
    lines.push(
      `- If the user wants to see that page again, prefer open_browser with params.url=${preferredSession.url} instead of rebuilding a new project.`
    );
  }
  return lines.join("\n");
}

/**
 * Builds a follow-up block when the user appears to be editing the artifact already created in this
 * chat rather than asking for a brand-new project.
 *
 * @param session - Current conversation session.
 * @param userInput - Raw current user wording.
 * @returns Artifact-edit guidance block, or `null` when no natural edit follow-up is detected.
 */
function buildRecentArtifactEditContextBlock(
  session: ConversationSession,
  userInput: string
): string | null {
  const normalizedInput = normalizeWhitespace(userInput);
  if (!normalizedInput) {
    return null;
  }

  const looksLikeEdit =
    NATURAL_ARTIFACT_EDIT_VERB_PATTERN.test(normalizedInput) &&
    (
      NATURAL_ARTIFACT_EDIT_TARGET_PATTERN.test(normalizedInput) ||
      NATURAL_ARTIFACT_EDIT_DELTA_PATTERN.test(normalizedInput)
    ) &&
    !NATURAL_NEW_BUILD_PATTERN.test(normalizedInput);
  if (!looksLikeEdit) {
    return null;
  }

  const recentArtifactAction =
    prioritizeRecentActionsForContext(session).find((action) => action.kind !== "task_summary") ?? null;
  const recentDestination =
    (session.activeWorkspace?.rootPath
      ? {
          resolvedPath: session.activeWorkspace.rootPath
        }
      : null) ??
    session.pathDestinations[0] ??
    null;
  const openBrowserSession =
    (session.activeWorkspace?.browserSessionId
      ? session.browserSessions.find(
          (browserSession) => browserSession.id === session.activeWorkspace?.browserSessionId
        ) ?? null
      : null) ??
    session.browserSessions.find((browserSession) => browserSession.status === "open") ??
    null;
  if (
    !recentArtifactAction &&
    !recentDestination &&
    !openBrowserSession &&
    !session.activeWorkspace
  ) {
    return null;
  }

  const lines = [
    "Natural artifact-edit follow-up:",
    "- The user appears to be editing the artifact already created in this chat rather than asking for a brand-new project."
  ];
  if (recentArtifactAction) {
    lines.push(
      recentArtifactAction.location
        ? `- Most recent concrete artifact: ${recentArtifactAction.label} at ${recentArtifactAction.location}`
        : `- Most recent concrete artifact: ${recentArtifactAction.label}`
    );
  }
  if (recentDestination) {
    lines.push(
      `- Preferred edit destination: ${recentDestination.resolvedPath}`
    );
  }
  if (session.activeWorkspace?.primaryArtifactPath) {
    lines.push(
      `- Preferred primary artifact: ${session.activeWorkspace.primaryArtifactPath}`
    );
  }
  if (openBrowserSession) {
    lines.push(
      `- Visible preview already exists: ${openBrowserSession.url}; keep the preview aligned with the edited artifact when practical.`
    );
  }
  lines.push(
    "- This run must include a real file mutation under the tracked workspace. Do not satisfy this request by only reopening, focusing, or closing the preview."
  );
  lines.push(
    "- Prefer updating the tracked primary artifact first unless the requested change clearly belongs in another related tracked file."
  );
  return lines.join("\n");
}

/**
 * Returns whether the current turn is asking for local folder organization work.
 *
 * @param userInput - Raw current user wording.
 * @returns `true` when the turn is an execution-style local organization request.
 */
function isLocalOrganizationRequest(userInput: string): boolean {
  if (!LOCAL_ORGANIZATION_TARGET_PATTERN.test(userInput)) {
    return false;
  }
  if (STRONG_LOCAL_ORGANIZATION_VERB_PATTERN.test(userInput)) {
    return true;
  }
  return (
    WEAK_LOCAL_ORGANIZATION_VERB_PATTERN.test(userInput) &&
    (
      LOCAL_ORGANIZATION_COLLECTION_PATTERN.test(userInput) ||
      ORGANIZATION_PREFIX_PATTERN.test(userInput) ||
      EXPLICIT_ALL_MATCHING_FOLDERS_PATTERN.test(userInput)
    )
  );
}

/**
 * Extracts the simple Desktop destination folder name from natural organization wording.
 *
 * @param userInput - Raw current user wording.
 * @returns Folder name, or `null` when none is named directly.
 */
function extractSimpleDesktopDestinationName(userInput: string): string | null {
  const match = userInput.match(SIMPLE_DESKTOP_DESTINATION_PATTERN);
  return match?.[1]?.trim() ?? null;
}

/**
 * Extracts the requested folder-name prefix from wording like `starts with drone-company`.
 *
 * @param userInput - Raw current user wording.
 * @returns Requested folder-name prefix, or `null` when none is named.
 */
function extractOrganizationFolderPrefix(userInput: string): string | null {
  return userInput.match(ORGANIZATION_PREFIX_PATTERN)?.[1]?.trim() ?? null;
}

/**
 * Derives the Desktop root from any remembered path that sits under the user's Desktop.
 *
 * @param candidatePath - Remembered file or folder path.
 * @returns Desktop root path, or `null` when the path is not under Desktop.
 */
function deriveDesktopRootFromCandidatePath(candidatePath: string | null | undefined): string | null {
  if (!candidatePath?.trim()) {
    return null;
  }
  const normalized = normalizeCrossPlatformPath(candidatePath);
  if (!normalized) {
    return null;
  }
  const usesWindowsSeparators = normalized.includes("\\");
  const separator = usesWindowsSeparators ? "\\" : "/";
  const segments = normalized.split(/[\\/]+/);
  const desktopIndex = segments.findIndex((segment) => segment.toLowerCase() === "desktop");
  if (desktopIndex === -1) {
    return null;
  }
  return segments.slice(0, desktopIndex + 1).join(separator) || null;
}

/**
 * Collects remembered Desktop roots from the current session so natural cleanup turns can act on
 * one explicit location instead of guessing.
 *
 * @param session - Current conversation session.
 * @returns Deduplicated Desktop roots in priority order.
 */
function collectRememberedDesktopRoots(session: ConversationSession): readonly string[] {
  const candidates = [
    session.activeWorkspace?.rootPath ?? null,
    session.activeWorkspace?.primaryArtifactPath ?? null,
    session.returnHandoff?.workspaceRootPath ?? null,
    session.returnHandoff?.primaryArtifactPath ?? null,
    ...(session.returnHandoff?.changedPaths ?? []),
    ...session.pathDestinations.map((destination) => destination.resolvedPath),
    ...session.recentActions.map((action) => action.location ?? null),
    ...session.browserSessions.flatMap((browserSession) => [
      browserSession.workspaceRootPath ?? null,
      browserSession.linkedProcessCwd ?? null
    ])
  ];
  const uniqueRoots = new Set<string>();
  for (const candidate of candidates) {
    const desktopRoot = deriveDesktopRootFromCandidatePath(candidate);
    if (desktopRoot) {
      uniqueRoots.add(desktopRoot);
    }
  }
  return [...uniqueRoots];
}

/**
 * Builds a bounded execution-input block for natural Desktop cleanup requests so the planner knows
 * it must perform a real move and can anchor the destination to the remembered Desktop root.
 *
 * @param session - Current conversation session.
 * @param userInput - Raw current user wording.
 * @returns Desktop-organization guidance block, or `null` when the turn is not such a request.
 */
function buildDesktopOrganizationExecutionContextBlock(
  session: ConversationSession,
  userInput: string
): string | null {
  const normalizedInput = normalizeWhitespace(userInput);
  if (!normalizedInput || !isLocalOrganizationRequest(normalizedInput)) {
    return null;
  }
  if (!/\bdesktop\b/i.test(normalizedInput)) {
    return null;
  }

  const rememberedDesktopRoot = collectRememberedDesktopRoots(session)[0] ?? null;
  const destinationFolderName = extractSimpleDesktopDestinationName(normalizedInput);
  const requestedFolderPrefix = extractOrganizationFolderPrefix(normalizedInput);
  const activeWorkspaceFolderName = session.activeWorkspace?.rootPath
    ? basenameCrossPlatformPath(session.activeWorkspace.rootPath)
    : null;
  const activeWorkspaceMatchesRequestedPrefix =
    Boolean(activeWorkspaceFolderName) &&
    Boolean(requestedFolderPrefix) &&
    activeWorkspaceFolderName!.toLowerCase().startsWith(requestedFolderPrefix!.toLowerCase());

  const lines = [
    "Natural desktop-organization follow-up:",
    "- The user is asking for a real Desktop folder move, not just an inspection or summary."
  ];
  if (rememberedDesktopRoot) {
    lines.push(`- Strongest remembered Desktop root in this chat: ${rememberedDesktopRoot}`);
  }
  if (rememberedDesktopRoot && destinationFolderName) {
    const separator = rememberedDesktopRoot.includes("\\") ? "\\" : "/";
    lines.push(
      `- Treat the named destination as ${normalizeCrossPlatformPath(`${rememberedDesktopRoot}${separator}${destinationFolderName}`)} unless fresher path evidence in this chat proves a different location.`
    );
  }
  if (requestedFolderPrefix) {
    lines.push(`- Match Desktop folders whose names start with ${requestedFolderPrefix}.`);
  }
  if (activeWorkspaceMatchesRequestedPrefix && activeWorkspaceFolderName) {
    lines.push(
      `- The current tracked workspace folder ${activeWorkspaceFolderName} also matches that requested prefix; include it in the move unless the user explicitly excluded it.`
    );
  }
  if (EXPLICIT_ALL_MATCHING_FOLDERS_PATTERN.test(normalizedInput)) {
    lines.push(
      "- The user explicitly authorized moving all matching folders now; do not ask again before executing the move unless a new blocker appears."
    );
  }
  lines.push(
    "- This run must include a real folder move side effect. Do not satisfy this request by only listing, reading, or summarizing directories."
  );
  return lines.join("\n");
}

/**
 * Builds a prompt guardrail block when the user gives first-person status updates.
 *
 * @param userInput - Current raw user message.
 * @returns Instruction block appended to execution input, or `null` when no status update is detected.
 */
export function buildTurnLocalStatusUpdateBlock(userInput: string): string | null {
  const normalizedInput = normalizeWhitespace(userInput);
  if (!normalizedInput) {
    return null;
  }
  if (!FIRST_PERSON_STATUS_UPDATE_PATTERN.test(normalizedInput)) {
    return null;
  }
  if (!STATUS_UPDATE_VALUE_MARKER_PATTERN.test(normalizedInput)) {
    return null;
  }

  return [
    "Turn-local status update (authoritative for this turn):",
    `- User stated: ${normalizedInput}`,
    "- Response rule: acknowledge this latest status and do not assert an older contradictory status as fact."
  ].join("\n");
}

/**
 * Wraps user input with recent turn context and deterministic routing hints when context exists.
 *
 * @param session - Conversation session containing recent turns.
 * @param userInput - Current request payload to send to execution.
 * @param maxContextTurnsForExecution - Maximum number of recent turns to include.
 * @param routingClassification - Optional routing-map classification for deterministic hinting.
 * @returns Execution payload passed to the task runner.
 */
export async function buildConversationAwareExecutionInput(
  session: ConversationSession,
  executionInput: string,
  maxContextTurnsForExecution: number,
  routingClassification: RoutingMapClassificationV1 | null = null,
  sourceUserInput: string | null = null,
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes,
  queryContinuityFacts?: QueryConversationContinuityFacts,
  media?: ConversationInboundMediaEnvelope | null,
  managedProcessSnapshots?: readonly ManagedProcessSnapshot[],
  semanticHint: ConversationIntentSemanticHint | null = null,
  browserSessionSnapshots?: readonly BrowserSessionSnapshot[]
): Promise<string> {
  const runtimeReconciledSession = reconcileConversationExecutionRuntimeSession(
    session,
    browserSessionSnapshots,
    managedProcessSnapshots
  );
  const recentTurns = session.conversationTurns.slice(-maxContextTurnsForExecution);
  const rawUserInput = sourceUserInput ?? executionInput;
  const statusUpdateBlock = buildTurnLocalStatusUpdateBlock(rawUserInput);
  const contextualRecallBlock = await buildContextualRecallBlock(
    runtimeReconciledSession,
    rawUserInput,
    queryContinuityEpisodes,
    queryContinuityFacts,
    media
  );
  const mediaContextBlock = buildConversationMediaContextBlock(media);
  const modeContinuityBlock = buildModeContinuityBlock(runtimeReconciledSession);
  const progressStateBlock = buildProgressStateBlock(runtimeReconciledSession);
  const returnHandoffBlock = buildReturnHandoffBlock(runtimeReconciledSession);
  const returnHandoffContinuationBlock = buildReturnHandoffContinuationBlock(
    runtimeReconciledSession,
    rawUserInput,
    semanticHint
  );
  const recentActionBlock = buildRecentActionBlock(runtimeReconciledSession);
  const activeWorkspaceBlock = buildActiveWorkspaceBlock(runtimeReconciledSession);
  const browserSessionBlock = buildBrowserSessionBlock(runtimeReconciledSession);
  const explicitBrowserUrlOwnershipGuardBlock = buildExplicitBrowserUrlOwnershipGuardBlock(
    runtimeReconciledSession,
    rawUserInput
  );
  const browserFollowUpIntentBlock = buildBrowserFollowUpIntentBlock(
    runtimeReconciledSession,
    rawUserInput
  );
  const artifactEditContextBlock = buildRecentArtifactEditContextBlock(
    runtimeReconciledSession,
    rawUserInput
  );
  const desktopOrganizationContextBlock = buildDesktopOrganizationExecutionContextBlock(
    runtimeReconciledSession,
    rawUserInput
  );
  const workspaceRecoveryContextBlock = buildWorkspaceRecoveryContextBlock(
    runtimeReconciledSession,
    rawUserInput,
    managedProcessSnapshots
  );
  const pathDestinationBlock = buildPathDestinationContextBlock(
    runtimeReconciledSession,
    rawUserInput
  );
  const reusePreferenceBlock = buildReuseIntentContextBlock(
    runtimeReconciledSession,
    rawUserInput
  );
  const routingHint = routingClassification
    ? buildRoutingExecutionHintV1(routingClassification)
    : null;
  if (
    recentTurns.length === 0 &&
    !statusUpdateBlock &&
    !contextualRecallBlock &&
    !mediaContextBlock &&
    !modeContinuityBlock &&
    !progressStateBlock &&
    !returnHandoffBlock &&
    !returnHandoffContinuationBlock &&
    !recentActionBlock &&
    !activeWorkspaceBlock &&
    !browserSessionBlock &&
    !explicitBrowserUrlOwnershipGuardBlock &&
    !browserFollowUpIntentBlock &&
    !artifactEditContextBlock &&
    !desktopOrganizationContextBlock &&
    !workspaceRecoveryContextBlock &&
    !pathDestinationBlock &&
    !reusePreferenceBlock &&
    !routingHint
  ) {
    return executionInput;
  }

  const lines: string[] = [
    "You are in an ongoing conversation with the same user.",
    "Use recent context to resolve references like 'another', 'same style', and 'as before'.",
    "Treat short confirmations or formatting replies as answers to the most recent assistant question when context indicates that linkage.",
    "Do not claim side effects were completed unless execution evidence in this run confirms it.",
    "For policy or block-reason questions, provide concrete typed reasons and avoid generic speculative explanations.",
    "Do not end with placeholder progress language (for example: 'I will ... shortly' or 'please hold on'). Return the final answer for this run.",
    "If the user gives a first-person status update (for example: 'my ... is ...'), treat that update as the newest fact for this turn and do not contradict it with older memory unless you ask a clarifying question.",
    "Only use facts from the context and current message."
  ];

  if (recentTurns.length > 0) {
    lines.push(
      "",
      "Recent conversation context (oldest to newest):",
      renderTurnsForContext(recentTurns)
    );
  }

  if (statusUpdateBlock) {
    lines.push("", statusUpdateBlock);
  }
  if (contextualRecallBlock) {
    lines.push("", contextualRecallBlock);
  }
  if (mediaContextBlock) {
    lines.push("", mediaContextBlock);
  }
  if (modeContinuityBlock) {
    lines.push("", modeContinuityBlock);
  }
  if (progressStateBlock) {
    lines.push("", progressStateBlock);
  }
  if (returnHandoffBlock) {
    lines.push("", returnHandoffBlock);
  }
  if (returnHandoffContinuationBlock) {
    lines.push("", returnHandoffContinuationBlock);
  }
  if (recentActionBlock) {
    lines.push("", recentActionBlock);
  }
  if (activeWorkspaceBlock) {
    lines.push("", activeWorkspaceBlock);
  }
  if (browserSessionBlock) {
    lines.push("", browserSessionBlock);
  }
  if (explicitBrowserUrlOwnershipGuardBlock) {
    lines.push("", explicitBrowserUrlOwnershipGuardBlock);
  }
  if (browserFollowUpIntentBlock) {
    lines.push("", browserFollowUpIntentBlock);
  }
  if (artifactEditContextBlock) {
    lines.push("", artifactEditContextBlock);
  }
  if (desktopOrganizationContextBlock) {
    lines.push("", desktopOrganizationContextBlock);
  }
  if (workspaceRecoveryContextBlock) {
    lines.push("", workspaceRecoveryContextBlock);
  }
  if (pathDestinationBlock) {
    lines.push("", pathDestinationBlock);
  }
  if (reusePreferenceBlock) {
    lines.push("", reusePreferenceBlock);
  }
  if (routingHint) {
    lines.push("", "Deterministic routing hint:", routingHint);
  }

  lines.push("", "Current user request:", executionInput);
  return lines.join("\n");
}

/**
 * Resolves whether input should be handled as standalone text or a short follow-up answer.
 *
 * @param session - Session state containing recent assistant/user turns.
 * @param userInput - Current user text to classify.
 * @param followUpRuleContext - Loaded follow-up rulepack context.
 * @returns Follow-up classification metadata plus the execution payload to send downstream.
 */
export function resolveFollowUpInput(
  session: ConversationSession,
  userInput: string,
  followUpRuleContext: FollowUpRuleContext
): FollowUpResolution {
  const lastAssistantPrompt = [...session.conversationTurns]
    .reverse()
    .find(
      (turn) =>
        turn.role === "assistant" &&
        isLikelyAssistantClarificationPrompt(turn.text)
    );
  const classification = classifyFollowUp(userInput, {
    hasPriorAssistantQuestion: Boolean(lastAssistantPrompt),
    ruleContext: followUpRuleContext
  });

  if (!classification.isShortFollowUp) {
    return {
      executionInput: userInput,
      classification
    };
  }

  if (!lastAssistantPrompt) {
    return {
      executionInput: userInput,
      classification
    };
  }

  return {
    executionInput: [
      "Follow-up user response to prior assistant clarification.",
      `Follow-up classifier: ${classification.matchedRuleId}`,
      `Follow-up rulepack: ${classification.rulepackVersion}`,
      `Follow-up category: ${classification.category}`,
      `Follow-up confidence: ${classification.confidenceTier}`,
      `Previous assistant question: ${normalizeAssistantTurnText(lastAssistantPrompt.text)}`,
      `User follow-up answer: ${normalizeWhitespace(userInput)}`
    ].join("\n"),
    classification
  };
}

/**
 * Builds the governed execution payload for a system-generated Agent Pulse job.
 *
 * @param session - Session providing recent turn context.
 * @param systemPrompt - Pulse prompt/body generated by scheduler logic.
 * @param maxContextTurnsForExecution - Maximum number of prior turns included in the context block.
 * @returns Fully assembled execution input sent to the queue worker.
 */
export function buildAgentPulseExecutionInput(
  session: ConversationSession,
  systemPrompt: string,
  maxContextTurnsForExecution: number
): string {
  const recentTurns = session.conversationTurns.slice(-maxContextTurnsForExecution);
  const contextBlock =
    recentTurns.length > 0
      ? [
        "",
        "Recent conversation context (oldest to newest):",
        renderTurnsForContext(recentTurns)
      ].join("\n")
      : "";

  return [
    "System-generated Agent Pulse check-in request.",
    "Return one concise proactive check-in message in natural language.",
    "Do not volunteer that you are an AI assistant in ordinary greetings or casual replies.",
    "Only mention that identity if the user directly asks what you are, if a capability or safety boundary requires it, or if it materially changes the answer.",
    "Never open with canned self-introductions like 'AI assistant here' or 'I'm your AI assistant'.",
    "Do not prepend labels like 'AI assistant response' or 'AI assistant check-in'.",
    "Do not impersonate a human.",
    "Do not perform file/network/shell actions unless explicitly required.",
    "",
    "Agent Pulse request:",
    systemPrompt,
    contextBlock
  ].join("\n");
}






