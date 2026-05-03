/**
 * @fileoverview Fail-closed router for optional local intent-model execution.
 */

import type {
  AutonomyBoundaryInterpretationRequest,
  AutonomyBoundaryInterpretationResolver,
  AutonomyBoundaryInterpretationSignal,
  BridgeQuestionTimingInterpretationRequest,
  BridgeQuestionTimingInterpretationResolver,
  BridgeQuestionTimingInterpretationSignal,
  ContinuationInterpretationRequest,
  ContinuationInterpretationResolver,
  ContinuationInterpretationSignal,
  ContextualFollowupInterpretationRequest,
  ContextualFollowupInterpretationResolver,
  ContextualFollowupInterpretationSignal,
  ContextualReferenceInterpretationRequest,
  ContextualReferenceInterpretationResolver,
  ContextualReferenceInterpretationSignal,
  EntityDomainHintInterpretationRequest,
  EntityDomainHintInterpretationResolver,
  EntityDomainHintInterpretationSignal,
  EntityReferenceInterpretationRequest,
  EntityReferenceInterpretationResolver,
  EntityReferenceInterpretationSignal,
  EntityTypeInterpretationRequest,
  EntityTypeInterpretationResolver,
  EntityTypeInterpretationSignal,
  HandoffControlInterpretationRequest,
  HandoffControlInterpretationResolver,
  HandoffControlInterpretationSignal,
  IdentityInterpretationRequest,
  IdentityInterpretationResolver,
  IdentityInterpretationSignal,
  LocalIntentModelRequest,
  LocalIntentModelResolver,
  LocalIntentModelSignal,
  RelationshipInterpretationRequest,
  RelationshipInterpretationResolver,
  RelationshipInterpretationSignal,
  StatusRecallBoundaryInterpretationRequest,
  StatusRecallBoundaryInterpretationResolver,
  StatusRecallBoundaryInterpretationSignal,
  TopicKeyInterpretationRequest,
  TopicKeyInterpretationResolver,
  TopicKeyInterpretationSignal
} from "./localIntentModelContracts";
import type {
  ProposalReplyInterpretationRequest,
  ProposalReplyInterpretationResolver,
  ProposalReplyInterpretationSignal
} from "./localIntentModelProposalReplyContracts";

export type LocalModelRouteDiagnosticStatus =
  | "ok"
  | "disabled"
  | "no_signal"
  | "timeout"
  | "malformed_response"
  | "unavailable"
  | "low_confidence";

export interface LocalModelRouteDiagnostic {
  status: LocalModelRouteDiagnosticStatus;
}

export interface LocalModelRouteResult<TResult> {
  result: TResult | null;
  diagnostic: LocalModelRouteDiagnostic;
}

/**
 * Returns whether one local model result carries low confidence.
 *
 * @param result - Local model result to inspect.
 * @returns `true` when the result explicitly reports low confidence.
 */
function isLowConfidenceLocalModelResult(result: unknown): boolean {
  if (result === null || typeof result !== "object") {
    return false;
  }
  return "confidence" in result && (result as { confidence?: unknown }).confidence === "low";
}

/**
 * Classifies local model execution failures without exposing prompt or response content.
 *
 * @param error - Failure thrown by a local model resolver.
 * @returns Stable diagnostic status for the failure.
 */
function classifyLocalModelError(error: unknown): LocalModelRouteDiagnosticStatus {
  if (error instanceof SyntaxError) {
    return "malformed_response";
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timeout") || message.includes("timed out")) {
    return "timeout";
  }
  return "unavailable";
}

/**
 * Executes one bounded local-model task with typed fail-closed diagnostics.
 *
 * @param request - Canonical task request.
 * @param resolver - Optional task resolver.
 * @returns Task result plus a prompt-safe diagnostic.
 */
async function routeOptionalLocalModelTaskWithDiagnostics<TRequest, TResult>(
  request: TRequest,
  resolver?: (request: TRequest) => Promise<TResult | null>
): Promise<LocalModelRouteResult<TResult>> {
  if (!resolver) {
    return {
      result: null,
      diagnostic: { status: "disabled" }
    };
  }

  try {
    const result = await resolver(request);
    if (!result) {
      return {
        result: null,
        diagnostic: { status: "no_signal" }
      };
    }
    return {
      result,
      diagnostic: {
        status: isLowConfidenceLocalModelResult(result) ? "low_confidence" : "ok"
      }
    };
  } catch (error) {
    return {
      result: null,
      diagnostic: { status: classifyLocalModelError(error) }
    };
  }
}

/**
 * Executes one bounded local-model task and fails closed on missing resolvers or thrown errors.
 *
 * @param request - Canonical task request.
 * @param resolver - Optional task resolver.
 * @returns Task result when one was produced safely, otherwise `null`.
 */
