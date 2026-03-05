/**
 * @fileoverview Produces task action plans strictly from model outputs and fails closed on planner/synthesis errors.
 */

import {
  FirstPrinciplesPacketV1,
  FirstPrinciplesRubric,
  Plan,
  PlannerLearningHintSummaryV1,
  PlannedAction,
  ShellRuntimeProfileV1,
  TaskRequest,
  WorkflowPattern
} from "../core/types";
import { SemanticMemoryStore } from "../core/semanticMemory";
import { estimateActionCostUsd } from "../core/actionCostPolicy";
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
import {
  ModelClient,
  PlannerModelOutput,
  ResponseSynthesisModelOutput
} from "../models/types";
import {
  InMemoryPlannerFailureStore,
  PlannerFailureStore
} from "../core/plannerFailureStore";
import { Stage685PlaybookPlanningContext } from "../core/stage6_85PlaybookRuntime";
import {
  allowsRunSkillForRequest,
  extractActionCandidates,
  filterNonExplicitRunSkillActions,
  hasOnlyRunSkillActions,
  hasRequiredAction,
  hasRespondMessage,
  inferRequiredActionType,
  normalizeFingerprintSegment,
  normalizeModelActions,
  normalizeRequiredCreateSkillParams,
  PLANNER_FAILURE_COOLDOWN_MS,
  PLANNER_FAILURE_MAX_STRIKES,
  PLANNER_FAILURE_WINDOW_MS,
  RequiredActionType
} from "./plannerHelpers";

const SHELL_EXPLICIT_REQUEST_PATTERN =
  /\b(shell|terminal|powershell|bash|cmd(?:\.exe)?|command line|run (?:a )?command|execute (?:a )?command)\b/i;
const SELF_MODIFY_EXPLICIT_REQUEST_PATTERN =
  /\b(self[-\s]?modify|modify (?:yourself|your own|the agent|the brain|runtime|source|codebase|governor|policy)|edit (?:agent|runtime|source|code|config)|patch (?:agent|runtime|codebase)|change (?:governor|policy|hard constraint|runtime|codebase))\b/i;
const FIRST_PRINCIPLES_RISK_PATTERNS: readonly RegExp[] = [
  /\b(delete|remove|rm)\b/i,
  /\b(network|api|webhook|endpoint|http[s]?:\/\/)\b/i,
  /\b(secret|token|credential|password|private key)\b/i,
  /\b(deploy|production|rollback|database migration)\b/i,
  /\b(self[-\s]?modify|modify (?:agent|runtime|policy|governor|constraint))\b/i,
  /\b(memory_mutation|pulse_emit)\b/i,
  /\b(shell|terminal|powershell|bash|cmd(?:\.exe)?)\b/i
];
const FIRST_PRINCIPLES_NOVEL_REQUEST_MIN_WORDS = 16;
const RESPONSE_IDENTITY_GUARDRAIL =
  "Keep explicit AI-agent identity in all user-facing text. " +
  "Do not claim to be human, do not claim to be the user, and do not write in first person as if you are the user. ";

interface FirstPrinciplesTriggerDecision {
  required: boolean;
  reasons: readonly string[];
}

export interface PlannerPlanOptions {
  playbookSelection?: Stage685PlaybookPlanningContext | null;
  workflowHints?: readonly WorkflowPattern[];
  judgmentHints?: readonly JudgmentPattern[];
}

