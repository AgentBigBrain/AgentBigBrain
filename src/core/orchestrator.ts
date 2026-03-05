/**
 * @fileoverview Coordinates planning, constraint checks, governance voting, execution, and state persistence.
 */

import { BrainConfig } from "./config";
import { selectModelForRole } from "./modelRouting";
import { ExecutionReceiptStore } from "./advancedAutonomyRuntime";
import {
  buildFailureTaxonomySignalFromRun,
  classifyFailureTaxonomy
} from "./advancedAutonomyFoundation";
import {
  createFederatedOutboundRuntimeConfigFromEnv,
  evaluateFederatedOutboundPolicy,
  FederatedOutboundRuntimeConfig
} from "./federatedOutboundDelegation";
import {
  ActionRunResult,
  FailureTaxonomyCodeV1,
  FailureTaxonomyResultV1,
  MissionCheckpointV1,
  ProfileMemoryStatus,
  STAGE_6_75_BLOCK_CODES,
  Stage675BlockCode,
  TaskRequest,
  TaskRunResult,
  WorkflowPattern
} from "./types";
import { extractActiveRequestSegment } from "./currentRequestExtraction";
import {
  deriveJudgmentPatternFromTaskRun,
  JudgmentPattern,
  JudgmentPatternStore
} from "./judgmentPatterns";
import {
  deriveWorkflowObservationFromTaskRun,
  WorkflowLearningStore
} from "./workflowLearningStore";
import { MasterGovernor } from "../governors/masterGovernor";
import { Governor } from "../governors/types";
import { ModelClient, ModelUsageSnapshot } from "../models/types";
import { PlannerOrgan } from "../organs/planner";
import { ReflectionOrgan } from "../organs/reflection";
import { ToolExecutorOrgan } from "../organs/executor";
import {
  InterpretedConversationIntent,
  IntentInterpreterOrgan,
  IntentInterpreterTurn
} from "../organs/intentInterpreter";
import { PulseLexicalRuleContext } from "../organs/pulseLexicalClassifier";
import { MemoryBrokerOrgan } from "../organs/memoryBroker";
import { StateStore } from "./stateStore";
import { PersonalityStore } from "./personalityStore";
import { GovernanceMemoryStore } from "./governanceMemory";
import {
  AgentPulseEvaluationRequest,
  AgentPulseEvaluationResult,
  ProfileMemoryStore
} from "./profileMemoryStore";
import { AppendRuntimeTraceEventInput, RuntimeTraceLogger } from "./runtimeTraceLogger";
import { TaskRunner } from "./taskRunner";
import {
  buildMissionPostmortem,
  evaluateRetryBudget,
  RetryBudgetDecision
} from "./stage6_85RecoveryPolicy";
import {
  resolveStage685PlaybookPlanningContext,
  Stage685PlaybookPlanningContext
} from "./stage6_85PlaybookRuntime";
import { FederatedHttpClient } from "../interfaces/federatedClient";

type Stage685PlaybookPlanningContextResolver = (input: {
  userInput: string;
  nowIso: string;
}) => Promise<Stage685PlaybookPlanningContext>;

type FederatedOutboundRuntimeConfigResolver = (
  env: NodeJS.ProcessEnv
) => FederatedOutboundRuntimeConfig;

/**
 * Creates an empty usage snapshot value with deterministic defaults.
 *
 * **Why it exists:**
 * Provides a single default shape for usage snapshot so callers do not diverge on initialization.
 *
 * **What it talks to:**
 * - `ModelUsageSnapshot` shape from model client contracts.
 *
 * @returns Zeroed usage metrics used when provider telemetry is unavailable.
 */
function emptyUsageSnapshot(): ModelUsageSnapshot {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedSpendUsd: 0
  };
}

/**
 * Computes per-task usage delta from two cumulative model-usage snapshots.
 *
 * **Why it exists:**
 * Model clients expose cumulative counters; task summaries need bounded per-run deltas.
 *
 * **What it talks to:**
 * - `ModelUsageSnapshot` values read before and after task execution.
 *
 * @param start - Snapshot captured at task start.
 * @param end - Snapshot captured after task completion.
 * @returns Non-negative usage delta with spend rounded to eight decimals.
 */
function diffUsageSnapshot(
  start: ModelUsageSnapshot,
  end: ModelUsageSnapshot
): ModelUsageSnapshot {
  return {
    calls: Math.max(0, end.calls - start.calls),
    promptTokens: Math.max(0, end.promptTokens - start.promptTokens),
    completionTokens: Math.max(0, end.completionTokens - start.completionTokens),
    totalTokens: Math.max(0, end.totalTokens - start.totalTokens),
    estimatedSpendUsd: Number(Math.max(0, end.estimatedSpendUsd - start.estimatedSpendUsd).toFixed(8))
  };
}

/**
 * Evaluates stage675 block code and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the stage675 block code policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `STAGE_6_75_BLOCK_CODES` (import `STAGE_6_75_BLOCK_CODES`) from `./types`.
 * - Uses `Stage675BlockCode` (import `Stage675BlockCode`) from `./types`.
 *
 * @param value - Candidate block code from violations, blocked-by lists, or retry policy.
 * @returns `true` when value is one of the Stage 6.75 canonical block codes.
 */
function isStage675BlockCode(value: unknown): value is Stage675BlockCode {
  return (
    typeof value === "string" &&
    STAGE_6_75_BLOCK_CODES.includes(value as Stage675BlockCode)
  );
}

/**
 * Creates a mission-checkpoint record for one executed plan action.
 *
 * **Why it exists:**
 * Stage 6.85 postmortems need deterministic per-action verification checkpoints.
 *
 * **What it talks to:**
 * - `ActionRunResult` for action id/type metadata.
 * - `MissionCheckpointV1` runtime evidence contract.
 *
 * @param taskId - Parent task/mission id.
 * @param missionAttemptId - Replan attempt number associated with this action.
 * @param result - Action execution/governance result.
 * @param checkpointIndex - Monotonic checkpoint index across all attempts.
 * @param observedAtIso - Timestamp captured when checkpoint entries are emitted.
 * @returns Mission checkpoint entry with stable idempotency key.
 */
