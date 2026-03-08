/**
 * @fileoverview Produces task action plans strictly from model outputs and fails closed on planner/synthesis errors.
 */

import {
  DistilledPacketV1,
  FirstPrinciplesPacketV1,
  Plan,
  PlannerLearningHintSummaryV1,
  TaskRequest,
  WorkflowPattern
} from "../core/types";
import { SemanticLesson, SemanticMemoryStore } from "../core/semanticMemory";
import {
  createFirstPrinciplesRubric,
  validateFirstPrinciplesRubric
} from "../core/advancedAutonomyFoundation";
import {
  buildDefaultRetrievalQuarantinePolicy,
  distillExternalContent,
  requireDistilledPacketForPlanner
} from "../core/retrievalQuarantine";
import { JudgmentPattern } from "../core/judgmentPatterns";
import { extractCurrentUserRequest } from "./memoryBroker";
import { ModelClient } from "../models/types";
import {
  InMemoryPlannerFailureStore,
  PlannerFailureStore
} from "../core/plannerFailureStore";
import { Stage685PlaybookPlanningContext } from "../core/stage6_85PlaybookRuntime";
import {
  inferRequiredActionType,
} from "./plannerPolicy/explicitActionIntent";
import {
  normalizeFingerprintSegment,
  PLANNER_FAILURE_COOLDOWN_MS,
  PLANNER_FAILURE_MAX_STRIKES,
  PLANNER_FAILURE_WINDOW_MS
} from "./plannerPolicy/plannerFailurePolicy";
import {
  PlannerExecutionEnvironmentContext,
} from "./plannerPolicy/executionStyleContracts";
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

const FIRST_PRINCIPLES_RISK_PATTERNS: readonly RegExp[] = [
  /\b(delete|remove|rm)\b/i,
  /\b(network|api|webhook|endpoint|http[s]?:\/\/)\b/i,
  /\b(secret|token|credential|password|private key)\b/i,
  /\b(deploy|production|rollback|database migration)\b/i,
  /\b(self[-\s]?modify|modify (?:agent|runtime|policy|governor|constraint))\b/i,
  /\b(memory_mutation|pulse_emit)\b/i,
  /\b(shell|terminal|powershell|bash|zsh|cmd(?:\.exe)?)\b/i
];
const FIRST_PRINCIPLES_NOVEL_REQUEST_MIN_WORDS = 16;

interface FirstPrinciplesTriggerDecision {
  required: boolean;
  reasons: readonly string[];
}

export interface PlannerPlanOptions {
  playbookSelection?: Stage685PlaybookPlanningContext | null;
  workflowHints?: readonly WorkflowPattern[];
  judgmentHints?: readonly JudgmentPattern[];
}

interface DistilledRelevantLesson {
  packet: DistilledPacketV1;
  concepts: readonly string[];
}

/**
 * Resolves default execution environment context from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of default execution environment context by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @returns Computed `PlannerExecutionEnvironmentContext` result.
 */
function resolveDefaultExecutionEnvironmentContext(): PlannerExecutionEnvironmentContext {
  const platform = process.platform === "win32" || process.platform === "darwin" || process.platform === "linux"
    ? process.platform
    : "linux";
  const shellKind = platform === "win32" ? "powershell" : "bash";
  return {
    platform,
    shellKind,
    invocationMode: "inline_command",
    commandMaxChars: 4_000
  };
}

/**
 * Distills planner lessons while suppressing quarantined memory entries.
 *
 * **Why it exists:**
 * Planner memory should improve planning quality, but one quarantined lesson must not abort a live
 * user task when the lesson can simply be excluded from prompt context.
 *
 * **What it talks to:**
 * - Uses `SemanticLesson` (import `SemanticLesson`) from `../core/semanticMemory`.
 * - Uses `buildDefaultRetrievalQuarantinePolicy` from `../core/retrievalQuarantine`.
 * - Uses `distillExternalContent` from `../core/retrievalQuarantine`.
 * - Uses `requireDistilledPacketForPlanner` from `../core/retrievalQuarantine`.
 *
 * @param relevantLessons - Retrieved lesson candidates from semantic memory.
 * @param retrievalPolicy - Deterministic retrieval quarantine policy for this planning pass.
 * @returns Planner-safe distilled lessons ready for prompt inclusion.
 */