export interface PlannerExecutionEnvironmentContext {
  platform: ShellRuntimeProfileV1["platform"];
  shellKind: ShellRuntimeProfileV1["shellKind"];
  invocationMode: ShellRuntimeProfileV1["invocationMode"];
  commandMaxChars: number;
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
   * Builds execution environment guidance for this module's runtime flow.
   *
   * **Why it exists:**
   * Keeps construction of execution environment guidance consistent across call sites.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   * @returns Resulting string value.
   */
  private buildExecutionEnvironmentGuidance(): string {
    return (
      "\nExecution Environment:\n" +
      `- platform: ${this.executionEnvironment.platform}\n` +
      `- shellKind: ${this.executionEnvironment.shellKind}\n` +
      `- invocationMode: ${this.executionEnvironment.invocationMode}\n` +
      `- commandMaxChars: ${this.executionEnvironment.commandMaxChars}\n` +
      "- If you emit shell_command, it must be valid for this shellKind."
    );
  }

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
   * - Uses `normalizeFingerprintSegment` (import `normalizeFingerprintSegment`) from `./plannerHelpers`.
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
   * Builds high risk action guardrails for this module's runtime flow.
   *
   * **Why it exists:**
   * Keeps construction of high risk action guardrails consistent across call sites.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param currentUserRequest - Structured input object for this operation.
   * @returns Resulting string value.
   */
  private buildHighRiskActionGuardrails(currentUserRequest: string): string {
    const disallowedActionTypes: string[] = [];
    if (!SHELL_EXPLICIT_REQUEST_PATTERN.test(currentUserRequest)) {
      disallowedActionTypes.push("shell_command");
    }
    if (!SELF_MODIFY_EXPLICIT_REQUEST_PATTERN.test(currentUserRequest)) {
      disallowedActionTypes.push("self_modify");
    }
    if (disallowedActionTypes.length === 0) {
      return "";
    }

    return (
      "\nDeterministic high-risk action guardrail: " +
      `for this request, do not emit ${disallowedActionTypes.join(" or ")} actions unless the user explicitly requests them. ` +
      "Prefer request-relevant action types such as respond, run_skill, or scoped file actions."
    );
  }

  /**
   * Cleans up failure fingerprint state according to deterministic retention rules.
   *
   * **Why it exists:**
   * Keeps failure fingerprint state lifecycle mutation logic centralized to reduce drift in state transitions.
   *
   * **What it talks to:**
   * - Uses `PLANNER_FAILURE_WINDOW_MS` (import `PLANNER_FAILURE_WINDOW_MS`) from `./plannerHelpers`.
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
   * - Uses `PLANNER_FAILURE_COOLDOWN_MS` (import `PLANNER_FAILURE_COOLDOWN_MS`) from `./plannerHelpers`.
   * - Uses `PLANNER_FAILURE_MAX_STRIKES` (import `PLANNER_FAILURE_MAX_STRIKES`) from `./plannerHelpers`.
   * - Uses `PLANNER_FAILURE_WINDOW_MS` (import `PLANNER_FAILURE_WINDOW_MS`) from `./plannerHelpers`.
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
   * Implements request planner output behavior used by `planner`.
   *
   * **Why it exists:**
   * Keeps `request planner output` behavior centralized so collaborating call sites stay consistent.
   *
   * **What it talks to:**
   * - Uses `Stage685PlaybookPlanningContext` (import `Stage685PlaybookPlanningContext`) from `../core/stage6_85PlaybookRuntime`.
   * - Uses `TaskRequest` (import `TaskRequest`) from `../core/types`.
   * - Uses `PlannerModelOutput` (import `PlannerModelOutput`) from `../models/types`.
   * - Uses `RequiredActionType` (import `RequiredActionType`) from `./plannerHelpers`.
   *
   * @param task - Value for task.
   * @param plannerModel - Value for planner model.
   * @param lessonsText - Message/text content processed by this function.
   * @param firstPrinciplesGuidance - Message/text content processed by this function.
   * @param currentUserRequest - Structured input object for this operation.
   * @param requiredActionType - Value for required action type.
   * @param playbookSelection - Value for playbook selection.
   * @returns Promise resolving to PlannerModelOutput.
   */
  private async requestPlannerOutput(
    task: TaskRequest,
    plannerModel: string,
    lessonsText: string,
    firstPrinciplesGuidance: string,
    learningGuidance: string,
    currentUserRequest: string,
    requiredActionType: RequiredActionType,
    playbookSelection: Stage685PlaybookPlanningContext | null
  ): Promise<PlannerModelOutput> {
    const playbookGuidance = this.buildPlaybookGuidance(playbookSelection);
    const highRiskActionGuardrails = this.buildHighRiskActionGuardrails(currentUserRequest);
    const executionEnvironmentGuidance = this.buildExecutionEnvironmentGuidance();
    const requiredActionHint =
      requiredActionType === "create_skill"
        ? "Current user request explicitly asks to create a skill. Include at least one create_skill action and do not replace it with respond-only output."
        : "";
    return this.modelClient.completeJson<PlannerModelOutput>({
      model: plannerModel,
      schemaName: "planner_v1",
      temperature: 0,
      systemPrompt:
        "You are a planning organ for an autonomous system. Return compact JSON with plannerNotes and actions[]. " +
        "Always produce at least one valid action. For conversational requests, emit a `respond` action. " +
        "If you emit a respond action, include params.message with the exact user-facing text. " +
        RESPONSE_IDENTITY_GUARDRAIL +
        "If you emit a write_file action, include params.path and params.content with the full file content to write. " +
        "If you emit a read_file action, include params.path. " +
        "If you emit a shell_command action, include params.command with the exact command string. " +
        requiredActionHint +
        executionEnvironmentGuidance +
        playbookGuidance +
        highRiskActionGuardrails +
        firstPrinciplesGuidance +
        learningGuidance +
        lessonsText,
      userPrompt: JSON.stringify({
        taskId: task.id,
        goal: task.goal,
        userInput: task.userInput,
        currentUserRequest,
        requiredActionType,
        playbookSelection
      })
    });
  }

