/**
 * @fileoverview Stable normalization helpers for persisted browser, path, workspace, and classifier records.
 */

import type {
  ConversationActiveWorkspaceRecord,
  ConversationBrowserSessionRecord,
  ConversationClassifierEvent,
  ConversationClassifierIntent,
  ConversationPathDestinationRecord
} from "./sessionStateContracts";

/**
 * Normalizes persisted domain-snapshot lanes into the supported shared-lane subset.
 *
 * @param value - Persisted candidate lane label.
 * @returns Normalized snapshot lane or `null` when absent/unsupported.
 */
function normalizeDomainSnapshotLane(value: unknown): ConversationActiveWorkspaceRecord["domainSnapshotLane"] {
  return value === "profile" ||
    value === "relationship" ||
    value === "workflow" ||
    value === "system_policy"
    ? value
    : null;
}

/**
 * Normalizes unknown persisted values into integer process ids when available.
 *
 * @param value - Persisted candidate value.
 * @returns Integer pid, or `null` when the value is missing or invalid.
 */
function normalizeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Normalizes one persisted browser-session record into the stable runtime shape.
 */
export function normalizeBrowserSessionRecord(
  candidate: Partial<ConversationBrowserSessionRecord>
): ConversationBrowserSessionRecord | null {
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.label !== "string" ||
    typeof candidate.url !== "string" ||
    (candidate.status !== "open" && candidate.status !== "closed") ||
    typeof candidate.openedAt !== "string" ||
    (candidate.visibility !== "visible" && candidate.visibility !== "headless")
  ) {
    return null;
  }

  return {
    id: candidate.id,
    label: candidate.label,
    url: candidate.url,
    status: candidate.status,
    openedAt: candidate.openedAt,
    closedAt: typeof candidate.closedAt === "string" ? candidate.closedAt : null,
    sourceJobId: typeof candidate.sourceJobId === "string" ? candidate.sourceJobId : null,
    visibility: candidate.visibility,
    controllerKind:
      candidate.controllerKind === "os_default" ? "os_default" : "playwright_managed",
    controlAvailable: candidate.controlAvailable === false ? false : true,
    browserProcessPid: normalizeInteger(candidate.browserProcessPid),
    workspaceRootPath:
      typeof candidate.workspaceRootPath === "string" ? candidate.workspaceRootPath : null,
    linkedProcessLeaseId:
      typeof candidate.linkedProcessLeaseId === "string" ? candidate.linkedProcessLeaseId : null,
    linkedProcessCwd:
      typeof candidate.linkedProcessCwd === "string" ? candidate.linkedProcessCwd : null,
    linkedProcessPid: normalizeInteger(candidate.linkedProcessPid)
  };
}

/**
 * Normalizes one persisted path-destination record into the stable runtime shape.
 */
export function normalizePathDestinationRecord(
  candidate: Partial<ConversationPathDestinationRecord>
): ConversationPathDestinationRecord | null {
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.label !== "string" ||
    typeof candidate.resolvedPath !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    label: candidate.label,
    resolvedPath: candidate.resolvedPath,
    sourceJobId: typeof candidate.sourceJobId === "string" ? candidate.sourceJobId : null,
    updatedAt: candidate.updatedAt
  };
}

/**
 * Normalizes one persisted active-workspace record into the stable runtime shape.
 */