function buildMissionCheckpoint(
  taskId: string,
  missionAttemptId: number,
  result: ActionRunResult,
  checkpointIndex: number,
  observedAtIso: string
): MissionCheckpointV1 {
  return {
    missionId: taskId,
    missionAttemptId,
    phase: "verify",
    actionType: result.action.type,
    observedAt: observedAtIso,
    idempotencyKey: `${taskId}:${missionAttemptId}:${result.action.id}:${checkpointIndex}`,
    actionId: result.action.id
  };
}

/**
 * Resolves mission failure block code from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of mission failure block code by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `RetryBudgetDecision` (import `RetryBudgetDecision`) from `./stage6_85RecoveryPolicy`.
 * - Uses `ActionRunResult` (import `ActionRunResult`) from `./types`.
 * - Uses `Stage675BlockCode` (import `Stage675BlockCode`) from `./types`.
 *
 * @param actionResults - Action outcomes collected across executed attempts.
 * @param retryDecision - Retry-budget decision for the last attempt, when available.
 * @returns Canonical Stage 6.75 block code describing why execution stopped.
 */
function resolveMissionFailureBlockCode(
  actionResults: readonly ActionRunResult[],
  retryDecision: RetryBudgetDecision | null
): Stage675BlockCode {
  if (retryDecision && !retryDecision.shouldRetry && retryDecision.blockCode) {
    return retryDecision.blockCode;
  }

  for (const result of actionResults) {
    for (const code of result.blockedBy) {
      if (isStage675BlockCode(code)) {
        return code;
      }
    }
    for (const violation of result.violations) {
      if (isStage675BlockCode(violation.code)) {
        return violation.code;
      }
    }
  }

  return "MISSION_STOP_LIMIT_REACHED";
}

/**
 * Resolves mission failure root cause from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of mission failure root cause by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `RetryBudgetDecision` (import `RetryBudgetDecision`) from `./stage6_85RecoveryPolicy`.
 * - Uses `ActionRunResult` (import `ActionRunResult`) from `./types`.
 *
 * @param actionResults - Action outcomes collected across executed attempts.
 * @param retryDecision - Retry-budget decision for the last attempt, when available.
 * @returns Human-readable cause summary for postmortem output.
 */
function resolveMissionFailureRootCause(
  actionResults: readonly ActionRunResult[],
  retryDecision: RetryBudgetDecision | null
): string {
  if (retryDecision && !retryDecision.shouldRetry) {
    return retryDecision.reason;
  }

  const firstBlocked = actionResults.find((result) => !result.approved);
  if (!firstBlocked) {
    return "No blocked action details were recorded.";
  }

  if (firstBlocked.violations.length > 0) {
    return firstBlocked.violations[0]?.message ?? "Constraint policy blocked execution.";
  }

  const rejectVotes = firstBlocked.votes.filter((vote) => !vote.approve);
  if (rejectVotes.length > 0) {
    return rejectVotes[0]?.reason ?? "Governance policy blocked execution.";
  }

  return "Mission stopped after deterministic runtime safety checks.";
}

/**
 * Decides whether to emit a Stage 6.85 mission postmortem in the task summary.
 *
 * **Why it exists:**
 * Postmortems are useful for true recovery-stop conditions and canonical Stage 6.75 failures,
 * but should not appear for unrelated non-blocking outcomes.
 *
 * **What it talks to:**
 * - Retry-budget stop decisions (`RetryBudgetDecision`).
 * - Action-level block/violation code lists (`ActionRunResult`).
 *
 * @param actionResults - Action outcomes collected across executed attempts.
 * @param retryDecision - Retry-budget decision for the last attempt, when available.
 * @returns `true` when summary output should include mission postmortem details.
 */
function shouldEmitMissionPostmortem(
  actionResults: readonly ActionRunResult[],
  retryDecision: RetryBudgetDecision | null
): boolean {
  if (retryDecision && !retryDecision.shouldRetry) {
    return true;
  }

  return actionResults.some((result) =>
    result.blockedBy.some((code) => isStage675BlockCode(code)) ||
    result.violations.some((violation) => isStage675BlockCode(violation.code))
  );
}

/**
 * Resolves deterministic FailureTaxonomyCodeV1 from failure category output.
 *
 * **Why it exists:**
 * Stage 6.10 requires typed failure-code persistence alongside failure categories so downstream
 * traces and state artifacts remain queryable.
 *
 * **What it talks to:**
 * - Uses `FailureTaxonomyCodeV1` contract mapping from `./types`.
 *
 * @param category - Classified failure taxonomy category.
 * @returns Canonical failure taxonomy code.
 */
function mapFailureTaxonomyCode(category: FailureTaxonomyResultV1["failureCategory"]): FailureTaxonomyCodeV1 {
  if (category === "constraint") {
    return "constraint_blocked";
  }
  if (category === "objective") {
    return "objective_not_met";
  }
  if (category === "reasoning") {
    return "reasoning_planner_failed";
  }
  if (category === "human_feedback") {
    return "human_feedback_required";
  }
  return "quality_rejected";
}

/**
 * Derives typed failure taxonomy metadata for a completed run result when applicable.
 *
 * **Why it exists:**
 * Keeps Stage 6.10 failure-classification policy centralized for orchestrator persistence/tracing.
 *
 * **What it talks to:**
 * - Uses `buildFailureTaxonomySignalFromRun` and `classifyFailureTaxonomy` helpers.
 * - Uses `FailureTaxonomyResultV1` contract from `./types`.
 *
 * @param runResult - Completed task run result to classify.
 * @returns Typed taxonomy metadata, or null when run has no failure signal.
 */
