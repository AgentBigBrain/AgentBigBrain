/**
 * @fileoverview Canonical planner-input and per-attempt planning helpers for the orchestrator.
 */

import { type PlannerOrgan } from "../../organs/planner";
import { type MemoryBrokerOrgan } from "../../organs/memoryBroker";
import { extractActiveRequestSegment } from "../currentRequestExtraction";
import { type AppendRuntimeTraceEventInput } from "../runtimeTraceLogger";
import { type TaskRequest, type TaskRunResult, type WorkflowPattern } from "../types";
import { type JudgmentPattern, type JudgmentPatternStore } from "../judgmentPatterns";
import { type WorkflowLearningStore } from "../workflowLearningStore";
import {
  type PlannerLearningContext,
  type ProfileAwareInput,
  type Stage685PlaybookPlanningContextResolver
} from "./contracts";

export interface BuildProfileAwareInputDependencies {
  memoryBroker: Pick<MemoryBrokerOrgan, "buildPlannerInput">;
}

export interface LoadPlannerLearningContextDependencies {
  workflowLearningStore?: Pick<WorkflowLearningStore, "getRelevantPatterns">;
  judgmentPatternStore?: Pick<JudgmentPatternStore, "getRelevantPatterns">;
}

export interface PlanOrchestratorAttemptInput {
  appendTraceEvent: (input: AppendRuntimeTraceEventInput) => Promise<void>;
  maxActionsPerTask: number;
  planner: Pick<PlannerOrgan, "plan">;
  plannerLearningContext: PlannerLearningContext;
  plannerModel: string;
  resolvePlaybookPlanningContext: Stage685PlaybookPlanningContextResolver;
  synthesizerModel: string;
  task: TaskRequest;
  attemptNumber: number;
  userInput: string;
}

/**
 * Builds planner-facing input enriched with profile-memory context when available.
 *
 * @param deps - Planner-input enrichment dependencies.
 * @param task - Current task request.
 * @returns Profile-aware input string plus profile-memory status metadata.
 */
export async function buildProfileAwareInput(
  deps: BuildProfileAwareInputDependencies,
  task: TaskRequest
): Promise<ProfileAwareInput> {
  return deps.memoryBroker.buildPlannerInput(task);
}

/**
 * Loads pre-plan workflow and judgment hints for planner guidance.
 *
 * @param deps - Learning-store dependencies used to fetch hints.
 * @param plannerUserInput - Planner-facing user input for the current task run.
 * @returns Deterministic workflow and judgment hint bundle.
 */
export async function loadPlannerLearningContext(
  deps: LoadPlannerLearningContextDependencies,
  plannerUserInput: string
): Promise<PlannerLearningContext> {
  const contextQuery = extractActiveRequestSegment(plannerUserInput).trim();
  if (!contextQuery) {
    return {
      workflowHints: [],
      judgmentHints: []
    };
  }

  let workflowHints: readonly WorkflowPattern[] = [];
  if (deps.workflowLearningStore) {
    try {
      workflowHints = await deps.workflowLearningStore.getRelevantPatterns(contextQuery, 3);
    } catch (error) {
      console.error(
        `[WorkflowLearning] non-fatal hint retrieval failure: ${(error as Error).message}`
      );
    }
  }

  let judgmentHints: readonly JudgmentPattern[] = [];
  if (deps.judgmentPatternStore) {
    try {
      judgmentHints = await deps.judgmentPatternStore.getRelevantPatterns(contextQuery, 3);
    } catch (error) {
      console.error(
        `[JudgmentPattern] non-fatal hint retrieval failure: ${(error as Error).message}`
      );
    }
  }

  return {
    workflowHints,
    judgmentHints
  };
}

/**
 * Runs planner generation for one attempt, including playbook context and action capping.
 *
 * @param input - Planner-attempt inputs and runtime collaborators.
 * @returns Planned action bundle ready for task-runner execution.
 */
export async function planOrchestratorAttempt(
  input: PlanOrchestratorAttemptInput
): Promise<TaskRunResult["plan"]> {
  const plannerStartedAtMs = Date.now();
  const playbookPlanningContext = await input.resolvePlaybookPlanningContext({
    userInput: input.task.userInput,
    nowIso: new Date().toISOString()
  });
  const plannerTask: TaskRequest = {
    ...input.task,
    userInput: input.userInput
  };
  const rawPlan = await input.planner.plan(
    plannerTask,
    input.plannerModel,
    input.synthesizerModel,
    {
      playbookSelection: playbookPlanningContext,
      workflowHints: input.plannerLearningContext.workflowHints,
      judgmentHints: input.plannerLearningContext.judgmentHints
    }
  );
  const cappedActions = rawPlan.actions.slice(0, input.maxActionsPerTask);
  const playbookSuffix = playbookPlanningContext.selectedPlaybookId
    ? ` [playbook=${playbookPlanningContext.selectedPlaybookId}]`
    : " [playbook=fallback]";
  const replanSuffix = input.attemptNumber > 1 ? ` [replanAttempt=${input.attemptNumber}]` : "";
  const plan = {
    ...rawPlan,
    plannerNotes: `${rawPlan.plannerNotes}${playbookSuffix}${replanSuffix}`,
    actions: cappedActions
  };
  await input.appendTraceEvent({
    eventType: "planner_completed",
    taskId: input.task.id,
    durationMs: Date.now() - plannerStartedAtMs,
    details: {
      attemptNumber: input.attemptNumber,
      plannerModel: input.plannerModel,
      synthesizerModel: input.synthesizerModel,
      actionCount: plan.actions.length,
      firstPrinciplesRequired: plan.firstPrinciples?.required ?? false,
      firstPrinciplesTriggerCount: plan.firstPrinciples?.triggerReasons.length ?? 0,
      workflowHintCount: plan.learningHints?.workflowHintCount ?? 0,
      judgmentHintCount: plan.learningHints?.judgmentHintCount ?? 0,
      playbookSelectedId: playbookPlanningContext.selectedPlaybookId,
      playbookFallback: playbookPlanningContext.fallbackToPlanner
    }
  });
  return plan;
}
