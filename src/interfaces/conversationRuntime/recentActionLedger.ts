/**
 * @fileoverview Derives and renders user-facing recent-action, destination, browser-session, and progress ledgers.
 */

import { basenameCrossPlatformPath } from "../../core/crossPlatformPath";
import type { ActionRunResult, TaskRunResult } from "../../core/types";
import type { ConversationIntentSemanticHint } from "./intentModeContracts";
import {
  buildPathDestination,
  fileLabel,
  folderLabel,
  normalizeInteger,
  normalizeString,
  parseLinkedBrowserSessionCleanupRecords,
  summarizeActionOutput
} from "./recentActionLedgerMetadataHelpers";
import {
  type BrowserSessionOwnershipContext,
  type TaskLevelLinkedProcessContext,
  collectTaskLevelLinkedProcesses,
  resolveBrowserLinkedProcessForAction
} from "./recentActionLedgerOwnership";
import {
  renderActiveWorkspaceHeading,
  renderActiveWorkspacePreviewLine,
  joinNaturalList,
  renderActiveWorkspaceLocation,
  renderBrowserSessionLine,
  renderPathDestinationLine,
  renderProgressStateLine,
  renderRecoveryTraceLine,
  renderReturnHandoffSummary,
  renderRecentActionLine
} from "./recentActionLedgerRendering";
import {
  analyzeConversationChatTurnSignals,
  shouldAllowImplicitReturnHandoffStatusFallback
} from "./chatTurnSignals";
import type {
  ConversationBrowserSessionRecord,
  ConversationPathDestinationRecord,
  ConversationRecentActionRecord,
  ConversationSession
} from "../sessionStore";

/**
 * Returns whether one semantic hint should be trusted as an implicit durable-handoff status signal.
 *
 * @param semanticHint - Optional resolved conversational status hint.
 * @returns `true` when the hint belongs to a durable handoff/status surface.
 */
function isImplicitReturnHandoffSemanticHint(
  semanticHint: ConversationIntentSemanticHint | null
): boolean {
  switch (semanticHint) {
    case "review_ready":
    case "guided_review":
    case "next_review_step":
    case "while_away_review":
    case "wrap_up_summary":
    case "explain_handoff":
    case "resume_handoff":
    case "status_return_handoff":
      return true;
    default:
      return false;
  }
}

export interface RecentActionLedgerLimits {
  maxRecentActions: number;
  maxBrowserSessions: number;
  maxPathDestinations: number;
}

export interface DerivedConversationLedgers {
  recentActions: readonly ConversationRecentActionRecord[];
  browserSessions: readonly ConversationBrowserSessionRecord[];
  pathDestinations: readonly ConversationPathDestinationRecord[];
}

/**
 * Derives recent-action, browser-session, and destination ledgers from a single action result.
 *
 * @param actionResult - Individual action result from a completed task.
 * @param sourceJobId - Session job id associated with the action.
 * @param at - Timestamp for ledger ordering.
 * @returns Typed ledger slices derived from the action metadata.
 */