function deriveFailureTaxonomyFromRun(runResult: TaskRunResult): FailureTaxonomyResultV1 | null {
  const approvedCount = runResult.actionResults.filter((result) => result.approved).length;
  const blockedCount = runResult.actionResults.length - approvedCount;
  if (blockedCount === 0 && approvedCount > 0) {
    return null;
  }

  const failureCategory = classifyFailureTaxonomy(buildFailureTaxonomySignalFromRun(runResult));
  return {
    failureCategory,
    failureCode: mapFailureTaxonomyCode(failureCategory)
  };
}

interface ProfileAwareInput {
  userInput: string;
  profileMemoryStatus: ProfileMemoryStatus;
}

interface PlannerLearningContext {
  workflowHints: readonly WorkflowPattern[];
  judgmentHints: readonly JudgmentPattern[];
}

export class BrainOrchestrator {
  private readonly memoryBroker: MemoryBrokerOrgan;
  private readonly intentInterpreter: IntentInterpreterOrgan;
  private readonly taskRunner: TaskRunner;

  /**
   * Wires orchestrator dependencies for planning, governance, execution, memory, and tracing.
   *
   * **Why it exists:**
   * `BrainOrchestrator` is the production control-plane entrypoint; constructor injection keeps
   * policy modules explicit and testable.
   *
   * **What it talks to:**
   * - Planning/execution organs (`PlannerOrgan`, `ToolExecutorOrgan`, `IntentInterpreterOrgan`).
   * - Governance stack (`Governor[]`, `MasterGovernor`, `GovernanceMemoryStore`, `TaskRunner`).
   * - Runtime durability/telemetry (`StateStore`, `ExecutionReceiptStore`, `RuntimeTraceLogger`).
   * - Optional continuity subsystems (`ProfileMemoryStore`, `MemoryBrokerOrgan`, `PersonalityStore`).
   * - Stage 6.85 playbook context resolver.
   *
   * @param config - Global runtime configuration (limits, observability, policy knobs).
   * @param planner - Planner organ that emits governed action plans.
   * @param executor - Executor organ that performs approved actions.
   * @param governors - Governor council used for per-action voting.
   * @param masterGovernor - Final aggregation authority for governor votes.
   * @param stateStore - Durable run-history store used for context and append-only results.
   * @param modelClient - Structured model client used by planner/interpreter/reflection.
   * @param reflection - Reflection organ that writes post-run lessons.
   * @param personalityStore - Optional personality reinforcement store.
   * @param governanceMemoryStore - Store for persisted governance decisions and evidence.
   * @param profileMemoryStore - Optional profile-memory backend for Agent Friend continuity.
   * @param memoryBroker - Optional broker that injects profile context into planner input.
   * @param executionReceiptStore - Receipt ledger for execution provenance/audit.
   * @param traceLogger - Runtime trace logger for task-level events.
   * @param resolvePlaybookPlanningContext - Resolver that chooses Stage 6.85 planning context.
   * @param resolveFederatedOutboundRuntimeConfig - Resolver for outbound federation runtime config/env gates.
   * @param workflowLearningStore - Optional Stage 6.13 store used for workflow hint retrieval and post-run adaptation writes.
   * @param judgmentPatternStore - Optional Stage 6.17 store used for judgment hint retrieval and outcome calibration writes.
   */
  constructor(
    private readonly config: BrainConfig,
    private readonly planner: PlannerOrgan,
    private readonly executor: ToolExecutorOrgan,
    private readonly governors: Governor[],
    private readonly masterGovernor: MasterGovernor,
    private readonly stateStore: StateStore,
    private readonly modelClient: ModelClient,
    private readonly reflection: ReflectionOrgan,
    private readonly personalityStore: PersonalityStore | undefined,
    private readonly governanceMemoryStore: GovernanceMemoryStore = new GovernanceMemoryStore(),
    private readonly profileMemoryStore?: ProfileMemoryStore,
    memoryBroker?: MemoryBrokerOrgan,
    private readonly executionReceiptStore: ExecutionReceiptStore = new ExecutionReceiptStore(),
    private readonly traceLogger: RuntimeTraceLogger = new RuntimeTraceLogger({
      enabled: config.observability.traceEnabled,
      filePath: config.observability.traceLogPath
    }),
    private readonly resolvePlaybookPlanningContext: Stage685PlaybookPlanningContextResolver =
      resolveStage685PlaybookPlanningContext,
    private readonly resolveFederatedOutboundRuntimeConfig: FederatedOutboundRuntimeConfigResolver =
      createFederatedOutboundRuntimeConfigFromEnv,
    private readonly workflowLearningStore?: WorkflowLearningStore,
    private readonly judgmentPatternStore?: JudgmentPatternStore
  ) {
    this.memoryBroker = memoryBroker ?? new MemoryBrokerOrgan(profileMemoryStore);
    this.intentInterpreter = new IntentInterpreterOrgan(this.modelClient);
    this.taskRunner = new TaskRunner({
      config: this.config,
      governors: this.governors,
      masterGovernor: this.masterGovernor,
      modelClient: this.modelClient,
      executor: this.executor,
      governanceMemoryStore: this.governanceMemoryStore,
      executionReceiptStore: this.executionReceiptStore,
      appendTraceEvent: this.appendTraceEvent.bind(this)
    });
  }

