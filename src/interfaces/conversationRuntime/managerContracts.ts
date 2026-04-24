/**
 * @fileoverview Canonical conversation-manager contracts and autonomous execution helpers for extracted interface runtime modules.
 */

import type {
  ConversationProgressStatus,
  ConversationRecoveryTrace,
  ConversationTransportIdentityRecord,
  ConversationVisibility
} from "../sessionStore";
import type { MemoryAccessAuditStore } from "../../core/memoryAccessAudit";
import type { ConversationInboundMediaEnvelope } from "../mediaRuntime/contracts";
import type {
  FollowUpRuleContext,
  PulseLexicalRuleContext
} from "../conversationManagerHelpers";
import type {
  ProfileMemoryIngestRequest
} from "../../core/profileMemory";
import type {
  CorrectConversationMemoryFact,
  ForgetConversationMemoryEpisode,
  ForgetConversationMemoryFact,
  MarkConversationMemoryEpisodeWrong,
  ResolveConversationMemoryEpisode,
  ReviewConversationMemory,
  ReviewConversationMemoryFacts
} from "./memoryReviewContracts";
import type { SkillInventoryEntry } from "../../organs/skillRegistry/contracts";
import type {
  InterpretedConversationIntent,
  IntentInterpreterTurn
} from "../../organs/intentInterpreter";
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
import type { ProposalReplyInterpretationResolver } from "../../organs/languageUnderstanding/localIntentModelProposalReplyContracts";
import type { ManagedProcessSnapshot } from "../../organs/liveRun/managedProcessRegistry";
import type { BrowserSessionSnapshot } from "../../organs/liveRun/browserSessionRegistry";
import type { TaskRunResult } from "../../core/types";
import {
  buildConversationCommandRoutingInput,
  buildConversationInboundUserInput
} from "../mediaRuntime/mediaNormalization";
import type {
  GetConversationEntityGraph,
  OpenConversationContinuityReadSession,
  QueryConversationContinuityEpisodes,
  QueryConversationContinuityFacts
} from "./continuityContracts";
export type {
  ConversationContinuityEpisodeEntityLink,
  ConversationContinuityEpisodeOpenLoopLink,
  ConversationContinuityEpisodeQueryRequest,
  ConversationContinuityEpisodeRecord,
  ConversationContinuityFactQueryRequest,
  ConversationContinuityFactRecord,
  ConversationContinuityFactResult,
  ConversationContinuityReadSession,
  GetConversationEntityGraph,
  OpenConversationContinuityReadSession,
  QueryConversationContinuityEpisodes,
  QueryConversationContinuityFacts
} from "./continuityContracts";

export interface ConversationInboundMessage {
  provider: "telegram" | "discord";
  conversationId: string;
  userId: string;
  username: string;
  transportIdentity?: ConversationTransportIdentityRecord | null;
  conversationVisibility: ConversationVisibility;
  text: string;
  commandRoutingText?: string;
  media?: ConversationInboundMediaEnvelope | null;
  receivedAt: string;
}

export interface ConversationExecutionResult {
  summary: string;
  taskRunResult?: TaskRunResult | null;
  suppressUserDelivery?: boolean;
}

export type RunDirectConversationTurn = (
  input: string,
  receivedAt: string,
  session?: {
    modelBackendOverride?: import("../../models/types").ModelBackend | null;
    codexAuthProfileId?: string | null;
  } | null
) => Promise<ConversationExecutionResult>;

export interface ConversationExecutionProgressUpdate {
  status: Exclude<ConversationProgressStatus, "idle">;
  message: string;
  recoveryTrace?: ConversationRecoveryTrace | null;
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
  errorDetail?: string | null;
}
export type ConversationOutboundDeliverySource =
  | "transport_response"
  | "direct_reply"
  | "autonomous_progress"
  | "worker_ack"
  | "worker_progress"
  | "worker_status_panel"
  | "worker_final_preview"
  | "worker_final";

export interface ConversationOutboundDeliveryTrace {
  source: ConversationOutboundDeliverySource;
  sessionKey?: string | null;
  jobId?: string | null;
  jobCreatedAt?: string | null;
  inboundEventId?: string | null;
  inboundReceivedAt?: string | null;
}

export interface ConversationNotifierCapabilities {
  supportsEdit: boolean;
  supportsNativeStreaming: boolean;
}

export interface ConversationNotifierTransport {
  capabilities: ConversationNotifierCapabilities;
  send(
    message: string,
    trace?: ConversationOutboundDeliveryTrace
  ): Promise<ConversationDeliveryResult>;
  edit?(
    messageId: string,
    message: string,
    trace?: ConversationOutboundDeliveryTrace
  ): Promise<ConversationDeliveryResult>;
  stream?(
    message: string,
    trace?: ConversationOutboundDeliveryTrace
  ): Promise<ConversationDeliveryResult>;
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

export type {
  ConversationMemoryFactReviewRecord,
  ConversationMemoryFactReviewRequest,
  ConversationMemoryFactReviewResult,
  ConversationMemoryFactMutationRequest,
  ConversationMemoryMutationRequest,
  ConversationMemoryReviewRecord,
  ConversationMemoryReviewRequest,
  CorrectConversationMemoryFact,
  ForgetConversationMemoryEpisode,
  ForgetConversationMemoryFact,
  MarkConversationMemoryEpisodeWrong,
  ResolveConversationMemoryEpisode,
  ReviewConversationMemory,
  ReviewConversationMemoryFacts
} from "./memoryReviewContracts";

export type ListAvailableSkills = () => Promise<readonly SkillInventoryEntry[]>;

export type DescribeRuntimeCapabilities = () => Promise<ConversationCapabilitySummary>;

export interface ConversationEntityAliasCandidateRequest {
  entityKey: string;
  aliasCandidate: string;
  observedAt: string;
  evidenceRef: string;
}

export interface ConversationEntityAliasCandidateResult {
  acceptedAlias: string | null;
  rejectionReason: string | null;
}

export type ReconcileConversationEntityAliasCandidate = (
  request: ConversationEntityAliasCandidateRequest
) => Promise<ConversationEntityAliasCandidateResult | null>;

export type RememberConversationProfileInput = (
  input: string | ProfileMemoryIngestRequest,
  receivedAt: string
) => Promise<boolean>;
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
  proposalReplyInterpretationResolver?: ProposalReplyInterpretationResolver;
  topicKeyInterpretationResolver?: TopicKeyInterpretationResolver;
  intentInterpreterConfidenceThreshold?: number;
  runCheckpointReview?: ConversationCheckpointReviewRunner;
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  queryContinuityFacts?: QueryConversationContinuityFacts;
  openContinuityReadSession?: OpenConversationContinuityReadSession;
  getEntityGraph?: GetConversationEntityGraph;
  reconcileEntityAliasCandidate?: ReconcileConversationEntityAliasCandidate;
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

/**
 * Resolves the bounded command-routing text used for slash-command and pulse-control classification.
 *
 * @param message - Inbound provider message.
 * @returns User-authored routing text, excluding OCR/document payloads.
 */
export function resolveConversationCommandRoutingInput(
  message: ConversationInboundMessage
): string {
  if (typeof message.commandRoutingText === "string") {
    return message.commandRoutingText.trim();
  }
  return buildConversationCommandRoutingInput(message.text, message.media);
}