  /**
   * Implements request planner repair output behavior used by `planner`.
   *
   * **Why it exists:**
   * Keeps `request planner repair output` behavior centralized so collaborating call sites stay consistent.
   *
   * **What it talks to:**
   * - Uses `Stage685PlaybookPlanningContext` (import `Stage685PlaybookPlanningContext`) from `../core/stage6_85PlaybookRuntime`.
   * - Uses `TaskRequest` (import `TaskRequest`) from `../core/types`.
   * - Uses `PlannerModelOutput` (import `PlannerModelOutput`) from `../models/types`.
   * - Uses `RequiredActionType` (import `RequiredActionType`) from `./plannerHelpers`.
   *
   * @param task - Value for task.
   * @param plannerModel - Value for planner model.
   * @param lessonsText - Message/text content processed by this function.
   * @param firstPrinciplesGuidance - Message/text content processed by this function.
   * @param previousOutput - Result object inspected or transformed in this step.
   * @param currentUserRequest - Structured input object for this operation.
   * @param requiredActionType - Value for required action type.
   * @param repairReason - Value for repair reason.
   * @param playbookSelection - Value for playbook selection.
   * @returns Promise resolving to PlannerModelOutput.
   */
  private async requestPlannerRepairOutput(
    task: TaskRequest,
    plannerModel: string,
    lessonsText: string,
    firstPrinciplesGuidance: string,
    learningGuidance: string,
    previousOutput: PlannerModelOutput,
    currentUserRequest: string,
    requiredActionType: RequiredActionType,
    repairReason: string,
    playbookSelection: Stage685PlaybookPlanningContext | null
  ): Promise<PlannerModelOutput> {
    const playbookGuidance = this.buildPlaybookGuidance(playbookSelection);
    const highRiskActionGuardrails = this.buildHighRiskActionGuardrails(currentUserRequest);
    const executionEnvironmentGuidance = this.buildExecutionEnvironmentGuidance();
    const requiredActionHint =
      requiredActionType === "create_skill"
        ? "Repair must include at least one create_skill action because the explicit user request is to create a skill."
        : "";
    return this.modelClient.completeJson<PlannerModelOutput>({
      model: plannerModel,
      schemaName: "planner_v1",
      temperature: 0,
      systemPrompt:
        "You are repairing a planner JSON output that had no valid actions. " +
        "Return compact JSON with plannerNotes and actions[]. " +
        "Actions must use only allowed types: respond, read_file, write_file, delete_file, list_directory, create_skill, run_skill, network_write, self_modify, shell_command. " +
        "Always produce at least one valid action. For conversational requests, emit respond with params.message. " +
        RESPONSE_IDENTITY_GUARDRAIL +
        "For write_file, include params.path and params.content (the full file content). " +
        "For read_file, include params.path. For shell_command, include params.command. " +
        requiredActionHint +
        executionEnvironmentGuidance +
        playbookGuidance +
        highRiskActionGuardrails +
        firstPrinciplesGuidance +
        learningGuidance +
        lessonsText,
      userPrompt: JSON.stringify({
        taskId: task.id,
        goal: task.goal,
        userInput: task.userInput,
        currentUserRequest,
        requiredActionType,
        repairReason,
        invalidPlannerOutput: previousOutput,
        playbookSelection
      })
    });
  }