  /**
   * Evaluates agent pulse and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps the agent pulse policy check explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses `AgentPulseEvaluationRequest` (import `AgentPulseEvaluationRequest`) from `./profileMemoryStore`.
   * - Uses `AgentPulseEvaluationResult` (import `AgentPulseEvaluationResult`) from `./profileMemoryStore`.
   *
   * @param request - Pulse-evaluation context (user/session metadata and timing inputs).
   * @returns Promise resolving to AgentPulseEvaluationResult.
   */
  async evaluateAgentPulse(
    request: AgentPulseEvaluationRequest
  ): Promise<AgentPulseEvaluationResult> {
    if (!this.profileMemoryStore) {
      return {
        decision: {
          allowed: false,
          decisionCode: "DISABLED",
          suppressedBy: ["profile_memory.disabled"],
          nextEligibleAtIso: null
        },
        staleFactCount: 0,
        unresolvedCommitmentCount: 0,
        unresolvedCommitmentTopics: [],
        relationship: {
          role: "unknown",
          roleFactId: null
        },
        contextDrift: {
          detected: false,
          domains: [],
          requiresRevalidation: false
        }
      };
    }

    try {
      return await this.profileMemoryStore.evaluateAgentPulse(this.config.agentPulse, request);
    } catch {
      return {
        decision: {
          allowed: false,
          decisionCode: "DISABLED",
          suppressedBy: ["profile_memory.unavailable"],
          nextEligibleAtIso: null
        },
        staleFactCount: 0,
        unresolvedCommitmentCount: 0,
        unresolvedCommitmentTopics: [],
        relationship: {
          role: "unknown",
          roleFactId: null
        },
        contextDrift: {
          detected: false,
          domains: [],
          requiresRevalidation: false
        }
      };
    }
  }

  /**
   * Interprets conversation intent into a typed decision signal.
   *
   * **Why it exists:**
   * Provides one interpretation path for conversation intent so policy consumers receive stable typed signals.
   *
   * **What it talks to:**
   * - Uses `IntentInterpreterTurn` (import `IntentInterpreterTurn`) from `../organs/intentInterpreter`.
   * - Uses `InterpretedConversationIntent` (import `InterpretedConversationIntent`) from `../organs/intentInterpreter`.
   * - Uses `PulseLexicalRuleContext` (import `PulseLexicalRuleContext`) from `../organs/pulseLexicalClassifier`.
   * - Uses `selectModelForRole` (import `selectModelForRole`) from `./modelRouting`.
   *
   * @param text - Current user message to classify.
   * @param recentTurns - Recent conversation turns used for disambiguation.
   * @param pulseRuleContext - Optional lexical context for pulse-control interpretation.
   * @returns Promise resolving to InterpretedConversationIntent.
   */
  async interpretConversationIntent(
    text: string,
    recentTurns: IntentInterpreterTurn[],
    pulseRuleContext?: PulseLexicalRuleContext
  ): Promise<InterpretedConversationIntent> {
    try {
      const interpreterModel = selectModelForRole("planner", this.config);
      return await this.intentInterpreter.interpretConversationIntent(
        text,
        interpreterModel,
        {
          recentTurns,
          pulseRuleContext
        }
      );
    } catch (error) {
      return {
        intentType: "none",
        pulseMode: null,
        confidence: 0,
        rationale: `Intent interpreter fallback: ${(error as Error).message}`,
        source: "fallback"
      };
    }
  }

