/**
 * @fileoverview Canonical session-state normalization helpers for interface session runtime flows.
 */

import {
  isConversationStackV1,
  migrateSessionConversationStackToV2
} from "../../core/stage6_86ConversationStack";
import { normalizeConversationDomainContext } from "../../core/sessionContext";
import type { ConversationStackV1, SessionSchemaVersionV1 } from "../../core/types";
import { createEmptyInterfaceSessionFile } from "./sessionPersistence";
import type { InterfaceSessionFile } from "./contracts";
import type { ConversationClassifierEvent, ConversationJob, ConversationSession } from "./sessionStateContracts";
import { normalizeModelBackend } from "../../models/backendConfig";
import {
  normalizeActiveClarification,
  normalizeActiveWorkspaceRecord,
  normalizeBrowserSessionRecord,
  normalizeClassifierEventRecord,
  normalizeConversationJob,
  normalizeConversationTurn,
  normalizeModeContinuityState,
  normalizePathDestinationRecord,
  normalizeProgressStateRecord,
  normalizeReturnHandoffRecord,
  normalizeRecentActionRecord
} from "./sessionNormalizationRecords";
import { normalizeAgentPulseSessionState } from "./sessionPulseNormalization";
import { normalizeConversationTransportIdentity } from "./transportIdentity";

/**
 * Normalizes one persisted conversation session into the stable runtime shape.
 */
export function normalizeSession(raw: Partial<ConversationSession>): ConversationSession | null {
  if (
    typeof raw.conversationId !== "string" ||
    typeof raw.userId !== "string" ||
    typeof raw.username !== "string" ||
    typeof raw.updatedAt !== "string"
  ) {
    return null;
  }

  const activeProposal =
    raw.activeProposal &&
    typeof raw.activeProposal.id === "string" &&
    typeof raw.activeProposal.originalInput === "string" &&
    typeof raw.activeProposal.currentInput === "string" &&
    typeof raw.activeProposal.createdAt === "string" &&
    typeof raw.activeProposal.updatedAt === "string" &&
    typeof raw.activeProposal.status === "string"
      ? {
          id: raw.activeProposal.id,
          originalInput: raw.activeProposal.originalInput,
          currentInput: raw.activeProposal.currentInput,
          createdAt: raw.activeProposal.createdAt,
          updatedAt: raw.activeProposal.updatedAt,
          status: raw.activeProposal.status
        }
      : null;

  const activeClarification = normalizeActiveClarification(raw.activeClarification);
  const queuedJobs = normalizeJobList(raw.queuedJobs);
  const recentJobs = normalizeJobList(raw.recentJobs);
  const conversationTurns = normalizeTurnList(raw.conversationTurns);
  const recentActions = normalizeRecentActionList(raw.recentActions);
  const browserSessions = normalizeBrowserSessionList(raw.browserSessions);
  const pathDestinations = normalizePathDestinationList(raw.pathDestinations);
  const activeWorkspace = normalizeActiveWorkspaceRecord(raw.activeWorkspace);
  const classifierEvents = normalizeClassifierEventList(raw.classifierEvents);

  const sessionSchemaVersionCandidate = normalizeSessionSchemaVersion(raw.sessionSchemaVersion);
  if (raw.sessionSchemaVersion !== undefined && sessionSchemaVersionCandidate === null) {
    return null;
  }

  const existingConversationStack = normalizeConversationStackCandidate(raw.conversationStack);
  if (raw.conversationStack !== undefined && raw.conversationStack !== null && existingConversationStack === null) {
    return null;
  }

  const stackMigration = migrateSessionConversationStackToV2({
    sessionSchemaVersion: sessionSchemaVersionCandidate,
    updatedAt: raw.updatedAt,
    conversationTurns,
    conversationStack: existingConversationStack
  });

  return {
    conversationId: raw.conversationId,
    userId: raw.userId,
    username: raw.username,
    transportIdentity: normalizeConversationTransportIdentity(raw.transportIdentity),
    conversationVisibility:
      raw.conversationVisibility === "private" ||
      raw.conversationVisibility === "public" ||
      raw.conversationVisibility === "unknown"
        ? raw.conversationVisibility
        : "unknown",
    sessionSchemaVersion: stackMigration.sessionSchemaVersion,
    conversationStack: stackMigration.conversationStack,
    updatedAt: raw.updatedAt,
    modelBackendOverride:
      typeof raw.modelBackendOverride === "string"
        ? normalizeModelBackend(raw.modelBackendOverride)
        : null,
    codexAuthProfileId:
      typeof raw.codexAuthProfileId === "string" && raw.codexAuthProfileId.trim().length > 0
        ? raw.codexAuthProfileId.trim()
        : null,
    activeProposal,
    activeClarification,
    domainContext: normalizeConversationDomainContext(raw.domainContext, raw.conversationId),
    modeContinuity: normalizeModeContinuityState(raw.modeContinuity),
    progressState: normalizeProgressStateRecord(raw.progressState),
    returnHandoff: normalizeReturnHandoffRecord(raw.returnHandoff),
    runningJobId: typeof raw.runningJobId === "string" ? raw.runningJobId : null,
    queuedJobs,
    recentJobs,
    recentActions,
    browserSessions,
    pathDestinations,
    activeWorkspace,
    conversationTurns,
    classifierEvents,
    agentPulse: normalizeAgentPulseSessionState(raw.agentPulse)
  };
}

