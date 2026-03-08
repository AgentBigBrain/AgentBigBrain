/**
 * @fileoverview Coordinates planning, constraint checks, governance voting, execution, and state persistence.
 */

import { BrainConfig } from "./config";
import { selectModelForRole } from "./modelRouting";
import { ExecutionReceiptStore } from "./advancedAutonomyRuntime";
import {
  createFederatedOutboundRuntimeConfigFromEnv,
  evaluateFederatedOutboundPolicy,
  type FederatedOutboundRuntimeConfig
} from "./federatedOutboundDelegation";
import {
  type ActionRunResult,
  type ConversationStackV1,
  type EntityGraphV1,
  type TaskRequest,
  type TaskRunResult
} from "./types";
import { throwIfAborted } from "./runtimeAbort";
import {
  JudgmentPatternStore
} from "./judgmentPatterns";
import {
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
import { resolveStage685PlaybookPlanningContext } from "./stage6_85/playbookRuntime";
import { FederatedHttpClient } from "../interfaces/federatedClient";
import {
  type FederatedOutboundRuntimeConfigResolver,
  type RunTaskOptions,
  type Stage685PlaybookPlanningContextResolver
} from "./orchestration/contracts";
import {
  deriveFailureTaxonomyFromRun
} from "./orchestration/orchestratorReceipts";
import { executeLocalOrchestratorTask } from "./orchestration/orchestratorExecution";
import {
  buildProfileAwareInput,
  loadPlannerLearningContext,
  planOrchestratorAttempt
} from "./orchestration/orchestratorPlanning";
import {
  buildGovernanceReplanInput,
  extractGovernanceReplanFeedback
} from "./orchestration/orchestratorGovernance";
import { persistLearningSignals } from "./orchestration/orchestratorLearning";
import {
  diffUsageSnapshot,
  readModelUsageSnapshot as readModelUsageSnapshotFromClient
} from "./taskRunnerSupport";

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
        relevantEpisodes: [],
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
        relevantEpisodes: [],
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
   * Queries bounded unresolved episodic memory linked to current continuity state.
   *
   * **Why it exists:**
   * Keeps interface/runtime recall consumers behind the orchestrator boundary instead of reaching
   * directly into encrypted profile-memory storage.
   *
   * **What it talks to:**
   * - Uses `ProfileMemoryStore.queryEpisodesForContinuity(...)` from `./profileMemoryStore`.
   *
   * @param graph - Current Stage 6.86 entity graph.
   * @param stack - Current Stage 6.86 conversation stack.
   * @param entityHints - Re-mentioned entity/topic hints from the active conversation turn.
   * @param maxEpisodes - Maximum number of bounded episode matches to return.
   * @returns Continuity-linked episodic-memory matches, or an empty list when unavailable.
   */
  async queryContinuityEpisodes(
    graph: EntityGraphV1,
    stack: ConversationStackV1,
    entityHints: readonly string[],
    maxEpisodes = 3
  ) {
    if (!this.profileMemoryStore) {
      return [];
    }

    try {
      return await this.profileMemoryStore.queryEpisodesForContinuity(graph, stack, {
        entityHints,
        maxEpisodes
      });
    } catch {
      return [];
    }
  }

  /**
   * Queries bounded profile facts linked to the current continuity/entity hints.
   *
   * @param graph - Current Stage 6.86 entity graph.
   * @param stack - Current Stage 6.86 conversation stack.
   * @param entityHints - Re-mentioned entity/topic hints from the active conversation turn.
   * @param maxFacts - Maximum number of bounded fact matches to return.
   * @returns Continuity-linked readable profile facts, or an empty list when unavailable.
   */
  async queryContinuityFacts(
    graph: EntityGraphV1,
    stack: ConversationStackV1,
    entityHints: readonly string[],
    maxFacts = 3
  ) {
    if (!this.profileMemoryStore) {
      return [];
    }

    try {
      return await this.profileMemoryStore.queryFactsForContinuity(graph, stack, {
        entityHints,
        maxFacts
      });
    } catch {
      return [];
    }
  }

  /**
   * Returns bounded remembered situations for explicit user review flows.
   *
   * @param reviewTaskId - Synthetic task id for audit linkage.
   * @param query - User-facing review command text.
   * @param nowIso - Timestamp applied to ranking/audit.
   * @param maxEpisodes - Maximum number of situations to surface.
   * @returns Bounded remembered situations, or an empty list when unavailable.
   */
  async reviewRememberedSituations(
    reviewTaskId: string,
    query: string,
    nowIso: string,
    maxEpisodes = 5
  ) {
    try {
      return await this.memoryBroker.reviewRememberedSituations(
        reviewTaskId,
        query,
        nowIso,
        maxEpisodes
      );
    } catch {
      return [];
    }
  }

  /**
   * Marks one remembered situation resolved via an explicit user command.
   *
   * @param episodeId - Episode identifier targeted by the user.
   * @param sourceTaskId - Synthetic task id for mutation provenance.
   * @param sourceText - User command text that triggered the mutation.
   * @param nowIso - Timestamp applied to the mutation.
   * @param note - Optional bounded outcome note.
   * @returns Updated remembered situation, or `null` when unavailable.
   */
  async resolveRememberedSituation(
    episodeId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string,
    note?: string
  ) {
    try {
      return await this.memoryBroker.resolveRememberedSituation(
        episodeId,
        sourceTaskId,
        sourceText,
        nowIso,
        note
      );
    } catch {
      return null;
    }
  }

  /**
   * Marks one remembered situation wrong/no longer relevant via an explicit user command.
   *
   * @param episodeId - Episode identifier targeted by the user.
   * @param sourceTaskId - Synthetic task id for mutation provenance.
   * @param sourceText - User command text that triggered the mutation.
   * @param nowIso - Timestamp applied to the mutation.
   * @param note - Optional bounded correction note.
   * @returns Updated remembered situation, or `null` when unavailable.
   */
  async markRememberedSituationWrong(
    episodeId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string,
    note?: string
  ) {
    try {
      return await this.memoryBroker.markRememberedSituationWrong(
        episodeId,
        sourceTaskId,
        sourceText,
        nowIso,
        note
      );
    } catch {
      return null;
    }
  }

  /**
   * Forgets one remembered situation via an explicit user command.
   *
   * @param episodeId - Episode identifier targeted by the user.
   * @param nowIso - Timestamp applied to the mutation.
   * @returns Removed remembered situation, or `null` when unavailable.
   */
  async forgetRememberedSituation(
    episodeId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string
  ) {
    try {
      return await this.memoryBroker.forgetRememberedSituation(
        episodeId,
        sourceTaskId,
        sourceText,
        nowIso
      );
    } catch {
      return null;
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
   * - `executeLocalOrchestratorTask` for retry/postmortem-aware local execution flow.
   * - Durability/learning sinks (`StateStore`, `PersonalityStore`, `ReflectionOrgan`).
   * - Runtime tracing via `appendTraceEvent`.
   *
   * @param task - Incoming task request from CLI/interface runtime.
   * @param options - Optional cancellation signal propagated from caller/runtime surface.
   * @returns Promise resolving to TaskRunResult.
   */
  async runTask(task: TaskRequest, options: RunTaskOptions = {}): Promise<TaskRunResult> {
    throwIfAborted(options.signal);
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
    const profileAwareInput = await buildProfileAwareInput(
      {
        memoryBroker: this.memoryBroker
      },
      task
    );
    const profileMemoryStatus = profileAwareInput.profileMemoryStatus;
    const profileAwareUserInput = profileAwareInput.userInput;
    const plannerLearningContext = await loadPlannerLearningContext(
      {
        workflowLearningStore: this.workflowLearningStore,
        judgmentPatternStore: this.judgmentPatternStore
      },
      profileAwareUserInput
    );
    const plannerModel = selectModelForRole("planner", this.config);
    const synthesizerModel = selectModelForRole("synthesizer", this.config);
    const runResult = await executeLocalOrchestratorTask({
      appendTraceEvent: this.appendTraceEvent.bind(this),
      buildReplanInput: buildGovernanceReplanInput,
      config: this.config,
      extractGovernanceReplanFeedback,
      planForAttempt: (attemptUserInput, attemptNumber) =>
        planOrchestratorAttempt({
          appendTraceEvent: this.appendTraceEvent.bind(this),
          maxActionsPerTask: this.config.limits.maxActionsPerTask,
          planner: this.planner,
          plannerLearningContext,
          plannerModel,
          resolvePlaybookPlanningContext: this.resolvePlaybookPlanningContext,
          synthesizerModel,
          task,
          attemptNumber,
          userInput: attemptUserInput
        }),
      profileAwareUserInput,
      profileMemoryStatus,
      readModelUsageSnapshot: this.readModelUsageSnapshot.bind(this),
      signal: options.signal,
      startedAtIso,
      startedAtMs,
      state,
      task,
      taskRunner: this.taskRunner,
      usageStart
    });

    await this.stateStore.appendRun(runResult);
    await persistLearningSignals(
      {
        workflowLearningStore: this.workflowLearningStore,
        judgmentPatternStore: this.judgmentPatternStore
      },
      runResult
    );

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
      executionStatus: approved ? "success" : "failed",
      executionFailureCode: approved ? undefined : "ACTION_EXECUTION_FAILED",
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
    await persistLearningSignals(
      {
        workflowLearningStore: this.workflowLearningStore,
        judgmentPatternStore: this.judgmentPatternStore
      },
      runResult
    );

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
    return readModelUsageSnapshotFromClient(this.modelClient);
  }
}
