/**
 * @fileoverview Caches backend/profile-specific brains for interface sessions while sharing one live-run core.
 */

import { makeId } from "../core/ids";
import {
  buildBrainRuntimeFromEnvironment,
  createSharedBrainRuntimeDependencies,
  type BuiltBrainRuntime,
  type SharedBrainRuntimeDependencies
} from "../core/buildBrain";
import { MAIN_AGENT_ID } from "../core/agentIdentity";
import type { TaskRequest } from "../core/types";
import {
  buildConversationModelEnvironment,
  resolveConversationModelSelection
} from "./conversationRuntime/modelBackendSelection";
import type { ConversationRecoveryTrace, ConversationSession } from "./sessionStore";
import type { ConversationExecutionProgressUpdate, ConversationExecutionResult } from "./conversationRuntime/managerContracts";
import { runDirectConversationReplyWithRuntime } from "./conversationRuntime/directConversationReply";
import { AutonomousLoop } from "../core/agentLoop";
import { createModelClientFromEnv } from "../models/createModelClient";
import {
  buildAutonomousGoalAbortedProgressMessage,
  buildAutonomousGoalMetProgressMessage,
  buildAutonomousIterationProgressMessage,
  buildAutonomousTerminalSummaryMessage,
  humanizeAutonomousStopReason
} from "./userFacing/stopSummarySurface";
import { buildAutonomousConversationExecutionResult } from "./autonomousConversationExecutionResult";
import type { TaskRunResult } from "../core/types";

interface CachedInterfaceBrainRuntime {
  readonly cacheKey: string;
  readonly runtime: BuiltBrainRuntime;
}

/**
 * Builds deterministic task envelopes for interface-owned governed work.
 *
 * @param input - User input for the governed task.
 * @param receivedAt - Timestamp used for deterministic metadata.
 * @returns Task request ready for orchestrator execution.
 */
function buildInterfaceTaskRequest(input: string, receivedAt: string): TaskRequest {
  return {
    id: makeId("task"),
    agentId: MAIN_AGENT_ID,
    goal: "Handle user request safely and efficiently.",
    userInput: input.trim(),
    createdAt: receivedAt
  };
}

export class InterfaceBrainRegistry {
  private readonly shared: SharedBrainRuntimeDependencies;
  private readonly runtimes = new Map<string, CachedInterfaceBrainRuntime>();

  /**
   * Creates the shared runtime/cache coordinator used by interface session backends.
   *
   * @param baseEnv - Base process environment used for backend/profile overrides.
   * @param shared - Optional shared runtime dependencies for tests or explicit reuse.
   */
  constructor(
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
    shared?: SharedBrainRuntimeDependencies
  ) {
    this.shared = shared ?? createSharedBrainRuntimeDependencies(baseEnv);
  }

  /**
   * Resolves or creates the backend/profile-specific runtime for one session.
   *
   * @param session - Session carrying optional backend/profile override metadata.
   * @returns Cached runtime plus the exact environment used to construct it.
   */
  getRuntimeForSession(
    session: Pick<ConversationSession, "modelBackendOverride" | "codexAuthProfileId"> | null | undefined
  ): {
    env: NodeJS.ProcessEnv;
    runtime: BuiltBrainRuntime;
  } {
    const selection = resolveConversationModelSelection(session, this.baseEnv);
    const cacheKey = `${selection.backend}::${selection.codexProfileId ?? "none"}`;
    const cached = this.runtimes.get(cacheKey);
    if (cached) {
      return {
        env: buildConversationModelEnvironment(session, this.baseEnv),
        runtime: cached.runtime
      };
    }

    const env = buildConversationModelEnvironment(session, this.baseEnv);
    const runtime = buildBrainRuntimeFromEnvironment(this.shared, env);
    this.runtimes.set(cacheKey, {
      cacheKey,
      runtime
    });
    return { env, runtime };
  }

