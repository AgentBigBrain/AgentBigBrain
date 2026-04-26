/**
 * @fileoverview Produces task action plans strictly from model outputs and fails closed on planner/synthesis errors.
 */

import {
  FirstPrinciplesPacketV1,
  Plan,
  ConversationDomainContext,
  PlannerLearningHintSummaryV1,
  TaskRequest,
  WorkflowPattern
} from "../core/types";
import type { PlannerSkillGuidanceEntry } from "./skillRegistry/contracts";
import type { SemanticMemoryStore } from "../core/semanticMemory";
import {
  buildDefaultRetrievalQuarantinePolicy
} from "../core/retrievalQuarantine";
import { JudgmentPattern } from "../core/judgmentPatterns";
import { extractCurrentUserRequest } from "./memoryBroker";
import { ModelClient } from "../models/types";
import {
  InMemoryPlannerFailureStore,
  PlannerFailureStore
} from "../core/plannerFailureStore";
import { Stage685PlaybookPlanningContext } from "../core/stage6_85PlaybookRuntime";
import { inferRequiredActionType } from "./plannerPolicy/explicitActionIntent";
import {
  normalizeFingerprintSegment,
  PLANNER_FAILURE_COOLDOWN_MS,
  PLANNER_FAILURE_MAX_STRIKES,
  PLANNER_FAILURE_WINDOW_MS
} from "./plannerPolicy/plannerFailurePolicy";
import { PlannerExecutionEnvironmentContext } from "./plannerPolicy/executionStyleContracts";
import {
  assertPlannerActionValidation,
  evaluatePlannerActionValidation,
  preparePlannerActions,
  shouldUseNonExplicitRunSkillFallback
} from "./plannerPolicy/explicitActionRepair";
import {
  requestPlannerOutput,
  requestPlannerRepairOutput
} from "./plannerPolicy/promptAssembly";
import {
  buildNonExplicitRunSkillFallbackAction,
  enforceRunSkillIntentPolicy,
  ensureRespondMessages,
  synthesizeRespondMessage
} from "./plannerPolicy/responseSynthesisFallback";
import {
  buildDeterministicExplicitRuntimeActionFallbackActions
} from "./plannerPolicy/explicitRuntimeActionFallback";
import { buildDeterministicWorkspaceRecoveryFallbackActions } from "./plannerPolicy/workspaceRecoveryFallback";
import {
  buildLearningHintSummary,
  buildLearningPromptGuidance
} from "./plannerPolicy/learningPromptGuidance";
import {
  buildDeterministicFirstPrinciplesPacket,
  buildFirstPrinciplesPromptGuidance,
  resolveFirstPrinciplesTriggerDecision
} from "./plannerPolicy/plannerFirstPrinciplesSupport";
import { type WorkflowSkillBridgeSummary } from "./skillRegistry/workflowSkillBridge";
import {
  distillPlannerLessons,
  resolveDefaultExecutionEnvironmentContext
} from "./plannerSupport";
import { maybeFinalizeDeterministicPlannerFallbackPlan } from "./plannerDeterministicFallbackSupport";
import { resolveEagerDeterministicPlannerFallbackPlan } from "./plannerEagerFallbackSupport";

export interface PlannerPlanOptions {
  playbookSelection?: Stage685PlaybookPlanningContext | null;
  workflowHints?: readonly WorkflowPattern[];
  judgmentHints?: readonly JudgmentPattern[];
  workflowBridge?: WorkflowSkillBridgeSummary | null;
  skillGuidance?: readonly PlannerSkillGuidanceEntry[];
  conversationDomainContext?: ConversationDomainContext | null;
}

export class PlannerOrgan {
  /**
   * Initializes `PlannerOrgan` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses `InMemoryPlannerFailureStore` (import `InMemoryPlannerFailureStore`) from `../core/plannerFailureStore`.
   * - Uses `PlannerFailureStore` (import `PlannerFailureStore`) from `../core/plannerFailureStore`.
   * - Uses `SemanticMemoryStore` (import `SemanticMemoryStore`) from `../core/semanticMemory`.
   * - Uses `ModelClient` (import `ModelClient`) from `../models/types`.
   *
   * @param modelClient - Value for model client.
   * @param memoryStore - Value for memory store.
   * @param failureStore - Value for failure store.
   * @param executionEnvironment - Value for execution environment.
   */
  constructor(
    private readonly modelClient: ModelClient,
    private readonly memoryStore: SemanticMemoryStore,
    private readonly failureStore: PlannerFailureStore = new InMemoryPlannerFailureStore(),
    private readonly executionEnvironment: PlannerExecutionEnvironmentContext =
      resolveDefaultExecutionEnvironmentContext()
  ) { }

