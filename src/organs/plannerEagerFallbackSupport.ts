import type {
  FirstPrinciplesPacketV1,
  Plan,
  PlannerLearningHintSummaryV1,
  TaskRequest
} from "../core/types";
import type { PlannerExecutionEnvironmentContext } from "./plannerPolicy/executionStyleContracts";
import { buildDeterministicDesktopRuntimeProcessSweepFallbackActions } from "./plannerPolicy/desktopRuntimeProcessSweepFallback";
import { buildDeterministicStaticArtifactOpenBrowserFallbackActions } from "./plannerPolicy/staticArtifactOpenSupport";
import { maybeFinalizeDeterministicPlannerFallbackPlan } from "./plannerDeterministicFallbackSupport";

interface ResolveEagerDeterministicPlannerFallbackPlanOptions {
  task: TaskRequest;
  currentUserRequest: string;
  requiredActionType: Parameters<typeof maybeFinalizeDeterministicPlannerFallbackPlan>[0]["requiredActionType"];
  executionEnvironment: PlannerExecutionEnvironmentContext;
  firstPrinciples: FirstPrinciplesPacketV1;
  learningHints: PlannerLearningHintSummaryV1 | undefined;
  failureFingerprint: string;
  clearFailureFingerprint: (fingerprint: string) => Promise<void>;
}

/**
 * Resolves eager deterministic planner fallback plan.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `Plan` (import `Plan`) from `../core/types`.
 * - Uses `maybeFinalizeDeterministicPlannerFallbackPlan` (import `maybeFinalizeDeterministicPlannerFallbackPlan`) from `./plannerDeterministicFallbackSupport`.
 * - Uses `buildDeterministicDesktopRuntimeProcessSweepFallbackActions` (import `buildDeterministicDesktopRuntimeProcessSweepFallbackActions`) from `./plannerPolicy/desktopRuntimeProcessSweepFallback`.
 * - Uses `buildDeterministicStaticArtifactOpenBrowserFallbackActions` (import `buildDeterministicStaticArtifactOpenBrowserFallbackActions`) from `./plannerPolicy/staticArtifactOpenSupport`.
 * @param options - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export async function resolveEagerDeterministicPlannerFallbackPlan(
  options: ResolveEagerDeterministicPlannerFallbackPlanOptions
): Promise<Plan | null> {
  const eagerStaticArtifactOpenActions = options.requiredActionType === "open_browser"
    ? buildDeterministicStaticArtifactOpenBrowserFallbackActions(options.task.userInput)
    : [];
  const eagerStaticArtifactOpenPlan = await maybeFinalizeDeterministicPlannerFallbackPlan({
    taskId: options.task.id,
    plannerNotes: `Deterministic static artifact browser-open fallback (deterministic_static_artifact_open_fallback=${eagerStaticArtifactOpenActions[0]?.type ?? "unknown"})`,
    actions: eagerStaticArtifactOpenActions,
    currentUserRequest: options.currentUserRequest,
    requiredActionType: options.requiredActionType,
    userInput: options.task.userInput,
    executionEnvironment: options.executionEnvironment,
    firstPrinciples: options.firstPrinciples,
    learningHints: options.learningHints,
    failureFingerprint: options.failureFingerprint,
    clearFailureFingerprint: options.clearFailureFingerprint
  });
  if (eagerStaticArtifactOpenPlan) {
    return eagerStaticArtifactOpenPlan;
  }

  const eagerDeterministicDesktopRuntimeProcessSweepActions =
    buildDeterministicDesktopRuntimeProcessSweepFallbackActions(
      options.task.userInput,
      options.executionEnvironment
    );
  const eagerDesktopSweepPlan = await maybeFinalizeDeterministicPlannerFallbackPlan({
    taskId: options.task.id,
    plannerNotes: "Deterministic desktop runtime process sweep fallback " +
      `(deterministic_desktop_runtime_process_sweep_fallback=${eagerDeterministicDesktopRuntimeProcessSweepActions[0]?.type ?? "unknown"})`,
    actions: eagerDeterministicDesktopRuntimeProcessSweepActions,
    currentUserRequest: options.currentUserRequest,
    requiredActionType: options.requiredActionType,
    userInput: options.task.userInput,
    executionEnvironment: options.executionEnvironment,
    firstPrinciples: options.firstPrinciples,
    learningHints: options.learningHints,
    failureFingerprint: options.failureFingerprint,
    clearFailureFingerprint: options.clearFailureFingerprint
  });
  if (eagerDesktopSweepPlan) {
    return eagerDesktopSweepPlan;
  }
  return null;
}
