/**
 * @fileoverview Runs deterministic inbound-message, command, proposal-flow, and stale-job recovery lifecycle for ConversationManager.
 */

import {
  resolveConversationInboundUserInput,
  type ConversationInboundMessage,
  type ConversationNotifier,
  type ExecuteConversationTask
} from "./conversationRuntime/managerContracts";
import { detectTimezoneFromMessage } from "./conversationRuntime/sessionPulseMetadata";
import {
  buildConversationKey,
  buildSessionSeed
} from "./conversationManagerHelpers";
import { createProfileMemoryRequestTelemetry } from "../core/profileMemoryRuntime/profileMemoryRequestTelemetry";
import type { ProfileMemoryRequestTelemetry } from "../core/profileMemoryRuntime/contracts";
import { appendMemoryAccessAudit } from "../organs/memoryContext/auditEvents";
import { normalizeConversationTransportIdentity } from "./conversationRuntime/transportIdentity";
import { reconcileInterpretedEntityAliasCandidateForTurn } from "./conversationRuntime/contextualEntityReferenceInterpretationSupport";
import { backfillPulseResponseOutcome, expireStaleEmissions } from "./pulseEmissionLifecycle";
import { backfillTurnsFromRecentJobsIfNeeded } from "./conversationSessionMutations";
import type { ConversationIngressDependencies } from "./conversationRuntime/contracts";
import {
  handleConversationCommand
} from "./conversationRuntime/commandDispatch";
import { resolveConversationInvocation } from "./conversationRuntime/invocationResolution";
import { recoverStaleRunningJobIfNeeded } from "./conversationRuntime/sessionRecovery";

const STARTING_WORK_REPLY_MAX_CHARS = 96;

/**
 * Builds a bounded preview of the work the runtime is about to start.
 *
 * @param input - Canonical inbound user input for the job being started.
 * @returns Short human-readable preview safe for first acknowledgements.
 */
function summarizeStartedWorkInput(input: string): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "your request";
  }
  if (normalized.length <= STARTING_WORK_REPLY_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, STARTING_WORK_REPLY_MAX_CHARS - 3)}...`;
}

/**
 * Renders the first acknowledgement for work that has started immediately.
 *
 * @param input - Canonical inbound user input for the job being started.
 * @returns Human-first acknowledgement shown before background completion delivery.
 */
function buildStartedWorkReply(input: string): string {
  return `On it. I'll start with: ${summarizeStartedWorkInput(input)}`;
}

/**
 * Persists one bounded alias-safety telemetry snapshot for a direct alias-clarification turn.
 *
 * @param deps - Ingress dependencies carrying the optional audit store.
 * @param userInput - Raw user wording that triggered alias reconciliation.
 * @param receivedAt - Timestamp attached to the inbound turn.
 * @param requestTelemetry - Request-scoped telemetry collected during alias reconciliation.
 */
async function recordDirectAliasSafetyAuditIfNeeded(
  deps: Pick<ConversationIngressDependencies, "memoryAccessAuditStore">,
  userInput: string,
  receivedAt: string,
  requestTelemetry: ProfileMemoryRequestTelemetry
): Promise<void> {
  if (
    !deps.memoryAccessAuditStore ||
    requestTelemetry.aliasSafetyDecisionCount === 0
  ) {
    return;
  }
  await appendMemoryAccessAudit(
    deps.memoryAccessAuditStore,
    `direct_entity_alias:${receivedAt}`,
    userInput,
    0,
    0,
    0,
    ["profile"],
    {
      aliasSafetyDecisionCount: requestTelemetry.aliasSafetyDecisionCount
    }
  );
}

/**
 * Memoizes one bounded entity-reference interpreter for the lifetime of a single inbound turn so
 * direct-reply execution-input assembly and later alias reconciliation do not pay for the same
 * semantic call twice.
 *
 * @param resolver - Optional shared entity-reference interpreter.
 * @returns Per-turn memoized resolver preserving fail-closed behavior.
 */
