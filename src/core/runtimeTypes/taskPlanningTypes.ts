/**
 * @fileoverview Canonical task, shell, and planning contracts extracted from the shared runtime type surface.
 */

import type { ActionType } from "./actionTypes";
import type { ConflictObjectV1 } from "./persistenceTypes";
import type { FirstPrinciplesPacketV1 } from "./decisionSupportTypes";

export interface TaskRequest {
  id: string;
  agentId?: string;
  goal: string;
  userInput: string;
  createdAt: string;
}

export interface RespondActionParams extends Record<string, unknown> {
  message?: string;
  text?: string;
  actorIdentity?: string;
  speakerRole?: string;
  impersonateHuman?: boolean;
  sharePersonalData?: boolean;
  explicitHumanApproval?: boolean;
  approvalId?: string;
  dataClassification?: string;
  recipient?: string;
  recipientId?: string;
  recipientName?: string;
  audience?: string;
  destination?: string;
  destinationAgentId?: string;
  targetUserId?: string;
  targetConversationId?: string;
  channel?: string;
  conversationId?: string;
}

export interface ReadFileActionParams extends Record<string, unknown> {
  path?: string;
}

export interface WriteFileActionParams extends Record<string, unknown> {
  path?: string;
  content?: string;
}

export interface DeleteFileActionParams extends Record<string, unknown> {
  path?: string;
}

export interface ListDirectoryActionParams extends Record<string, unknown> {
  path?: string;
}

export interface CreateSkillActionParams extends Record<string, unknown> {
  name?: string;
  kind?: "executable_module" | "markdown_instruction";
  origin?: "runtime_user";
  activationSource?: "explicit_user_request" | "agent_suggestion" | "operator_approval";
  code?: string;
  instructions?: string;
  markdownContent?: string;
  content?: string;
  description?: string;
  purpose?: string;
  inputSummary?: string;
  outputSummary?: string;
  riskLevel?: string;
  allowedSideEffects?: readonly string[];
  tags?: readonly string[];
  capabilities?: readonly string[];
  applicability?: readonly string[];
  memoryPolicy?: "none" | "candidate_only" | "operator_approved";
  projectionPolicy?: "metadata_only" | "review_safe_excerpt" | "operator_full_content";
  version?: string;
  userSummary?: string;
  invocationHints?: readonly string[];
  testInput?: string;
  expectedOutputContains?: string;
}

export interface UpdateSkillActionParams extends Record<string, unknown> {
  name?: string;
  code?: string;
  instructions?: string;
  markdownContent?: string;
  content?: string;
  description?: string;
  purpose?: string;
  inputSummary?: string;
  outputSummary?: string;
  riskLevel?: string;
  allowedSideEffects?: readonly string[];
  tags?: readonly string[];
  capabilities?: readonly string[];
  memoryPolicy?: "none" | "candidate_only" | "operator_approved";
  projectionPolicy?: "metadata_only" | "review_safe_excerpt" | "operator_full_content";
  version?: string;
  userSummary?: string;
  invocationHints?: readonly string[];
}

export interface SkillLifecycleActionParams extends Record<string, unknown> {
  name?: string;
  reason?: string;
}

export interface RunSkillActionParams extends Record<string, unknown> {
  name?: string;
  input?: string;
  text?: string;
  exportName?: string;
}

export interface NetworkWriteActionParams extends Record<string, unknown> {
  endpoint?: string;
  url?: string;
  payload?: unknown;
  method?: string;
  connector?: "gmail" | "calendar";
  operation?: "read" | "watch" | "draft" | "propose" | "write" | "update" | "delete";
  approvalDiff?: string;
  approvalExpiresAt?: string;
  approvalMaxUses?: number;
  approvalUses?: number;
  approvalActionIds?: readonly string[];
  idempotencyKey?: string;
  idempotencyKeys?: readonly string[];
  riskClass?: "tier_2" | "tier_3";
  approvedBy?: string;
  lastReadAtIso?: string;
  observedAtWatermark?: string;
  freshnessWindowMs?: number;
  unresolvedConflict?: ConflictObjectV1;
  requiresConsistencyPreflight?: boolean;
  externalIds?: readonly string[];
  sharePersonalData?: boolean;
  explicitHumanApproval?: boolean;
  approvalId?: string;
  dataClassification?: string;
  recipient?: string;
  recipientId?: string;
  recipientName?: string;
  audience?: string;
  destination?: string;
  destinationAgentId?: string;
  targetUserId?: string;
  targetConversationId?: string;
  channel?: string;
  conversationId?: string;
}

export interface SelfModifyActionParams extends Record<string, unknown> {
  target?: string;
  touchesImmutable?: boolean;
}

export type ShellKindV1 = "powershell" | "pwsh" | "cmd" | "bash" | "zsh" | "wsl_bash";

export type ShellInvocationModeV1 = "inline_command";

export type EnvModeV1 = "allowlist" | "passthrough";

export interface ShellEnvPolicyV1 {
  mode: EnvModeV1;
  allowlist?: readonly string[];
  denylist?: readonly string[];
}

export interface ShellCwdPolicyV1 {
  allowRelative: boolean;
  normalize: "posix" | "native";
  denyOutsideSandbox: boolean;
}

export interface ShellRuntimeProfileV1 {
  profileVersion: "v1";
  platform: "win32" | "darwin" | "linux";
  shellKind: ShellKindV1;
  executable: string;
  invocationMode: ShellInvocationModeV1;
  wrapperArgs: readonly string[];
  encoding: "utf8";
  commandMaxChars: number;
  timeoutMsDefault: number;
  envPolicy: ShellEnvPolicyV1;
  cwdPolicy: ShellCwdPolicyV1;
  wslPolicy?: {
    enabled: boolean;
    windowsOnly: true;
    distro?: string;
  };
}

