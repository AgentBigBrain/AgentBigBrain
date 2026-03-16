/**
 * @fileoverview Canonical conversation-manager contracts and autonomous execution helpers for extracted interface runtime modules.
 */

import type {
  ConversationProgressStatus,
  ConversationVisibility
} from "../sessionStore";
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
import type { SkillInventoryEntry } from "../../organs/skillRegistry/contracts";
import type {
  InterpretedConversationIntent,
  IntentInterpreterTurn
} from "../../organs/intentInterpreter";
import type { LocalIntentModelResolver } from "../../organs/languageUnderstanding/localIntentModelContracts";
import type { ManagedProcessSnapshot } from "../../organs/liveRun/managedProcessRegistry";
import type { BrowserSessionSnapshot } from "../../organs/liveRun/browserSessionRegistry";
import type { TaskRunResult } from "../../core/types";
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
  taskRunResult?: TaskRunResult | null;
}

export interface ConversationExecutionProgressUpdate {
  status: Exclude<ConversationProgressStatus, "idle">;
  message: string;
}

export type ConversationCapabilityStatus = "available" | "limited" | "unavailable";

export interface ConversationCapabilityRecord {
  id:
    | "natural_chat"
    | "plan_and_build"
    | "autonomous_execution"
    | "memory_review"
    | "skill_discovery"
    | "images"
    | "voice_notes"
    | "video_attachments"
    | "document_attachments";
  label: string;
  status: ConversationCapabilityStatus;
  summary: string;
}

export interface ConversationCapabilitySummary {
  provider: "telegram" | "discord" | "generic";
  privateChatAliasOptional: boolean;
  supportsNaturalConversation: boolean;
  supportsAutonomousExecution: boolean;
  supportsMemoryReview: boolean;
  capabilities: readonly ConversationCapabilityRecord[];
}

export type ExecuteConversationTask = (
  input: string,
  receivedAt: string,
  onProgressUpdate?: (update: ConversationExecutionProgressUpdate) => Promise<void>
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

export type ListAvailableSkills = () => Promise<readonly SkillInventoryEntry[]>;

export type DescribeRuntimeCapabilities = () => Promise<ConversationCapabilitySummary>;

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

export type ListManagedProcessSnapshots = () => Promise<readonly ManagedProcessSnapshot[]>;
export type ListBrowserSessionSnapshots = () => Promise<readonly BrowserSessionSnapshot[]>;

export interface ConversationManagerConfig {
  maxProposalInputChars: number;
  heartbeatIntervalMs: number;
  ackDelayMs: number;
  maxRecentJobs: number;
  maxRecentActions: number;
  maxBrowserSessions: number;
  maxPathDestinations: number;
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
  localIntentModelResolver?: LocalIntentModelResolver;
  intentInterpreterConfidenceThreshold?: number;
  runCheckpointReview?: ConversationCheckpointReviewRunner;
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  queryContinuityFacts?: QueryConversationContinuityFacts;
  reviewConversationMemory?: ReviewConversationMemory;
  resolveConversationMemoryEpisode?: ResolveConversationMemoryEpisode;
  markConversationMemoryEpisodeWrong?: MarkConversationMemoryEpisodeWrong;
  forgetConversationMemoryEpisode?: ForgetConversationMemoryEpisode;
  listAvailableSkills?: ListAvailableSkills;
  describeRuntimeCapabilities?: DescribeRuntimeCapabilities;
  listManagedProcessSnapshots?: ListManagedProcessSnapshots;
  listBrowserSessionSnapshots?: ListBrowserSessionSnapshots;
  abortActiveAutonomousRun?(conversationId: string): boolean;
}

export interface ConversationIngressRuleContexts {
  followUpRuleContext: FollowUpRuleContext;
  pulseLexicalRuleContext: PulseLexicalRuleContext;
}

export const AUTONOMOUS_EXECUTION_PREFIX = "[AUTONOMOUS_LOOP_GOAL]";

export interface AutonomousExecutionEnvelope {
  goal: string;
  initialExecutionInput: string | null;
}

/**
 * Tags an execution input as an autonomous loop goal so interface transport callbacks
 * can route to the autonomous loop instead of a single-task execution.
 *
 * @param goal - Autonomous loop goal text that should be encoded for execution.
 * @param initialExecutionInput - Optional richer first-step execution brief for iteration 1.
 * @returns Stable execution input containing the autonomous goal prefix.
 */
export function buildAutonomousExecutionInput(
  goal: string,
  initialExecutionInput: string | null = null
): string {
  const trimmedGoal = goal.trim();
  const trimmedInitialInput = initialExecutionInput?.trim() ?? "";
  if (!trimmedInitialInput || trimmedInitialInput === trimmedGoal) {
    return `${AUTONOMOUS_EXECUTION_PREFIX} ${trimmedGoal}`;
  }
  return `${AUTONOMOUS_EXECUTION_PREFIX} ${JSON.stringify({
    goal: trimmedGoal,
    initialExecutionInput: trimmedInitialInput
  } satisfies AutonomousExecutionEnvelope)}`;
}

/**
 * Detects whether an execution input was tagged as an autonomous loop goal.
 *
 * @param executionInput - Raw execution input that may contain the autonomous goal prefix.
 * @returns Extracted autonomous goal text, or `null` when no autonomous goal tag is present.
 */
export function parseAutonomousExecutionInput(
  executionInput: string
): AutonomousExecutionEnvelope | null {
  if (!executionInput.startsWith(AUTONOMOUS_EXECUTION_PREFIX)) {
    return null;
  }
  const payload = executionInput.slice(AUTONOMOUS_EXECUTION_PREFIX.length).trim();
  if (!payload) {
    return null;
  }
  try {
    const parsed = JSON.parse(payload) as Partial<AutonomousExecutionEnvelope>;
    if (typeof parsed.goal === "string" && parsed.goal.trim().length > 0) {
      return {
        goal: parsed.goal.trim(),
        initialExecutionInput:
          typeof parsed.initialExecutionInput === "string" &&
          parsed.initialExecutionInput.trim().length > 0
            ? parsed.initialExecutionInput.trim()
            : null
      };
    }
  } catch {
    // Fall back to the legacy plain-text autonomous goal encoding.
  }
  return {
    goal: payload,
    initialExecutionInput: null
  };
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

