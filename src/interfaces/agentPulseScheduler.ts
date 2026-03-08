/**
 * @fileoverview Runs deterministic Agent Pulse evaluations for opted-in interface sessions and enqueues governed proactive check-ins.
 */

import {
  type AgentPulseSchedulerConfig,
  type AgentPulseSchedulerDeps,
  type AgentPulseStateUpdate,
  DEFAULT_AGENT_PULSE_SCHEDULER_CONFIG
} from "./conversationRuntime/pulseSchedulerContracts";
import { evaluatePulseForUser } from "./conversationRuntime/pulseEvaluation";
import {
  type ConversationSession
} from "./sessionStore";
import {
  conversationBelongsToProvider,
  shouldSkipSessionForPulse,
  sortByMostRecentSessionUpdate
} from "./conversationRuntime/pulseScheduling";

export type {
  AgentPulseSchedulerConfig,
  AgentPulseSchedulerDeps,
  AgentPulseStateUpdate
} from "./conversationRuntime/pulseSchedulerContracts";
export class AgentPulseScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private tickInFlight = false;

  /**
   * Initializes `AgentPulseScheduler` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Stores injected scheduler collaborators (session store, pulse evaluator, enqueue/update callbacks).
   *
   * @param deps - Runtime dependencies for pulse evaluation and state persistence.
   * @param config - Configuration or policy values that shape deterministic behavior.
   */
  constructor(
    private readonly deps: AgentPulseSchedulerDeps,
    private readonly config: AgentPulseSchedulerConfig = DEFAULT_AGENT_PULSE_SCHEDULER_CONFIG
  ) { }

  /**
   * Starts input within this module's managed runtime lifecycle.
   *
   * **Why it exists:**
   * Keeps startup sequencing for input explicit and deterministic.
   *
   * **What it talks to:**
   * - Uses `setInterval` and `runTickOnce` to drive periodic evaluation.
   */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.timer = setInterval(() => {
      void this.runTickOnce();
    }, this.config.tickIntervalMs);
    void this.runTickOnce();
  }

  /**
   * Stops or clears input to keep runtime state consistent.
   *
   * **Why it exists:**
   * Centralizes teardown/reset behavior for input so lifecycle handling stays predictable.
   *
   * **What it talks to:**
   * - Uses `clearInterval` to stop scheduled tick execution.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Executes tick once as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the tick once runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses session listing/filtering helpers and `evaluateUser` for per-user decisions.
   * @returns Promise resolving to void.
   */
  async runTickOnce(): Promise<void> {
    if (this.tickInFlight) {
      return;
    }
    this.tickInFlight = true;

    try {
      const nowIso = new Date().toISOString();
      const sessions = await this.deps.sessionStore.listSessions();
      const providerSessions = sessions.filter((session) =>
        conversationBelongsToProvider(session.conversationId, this.deps.provider)
      );
      const users = new Set(providerSessions.map((session) => session.userId));
      for (const userId of users) {
        const userSessions = sortByMostRecentSessionUpdate(
          providerSessions.filter((session) => session.userId === userId)
        );
        const controllerSession = userSessions.find((candidate) => candidate.agentPulse.optIn);
        if (!controllerSession) {
          continue;
        }
        if (shouldSkipSessionForPulse(controllerSession)) {
          continue;
        }

        await this.evaluateUser(controllerSession, userSessions, nowIso);
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  /**
   * Executes pulse state to user sessions as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the pulse state to user sessions runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses `ConversationSession` (import `ConversationSession`) from `./sessionStore`.
   *
   * @param userSessions - Sessions that should receive synchronized pulse-state updates.
   * @param update - Pulse-state patch persisted to each session.
   * @returns Promise resolving to void.
   */
  private async applyPulseStateToUserSessions(
    userSessions: ConversationSession[],
    update: AgentPulseStateUpdate
  ): Promise<void> {
    for (const session of userSessions) {
      await this.deps.updatePulseState(session.conversationId, update);
    }
  }

  /**
   * Evaluates a user for pulse emission, delegating to the dynamic candidate
   * engine when enabled or falling back to the legacy counter-based path.
   */
  private async evaluateUser(
    controllerSession: ConversationSession,
    userSessions: ConversationSession[],
    nowIso: string
  ): Promise<void> {
    await evaluatePulseForUser({
      controllerSession,
      userSessions,
      nowIso,
      deps: this.deps,
      config: this.config,
      applyPulseStateToUserSessions: async (sessions, update) =>
        this.applyPulseStateToUserSessions(sessions, update)
    });
  }
}

