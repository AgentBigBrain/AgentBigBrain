import type {
  FirstPrinciplesPacketV1,
  Plan,
  PlannedAction,
  PlannerLearningHintSummaryV1
} from "../core/types";
import { assertPlannerActionValidation, evaluatePlannerActionValidation } from "./plannerPolicy/explicitActionRepair";
import type { PlannerExecutionEnvironmentContext } from "./plannerPolicy/executionStyleContracts";

interface DeterministicPlannerFallbackPlanOptions {
  taskId: string;
  plannerNotes: string;
  actions: PlannedAction[];
  currentUserRequest: string;
  requiredActionType: Parameters<typeof evaluatePlannerActionValidation>[1];
  userInput: string;
  executionEnvironment: PlannerExecutionEnvironmentContext;
  firstPrinciples: FirstPrinciplesPacketV1;
  learningHints: PlannerLearningHintSummaryV1 | undefined;
  failureFingerprint: string;
  clearFailureFingerprint: (fingerprint: string) => Promise<void>;
}

/**
 * Attempts to finalize deterministic planner fallback plan.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `Plan` (import `Plan`) from `../core/types`.
 * - Uses `assertPlannerActionValidation` (import `assertPlannerActionValidation`) from `./plannerPolicy/explicitActionRepair`.
 * - Uses `evaluatePlannerActionValidation` (import `evaluatePlannerActionValidation`) from `./plannerPolicy/explicitActionRepair`.
 * @param options - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export async function maybeFinalizeDeterministicPlannerFallbackPlan(
  options: DeterministicPlannerFallbackPlanOptions
): Promise<Plan | null> {
  if (options.actions.length === 0) {
    return null;
  }
  const fallbackValidation = evaluatePlannerActionValidation(
    options.currentUserRequest,
    options.requiredActionType,
    options.actions,
    options.userInput,
    options.executionEnvironment
  );
  assertPlannerActionValidation(fallbackValidation, options.requiredActionType);
  await options.clearFailureFingerprint(options.failureFingerprint);
  return {
    taskId: options.taskId,
    plannerNotes: options.plannerNotes,
    firstPrinciples: options.firstPrinciples,
    learningHints: options.learningHints,
    actions: options.actions
  };
}