function distillPlannerLessons(
  relevantLessons: readonly SemanticLesson[],
  retrievalPolicy: ReturnType<typeof buildDefaultRetrievalQuarantinePolicy>
): DistilledRelevantLesson[] {
  const distilledLessons: DistilledRelevantLesson[] = [];
  for (const lesson of relevantLessons) {
    const distillation = distillExternalContent(
      {
        sourceKind: "document",
        sourceId: lesson.id,
        contentType: "text/plain",
        rawContent: lesson.text,
        observedAt: lesson.createdAt
      },
      retrievalPolicy
    );
    if (!distillation.ok) {
      console.warn(
        `[Planner] Suppressing quarantined lesson ${lesson.id}: ` +
        `${distillation.blockCode} (${distillation.reason})`
      );
      continue;
    }
    const packetValidation = requireDistilledPacketForPlanner(distillation.packet);
    if (packetValidation) {
      throw new Error(
        `Retrieval quarantine packet validation failed for lesson ${lesson.id}: ` +
        `${packetValidation.blockCode} (${packetValidation.reason})`
      );
    }
    distilledLessons.push({
      packet: distillation.packet,
      concepts: lesson.concepts
    });
  }
  return distilledLessons;
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
   * Resolves whether first-principles rubric planning is mandatory for this request.
   *
   * **Why it exists:**
   * Stage 6.10 requires deterministic trigger logic for high-risk and novel requests so first-
   * principles policy is applied consistently before planner action generation.
   *
   * **What it talks to:**
   * - Uses local high-risk regex guards and novelty thresholds in this module.
   *
   * @param currentUserRequest - Active request segment extracted from conversation/task input.
   * @param relevantLessonCount - Number of retrieved lessons available for this request.
   * @returns Trigger decision with explicit deterministic reasons.
   */
  private resolveFirstPrinciplesTriggerDecision(
    currentUserRequest: string,
    relevantLessonCount: number
  ): FirstPrinciplesTriggerDecision {
    const reasons: string[] = [];
    for (const pattern of FIRST_PRINCIPLES_RISK_PATTERNS) {
      if (pattern.test(currentUserRequest)) {
        reasons.push(`risk_pattern:${pattern.source}`);
      }
    }

    const wordCount = currentUserRequest
      .trim()
      .split(/\s+/)
      .filter((entry) => entry.trim().length > 0).length;
    if (
      reasons.length === 0 &&
      relevantLessonCount === 0 &&
      wordCount >= FIRST_PRINCIPLES_NOVEL_REQUEST_MIN_WORDS
    ) {
      reasons.push("novel_request:no_relevant_lessons");
    }

    return {
      required: reasons.length > 0,
      reasons: reasons.sort((left, right) => left.localeCompare(right))
    };
  }

  /**
   * Builds a deterministic first-principles rubric for high-risk/novel planning requests.
   *
   * **Why it exists:**
   * The planner must explicitly ground facts, assumptions, constraints, and unknowns before
   * proposing actions when Stage 6.10 trigger conditions are met.
   *
   * **What it talks to:**
   * - Uses Stage 6.5 rubric helpers (`createFirstPrinciplesRubric`, `validateFirstPrinciplesRubric`).
   *
   * @param task - Current task metadata.
   * @param currentUserRequest - Active request segment extracted from conversation/task input.
   * @param triggerReasons - Trigger reasons that required first-principles policy.
   * @returns Validated rubric packet used to guide planner prompts and persisted plan metadata.
   */
  private buildDeterministicFirstPrinciplesPacket(
    task: TaskRequest,
    currentUserRequest: string,
    triggerReasons: readonly string[]
  ): FirstPrinciplesPacketV1 {
    const rubric = createFirstPrinciplesRubric({
      facts: [
        `task.goal=${task.goal}`,
        `task.currentUserRequest=${currentUserRequest}`,
        "runtime.mode=governed_execution"
      ],
      assumptions: [
        "external_system_state_may_be_stale",
        "planner_output_is_untrusted_until_constraints_and_governors_pass",
        "execution_receipts_and_traces_must_remain_auditable"
      ],
      constraints: [
        "all_actions_must_pass_hard_constraints",
        "all_side_effects_require_governor_approval",
        "budget_and_deadline_limits_are_fail_closed"
      ],
      unknowns: [
        "external_dependency_availability",
        "current_filesystem_or_service_state_before_read",
        "human_intent_details_not_explicitly_stated"
      ],
      minimalPlan:
        "Derive the minimum safe action set for the active request, keep scope bounded, " +
        "and prioritize verifiable outputs with deterministic fallbacks."
    });
    const validation = validateFirstPrinciplesRubric(rubric);
    if (!validation.valid) {
      throw new Error(
        "First-principles rubric validation failed: " + validation.violationCodes.join(", ")
      );
    }

    return {
      required: true,
      triggerReasons,
      rubric,
      validation
    };
  }

  /**
   * Builds first-principles prompt guidance from rubric packet metadata.
   *
   * **Why it exists:**
   * Planner prompts should include explicit rubric context so model planning reflects required
   * facts/assumptions/constraints/unknowns for high-risk and novel tasks.
   *
   * **What it talks to:**
   * - Uses `FirstPrinciplesPacketV1` planning metadata.
   *
   * @param packet - First-principles packet prepared for the current request.
   * @returns Prompt-ready rubric guidance text, or empty string when policy is not required.
   */
  private buildFirstPrinciplesPromptGuidance(packet: FirstPrinciplesPacketV1): string {
    if (!packet.required || !packet.rubric) {
      return "";
    }
    return (
      "\nFirst-Principles Rubric (required):\n" +
      `- triggerReasons: ${packet.triggerReasons.join(", ")}\n` +
      `- facts: ${packet.rubric.facts.join(" | ")}\n` +
      `- assumptions: ${packet.rubric.assumptions.join(" | ")}\n` +
      `- constraints: ${packet.rubric.constraints.join(" | ")}\n` +
      `- unknowns: ${packet.rubric.unknowns.join(" | ")}\n` +
      `- minimalPlan: ${packet.rubric.minimalPlan}\n` +
      "Use this rubric as the mandatory planning baseline before emitting actions."
    );
  }

  /**
   * Builds deterministic workflow-learning guidance for planner prompts.
   *
   * **Why it exists:**
   * Stage 6.13 runtime wiring needs compact reusable workflow hints injected into planning prompts.
   *
   * **What it talks to:**
   * - Uses `WorkflowPattern` hint entries supplied by orchestrator pre-plan retrieval.
   *
   * @param patterns - Workflow hints chosen for this planning attempt.
   * @returns Prompt guidance block, or empty string when no workflow hints are available.
   */
  private buildWorkflowLearningGuidance(patterns: readonly WorkflowPattern[]): string {
    if (patterns.length === 0) {
      return "";
    }
    const lines = patterns.slice(0, 3).map((pattern) => {
      return (
        `- workflowKey=${pattern.workflowKey}; confidence=${pattern.confidence.toFixed(2)}; ` +
        `status=${pattern.status}; success=${pattern.successCount}; failure=${pattern.failureCount}; ` +
        `suppressed=${pattern.suppressedCount}`
      );
    });
    return (
      "\nWorkflow Learning Hints:\n" +
      lines.join("\n") +
      "\nPrefer high-confidence active workflow patterns and avoid known suppressed/failure motifs."
    );
  }

  /**
   * Builds deterministic judgment-learning guidance for planner prompts.
   *
   * **Why it exists:**
   * Stage 6.17 runtime wiring needs calibrated judgment hints to reduce repeated low-quality choices.
   *
   * **What it talks to:**
   * - Uses `JudgmentPattern` hint entries supplied by orchestrator pre-plan retrieval.
   *
   * @param patterns - Judgment hints chosen for this planning attempt.
   * @returns Prompt guidance block, or empty string when no judgment hints are available.
   */
  private buildJudgmentLearningGuidance(patterns: readonly JudgmentPattern[]): string {
    if (patterns.length === 0) {
      return "";
    }
    const lines = patterns.slice(0, 3).map((pattern) => {
      const latestSignal =
        pattern.outcomeHistory.length > 0
          ? pattern.outcomeHistory[pattern.outcomeHistory.length - 1]
          : undefined;
      return (
        `- riskPosture=${pattern.riskPosture}; confidence=${pattern.confidence.toFixed(2)}; ` +
        `signals=${pattern.outcomeHistory.length}; latestSignal=${latestSignal?.signalType ?? "none"}; ` +
        `latestScore=${latestSignal ? latestSignal.score.toFixed(2) : "n/a"}`
      );
    });
    return (
      "\nJudgment Learning Hints:\n" +
      lines.join("\n") +
      "\nWhen uncertain, prefer lower-risk options and avoid repeating low-confidence decisions."
    );
  }

  /**
   * Builds combined planner guidance block from workflow and judgment learning hints.
   *
   * **Why it exists:**
   * Keeps Stage 6.13/6.17 prompt injection deterministic and centralized.
   *
   * **What it talks to:**
   * - Uses workflow/judgment hint builders in this module.
   *
   * @param workflowHints - Workflow patterns relevant to the current request.
   * @param judgmentHints - Judgment patterns relevant to the current request.
   * @returns Combined prompt guidance text, or empty string when no learning hints exist.
   */
  private buildLearningPromptGuidance(
    workflowHints: readonly WorkflowPattern[],
    judgmentHints: readonly JudgmentPattern[]
  ): string {
    const workflowGuidance = this.buildWorkflowLearningGuidance(workflowHints);
    const judgmentGuidance = this.buildJudgmentLearningGuidance(judgmentHints);
    return `${workflowGuidance}${judgmentGuidance}`;
  }

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

    const relevantLessons = await this.memoryStore.getRelevantLessons(task.userInput, 8);
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
    const firstPrinciplesTriggerDecision = this.resolveFirstPrinciplesTriggerDecision(
      currentUserRequest,
      relevantLessons.length
    );
    const firstPrinciplesPacket: FirstPrinciplesPacketV1 = firstPrinciplesTriggerDecision.required
      ? this.buildDeterministicFirstPrinciplesPacket(
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
    const firstPrinciplesGuidance = this.buildFirstPrinciplesPromptGuidance(firstPrinciplesPacket);
    const workflowHints = (options.workflowHints ?? []).slice(0, 3);
    const judgmentHints = (options.judgmentHints ?? []).slice(0, 3);
    const learningGuidance = this.buildLearningPromptGuidance(workflowHints, judgmentHints);
    const learningHints: PlannerLearningHintSummaryV1 | undefined =
      workflowHints.length > 0 || judgmentHints.length > 0
        ? {
          workflowHintCount: workflowHints.length,
          judgmentHintCount: judgmentHints.length
        }
        : undefined;
    const requiredActionType = inferRequiredActionType(currentUserRequest);
    const playbookSelection = options.playbookSelection ?? null;

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
        requiredActionType
      );
      const initialValidation = evaluatePlannerActionValidation(
        currentUserRequest,
        requiredActionType,
        initialPreparation.actions
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
          requiredActionType
        );
        if (repairedPreparation.actions.length === 0) {
          if (
            shouldUseNonExplicitRunSkillFallback(
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
        const repairedValidation = evaluatePlannerActionValidation(
          currentUserRequest,
          requiredActionType,
          repairedPreparation.actions
        );
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
      await this.recordFailureFingerprint(failureFingerprint, Date.now());
      throw error;
    }
  }
}
