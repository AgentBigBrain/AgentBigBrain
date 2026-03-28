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
  if (!resolver) {
    return null;
  }

  try {
    const result = await resolver(request);
    return result ?? null;
  } catch {
    return null;
  }
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
