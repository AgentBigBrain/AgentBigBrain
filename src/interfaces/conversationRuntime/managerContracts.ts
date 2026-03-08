/**
 * @fileoverview Canonical conversation-manager contracts and autonomous execution helpers for extracted interface runtime modules.
 */

import type { ConversationVisibility } from "../sessionStore";
import type {
  FollowUpRuleContext,
  PulseLexicalRuleContext
} from "../conversationManagerHelpers";
import type {
  InterpretedConversationIntent,
  IntentInterpreterTurn
} from "../../organs/intentInterpreter";

export interface ConversationInboundMessage {
  provider: "telegram" | "discord";
  conversationId: string;
  userId: string;
  username: string;
  conversationVisibility: ConversationVisibility;
  text: string;
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