function memoizeEntityReferenceInterpretationResolver(
  resolver: ConversationIngressDependencies["entityReferenceInterpretationResolver"]
): ConversationIngressDependencies["entityReferenceInterpretationResolver"] {
  if (!resolver) {
    return resolver;
  }
  const cache = new Map<string, ReturnType<typeof resolver>>();
  return async (request) => {
    const cacheKey = JSON.stringify(request);
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const pending = resolver(request);
    cache.set(cacheKey, pending);
    return pending;
  };
}

/**
 * Processes one inbound message through command/pulse/proposal/queueing paths and persists session mutations.
 *
 * @param message - Inbound provider message.
 * @param executeTask - Runtime execute callback for direct proposal-question handling.
 * @param notify - Notifier callback or transport for queued work.
 * @param deps - Conversation manager lifecycle dependencies.
 * @returns User-facing reply string for this inbound message.
 */
export async function processConversationMessage(
  message: ConversationInboundMessage,
  executeTask: ExecuteConversationTask,
  notify: ConversationNotifier,
  deps: ConversationIngressDependencies
): Promise<string> {
  const trimmed = resolveConversationInboundUserInput(message).trim();
  if (!trimmed) {
    return "I did not receive any text yet. Send a quick message or add a caption and I will continue.";
  }

  const sessionKey = buildConversationKey(message);
  const requestTelemetry = createProfileMemoryRequestTelemetry();
  const memoizedEntityReferenceInterpretationResolver =
    memoizeEntityReferenceInterpretationResolver(deps.entityReferenceInterpretationResolver);
  const invocationDeps: ConversationIngressDependencies = {
    ...deps,
    entityReferenceInterpretationResolver: memoizedEntityReferenceInterpretationResolver
  };
  deps.setWorkerBinding(sessionKey, executeTask, notify);
  const session = (await deps.store.getSession(sessionKey)) ?? buildSessionSeed(message);
  recoverStaleRunningJobIfNeeded({
    sessionKey,
    session,
    nowIso: message.receivedAt,
    deps
  });
  backfillTurnsFromRecentJobsIfNeeded(
    session,
    deps.config.maxContextTurnsForExecution,
    deps.config.maxConversationTurns
  );
  session.username = message.username;
  session.transportIdentity =
    normalizeConversationTransportIdentity(message.transportIdentity) ?? session.transportIdentity;
  session.conversationVisibility = message.conversationVisibility;
  session.updatedAt = message.receivedAt;

  const receivedMs = Date.parse(message.receivedAt);
  backfillPulseResponseOutcome(session, trimmed, receivedMs);
  expireStaleEmissions(session, receivedMs);

  const detectedTz = detectTimezoneFromMessage(trimmed);
  if (detectedTz && detectedTz !== session.agentPulse.userTimezone) {
    session.agentPulse.userTimezone = detectedTz;
  }

  if (trimmed.startsWith("/")) {
    const reply = await handleConversationCommand(session, message, deps);
    await deps.store.setSession(session);
    if (session.queuedJobs.length > 0) {
      void deps.startWorkerIfNeeded(sessionKey, executeTask, notify);
    }
    return reply;
  }

  await reconcileInterpretedEntityAliasCandidateForTurn(
    session,
    trimmed,
    message.receivedAt,
    deps.getEntityGraph,
    memoizedEntityReferenceInterpretationResolver,
    deps.reconcileEntityAliasCandidate,
    requestTelemetry
  );
  await recordDirectAliasSafetyAuditIfNeeded(
    deps,
    trimmed,
    message.receivedAt,
    requestTelemetry
  );
  const invocation = await resolveConversationInvocation(
    session,
    message,
    executeTask,
    invocationDeps
  );
  await deps.store.setSession(session);
  if (invocation.shouldStartWorker) {
    void deps.startWorkerIfNeeded(sessionKey, executeTask, notify);
  }
  if (invocation.shouldStartWorker && invocation.reply.trim().length === 0) {
    return buildStartedWorkReply(trimmed);
  }
  return invocation.reply;
}