function deriveActionRecordsFromResult(
  actionResult: ActionRunResult,
  sourceJobId: string,
  at: string,
  linkedProcess: TaskLevelLinkedProcessContext | null
): DerivedConversationLedgers {
  const metadata = actionResult.executionMetadata ?? {};
  const recentActions: ConversationRecentActionRecord[] = [];
  const browserSessions: ConversationBrowserSessionRecord[] = [];
  const pathDestinations: ConversationPathDestinationRecord[] = [];
  const summary = summarizeActionOutput(actionResult);

  const filePath =
    normalizeString(metadata.filePath) ??
    normalizeString(metadata.writeFilePath) ??
    normalizeString(metadata.readFilePath) ??
    normalizeString(metadata.deleteFilePath);
  const directoryPath =
    normalizeString(metadata.directoryPath) ?? normalizeString(metadata.listedPath);
  const processCwd = normalizeString(metadata.processCwd);
  const processLeaseId = normalizeString(metadata.processLeaseId);
  const processPid = normalizeInteger(metadata.processPid);
  const processLifecycleStatus = normalizeString(metadata.processLifecycleStatus);
  const probeUrl = normalizeString(metadata.probeUrl);
  const browserVerifyUrl = normalizeString(metadata.browserVerifyUrl);
  const browserSessionId = normalizeString(metadata.browserSessionId);
  const browserSessionUrl = normalizeString(metadata.browserSessionUrl);
  const browserSessionStatus = normalizeString(metadata.browserSessionStatus);
  const browserSessionVisibility = normalizeString(metadata.browserSessionVisibility);
  const browserSessionControllerKind = normalizeString(metadata.browserSessionControllerKind);
  const browserSessionControlAvailable = metadata.browserSessionControlAvailable !== false;
  const browserProcessPid = normalizeInteger(metadata.browserSessionBrowserProcessPid);
  const browserSessionWorkspaceRootPath = normalizeString(metadata.browserSessionWorkspaceRootPath);
  const browserSessionLinkedProcessLeaseId = normalizeString(metadata.browserSessionLinkedProcessLeaseId);
  const browserSessionLinkedProcessCwd = normalizeString(metadata.browserSessionLinkedProcessCwd);
  const browserSessionLinkedProcessPid = normalizeInteger(metadata.browserSessionLinkedProcessPid);
  const linkedBrowserSessionCleanupRecords = parseLinkedBrowserSessionCleanupRecords(
    metadata.linkedBrowserSessionCleanupRecordsJson
  );
  const browserSessionOwnership: BrowserSessionOwnershipContext | null =
    browserSessionLinkedProcessLeaseId || browserSessionLinkedProcessCwd || browserSessionWorkspaceRootPath
      ? {
          leaseId: browserSessionLinkedProcessLeaseId ?? linkedProcess?.leaseId ?? "",
          cwd:
            browserSessionLinkedProcessCwd ??
            browserSessionWorkspaceRootPath ??
            linkedProcess?.cwd ??
            null,
          pid: browserSessionLinkedProcessPid ?? linkedProcess?.pid ?? null,
          workspaceRootPath:
            browserSessionWorkspaceRootPath ??
            browserSessionLinkedProcessCwd ??
            linkedProcess?.cwd ??
            null
        }
      : linkedProcess
        ? {
            ...linkedProcess,
            workspaceRootPath: linkedProcess.cwd
          }
        : null;

  if (filePath) {
    recentActions.push({
      id: `${sourceJobId}:file:${filePath}`,
      kind: "file",
      label: fileLabel(filePath),
      location: filePath,
      status: actionResult.approved && actionResult.executionStatus === "success" ? "updated" : "failed",
      sourceJobId,
      at,
      summary
    });
    pathDestinations.push(
      buildPathDestination(
        `path:file:${filePath}`,
        fileLabel(filePath),
        filePath,
        sourceJobId,
        at
      )
    );
  }

  if (directoryPath) {
    recentActions.push({
      id: `${sourceJobId}:folder:${directoryPath}`,
      kind: "folder",
      label: folderLabel(directoryPath),
      location: directoryPath,
      status: actionResult.approved && actionResult.executionStatus === "success" ? "completed" : "failed",
      sourceJobId,
      at,
      summary
    });
    pathDestinations.push(
      buildPathDestination(
        `path:folder:${directoryPath}`,
        folderLabel(directoryPath),
        directoryPath,
        sourceJobId,
        at
      )
    );
  }

  if (processLeaseId) {
    const processStatus =
      processLifecycleStatus === "PROCESS_STOPPED"
        ? "closed"
        : (actionResult.executionStatus === "success" ? "running" : "failed");
    recentActions.push({
      id: `${sourceJobId}:process:${processLeaseId}`,
      kind: "process",
      label: processCwd ? `Process in ${processCwd}` : "Managed process",
      location: processCwd,
      status: processStatus,
      sourceJobId,
      at,
      summary: processPid !== null ? `${summary} (pid ${processPid})` : summary
    });
    if (processCwd) {
      pathDestinations.push(
        buildPathDestination(
          `path:process:${processLeaseId}`,
          "Process working folder",
          processCwd,
          sourceJobId,
          at
        )
      );
    }
  }

  if (probeUrl) {
    recentActions.push({
      id: `${sourceJobId}:url:${probeUrl}`,
      kind: "url",
      label: "Verified local URL",
      location: probeUrl,
      status: actionResult.executionStatus === "success" ? "completed" : "failed",
      sourceJobId,
      at,
      summary
    });
  }

  if (browserVerifyUrl) {
    recentActions.push({
      id: `${sourceJobId}:browser:${browserVerifyUrl}`,
      kind: "task_summary",
      label: "Browser verification",
      location: browserVerifyUrl,
      status: actionResult.executionStatus === "success" ? "completed" : "failed",
      sourceJobId,
      at,
      summary
    });
  }

  if (browserSessionId && browserSessionUrl) {
    const isOpenSession = browserSessionStatus === "open";
    recentActions.push({
      id: `${sourceJobId}:browser_session:${browserSessionId}`,
      kind: "browser_session",
      label: "Browser window",
      location: browserSessionUrl,
      status: isOpenSession ? "open" : "closed",
      sourceJobId,
      at,
      summary
    });
    browserSessions.push({
      id: browserSessionId,
      label: "Browser window",
      url: browserSessionUrl,
      status: isOpenSession ? "open" : "closed",
      openedAt: at,
      closedAt: isOpenSession ? null : at,
      sourceJobId,
      visibility: browserSessionVisibility === "headless" ? "headless" : "visible",
      controllerKind:
        browserSessionControllerKind === "os_default" ? "os_default" : "playwright_managed",
      controlAvailable: browserSessionControlAvailable,
      browserProcessPid,
      workspaceRootPath: browserSessionOwnership?.workspaceRootPath ?? null,
      linkedProcessLeaseId:
        browserSessionOwnership?.leaseId.length ? browserSessionOwnership.leaseId : null,
      linkedProcessCwd: browserSessionOwnership?.cwd ?? null,
      linkedProcessPid: browserSessionOwnership?.pid ?? null
    });
  }

  for (const cleanupRecord of linkedBrowserSessionCleanupRecords) {
    const isOpenSession = cleanupRecord.status === "open";
    recentActions.push({
      id: `${sourceJobId}:browser_session:${cleanupRecord.sessionId}`,
      kind: "browser_session",
      label: "Browser window",
      location: cleanupRecord.url,
      status: isOpenSession ? "open" : "closed",
      sourceJobId,
      at,
      summary
    });
    browserSessions.push({
      id: cleanupRecord.sessionId,
      label: "Browser window",
      url: cleanupRecord.url,
      status: cleanupRecord.status,
      openedAt: at,
      closedAt: isOpenSession ? null : at,
      sourceJobId,
      visibility: cleanupRecord.visibility,
      controllerKind: cleanupRecord.controllerKind,
      controlAvailable: cleanupRecord.controlAvailable,
      browserProcessPid: cleanupRecord.browserProcessPid,
      workspaceRootPath: cleanupRecord.workspaceRootPath,
      linkedProcessLeaseId: cleanupRecord.linkedProcessLeaseId,
      linkedProcessCwd: cleanupRecord.linkedProcessCwd,
      linkedProcessPid: cleanupRecord.linkedProcessPid
    });
  }

  return {
    recentActions,
    browserSessions,
    pathDestinations
  };
}


