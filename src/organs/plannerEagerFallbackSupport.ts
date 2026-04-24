import type {
  FirstPrinciplesPacketV1,
  Plan,
  PlannerLearningHintSummaryV1,
  TaskRequest
} from "../core/types";
import {
  buildDeterministicFrameworkBuildFallbackActions
} from "./plannerPolicy/explicitRuntimeActionFallback";
import type { PlannerExecutionEnvironmentContext } from "./plannerPolicy/executionStyleContracts";
import { buildDeterministicDesktopRuntimeProcessSweepFallbackActions } from "./plannerPolicy/desktopRuntimeProcessSweepFallback";
import { buildDeterministicLocalOrganizationFallbackActions } from "./plannerPolicy/localOrganizationRuntimeActionFallback";
import {
  isDeterministicFrameworkBuildLaneRequest,
  isFrameworkWorkspacePreparationRequest,
  isStaticHtmlExecutionStyleRequest
} from "./plannerPolicy/liveVerificationPolicy";
import { buildDeterministicStaticArtifactOpenBrowserFallbackActions } from "./plannerPolicy/staticArtifactOpenSupport";
import {
  buildDeterministicStaticHtmlBuildFallbackActions,
  hasStaticHtmlBuildLaneMarker
} from "./plannerPolicy/staticHtmlRuntimeActionFallback";
import { hasFrameworkBuildLaneMarker } from "./plannerPolicy/frameworkRuntimeActionFallbackSupport";
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
 * - Uses `buildDeterministicFrameworkBuildFallbackActions` (import `buildDeterministicFrameworkBuildFallbackActions`) from `./plannerPolicy/explicitRuntimeActionFallback`.
 * - Uses `hasFrameworkBuildLaneMarker` (import `hasFrameworkBuildLaneMarker`) from `./plannerPolicy/frameworkRuntimeActionFallbackSupport`.
 * - Uses `isDeterministicFrameworkBuildLaneRequest` (import `isDeterministicFrameworkBuildLaneRequest`) from `./plannerPolicy/liveVerificationPolicy`.
 * - Uses `isFrameworkWorkspacePreparationRequest` (import `isFrameworkWorkspacePreparationRequest`) from `./plannerPolicy/liveVerificationPolicy`.
 * - Uses `isStaticHtmlExecutionStyleRequest` (import `isStaticHtmlExecutionStyleRequest`) from `./plannerPolicy/liveVerificationPolicy`.
 * - Uses `buildDeterministicLocalOrganizationFallbackActions` (import `buildDeterministicLocalOrganizationFallbackActions`) from `./plannerPolicy/localOrganizationRuntimeActionFallback`.
 * - Uses `buildDeterministicStaticArtifactOpenBrowserFallbackActions` (import `buildDeterministicStaticArtifactOpenBrowserFallbackActions`) from `./plannerPolicy/staticArtifactOpenSupport`.
 * - Uses `buildDeterministicStaticHtmlBuildFallbackActions` (import `buildDeterministicStaticHtmlBuildFallbackActions`) from `./plannerPolicy/staticHtmlRuntimeActionFallback`.
 * - Uses `hasStaticHtmlBuildLaneMarker` (import `hasStaticHtmlBuildLaneMarker`) from `./plannerPolicy/staticHtmlRuntimeActionFallback`.
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

  const eagerDeterministicStaticHtmlBuildActions =
    isStaticHtmlExecutionStyleRequest(options.task.userInput) ||
    hasStaticHtmlBuildLaneMarker(options.task.userInput)
      ? buildDeterministicStaticHtmlBuildFallbackActions(
          options.task.userInput,
          options.executionEnvironment,
          options.task.goal
        )
      : [];
  const eagerStaticHtmlPlan = await maybeFinalizeDeterministicPlannerFallbackPlan({
    taskId: options.task.id,
    plannerNotes: "Deterministic static HTML build fallback " +
      `(deterministic_static_html_build_fallback=${eagerDeterministicStaticHtmlBuildActions[0]?.type ?? "unknown"})`,
    actions: eagerDeterministicStaticHtmlBuildActions,
    currentUserRequest: options.currentUserRequest,
    requiredActionType: options.requiredActionType,
    userInput: options.task.userInput,
    executionEnvironment: options.executionEnvironment,
    firstPrinciples: options.firstPrinciples,
    learningHints: options.learningHints,
    failureFingerprint: options.failureFingerprint,
    clearFailureFingerprint: options.clearFailureFingerprint
  });
  if (eagerStaticHtmlPlan) {
    return eagerStaticHtmlPlan;
  }

  const eagerDeterministicFrameworkBuildActions =
    isDeterministicFrameworkBuildLaneRequest(options.task.userInput) ||
    hasFrameworkBuildLaneMarker(options.task.userInput)
      ? buildDeterministicFrameworkBuildFallbackActions(
          options.task.userInput,
          options.executionEnvironment,
          options.task.goal
        )
      : [];
  const eagerFrameworkPlan = await maybeFinalizeDeterministicPlannerFallbackPlan({
    taskId: options.task.id,
    plannerNotes: isFrameworkWorkspacePreparationRequest(options.task.userInput)
      ? "Deterministic framework workspace-preparation fallback " +
        `(deterministic_framework_workspace_preparation_fallback=${eagerDeterministicFrameworkBuildActions[0]?.type ?? "unknown"})`
      : "Deterministic framework build lifecycle fallback " +
        `(deterministic_framework_build_fallback=${eagerDeterministicFrameworkBuildActions[0]?.type ?? "unknown"})`,
    actions: eagerDeterministicFrameworkBuildActions,
    currentUserRequest: options.currentUserRequest,
    requiredActionType: options.requiredActionType,
    userInput: options.task.userInput,
    executionEnvironment: options.executionEnvironment,
    firstPrinciples: options.firstPrinciples,
    learningHints: options.learningHints,
    failureFingerprint: options.failureFingerprint,
    clearFailureFingerprint: options.clearFailureFingerprint
  });
  if (eagerFrameworkPlan) {
    return eagerFrameworkPlan;
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

  const eagerDeterministicLocalOrganizationActions =
    buildDeterministicLocalOrganizationFallbackActions(
      options.task.userInput,
      options.executionEnvironment
    );
  return maybeFinalizeDeterministicPlannerFallbackPlan({
    taskId: options.task.id,
    plannerNotes: "Deterministic local organization fallback " +
      `(deterministic_local_organization_fallback=${eagerDeterministicLocalOrganizationActions[0]?.type ?? "unknown"})`,
    actions: eagerDeterministicLocalOrganizationActions,
    currentUserRequest: options.currentUserRequest,
    requiredActionType: options.requiredActionType,
    userInput: options.task.userInput,
    executionEnvironment: options.executionEnvironment,
    firstPrinciples: options.firstPrinciples,
    learningHints: options.learningHints,
    failureFingerprint: options.failureFingerprint,
    clearFailureFingerprint: options.clearFailureFingerprint
  });
}
