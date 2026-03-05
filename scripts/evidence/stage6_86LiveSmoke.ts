/**
 * @fileoverview Runs deterministic Stage 6.86 live-smoke scenarios with time-shifted continuity checks and emits reviewer evidence.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyUserTurnToConversationStackV1,
  buildConversationStackFromTurnsV1
} from "../../src/core/stage6_86ConversationStack";
import {
  evaluateBridgeQuestionEmissionV1,
  resolveBridgeQuestionAnswerV1
} from "../../src/core/stage6_86BridgeQuestions";
import {
  resolveOpenLoopOnConversationStackV1,
  selectOpenLoopsForPulseV1,
  upsertOpenLoopOnConversationStackV1
} from "../../src/core/stage6_86OpenLoops";
import { evaluatePulseCandidatesV1 } from "../../src/core/stage6_86PulseCandidates";
import { ConversationStackV1, EntityGraphV1, PulseCandidateV1 } from "../../src/core/types";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";

const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_86_live_smoke_report.json");

interface Stage686LiveScenarioCheck {
  id: string;
  pass: boolean;
  detail: string;
}

interface Stage686LiveScenarioResult {
  id: string;
  title: string;
  pass: boolean;
  timepointsUsed: readonly string[];
  checks: readonly Stage686LiveScenarioCheck[];
}

interface Stage686LiveSmokeArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL";
  scenarios: readonly Stage686LiveScenarioResult[];
  summary: {
    totalScenarios: number;
    passedScenarios: number;
    failedScenarioIds: readonly string[];
  };
  passCriteria: {
    allScenariosPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Implements `buildBaseContinuityGraph` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildBaseContinuityGraph(
  confirmedEdgeLastObservedAt = "2025-11-01T00:00:00.000Z"
): EntityGraphV1 {
  return {
    schemaVersion: "v1",
    updatedAt: "2026-02-28T00:00:00.000Z",
    entities: [
      {
        entityKey: "entity_flare_labs",
        canonicalName: "Flare Labs",
        entityType: "org",
        disambiguator: null,
        aliases: ["Flare Labs"],
        firstSeenAt: "2025-10-01T00:00:00.000Z",
        lastSeenAt: "2026-02-20T00:00:00.000Z",
        salience: 6,
        evidenceRefs: ["trace:entity_flare_labs"]
      },
      {
        entityKey: "entity_project_aurora",
        canonicalName: "Project Aurora",
        entityType: "concept",
        disambiguator: null,
        aliases: ["Project Aurora"],
        firstSeenAt: "2025-10-01T00:00:00.000Z",
        lastSeenAt: "2026-02-20T00:00:00.000Z",
        salience: 5,
        evidenceRefs: ["trace:entity_project_aurora"]
      },
      {
        entityKey: "entity_release_runbook",
        canonicalName: "Release Runbook",
        entityType: "thing",
        disambiguator: null,
        aliases: ["Release Runbook"],
        firstSeenAt: "2025-10-01T00:00:00.000Z",
        lastSeenAt: "2025-11-01T00:00:00.000Z",
        salience: 3,
        evidenceRefs: ["trace:entity_release_runbook"]
      }
    ],
    edges: [
      {
        edgeKey: "edge_bridge_candidate",
        sourceEntityKey: "entity_flare_labs",
        targetEntityKey: "entity_project_aurora",
        relationType: "co_mentioned",
        status: "uncertain",
        coMentionCount: 7,
        strength: 7,
        firstObservedAt: "2025-10-01T00:00:00.000Z",
        lastObservedAt: "2026-02-20T00:00:00.000Z",
        evidenceRefs: ["trace:edge_bridge_candidate"]
      },
      {
        edgeKey: "edge_stale_confirmed",
        sourceEntityKey: "entity_flare_labs",
        targetEntityKey: "entity_release_runbook",
        relationType: "project_related",
        status: "confirmed",
        coMentionCount: 4,
        strength: 4,
        firstObservedAt: "2025-10-01T00:00:00.000Z",
        lastObservedAt: confirmedEdgeLastObservedAt,
        evidenceRefs: ["trace:edge_stale_confirmed"]
      }
    ]
  };
}

/**
 * Implements `buildBaseContinuityStack` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildBaseContinuityStack(): ConversationStackV1 {
  const seeded = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's review sprint backlog priorities.",
        at: "2026-02-27T09:00:00.000Z"
      },
      {
        role: "user",
        text: "Switch to budget runway assumptions at Flare Labs.",
        at: "2026-02-28T09:00:00.000Z"
      }
    ],
    "2026-02-28T09:00:00.000Z"
  );
  const activeThreadKey = seeded.activeThreadKey;
  if (!activeThreadKey) {
    throw new Error("Base continuity stack requires deterministic active thread.");
  }
  return upsertOpenLoopOnConversationStackV1({
    stack: seeded,
    threadKey: activeThreadKey,
    text: "Remind me later to finalize budget runway assumptions.",
    observedAt: "2026-02-28T09:05:00.000Z",
    entityRefs: ["entity_flare_labs"],
    priorityHint: 0.74
  }).stack;
}

/**
 * Implements `findCandidateByReason` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function findCandidateByReason(
  candidates: readonly PulseCandidateV1[],
  reasonCode: PulseCandidateV1["reasonCode"]
): PulseCandidateV1 | null {
  return candidates.find((candidate) => candidate.reasonCode === reasonCode) ?? null;
}

/**
 * Implements `buildCheck` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildCheck(id: string, pass: boolean, detail: string): Stage686LiveScenarioCheck {
  return {
    id,
    pass,
    detail
  };
}

/**
 * Implements `buildScenarioResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildScenarioResult(
  id: string,
  title: string,
  timepointsUsed: readonly string[],
  checks: readonly Stage686LiveScenarioCheck[]
): Stage686LiveScenarioResult {
  return {
    id,
    title,
    pass: checks.every((check) => check.pass),
    timepointsUsed,
    checks
  };
}

/**
 * Implements `runEntityRecallScenario` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function runEntityRecallScenario(): Stage686LiveScenarioResult {
  const observedAt = "2026-06-01T12:00:00.000Z";
  const staleGraph = buildBaseContinuityGraph("2025-11-01T00:00:00.000Z");
  const freshGraph = buildBaseContinuityGraph("2026-05-28T00:00:00.000Z");
  const stack = buildBaseContinuityStack();

  const staleEvaluation = evaluatePulseCandidatesV1(
    {
      graph: staleGraph,
      stack,
      observedAt
    },
    {
      staleFactRevalidationDays: 90
    }
  );
  const freshEvaluation = evaluatePulseCandidatesV1(
    {
      graph: freshGraph,
      stack,
      observedAt
    },
    {
      staleFactRevalidationDays: 90
    }
  );
  const capSuppressed = evaluatePulseCandidatesV1(
    {
      graph: staleGraph,
      stack,
      observedAt,
      recentPulseHistory: [
        {
          emittedAt: "2026-06-01T08:30:00.000Z",
          reasonCode: "USER_REQUESTED_FOLLOWUP",
          candidateEntityRefs: ["entity_flare_labs"]
        },
        {
          emittedAt: "2026-06-01T10:30:00.000Z",
          reasonCode: "USER_REQUESTED_FOLLOWUP",
          candidateEntityRefs: ["entity_flare_labs"]
        }
      ]
    },
    {
      pulseMaxPerDay: 2,
      staleFactRevalidationDays: 90
    }
  );

  const staleCandidateRelevant = findCandidateByReason(
    staleEvaluation.orderedCandidates,
    "STALE_FACT_REVALIDATION"
  );
  const staleCandidateIrrelevant = findCandidateByReason(
    freshEvaluation.orderedCandidates,
    "STALE_FACT_REVALIDATION"
  );
  const staleCapSuppressed = capSuppressed.decisions.some(
    (entry) =>
      entry.candidate.reasonCode === "STALE_FACT_REVALIDATION" &&
      entry.decision.decisionCode === "SUPPRESS" &&
      entry.decision.blockDetailReason === "PULSE_CAP_REACHED"
  );

  return buildScenarioResult(
    "entity_recall_relevance_and_caps",
    "Entity recall resurfaces only when stale and remains cap-bounded",
    [
      "2025-11-01T00:00:00.000Z",
      "2026-05-28T00:00:00.000Z",
      "2026-06-01T12:00:00.000Z"
    ],
    [
      buildCheck(
        "stale_candidate_present_when_relevant",
        Boolean(staleCandidateRelevant),
        staleCandidateRelevant
          ? `Found stale revalidation candidate ${staleCandidateRelevant.candidateId}.`
          : "No stale revalidation candidate was emitted for stale relationship evidence."
      ),
      buildCheck(
        "stale_candidate_absent_when_fresh",
        staleCandidateIrrelevant === null,
        staleCandidateIrrelevant === null
          ? "Fresh relationship evidence did not trigger stale revalidation."
          : `Unexpected stale candidate ${staleCandidateIrrelevant.candidateId} for fresh relationship evidence.`
      ),
      buildCheck(
        "stale_candidate_suppressed_by_daily_cap",
        staleCapSuppressed,
        staleCapSuppressed
          ? "Daily pulse cap suppressed stale revalidation candidate deterministically."
          : "Daily pulse cap did not suppress stale revalidation candidate."
      )
    ]
  );
}

/**
 * Implements `runBridgeClarificationScenario` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function runBridgeClarificationScenario(): Stage686LiveScenarioResult {
  const observedAt = "2026-03-01T12:00:00.000Z";
  const graph = buildBaseContinuityGraph("2025-11-01T00:00:00.000Z");
  const stack = buildBaseContinuityStack();
  const pulseEvaluation = evaluatePulseCandidatesV1({
    graph,
    stack,
    observedAt
  });
  const bridgeCandidate = findCandidateByReason(
    pulseEvaluation.orderedCandidates,
    "RELATIONSHIP_CLARIFICATION"
  );
  if (!bridgeCandidate) {
    return buildScenarioResult(
      "bridge_single_shot_safe_clarification",
      "Bridge clarification asks once, stays neutral, and records status",
      [observedAt],
      [
        buildCheck(
          "bridge_candidate_present",
          false,
          "No RELATIONSHIP_CLARIFICATION candidate was generated."
        )
      ]
    );
  }

  const emission = evaluateBridgeQuestionEmissionV1({
    graph,
    candidate: bridgeCandidate,
    observedAt
  });
  const bridgeQuestion = emission.bridgeQuestion;
  const neutralPromptPass =
    Boolean(bridgeQuestion) &&
    bridgeQuestion!.prompt.includes("How would you describe their relationship") &&
    bridgeQuestion!.prompt.includes(
      "coworker, friend, family, project_related, other, or not related"
    );

  if (!bridgeQuestion) {
    return buildScenarioResult(
      "bridge_single_shot_safe_clarification",
      "Bridge clarification asks once, stays neutral, and records status",
      [observedAt],
      [
        buildCheck("bridge_emission_approved", false, "Bridge emission was not approved."),
        buildCheck("bridge_prompt_is_neutral", false, "No bridge prompt was produced."),
        buildCheck("bridge_status_recorded", false, "No bridge history record was produced."),
        buildCheck("bridge_follow_up_blocked", false, "Follow-up block could not be evaluated.")
      ]
    );
  }

  const deferred = resolveBridgeQuestionAnswerV1({
    graph,
    question: bridgeQuestion,
    observedAt: "2026-03-02T12:00:00.000Z",
    evidenceRef: "trace:stage686_live_smoke_bridge_deferred",
    answer: {
      kind: "deferred"
    }
  });
  const followUp = evaluateBridgeQuestionEmissionV1({
    graph,
    candidate: bridgeCandidate,
    observedAt: "2026-03-03T12:00:00.000Z",
    recentBridgeHistory: [deferred.historyRecord]
  });

  return buildScenarioResult(
    "bridge_single_shot_safe_clarification",
    "Bridge clarification asks once, stays neutral, and records status",
    [
      "2026-03-01T12:00:00.000Z",
      "2026-03-02T12:00:00.000Z",
      "2026-03-03T12:00:00.000Z"
    ],
    [
      buildCheck(
        "bridge_emission_approved",
        emission.approved && emission.blockCode === null,
        emission.approved
          ? "Bridge question emission approved."
          : `Bridge question was blocked with reason ${emission.blockDetailReason ?? "unknown"}.`
      ),
      buildCheck(
        "bridge_prompt_is_neutral",
        neutralPromptPass,
        neutralPromptPass
          ? "Bridge prompt kept neutral option-based wording."
          : "Bridge prompt did not match neutral wording contract."
      ),
      buildCheck(
        "bridge_status_recorded",
        deferred.historyRecord.status === "deferred" && deferred.deniedConflictCode === null,
        deferred.deniedConflictCode === null
          ? `Deferred answer recorded with deferralCount=${deferred.historyRecord.deferralCount}.`
          : `Bridge answer resolution returned conflict ${deferred.deniedConflictCode}.`
      ),
      buildCheck(
        "bridge_follow_up_blocked",
        followUp.blockDetailReason === "BRIDGE_COOLDOWN_ACTIVE",
        followUp.blockDetailReason === "BRIDGE_COOLDOWN_ACTIVE"
          ? "Follow-up bridge prompt blocked by deterministic cooldown."
          : `Unexpected follow-up bridge outcome ${followUp.blockDetailReason ?? "approved"}.`
      )
    ]
  );
}

/**
 * Implements `resolveActiveTopicKey` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function resolveActiveTopicKey(stack: ConversationStackV1): string | null {
  if (!stack.activeThreadKey) {
    return null;
  }
  const active = stack.threads.find((thread) => thread.threadKey === stack.activeThreadKey);
  return active?.topicKey ?? null;
}

/**
 * Implements `runThreadDivergenceScenario` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function runThreadDivergenceScenario(): Stage686LiveScenarioResult {
  let stack = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's review sprint backlog priorities.",
        at: "2026-03-01T10:00:00.000Z"
      },
      {
        role: "assistant",
        text: "Understood, we can review sprint backlog priorities.",
        at: "2026-03-01T10:01:00.000Z"
      },
      {
        role: "user",
        text: "Switch to budget runway assumptions.",
        at: "2026-03-01T10:02:00.000Z"
      },
      {
        role: "assistant",
        text: "Budget runway assumptions are now active.",
        at: "2026-03-01T10:03:00.000Z"
      },
      {
        role: "user",
        text: "Now switch to hiring pipeline planning.",
        at: "2026-03-01T10:04:00.000Z"
      }
    ],
    "2026-03-01T10:04:00.000Z"
  );

  const divergedThreadCountPass = stack.threads.length >= 3;
  stack = applyUserTurnToConversationStackV1(stack, {
    role: "user",
    text: "Go back to budget runway assumptions.",
    at: "2026-03-01T10:05:00.000Z"
  });
  const resumedBudgetPass = resolveActiveTopicKey(stack)?.includes("budget") ?? false;

  const activeBeforeAmbiguousReturn = stack.activeThreadKey;
  stack = applyUserTurnToConversationStackV1(stack, {
    role: "user",
    text: "Let's go back.",
    at: "2026-03-01T10:06:00.000Z"
  });
  const ambiguousStayPass = stack.activeThreadKey === activeBeforeAmbiguousReturn;

  return buildScenarioResult(
    "thread_diverge_and_resume",
    "Conversation threads diverge and deterministically resume",
    [
      "2026-03-01T10:00:00.000Z",
      "2026-03-01T10:04:00.000Z",
      "2026-03-01T10:06:00.000Z"
    ],
    [
      buildCheck(
        "threads_diverged",
        divergedThreadCountPass,
        divergedThreadCountPass
          ? `Thread divergence created ${stack.threads.length} threads.`
          : `Expected at least 3 threads after divergence; found ${stack.threads.length}.`
      ),
      buildCheck(
        "resume_to_budget_thread",
        resumedBudgetPass,
        resumedBudgetPass
          ? "Explicit resume signal moved active context back to budget thread."
          : `Active topic after explicit resume was ${resolveActiveTopicKey(stack) ?? "null"}.`
      ),
      buildCheck(
        "ambiguous_return_stays_on_active_thread",
        ambiguousStayPass,
        ambiguousStayPass
          ? "Ambiguous return signal kept current active thread."
          : "Ambiguous return signal incorrectly switched active thread."
      )
    ]
  );
}

/**
 * Implements `runOpenLoopBindingScenario` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function runOpenLoopBindingScenario(): Stage686LiveScenarioResult {
  const seeded = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's review sprint backlog priorities.",
        at: "2026-01-01T09:00:00.000Z"
      },
      {
        role: "user",
        text: "Switch to budget runway assumptions.",
        at: "2026-03-01T09:00:00.000Z"
      }
    ],
    "2026-03-01T09:00:00.000Z"
  );
  const sprintThread = seeded.threads.find((thread) => thread.topicKey.includes("sprint"));
  const budgetThread = seeded.threads.find((thread) => thread.topicKey.includes("budget"));
  if (!sprintThread || !budgetThread) {
    return buildScenarioResult(
      "open_loop_thread_binding",
      "Deferred open loop resurfaces with original thread binding",
      ["2026-03-01T09:00:00.000Z"],
      [
        buildCheck(
          "thread_fixture_valid",
          false,
          "Expected sprint and budget threads were not both present."
        )
      ]
    );
  }

  const staleLoop = upsertOpenLoopOnConversationStackV1({
    stack: seeded,
    threadKey: sprintThread.threadKey,
    text: "Still need to decide sprint overflow policy.",
    observedAt: "2026-01-01T09:05:00.000Z",
    priorityHint: 0.6
  });
  const freshLoop = upsertOpenLoopOnConversationStackV1({
    stack: staleLoop.stack,
    threadKey: budgetThread.threadKey,
    text: "Remind me later to confirm budget runway assumptions.",
    observedAt: "2026-03-01T09:05:00.000Z",
    priorityHint: 0.74
  });
  const selection = selectOpenLoopsForPulseV1(
    freshLoop.stack,
    "2026-03-15T09:00:00.000Z",
    {
      maxOpenLoopsSurfaced: 1,
      openLoopStaleDays: 30,
      freshPriorityThreshold: 0.35,
      stalePriorityThreshold: 0.7
    }
  );

  const selected = selection.selected[0] ?? null;
  const selectedFreshBudgetPass =
    selected !== null &&
    selected.loopId === freshLoop.loop?.loopId &&
    selected.threadKey === budgetThread.threadKey;
  const staleSuppressedPass = selection.suppressed.some(
    (candidate) => candidate.suppressionReason === "STALE_PRIORITY_TOO_LOW"
  );

  const resolved = freshLoop.loop
    ? resolveOpenLoopOnConversationStackV1({
      stack: freshLoop.stack,
      threadKey: freshLoop.loop.threadKey,
      loopId: freshLoop.loop.loopId,
      observedAt: "2026-03-16T09:00:00.000Z"
    })
    : {
      stack: freshLoop.stack,
      resolved: false,
      loop: null
    };
  const postResolveSelection = selectOpenLoopsForPulseV1(
    resolved.stack,
    "2026-03-17T09:00:00.000Z",
    {
      maxOpenLoopsSurfaced: 1,
      openLoopStaleDays: 30,
      freshPriorityThreshold: 0.35,
      stalePriorityThreshold: 0.7
    }
  );
  const resolvedRemovedPass =
    resolved.loop !== null &&
    !postResolveSelection.selected.some((candidate) => candidate.loopId === resolved.loop?.loopId);

  return buildScenarioResult(
    "open_loop_thread_binding",
    "Deferred open loop resurfaces with original thread binding",
    [
      "2026-01-01T09:05:00.000Z",
      "2026-03-01T09:05:00.000Z",
      "2026-03-15T09:00:00.000Z",
      "2026-03-16T09:00:00.000Z"
    ],
    [
      buildCheck(
        "selected_loop_matches_original_thread",
        selectedFreshBudgetPass,
        selectedFreshBudgetPass
          ? "Open-loop pulse candidate preserved budget thread binding."
          : "Selected open-loop candidate did not match original budget thread binding."
      ),
      buildCheck(
        "stale_low_priority_loop_suppressed",
        staleSuppressedPass,
        staleSuppressedPass
          ? "Stale low-priority loop was suppressed deterministically."
          : "Expected stale low-priority suppression was not observed."
      ),
      buildCheck(
        "resolved_loop_not_resurfaced",
        resolvedRemovedPass,
        resolvedRemovedPass
          ? "Resolved loop was excluded from later pulse selection."
          : "Resolved loop still resurfaced in post-resolution selection."
      )
    ]
  );
}

/**
 * Implements `hasActiveMissionWorkForUser` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function hasActiveMissionWorkForUser(
  sessionStore: InterfaceSessionStore,
  userId: string
): Promise<boolean> {
  const sessions = await sessionStore.listSessions();
  return sessions.some(
    (session) => session.userId === userId && (Boolean(session.runningJobId) || session.queuedJobs.length > 0)
  );
}

/**
 * Implements `runGlobalMissionSuppressionScenario` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runGlobalMissionSuppressionScenario(): Promise<Stage686LiveScenarioResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage686-live-smoke-"));
  try {
    const sessionsPath = path.join(tempDir, "sessions.json");
    const sessionStore = new InterfaceSessionStore(sessionsPath);

    const busySession = buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-busy",
      userId: "user-stage686",
      username: "agentowner",
      conversationVisibility: "private",
      receivedAt: "2026-03-01T11:55:00.000Z"
    });
    busySession.runningJobId = "job_busy_001";

    const idleSession = buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-idle",
      userId: "user-stage686",
      username: "agentowner",
      conversationVisibility: "private",
      receivedAt: "2026-03-01T11:56:00.000Z"
    });
    idleSession.agentPulse.optIn = true;
    idleSession.updatedAt = "2026-03-01T11:56:00.000Z";

    await sessionStore.setSession(busySession);
    await sessionStore.setSession(idleSession);

    const activeMissionWorkExists = await hasActiveMissionWorkForUser(sessionStore, "user-stage686");
    const graph = buildBaseContinuityGraph("2025-11-01T00:00:00.000Z");
    const stack = buildBaseContinuityStack();

    const suppressedEvaluation = evaluatePulseCandidatesV1({
      graph,
      stack,
      observedAt: "2026-03-01T12:00:00.000Z",
      activeMissionWorkExists
    });
    const suppressedAllPass =
      suppressedEvaluation.emittedCandidate === null &&
      suppressedEvaluation.decisions.every(
        (entry) =>
          entry.decision.decisionCode === "SUPPRESS" &&
          entry.decision.blockDetailReason === "DERAILS_ACTIVE_MISSION"
      );

    busySession.runningJobId = null;
    await sessionStore.setSession(busySession);
    const activeMissionCleared = await hasActiveMissionWorkForUser(sessionStore, "user-stage686");
    const unsuppressedEvaluation = evaluatePulseCandidatesV1({
      graph,
      stack,
      observedAt: "2026-03-01T12:30:00.000Z",
      activeMissionWorkExists: activeMissionCleared
    });
    const emissionRestoredPass = unsuppressedEvaluation.emittedCandidate !== null;

    return buildScenarioResult(
      "global_mission_priority_suppression",
      "Pulse suppresses globally during active mission work across sessions",
      [
        "2026-03-01T11:55:00.000Z",
        "2026-03-01T12:00:00.000Z",
        "2026-03-01T12:30:00.000Z"
      ],
      [
        buildCheck(
          "active_work_detected_across_sessions",
          activeMissionWorkExists,
          activeMissionWorkExists
            ? "Detected active mission work across user sessions."
            : "Failed to detect active mission work across user sessions."
        ),
        buildCheck(
          "all_candidates_suppressed_while_active_work_exists",
          suppressedAllPass,
          suppressedAllPass
            ? "All pulse candidates were suppressed with DERAILS_ACTIVE_MISSION."
            : "Pulse suppression did not apply globally while mission work was active."
        ),
        buildCheck(
          "suppression_lifts_after_active_work_clears",
          !activeMissionCleared && emissionRestoredPass,
          !activeMissionCleared && emissionRestoredPass
            ? "Suppression lifted and a pulse candidate became emit-eligible after active work cleared."
            : "Suppression did not lift correctly after active work cleared."
        )
      ]
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Implements `runStage686LiveSmoke` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage686LiveSmoke(): Promise<Stage686LiveSmokeArtifact> {
  const scenarios: Stage686LiveScenarioResult[] = [
    runEntityRecallScenario(),
    runBridgeClarificationScenario(),
    runThreadDivergenceScenario(),
    runOpenLoopBindingScenario(),
    await runGlobalMissionSuppressionScenario()
  ];

  const passedScenarios = scenarios.filter((scenario) => scenario.pass).length;
  const failedScenarioIds = scenarios
    .filter((scenario) => !scenario.pass)
    .map((scenario) => scenario.id);
  const overallPass = failedScenarioIds.length === 0;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_86:live_smoke",
    status: overallPass ? "PASS" : "FAIL",
    scenarios,
    summary: {
      totalScenarios: scenarios.length,
      passedScenarios,
      failedScenarioIds
    },
    passCriteria: {
      allScenariosPass: overallPass,
      overallPass
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage686LiveSmoke();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.86 live smoke status: ${artifact.status}`);
  console.log(`Artifact: ${ARTIFACT_PATH}`);

  if (!artifact.passCriteria.overallPass) {
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