async function routeOptionalLocalModelTask<TRequest, TResult>(
  request: TRequest,
  resolver?: (request: TRequest) => Promise<TResult | null>
): Promise<TResult | null> {
  const routed = await routeOptionalLocalModelTaskWithDiagnostics(request, resolver);
  return routed.result;
}

/**
 * Executes the optional local intent-model path and fails closed on missing resolvers or errors.
 *
 * @param request - Canonical local intent-model request.
 * @param resolver - Optional local model resolver.
 * @returns Local model signal when one was produced safely, otherwise `null`.
 */
export async function routeLocalIntentModel(
  request: LocalIntentModelRequest,
  resolver?: LocalIntentModelResolver
): Promise<LocalIntentModelSignal | null> {
  return routeOptionalLocalModelTask(request, resolver);
}

/**
 * Executes the optional local intent-model path with typed diagnostics.
 *
 * @param request - Canonical local intent-model request.
 * @param resolver - Optional local model resolver.
 * @returns Local model signal plus a prompt-safe diagnostic.
 */
export async function routeLocalIntentModelWithDiagnostics(
  request: LocalIntentModelRequest,
  resolver?: LocalIntentModelResolver
): Promise<LocalModelRouteResult<LocalIntentModelSignal>> {
  return routeOptionalLocalModelTaskWithDiagnostics(request, resolver);
}

/**
 * Executes the optional local identity-interpretation task and fails closed on missing resolvers
 * or errors.
 *
 * @param request - Canonical identity-interpretation request.
 * @param resolver - Optional identity-interpreter resolver.
 * @returns Identity interpretation when one was produced safely, otherwise `null`.
 */
export async function routeIdentityInterpretationModel(
  request: IdentityInterpretationRequest,
  resolver?: IdentityInterpretationResolver
): Promise<IdentityInterpretationSignal | null> {
  return routeOptionalLocalModelTask(request, resolver);
}

/**
 * Executes the optional local relationship-interpretation task and fails closed on missing
 * resolvers or errors.
 *
 * @param request - Canonical relationship-interpretation request.
 * @param resolver - Optional relationship interpreter.
 * @returns Relationship interpretation when one was produced safely, otherwise `null`.
 */
export async function routeRelationshipInterpretationModel(
  request: RelationshipInterpretationRequest,
  resolver?: RelationshipInterpretationResolver
): Promise<RelationshipInterpretationSignal | null> {
  return routeOptionalLocalModelTask(request, resolver);
}

/**
 * Executes the optional local proposal-reply-interpretation task and fails closed on missing
 * resolvers or errors.
 *
 * @param request - Canonical proposal-reply request.
 * @param resolver - Optional proposal-reply interpreter.
 * @returns Proposal-reply interpretation when one was produced safely, otherwise `null`.
 */
export async function routeProposalReplyInterpretationModel(
  request: ProposalReplyInterpretationRequest,
  resolver?: ProposalReplyInterpretationResolver
): Promise<ProposalReplyInterpretationSignal | null> {
  return routeOptionalLocalModelTask(request, resolver);
}

/**
 * Executes the optional local continuation-interpretation task and fails closed on missing
 * resolvers or errors.
 *
 * @param request - Canonical continuation-interpretation request.
 * @param resolver - Optional continuation-interpreter resolver.
 * @returns Continuation interpretation when one was produced safely, otherwise `null`.
 */
export async function routeContinuationInterpretationModel(
  request: ContinuationInterpretationRequest,
  resolver?: ContinuationInterpretationResolver
): Promise<ContinuationInterpretationSignal | null> {
  return routeOptionalLocalModelTask(request, resolver);
}

/**
 * Executes the optional local contextual-reference-interpretation task and fails closed on missing
 * resolvers or errors.
 *
 * @param request - Canonical contextual-reference request.
 * @param resolver - Optional contextual-reference interpreter.
 * @returns Contextual-reference interpretation when one was produced safely, otherwise `null`.
 */
export async function routeContextualReferenceInterpretationModel(
  request: ContextualReferenceInterpretationRequest,
  resolver?: ContextualReferenceInterpretationResolver
): Promise<ContextualReferenceInterpretationSignal | null> {
  return routeOptionalLocalModelTask(request, resolver);
}

/**
 * Executes the optional local topic-key-interpretation task and fails closed on missing resolvers
 * or errors.
 *
 * @param request - Canonical topic-key request.
 * @param resolver - Optional topic-key interpreter.
 * @returns Topic-key interpretation when one was produced safely, otherwise `null`.
 */
export async function routeTopicKeyInterpretationModel(
  request: TopicKeyInterpretationRequest,
  resolver?: TopicKeyInterpretationResolver
): Promise<TopicKeyInterpretationSignal | null> {
  return routeOptionalLocalModelTask(request, resolver);
}

