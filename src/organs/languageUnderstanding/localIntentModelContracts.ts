/**
 * @fileoverview Canonical contracts for the optional local intent-model path used by the human-centric execution front door.
 */

import type { RoutingMapClassificationV1 } from "../../interfaces/routingMap";
import type {
  ConversationIntentSemanticHint,
  ResolvedConversationIntentMode
} from "../../interfaces/conversationRuntime/intentModeContracts";
import type { EntityNodeV1 } from "../../core/runtimeTypes/interfaceTypes";
import type {
  ConversationDomainLane,
  ConversationIntentMode,
  ConversationReturnHandoffStatus
} from "../../interfaces/sessionStore";

export type LocalIntentModelConfidence = "low" | "medium" | "high";

export interface LocalIntentModelSessionHints {
  hasActiveWorkspace?: boolean;
  hasReturnHandoff: boolean;
  hasRecentAssistantQuestion?: boolean;
  hasRecentAssistantIdentityPrompt?: boolean;
  hasRecentAssistantIdentityAnswer?: boolean;
  recentIdentityConversationActive?: boolean;
  returnHandoffStatus: ConversationReturnHandoffStatus | null;
  returnHandoffPreviewAvailable: boolean;
  returnHandoffPrimaryArtifactAvailable: boolean;
  returnHandoffChangedPathCount: number;
  returnHandoffNextSuggestedStepAvailable: boolean;
  modeContinuity: ConversationIntentMode | null;
  domainDominantLane?: ConversationDomainLane;
  domainContinuityActive?: boolean;
  workflowContinuityActive?: boolean;
}

export interface LocalIntentModelRequest {
  userInput: string;
  routingClassification: RoutingMapClassificationV1 | null;
  sessionHints?: LocalIntentModelSessionHints | null;
}

export interface LocalIntentModelSignal extends ResolvedConversationIntentMode {
  source: "local_intent_model";
  semanticHint?: ConversationIntentSemanticHint | null;
}

export type IdentityInterpretationKind =
  | "self_identity_declaration"
  | "self_identity_query"
  | "assistant_identity_query"
  | "non_identity_chat"
  | "uncertain";

export interface IdentityInterpretationRequest {
  userInput: string;
  routingClassification: RoutingMapClassificationV1 | null;
  sessionHints?: LocalIntentModelSessionHints | null;
  recentAssistantTurn?: string | null;
}

export interface IdentityInterpretationSignal {
  source: "local_intent_model";
  kind: IdentityInterpretationKind;
  candidateValue: string | null;
  confidence: LocalIntentModelConfidence;
  shouldPersist: boolean;
  explanation: string;
}

export type ContinuationInterpretationKind =
  | "short_follow_up"
  | "mode_continuation"
  | "return_handoff_resume"
  | "non_continuation_chat"
  | "uncertain";

export type ContinuationFollowUpCategory =
  | "ack"
  | "approve"
  | "deny"
  | "adjust"
  | "question"
  | null;

export type ContinuationInterpretationTarget =
  | "prior_assistant_turn"
  | "mode_continuity"
  | "return_handoff"
  | null;

export interface ContinuationInterpretationRequest {
  userInput: string;
  routingClassification: RoutingMapClassificationV1 | null;
  sessionHints?: LocalIntentModelSessionHints | null;
  recentAssistantTurn?: string | null;
}

export interface ContinuationInterpretationSignal {
  source: "local_intent_model";
  kind: ContinuationInterpretationKind;
  followUpCategory: ContinuationFollowUpCategory;
  continuationTarget: ContinuationInterpretationTarget;
  candidateValue: string | null;
  confidence: LocalIntentModelConfidence;
  explanation: string;
}

export type ContextualReferenceInterpretationKind =
  | "contextual_recall_reference"
  | "open_loop_resume_reference"
  | "non_contextual_reference"
  | "uncertain";

export interface ContextualReferenceInterpretationTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ContextualReferenceInterpretationThreadHint {
  topicLabel: string;
  resumeHint: string;
  openLoopCount: number;
  lastTouchedAt: string;
}

export interface ContextualReferenceInterpretationRequest {
  userInput: string;
  routingClassification: RoutingMapClassificationV1 | null;
  sessionHints?: LocalIntentModelSessionHints | null;
  recentTurns?: readonly ContextualReferenceInterpretationTurn[];
  pausedThreads?: readonly ContextualReferenceInterpretationThreadHint[];
  deterministicHints?: readonly string[];
}

export interface ContextualReferenceInterpretationSignal {
  source: "local_intent_model";
  kind: ContextualReferenceInterpretationKind;
  entityHints: readonly string[];
  topicHints: readonly string[];
  confidence: LocalIntentModelConfidence;
  explanation: string;
}

export type TopicKeyInterpretationKind =
  | "retain_active_thread"
  | "resume_paused_thread"
  | "switch_topic_candidate"
  | "non_topic_turn"
  | "uncertain";

export interface TopicKeyInterpretationCandidate {
  topicKey: string;
  label: string;
  confidence: number;
}

export interface TopicKeyInterpretationThreadHint {
  threadKey: string;
  topicKey: string;
  topicLabel: string;
  resumeHint: string;
  state: "active" | "paused";
}