  /**
   * Runs one governed task using the session-selected backend/profile runtime.
   *
   * @param session - Session carrying optional backend/profile override metadata.
   * @param input - User input to execute.
   * @param receivedAt - Timestamp used for task metadata.
   * @returns Governed conversation execution result.
   */
  async runTaskForSession(
    session: Pick<
      ConversationSession,
      "modelBackendOverride" | "codexAuthProfileId" | "domainContext"
    > | null | undefined,
    input: string,
    receivedAt: string
  ): Promise<ConversationExecutionResult> {
    const { runtime } = this.getRuntimeForSession(session);
    const runResult = await runtime.brain.runTask(buildInterfaceTaskRequest(input, receivedAt), {
      conversationDomainContext: session?.domainContext ?? null
    });
    return {
      summary: runResult.summary,
      taskRunResult: runResult
    };
  }

  /**
   * Runs one direct conversational turn using the session-selected backend/profile runtime.
   *
   * @param session - Session carrying optional backend/profile override metadata.
   * @param input - Conversation text to answer directly.
   * @param receivedAt - Timestamp used for deterministic reply metadata.
   * @returns Direct conversation summary payload.
   */
  async runDirectConversationForSession(
    session: Pick<ConversationSession, "modelBackendOverride" | "codexAuthProfileId"> | null | undefined,
    input: string,
    receivedAt: string
  ): Promise<ConversationExecutionResult> {
    const env = buildConversationModelEnvironment(session, this.baseEnv);
    const modelClient = createModelClientFromEnv(env);
    return {
      summary: await runDirectConversationReplyWithRuntime(
        input,
        receivedAt,
        this.shared.baseConfig,
        modelClient
      ),
      taskRunResult: null
    };
  }

