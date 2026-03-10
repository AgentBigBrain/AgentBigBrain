/**
 * @fileoverview Canonical conversation-manager contracts and autonomous execution helpers for extracted interface runtime modules.
 */

import type { ConversationVisibility } from "../sessionStore";
import type { ConversationInboundMediaEnvelope } from "../mediaRuntime/contracts";
import type {
  FollowUpRuleContext,
  PulseLexicalRuleContext
} from "../conversationManagerHelpers";
import type {
  ConversationStackV1,
  OpenLoopV1
} from "../../core/types";
import type { ProfileEpisodeStatus } from "../../core/profileMemory";
import type {
  InterpretedConversationIntent,
  IntentInterpreterTurn
} from "../../organs/intentInterpreter";
import { buildConversationInboundUserInput } from "../mediaRuntime/mediaNormalization";

export interface ConversationInboundMessage {
  provider: "telegram" | "discord";
  conversationId: string;
  userId: string;
  username: string;
  conversationVisibility: ConversationVisibility;
  text: string;
  media?: ConversationInboundMediaEnvelope | null;
  receivedAt: string;
}

export interface ConversationExecutionResult {
  summary: string;
}

export type ExecuteConversationTask = (
  input: string,
  receivedAt: string
) => Promise<ConversationExecutionResult>;

export interface ConversationDeliveryResult {
  ok: boolean;
  messageId: string | null;
  errorCode: string | null;
}

export interface ConversationNotifierCapabilities {
  supportsEdit: boolean;
  supportsNativeStreaming: boolean;
}

export interface ConversationNotifierTransport {
  capabilities: ConversationNotifierCapabilities;
  send(message: string): Promise<ConversationDeliveryResult>;
  edit?(messageId: string, message: string): Promise<ConversationDeliveryResult>;
  stream?(message: string): Promise<ConversationDeliveryResult>;
}

export type ConversationNotifier =
  | ConversationNotifierTransport
  | ((message: string) => Promise<void>);

export type ConversationIntentInterpreter = (
  input: string,
  recentTurns: IntentInterpreterTurn[],
  pulseRuleContext?: PulseLexicalRuleContext
) => Promise<InterpretedConversationIntent>;

export interface ConversationCheckpointReviewResult {
  checkpointId: string;
  overallPass: boolean;
  artifactPath: string;
  summaryLines: readonly string[];
}

export type ConversationCheckpointReviewRunner = (
  checkpointId: string
) => Promise<ConversationCheckpointReviewResult | null>;

export interface ConversationContinuityEpisodeEntityLink {
  entityKey: string;
  canonicalName: string;
}

export interface ConversationContinuityEpisodeOpenLoopLink {
  loopId: string;
  threadKey: string;
  status: OpenLoopV1["status"];
  priority: number;
}

export interface ConversationContinuityEpisodeRecord {
  episodeId: string;
  title: string;
  summary: string;
  status: ProfileEpisodeStatus;
  lastMentionedAt: string;
  entityRefs: readonly string[];
  entityLinks: readonly ConversationContinuityEpisodeEntityLink[];
  openLoopLinks: readonly ConversationContinuityEpisodeOpenLoopLink[];
}

export interface ConversationContinuityFactRecord {
  factId: string;
  key: string;
  value: string;
  status: string;
  observedAt: string;
  lastUpdatedAt: string;
  confidence: number;
}

export interface ConversationMemoryReviewRecord {
  episodeId: string;
  title: string;
  summary: string;
  status: ProfileEpisodeStatus;
  lastMentionedAt: string;
  resolvedAt: string | null;
  confidence: number;
  sensitive: boolean;
}

export interface ConversationMemoryReviewRequest {
  reviewTaskId: string;
  query: string;
  nowIso: string;
  maxEpisodes?: number;
}

export type ReviewConversationMemory = (
  request: ConversationMemoryReviewRequest
) => Promise<readonly ConversationMemoryReviewRecord[]>;

export interface ConversationMemoryMutationRequest {
  episodeId: string;
  note?: string;
  nowIso: string;
  sourceTaskId: string;
  sourceText: string;
}