/**
 * Derives typed user-facing ledgers from one completed task result.
 *
 * @param taskRunResult - Completed task result returned by the governed execution layer.
 * @param sourceJobId - Interface session job id associated with the task.
 * @param at - Timestamp used for ledger ordering.
 * @returns Derived ledgers ready for bounded upsert into the session state.
 */
export function deriveConversationLedgersFromTaskRunResult(
  taskRunResult: TaskRunResult,
  sourceJobId: string,
  at: string
): DerivedConversationLedgers {
  const recentActions: ConversationRecentActionRecord[] = [
    {
      id: `${sourceJobId}:task_summary`,
      kind: "task_summary",
      label: "Latest completed task",
      location: null,
      status: "completed",
      sourceJobId,
      at,
      summary: taskRunResult.summary
    }
  ];
  const browserSessions: ConversationBrowserSessionRecord[] = [];
  const pathDestinations: ConversationPathDestinationRecord[] = [];
  const taskLevelLinkedProcesses = collectTaskLevelLinkedProcesses(taskRunResult.actionResults);

  for (const [actionIndex, actionResult] of taskRunResult.actionResults.entries()) {
    const linkedProcess =
      actionResult.action.type === "open_browser"
        ? resolveBrowserLinkedProcessForAction(
            actionResult,
            actionIndex,
            taskLevelLinkedProcesses
          )
        : taskLevelLinkedProcesses.length === 1
          ? taskLevelLinkedProcesses[0] ?? null
          : null;
    const derived = deriveActionRecordsFromResult(
      actionResult,
      sourceJobId,
      at,
      linkedProcess
    );
    recentActions.push(...derived.recentActions);
    browserSessions.push(...derived.browserSessions);
    pathDestinations.push(...derived.pathDestinations);
  }

  return {
    recentActions,
    browserSessions,
    pathDestinations
  };
}

