/**
 * @fileoverview Canonical session-state contracts for interface conversation persistence.
 */

import type { PulseEmissionRecordV1 } from "../../core/stage6_86PulseCandidates";
import type { ConversationStackV1 } from "../../core/types";

export type ProposalStatus = "pending" | "approved" | "cancelled" | "executed";
export type ConversationJobStatus = "queued" | "running" | "completed" | "failed";
export type ConversationAckLifecycleState =
  | "NOT_SENT"
  | "SENT"
  | "REPLACED"
  | "FINAL_SENT_NO_EDIT"
  | "CANCELLED";
export type ConversationFinalDeliveryOutcome =
  | "not_attempted"
  | "sent"
  | "rate_limited"
  | "failed";
export type ConversationTurnRole = "user" | "assistant";
export type ConversationVisibility = "private" | "public" | "unknown";
export type ConversationClassifierKind = "follow_up" | "proposal_reply" | "pulse_lexical";
export type ConversationClassifierCategory =
  | "ACK"
  | "APPROVE"
  | "DENY"
  | "UNCLEAR"
  | "COMMAND"
  | "NON_COMMAND";
export type ConversationClassifierConfidenceTier = "HIGH" | "MED" | "LOW";
export type ConversationClassifierIntent =
  | "APPROVE"
  | "CANCEL"
  | "ADJUST"
  | "QUESTION"
  | "on"
  | "off"
  | "private"
  | "public"
  | "status"
  | null;
export type AgentPulseMode = "private" | "public";
export type AgentPulseRouteStrategy = "last_private_used" | "current_conversation";
export type ConversationIntentMode =
  | "chat"
  | "explain"
  | "plan"
  | "build"
  | "autonomous"
  | "review"
  | "discover_available_capabilities"
  | "status_or_recall"
  | "unclear";
export type ConversationIntentModeSource =
  | "slash_command"
  | "voice_command"
  | "natural_intent"
  | "clarification_answer";
export type ConversationRecentActionKind =
  | "file"
  | "folder"
  | "browser_session"
  | "process"
  | "url"
  | "report"
  | "task_summary";
export type ConversationRecentActionStatus =
  | "created"
  | "updated"
  | "open"
  | "closed"
  | "running"
  | "completed"
  | "failed";
export type ConversationProgressStatus =
  | "idle"
  | "starting"
  | "working"
  | "retrying"
  | "verifying"
  | "waiting_for_user"
  | "completed"
  | "stopped";
export type ConversationBrowserSessionStatus = "open" | "closed";
export type ConversationBrowserSessionControllerKind = "playwright_managed" | "os_default";
export type ConversationWorkspaceOwnershipState = "tracked" | "stale" | "orphaned";
export type ConversationWorkspacePreviewStackState =
  | "browser_and_preview"
  | "browser_only"
  | "preview_only"
  | "detached";
export type ConversationReturnHandoffStatus = "completed" | "stopped" | "waiting_for_user";
export type AgentPulseDecisionCode =
  | "ALLOWED"
  | "DISABLED"
  | "OPT_OUT"
  | "NO_PRIVATE_ROUTE"
  | "NO_STALE_FACTS"
  | "NO_UNRESOLVED_COMMITMENTS"
  | "NO_CONTEXTUAL_LINKAGE"
  | "RELATIONSHIP_ROLE_SUPPRESSED"
  | "CONTEXT_DRIFT_SUPPRESSED"
  | "CONTEXTUAL_TOPIC_COOLDOWN"
  | "QUIET_HOURS"
  | "RATE_LIMIT"
  | "NOT_EVALUATED"
  | "DYNAMIC_SENT"
  | "DYNAMIC_SUPPRESSED";

export interface AgentPulseContextualLexicalEvidence {
  matchedRuleId: string;
  rulepackVersion: string;
  rulepackFingerprint: string;
  confidenceTier: ConversationClassifierConfidenceTier;
  confidence: number;
  conflict: boolean;
  candidateTokens: string[];
  evaluatedAt: string;
}

export interface ConversationTurn {
  role: ConversationTurnRole;
  text: string;
  at: string;
}

export interface AgentPulseSessionState {
  optIn: boolean;
  mode: AgentPulseMode;
  routeStrategy: AgentPulseRouteStrategy;
  lastPulseSentAt: string | null;
  lastPulseReason: string | null;
  lastPulseTargetConversationId: string | null;
  lastDecisionCode: AgentPulseDecisionCode;
  lastEvaluatedAt: string | null;
  lastContextualLexicalEvidence?: AgentPulseContextualLexicalEvidence | null;
  recentEmissions?: PulseEmissionRecordV1[];
  userStyleFingerprint?: string;
  userTimezone?: string;
}

export interface PendingProposal {
  id: string;
  originalInput: string;
  currentInput: string;
  createdAt: string;
  updatedAt: string;
  status: ProposalStatus;
}

export type ClarificationOptionId =
  | "plan"
  | "build"
  | "explain"
  | "fix_now"
  | "skills"
  | "continue_recovery"
  | "retry_with_shutdown"
  | "cancel";

