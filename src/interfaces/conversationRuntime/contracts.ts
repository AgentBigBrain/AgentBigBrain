/**
 * @fileoverview Internal conversation-runtime contracts for interface session persistence and ingress delegation.
 */

import type {
  ConversationCheckpointReviewRunner,
  ForgetConversationMemoryEpisode,
  ConversationIngressRuleContexts,
  QueryConversationContinuityFacts,
  ConversationIntentInterpreter,
  ConversationManagerConfig,
  ConversationNotifier,
  QueryConversationContinuityEpisodes,
  ResolveConversationMemoryEpisode,
  ReviewConversationMemory,
  MarkConversationMemoryEpisodeWrong,
  ExecuteConversationTask
} from "./managerContracts";
import type { ConversationSession } from "../sessionStore";

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
  >;
  interpretConversationIntent?: ConversationIntentInterpreter;
  intentInterpreterConfidenceThreshold: number;
  runCheckpointReview?: ConversationCheckpointReviewRunner;
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  queryContinuityFacts?: QueryConversationContinuityFacts;
  reviewConversationMemory?: ReviewConversationMemory;
  resolveConversationMemoryEpisode?: ResolveConversationMemoryEpisode;
  markConversationMemoryEpisodeWrong?: MarkConversationMemoryEpisodeWrong;
  forgetConversationMemoryEpisode?: ForgetConversationMemoryEpisode;
  isWorkerActive(sessionKey: string): boolean;
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
  clearAckTimer(sessionKey: string): void;
}

export interface ConversationSessionRecoveryContext {
  sessionKey: string;
  session: ConversationSession;
  nowIso: string;
  deps: ConversationSessionRecoveryDependencies;
}
