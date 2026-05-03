/**
 * @fileoverview Canonical session-state contracts for interface conversation persistence.
 */

import type { PulseEmissionRecordV1 } from "../../core/stage6_86PulseCandidates";
import type {
  ConversationDomainContext,
  ConversationDomainLane,
  ConversationDomainRoutingMode
} from "../../core/sessionContext";
import type { RecoveryFailureClass } from "../../core/autonomy/contracts";
import type { ConversationStackV1 } from "../../core/types";
import type { ModelBackend } from "../../models/types";

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
export type ConversationAssistantTurnKind =
  | "clarification"
  | "informational_answer"
  | "workflow_progress"
  | "other";
export type ConversationTurnMetadataSource =
  | "runtime_metadata"
  | "legacy_text_inference";
export interface ConversationTurnMetadata {
  assistantTurnKind?: ConversationAssistantTurnKind;
  assistantTurnKindSource?: ConversationTurnMetadataSource;
}
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
export type ConversationIntentMode = ConversationDomainRoutingMode;
export type ConversationTransportProvider = "telegram" | "discord";
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
export type ConversationRecoveryKind =
  | "structured_executor_recovery"
  | "workspace_auto_recovery"
  | "stale_session_recovery";
export type ConversationRecoveryStatus = "attempting" | "recovered" | "failed";
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
  | "SESSION_DOMAIN_SUPPRESSED"
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
  id?: string;
  role: ConversationTurnRole;
  text: string;
  at: string;
  metadata?: ConversationTurnMetadata;
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
  | "static_html"
  | "nextjs"
  | "react"
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

export type ClarificationRenderingIntent =
  | "build_format"
  | "plan_or_build"
  | "fix_or_explain"
  | "task_recovery";

export type ClarificationRiskClass = "low" | "medium" | "high";

export interface ActiveClarificationState {
  id: string;
  kind: "execution_mode" | "build_format" | "task_recovery";
  sourceInput: string;
  question: string;
  requestedAt: string;
  matchedRuleId: string;
  renderingIntent: ClarificationRenderingIntent;
  riskClass?: ClarificationRiskClass;
  promptFingerprint?: string;
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

export interface ConversationRecoveryTrace {
  kind: ConversationRecoveryKind;
  status: ConversationRecoveryStatus;
  summary: string;
  updatedAt: string;
  recoveryClass?: RecoveryFailureClass | null;
  fingerprint?: string | null;
}

export interface ConversationProgressState {
  status: ConversationProgressStatus;
  message: string;
  jobId: string | null;
  updatedAt: string;
  recoveryTrace?: ConversationRecoveryTrace | null;
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
  domainSnapshotLane?: ConversationDomainLane | null;
  domainSnapshotRecordedAt?: string | null;
  updatedAt: string;
}

export interface ConversationTransportIdentityRecord {
  provider: ConversationTransportProvider;
  username: string | null;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  observedAt: string;
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
  at?: string;
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
  domainSnapshotLane?: ConversationDomainLane | null;
  domainSnapshotRecordedAt?: string | null;
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
  recoveryTrace?: ConversationRecoveryTrace | null;
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
  transportIdentity?: ConversationTransportIdentityRecord | null;
  conversationVisibility: ConversationVisibility;
  sessionSchemaVersion?: "v1" | "v2";
  conversationStack?: ConversationStackV1;
  updatedAt: string;
  modelBackendOverride?: ModelBackend | null;
  codexAuthProfileId?: string | null;
  activeProposal: PendingProposal | null;
  activeClarification: ActiveClarificationState | null;
  domainContext: ConversationDomainContext;
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