export interface TopicKeyInterpretationRequest {
  userInput: string;
  routingClassification: RoutingMapClassificationV1 | null;
  sessionHints?: LocalIntentModelSessionHints | null;
  recentTurns?: readonly ContextualReferenceInterpretationTurn[];
  activeThread?: TopicKeyInterpretationThreadHint | null;
  pausedThreads?: readonly TopicKeyInterpretationThreadHint[];
  deterministicCandidates?: readonly TopicKeyInterpretationCandidate[];
}

export interface TopicKeyInterpretationSignal {
  source: "local_intent_model";
  kind: TopicKeyInterpretationKind;
  selectedTopicKey: string | null;
  selectedThreadKey: string | null;
  confidence: LocalIntentModelConfidence;
  explanation: string;
}

export type EntityReferenceInterpretationKind =
  | "entity_scoped_reference"
  | "entity_alias_candidate"
  | "non_entity_reference"
  | "uncertain";

export interface EntityReferenceInterpretationCandidate {
  entityKey: string;
  canonicalName: string;
  aliases: readonly string[];
  entityType: EntityNodeV1["entityType"];
  domainHint: EntityNodeV1["domainHint"];
}

export interface EntityReferenceInterpretationRequest {
  userInput: string;
  routingClassification: RoutingMapClassificationV1 | null;
  sessionHints?: LocalIntentModelSessionHints | null;
  recentTurns?: readonly ContextualReferenceInterpretationTurn[];
  candidateEntities?: readonly EntityReferenceInterpretationCandidate[];
  deterministicHints?: readonly string[];
}

export interface EntityReferenceInterpretationSignal {
  source: "local_intent_model";
  kind: EntityReferenceInterpretationKind;
  selectedEntityKeys: readonly string[];
  aliasCandidate: string | null;
  confidence: LocalIntentModelConfidence;
  explanation: string;
}

export type EntityTypeInterpretationKind =
  | "typed_candidates"
  | "non_entity_type_boundary"
  | "uncertain";

export interface EntityTypeInterpretationCandidate {
  candidateName: string;
  deterministicEntityType: EntityNodeV1["entityType"];
  domainHint: EntityNodeV1["domainHint"];
}

export interface EntityTypeInterpretationSelection {
  candidateName: string;
  entityType: EntityNodeV1["entityType"];
}

export interface EntityTypeInterpretationRequest {
  userInput: string;
  routingClassification: RoutingMapClassificationV1 | null;
  sessionHints?: LocalIntentModelSessionHints | null;
  recentTurns?: readonly ContextualReferenceInterpretationTurn[];
  candidateEntities?: readonly EntityTypeInterpretationCandidate[];
  deterministicHints?: readonly string[];
}

export interface EntityTypeInterpretationSignal {
  source: "local_intent_model";
  kind: EntityTypeInterpretationKind;
  typedCandidates: readonly EntityTypeInterpretationSelection[];
  confidence: LocalIntentModelConfidence;
  explanation: string;
}

export type EntityDomainHintInterpretationKind = "domain_hinted_candidates"
  | "non_entity_domain_boundary"
  | "uncertain";

export interface EntityDomainHintInterpretationCandidate {
  candidateName: string;
  entityType: EntityNodeV1["entityType"];
  deterministicDomainHint: EntityNodeV1["domainHint"];
}

export interface EntityDomainHintInterpretationSelection { candidateName: string; domainHint: "profile" | "relationship" | "workflow"; }

export interface EntityDomainHintInterpretationRequest {
  userInput: string;
  routingClassification: RoutingMapClassificationV1 | null;
  sessionHints?: LocalIntentModelSessionHints | null;
  recentTurns?: readonly ContextualReferenceInterpretationTurn[];
  candidateEntities?: readonly EntityDomainHintInterpretationCandidate[];
  deterministicHints?: readonly string[];
}

export interface EntityDomainHintInterpretationSignal {
  source: "local_intent_model";
  kind: EntityDomainHintInterpretationKind;
  domainHintedCandidates: readonly EntityDomainHintInterpretationSelection[];
  confidence: LocalIntentModelConfidence;
  explanation: string;
}

export type HandoffControlInterpretationKind =
  | "pause_request"
  | "review_request"
  | "guided_review_request"
  | "while_away_review_request"
  | "non_handoff_control"
  | "uncertain";

export interface HandoffControlInterpretationRequest {
  userInput: string;
  routingClassification: RoutingMapClassificationV1 | null;
  sessionHints?: LocalIntentModelSessionHints | null;
  recentTurns?: readonly ContextualReferenceInterpretationTurn[];
}

export interface HandoffControlInterpretationSignal {
  source: "local_intent_model";
  kind: HandoffControlInterpretationKind;
  confidence: LocalIntentModelConfidence;
  explanation: string;
}

export type ContextualFollowupInterpretationKind =
  | "status_followup"
  | "reminder_followup"
  | "non_contextual_followup"
  | "uncertain";