export interface ActiveClarificationOption {
  id: ClarificationOptionId;
  label: string;
}

export interface ActiveClarificationState {
  id: string;
  kind: "execution_mode" | "task_recovery";
  sourceInput: string;
  question: string;
  requestedAt: string;
  matchedRuleId: string;
  recoveryInstruction?: string | null;
  options: readonly ActiveClarificationOption[];
}

export interface ConversationModeContinuityState {
  activeMode: ConversationIntentMode;
  source: ConversationIntentModeSource;
  confidence: ConversationClassifierConfidenceTier;
  lastAffirmedAt: string;
  lastUserInput: string;
  lastClarificationId?: string | null;
}

export interface ConversationRecentActionRecord {
  id: string;
  kind: ConversationRecentActionKind;
  label: string;
  location: string | null;
  status: ConversationRecentActionStatus;
  sourceJobId: string | null;
  at: string;
  summary: string;
}

export interface ConversationProgressState {
  status: ConversationProgressStatus;
  message: string;
  jobId: string | null;
  updatedAt: string;
}

export interface ConversationReturnHandoffRecord {
  id: string;
  status: ConversationReturnHandoffStatus;
  goal: string;
  summary: string;
  nextSuggestedStep: string | null;
  workspaceRootPath: string | null;
  primaryArtifactPath: string | null;
  previewUrl: string | null;
  changedPaths: string[];
  sourceJobId: string | null;
  updatedAt: string;
}

export interface ConversationBrowserSessionRecord {
  id: string;
  label: string;
  url: string;
  status: ConversationBrowserSessionStatus;
  openedAt: string;
  closedAt: string | null;
  sourceJobId: string | null;
  visibility: "visible" | "headless";
  controllerKind: ConversationBrowserSessionControllerKind;
  controlAvailable: boolean;
  browserProcessPid: number | null;
  workspaceRootPath?: string | null;
  linkedProcessLeaseId: string | null;
  linkedProcessCwd: string | null;
  linkedProcessPid: number | null;
}

export interface ConversationPathDestinationRecord {
  id: string;
  label: string;
  resolvedPath: string;
  sourceJobId: string | null;
  updatedAt: string;
}

export interface ConversationActiveWorkspaceRecord {
  id: string;
  label: string;
  rootPath: string | null;
  primaryArtifactPath: string | null;
  previewUrl: string | null;
  browserSessionId: string | null;
  browserSessionIds: string[];
  browserSessionStatus: ConversationBrowserSessionStatus | null;
  browserProcessPid: number | null;
  previewProcessLeaseId: string | null;
  previewProcessLeaseIds: string[];
  previewProcessCwd: string | null;
  lastKnownPreviewProcessPid: number | null;
  stillControllable: boolean;
  ownershipState: ConversationWorkspaceOwnershipState;
  previewStackState: ConversationWorkspacePreviewStackState;
  lastChangedPaths: string[];
  sourceJobId: string | null;
  updatedAt: string;
}

export interface ConversationJob {
  id: string;
  input: string;
  executionInput?: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  status: ConversationJobStatus;
  resultSummary: string | null;
  errorMessage: string | null;
  isSystemJob?: boolean;
  ackTimerGeneration: number;
  ackEligibleAt: string | null;
  ackLifecycleState: ConversationAckLifecycleState;
  ackMessageId: string | null;
  ackSentAt: string | null;
  ackEditAttemptCount: number;
  ackLastErrorCode: string | null;
  finalDeliveryOutcome: ConversationFinalDeliveryOutcome;
  finalDeliveryAttemptCount: number;
  finalDeliveryLastErrorCode: string | null;
  finalDeliveryLastAttemptAt: string | null;
  pauseRequestedAt?: string | null;
}

export interface ConversationClassifierEvent {
  classifier: ConversationClassifierKind;
  input: string;
  at: string;
  isShortFollowUp: boolean;
  category: ConversationClassifierCategory;
  confidenceTier: ConversationClassifierConfidenceTier;
  matchedRuleId: string;
  rulepackVersion: string;
  intent: ConversationClassifierIntent;
  conflict?: boolean;
}

export interface ConversationSession {
  conversationId: string;
  userId: string;
  username: string;
  conversationVisibility: ConversationVisibility;
  sessionSchemaVersion?: "v1" | "v2";
  conversationStack?: ConversationStackV1;
  updatedAt: string;
  activeProposal: PendingProposal | null;
  activeClarification: ActiveClarificationState | null;
  modeContinuity: ConversationModeContinuityState | null;
  progressState: ConversationProgressState | null;
  returnHandoff: ConversationReturnHandoffRecord | null;
  runningJobId: string | null;
  queuedJobs: ConversationJob[];
  recentJobs: ConversationJob[];
  recentActions: ConversationRecentActionRecord[];
  browserSessions: ConversationBrowserSessionRecord[];
  pathDestinations: ConversationPathDestinationRecord[];
  activeWorkspace: ConversationActiveWorkspaceRecord | null;
  conversationTurns: ConversationTurn[];
  classifierEvents?: ConversationClassifierEvent[];
  agentPulse: AgentPulseSessionState;
}