  /**
   * Builds failure fingerprint for this module's runtime flow.
   *
   * **Why it exists:**
   * Keeps construction of failure fingerprint consistent across call sites.
   *
   * **What it talks to:**
   * - Uses `TaskRequest` (import `TaskRequest`) from `../core/types`.
   * - Uses `normalizeFingerprintSegment` (import `normalizeFingerprintSegment`) from
   *   `./plannerPolicy/plannerFailurePolicy`.
   *
   * @param task - Value for task.
   * @returns Resulting string value.
   */
  private buildFailureFingerprint(task: TaskRequest): string {
    return [
      normalizeFingerprintSegment(task.goal),
      normalizeFingerprintSegment(task.userInput)
    ].join("::");
  }

  /**
   * Cleans up failure fingerprint state according to deterministic retention rules.
   *
   * **Why it exists:**
   * Keeps failure fingerprint state lifecycle mutation logic centralized to reduce drift in state transitions.
   *
   * **What it talks to:**
   * - Uses `PLANNER_FAILURE_WINDOW_MS` (import `PLANNER_FAILURE_WINDOW_MS`) from
   *   `./plannerPolicy/plannerFailurePolicy`.
   *
   * @param nowMs - Duration value in milliseconds.
   * @returns Promise resolving to void.
   */
  private async cleanupFailureFingerprintState(nowMs: number): Promise<void> {
    await this.failureStore.cleanupOlderThan(nowMs - PLANNER_FAILURE_WINDOW_MS);
  }

  /**
   * Applies deterministic validity checks for failure cooldown open.
   *
   * **Why it exists:**
   * Fails fast when failure cooldown open is invalid so later control flow stays safe and predictable.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param fingerprint - Value for fingerprint.
   * @param nowMs - Duration value in milliseconds.
   * @returns Promise resolving to void.
   */
  private async assertFailureCooldownOpen(fingerprint: string, nowMs: number): Promise<void> {
    const entry = await this.failureStore.get(fingerprint);
    if (!entry || nowMs >= entry.blockedUntilMs) {
      return;
    }

    const cooldownRemainingMs = entry.blockedUntilMs - nowMs;
    throw new Error(
      `Planner failure cooldown active (${cooldownRemainingMs}ms remaining) for repeated failing request fingerprint.`
    );
  }

  /**
   * Persists failure fingerprint with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes failure fingerprint mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `PLANNER_FAILURE_COOLDOWN_MS` (import `PLANNER_FAILURE_COOLDOWN_MS`) from
   *   `./plannerPolicy/plannerFailurePolicy`.
   * - Uses `PLANNER_FAILURE_MAX_STRIKES` (import `PLANNER_FAILURE_MAX_STRIKES`) from
   *   `./plannerPolicy/plannerFailurePolicy`.
   * - Uses `PLANNER_FAILURE_WINDOW_MS` (import `PLANNER_FAILURE_WINDOW_MS`) from
   *   `./plannerPolicy/plannerFailurePolicy`.
   *
   * @param fingerprint - Value for fingerprint.
   * @param nowMs - Duration value in milliseconds.
   * @returns Promise resolving to void.
   */
  private async recordFailureFingerprint(fingerprint: string, nowMs: number): Promise<void> {
    const previous = await this.failureStore.get(fingerprint);
    const withinWindow =
      previous !== undefined && nowMs - previous.lastFailureAtMs <= PLANNER_FAILURE_WINDOW_MS;
    const strikes = withinWindow ? previous.strikes + 1 : 1;
    const blockedUntilMs =
      strikes >= PLANNER_FAILURE_MAX_STRIKES ? nowMs + PLANNER_FAILURE_COOLDOWN_MS : 0;

    await this.failureStore.upsert(fingerprint, {
      strikes,
      lastFailureAtMs: nowMs,
      blockedUntilMs
    });
  }