export interface ContextualFollowupInterpretationRequest {
  userInput: string;
  routingClassification: RoutingMapClassificationV1 | null;
  sessionHints?: LocalIntentModelSessionHints | null;
  recentTurns?: readonly ContextualReferenceInterpretationTurn[];
  deterministicCandidateTokens?: readonly string[];
}

export interface ContextualFollowupInterpretationSignal {
  source: "local_intent_model";
  kind: ContextualFollowupInterpretationKind;
  candidateTokens: readonly string[];
  confidence: LocalIntentModelConfidence;
  explanation: string;
}

export type BridgeQuestionTimingInterpretationKind =
  | "ask_now"
  | "defer_for_context"
  | "non_bridge_context"
  | "uncertain";

export interface BridgeQuestionTimingInterpretationRequest {
  userInput: string;
  routingClassification: RoutingMapClassificationV1 | null;
  sessionHints?: LocalIntentModelSessionHints | null;
  recentTurns?: readonly ContextualReferenceInterpretationTurn[];
  questionPrompt?: string | null;
  entityLabels?: readonly string[];
}

export interface BridgeQuestionTimingInterpretationSignal {
  source: "local_intent_model";
  kind: BridgeQuestionTimingInterpretationKind;
  confidence: LocalIntentModelConfidence;
  explanation: string;
}

export type AutonomyBoundaryInterpretationKind =
  | "promote_to_autonomous"
  | "keep_as_build"
  | "keep_as_chat"
  | "uncertain";

export type AutonomyBoundaryDeterministicSignalStrength =
  | "none"
  | "ambiguous"
  | "strong";

export interface AutonomyBoundaryInterpretationRequest {
  userInput: string;
  routingClassification: RoutingMapClassificationV1 | null;
  sessionHints?: LocalIntentModelSessionHints | null;
  recentTurns?: readonly ContextualReferenceInterpretationTurn[];
  deterministicSignalStrength?: AutonomyBoundaryDeterministicSignalStrength | null;
}

export interface AutonomyBoundaryInterpretationSignal {
  source: "local_intent_model";
  kind: AutonomyBoundaryInterpretationKind;
  confidence: LocalIntentModelConfidence;
  explanation: string;
}

export type StatusRecallBoundaryInterpretationKind =
  | "status_or_recall"
  | "execute_now"
  | "non_status_boundary"
  | "uncertain";

export type StatusRecallBoundaryFocus =
  | "change_summary"
  | "return_handoff"
  | "location"
  | "browser"
  | "progress"
  | "waiting"
  | null;

export interface StatusRecallBoundaryInterpretationRequest {
  userInput: string;
  routingClassification: RoutingMapClassificationV1 | null;
  sessionHints?: LocalIntentModelSessionHints | null;
  recentTurns?: readonly ContextualReferenceInterpretationTurn[];
  deterministicPreference?: "status_or_recall" | "execute_now" | null;
}

export interface StatusRecallBoundaryInterpretationSignal {
  source: "local_intent_model";
  kind: StatusRecallBoundaryInterpretationKind;
  focus: StatusRecallBoundaryFocus;
  confidence: LocalIntentModelConfidence;
  explanation: string;
}

export type LocalIntentModelResolver = (
  request: LocalIntentModelRequest
) => Promise<LocalIntentModelSignal | null>;

export type IdentityInterpretationResolver = (
  request: IdentityInterpretationRequest
) => Promise<IdentityInterpretationSignal | null>;

export type ContinuationInterpretationResolver = (
  request: ContinuationInterpretationRequest
) => Promise<ContinuationInterpretationSignal | null>;

export type ContextualReferenceInterpretationResolver = (
  request: ContextualReferenceInterpretationRequest
) => Promise<ContextualReferenceInterpretationSignal | null>;

export type TopicKeyInterpretationResolver = (
  request: TopicKeyInterpretationRequest
) => Promise<TopicKeyInterpretationSignal | null>;

export type EntityReferenceInterpretationResolver = (
  request: EntityReferenceInterpretationRequest
) => Promise<EntityReferenceInterpretationSignal | null>;

export type EntityTypeInterpretationResolver = (
  request: EntityTypeInterpretationRequest
) => Promise<EntityTypeInterpretationSignal | null>;

export type EntityDomainHintInterpretationResolver = (request: EntityDomainHintInterpretationRequest) => Promise<EntityDomainHintInterpretationSignal | null>;

export type HandoffControlInterpretationResolver = (
  request: HandoffControlInterpretationRequest
) => Promise<HandoffControlInterpretationSignal | null>;

export type ContextualFollowupInterpretationResolver = (
  request: ContextualFollowupInterpretationRequest
) => Promise<ContextualFollowupInterpretationSignal | null>;

export type BridgeQuestionTimingInterpretationResolver = (request: BridgeQuestionTimingInterpretationRequest) => Promise<BridgeQuestionTimingInterpretationSignal | null>;
export type AutonomyBoundaryInterpretationResolver = (request: AutonomyBoundaryInterpretationRequest) => Promise<AutonomyBoundaryInterpretationSignal | null>;
export type StatusRecallBoundaryInterpretationResolver = (request: StatusRecallBoundaryInterpretationRequest) => Promise<StatusRecallBoundaryInterpretationSignal | null>;
