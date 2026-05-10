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
import { selectLatestPulseControlSession } from "./agentPulseSchedulerSelection";
import {
  buildPulseAuthorityRequestId,
  buildPulseDecisionRecord,
  evaluatePulseAuthorityGateway
} from "./proactiveRuntime/pulseAuthorityGateway";

export type {
  AgentPulseSchedulerConfig,
  AgentPulseSchedulerDeps,
  AgentPulseStateUpdate
} from "./conversationRuntime/pulseSchedulerContracts";
export class AgentPulseScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private tickInFlight = false;
  private readonly config: AgentPulseSchedulerConfig;

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
    config: AgentPulseSchedulerConfig = DEFAULT_AGENT_PULSE_SCHEDULER_CONFIG
  ) {
    this.config = {
      ...config,
      tickIntervalMs:
        config.allowFastTickIntervalForTests === true
          ? config.tickIntervalMs
          : Math.max(60_000, config.tickIntervalMs)
    };
  }

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
    if (this.config.runOnStartup === true) {
      void this.runTickOnce("startup");
    }
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
  async runTickOnce(trigger: "interval" | "startup" | "manual_tick" = "manual_tick"): Promise<void> {
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
        const latestControlSession = selectLatestPulseControlSession(userSessions);
        if (latestControlSession && !latestControlSession.agentPulse.optIn) {
          await this.recordSchedulerSuppression(
            latestControlSession,
            userSessions,
            nowIso,
            trigger,
            "OPT_OUT",
            "user.global_opt_out"
          );
          continue;
        }
        const controllerSession = userSessions.find((candidate) => candidate.agentPulse.optIn);
        if (!controllerSession) {
          continue;
        }
        if (userSessions.some((session) => Boolean(session.runningJobId) || session.queuedJobs.length > 0)) {
          await this.recordSchedulerSuppression(
            controllerSession,
            userSessions,
            nowIso,
            trigger,
            "SKIPPED_ACTIVE_WORK",
            "policy.user_active_or_queued_mission"
          );
          continue;
        }
        if (shouldSkipSessionForPulse(controllerSession)) {
          await this.recordSchedulerSuppression(
            controllerSession,
            userSessions,
            nowIso,
            trigger,
            "RATE_LIMIT",
            "policy.pulse_gap"
          );
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

  /**
   * Records scheduler-level suppression through the same authority-decision ledger as emitted
   * pulses so skipped work is auditable without creating user-visible outreach.
   */
  private async recordSchedulerSuppression(
    controllerSession: ConversationSession,
    userSessions: ConversationSession[],
    nowIso: string,
    trigger: "interval" | "startup" | "manual_tick",
    decisionCode: "SKIPPED_ACTIVE_WORK" | "RATE_LIMIT" | "OPT_OUT",
    suppressedBy: string
  ): Promise<void> {
    const requestId = buildPulseAuthorityRequestId({
      userId: controllerSession.userId,
      controllerSessionId: controllerSession.conversationId,
      targetSessionId: null,
      reasonCode: "scheduler_skip",
      candidateId: null,
      trigger,
      nowIso
    });
    const decision = evaluatePulseAuthorityGateway({
      requestId,
      userId: controllerSession.userId,
      controllerSessionId: controllerSession.conversationId,
      targetSessionId: null,
      targetVisibility: "unknown",
      reasonCode: "scheduler_skip",
      candidateId: null,
      trigger,
      nowIso,
      baseDecision: {
        allowed: false,
        decisionCode,
        suppressedBy: [suppressedBy],
        nextEligibleAtIso: null
      },
      policyContext: {
        targetSessionVisibility: "unknown",
        userHasActiveMission: decisionCode === "SKIPPED_ACTIVE_WORK",
        userHasQueuedMission: decisionCode === "SKIPPED_ACTIVE_WORK",
        routeIsPublicSafe: false,
        sourceEvidencePublicSafe: false,
        timezoneSource: controllerSession.agentPulse.userTimezone ? "explicit_user_setting" : "unknown"
      },
      evidence: {
        evidenceRefs: [],
        sourceRecallRefs: [],
        sourceRecallStatus: "not_used",
        sourceRecallUsable: false,
        containsPrivateMemoryEvidence: false,
        containsRelationshipEvidence: false,
        containsIdentityEvidence: false
      }
    });
    const decisionRecord = buildPulseDecisionRecord({
      request: {
        requestId,
        userId: controllerSession.userId,
        controllerSessionId: controllerSession.conversationId,
        targetSessionId: null,
        targetVisibility: "unknown",
        reasonCode: "scheduler_skip",
        candidateId: null,
        trigger,
        nowIso,
        policyContext: {
          targetSessionVisibility: "unknown",
          userHasActiveMission: decisionCode === "SKIPPED_ACTIVE_WORK",
          userHasQueuedMission: decisionCode === "SKIPPED_ACTIVE_WORK",
          routeIsPublicSafe: false,
          sourceEvidencePublicSafe: false,
          timezoneSource: controllerSession.agentPulse.userTimezone ? "explicit_user_setting" : "unknown"
        },
        evidence: {
          evidenceRefs: [],
          sourceRecallRefs: [],
          sourceRecallStatus: "not_used",
          sourceRecallUsable: false,
          containsPrivateMemoryEvidence: false,
          containsRelationshipEvidence: false,
          containsIdentityEvidence: false
        }
      },
      decision,
      candidateProposed: false,
      decisionStatus: "skipped"
    });
    for (const session of userSessions) {
      await this.deps.updatePulseState(session.conversationId, {
        lastDecisionCode: decision.decisionCode,
        lastEvaluatedAt: nowIso,
        decisionRecord,
        updatedAt: nowIso
      });
    }
  }
}