  /**
   * Builds playbook guidance for this module's runtime flow.
   *
   * **Why it exists:**
   * Keeps construction of playbook guidance consistent across call sites.
   *
   * **What it talks to:**
   * - Uses `Stage685PlaybookPlanningContext` (import `Stage685PlaybookPlanningContext`) from `../core/stage6_85PlaybookRuntime`.
   *
   * @param playbookSelection - Value for playbook selection.
   * @returns Resulting string value.
   */
  private buildPlaybookGuidance(
    playbookSelection: Stage685PlaybookPlanningContext | null
  ): string {
    if (!playbookSelection) {
      return "";
    }

    if (!playbookSelection.fallbackToPlanner && playbookSelection.selectedPlaybookId) {
      const selectedPlaybookName = playbookSelection.selectedPlaybookName ?? "unnamed_playbook";
      const tags = playbookSelection.requestedTags.join(",");
      return (
        "\nDeterministic Stage 6.85 playbook match is available. " +
        `Selected playbook id: ${playbookSelection.selectedPlaybookId}. ` +
        `Selected playbook name: ${selectedPlaybookName}. ` +
        `Requested tags: ${tags}. ` +
        `Required input schema: ${playbookSelection.requiredInputSchema}. ` +
        "Use this playbook context as the default workflow scaffold and avoid clarification-only output " +
        "unless a safety-critical unknown blocks execution. " +
        "For build/research playbook matches, prefer respond actions with deterministic steps. " +
        "Do not emit run_skill unless the current user request explicitly asks to run or use a named skill."
      );
    }

    return (
      "\nDeterministic Stage 6.85 playbook fallback is active. " +
      `Fallback reason: ${playbookSelection.reason}. ` +
      "Use normal planning with explicit assumptions and avoid repeated clarification loops."
    );
  }

  /**
   * Implements synthesize respond message behavior used by `planner`.
   *
   * **Why it exists:**
   * Keeps `synthesize respond message` behavior centralized so collaborating call sites stay consistent.
   *
   * **What it talks to:**
   * - Uses `TaskRequest` (import `TaskRequest`) from `../core/types`.
   * - Uses `ResponseSynthesisModelOutput` (import `ResponseSynthesisModelOutput`) from `../models/types`.
   *
   * @param task - Value for task.
   * @param synthesizerModel - Value for synthesizer model.
   * @returns Promise resolving to string.
   */
  private async synthesizeRespondMessage(
    task: TaskRequest,
    synthesizerModel: string
  ): Promise<string> {
    const output = await this.modelClient.completeJson<ResponseSynthesisModelOutput>({
      model: synthesizerModel,
      schemaName: "response_v1",
      temperature: 0.2,
      systemPrompt:
        "You are a response synthesizer organ in a governed assistant. " +
        "Return JSON with one key: message. The message must directly answer the user input, be concise, and avoid mentioning internal systems. " +
        RESPONSE_IDENTITY_GUARDRAIL,
      userPrompt: JSON.stringify({
        taskId: task.id,
        goal: task.goal,
        userInput: task.userInput
      })
    });

    const message = typeof output.message === "string" ? output.message.trim() : "";
    if (message.length === 0) {
      throw new Error("Response synthesis returned an empty message.");
    }

    return message;
  }

