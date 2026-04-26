/** @fileoverview Shared contracts for conversation routing entrypoints. */

import type {
  AutonomyBoundaryInterpretationResolver,
  ContinuationInterpretationResolver,
  ContextualFollowupInterpretationResolver,
  ContextualReferenceInterpretationResolver,
  EntityReferenceInterpretationResolver,
  HandoffControlInterpretationResolver,
  IdentityInterpretationResolver,
  LocalIntentModelResolver,
  StatusRecallBoundaryInterpretationResolver,
  TopicKeyInterpretationResolver
} from "../../organs/languageUnderstanding/localIntentModelContracts";
import type { FollowUpRuleContext } from "../conversationManagerHelpers";
import type { ConversationSession } from "../sessionStore";
import type {
  DescribeRuntimeCapabilities,
  GetConversationEntityGraph,
  ListAvailableSkills,
  ListBrowserSessionSnapshots,
  ListManagedProcessSnapshots,
  OpenConversationContinuityReadSession,
  QueryConversationContinuityEpisodes,
  QueryConversationContinuityFacts,
  RememberConversationProfileInput,
  RunDirectConversationTurn
} from "./managerContracts";

export interface ConversationEnqueueResult {
  reply: string;
  shouldStartWorker: boolean;
}

export interface ConversationRoutingDependencies {
  followUpRuleContext: FollowUpRuleContext;
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  queryContinuityFacts?: QueryConversationContinuityFacts;
  openContinuityReadSession?: OpenConversationContinuityReadSession;
  rememberConversationProfileInput?: RememberConversationProfileInput;
  listAvailableSkills?: ListAvailableSkills;
  describeRuntimeCapabilities?: DescribeRuntimeCapabilities;
  listManagedProcessSnapshots?: ListManagedProcessSnapshots;
  listBrowserSessionSnapshots?: ListBrowserSessionSnapshots;
  localIntentModelResolver?: LocalIntentModelResolver;
  autonomyBoundaryInterpretationResolver?: AutonomyBoundaryInterpretationResolver;
  statusRecallBoundaryInterpretationResolver?: StatusRecallBoundaryInterpretationResolver;
  continuationInterpretationResolver?: ContinuationInterpretationResolver;
  contextualFollowupInterpretationResolver?: ContextualFollowupInterpretationResolver;
  contextualReferenceInterpretationResolver?: ContextualReferenceInterpretationResolver;
  entityReferenceInterpretationResolver?: EntityReferenceInterpretationResolver;
  handoffControlInterpretationResolver?: HandoffControlInterpretationResolver;
  identityInterpretationResolver?: IdentityInterpretationResolver;
  topicKeyInterpretationResolver?: TopicKeyInterpretationResolver;
  getEntityGraph?: GetConversationEntityGraph;
  abortActiveAutonomousRun?(): boolean;
  config: {
    allowAutonomousViaInterface: boolean;
    maxContextTurnsForExecution: number;
    maxConversationTurns: number;
  };
  directCasualChatEnabled?: boolean;
  runDirectConversationTurn?: RunDirectConversationTurn;
  enqueueJob(
    session: ConversationSession,
    input: string,
    receivedAt: string,
    executionInput?: string,
    isSystemJob?: boolean
  ): ConversationEnqueueResult;
}