const CHANGE_RECALL_PATTERN =
  /\b(?:what did you (?:just )?(?:do|make|create|change)|what changed|what happened|tell me about (?:your|the) changes|tell me what you changed|what you changed|change summary)\b/;
const RETURN_HANDOFF_PATTERN =
  /\b(?:what did you get done|what got done|what(?:'s| is) ready(?: for (?:me to )?review)?|show me what(?:'s| is) ready(?: for (?:me to )?review)?|show me (?:the )?(?:rough |current )?draft|rough draft|what do you have ready(?: for me)?|show me what you(?:'ve| have) got(?: so far)?|what should i look at first|what should i review first|where should i start|show me what i should look at first|what do you want me to look at first|pick (?:that|it) back up|resume (?:that|it)|continue from where you left off|what changed while i was away|what did you change while i was away|what happened while i was away|what did you get done while i was away|what did you finish while i was (?:away|gone|out)|what did you complete while i was (?:away|gone|out)|what got finished while i was (?:away|gone|out)|what got completed while i was (?:away|gone|out))\b/i;

const CHANGE_RECALL_KIND_PRIORITY: Readonly<Record<ConversationRecentActionRecord["kind"], number>> = {
  file: 0,
  folder: 1,
  report: 2,
  process: 3,
  browser_session: 4,
  url: 5,
  task_summary: 6
};

/**
 * Returns the most useful recent action for natural-language recall, preferring concrete side effects.
 *
 * @param session - Current conversation session.
 * @returns Most relevant recent action, or `null` when no actions are tracked.
 */
function latestConcreteRecentAction(
  session: ConversationSession
): ConversationRecentActionRecord | null {
  return (
    session.recentActions.find((action) => action.kind !== "task_summary") ??
    session.recentActions[0] ??
    null
  );
}

/**
 * Returns the most useful actions for "what changed?" follow-ups, preferring file and folder edits
 * over preview/browser bookkeeping.
 *
 * @param session - Current conversation session.
 * @returns Change-oriented recent actions sorted from most relevant to least relevant.
 */
function prioritizedRecentChangeActions(
  session: ConversationSession
): ConversationRecentActionRecord[] {
  return [...session.recentActions]
    .filter((action) => action.kind !== "task_summary")
    .sort((left, right) => {
      const leftPriority = CHANGE_RECALL_KIND_PRIORITY[left.kind];
      const rightPriority = CHANGE_RECALL_KIND_PRIORITY[right.kind];
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return right.at.localeCompare(left.at);
    });
}

/**
 * Returns the latest completed job in session order.
 *
 * @param session - Current conversation session.
 * @returns Latest completed job, or `null` when none exists.
 */
function latestCompletedJob(
  session: ConversationSession
): ConversationSession["recentJobs"][number] | null {
  return session.recentJobs
    .filter((job) => job.status === "completed")
    .sort((left, right) => {
      const leftTimestamp = left.completedAt ?? left.startedAt ?? left.createdAt;
      const rightTimestamp = right.completedAt ?? right.startedAt ?? right.createdAt;
      return rightTimestamp.localeCompare(leftTimestamp);
    })[0] ?? null;
}

/**
 * Deduplicates repeated file/folder/browser records, keeping the newest entry for each stable target.
 *
 * @param actions - Candidate recent actions.
 * @returns Deduplicated actions in original priority order.
 */
function dedupeRecentActions(
  actions: readonly ConversationRecentActionRecord[]
): ConversationRecentActionRecord[] {
  const seen = new Set<string>();
  const deduped: ConversationRecentActionRecord[] = [];

  for (const action of actions) {
    const identity = action.location ?? `${action.kind}:${action.label}`;
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    deduped.push(action);
  }

  return deduped;
}

/**
 * Returns the most relevant recent actions for the latest completed job, falling back to the global
 * recent-action ordering when job-linked actions are unavailable.
 *
 * @param session - Current conversation session.
 * @returns Prioritized and deduplicated action list for change recall.
 */
function latestJobScopedChangeActions(
  session: ConversationSession
): ConversationRecentActionRecord[] {
  const latestJob = latestCompletedJob(session);
  if (!latestJob) {
    return dedupeRecentActions(prioritizedRecentChangeActions(session));
  }

  const scopedActions = prioritizedRecentChangeActions({
    ...session,
    recentActions: session.recentActions.filter(
      (action) => action.sourceJobId === latestJob.id
    )
  });
  if (scopedActions.length > 0) {
    return dedupeRecentActions(scopedActions);
  }
  return dedupeRecentActions(prioritizedRecentChangeActions(session));
}

/**
 * Builds a human summary for "what changed?" follow-ups using the latest completed job and its
 * concrete side effects.
 *
 * @param session - Current conversation session.
 * @returns Human-readable change summary, or `null` when no concrete actions exist.
 */
function renderLatestChangeSummary(session: ConversationSession): string | null {
  const latestJob = latestCompletedJob(session);
  const changeActions = latestJobScopedChangeActions(session);
  if (changeActions.length === 0) {
    return null;
  }

  const fileActions = changeActions.filter((action) => action.kind === "file");
  const folderActions = changeActions.filter((action) => action.kind === "folder");
  const openBrowserForLatestJob = session.browserSessions.find(
    (browserSession) =>
      browserSession.status === "open" &&
      (latestJob ? browserSession.sourceJobId === latestJob.id : true)
  );

  const lines: string[] = [];
  if (fileActions.length > 0) {
    const fileNames = fileActions
      .map((action) => action.location)
      .filter((location): location is string => typeof location === "string")
      .map((location) => basenameCrossPlatformPath(location))
      .filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);
    if (fileNames.length > 0) {
      lines.push(`I updated ${joinNaturalList(fileNames)}.`);
    }
  } else if (folderActions.length > 0) {
    const folderNames = folderActions
      .map((action) => action.location)
      .filter((location): location is string => typeof location === "string")
      .map((location) => basenameCrossPlatformPath(location))
      .filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);
    if (folderNames.length > 0) {
      lines.push(`I updated ${joinNaturalList(folderNames)}.`);
    }
  }

  const latestInput = latestJob?.input?.trim() ?? "";
  if (/\bslider\b/i.test(latestInput)) {
    lines.push("The hero section now uses a slider.");
  } else if (/\bcarousel\b/i.test(latestInput)) {
    lines.push("The hero section now uses a carousel.");
  }

  if (openBrowserForLatestJob) {
    lines.push(`The preview is still open at ${openBrowserForLatestJob.url}.`);
  }

  if (lines.length > 0) {
    return lines.join("\n");
  }

  return [
    "Here are the latest changes I made:",
    ...changeActions.slice(0, 3).map(renderRecentActionLine)
  ].join("\n");
}