export interface ShellSpawnSpecV1 {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  envMode: EnvModeV1;
  envKeyNames: readonly string[];
}

export interface ShellCommandActionParams extends Record<string, unknown> {
  command?: string;
  path?: string;
  target?: string;
  file?: string;
  directory?: string;
  cwd?: string;
  workdir?: string;
  timeoutMs?: number;
  requestedShellKind?: ShellKindV1;
  output?: string;
  input?: string;
}

export interface StartProcessActionParams extends Record<string, unknown> {
  command?: string;
  cwd?: string;
  workdir?: string;
  requestedShellKind?: ShellKindV1;
}

export interface CheckProcessActionParams extends Record<string, unknown> {
  leaseId?: string;
}

export interface StopProcessActionParams extends Record<string, unknown> {
  leaseId?: string;
  pid?: number;
  preserveLinkedBrowserSessions?: boolean;
}

export interface ProbePortActionParams extends Record<string, unknown> {
  host?: string;
  port?: number;
  timeoutMs?: number;
}

export interface ProbeHttpActionParams extends Record<string, unknown> {
  url?: string;
  expectedStatus?: number;
  timeoutMs?: number;
}

export interface VerifyBrowserActionParams extends Record<string, unknown> {
  url?: string;
  expectedTitle?: string;
  expectedText?: string;
  timeoutMs?: number;
}

export interface OpenBrowserActionParams extends Record<string, unknown> {
  url?: string;
  timeoutMs?: number;
  rootPath?: string;
  previewProcessLeaseId?: string;
}

export interface CloseBrowserActionParams extends Record<string, unknown> {
  sessionId?: string;
  url?: string;
}

export type FolderRuntimeProcessSelectorMode = "starts_with" | "contains";

export interface StopFolderRuntimeProcessesActionParams extends Record<string, unknown> {
  rootPath?: string;
  selectorMode?: FolderRuntimeProcessSelectorMode;
  selectorTerm?: string;
}

export interface InspectPathHoldersActionParams extends Record<string, unknown> {
  path?: string;
}

export interface InspectWorkspaceResourcesActionParams extends Record<string, unknown> {
  rootPath?: string;
  path?: string;
  previewUrl?: string;
  browserSessionId?: string;
  previewProcessLeaseId?: string;
}

export type MemoryMutationStoreV1 = "entity_graph" | "conversation_stack" | "pulse_state";

export type MemoryMutationOperationV1 = "upsert" | "merge" | "supersede" | "resolve" | "evict";

export interface MemoryMutationActionParams extends Record<string, unknown> {
  store?: MemoryMutationStoreV1;
  operation?: MemoryMutationOperationV1;
  mutationPath?: readonly string[];
  payload?: Record<string, unknown>;
  evidenceRefs?: readonly string[];
}

export interface PulseEmitActionParams extends Record<string, unknown> {
  kind?: "bridge_question" | "open_loop_resume" | "topic_resume" | "stale_fact_revalidation";
  reasonCode?: string;
  threadKey?: string;
  entityRefs?: readonly string[];
  evidenceRefs?: readonly string[];
}

export type PlannedActionParamsByType = {
  respond: RespondActionParams;
  read_file: ReadFileActionParams;
  write_file: WriteFileActionParams;
  delete_file: DeleteFileActionParams;
  list_directory: ListDirectoryActionParams;
  create_skill: CreateSkillActionParams;
  update_skill: UpdateSkillActionParams;
  deprecate_skill: SkillLifecycleActionParams;
  approve_skill: SkillLifecycleActionParams;
  reject_skill: SkillLifecycleActionParams;
  run_skill: RunSkillActionParams;
  network_write: NetworkWriteActionParams;
  self_modify: SelfModifyActionParams;
  shell_command: ShellCommandActionParams;
  start_process: StartProcessActionParams;
  check_process: CheckProcessActionParams;
  stop_process: StopProcessActionParams;
  probe_port: ProbePortActionParams;
  probe_http: ProbeHttpActionParams;
  verify_browser: VerifyBrowserActionParams;
  open_browser: OpenBrowserActionParams;
  close_browser: CloseBrowserActionParams;
  stop_folder_runtime_processes: StopFolderRuntimeProcessesActionParams;
  inspect_path_holders: InspectPathHoldersActionParams;
  inspect_workspace_resources: InspectWorkspaceResourcesActionParams;
  memory_mutation: MemoryMutationActionParams;
  pulse_emit: PulseEmitActionParams;
};

export type PlannedActionByType<T extends ActionType> = {
  id: string;
  type: T;
  description: string;
  params: PlannedActionParamsByType[T];
  estimatedCostUsd: number;
};

export type PlannedAction = {
  [K in ActionType]: PlannedActionByType<K>;
}[ActionType];

export interface PlannerLearningHintSummaryV1 {
  workflowHintCount: number;
  judgmentHintCount: number;
  workflowPreferredSkillName?: string | null;
  workflowSkillSuggestionCount?: number;
  plannerSkillGuidanceCount?: number;
}

export interface Plan {
  taskId: string;
  plannerNotes: string;
  actions: PlannedAction[];
  firstPrinciples?: FirstPrinciplesPacketV1;
  learningHints?: PlannerLearningHintSummaryV1;
}

export interface GovernanceProposal {
  id: string;
  taskId: string;
  requestedBy: string;
  rationale: string;
  action: PlannedAction;
  touchesImmutable: boolean;
}