export function normalizeActiveWorkspaceRecord(
  candidate: Partial<ConversationActiveWorkspaceRecord> | null | undefined
): ConversationActiveWorkspaceRecord | null {
  if (
    !candidate ||
    typeof candidate.id !== "string" ||
    typeof candidate.label !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    label: candidate.label,
    rootPath: typeof candidate.rootPath === "string" ? candidate.rootPath : null,
    primaryArtifactPath:
      typeof candidate.primaryArtifactPath === "string" ? candidate.primaryArtifactPath : null,
    previewUrl: typeof candidate.previewUrl === "string" ? candidate.previewUrl : null,
    browserSessionId:
      typeof candidate.browserSessionId === "string" ? candidate.browserSessionId : null,
    browserSessionIds: Array.isArray(candidate.browserSessionIds)
      ? candidate.browserSessionIds.filter(
          (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
        )
      : (typeof candidate.browserSessionId === "string" ? [candidate.browserSessionId] : []),
    browserSessionStatus:
      candidate.browserSessionStatus === "open" || candidate.browserSessionStatus === "closed"
        ? candidate.browserSessionStatus
        : null,
    browserProcessPid: normalizeInteger(candidate.browserProcessPid),
    previewProcessLeaseId:
      typeof candidate.previewProcessLeaseId === "string" ? candidate.previewProcessLeaseId : null,
    previewProcessLeaseIds: Array.isArray(candidate.previewProcessLeaseIds)
      ? candidate.previewProcessLeaseIds.filter(
          (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
        )
      : (typeof candidate.previewProcessLeaseId === "string"
          ? [candidate.previewProcessLeaseId]
          : []),
    previewProcessCwd:
      typeof candidate.previewProcessCwd === "string" ? candidate.previewProcessCwd : null,
    lastKnownPreviewProcessPid: normalizeInteger(candidate.lastKnownPreviewProcessPid),
    stillControllable: candidate.stillControllable === true,
    ownershipState:
      candidate.ownershipState === "tracked" ||
      candidate.ownershipState === "stale" ||
      candidate.ownershipState === "orphaned"
        ? candidate.ownershipState
        : "stale",
    previewStackState:
      candidate.previewStackState === "browser_and_preview" ||
      candidate.previewStackState === "browser_only" ||
      candidate.previewStackState === "preview_only" ||
      candidate.previewStackState === "detached"
        ? candidate.previewStackState
        : "detached",
    lastChangedPaths: Array.isArray(candidate.lastChangedPaths)
      ? candidate.lastChangedPaths.filter(
          (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
        )
      : [],
    sourceJobId: typeof candidate.sourceJobId === "string" ? candidate.sourceJobId : null,
    domainSnapshotLane: normalizeDomainSnapshotLane(candidate.domainSnapshotLane),
    domainSnapshotRecordedAt:
      typeof candidate.domainSnapshotRecordedAt === "string"
        ? candidate.domainSnapshotRecordedAt
        : null,
    updatedAt: candidate.updatedAt
  };
}

/**
 * Normalizes one persisted classifier event into the stable runtime shape.
 */
export function normalizeClassifierEventRecord(
  event: Partial<ConversationClassifierEvent>
): ConversationClassifierEvent | null {
  if (
    (event.classifier !== "follow_up" &&
      event.classifier !== "proposal_reply" &&
      event.classifier !== "pulse_lexical") ||
    typeof event.input !== "string" ||
    typeof event.at !== "string" ||
    typeof event.isShortFollowUp !== "boolean" ||
    (event.category !== "ACK" &&
      event.category !== "APPROVE" &&
      event.category !== "DENY" &&
      event.category !== "UNCLEAR" &&
      event.category !== "COMMAND" &&
      event.category !== "NON_COMMAND") ||
    (event.confidenceTier !== "HIGH" &&
      event.confidenceTier !== "MED" &&
      event.confidenceTier !== "LOW") ||
    typeof event.matchedRuleId !== "string" ||
    typeof event.rulepackVersion !== "string"
  ) {
    return null;
  }

  const intentCandidate = event.intent;
  const normalizedIntent: ConversationClassifierIntent =
    intentCandidate === "APPROVE" ||
    intentCandidate === "CANCEL" ||
    intentCandidate === "ADJUST" ||
    intentCandidate === "QUESTION" ||
    intentCandidate === "on" ||
    intentCandidate === "off" ||
    intentCandidate === "private" ||
    intentCandidate === "public" ||
    intentCandidate === "status" ||
    intentCandidate === null
      ? intentCandidate
      : null;

  return {
    classifier: event.classifier,
    input: event.input,
    at: event.at,
    isShortFollowUp: event.isShortFollowUp,
    category: event.category,
    confidenceTier: event.confidenceTier,
    matchedRuleId: event.matchedRuleId,
    rulepackVersion: event.rulepackVersion,
    intent: normalizedIntent,
    conflict: typeof event.conflict === "boolean" ? event.conflict : false
  };
}