  /**
   * Runs the autonomous loop using the session-selected backend/profile runtime.
   *
   * @param session - Session carrying optional backend/profile override metadata.
   * @param goal - Autonomous goal to pursue.
   * @param receivedAt - Timestamp used for deterministic startup messages.
   * @param onProgress - Progress callback used by transport delivery.
   * @param signal - Optional external cancellation signal.
   * @param initialExecutionInput - Optional richer first-step prompt.
   * @param onProgressUpdate - Optional structured progress callback.
   * @returns Autonomous conversation execution result.
   */
  async runAutonomousTaskForSession(
    session: Pick<ConversationSession, "modelBackendOverride" | "codexAuthProfileId"> | null | undefined,
    goal: string,
    receivedAt: string,
    onProgress: (message: string) => Promise<void>,
    signal?: AbortSignal,
    initialExecutionInput?: string | null,
    onProgressUpdate?: (update: ConversationExecutionProgressUpdate) => Promise<void>
  ): Promise<ConversationExecutionResult> {
    const { runtime } = this.getRuntimeForSession(session);
    const loop = new AutonomousLoop(runtime.brain, runtime.modelClient, runtime.config);

    let totalIterations = 0;
    let totalApproved = 0;
    let totalBlocked = 0;
    let terminalAborted = false;
    let terminalReason = "";
    let lastProgressMessageAt = 0;
    const throttleMs = 30_000;
    let latestTaskRunResult: TaskRunResult | null = null;
    const aggregatedActionResults: TaskRunResult["actionResults"] = [];
    let firstTaskStartedAt: string | null = null;
    let latestTaskCompletedAt: string | null = null;
    let terminalProgressStateEmitted = false;
    let terminalProgressMessageEmitted = false;
    let latestRecoveryTrace: ConversationRecoveryTrace | null = null;
    const buildTerminalRecoveryTrace = (
      status: "recovered" | "failed"
    ): ConversationRecoveryTrace | null =>
      latestRecoveryTrace
        ? {
            ...latestRecoveryTrace,
            status,
            updatedAt: new Date().toISOString()
          }
        : null;

    const shouldSendProgress = (iteration: number, approved: number): boolean => {
      if (iteration === 1 || approved > 0) {
        return true;
      }
      return Date.now() - lastProgressMessageAt >= throttleMs;
    };

    try {
      await loop.run(
        goal,
        {
          onStateChange: async (update) => {
            const updatedAt = new Date().toISOString();
            if (update.recoveryKind) {
              latestRecoveryTrace = {
                kind: update.recoveryKind,
                status: "attempting",
                summary: update.message,
                updatedAt,
                recoveryClass: update.recoveryClass ?? null,
                fingerprint: update.recoveryFingerprint ?? null
              };
            }
            await onProgressUpdate?.({
              status: update.state,
              message: update.message,
              recoveryTrace: latestRecoveryTrace
            });
            if (update.state === "completed" || update.state === "stopped") {
              terminalProgressStateEmitted = true;
            }
          },
          onIterationStart: async (iteration, input) => {
            totalIterations = iteration;
            if (iteration === 1) {
              const preview = input.length > 150 ? input.slice(0, 150) + "..." : input;
              await onProgress(`Autonomous task started: ${preview}`);
              lastProgressMessageAt = Date.now();
            }
          },
          onIterationComplete: async (iteration, _summary, approved, blocked, result) => {
            totalIterations = iteration;
            totalApproved += approved;
            totalBlocked += blocked;
            latestTaskRunResult = result;
            aggregatedActionResults.push(...result.actionResults);
            firstTaskStartedAt ??= result.startedAt;
            latestTaskCompletedAt = result.completedAt;
            if (shouldSendProgress(iteration, approved)) {
              await onProgress(
                buildAutonomousIterationProgressMessage(
                  iteration,
                  approved,
                  blocked,
                  totalApproved,
                  totalBlocked
                )
              );
              lastProgressMessageAt = Date.now();
            }
          },
          onGoalMet: async (reasoning) => {
            if (!terminalProgressStateEmitted) {
              await onProgressUpdate?.({
                status: "completed",
                message: reasoning,
                recoveryTrace: buildTerminalRecoveryTrace("recovered")
              });
              terminalProgressStateEmitted = true;
            }
            await onProgress(
              buildAutonomousGoalMetProgressMessage(
                totalIterations,
                totalApproved,
                totalBlocked,
                reasoning
              )
            );
            terminalProgressMessageEmitted = true;
          },
          onGoalAborted: async (reason) => {
            terminalAborted = true;
            terminalReason = reason;
            if (!terminalProgressStateEmitted) {
              await onProgressUpdate?.({
                status: "stopped",
                message: humanizeAutonomousStopReason(reason),
                recoveryTrace: buildTerminalRecoveryTrace("failed")
              });
              terminalProgressStateEmitted = true;
            }
            await onProgress(
              buildAutonomousGoalAbortedProgressMessage(
                totalIterations,
                totalApproved,
                totalBlocked,
                reason
              )
            );
            terminalProgressMessageEmitted = true;
          }
        },
        signal,
        undefined,
        initialExecutionInput ?? null
      );
    } catch (error) {
      if (!terminalAborted) {
        terminalAborted = true;
        terminalReason =
          `[reasonCode=AUTONOMOUS_LOOP_RUNTIME_ERROR] Autonomous loop runtime failure: ${
            (error as Error).message || "Unknown runtime error."
          }`;
      }
    }

    if (terminalAborted) {
      if (!terminalProgressStateEmitted) {
        await onProgressUpdate?.({
          status: "stopped",
          message: humanizeAutonomousStopReason(terminalReason),
          recoveryTrace: buildTerminalRecoveryTrace("failed")
        });
      }
      if (!terminalProgressMessageEmitted) {
        await onProgress(
          buildAutonomousGoalAbortedProgressMessage(
            totalIterations,
            totalApproved,
            totalBlocked,
            terminalReason
          )
        );
      }
    }

    return buildAutonomousConversationExecutionResult(
      buildAutonomousTerminalSummaryMessage(
        !terminalAborted,
        totalIterations,
        totalApproved,
        totalBlocked,
        terminalReason
      ),
      latestTaskRunResult,
      aggregatedActionResults,
      firstTaskStartedAt,
      latestTaskCompletedAt
    );
  }
}
