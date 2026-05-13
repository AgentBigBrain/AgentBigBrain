/**
 * @fileoverview Canonical inbound conversation-dispatch helpers shared by Discord and Telegram gateways.
 */

import type {
  ConversationExecutionProgressUpdate,
  ConversationExecutionResult,
  ConversationDeliveryResult,
  ConversationInboundMessage,
  ConversationNotifierTransport,
  ExecuteConversationTask
} from "../conversationRuntime/managerContracts";
import { parseAutonomousExecutionInput } from "../conversationRuntime/managerContracts";
import type { TaskRunResult } from "../../core/types";
import type {
  EntityGraphStoreLike,
  EntityGraphActorEvidenceContext,
  InboundEntityGraphMutationInput
} from "../entityGraphRuntime";
import { maybeRecordInboundEntityGraphMutation } from "../entityGraphRuntime";
import type { OwnerOperatorPrincipalConfig } from "../principalRuntime/principalConfig";
import {
  derivePrincipalContextFromIngress,
  requirePrincipalAccessForOperation
} from "../principalRuntime/principalAccess";
import type {
  EntityDomainHintInterpretationResolver,
  EntityTypeInterpretationResolver
} from "../../organs/languageUnderstanding/localIntentModelContracts";
import { runAutonomousTransportTask } from "./deliveryLifecycle";
import { buildAutonomousAbortControllerKey } from "./autonomousAbortControl";

/**
 * Formats one transport delivery failure into a stable error message while preserving provider
 * detail when the transport exposed it.
 *
 * @param result - Failed delivery result from the active transport.
 * @param fallbackFailureCode - Stable fallback code when the transport omitted one.
 * @returns Error message safe to throw through the gateway poll loop.
 */
function buildTransportDeliveryFailureMessage(
  result: ConversationDeliveryResult,
  fallbackFailureCode: string
): string {
  const code = result.errorCode ?? fallbackFailureCode;
  const detail = typeof result.errorDetail === "string" ? result.errorDetail.trim() : "";
  return detail ? `${code}: ${detail}` : code;
}

export interface ConversationManagerLike {
  handleMessage(
    inbound: ConversationInboundMessage,
    executeTask: ExecuteConversationTask,
    notify: ConversationNotifierTransport
  ): Promise<string>;
}

export interface HandleAcceptedTransportConversationInput {
  inbound: ConversationInboundMessage;
  entityGraphEvent: InboundEntityGraphMutationInput;
  notifier: ConversationNotifierTransport;
  conversationManager: ConversationManagerLike;
  entityGraphStore: EntityGraphStoreLike;
  dynamicPulseEnabled: boolean;
  principalConfig?: OwnerOperatorPrincipalConfig;
  allowedUserIds?: readonly string[];
  allowedUsernames?: readonly string[];
  abortControllers: Map<string, AbortController>;
  entityTypeInterpretationResolver?: EntityTypeInterpretationResolver;
  entityDomainHintInterpretationResolver?: EntityDomainHintInterpretationResolver;
  resolveEntityGraphDomainHint?():
    Promise<"profile" | "relationship" | "workflow" | "system_policy" | null>;
  runTextTask(
    input: string,
    receivedAt: string,
    onProgressUpdate?: (update: ConversationExecutionProgressUpdate) => Promise<void>
  ): Promise<ConversationExecutionResult | TaskRunResult | string>;
  runAutonomousTask(
    goal: string,
    receivedAt: string,
    progressSender: (message: string) => Promise<void>,
    signal: AbortSignal,
    initialExecutionInput?: string | null,
    onProgressUpdate?: (update: ConversationExecutionProgressUpdate) => Promise<void>
  ): Promise<ConversationExecutionResult>;
  deliverReply(reply: string): Promise<ConversationDeliveryResult>;
  deliveryFailureCode: string;
  onEntityGraphMutationFailure?(error: Error): void;
  onEmptyReply?(): void;
}

/**
 * Normalizes transport text-task output into the canonical conversation execution result shape.
 *
 * **Why it exists:**
 * Gateways already return a normalized execution result, but transport tests and narrow helper
 * call sites may still provide a summary string or raw `TaskRunResult`. This keeps the
 * transport seam tolerant without leaking shape ambiguity through the rest of the interface
 * runtime.
 *
 * **What it talks to:**
 * - Uses `ConversationExecutionResult` (import type `ConversationExecutionResult`) from
 *   `../conversationRuntime/managerContracts`.
 * - Uses `TaskRunResult` (import type `TaskRunResult`) from `../../core/types`.
 *
 * @param result - Raw text-task result returned by the transport caller.
 * @returns Canonical conversation execution result with a stable `summary`.
 */
function normalizeConversationExecutionResult(
  result: ConversationExecutionResult | TaskRunResult | string
): ConversationExecutionResult {
  if (typeof result === "string") {
    return { summary: result };
  }

  if (isTaskRunResult(result)) {
    return {
      summary: result.summary,
      taskRunResult: result
    };
  }

  return {
    summary: result.summary,
    taskRunResult: result.taskRunResult ?? null
  };
}

/**
 * Determines whether a transport execution value is a raw `TaskRunResult`.
 *
 * **Why it exists:**
 * `TaskRunResult` and `ConversationExecutionResult` both carry `summary`, so the transport seam
 * needs a stronger discriminator before deciding whether to preserve a raw orchestrator result or
 * just a normalized summary wrapper.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` (import type `TaskRunResult`) from `../../core/types`.
 *
 * @param result - Candidate execution payload returned by a transport caller.
 * @returns `true` when the value matches the raw orchestrator result contract.
 */