  /**
   * Applies deterministic validity checks for respond messages.
   *
   * **Why it exists:**
   * Fails fast when respond messages is invalid so later control flow stays safe and predictable.
   *
   * **What it talks to:**
   * - Uses `PlannedAction` (import `PlannedAction`) from `../core/types`.
   * - Uses `TaskRequest` (import `TaskRequest`) from `../core/types`.
   * - Uses `hasRespondMessage` (import `hasRespondMessage`) from `./plannerHelpers`.
   *
   * @param actions - Value for actions.
   * @param task - Value for task.
   * @param synthesizerModel - Value for synthesizer model.
   * @returns Ordered collection produced by this step.
   */
  private async ensureRespondMessages(
    actions: PlannedAction[],
    task: TaskRequest,
    synthesizerModel: string
  ): Promise<PlannedAction[]> {
    const needsMessage = actions.some(
      (action) => action.type === "respond" && !hasRespondMessage(action)
    );
    if (!needsMessage) {
      return actions;
    }

    const synthesizedMessage = await this.synthesizeRespondMessage(task, synthesizerModel);
    return actions.map((action) => {
      if (action.type !== "respond" || hasRespondMessage(action)) {
        return action;
      }

      return {
        ...action,
        params: {
          ...action.params,
          message: synthesizedMessage
        }
      };
    });
  }