  /**
   * Stops or clears failure fingerprint to keep runtime state consistent.
   *
   * **Why it exists:**
   * Centralizes teardown/reset behavior for failure fingerprint so lifecycle handling stays predictable.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param fingerprint - Value for fingerprint.
   * @returns Promise resolving to void.
   */
  private async clearFailureFingerprint(fingerprint: string): Promise<void> {
    await this.failureStore.delete(fingerprint);
  }

  /**
   * Implements plan behavior used by `planner`.
   *
   * **Why it exists:**
   * Keeps `plan` behavior centralized so collaborating call sites stay consistent.
   *
   * **What it talks to:**
   * - Uses `estimateActionCostUsd` (import `estimateActionCostUsd`) from `../core/actionCostPolicy`.
   * - Uses `Plan` (import `Plan`) from `../core/types`.
   * - Uses `TaskRequest` (import `TaskRequest`) from `../core/types`.
   * - Uses `extractCurrentUserRequest` (import `extractCurrentUserRequest`) from `./memoryBroker`.
   * - Uses planner action preparation, validation, and response fallback helpers from
   *   `./plannerPolicy/explicitActionRepair` and `./plannerPolicy/responseSynthesisFallback`.
   * - Additional imported collaborators are also used in this function body.
   *
   * @param task - Value for task.
   * @param plannerModel - Value for planner model.
   * @param synthesizerModel - Value for synthesizer model.
   * @param options - Optional tuning knobs for this operation.
   * @returns Promise resolving to Plan.
   */
  async plan(
    task: TaskRequest,
    plannerModel: string,
    synthesizerModel: string = plannerModel,
    options: PlannerPlanOptions = {}
  ): Promise<Plan> {
    const failureFingerprint = this.buildFailureFingerprint(task);
    const nowMs = Date.now();
    await this.cleanupFailureFingerprintState(nowMs);
    await this.assertFailureCooldownOpen(failureFingerprint, nowMs);

    const relevantLessons = await this.memoryStore.getRelevantLessons(
      task.userInput,
      8,
      undefined,
      options.conversationDomainContext?.dominantLane ?? null
    );
    const retrievalPolicy = buildDefaultRetrievalQuarantinePolicy(new Date().toISOString());
    const distilledLessons = distillPlannerLessons(relevantLessons, retrievalPolicy);
    const lessonsText = distilledLessons.length > 0
      ? `\n\nRelevant Distilled Lessons:\n${distilledLessons
          .map(({ packet, concepts }) => {
            const riskSummary =
              packet.riskSignals.length > 0 ? packet.riskSignals.join(",") : "none";
            return (
              `- ${packet.summary} ` +
              `[sourceId=${packet.sourceId}; concepts=${concepts.join(", ")}; riskSignals=${riskSummary}]`
            );
          })
          .join("\n")}`
      : "";
    const currentUserRequest = extractCurrentUserRequest(task.userInput);
    const firstPrinciplesTriggerDecision = resolveFirstPrinciplesTriggerDecision(
      currentUserRequest,
      relevantLessons.length
    );
    const firstPrinciplesPacket: FirstPrinciplesPacketV1 = firstPrinciplesTriggerDecision.required
      ? buildDeterministicFirstPrinciplesPacket(
        task,
        currentUserRequest,
        firstPrinciplesTriggerDecision.reasons
      )
      : {
        required: false,
        triggerReasons: [],
        rubric: null,
          validation: null
      };
    const firstPrinciplesGuidance = buildFirstPrinciplesPromptGuidance(firstPrinciplesPacket);
    const workflowHints = (options.workflowHints ?? []).slice(0, 3);
    const judgmentHints = (options.judgmentHints ?? []).slice(0, 3);
    const workflowBridge = options.workflowBridge ?? null;
    const skillGuidance = (options.skillGuidance ?? []).slice(0, 3);
    const learningGuidance = buildLearningPromptGuidance(
      workflowHints,
      judgmentHints,
      workflowBridge,
      skillGuidance
    );
    const learningHints: PlannerLearningHintSummaryV1 | undefined = buildLearningHintSummary(
      workflowHints,
      judgmentHints,
      workflowBridge,
      skillGuidance
    );
    const requiredActionType = inferRequiredActionType(currentUserRequest, task.userInput);
    const playbookSelection = options.playbookSelection ?? null;
    const eagerDeterministicPlan = await resolveEagerDeterministicPlannerFallbackPlan({
      task,
      currentUserRequest,
      requiredActionType,
      executionEnvironment: this.executionEnvironment,
      firstPrinciples: firstPrinciplesPacket,
      learningHints,
      failureFingerprint,
      clearFailureFingerprint: this.clearFailureFingerprint.bind(this)
    });
    if (eagerDeterministicPlan) {
      return eagerDeterministicPlan;
    }

    try {
      // Planner failures are fatal by policy: no deterministic fallback plan generation.
      const output = await requestPlannerOutput(this.modelClient, {
        task,
        plannerModel,
        lessonsText,
        firstPrinciplesGuidance,
        learningGuidance,
        currentUserRequest,
        requiredActionType,
        playbookSelection,
        executionEnvironment: this.executionEnvironment
      });
      const initialPreparation = preparePlannerActions(
        output,
        currentUserRequest,
        requiredActionType,
        task.userInput,
        this.executionEnvironment
      );
      const initialValidation = evaluatePlannerActionValidation(
        currentUserRequest,
        requiredActionType,
        initialPreparation.actions,
        task.userInput,
        this.executionEnvironment
      );
      if (initialValidation.needsRepair) {
        const repairedOutput = await requestPlannerRepairOutput(this.modelClient, {
          task,
          plannerModel,
          lessonsText,
          firstPrinciplesGuidance,
          learningGuidance,
          currentUserRequest,
          requiredActionType,
          playbookSelection,
          executionEnvironment: this.executionEnvironment,
          previousOutput: output,
          repairReason: initialValidation.repairReason ?? "no_valid_actions"
        });
        const repairedPreparation = preparePlannerActions(
          repairedOutput,
          currentUserRequest,
          requiredActionType,
          task.userInput,
          this.executionEnvironment
        );
        const repairedValidation = evaluatePlannerActionValidation(
          currentUserRequest,
          requiredActionType,
          repairedPreparation.actions,
          task.userInput,
          this.executionEnvironment
        );
        const deterministicWorkspaceRecoveryFallbackActions =
          repairedPreparation.actions.length === 0 || repairedValidation.needsRepair
            ? buildDeterministicWorkspaceRecoveryFallbackActions(
                currentUserRequest,
                task.userInput
              )
            : [];
        const workspaceRecoveryPlan = await maybeFinalizeDeterministicPlannerFallbackPlan({
          taskId: task.id,
          plannerNotes:
            `${repairedOutput.plannerNotes || output.plannerNotes || "Model planner output"} ` +
            `(backend=${this.modelClient.backend}, model=${plannerModel}, repair=true, ` +
            `deterministic_workspace_recovery_fallback=${deterministicWorkspaceRecoveryFallbackActions[0]?.type ?? "unknown"})`,
          actions: deterministicWorkspaceRecoveryFallbackActions,
          currentUserRequest,
          requiredActionType,
          userInput: task.userInput,
          executionEnvironment: this.executionEnvironment,
          firstPrinciples: firstPrinciplesPacket,
          learningHints,
          failureFingerprint,
          clearFailureFingerprint: this.clearFailureFingerprint.bind(this)
        });
        if (workspaceRecoveryPlan) {
          return workspaceRecoveryPlan;
        }
        const deterministicExplicitRuntimeFallbackActions =
          repairedPreparation.actions.length === 0 || repairedValidation.needsRepair
            ? buildDeterministicExplicitRuntimeActionFallbackActions(
                currentUserRequest,
                requiredActionType,
                task.userInput
              )
            : [];
        const explicitRuntimePlan = await maybeFinalizeDeterministicPlannerFallbackPlan({
          taskId: task.id,
          plannerNotes:
            `${repairedOutput.plannerNotes || output.plannerNotes || "Model planner output"} ` +
            `(backend=${this.modelClient.backend}, model=${plannerModel}, repair=true, ` +
            `deterministic_explicit_runtime_fallback=${deterministicExplicitRuntimeFallbackActions[0]?.type ?? "unknown"})`,
          actions: deterministicExplicitRuntimeFallbackActions,
          currentUserRequest,
          requiredActionType,
          userInput: task.userInput,
          executionEnvironment: this.executionEnvironment,
          firstPrinciples: firstPrinciplesPacket,
          learningHints,
          failureFingerprint,
          clearFailureFingerprint: this.clearFailureFingerprint.bind(this)
        });
        if (explicitRuntimePlan) {
          return explicitRuntimePlan;
        }
        if (repairedPreparation.actions.length === 0) {
          if (
            shouldUseNonExplicitRunSkillFallback(
              currentUserRequest,
              requiredActionType,
              initialPreparation,
              repairedPreparation
            )
          ) {
            const synthesizedMessage = await synthesizeRespondMessage(
              this.modelClient,
              task,
              synthesizerModel
            );
            await this.clearFailureFingerprint(failureFingerprint);
            return {
              taskId: task.id,
              plannerNotes:
                `${repairedOutput.plannerNotes || output.plannerNotes || "Model planner output"} ` +
                `(backend=${this.modelClient.backend}, model=${plannerModel}, repair=true, ` +
                "non_explicit_run_skill_fallback=respond)",
              firstPrinciples: firstPrinciplesPacket,
              learningHints,
              actions: [buildNonExplicitRunSkillFallbackAction(synthesizedMessage)]
            };
          }
          throw new Error("Planner model returned no valid actions.");
        }
        assertPlannerActionValidation(repairedValidation, requiredActionType);
        const actionsWithMessages = await ensureRespondMessages(
          this.modelClient,
          repairedPreparation.actions,
          task,
          synthesizerModel
        );
        const postPolicy = await enforceRunSkillIntentPolicy(
          this.modelClient,
          actionsWithMessages,
          task,
          synthesizerModel,
          currentUserRequest
        );
        await this.clearFailureFingerprint(failureFingerprint);
        return {
          taskId: task.id,
          plannerNotes:
            `${repairedOutput.plannerNotes || output.plannerNotes || "Model planner output"} ` +
            `(backend=${this.modelClient.backend}, model=${plannerModel}, repair=true)` +
            (postPolicy.usedFallback
              ? " (non_explicit_run_skill_post_filter_fallback=respond)"
            : ""),
          firstPrinciples: firstPrinciplesPacket,
          learningHints,
          actions: postPolicy.actions
        };
      }

      assertPlannerActionValidation(initialValidation, requiredActionType);
      const actionsWithMessages = await ensureRespondMessages(
        this.modelClient,
        initialPreparation.actions,
        task,
        synthesizerModel
      );
      const postPolicy = await enforceRunSkillIntentPolicy(
        this.modelClient,
        actionsWithMessages,
        task,
        synthesizerModel,
        currentUserRequest
      );
      await this.clearFailureFingerprint(failureFingerprint);
      return {
        taskId: task.id,
        plannerNotes:
          `${output.plannerNotes || "Model planner output"} ` +
          `(backend=${this.modelClient.backend}, model=${plannerModel})` +
          (postPolicy.usedFallback
            ? " (non_explicit_run_skill_post_filter_fallback=respond)"
            : ""),
        firstPrinciples: firstPrinciplesPacket,
        learningHints,
        actions: postPolicy.actions
      };
    } catch (error) {
      const deterministicExplicitRuntimeFallbackActions =
        buildDeterministicExplicitRuntimeActionFallbackActions(
          currentUserRequest,
          requiredActionType,
          task.userInput
        );
      const explicitCatchPlan = await maybeFinalizeDeterministicPlannerFallbackPlan({
        taskId: task.id,
        plannerNotes:
          `${error instanceof Error ? error.message : "Planner explicit runtime fallback triggered"} ` +
          `(backend=${this.modelClient.backend}, model=${plannerModel}, ` +
          `deterministic_explicit_runtime_fallback=${deterministicExplicitRuntimeFallbackActions[0]?.type ?? "unknown"})`,
        actions: deterministicExplicitRuntimeFallbackActions,
        currentUserRequest,
        requiredActionType,
        userInput: task.userInput,
        executionEnvironment: this.executionEnvironment,
        firstPrinciples: firstPrinciplesPacket,
        learningHints,
        failureFingerprint,
        clearFailureFingerprint: this.clearFailureFingerprint.bind(this)
      });
      if (explicitCatchPlan) {
        return explicitCatchPlan;
      }
      await this.recordFailureFingerprint(failureFingerprint, Date.now());
      throw error;
    }
  }
}