  /**
   * Persists trace event with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes trace event mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `AppendRuntimeTraceEventInput` (import `AppendRuntimeTraceEventInput`) from `./runtimeTraceLogger`.
   *
   * @param input - Trace event payload to append.
   * @returns Promise resolving to void.
   */
  private async appendTraceEvent(input: AppendRuntimeTraceEventInput): Promise<void> {
    try {
      await this.traceLogger.appendEvent(input);
    } catch (error) {
      console.error(
        `[Trace] non-fatal runtime trace append failure for task ${input.taskId}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Executes task as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the task runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - `selectModelForRole` for planner/synthesizer model routing.
   * - `TaskRunner` for hard-constraint + governor + execution flow.
   * - Stage 6.85 retry/postmortem helpers (`evaluateRetryBudget`, `buildMissionPostmortem`).
   * - Durability/learning sinks (`StateStore`, `PersonalityStore`, `ReflectionOrgan`).
   * - Runtime tracing via `appendTraceEvent`.
   *
   * @param task - Incoming task request from CLI/interface runtime.
   * @returns Promise resolving to TaskRunResult.
   */
  async runTask(task: TaskRequest): Promise<TaskRunResult> {
    const startedAtIso = new Date().toISOString();
    const startedAtMs = Date.now();
    const usageStart = this.readModelUsageSnapshot();
    await this.appendTraceEvent({
      eventType: "task_started",
      taskId: task.id,
      details: {
        agentId: task.agentId ?? null,
        goalLength: task.goal.length,
        userInputLength: task.userInput.length
      }
    });

    const delegatedRunResult = await this.maybeRunOutboundFederatedTask(
      task,
      startedAtIso,
      startedAtMs,
      usageStart
    );
    if (delegatedRunResult) {
      return delegatedRunResult;
    }

    // Load prior runs/metrics so each decision has historical context available.
    const state = await this.stateStore.load();
    const profileAwareInput = await this.buildProfileAwareInput(task);
    const profileMemoryStatus = profileAwareInput.profileMemoryStatus;
    const profileAwareUserInput = profileAwareInput.userInput;
    const plannerLearningContext = await this.loadPlannerLearningContext(profileAwareUserInput);
    const plannerModel = selectModelForRole("planner", this.config);
    const synthesizerModel = selectModelForRole("synthesizer", this.config);
    const actionResults: ActionRunResult[] = [];
    const missionCheckpoints: MissionCheckpointV1[] = [];
    let cumulativeApprovedEstimatedCostUsd = 0;
    const maxPlanAttempts = Math.max(1, this.config.limits.maxPlanAttemptsPerTask);
    let attemptsExecuted = 0;
    let retryDecision: RetryBudgetDecision | null = null;
    let currentPlan = await this.planForAttempt(
      task,
      plannerModel,
      synthesizerModel,
      profileAwareUserInput,
      1,
      plannerLearningContext
    );

    // Retry planning within the same task when governance rejects an entire attempt.
    for (let attempt = 1; attempt <= maxPlanAttempts; attempt += 1) {
      attemptsExecuted = attempt;
      const attemptOutcome = await this.taskRunner.runPlanActions({
        task,
        state,
        plan: currentPlan,
        startedAtMs,
        cumulativeApprovedEstimatedCostUsd,
        modelUsageStart: usageStart,
        profileMemoryStatus,
        missionAttemptId: attempt
      });
      actionResults.push(...attemptOutcome.results);
      const checkpointObservedAtIso = new Date().toISOString();
      missionCheckpoints.push(
        ...attemptOutcome.results.map((result, index) =>
          buildMissionCheckpoint(
            task.id,
            attempt,
            result,
            missionCheckpoints.length + index + 1,
            checkpointObservedAtIso
          )
        )
      );
      cumulativeApprovedEstimatedCostUsd += attemptOutcome.approvedEstimatedCostDeltaUsd;

      const governanceFeedback = this.extractGovernanceReplanFeedback(attemptOutcome.results);
      if (!governanceFeedback) {
        break;
      }

      retryDecision = evaluateRetryBudget(attempt, maxPlanAttempts);
      if (!retryDecision.shouldRetry) {
        await this.appendTraceEvent({
          eventType: "constraint_blocked",
          taskId: task.id,
          details: {
            blockCode: retryDecision.blockCode,
            blockCategory: "runtime"
          }
        });
        break;
      }

      const replannedInput = this.buildReplanInput(
        profileAwareUserInput,
        governanceFeedback,
        retryDecision.nextAttempt
      );
      currentPlan = await this.planForAttempt(
        task,
        plannerModel,
        synthesizerModel,
        replannedInput,
        retryDecision.nextAttempt,
        plannerLearningContext
      );
    }

    const approvedCount = actionResults.filter((result) => result.approved).length;
    const blockedCount = actionResults.length - approvedCount;
    const budgetBlockedCount = actionResults.filter((result) =>
      result.blockedBy.includes("COST_LIMIT_EXCEEDED") ||
      result.blockedBy.includes("CUMULATIVE_COST_LIMIT_EXCEEDED") ||
      result.blockedBy.includes("MODEL_SPEND_LIMIT_EXCEEDED")
    ).length;
    const completedAt = new Date().toISOString();
    const usageEnd = this.readModelUsageSnapshot();
    const usageDelta = diffUsageSnapshot(usageStart, usageEnd);
    const missionPostmortem =
      approvedCount === 0 &&
      blockedCount > 0 &&
      shouldEmitMissionPostmortem(actionResults, retryDecision)
        ? buildMissionPostmortem({
          missionId: task.id,
          missionAttemptId: attemptsExecuted,
          failedAt: completedAt,
          blockCode: resolveMissionFailureBlockCode(actionResults, retryDecision),
          rootCause: resolveMissionFailureRootCause(actionResults, retryDecision),
          checkpoints: missionCheckpoints
        })
        : null;

    const runResult: TaskRunResult = {
      task,
      plan: currentPlan,
      actionResults,
      summary:
        `Completed task with ${approvedCount} approved action(s) and ${blockedCount} blocked action(s) ` +
        `across ${attemptsExecuted} plan attempt(s). Estimated approved action cost ` +
        `${cumulativeApprovedEstimatedCostUsd.toFixed(2)}/${this.config.limits.maxCumulativeEstimatedCostUsd.toFixed(2)} USD.` +
        ` Model usage spend (provider-usage estimated) ${usageDelta.estimatedSpendUsd.toFixed(6)}/` +
        `${this.config.limits.maxCumulativeModelSpendUsd.toFixed(2)} USD.` +
        (missionPostmortem
          ? ` Recovery postmortem: ${missionPostmortem.blockCode} (${missionPostmortem.rootCause}).`
          : "") +
        (profileMemoryStatus === "degraded_unavailable"
          ? " Agent Friend context unavailable (degraded_unavailable); continuing with core task mode."
          : "") +
        (budgetBlockedCount > 0
          ? ` Budget controls blocked ${budgetBlockedCount} action(s).`
          : ""),
      modelUsage: usageDelta,
      startedAt: startedAtIso,
      completedAt
    };
    const failureTaxonomy = deriveFailureTaxonomyFromRun(runResult);
    if (failureTaxonomy) {
      runResult.failureTaxonomy = failureTaxonomy;
    }

    await this.appendTraceEvent({
      eventType: "task_completed",
      taskId: task.id,
      durationMs: Date.now() - startedAtMs,
      details: {
        approvedCount,
        blockedCount,
        attemptsExecuted,
        estimatedApprovedCostUsd: Number(cumulativeApprovedEstimatedCostUsd.toFixed(4)),
        modelSpendUsd: Number(usageDelta.estimatedSpendUsd.toFixed(8)),
        firstPrinciplesRequired: currentPlan.firstPrinciples?.required ?? false,
        firstPrinciplesTriggerCount: currentPlan.firstPrinciples?.triggerReasons.length ?? 0,
        workflowHintCount: currentPlan.learningHints?.workflowHintCount ?? 0,
        judgmentHintCount: currentPlan.learningHints?.judgmentHintCount ?? 0,
        failureCategory: failureTaxonomy?.failureCategory ?? null,
        failureCode: failureTaxonomy?.failureCode ?? null,
        retryStopBlockCode:
          retryDecision && !retryDecision.shouldRetry ? retryDecision.blockCode : null,
        postmortemBlockCode: missionPostmortem?.blockCode ?? null,
        lastDurableActionId: missionPostmortem?.lastDurableCheckpoint?.actionId ?? null
      }
    });

    await this.stateStore.appendRun(runResult);
    await this.persistLearningSignals(runResult);

    // Personality learning is deterministic and safety-filtered. Failures are non-fatal.
    if (this.personalityStore) {
      try {
        await this.personalityStore.applyRunReward(runResult);
      } catch (error) {
        console.error(
          `[Personality] non-fatal personality update failure for task ${task.id}: ${(error as Error).message}`
        );
      }
    }

    // Reflection failures are non-fatal; task execution result is already durable.
    try {
      const reflectionModel = selectModelForRole("planner", this.config);
      await this.reflection.reflectOnTask(runResult, reflectionModel);
    } catch (error) {
      console.error(
        `[Reflection] non-fatal reflection failure for task ${task.id}: ${(error as Error).message}`
      );
    }

    return runResult;
  }

  /**
   * Attempts explicit outbound federated delegation before local planning/execution.
   *
   * **Why it exists:**
   * Phase 2b wiring requires a production-path outbound delegation route with deterministic
   * allowlist/quote gates and fail-closed local fallback when policy checks fail.
   *
   * **What it talks to:**
   * - Outbound federation policy/config helpers (`federatedOutboundDelegation`).
   * - `FederatedHttpClient` for remote delegate/poll protocol.
   * - Runtime trace/state/reflection sinks for durable evidence parity.
   *
   * @param task - Current task request.
   * @param startedAtIso - Task start timestamp.
   * @param startedAtMs - Task start time in epoch milliseconds.
   * @param usageStart - Model usage snapshot captured at task start.
   * @returns Delegated task run result when outbound route executes, otherwise `null` to continue local path.
   */
  private async maybeRunOutboundFederatedTask(
    task: TaskRequest,
    startedAtIso: string,
    startedAtMs: number,
    usageStart: ModelUsageSnapshot
  ): Promise<TaskRunResult | null> {
    let outboundConfig: FederatedOutboundRuntimeConfig;
    try {
      outboundConfig = this.resolveFederatedOutboundRuntimeConfig(process.env);
    } catch (error) {
      await this.appendTraceEvent({
        eventType: "constraint_blocked",
        taskId: task.id,
        details: {
          blockCode: "OUTBOUND_FEDERATION_CONFIG_INVALID",
          blockCategory: "runtime",
          fallbackLocal: true,
          reason: error instanceof Error ? error.message : String(error)
        }
      });
      return null;
    }

    const policyDecision = evaluateFederatedOutboundPolicy(task, outboundConfig);
    if (!policyDecision.intent) {
      return null;
    }

    if (!policyDecision.shouldDelegate || !policyDecision.target) {
      await this.appendTraceEvent({
        eventType: "constraint_blocked",
        taskId: task.id,
        details: {
          blockCode: policyDecision.reasonCode,
          blockCategory: "runtime",
          fallbackLocal: true,
          reason: policyDecision.reason
        }
      });
      return null;
    }

    const target = policyDecision.target;
    const intent = policyDecision.intent;
    const quoteId = `${task.id}:${target.externalAgentId}:quote`;
    const client = new FederatedHttpClient({
      baseUrl: target.baseUrl,
      timeoutMs: target.awaitTimeoutMs,
      auth: {
        externalAgentId: target.externalAgentId,
        sharedSecret: target.sharedSecret
      }
    });

    const delegateResult = await client.delegate({
      quoteId,
      quotedCostUsd: intent.quotedCostUsd,
      goal: task.goal,
      userInput: intent.delegatedUserInput,
      requestedAt: task.createdAt
    });
    if (!delegateResult.ok || !delegateResult.taskId || !delegateResult.decision?.accepted) {
      await this.appendTraceEvent({
        eventType: "constraint_blocked",
        taskId: task.id,
        details: {
          blockCode: "OUTBOUND_DELEGATION_DISPATCH_REJECTED",
          blockCategory: "runtime",
          fallbackLocal: true,
          httpStatus: delegateResult.httpStatus,
          reason:
            delegateResult.error ??
            delegateResult.decision?.reasons.join(" | ") ??
            "Outbound delegate call was not accepted."
        }
      });
      return null;
    }

    const pollResult = await client.awaitResult(delegateResult.taskId, {
      pollIntervalMs: target.pollIntervalMs,
      timeoutMs: target.awaitTimeoutMs
    });
    const remoteStatus = pollResult.result?.status ?? (pollResult.ok ? "pending" : "poll_failed");
    const remoteOutput = pollResult.result?.output ?? "";
    const remoteError =
      pollResult.result?.error ??
      (pollResult.ok ? null : pollResult.error ?? "Federated poll failed without error message.");
    const approved = pollResult.ok && pollResult.result?.status === "completed";
    const completedAtIso = new Date().toISOString();
    const usageEnd = this.readModelUsageSnapshot();
    const usageDelta = diffUsageSnapshot(usageStart, usageEnd);

    const delegatedAction: TaskRunResult["plan"]["actions"][number] = {
      id: `federated_delegate_${task.id}`,
      type: "network_write",
      description: `Delegate task to federated target ${target.externalAgentId}.`,
      params: {
        endpoint: `${target.baseUrl}/federation/delegate`,
        externalAgentId: target.externalAgentId,
        quoteId,
        delegatedTaskId: delegateResult.taskId,
        quotedCostUsd: intent.quotedCostUsd,
        delegationMode: "federated_outbound_v1"
      },
      estimatedCostUsd: intent.quotedCostUsd
    };
    const actionResult: ActionRunResult = {
      action: delegatedAction,
      mode: "escalation_path",
      approved,
      output: approved
        ? (remoteOutput.trim() || "Federated task completed with empty output payload.")
        : `Federated task did not complete successfully: ${remoteError ?? "unknown error"}`,
      executionMetadata: {
        outboundFederation: true,
        targetAgentId: target.externalAgentId,
        delegatedTaskId: delegateResult.taskId,
        remoteStatus
      },
      blockedBy: approved ? [] : ["ACTION_EXECUTION_FAILED"],
      violations: approved
        ? []
        : [
          {
            code: "ACTION_EXECUTION_FAILED",
            message:
              `Outbound federated task "${delegateResult.taskId}" failed with status "${remoteStatus}". ` +
              `Reason: ${remoteError ?? "unknown error"}.`
          }
        ],
      votes: []
    };
    const runResult: TaskRunResult = {
      task,
      plan: {
        taskId: task.id,
        plannerNotes:
          `Outbound federated delegation route selected for target "${target.externalAgentId}".`,
        actions: [delegatedAction]
      },
      actionResults: [actionResult],
      summary: approved
        ? `Delegated outbound task to "${target.externalAgentId}" (taskId=${delegateResult.taskId}) and received a completed result.`
        : `Delegated outbound task to "${target.externalAgentId}" (taskId=${delegateResult.taskId}) but remote execution failed (${remoteStatus}).`,
      modelUsage: usageDelta,
      startedAt: startedAtIso,
      completedAt: completedAtIso
    };
    const failureTaxonomy = deriveFailureTaxonomyFromRun(runResult);
    if (failureTaxonomy) {
      runResult.failureTaxonomy = failureTaxonomy;
    }

    await this.appendTraceEvent({
      eventType: "action_executed",
      taskId: task.id,
      actionId: delegatedAction.id,
      mode: "escalation_path",
      details: {
        outboundFederation: true,
        targetAgentId: target.externalAgentId,
        delegatedTaskId: delegateResult.taskId,
        remoteStatus,
        outputLength: remoteOutput.length
      }
    });
    await this.appendTraceEvent({
      eventType: "task_completed",
      taskId: task.id,
      durationMs: Date.now() - startedAtMs,
      details: {
        approvedCount: approved ? 1 : 0,
        blockedCount: approved ? 0 : 1,
        attemptsExecuted: 1,
        estimatedApprovedCostUsd: approved ? Number(intent.quotedCostUsd.toFixed(4)) : 0,
        modelSpendUsd: Number(usageDelta.estimatedSpendUsd.toFixed(8)),
        outboundFederation: true,
        targetAgentId: target.externalAgentId,
        delegatedTaskId: delegateResult.taskId,
        remoteStatus,
        failureCategory: failureTaxonomy?.failureCategory ?? null,
        failureCode: failureTaxonomy?.failureCode ?? null
      }
    });

    await this.stateStore.appendRun(runResult);
    await this.persistLearningSignals(runResult);

    if (this.personalityStore) {
      try {
        await this.personalityStore.applyRunReward(runResult);
      } catch (error) {
        console.error(
          `[Personality] non-fatal personality update failure for task ${task.id}: ${(error as Error).message}`
        );
      }
    }

    try {
      const reflectionModel = selectModelForRole("planner", this.config);
      await this.reflection.reflectOnTask(runResult, reflectionModel);
    } catch (error) {
      console.error(
        `[Reflection] non-fatal reflection failure for task ${task.id}: ${(error as Error).message}`
      );
    }

    return runResult;
  }

  /**
   * Runs planner generation for one attempt, including playbook context and action capping.
   *
   * **Why it exists:**
   * Replan attempts should follow the exact same planning pipeline while adding deterministic
   * attempt/playbook annotations.
   *
   * **What it talks to:**
   * - Stage 6.85 playbook resolver (`resolvePlaybookPlanningContext`).
   * - `PlannerOrgan.plan` for model-generated action plans.
   * - Runtime tracing via `appendTraceEvent`.
   *
   * @param task - Original task request metadata.
   * @param plannerModel - Model id used for planning output.
   * @param synthesizerModel - Model id used for response synthesis.
   * @param userInput - Planner-facing user input for this attempt (original or replan prompt).
   * @param attemptNumber - One-based attempt counter.
   * @param plannerLearningContext - Pre-fetched Stage 6.13/6.17 hint context for planner guidance.
   * @returns Planned action bundle ready for task-runner execution.
   */
  private async planForAttempt(
    task: TaskRequest,
    plannerModel: string,
    synthesizerModel: string,
    userInput: string,
    attemptNumber: number,
    plannerLearningContext: PlannerLearningContext
  ): Promise<TaskRunResult["plan"]> {
    const plannerStartedAtMs = Date.now();
    const playbookPlanningContext = await this.resolvePlaybookPlanningContext({
      userInput: task.userInput,
      nowIso: new Date().toISOString()
    });
    const plannerTask: TaskRequest = {
      ...task,
      userInput
    };
    const rawPlan = await this.planner.plan(
      plannerTask,
      plannerModel,
      synthesizerModel,
      {
        playbookSelection: playbookPlanningContext,
        workflowHints: plannerLearningContext.workflowHints,
        judgmentHints: plannerLearningContext.judgmentHints
      }
    );
    const cappedActions = rawPlan.actions.slice(0, this.config.limits.maxActionsPerTask);
    const playbookSuffix = playbookPlanningContext.selectedPlaybookId
      ? ` [playbook=${playbookPlanningContext.selectedPlaybookId}]`
      : " [playbook=fallback]";
    const replanSuffix = attemptNumber > 1 ? ` [replanAttempt=${attemptNumber}]` : "";
    const plan = {
      ...rawPlan,
      plannerNotes: `${rawPlan.plannerNotes}${playbookSuffix}${replanSuffix}`,
      actions: cappedActions
    };
    await this.appendTraceEvent({
      eventType: "planner_completed",
      taskId: task.id,
      durationMs: Date.now() - plannerStartedAtMs,
      details: {
        attemptNumber,
        plannerModel,
        synthesizerModel,
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

  /**
   * Reads model-usage telemetry from the client, with a safe empty fallback.
   *
   * **Why it exists:**
   * Some model clients may not implement telemetry yet; orchestration still needs stable math.
   *
   * **What it talks to:**
   * - `modelClient.getUsageSnapshot` when available.
   * - `emptyUsageSnapshot` fallback.
   *
   * @returns Current cumulative usage snapshot.
   */
  private readModelUsageSnapshot(): ModelUsageSnapshot {
    if (typeof this.modelClient.getUsageSnapshot === "function") {
      return this.modelClient.getUsageSnapshot();
    }
    return emptyUsageSnapshot();
  }

  /**
   * Builds planner-facing input enriched with profile-memory context when available.
   *
   * **Why it exists:**
   * Keeps profile-context ingestion logic inside `MemoryBrokerOrgan` instead of duplicating it
   * in orchestration.
   *
   * **What it talks to:**
   * - `MemoryBrokerOrgan.buildPlannerInput`.
   *
   * @param task - Current task request.
   * @returns Profile-aware input string plus profile-memory status metadata.
   */
  private async buildProfileAwareInput(task: TaskRequest): Promise<ProfileAwareInput> {
    return this.memoryBroker.buildPlannerInput(task);
  }

  /**
   * Loads pre-plan workflow and judgment hints for planner guidance.
   *
   * **Why it exists:**
   * Phase 4 wiring requires deterministic hint retrieval before each planning attempt while keeping
   * store-read failures non-fatal to core task execution.
   *
   * **What it talks to:**
   * - `WorkflowLearningStore.getRelevantPatterns` for Stage 6.13 workflow hints.
   * - `JudgmentPatternStore.getRelevantPatterns` for Stage 6.17 judgment hints.
   * - `extractActiveRequestSegment` for bounded request-context extraction.
   *
   * @param plannerUserInput - Planner-facing user input for the current task run.
   * @returns Deterministic workflow/judgment hint bundle.
   */
  private async loadPlannerLearningContext(
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
    if (this.workflowLearningStore) {
      try {
        workflowHints = await this.workflowLearningStore.getRelevantPatterns(contextQuery, 3);
      } catch (error) {
        console.error(
          `[WorkflowLearning] non-fatal hint retrieval failure: ${(error as Error).message}`
        );
      }
    }

    let judgmentHints: readonly JudgmentPattern[] = [];
    if (this.judgmentPatternStore) {
      try {
        judgmentHints = await this.judgmentPatternStore.getRelevantPatterns(contextQuery, 3);
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
   * Derives deterministic objective-outcome score for judgment calibration.
   *
   * **Why it exists:**
   * Stage 6.17 objective calibration needs a stable score derived from approved vs blocked actions.
   *
   * **What it talks to:**
   * - Reads action approval outcomes from `TaskRunResult`.
   *
   * @param runResult - Completed task run result.
   * @returns Score in range [-1, 1] used for objective judgment signal writes.
   */
  private deriveJudgmentObjectiveScore(runResult: TaskRunResult): number {
    const totalActions = runResult.actionResults.length;
    if (totalActions <= 0) {
      return 0;
    }
    const approvedCount = runResult.actionResults.filter((result) => result.approved).length;
    const blockedCount = totalActions - approvedCount;
    return Number(((approvedCount - blockedCount) / totalActions).toFixed(4));
  }

  /**
   * Persists workflow and judgment learning signals from a completed run.
   *
   * **Why it exists:**
   * Phase 4 wiring requires post-run writes so future plans can reuse prior outcomes.
   *
   * **What it talks to:**
   * - `deriveWorkflowObservationFromTaskRun` and `WorkflowLearningStore.recordObservation`.
   * - `deriveJudgmentPatternFromTaskRun`, `JudgmentPatternStore.recordPattern`, and `applyOutcomeSignal`.
   *
   * @param runResult - Completed task run used for learning writes.
   * @returns Promise resolving when non-fatal learning writes complete.
   */
  private async persistLearningSignals(runResult: TaskRunResult): Promise<void> {
    if (this.workflowLearningStore) {
      try {
        const workflowObservation = deriveWorkflowObservationFromTaskRun(runResult);
        await this.workflowLearningStore.recordObservation(workflowObservation);
      } catch (error) {
        console.error(
          `[WorkflowLearning] non-fatal observation persistence failure for task ${runResult.task.id}: ${(error as Error).message}`
        );
      }
    }

    if (this.judgmentPatternStore) {
      try {
        const patternInput = deriveJudgmentPatternFromTaskRun(runResult, "balanced");
        const pattern = await this.judgmentPatternStore.recordPattern(patternInput);
        await this.judgmentPatternStore.applyOutcomeSignal(
          pattern.id,
          "objective",
          this.deriveJudgmentObjectiveScore(runResult),
          runResult.completedAt
        );
      } catch (error) {
        console.error(
          `[JudgmentPattern] non-fatal persistence failure for task ${runResult.task.id}: ${(error as Error).message}`
        );
      }
    }
  }

  /**
   * Extracts compact governor rejection notes to guide the next replan attempt.
   *
   * **Why it exists:**
   * Replanning should include concrete policy feedback instead of blindly retrying the same plan.
   *
   * **What it talks to:**
   * - Action execution results and embedded governor votes.
   *
   * @param attemptResults - Action results from one planning attempt.
   * @returns Newline-joined rejection summary, or `null` when replanning is not needed.
   */
  private extractGovernanceReplanFeedback(
    attemptResults: ActionRunResult[]
  ): string | null {
    if (attemptResults.some((result) => result.approved)) {
      return null;
    }

    const governanceBlocks = attemptResults.filter(
      (result) => !result.approved && result.violations.length === 0 && result.votes.length > 0
    );
    if (governanceBlocks.length === 0) {
      return null;
    }

    const notes = governanceBlocks.slice(0, 3).map((result) => {
      const voteReasons = result.votes
        .filter((vote) => !vote.approve)
        .slice(0, 4)
        .map((vote) => `${vote.governorId}: ${vote.reason}`)
        .join(" | ");
      return `${result.action.type}: ${voteReasons || "Blocked by governor policy."}`;
    });

    return notes.join("\n");
  }

  /**
   * Builds the planner prompt for the next governance-driven replan attempt.
   *
   * **Why it exists:**
   * Keeps retry prompts explicit: preserve user goal, add attempt index, and inject vote reasons.
   *
   * **What it talks to:**
   * - Local prompt template only.
   *
   * @param originalUserInput - Original user request text.
   * @param governanceFeedback - Governor rejection summary from prior attempt.
   * @param nextAttemptNumber - One-based attempt number about to be executed.
   * @returns Replan prompt string passed to planner.
   */
  private buildReplanInput(
    originalUserInput: string,
    governanceFeedback: string,
    nextAttemptNumber: number
  ): string {
    return [
      originalUserInput,
      "",
      `Replan Attempt ${nextAttemptNumber}: the prior plan was blocked by governance.`,
      "Adjust the plan to satisfy governor policy while still accomplishing the user goal.",
      "Governance feedback:",
      governanceFeedback
    ].join("\n");
  }

}