  /**
   * Implements enforce run skill intent policy behavior used by `planner`.
   *
   * **Why it exists:**
   * Keeps `enforce run skill intent policy` behavior centralized so collaborating call sites stay consistent.
   *
   * **What it talks to:**
   * - Uses `estimateActionCostUsd` (import `estimateActionCostUsd`) from `../core/actionCostPolicy`.
   * - Uses `PlannedAction` (import `PlannedAction`) from `../core/types`.
   * - Uses `TaskRequest` (import `TaskRequest`) from `../core/types`.
   * - Uses `extractCurrentUserRequest` (import `extractCurrentUserRequest`) from `./memoryBroker`.
   * - Uses `allowsRunSkillForRequest` (import `allowsRunSkillForRequest`) from `./plannerHelpers`.
   * - Uses `hasOnlyRunSkillActions` (import `hasOnlyRunSkillActions`) from `./plannerHelpers`.
   *
   * @param actions - Value for actions.
   * @param task - Value for task.
   * @param synthesizerModel - Value for synthesizer model.
   * @param currentUserRequest - Structured input object for this operation.
   * @returns Ordered collection produced by this step.
   */
  private async enforceRunSkillIntentPolicy(
    actions: PlannedAction[],
    task: TaskRequest,
    synthesizerModel: string,
    currentUserRequest: string
  ): Promise<{ actions: PlannedAction[]; usedFallback: boolean }> {
    const extractedCurrentUserRequest = extractCurrentUserRequest(task.userInput);
    const runSkillAllowed =
      allowsRunSkillForRequest(currentUserRequest) &&
      allowsRunSkillForRequest(extractedCurrentUserRequest);
    const filteredActions = runSkillAllowed
      ? actions
      : actions.filter((action) => action.type !== "run_skill");
    if (filteredActions.length > 0) {
      return {
        actions: filteredActions,
        usedFallback: false
      };
    }

    if (!hasOnlyRunSkillActions(actions)) {
      return {
        actions: filteredActions,
        usedFallback: false
      };
    }

    const synthesizedMessage = await this.synthesizeRespondMessage(task, synthesizerModel);
    return {
      actions: [
        {
          id: "action_non_explicit_run_skill_post_filter_fallback",
          type: "respond",
          description: "Respond using deterministic fallback after post-normalization run_skill filtering.",
          params: {
            message: synthesizedMessage
          },
          estimatedCostUsd: estimateActionCostUsd({
            type: "respond",
            params: {
              message: synthesizedMessage
            }
          })
        }
      ],
      usedFallback: true
    };
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
   * - Uses `extractActionCandidates` (import `extractActionCandidates`) from `./plannerHelpers`.
   * - Uses `filterNonExplicitRunSkillActions` (import `filterNonExplicitRunSkillActions`) from `./plannerHelpers`.
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
    const distilledLessons = relevantLessons.map((lesson) => {
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
        throw new Error(
          `Retrieval quarantine blocked lesson ${lesson.id}: ` +
          `${distillation.blockCode} (${distillation.reason})`
        );
      }
      const packetValidation = requireDistilledPacketForPlanner(distillation.packet);
      if (packetValidation) {
        throw new Error(
          `Retrieval quarantine packet validation failed for lesson ${lesson.id}: ` +
          `${packetValidation.blockCode} (${packetValidation.reason})`
        );
      }
      return {
        packet: distillation.packet,
        concepts: lesson.concepts
      };
    });
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
      const output = await this.requestPlannerOutput(
        task,
        plannerModel,
        lessonsText,
        firstPrinciplesGuidance,
        learningGuidance,
        currentUserRequest,
        requiredActionType,
        playbookSelection
      );
      let normalizedActions = normalizeModelActions(extractActionCandidates(output));
      normalizedActions = normalizeRequiredCreateSkillParams(
        normalizedActions,
        currentUserRequest,
        requiredActionType
      );
      const filteredInitialRunSkillOnly =
        hasOnlyRunSkillActions(normalizedActions) &&
        filterNonExplicitRunSkillActions(normalizedActions, currentUserRequest).length === 0;
      normalizedActions = filterNonExplicitRunSkillActions(
        normalizedActions,
        currentUserRequest
      );
      const missingRequiredAction =
        normalizedActions.length > 0 &&
        !hasRequiredAction(normalizedActions, requiredActionType);
      if (normalizedActions.length === 0 || missingRequiredAction) {
        const repairReason =
          normalizedActions.length === 0
            ? "no_valid_actions"
            : `missing_required_action:${requiredActionType}`;
        const repairedOutput = await this.requestPlannerRepairOutput(
          task,
          plannerModel,
          lessonsText,
          firstPrinciplesGuidance,
          learningGuidance,
          output,
          currentUserRequest,
          requiredActionType,
          repairReason,
          playbookSelection
        );
        normalizedActions = normalizeModelActions(extractActionCandidates(repairedOutput));
        normalizedActions = normalizeRequiredCreateSkillParams(
          normalizedActions,
          currentUserRequest,
          requiredActionType
        );
        const filteredRepairRunSkillOnly =
          hasOnlyRunSkillActions(normalizedActions) &&
          filterNonExplicitRunSkillActions(normalizedActions, currentUserRequest).length === 0;
        normalizedActions = filterNonExplicitRunSkillActions(
          normalizedActions,
          currentUserRequest
        );
        if (normalizedActions.length === 0) {
          if (
            requiredActionType === null &&
            (filteredRepairRunSkillOnly || filteredInitialRunSkillOnly)
          ) {
            const synthesizedMessage = await this.synthesizeRespondMessage(
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
              actions: [
                {
                  id: "action_non_explicit_run_skill_fallback",
                  type: "respond",
                  description: "Respond using deterministic fallback after filtering non-explicit run_skill actions.",
                  params: {
                    message: synthesizedMessage
                  },
                  estimatedCostUsd: estimateActionCostUsd({
                    type: "respond",
                    params: {
                      message: synthesizedMessage
                    }
                  })
                }
              ]
            };
          }
          throw new Error("Planner model returned no valid actions.");
        }
        if (!hasRequiredAction(normalizedActions, requiredActionType)) {
          throw new Error(
            `Planner model missing required ${requiredActionType} action for explicit user intent.`
          );
        }
        const actionsWithMessages = await this.ensureRespondMessages(
          normalizedActions,
          task,
          synthesizerModel
        );
        const postPolicy = await this.enforceRunSkillIntentPolicy(
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

      if (!hasRequiredAction(normalizedActions, requiredActionType)) {
        throw new Error(
          `Planner model missing required ${requiredActionType} action for explicit user intent.`
        );
      }
      const actionsWithMessages = await this.ensureRespondMessages(
        normalizedActions,
        task,
        synthesizerModel
      );
      const postPolicy = await this.enforceRunSkillIntentPolicy(
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