export type ResolveConversationMemoryEpisode = (
  request: ConversationMemoryMutationRequest
) => Promise<ConversationMemoryReviewRecord | null>;

export type MarkConversationMemoryEpisodeWrong = (
  request: ConversationMemoryMutationRequest
) => Promise<ConversationMemoryReviewRecord | null>;

export type ForgetConversationMemoryEpisode = (
  request: Pick<
    ConversationMemoryMutationRequest,
    "episodeId" | "nowIso" | "sourceTaskId" | "sourceText"
  >
) => Promise<ConversationMemoryReviewRecord | null>;

export interface ConversationContinuityEpisodeQueryRequest {
  stack: ConversationStackV1;
  entityHints: readonly string[];
  maxEpisodes?: number;
}

export type QueryConversationContinuityEpisodes = (
  request: ConversationContinuityEpisodeQueryRequest
) => Promise<readonly ConversationContinuityEpisodeRecord[]>;

export interface ConversationContinuityFactQueryRequest {
  stack: ConversationStackV1;
  entityHints: readonly string[];
  maxFacts?: number;
}

export type QueryConversationContinuityFacts = (
  request: ConversationContinuityFactQueryRequest
) => Promise<readonly ConversationContinuityFactRecord[]>;

export interface ConversationManagerConfig {
  maxProposalInputChars: number;
  heartbeatIntervalMs: number;
  ackDelayMs: number;
  maxRecentJobs: number;
  staleRunningJobRecoveryMs: number;
  maxConversationTurns: number;
  maxContextTurnsForExecution: number;
  showCompletionPrefix: boolean;
  followUpOverridePath: string | null;
  pulseLexicalOverridePath: string | null;
  allowAutonomousViaInterface: boolean;
}

export interface ConversationManagerDependencies {
  interpretConversationIntent?: ConversationIntentInterpreter;
  intentInterpreterConfidenceThreshold?: number;
  runCheckpointReview?: ConversationCheckpointReviewRunner;
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  queryContinuityFacts?: QueryConversationContinuityFacts;
  reviewConversationMemory?: ReviewConversationMemory;
  resolveConversationMemoryEpisode?: ResolveConversationMemoryEpisode;
  markConversationMemoryEpisodeWrong?: MarkConversationMemoryEpisodeWrong;
  forgetConversationMemoryEpisode?: ForgetConversationMemoryEpisode;
}

export interface ConversationIngressRuleContexts {
  followUpRuleContext: FollowUpRuleContext;
  pulseLexicalRuleContext: PulseLexicalRuleContext;
}

export const AUTONOMOUS_EXECUTION_PREFIX = "[AUTONOMOUS_LOOP_GOAL]";

/**
 * Tags an execution input as an autonomous loop goal so interface transport callbacks
 * can route to the autonomous loop instead of a single-task execution.
 *
 * @param goal - Autonomous loop goal text that should be encoded for execution.
 * @returns Stable execution input containing the autonomous goal prefix.
 */
export function buildAutonomousExecutionInput(goal: string): string {
  return `${AUTONOMOUS_EXECUTION_PREFIX} ${goal}`;
}

/**
 * Detects whether an execution input was tagged as an autonomous loop goal.
 *
 * @param executionInput - Raw execution input that may contain the autonomous goal prefix.
 * @returns Extracted autonomous goal text, or `null` when no autonomous goal tag is present.
 */
export function parseAutonomousExecutionInput(
  executionInput: string
): string | null {
  if (!executionInput.startsWith(AUTONOMOUS_EXECUTION_PREFIX)) {
    return null;
  }
  return executionInput.slice(AUTONOMOUS_EXECUTION_PREFIX.length).trim();
}

/**
 * Resolves the bounded user-input text used by conversation-runtime helpers, preferring explicit
 * text and falling back to a natural media-only request when the inbound message contains media.
 *
 * @param message - Inbound provider message.
 * @returns Canonical user-input text used for routing and execution input assembly.
 */
export function resolveConversationInboundUserInput(
  message: ConversationInboundMessage
): string {
  return buildConversationInboundUserInput(message.text, message.media);
}

