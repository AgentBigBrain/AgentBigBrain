/**
 * @fileoverview Shared orchestration contracts for core execution entrypoints and helpers.
 */

import { type Stage685PlaybookPlanningContext } from "../stage6_85PlaybookRuntime";
import { type FederatedOutboundRuntimeConfig } from "../federatedOutboundDelegation";
import { type ModelUsageSnapshot, type ModelClient } from "../../models/types";
import { type BrainConfig } from "../config";
import { type Governor } from "../../governors/types";
import { type MasterGovernor } from "../../governors/masterGovernor";
import { type ToolExecutorOrgan } from "../../organs/executor";
import { type GovernanceMemoryStore } from "../governanceMemory";
import { type ExecutionReceiptStore } from "../advancedAutonomyRuntime";
import { type AppendRuntimeTraceEventInput } from "../runtimeTraceLogger";
import { type Stage686RuntimeActionEngine } from "../stage6_86/runtimeActions";
import { type BrainState, type ProfileMemoryStatus, type TaskRunResult, type WorkflowPattern } from "../types";
import { type JudgmentPattern } from "../judgmentPatterns";

export type Stage685PlaybookPlanningContextResolver = (input: {
  userInput: string;
  nowIso: string;
}) => Promise<Stage685PlaybookPlanningContext>;

export type FederatedOutboundRuntimeConfigResolver = (
  env: NodeJS.ProcessEnv
) => FederatedOutboundRuntimeConfig;

export interface ProfileAwareInput {
  userInput: string;
  profileMemoryStatus: ProfileMemoryStatus;
}

export interface PlannerLearningContext {
  workflowHints: readonly WorkflowPattern[];
  judgmentHints: readonly JudgmentPattern[];
}

export interface RunTaskOptions {
  signal?: AbortSignal;
}

export interface TaskRunnerDependencies {
  config: BrainConfig;
  governors: Governor[];
  masterGovernor: MasterGovernor;
  modelClient: ModelClient;
  executor: ToolExecutorOrgan;
  governanceMemoryStore: GovernanceMemoryStore;
  executionReceiptStore: ExecutionReceiptStore;
  appendTraceEvent: (input: AppendRuntimeTraceEventInput) => Promise<void>;
  stage686RuntimeActionEngine?: Stage686RuntimeActionEngine;
}

export interface RunPlanActionsInput {
  task: TaskRunResult["task"];
  state: BrainState;
  plan: TaskRunResult["plan"];
  missionAttemptId: number;
  startedAtMs: number;
  cumulativeApprovedEstimatedCostUsd: number;
  modelUsageStart: ModelUsageSnapshot;
  profileMemoryStatus: ProfileMemoryStatus;
  signal?: AbortSignal;
}