/**
 * Executes the optional local entity-reference-interpretation task and fails closed on missing
 * resolvers or errors.
 *
 * @param request - Canonical entity-reference request.
 * @param resolver - Optional entity-reference interpreter.
 * @returns Entity-reference interpretation when one was produced safely, otherwise `null`.
 */
export async function routeEntityReferenceInterpretationModel(
  request: EntityReferenceInterpretationRequest,
  resolver?: EntityReferenceInterpretationResolver
): Promise<EntityReferenceInterpretationSignal | null> {
  return routeOptionalLocalModelTask(request, resolver);
}

/**
 * Executes the optional local entity-type-interpretation task and fails closed on missing
 * resolvers or errors.
 *
 * @param request - Canonical entity-type request.
 * @param resolver - Optional entity-type interpreter.
 * @returns Entity-type interpretation when one was produced safely, otherwise `null`.
 */
export async function routeEntityTypeInterpretationModel(
  request: EntityTypeInterpretationRequest,
  resolver?: EntityTypeInterpretationResolver
): Promise<EntityTypeInterpretationSignal | null> {
  return routeOptionalLocalModelTask(request, resolver);
}

/**
 * Executes the optional local entity-domain-hint-interpretation task and fails closed on missing
 * resolvers or errors.
 *
 * @param request - Canonical entity-domain-hint request.
 * @param resolver - Optional entity-domain-hint interpreter.
 * @returns Entity-domain-hint interpretation when one was produced safely, otherwise `null`.
 */
export async function routeEntityDomainHintInterpretationModel(
  request: EntityDomainHintInterpretationRequest,
  resolver?: EntityDomainHintInterpretationResolver
): Promise<EntityDomainHintInterpretationSignal | null> {
  return routeOptionalLocalModelTask(request, resolver);
}

/**
 * Executes the optional local handoff-control-interpretation task and fails closed on missing
 * resolvers or errors.
 *
 * @param request - Canonical handoff-control request.
 * @param resolver - Optional handoff-control interpreter.
 * @returns Handoff-control interpretation when one was produced safely, otherwise `null`.
 */
export async function routeHandoffControlInterpretationModel(
  request: HandoffControlInterpretationRequest,
  resolver?: HandoffControlInterpretationResolver
): Promise<HandoffControlInterpretationSignal | null> {
  return routeOptionalLocalModelTask(request, resolver);
}

/**
 * Executes the optional local contextual-followup-interpretation task and fails closed on missing
 * resolvers or errors.
 *
 * @param request - Canonical contextual-followup request.
 * @param resolver - Optional contextual-followup interpreter.
 * @returns Contextual-followup interpretation when one was produced safely, otherwise `null`.
 */
export async function routeContextualFollowupInterpretationModel(
  request: ContextualFollowupInterpretationRequest,
  resolver?: ContextualFollowupInterpretationResolver
): Promise<ContextualFollowupInterpretationSignal | null> {
  return routeOptionalLocalModelTask(request, resolver);
}

/**
 * Executes the optional local bridge-question-timing task and fails closed on missing resolvers or
 * errors.
 *
 * @param request - Canonical bridge-question-timing request.
 * @param resolver - Optional bridge-question-timing interpreter.
 * @returns Bridge-question-timing interpretation when one was produced safely, otherwise `null`.
 */
export async function routeBridgeQuestionTimingInterpretationModel(
  request: BridgeQuestionTimingInterpretationRequest,
  resolver?: BridgeQuestionTimingInterpretationResolver
): Promise<BridgeQuestionTimingInterpretationSignal | null> {
  return routeOptionalLocalModelTask(request, resolver);
}

/**
 * Executes the optional local autonomy-boundary task and fails closed on missing resolvers or
 * errors.
 *
 * @param request - Canonical autonomy-boundary request.
 * @param resolver - Optional autonomy-boundary interpreter.
 * @returns Autonomy-boundary interpretation when one was produced safely, otherwise `null`.
 */
export async function routeAutonomyBoundaryInterpretationModel(
  request: AutonomyBoundaryInterpretationRequest,
  resolver?: AutonomyBoundaryInterpretationResolver
): Promise<AutonomyBoundaryInterpretationSignal | null> {
  return routeOptionalLocalModelTask(request, resolver);
}

/**
 * Executes the optional local status-recall-boundary task and fails closed on missing resolvers or
 * errors.
 *
 * @param request - Canonical status-recall-boundary request.
 * @param resolver - Optional status-recall-boundary interpreter.
 * @returns Status-recall-boundary interpretation when one was produced safely, otherwise `null`.
 */
export async function routeStatusRecallBoundaryInterpretationModel(
  request: StatusRecallBoundaryInterpretationRequest,
  resolver?: StatusRecallBoundaryInterpretationResolver
): Promise<StatusRecallBoundaryInterpretationSignal | null> {
  return routeOptionalLocalModelTask(request, resolver);
}