/**
 * Renders a human summary for natural status, recall, and "where did you put it?" questions.
 *
 * @param session - Current conversation session state.
 * @param userInput - Raw user input used to emphasize the most relevant ledger slice.
 * @returns Human-readable answer grounded in structured session state.
 */
export function renderConversationStatusOrRecall(
  session: ConversationSession,
  userInput: string,
  semanticHint: ConversationIntentSemanticHint | null = null
): string {
  const normalizedInput = userInput.toLowerCase();
  const chatSignals = analyzeConversationChatTurnSignals(userInput);
  const canTrustImplicitSemanticHandoff =
    isImplicitReturnHandoffSemanticHint(semanticHint) &&
    chatSignals.primaryKind !== "plain_chat" &&
    chatSignals.primaryKind !== "self_identity_query" &&
    chatSignals.primaryKind !== "assistant_identity_query";
  const focusOnRecentAction =
    semanticHint === "status_change_summary" ||
    CHANGE_RECALL_PATTERN.test(normalizedInput);
  const focusOnReturnHandoff =
    canTrustImplicitSemanticHandoff ||
    semanticHint === "status_return_handoff" ||
    RETURN_HANDOFF_PATTERN.test(normalizedInput);
  const focusOnLocation =
    semanticHint === "status_location" ||
    /\b(where|desktop|folder|path|put)\b/.test(normalizedInput);
  const focusOnBrowser =
    semanticHint === "status_browser" ||
    /\b(browser|tab|window|leave open|left open|open)\b/.test(normalizedInput);
  const focusOnProgress =
    semanticHint === "status_progress" ||
    /\b(status|doing|happening|working|stuck|waiting|next)\b/.test(normalizedInput);
  const focusOnWaiting =
    semanticHint === "status_waiting" ||
    /\b(waiting on|waiting for|need from me|need from us|what are you waiting on)\b/.test(normalizedInput);

  const lines: string[] = [];
  let recoveryLineAdded = false;

  const progressState = session.progressState;
  const latestRecoveryTrace = latestCompletedJob(session)?.recoveryTrace ?? null;
  if (focusOnWaiting) {
    if (progressState?.status === "waiting_for_user") {
      lines.push(`I'm waiting on you for ${progressState.message}.`);
    } else {
      lines.push("I'm not currently waiting on anything from you.");
    }
  } else if (progressState && (focusOnProgress || (!focusOnLocation && !focusOnBrowser && !focusOnRecentAction))) {
    lines.push(renderProgressStateLine(progressState));
  } else if (focusOnProgress) {
    if (latestRecoveryTrace) {
      lines.push(renderRecoveryTraceLine(latestRecoveryTrace));
      recoveryLineAdded = true;
    } else {
      lines.push("I'm not actively working on anything right now.");
    }
  }

  if (focusOnReturnHandoff && session.returnHandoff) {
    lines.push(renderReturnHandoffSummary(session.returnHandoff, userInput, semanticHint));
  }

  const openBrowserSessions = session.browserSessions.filter((browserSession) => browserSession.status === "open");
  if (focusOnBrowser) {
    const trackedWorkspacePreview = renderActiveWorkspacePreviewLine(session);
    if (trackedWorkspacePreview !== null) {
      lines.push(trackedWorkspacePreview);
    }
    if (openBrowserSessions.length > 0) {
      lines.push("Open browser sessions:");
      lines.push(...openBrowserSessions.slice(0, 3).map(renderBrowserSessionLine));
    } else {
      lines.push("I don't have any tracked browser windows left open right now.");
    }
  }

  if (focusOnLocation) {
    const activeWorkspaceLocation = renderActiveWorkspaceLocation(session);
    if (activeWorkspaceLocation) {
      lines.push(renderActiveWorkspaceHeading(session));
      lines.push(activeWorkspaceLocation);
    }
    if (session.pathDestinations.length > 0) {
      lines.push("Recent locations:");
      lines.push(...session.pathDestinations.slice(0, 3).map(renderPathDestinationLine));
    } else {
      const recentAction = latestConcreteRecentAction(session);
      if (recentAction?.location) {
        lines.push(`The most recent saved or opened location I have is ${recentAction.location}.`);
      } else if (session.activeWorkspace?.rootPath) {
        if (session.activeWorkspace.ownershipState === "orphaned") {
          lines.push(
            `The last attributable project workspace I know about is ${session.activeWorkspace.rootPath}, but I can't prove that preview or process control is still live.`
          );
        } else if (session.activeWorkspace.ownershipState === "stale") {
          lines.push(
            `The last remembered project workspace I have is ${session.activeWorkspace.rootPath}.`
          );
        } else {
          lines.push(`The current project workspace is ${session.activeWorkspace.rootPath}.`);
        }
      } else {
        lines.push("I don't have a recent saved location to point to in this chat yet.");
      }
    }
  }

  if (focusOnRecentAction) {
    const latestChangeSummary = renderLatestChangeSummary(session);
    if (latestChangeSummary) {
      lines.push(latestChangeSummary);
    } else {
      lines.push("I haven't completed a tracked action in this chat yet.");
    }
  }

  if (focusOnWaiting) {
    return lines.join("\n");
  }

  if (
    focusOnProgress &&
    progressState &&
    !focusOnLocation &&
    !focusOnBrowser &&
    !focusOnRecentAction &&
    !focusOnReturnHandoff
  ) {
    return lines.join("\n");
  }

  if (!focusOnLocation && !focusOnBrowser && !focusOnRecentAction && !focusOnReturnHandoff) {
    if (latestRecoveryTrace && !recoveryLineAdded) {
      lines.push(renderRecoveryTraceLine(latestRecoveryTrace));
    }
    if (session.recentActions.length > 0) {
      lines.push("Most recent actions:");
      lines.push(...session.recentActions.slice(0, 3).map(renderRecentActionLine));
    } else {
      if (
        session.returnHandoff &&
        shouldAllowImplicitReturnHandoffStatusFallback(userInput, semanticHint)
      ) {
        lines.push(renderReturnHandoffSummary(session.returnHandoff, userInput, semanticHint));
      } else {
        lines.push("I don't have a tracked status update for that.");
      }
    }
  }

  return lines.join("\n");
}