/**
 * Normalizes persisted interface-session state into the stable runtime shape.
 */
export function normalizeState(raw: Partial<InterfaceSessionFile>): InterfaceSessionFile {
  if (!raw.conversations || typeof raw.conversations !== "object") {
    return createEmptyInterfaceSessionFile();
  }

  const normalizedConversations: Record<string, ConversationSession> = {};
  for (const [key, value] of Object.entries(raw.conversations)) {
    const normalized = normalizeSession(value as Partial<ConversationSession>);
    if (normalized) {
      normalizedConversations[key] = normalized;
    }
  }

  return {
    conversations: normalizedConversations
  };
}

/**
 * Normalizes a persisted queued/recent job list into the stable session runtime shape.
 *
 * @param rawJobs - Unknown persisted job payload.
 * @returns Normalized conversation jobs.
 */
function normalizeJobList(rawJobs: unknown): ConversationJob[] {
  return Array.isArray(rawJobs)
    ? rawJobs
        .map((job) => normalizeConversationJob(job as Partial<ConversationJob>))
        .filter((job): job is ConversationJob => job !== null)
    : [];
}

/**
 * Normalizes persisted conversation turns into the stable turn shape.
 *
 * @param rawTurns - Unknown persisted turn payload.
 * @returns Normalized conversation turns.
 */
function normalizeTurnList(rawTurns: unknown): ConversationSession["conversationTurns"] {
  return Array.isArray(rawTurns)
    ? rawTurns
        .map((turn) =>
          normalizeConversationTurn(turn as Partial<ConversationSession["conversationTurns"][number]>)
        )
        .filter((turn): turn is ConversationSession["conversationTurns"][number] => turn !== null)
    : [];
}

/**
 * Normalizes persisted recent-action records into the stable ledger shape.
 *
 * @param rawActions - Unknown persisted recent-action payload.
 * @returns Normalized recent-action records.
 */
function normalizeRecentActionList(rawActions: unknown): ConversationSession["recentActions"] {
  return Array.isArray(rawActions)
    ? rawActions
        .map((action) =>
          normalizeRecentActionRecord(action as Partial<ConversationSession["recentActions"][number]>)
        )
        .filter((action): action is ConversationSession["recentActions"][number] => action !== null)
    : [];
}

/**
 * Normalizes persisted browser-session records into the stable runtime shape.
 *
 * @param rawBrowserSessions - Unknown persisted browser-session payload.
 * @returns Normalized browser session records.
 */
function normalizeBrowserSessionList(
  rawBrowserSessions: unknown
): ConversationSession["browserSessions"] {
  return Array.isArray(rawBrowserSessions)
    ? rawBrowserSessions
        .map((browserSession) =>
          normalizeBrowserSessionRecord(
            browserSession as Partial<ConversationSession["browserSessions"][number]>
          )
        )
        .filter(
          (browserSession): browserSession is ConversationSession["browserSessions"][number] =>
            browserSession !== null
        )
    : [];
}

/**
 * Normalizes persisted path-destination records into the stable runtime shape.
 *
 * @param rawDestinations - Unknown persisted destination payload.
 * @returns Normalized destination records.
 */
function normalizePathDestinationList(
  rawDestinations: unknown
): ConversationSession["pathDestinations"] {
  return Array.isArray(rawDestinations)
    ? rawDestinations
        .map((destination) =>
          normalizePathDestinationRecord(
            destination as Partial<ConversationSession["pathDestinations"][number]>
          )
        )
        .filter(
          (destination): destination is ConversationSession["pathDestinations"][number] =>
            destination !== null
        )
    : [];
}

/**
 * Normalizes persisted classifier events into the stable interface-session shape.
 *
 * @param rawEvents - Unknown persisted classifier-event payload.
 * @returns Normalized classifier events.
 */
function normalizeClassifierEventList(rawEvents: unknown): ConversationClassifierEvent[] {
  return Array.isArray(rawEvents)
    ? rawEvents
        .map((event) => normalizeClassifierEventRecord(event as Partial<ConversationClassifierEvent>))
        .filter((event): event is ConversationClassifierEvent => event !== null)
    : [];
}

/**
 * Validates a persisted session schema version marker.
 *
 * @param candidate - Unknown persisted schema version.
 * @returns Supported schema version, or `null` when absent/invalid.
 */
function normalizeSessionSchemaVersion(
  candidate: unknown
): SessionSchemaVersionV1 | null {
  if (candidate === undefined) {
    return null;
  }
  return candidate === "v1" || candidate === "v2" ? candidate : null;
}

/**
 * Validates a persisted conversation stack candidate before migration to the current runtime shape.
 *
 * @param candidate - Unknown persisted conversation stack payload.
 * @returns Supported stack object, or `null` when absent/invalid.
 */
function normalizeConversationStackCandidate(candidate: unknown): ConversationStackV1 | null {
  if (candidate === undefined || candidate === null) {
    return null;
  }
  return isConversationStackV1(candidate) ? candidate : null;
}
