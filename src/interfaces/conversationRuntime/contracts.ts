/**
 * @fileoverview Internal conversation-runtime contracts for interface session persistence and ingress delegation.
 */

import type {
  CorrectConversationMemoryFact,
  ConversationCheckpointReviewRunner,
  DescribeRuntimeCapabilities,
  ForgetConversationMemoryFact,
  ForgetConversationMemoryEpisode,
  ConversationIngressRuleContexts,
  ListBrowserSessionSnapshots,
  ListManagedProcessSnapshots,
  ListAvailableSkills,
  QueryConversationContinuityFacts,
  RememberConversationProfileInput,
  ConversationIntentInterpreter,
  ConversationManagerConfig,
  ConversationNotifier,
  OpenConversationContinuityReadSession,
  QueryConversationContinuityEpisodes,
  ReviewConversationMemoryFacts,
  ResolveConversationMemoryEpisode,
  ReviewConversationMemory,
  MarkConversationMemoryEpisodeWrong,
  ExecuteConversationTask,
  RunDirectConversationTurn
} from "./managerContracts";
import type {
  AutonomyBoundaryInterpretationResolver,
  ContinuationInterpretationResolver,
  ContextualFollowupInterpretationResolver,
  ContextualReferenceInterpretationResolver,
  EntityReferenceInterpretationResolver,
  HandoffControlInterpretationResolver,
  IdentityInterpretationResolver,
  LocalIntentModelResolver,
  RelationshipInterpretationResolver,
  StatusRecallBoundaryInterpretationResolver,
  TopicKeyInterpretationResolver
} from "../../organs/languageUnderstanding/localIntentModelContracts";
import type { ProposalReplyInterpretationResolver } from "../../organs/languageUnderstanding/localIntentModelProposalReplyContracts";
import type { ConversationSession } from "../sessionStore";
import type { MemoryAccessAuditStore } from "../../core/memoryAccessAudit";

export interface InterfaceSessionFile {
  conversations: Record<string, ConversationSession>;
}

export interface InterfaceSessionStoreOptions {
  backend?: "json" | "sqlite";
  sqlitePath?: string;
  exportJsonOnWrite?: boolean;
}

export interface SqliteSessionRow {
  conversation_id: string;
  updated_at: string;
  session_json: string;
}

export type NormalizeConversationSession = (
  raw: Partial<ConversationSession>
) => ConversationSession | null;

export type NormalizeInterfaceSessionState = (
  raw: Partial<InterfaceSessionFile>
) => InterfaceSessionFile;

export interface SessionPersistenceContext {
  statePath: string;
  sqlitePath: string;
  exportJsonOnWrite: boolean;
  normalizeSession: NormalizeConversationSession;
  normalizeState: NormalizeInterfaceSessionState;
}

export interface ConversationIngressDependencies extends ConversationIngressRuleContexts {
  store: {
    getSession(conversationId: string): Promise<ConversationSession | null>;
    setSession(session: ConversationSession): Promise<void>;
  };
  config: Pick<
    ConversationManagerConfig,
    | "allowAutonomousViaInterface"
    | "maxProposalInputChars"
    | "maxConversationTurns"
    | "maxContextTurnsForExecution"
    | "staleRunningJobRecoveryMs"
    | "maxRecentJobs"
    | "maxRecentActions"
    | "maxBrowserSessions"
    | "maxPathDestinations"
  >;
  interpretConversationIntent?: ConversationIntentInterpreter;
  runDirectConversationTurn?: RunDirectConversationTurn;
  localIntentModelResolver?: LocalIntentModelResolver;
  autonomyBoundaryInterpretationResolver?: AutonomyBoundaryInterpretationResolver;
  statusRecallBoundaryInterpretationResolver?: StatusRecallBoundaryInterpretationResolver;
  continuationInterpretationResolver?: ContinuationInterpretationResolver;
  contextualFollowupInterpretationResolver?: ContextualFollowupInterpretationResolver;
  contextualReferenceInterpretationResolver?: ContextualReferenceInterpretationResolver;
  entityReferenceInterpretationResolver?: EntityReferenceInterpretationResolver;
  handoffControlInterpretationResolver?: HandoffControlInterpretationResolver;
  identityInterpretationResolver?: IdentityInterpretationResolver;
  relationshipInterpretationResolver?: RelationshipInterpretationResolver;
  proposalReplyInterpretationResolver?: ProposalReplyInterpretationResolver;
  topicKeyInterpretationResolver?: TopicKeyInterpretationResolver;
  intentInterpreterConfidenceThreshold: number;
  runCheckpointReview?: ConversationCheckpointReviewRunner;
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  queryContinuityFacts?: QueryConversationContinuityFacts;
  openContinuityReadSession?: OpenConversationContinuityReadSession;
  getEntityGraph?: import("./managerContracts").GetConversationEntityGraph;
  reconcileEntityAliasCandidate?: import("./managerContracts").ReconcileConversationEntityAliasCandidate;
  rememberConversationProfileInput?: RememberConversationProfileInput;
  reviewConversationMemory?: ReviewConversationMemory;
  reviewConversationMemoryFacts?: ReviewConversationMemoryFacts;
  resolveConversationMemoryEpisode?: ResolveConversationMemoryEpisode;
  markConversationMemoryEpisodeWrong?: MarkConversationMemoryEpisodeWrong;
  forgetConversationMemoryEpisode?: ForgetConversationMemoryEpisode;
  correctConversationMemoryFact?: CorrectConversationMemoryFact;
  forgetConversationMemoryFact?: ForgetConversationMemoryFact;
  listAvailableSkills?: ListAvailableSkills;
  describeRuntimeCapabilities?: DescribeRuntimeCapabilities;
  listManagedProcessSnapshots?: ListManagedProcessSnapshots;
  listBrowserSessionSnapshots?: ListBrowserSessionSnapshots;
  memoryAccessAuditStore?: MemoryAccessAuditStore;
  abortActiveAutonomousRun?(conversationId: string): boolean;
  isWorkerActive(sessionKey: string): boolean;
  getWorkerLastSeenAt?(sessionKey: string): string | null;
  clearAckTimer(sessionKey: string): void;
  setWorkerBinding(
    sessionKey: string,
    executeTask: ExecuteConversationTask,
    notify: ConversationNotifier
  ): void;
  startWorkerIfNeeded(
    sessionKey: string,
    executeTask: ExecuteConversationTask,
    notify: ConversationNotifier
  ): Promise<void>;
  enqueueJob(
    session: ConversationSession,
    input: string,
    receivedAt: string,
    executionInput?: string,
    isSystemJob?: boolean
  ): {
    reply: string;
    shouldStartWorker: boolean;
  };
  buildAutonomousExecutionInput(goal: string): string;
}

export interface ConversationSessionRecoveryDependencies {
  config: Pick<
    ConversationIngressDependencies["config"],
    "staleRunningJobRecoveryMs" | "maxRecentJobs"
  >;
  isWorkerActive(sessionKey: string): boolean;
  getWorkerLastSeenAt?(sessionKey: string): string | null;
  clearAckTimer(sessionKey: string): void;
}

export interface ConversationSessionRecoveryContext {
  sessionKey: string;
  session: ConversationSession;
  nowIso: string;
  deps: ConversationSessionRecoveryDependencies;
}