function isTaskRunResult(
  result: ConversationExecutionResult | TaskRunResult
): result is TaskRunResult {
  return (
    "task" in result &&
    "plan" in result &&
    "actionResults" in result &&
    "startedAt" in result &&
    "completedAt" in result
  );
}

/**
 * Delivers a transport-facing reject/stop response when text is available.
 *
 * @param responseText - User-facing response text, or `null` when nothing should be sent.
 * @param deliverResponse - Gateway-bound response delivery callback.
 * @param fallbackFailureCode - Stable fallback error code when delivery fails without one.
 * @returns `true` when a response was delivered, otherwise `false`.
 */
export async function deliverPreparedTransportResponse(
  responseText: string | null,
  deliverResponse: (text: string) => Promise<ConversationDeliveryResult>,
  fallbackFailureCode: string
): Promise<boolean> {
  if (!responseText) {
    return false;
  }
  const sendResult = await deliverResponse(responseText);
  if (!sendResult.ok) {
    throw new Error(buildTransportDeliveryFailureMessage(sendResult, fallbackFailureCode));
  }
  return true;
}

/**
 * Executes the accepted inbound conversation path shared by Discord and Telegram gateways.
 *
 * @param input - Gateway-scoped dependencies for one accepted inbound event.
 */
export async function handleAcceptedTransportConversation(
  input: HandleAcceptedTransportConversationInput
): Promise<void> {
  const domainHint = await input.resolveEntityGraphDomainHint?.();
  const actorEvidence = buildInboundEntityGraphActorEvidence(input);
  await maybeRecordInboundEntityGraphMutation(
    input.entityGraphStore,
    input.dynamicPulseEnabled,
    {
      ...input.entityGraphEvent,
      actorEvidence,
      domainHint: domainHint ?? null
    },
    {
      entityTypeInterpretationResolver: input.entityTypeInterpretationResolver,
      entityDomainHintInterpretationResolver: input.entityDomainHintInterpretationResolver
    },
    input.onEntityGraphMutationFailure
  );

  const reply = await input.conversationManager.handleMessage(
    input.inbound,
    buildTransportExecutionTask(input),
    input.notifier
  );

  if (!reply.trim()) {
    input.onEmptyReply?.();
    return;
  }

  const sendResult = await input.deliverReply(reply);
  if (!sendResult.ok) {
    throw new Error(
      buildTransportDeliveryFailureMessage(sendResult, input.deliveryFailureCode)
    );
  }
}

/**
 * Implements `buildInboundEntityGraphActorEvidence` behavior within this module.
 */
function buildInboundEntityGraphActorEvidence(
  input: HandleAcceptedTransportConversationInput
): EntityGraphActorEvidenceContext | null {
  const principalContext = derivePrincipalContextFromIngress({
    provider: input.inbound.provider,
    conversationId: input.inbound.conversationId,
    userId: input.inbound.userId,
    username: input.inbound.username,
    conversationVisibility: input.inbound.conversationVisibility,
    transportIdentity: input.inbound.transportIdentity ?? null,
    receivedAt: input.inbound.receivedAt,
    principalConfig: input.principalConfig,
    allowedUserIds: input.allowedUserIds,
    allowedUsernames: input.allowedUsernames
  });
  const accessDecision = requirePrincipalAccessForOperation({
    principalContext,
    operation: "entity_graph_write",
    accessClass:
      principalContext.route.visibility === "public"
        ? "shared_public"
        : principalContext.actor.principalRole === "legacy_unknown"
          ? "session_only"
          : principalContext.actor.principalRole === "owner"
            ? "owner_private"
            : principalContext.actor.principalRole === "operator"
              ? "operator_private"
              : "speaker_private",
    allowed: principalContext.actor.principalRole !== "legacy_unknown",
    reason:
      principalContext.actor.principalRole === "legacy_unknown"
        ? "missing_principal_scope"
        : principalContext.route.visibility === "public"
          ? "public_safe"
          : principalContext.actor.principalRole === "owner"
            ? "owner_principal_matched"
            : principalContext.actor.principalRole === "operator"
              ? "operator_principal_matched"
              : "speaker_scope_matched"
  }).accessDecision;
  if (!principalContext.actor.providerUserIdHash) {
    return null;
  }
  return {
    principalIdHash: principalContext.actor.providerUserIdHash,
    principalRole: principalContext.actor.principalRole,
    accessClass: accessDecision.accessClass as EntityGraphActorEvidenceContext["accessClass"],
    routeVisibility: principalContext.route.visibility,
    legacyIdentityState: principalContext.actor.legacyIdentityState
  };
}

/**
 * Builds the canonical execution callback used by transport-managed conversations.
 *
 * @param input - Accepted inbound transport context.
 * @returns Execution callback passed into `ConversationManager.handleMessage(...)`.
 */
function buildTransportExecutionTask(
  input: HandleAcceptedTransportConversationInput
): ExecuteConversationTask {
  return async (
    taskInput: string,
    receivedAt: string,
    onProgressUpdate?: (update: ConversationExecutionProgressUpdate) => Promise<void>
  ) => {
    const autonomousGoal = parseAutonomousExecutionInput(taskInput);
    if (autonomousGoal) {
      return await runAutonomousTransportTask({
        conversationId: buildAutonomousAbortControllerKey({
          provider: input.inbound.provider,
          conversationId: input.inbound.conversationId,
          userId: input.inbound.userId
        }),
        goal: autonomousGoal.goal,
        initialExecutionInput: autonomousGoal.initialExecutionInput,
        receivedAt,
        notifier: input.notifier,
        abortControllers: input.abortControllers,
        runAutonomousTask: input.runAutonomousTask,
        onProgressUpdate
      });
    }

    return normalizeConversationExecutionResult(
      await input.runTextTask(taskInput, receivedAt, onProgressUpdate)
    );
  };
}
