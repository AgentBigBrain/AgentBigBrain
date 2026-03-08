/**
 * @fileoverview Canonical runtime state and task-result contracts extracted from the shared runtime type surface.
 */

import type { ActionRunResult } from "./governanceOutcomeTypes";
import type { Plan, TaskRequest } from "./taskPlanningTypes";
import type { FailureTaxonomyResultV1 } from "./decisionSupportTypes";

export interface TaskRunResult {
  task: TaskRequest;
  plan: Plan;
  actionResults: ActionRunResult[];
  summary: string;
  failureTaxonomy?: FailureTaxonomyResultV1;
  modelUsage?: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedSpendUsd: number;
  };
  startedAt: string;
  completedAt: string;
}

export interface BrainMetrics {
  totalTasks: number;
  totalActions: number;
  approvedActions: number;
  blockedActions: number;
  fastPathActions: number;
  escalationActions: number;
}

export interface BrainState {
  createdAt: string;
  lastRunAt?: string;
  runs: TaskRunResult[];
  metrics: BrainMetrics;
}

export type ProfileMemoryStatus = "disabled" | "available" | "degraded_unavailable";
