/**
 * @fileoverview Coordinates planning, constraint checks, governance voting, execution, and state persistence.
 */

import { BrainConfig } from "./config";
import { selectModelForRole } from "./modelRouting";
import { ExecutionReceiptStore } from "./advancedAutonomyRuntime";
import { makeId } from "./ids";
import {
  createFederatedOutboundRuntimeConfigFromEnv
} from "./federatedOutboundDelegation";
import {
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
import type { SkillRegistryStore } from "../organs/skillRegistry/skillRegistryStore";
import { StateStore } from "./stateStore";
import { PersonalityStore } from "./personalityStore";
import { GovernanceMemoryStore } from "./governanceMemory";
import {
  ProfileMemoryStore
} from "./profileMemoryStore";
import type { ProfileMemoryIngestRequest } from "./profileMemoryRuntime/contracts";
import type { ProfileEpisodeContinuityQueryRequest } from "./profileMemoryRuntime/profileMemoryEpisodeQueries";
import {
  buildProfileMemorySourceTaskIdFromProvenance,
  normalizeProfileMemoryIngestRequest
} from "./profileMemoryRuntime/profileMemoryIngestProvenance";
import type { ProfileFactContinuityQueryRequest } from "./profileMemoryRuntime/profileMemoryQueryContracts";
import { AppendRuntimeTraceEventInput, RuntimeTraceLogger } from "./runtimeTraceLogger";
import { TaskRunner } from "./taskRunner";
import { Stage686RuntimeActionEngine } from "./stage6_86/runtimeActions";
import { resolveStage685PlaybookPlanningContext } from "./stage6_85/playbookRuntime";
import { FederatedHttpClient } from "../interfaces/federatedClient";
import {
  type FederatedOutboundRuntimeConfigResolver,
  type RunTaskOptions,
  type Stage685PlaybookPlanningContextResolver
} from "./orchestration/contracts";
import type { ManagedProcessSnapshot } from "../organs/liveRun/managedProcessRegistry";
import type { BrowserSessionSnapshot } from "../organs/liveRun/browserSessionRegistry";
import { executeLocalOrchestratorTask } from "./orchestration/orchestratorExecution";
import {
  correctRememberedFact as correctRememberedFactFromRuntime,
  evaluateOrchestratorAgentPulse,
  forgetRememberedSituation as forgetRememberedSituationFromRuntime,
  forgetRememberedFact as forgetRememberedFactFromRuntime,
  interpretOrchestratorConversationIntent,
  markRememberedSituationWrong as markRememberedSituationWrongFromRuntime,
  queryOrchestratorContinuityEpisodes,
  queryOrchestratorContinuityFacts,
  reviewRememberedFacts as reviewRememberedFactsFromRuntime,
  resolveRememberedSituation as resolveRememberedSituationFromRuntime,
  reviewRememberedSituations as reviewRememberedSituationsFromRuntime
} from "./orchestration/orchestratorContinuation";
import { openOrchestratorContinuityReadSession } from "./orchestration/orchestratorContinuityReadSession";
import { maybeRunOutboundFederatedTask } from "./orchestration/orchestratorFederation";
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
  readModelUsageSnapshot as readModelUsageSnapshotFromClient
} from "./taskRunnerSupport";
import { createBridgeQuestionTimingInterpretationResolverFromEnv } from "../organs/languageUnderstanding/localIntentModelRuntime";
import type { BridgeQuestionTimingInterpretationResolver } from "../organs/languageUnderstanding/localIntentModelContracts";

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
   * @param skillRegistryStore - Optional skill inventory used for workflow-to-skill bridge guidance.
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
    private readonly judgmentPatternStore?: JudgmentPatternStore,
    private readonly skillRegistryStore?: Pick<
      SkillRegistryStore,
      "listAvailableSkills" | "listApplicableGuidance"
    >,
    private readonly bridgeQuestionTimingInterpretationResolver: BridgeQuestionTimingInterpretationResolver | undefined =
      createBridgeQuestionTimingInterpretationResolverFromEnv(),
    private readonly stage686RuntimeActionEngine?: Stage686RuntimeActionEngine
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
      appendTraceEvent: this.appendTraceEvent.bind(this),
      stage686RuntimeActionEngine: this.stage686RuntimeActionEngine ?? new Stage686RuntimeActionEngine({
        backend: this.config.persistence.ledgerBackend,
        sqlitePath: this.config.persistence.ledgerSqlitePath,
        exportJsonOnWrite: this.config.persistence.exportJsonOnWrite,
        bridgeQuestionTimingInterpretationResolver: this.bridgeQuestionTimingInterpretationResolver
      })
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
  async evaluateAgentPulse(request: Parameters<typeof evaluateOrchestratorAgentPulse>[1]) {
    return evaluateOrchestratorAgentPulse(
      {
        config: this.config,
        profileMemoryStore: this.profileMemoryStore
      },
      request
    );
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
    return interpretOrchestratorConversationIntent(
      {
        config: this.config,
        intentInterpreter: this.intentInterpreter
      },
      text,
      recentTurns,
      pulseRuleContext
    );
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
    maxEpisodes = 3,
    requestOptions: Omit<ProfileEpisodeContinuityQueryRequest, "entityHints" | "maxEpisodes"> = {}
  ) {
    return queryOrchestratorContinuityEpisodes(
      { profileMemoryStore: this.profileMemoryStore },
      graph,
      stack,
      entityHints,
      maxEpisodes,
      requestOptions
    );
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
    maxFacts = 3,
    requestOptions: Omit<ProfileFactContinuityQueryRequest, "entityHints" | "maxFacts"> = {}
  ) {
    return queryOrchestratorContinuityFacts(
      { profileMemoryStore: this.profileMemoryStore },
      graph,
      stack,
      entityHints,
      maxFacts,
      requestOptions
    );
  }

  /** Opens one bounded continuity read session over the current profile-memory snapshot. */
  async openContinuityReadSession(graph: EntityGraphV1) {
    return openOrchestratorContinuityReadSession({ profileMemoryStore: this.profileMemoryStore }, graph);
  }

  /**
   * Persists bounded direct-conversation profile memory through the canonical store seam.
   *
   * @param input - Raw direct conversational user wording or validated fact candidates.
   * @param receivedAt - Observation timestamp for the turn.
   * @returns `true` when profile memory accepted at least one canonical fact or episode update.
   */
  async rememberConversationProfileInput(
    input: string | ProfileMemoryIngestRequest,
    receivedAt: string
  ): Promise<boolean> {
    if (!this.profileMemoryStore) {
      return false;
    }
    const request = normalizeProfileMemoryIngestRequest(typeof input === "string"
      ? { userInput: input }
      : input);
    const sourceTaskId =
      buildProfileMemorySourceTaskIdFromProvenance(request.provenance) ?? makeId("task");
    const result = await this.profileMemoryStore.ingestFromTaskInput(
      sourceTaskId,
      request.userInput ?? "",
      receivedAt,
      {
        validatedFactCandidates: request.validatedFactCandidates,
        additionalEpisodeCandidates: request.additionalEpisodeCandidates,
        mediaIngest: request.mediaIngest,
        provenance: request.provenance,
        ingestPolicy: request.ingestPolicy
      }
    );
    return result.appliedFacts > 0;
  }

  /** Lists best-effort live managed process snapshots from the executor registry. */
  listManagedProcessSnapshots(): readonly ManagedProcessSnapshot[] { return this.executor.listManagedProcessSnapshots(); }

  /** Lists best-effort live browser session snapshots from the executor registry. */
  listBrowserSessionSnapshots(): readonly BrowserSessionSnapshot[] { return this.executor.listBrowserSessionSnapshots(); }

  /** Reviews bounded remembered situations through the broker-owned review seam. */
  async reviewRememberedSituations(reviewTaskId: string, query: string, nowIso: string, maxEpisodes = 5) {
    return reviewRememberedSituationsFromRuntime(
      {
        memoryBroker: this.memoryBroker
      },
      reviewTaskId,
      query,
      nowIso,
      maxEpisodes
    );
  }

  /** Reviews bounded remembered facts through the broker-owned review seam. */
  async reviewRememberedFacts(reviewTaskId: string, query: string, nowIso: string, maxFacts = 5) {
    return reviewRememberedFactsFromRuntime(
      {
        memoryBroker: this.memoryBroker
      },
      reviewTaskId,
      query,
      nowIso,
      maxFacts
    );
  }

  /** Marks one remembered situation resolved through the broker-owned review seam. */
  async resolveRememberedSituation(
    episodeId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string,
    note?: string
  ) {
    return resolveRememberedSituationFromRuntime(
      {
        memoryBroker: this.memoryBroker
      },
      episodeId,
      sourceTaskId,
      sourceText,
      nowIso,
      note
    );
  }

  /** Marks one remembered situation wrong through the broker-owned review seam. */
  async markRememberedSituationWrong(
    episodeId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string,
    note?: string
  ) {
    return markRememberedSituationWrongFromRuntime(
      {
        memoryBroker: this.memoryBroker
      },
      episodeId,
      sourceTaskId,
      sourceText,
      nowIso,
      note
    );
  }

  /** Forgets one remembered situation through the broker-owned review seam. */
  async forgetRememberedSituation(
    episodeId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string
  ) {
    return forgetRememberedSituationFromRuntime(
      {
        memoryBroker: this.memoryBroker
      },
      episodeId,
      sourceTaskId,
      sourceText,
      nowIso
    );
  }

  /** Corrects one remembered fact through the broker-owned review seam. */
  async correctRememberedFact(
    factId: string,
    replacementValue: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string,
    note?: string
  ) {
    return correctRememberedFactFromRuntime(
      {
        memoryBroker: this.memoryBroker
      },
      factId,
      replacementValue,
      sourceTaskId,
      sourceText,
      nowIso,
      note
    );
  }

  /** Forgets one remembered fact through the broker-owned review seam. */
  async forgetRememberedFact(
    factId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string
  ) {
    return forgetRememberedFactFromRuntime(
      {
        memoryBroker: this.memoryBroker
      },
      factId,
      sourceTaskId,
      sourceText,
      nowIso
    );
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

    const delegatedRunResult = await maybeRunOutboundFederatedTask(
      {
        appendTraceEvent: this.appendTraceEvent.bind(this),
        config: this.config,
        createFederatedClient: (input) => new FederatedHttpClient(input),
        personalityStore: this.personalityStore,
        readModelUsageSnapshot: this.readModelUsageSnapshot.bind(this),
        reflection: this.reflection,
        resolveFederatedOutboundRuntimeConfig: this.resolveFederatedOutboundRuntimeConfig,
        stateStore: this.stateStore,
        workflowLearningDeps: {
          workflowLearningStore: this.workflowLearningStore,
          judgmentPatternStore: this.judgmentPatternStore
        }
      },
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
      task,
      {
        conversationDomainContext: options.conversationDomainContext
      }
    );
    const profileMemoryStatus = profileAwareInput.profileMemoryStatus;
    const profileAwareUserInput = profileAwareInput.userInput;
    const plannerLearningContext = await loadPlannerLearningContext(
      {
        workflowLearningStore: this.workflowLearningStore,
        judgmentPatternStore: this.judgmentPatternStore,
        listAvailableSkills: this.skillRegistryStore?.listAvailableSkills.bind(this.skillRegistryStore),
        listApplicableGuidance:
          this.skillRegistryStore?.listApplicableGuidance.bind(this.skillRegistryStore)
      },
      profileAwareUserInput,
      {
        conversationDomainContext: options.conversationDomainContext
      }
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
          userInput: attemptUserInput,
          conversationDomainContext: options.conversationDomainContext
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
