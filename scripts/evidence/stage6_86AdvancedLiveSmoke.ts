/**
 * @fileoverview Runs advanced Stage 6.86 live-smoke scenarios with human-like transcripts and emits deterministic reviewer evidence.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyAssistantTurnToConversationStackV1,
  applyUserTurnToConversationStackV1,
  createEmptyConversationStackV1
} from "../../src/core/stage6_86ConversationStack";
import {
  evaluateBridgeQuestionEmissionV1,
  resolveBridgeQuestionAnswerV1
} from "../../src/core/stage6_86BridgeQuestions";
import {
  applyEntityExtractionToGraph,
  createEmptyEntityGraphV1,
  extractEntityCandidates
} from "../../src/core/stage6_86EntityGraph";
import {
  resolveOpenLoopOnConversationStackV1,
  selectOpenLoopsForPulseV1,
  upsertOpenLoopOnConversationStackV1
} from "../../src/core/stage6_86OpenLoops";
import { evaluatePulseCandidatesV1 } from "../../src/core/stage6_86PulseCandidates";
import {
  BridgeBlockCodeV1,
  ConversationStackV1,
  EntityGraphV1,
  PulseBlockCodeV1,
  PulseCandidateV1
} from "../../src/core/types";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_86_advanced_live_smoke_report.json"
);
const COMMAND_NAME = "npm run test:stage6_86:advanced_live_smoke";

interface AdvancedTranscriptTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
  openLoopPriorityHint?: number;
}

interface Stage686AdvancedScenarioCheck {
  id: string;
  pass: boolean;
  detail: string;
}

interface Stage686AdvancedScenarioResult {
  id: string;
  title: string;
  pass: boolean;
  checks: readonly Stage686AdvancedScenarioCheck[];
  transcript: readonly AdvancedTranscriptTurn[];
  observedAt: string;
}

interface Stage686AdvancedCoverage {
  people: boolean;
  workplaces: boolean;
  events: boolean;
  followUpEmits: boolean;
  followUpSuppresses: boolean;
  bridgeClarification: boolean;
  privacySuppression: boolean;
  threadResume: boolean;
  longConversationDepth: boolean;
  multiPersonContinuity: boolean;
  longHorizonRevalidation: boolean;
}

interface Stage686AdvancedLiveSmokeArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL";
  scenarios: readonly Stage686AdvancedScenarioResult[];
  summary: {
    totalScenarios: number;
    passedScenarios: number;
    failedScenarioIds: readonly string[];
    totalChecks: number;
    failedChecks: number;
  };
  coverage: Stage686AdvancedCoverage;
  passCriteria: {
    allScenariosPass: boolean;
    coverageComplete: boolean;
    overallPass: boolean;
  };
}

interface ConversationSimulationState {
  graph: EntityGraphV1;
  stack: ConversationStackV1;
}

/**
 * Implements `buildCheck` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildCheck(id: string, pass: boolean, detail: string): Stage686AdvancedScenarioCheck {
  return { id, pass, detail };
}

/**
 * Implements `buildScenarioResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildScenarioResult(
  id: string,
  title: string,
  transcript: readonly AdvancedTranscriptTurn[],
  observedAt: string,
  checks: readonly Stage686AdvancedScenarioCheck[]
): Stage686AdvancedScenarioResult {
  return { id, title, pass: checks.every((check) => check.pass), checks, transcript, observedAt };
}

/**
 * Implements `createConversationSimulationState` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function createConversationSimulationState(startedAt: string): ConversationSimulationState {
  return {
    graph: createEmptyEntityGraphV1(startedAt),
    stack: createEmptyConversationStackV1(startedAt)
  };
}

/**
 * Implements `runTranscriptConversation` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function runTranscriptConversation(
  scenarioId: string,
  transcript: readonly AdvancedTranscriptTurn[]
): ConversationSimulationState {
  if (transcript.length === 0) {
    throw new Error(`Scenario '${scenarioId}' must include at least one turn.`);
  }
  const turns = [...transcript].sort((left, right) => left.at.localeCompare(right.at));
  let state = createConversationSimulationState(turns[0].at);
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn.role === "assistant") {
      state = {
        graph: state.graph,
        stack: applyAssistantTurnToConversationStackV1(state.stack, {
          role: "assistant",
          text: turn.text,
          at: turn.at
        })
      };
      continue;
    }
    const stackAfterTurn = applyUserTurnToConversationStackV1(state.stack, {
      role: "user",
      text: turn.text,
      at: turn.at
    });
    const evidenceRef = `trace:${scenarioId}:turn:${index}:entities`;
    const extraction = extractEntityCandidates({
      text: turn.text,
      observedAt: turn.at,
      evidenceRef
    });
    const graphMutation = applyEntityExtractionToGraph(state.graph, extraction, turn.at, evidenceRef);
    let nextStack = stackAfterTurn;
    if (stackAfterTurn.activeThreadKey) {
      nextStack = upsertOpenLoopOnConversationStackV1({
        stack: stackAfterTurn,
        threadKey: stackAfterTurn.activeThreadKey,
        text: turn.text,
        observedAt: turn.at,
        priorityHint: turn.openLoopPriorityHint,
        entityRefs: extraction.nodes.map((node) => node.entityKey)
      }).stack;
    }
    state = { graph: graphMutation.graph, stack: nextStack };
  }
  return state;
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
 * Implements `countEntitiesByType` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function countEntitiesByType(graph: EntityGraphV1): Readonly<Record<string, number>> {
  const counts = {
    person: 0,
    org: 0,
    event: 0
  };
  for (const entity of graph.entities) {
    if (entity.entityType === "person") {
      counts.person += 1;
      continue;
    }
    if (entity.entityType === "org") {
      counts.org += 1;
      continue;
    }
    if (entity.entityType === "event") {
      counts.event += 1;
    }
  }
  return counts;
}

/**
 * Implements `findEntityKeyByCanonicalName` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function findEntityKeyByCanonicalName(graph: EntityGraphV1, canonicalName: string): string | null {
  const normalizedTarget = canonicalName.trim().toLowerCase();
  for (const entity of graph.entities) {
    if (entity.canonicalName.trim().toLowerCase() === normalizedTarget) {
      return entity.entityKey;
    }
  }
  return null;
}

/**
 * Implements `calculateDaySpan` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function calculateDaySpan(startAt: string, endAt: string): number {
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return 0;
  }
  return Math.max(0, (endMs - startMs) / (24 * 60 * 60 * 1_000));
}

/**
 * Implements `isPrivacySuppressionReason` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isPrivacySuppressionReason(
  reason: PulseBlockCodeV1 | BridgeBlockCodeV1 | null
): boolean {
  return reason === "PRIVACY_SENSITIVE" || reason === "BRIDGE_PRIVACY_SENSITIVE";
}

/**
 * Implements `runWorkplaceFollowUpLifecycleScenario` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function runWorkplaceFollowUpLifecycleScenario(): Stage686AdvancedScenarioResult {
  const id = "workplace_followup_lifecycle";
  const transcript: readonly AdvancedTranscriptTurn[] = [
    {
      role: "user",
      at: "2026-01-10T09:00:00.000Z",
      text: "At Nimbus Labs we are preparing Launch Review for AtlasBoard and AuroraService."
    },
    {
      role: "assistant",
      at: "2026-01-10T09:00:20.000Z",
      text: "Logged. I can track the release thread and blockers."
    },
    {
      role: "user",
      at: "2026-01-10T09:01:10.000Z",
      text: "Remind me later to review AtlasBoard launch blockers with AuroraService.",
      openLoopPriorityHint: 0.86
    },
    {
      role: "assistant",
      at: "2026-01-10T09:01:30.000Z",
      text: "I noted that as a deferred release follow-up."
    },
    {
      role: "user",
      at: "2026-01-10T09:03:00.000Z",
      text: "Switch to hiring budget planning for Nimbus Labs."
    },
    {
      role: "assistant",
      at: "2026-01-10T09:03:20.000Z",
      text: "Budget thread created."
    },
    {
      role: "user",
      at: "2026-01-10T09:05:00.000Z",
      text: "Go back to release blockers for AtlasBoard."
    }
  ];
  const observedAt = "2026-05-20T12:00:00.000Z";
  const state = runTranscriptConversation(id, transcript);
  const baseEvaluation = evaluatePulseCandidatesV1({
    graph: state.graph,
    stack: state.stack,
    observedAt
  });
  const openLoopCandidate = findCandidateByReason(baseEvaluation.orderedCandidates, "OPEN_LOOP_RESUME");
  const emittedFollowUp = baseEvaluation.emittedCandidate !== null;

  const capEvaluation = evaluatePulseCandidatesV1(
    {
      graph: state.graph,
      stack: state.stack,
      observedAt,
      recentPulseHistory: [
        {
          emittedAt: "2026-05-20T08:00:00.000Z",
          reasonCode: "USER_REQUESTED_FOLLOWUP",
          candidateEntityRefs: ["entity_stub_one"]
        },
        {
          emittedAt: "2026-05-20T10:30:00.000Z",
          reasonCode: "USER_REQUESTED_FOLLOWUP",
          candidateEntityRefs: ["entity_stub_two"]
        }
      ]
    },
    {
      pulseMaxPerDay: 2
    }
  );
  const capSuppressionObserved = capEvaluation.decisions.some(
    (entry) =>
      entry.candidate.reasonCode === "OPEN_LOOP_RESUME" &&
      entry.decision.decisionCode === "SUPPRESS" &&
      entry.decision.blockDetailReason === "PULSE_CAP_REACHED"
  );

  const cooldownEvaluation = evaluatePulseCandidatesV1(
    {
      graph: state.graph,
      stack: state.stack,
      observedAt,
      recentPulseHistory: [
        {
          emittedAt: "2026-05-20T11:30:00.000Z",
          reasonCode: "USER_REQUESTED_FOLLOWUP",
          candidateEntityRefs: ["entity_stub_three"]
        }
      ]
    },
    {
      pulseMinIntervalMinutes: 240
    }
  );
  const cooldownSuppressionObserved = cooldownEvaluation.decisions.some(
    (entry) =>
      entry.candidate.reasonCode === "OPEN_LOOP_RESUME" &&
      entry.decision.decisionCode === "SUPPRESS" &&
      entry.decision.blockDetailReason === "PULSE_COOLDOWN_ACTIVE"
  );

  return buildScenarioResult(
    id,
    "Workplace follow-up emits when relevant and suppresses under caps",
    transcript,
    observedAt,
    [
      buildCheck(
        "open_loop_candidate_exists",
        openLoopCandidate !== null,
        openLoopCandidate
          ? `Found OPEN_LOOP_RESUME candidate ${openLoopCandidate.candidateId}.`
          : "No OPEN_LOOP_RESUME candidate was generated from deferred workplace thread."
      ),
      buildCheck(
        "follow_up_emits_without_suppression",
        emittedFollowUp,
        emittedFollowUp
          ? "Pulse evaluation produced an emit decision for follow-up."
          : "No follow-up emit decision was produced without suppression conditions."
      ),
      buildCheck(
        "daily_cap_suppresses_follow_up",
        capSuppressionObserved,
        capSuppressionObserved
          ? "Daily cap suppression blocked open-loop follow-up."
          : "Open-loop follow-up was not suppressed by daily pulse cap."
      ),
      buildCheck(
        "cooldown_suppresses_follow_up",
        cooldownSuppressionObserved,
        cooldownSuppressionObserved
          ? "Global cooldown suppression blocked open-loop follow-up."
          : "Open-loop follow-up was not suppressed by global cooldown."
      )
    ]
  );
}

/**
 * Implements `runRelationshipBridgeSingleShotScenario` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function runRelationshipBridgeSingleShotScenario(): Stage686AdvancedScenarioResult {
  const id = "relationship_bridge_single_shot";
  const transcript: readonly AdvancedTranscriptTurn[] = [
    {
      role: "user",
      at: "2026-02-01T09:00:00.000Z",
      text: "Nimbus Labs depends on AtlasBoard for planning."
    },
    { role: "assistant", at: "2026-02-01T09:00:20.000Z", text: "Captured." },
    {
      role: "user",
      at: "2026-02-03T09:00:00.000Z",
      text: "AtlasBoard rollout at Nimbus Labs is still blocked."
    },
    {
      role: "user",
      at: "2026-02-06T09:00:00.000Z",
      text: "Nimbus Labs and AtlasBoard are in the same release thread."
    },
    {
      role: "user",
      at: "2026-02-10T09:00:00.000Z",
      text: "I still need AtlasBoard updates from Nimbus Labs."
    },
    {
      role: "user",
      at: "2026-02-14T09:00:00.000Z",
      text: "Nimbus Labs keeps mentioning AtlasBoard in sprint planning."
    },
    {
      role: "user",
      at: "2026-02-18T09:00:00.000Z",
      text: "AtlasBoard and Nimbus Labs are both in today's release notes."
    }
  ];
  const observedAt = "2026-02-20T13:00:00.000Z";
  const state = runTranscriptConversation(id, transcript);
  const pulseEvaluation = evaluatePulseCandidatesV1({
    graph: state.graph,
    stack: state.stack,
    observedAt
  });
  const bridgeCandidate = findCandidateByReason(
    pulseEvaluation.orderedCandidates,
    "RELATIONSHIP_CLARIFICATION"
  );
  if (!bridgeCandidate) {
    return buildScenarioResult(
      id,
      "Bridge clarification asks once and then respects cooldown",
      transcript,
      observedAt,
      [
        buildCheck(
          "bridge_candidate_present",
          false,
          "No RELATIONSHIP_CLARIFICATION candidate was generated from repeated co-mentions."
        )
      ]
    );
  }
  const emission = evaluateBridgeQuestionEmissionV1({
    graph: state.graph,
    candidate: bridgeCandidate,
    observedAt
  });
  const question = emission.bridgeQuestion;
  const questionIsNeutral =
    question !== null &&
    question.prompt.includes("How would you describe their relationship") &&
    question.prompt.includes("coworker, friend, family, project_related, other, or not related");

  let deferredFollowUpBlocked = false;
  let deferredStatusValid = false;
  if (question) {
    const deferred = resolveBridgeQuestionAnswerV1({
      graph: state.graph,
      question,
      observedAt: "2026-02-21T13:00:00.000Z",
      evidenceRef: "trace:stage686_advanced_bridge_deferred",
      answer: { kind: "deferred" }
    });
    deferredStatusValid =
      deferred.historyRecord.status === "deferred" && deferred.historyRecord.deferralCount >= 1;
    const followUpAttempt = evaluateBridgeQuestionEmissionV1({
      graph: deferred.graph,
      candidate: bridgeCandidate,
      observedAt: "2026-02-22T13:00:00.000Z",
      recentBridgeHistory: [deferred.historyRecord]
    });
    deferredFollowUpBlocked =
      !followUpAttempt.approved && followUpAttempt.blockDetailReason === "BRIDGE_COOLDOWN_ACTIVE";
  }

  return buildScenarioResult(
    id,
    "Bridge clarification asks once and then respects cooldown",
    transcript,
    observedAt,
    [
      buildCheck(
        "bridge_candidate_present",
        bridgeCandidate !== null,
        `Bridge candidate ${bridgeCandidate.candidateId} is available for evaluation.`
      ),
      buildCheck(
        "bridge_emission_approved",
        emission.approved,
        emission.approved
          ? "Bridge emission passed deterministic evidence/cooldown/cap gates."
          : `Bridge emission blocked with reason ${String(emission.blockDetailReason)}.`
      ),
      buildCheck(
        "bridge_prompt_is_neutral",
        questionIsNeutral,
        questionIsNeutral
          ? "Bridge prompt used neutral option-based wording."
          : "Bridge prompt did not match neutral wording contract."
      ),
      buildCheck(
        "deferred_answer_recorded",
        deferredStatusValid,
        deferredStatusValid
          ? "Deferred answer recorded with deterministic cooldown backoff metadata."
          : "Deferred answer metadata was not recorded as expected."
      ),
      buildCheck(
        "follow_up_blocked_during_bridge_cooldown",
        deferredFollowUpBlocked,
        deferredFollowUpBlocked
          ? "Follow-up bridge emission was blocked by cooldown."
          : "Bridge cooldown did not block repeated bridge emission."
      )
    ]
  );
}

/**
 * Implements `runPrivacySensitivePeopleEventSuppressionScenario` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function runPrivacySensitivePeopleEventSuppressionScenario(): Stage686AdvancedScenarioResult {
  const id = "privacy_sensitive_people_event_suppression";
  const transcript: readonly AdvancedTranscriptTurn[] = [
    {
      role: "user",
      at: "2026-03-01T08:00:00.000Z",
      text: "Remind me later to check Maya Chen medical results after Health Review.",
      openLoopPriorityHint: 0.92
    },
    { role: "assistant", at: "2026-03-01T08:00:20.000Z", text: "Noted." }
  ];
  const observedAt = "2026-04-10T12:00:00.000Z";
  const state = runTranscriptConversation(id, transcript);
  const pulseEvaluation = evaluatePulseCandidatesV1({
    graph: state.graph,
    stack: state.stack,
    observedAt,
    privacyOptOutEntityKeys: state.graph.entities.map((entity) => entity.entityKey)
  });
  const hasPersonEntity = state.graph.entities.some((entity) => entity.entityType === "person");
  const hasEventEntity = state.graph.entities.some((entity) => entity.entityType === "event");
  const privacySuppressed = pulseEvaluation.decisions.every(
    (entry) =>
      entry.decision.decisionCode === "SUPPRESS" &&
      isPrivacySuppressionReason(entry.decision.blockDetailReason)
  );

  return buildScenarioResult(
    id,
    "People/event memory stays continuity-aware but privacy-suppressed",
    transcript,
    observedAt,
    [
      buildCheck(
        "people_entities_detected",
        hasPersonEntity,
        hasPersonEntity
          ? "Person entity type was extracted from transcript."
          : "Expected person entity extraction was not observed."
      ),
      buildCheck(
        "event_entities_detected",
        hasEventEntity,
        hasEventEntity
          ? "Event entity type was extracted from transcript."
          : "Expected event entity extraction was not observed."
      ),
      buildCheck(
        "privacy_candidates_generated",
        pulseEvaluation.orderedCandidates.length > 0,
        pulseEvaluation.orderedCandidates.length > 0
          ? `Generated ${pulseEvaluation.orderedCandidates.length} candidate(s) for suppression evaluation.`
          : "No candidates were generated for privacy suppression validation."
      ),
      buildCheck(
        "privacy_suppression_blocks_followup",
        pulseEvaluation.emittedCandidate === null && privacySuppressed,
        pulseEvaluation.emittedCandidate === null && privacySuppressed
          ? "All candidates were suppressed with privacy-sensitive reason codes."
          : "Privacy-sensitive flow emitted or used non-privacy suppression reasons."
      )
    ]
  );
}

/**
 * Implements `runThreadResumeBindingScenario` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function runThreadResumeBindingScenario(): Stage686AdvancedScenarioResult {
  const id = "thread_resume_binding";
  const transcript: readonly AdvancedTranscriptTurn[] = [
    { role: "user", at: "2026-03-12T10:00:00.000Z", text: "Let's outline Phoenix Expo booth logistics." },
    { role: "assistant", at: "2026-03-12T10:00:20.000Z", text: "Booth logistics thread started." },
    { role: "user", at: "2026-03-12T10:03:00.000Z", text: "Switch to Nimbus Labs onboarding checklist." },
    { role: "assistant", at: "2026-03-12T10:03:20.000Z", text: "Onboarding thread started." },
    {
      role: "user",
      at: "2026-03-12T10:05:00.000Z",
      text: "Remind me later to finalize Nimbus onboarding checklist.",
      openLoopPriorityHint: 0.83
    },
    { role: "assistant", at: "2026-03-12T10:05:20.000Z", text: "Deferred onboarding loop saved." },
    { role: "user", at: "2026-03-12T10:08:00.000Z", text: "Go back to booth logistics for Phoenix Expo." }
  ];
  const observedAt = "2026-03-20T11:00:00.000Z";
  const state = runTranscriptConversation(id, transcript);
  const activeThread = state.stack.threads.find((thread) => thread.threadKey === state.stack.activeThreadKey) ?? null;
  const resumedPhoenix = activeThread !== null && activeThread.topicLabel.toLowerCase().includes("phoenix");
  const onboardingLoop = state.stack.threads
    .flatMap((thread) => thread.openLoops.map((loop) => ({ loop, threadKey: thread.threadKey })))
    .find((entry) => entry.loop.status === "open") ?? null;

  const selection = selectOpenLoopsForPulseV1(state.stack, observedAt, {
    maxOpenLoopsSurfaced: 1,
    openLoopStaleDays: 30,
    freshPriorityThreshold: 0.3,
    stalePriorityThreshold: 0.7
  });
  const onboardingLoopSelected =
    onboardingLoop !== null &&
    selection.selected.some(
      (candidate) =>
        candidate.loopId === onboardingLoop.loop.loopId &&
        candidate.threadKey === onboardingLoop.threadKey
    );

  const resolved = onboardingLoop
    ? resolveOpenLoopOnConversationStackV1({
      stack: state.stack,
      threadKey: onboardingLoop.threadKey,
      loopId: onboardingLoop.loop.loopId,
      observedAt: "2026-03-21T11:00:00.000Z"
    })
    : { stack: state.stack, resolved: false, loop: null };
  const postResolveSelection = selectOpenLoopsForPulseV1(
    resolved.stack,
    "2026-03-22T11:00:00.000Z"
  );
  const resolvedLoopSuppressed =
    resolved.loop !== null &&
    !postResolveSelection.selected.some((candidate) => candidate.loopId === resolved.loop?.loopId);

  return buildScenarioResult(
    id,
    "Thread resumes correctly and open loops remain bound to original thread",
    transcript,
    observedAt,
    [
      buildCheck(
        "explicit_return_resumes_expected_thread",
        resumedPhoenix,
        resumedPhoenix
          ? "Explicit return phrase resumed Phoenix Expo thread."
          : "Explicit return phrase did not resume the expected thread."
      ),
      buildCheck(
        "open_loop_keeps_original_thread_binding",
        onboardingLoopSelected,
        onboardingLoopSelected
          ? "Open-loop candidate preserved onboarding thread binding."
          : "Open-loop candidate did not preserve onboarding thread binding."
      ),
      buildCheck(
        "resolved_loop_no_longer_resurfaces",
        resolvedLoopSuppressed,
        resolvedLoopSuppressed
          ? "Resolved onboarding loop no longer resurfaced."
          : "Resolved onboarding loop still resurfaced."
      )
    ]
  );
}

/**
 * Implements `runLongMultiPartyContinuityScenario` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function runLongMultiPartyContinuityScenario(): Stage686AdvancedScenarioResult {
  const id = "long_multi_party_continuity";
  const transcript: readonly AdvancedTranscriptTurn[] = [
    {
      role: "user",
      at: "2026-07-01T09:00:00.000Z",
      text: "At Nimbus Labs, Maya Chen and Liam Patel are coordinating Launch Review with Harbor Systems."
    },
    { role: "assistant", at: "2026-07-01T09:00:20.000Z", text: "Captured launch coordination thread." },
    {
      role: "user",
      at: "2026-07-01T09:02:00.000Z",
      text: "Jordan Lee at Harbor Systems asked Priya Rao from Nimbus Labs to finalize Partner Summit agenda."
    },
    {
      role: "user",
      at: "2026-07-01T09:04:00.000Z",
      text: "Remind me later to send Maya Chen and Jordan Lee the Launch Review risk checklist.",
      openLoopPriorityHint: 0.89
    },
    { role: "assistant", at: "2026-07-01T09:04:20.000Z", text: "Deferred launch checklist loop stored." },
    {
      role: "user",
      at: "2026-07-01T09:06:00.000Z",
      text: "Switch to hiring pipeline for Nimbus Labs and Orion Group."
    },
    { role: "assistant", at: "2026-07-01T09:06:20.000Z", text: "Hiring pipeline thread active." },
    {
      role: "user",
      at: "2026-07-01T09:08:00.000Z",
      text: "We still need to decide whether Liam Patel or Priya Rao leads Partner Summit prep.",
      openLoopPriorityHint: 0.82
    },
    {
      role: "user",
      at: "2026-07-01T09:10:00.000Z",
      text: "Switch to Harbor Systems incident review planning."
    },
    { role: "assistant", at: "2026-07-01T09:10:20.000Z", text: "Incident planning thread active." },
    {
      role: "user",
      at: "2026-07-01T09:12:00.000Z",
      text: "Remind me later to schedule incident review with Jordan Lee and Maya Chen.",
      openLoopPriorityHint: 0.84
    },
    { role: "assistant", at: "2026-07-01T09:12:20.000Z", text: "Incident follow-up saved." },
    {
      role: "user",
      at: "2026-07-02T09:00:00.000Z",
      text: "Go back to Launch Review coordination with Nimbus Labs and Harbor Systems."
    },
    { role: "assistant", at: "2026-07-02T09:00:20.000Z", text: "Returned to launch coordination thread." },
    {
      role: "user",
      at: "2026-07-02T09:02:00.000Z",
      text: "Nimbus Labs and Harbor Systems shared Launch Review blockers this morning."
    },
    {
      role: "user",
      at: "2026-07-03T09:02:00.000Z",
      text: "Harbor Systems sent Nimbus Labs another Launch Review checkpoint update."
    },
    {
      role: "user",
      at: "2026-07-04T09:02:00.000Z",
      text: "Nimbus Labs met Harbor Systems during Launch Review planning."
    },
    {
      role: "user",
      at: "2026-07-05T09:02:00.000Z",
      text: "Launch Review notes from Harbor Systems and Nimbus Labs need consolidation."
    },
    {
      role: "user",
      at: "2026-07-06T09:02:00.000Z",
      text: "Nimbus Labs and Harbor Systems aligned Partner Summit and Launch Review timelines."
    },
    {
      role: "assistant",
      at: "2026-07-06T09:02:20.000Z",
      text: "Cross-org continuity context is updated."
    },
    {
      role: "user",
      at: "2026-07-06T09:05:00.000Z",
      text: "Continue incident planning and then return to Launch Review."
    }
  ];
  const observedAt = "2026-08-01T11:30:00.000Z";
  const state = runTranscriptConversation(id, transcript);
  const counts = countEntitiesByType(state.graph);
  const pulseEvaluation = evaluatePulseCandidatesV1({
    graph: state.graph,
    stack: state.stack,
    observedAt
  });
  const openLoopCandidate = findCandidateByReason(pulseEvaluation.orderedCandidates, "OPEN_LOOP_RESUME");
  const bridgeCandidate = findCandidateByReason(
    pulseEvaluation.orderedCandidates,
    "RELATIONSHIP_CLARIFICATION"
  );
  const bridgeApproved =
    bridgeCandidate !== null &&
    evaluateBridgeQuestionEmissionV1({
      graph: state.graph,
      candidate: bridgeCandidate,
      observedAt
    }).approved;
  const threadCount = state.stack.threads.length;

  return buildScenarioResult(
    id,
    "Long multi-party continuity run (people, orgs, events, interleaved threads)",
    transcript,
    observedAt,
    [
      buildCheck(
        "transcript_has_long_depth",
        transcript.length >= 20,
        transcript.length >= 20
          ? `Transcript depth ${transcript.length} turns satisfies long-form threshold.`
          : `Transcript depth ${transcript.length} turns did not reach long-form threshold.`
      ),
      buildCheck(
        "multi_person_entities_persisted",
        counts.person >= 4,
        counts.person >= 4
          ? `Detected ${counts.person} person entities in long-form transcript.`
          : `Expected >=4 person entities, found ${counts.person}.`
      ),
      buildCheck(
        "multi_workplace_entities_persisted",
        counts.org >= 3,
        counts.org >= 3
          ? `Detected ${counts.org} workplace/org entities in long-form transcript.`
          : `Expected >=3 org entities, found ${counts.org}.`
      ),
      buildCheck(
        "event_entities_persisted",
        counts.event >= 2,
        counts.event >= 2
          ? `Detected ${counts.event} event entities in long-form transcript.`
          : `Expected >=2 event entities, found ${counts.event}.`
      ),
      buildCheck(
        "open_loop_candidate_present_after_long_run",
        openLoopCandidate !== null,
        openLoopCandidate
          ? `Long-form run produced open-loop candidate ${openLoopCandidate.candidateId}.`
          : "Long-form run did not produce an OPEN_LOOP_RESUME candidate."
      ),
      buildCheck(
        "bridge_path_remains_governed_in_long_run",
        bridgeCandidate !== null && bridgeApproved,
        bridgeCandidate !== null && bridgeApproved
          ? "Long-form run produced bridge candidate that passed governed emission."
          : "Long-form run did not produce an approved bridge clarification path."
      ),
      buildCheck(
        "thread_interleaving_persists_multiple_threads",
        threadCount >= 3,
        threadCount >= 3
          ? `Conversation stack retained ${threadCount} interleaved threads.`
          : `Expected >=3 interleaved threads, found ${threadCount}.`
      )
    ]
  );
}

/**
 * Implements `runLongHorizonRelationshipRevalidationScenario` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function runLongHorizonRelationshipRevalidationScenario(): Stage686AdvancedScenarioResult {
  const id = "long_horizon_relationship_revalidation";
  const transcript: readonly AdvancedTranscriptTurn[] = [
    {
      role: "user",
      at: "2026-01-03T09:00:00.000Z",
      text: "Nimbus Labs and Harbor Systems are preparing Launch Review with Maya Chen and Liam Patel."
    },
    {
      role: "assistant",
      at: "2026-01-03T09:00:20.000Z",
      text: "Launch Review thread captured."
    },
    {
      role: "user",
      at: "2026-01-05T09:05:00.000Z",
      text: "Orion Group and Red Cedar University are joining Partner Summit planning with Priya Rao."
    },
    {
      role: "assistant",
      at: "2026-01-05T09:05:20.000Z",
      text: "Partner Summit planning context is stored."
    },
    {
      role: "user",
      at: "2026-01-07T09:10:00.000Z",
      text: "Remind me later to send Maya Chen and Jordan Lee the Launch Review risk checklist.",
      openLoopPriorityHint: 0.91
    },
    {
      role: "assistant",
      at: "2026-01-07T09:10:20.000Z",
      text: "Deferred launch checklist loop saved."
    },
    {
      role: "user",
      at: "2026-01-10T09:15:00.000Z",
      text: "Switch to hiring pipeline with Orion Group."
    },
    {
      role: "assistant",
      at: "2026-01-10T09:15:20.000Z",
      text: "Hiring pipeline thread active."
    },
    {
      role: "user",
      at: "2026-01-14T09:18:00.000Z",
      text: "Nimbus Labs and Harbor Systems shared a Launch Review checkpoint."
    },
    {
      role: "user",
      at: "2026-01-21T09:20:00.000Z",
      text: "Harbor Systems sent Nimbus Labs Launch Review blockers from Jordan Lee."
    },
    {
      role: "assistant",
      at: "2026-01-21T09:20:20.000Z",
      text: "Launch blocker context updated."
    },
    {
      role: "user",
      at: "2026-01-28T09:24:00.000Z",
      text: "Nimbus Labs and Harbor Systems aligned Partner Summit goals with Priya Rao."
    },
    {
      role: "user",
      at: "2026-02-04T09:28:00.000Z",
      text: "Red Cedar University asked Maya Chen for Security Conference updates."
    },
    {
      role: "assistant",
      at: "2026-02-04T09:28:20.000Z",
      text: "Security Conference thread captured."
    },
    {
      role: "user",
      at: "2026-02-11T09:31:00.000Z",
      text: "Remind me later to compare incident response drafts from Nimbus Labs and Harbor Systems.",
      openLoopPriorityHint: 0.86
    },
    {
      role: "assistant",
      at: "2026-02-11T09:31:20.000Z",
      text: "Incident response follow-up loop saved."
    },
    {
      role: "user",
      at: "2026-02-18T09:34:00.000Z",
      text: "Switch to budget planning with Orion Group and Red Cedar University."
    },
    {
      role: "assistant",
      at: "2026-02-18T09:34:20.000Z",
      text: "Budget planning thread active."
    },
    {
      role: "user",
      at: "2026-02-25T09:37:00.000Z",
      text: "Go back to Launch Review coordination for Nimbus Labs and Harbor Systems."
    },
    {
      role: "assistant",
      at: "2026-02-25T09:37:20.000Z",
      text: "Returned to Launch Review coordination thread."
    },
    {
      role: "user",
      at: "2026-03-02T09:40:00.000Z",
      text: "Nimbus Labs and Harbor Systems finalized another Launch Review checkpoint."
    },
    {
      role: "user",
      at: "2026-03-09T09:43:00.000Z",
      text: "Liam Patel and Priya Rao are preparing Partner Summit materials."
    },
    {
      role: "assistant",
      at: "2026-03-09T09:43:20.000Z",
      text: "Partner Summit continuity updated."
    },
    {
      role: "user",
      at: "2026-06-10T10:00:00.000Z",
      text: "Pause launch topics and focus on Orion Group hiring interviews."
    },
    {
      role: "assistant",
      at: "2026-06-10T10:00:20.000Z",
      text: "Hiring interview thread active."
    },
    {
      role: "user",
      at: "2026-08-01T10:10:00.000Z",
      text: "Return to Launch Review outcomes from Nimbus Labs and Harbor Systems."
    },
    {
      role: "assistant",
      at: "2026-08-01T10:10:20.000Z",
      text: "Launch outcomes thread resumed."
    },
    {
      role: "user",
      at: "2026-09-15T10:20:00.000Z",
      text: "Remind me to revalidate whether Nimbus Labs and Harbor Systems still share project timelines.",
      openLoopPriorityHint: 0.9
    },
    {
      role: "assistant",
      at: "2026-09-15T10:20:20.000Z",
      text: "Revalidation follow-up loop stored."
    },
    {
      role: "user",
      at: "2026-10-20T10:30:00.000Z",
      text: "Switch to Phoenix Conference logistics with Maya Chen and Liam Patel."
    },
    {
      role: "assistant",
      at: "2026-10-20T10:30:20.000Z",
      text: "Phoenix Conference thread active."
    },
    {
      role: "user",
      at: "2026-11-05T10:40:00.000Z",
      text: "Return to incident response draft work for Harbor Systems and Nimbus Labs."
    }
  ];
  const observedAt = "2026-11-20T12:00:00.000Z";
  const state = runTranscriptConversation(id, transcript);
  const counts = countEntitiesByType(state.graph);
  const daySpan = calculateDaySpan(transcript[0]?.at ?? observedAt, observedAt);

  const nimbusEntityKey = findEntityKeyByCanonicalName(state.graph, "Nimbus Labs");
  const harborEntityKey = findEntityKeyByCanonicalName(state.graph, "Harbor Systems");
  const bridgeSeedEvaluation = evaluatePulseCandidatesV1(
    {
      graph: state.graph,
      stack: state.stack,
      observedAt: "2026-03-12T12:00:00.000Z"
    },
    {
      coMentionThreshold: 5
    }
  );

  const bridgeCandidate =
    bridgeSeedEvaluation.orderedCandidates.find(
      (candidate) =>
        candidate.reasonCode === "RELATIONSHIP_CLARIFICATION" &&
        nimbusEntityKey !== null &&
        harborEntityKey !== null &&
        candidate.entityRefs.includes(nimbusEntityKey) &&
        candidate.entityRefs.includes(harborEntityKey)
    ) ?? null;

  let graphAfterConfirmation = state.graph;
  let bridgeConfirmationPassed = false;
  if (bridgeCandidate) {
    const bridgeEmission = evaluateBridgeQuestionEmissionV1({
      graph: state.graph,
      candidate: bridgeCandidate,
      observedAt: "2026-03-12T12:00:00.000Z"
    });
    if (bridgeEmission.bridgeQuestion) {
      const bridgeResolution = resolveBridgeQuestionAnswerV1({
        graph: state.graph,
        question: bridgeEmission.bridgeQuestion,
        observedAt: "2026-03-12T12:30:00.000Z",
        evidenceRef: "trace:stage686_advanced_long_horizon_bridge_confirmed",
        answer: {
          kind: "confirmed",
          relationType: "project_related"
        }
      });
      graphAfterConfirmation = bridgeResolution.graph;
      bridgeConfirmationPassed = bridgeEmission.approved && bridgeResolution.deniedConflictCode === null;
    }
  }

  const staleEvaluation = evaluatePulseCandidatesV1(
    {
      graph: graphAfterConfirmation,
      stack: state.stack,
      observedAt
    },
    {
      staleFactRevalidationDays: 120
    }
  );
  const staleCandidate =
    staleEvaluation.orderedCandidates.find(
      (candidate) =>
        candidate.reasonCode === "STALE_FACT_REVALIDATION" &&
        nimbusEntityKey !== null &&
        harborEntityKey !== null &&
        candidate.entityRefs.includes(nimbusEntityKey) &&
        candidate.entityRefs.includes(harborEntityKey)
    ) ?? null;

  const missionSuppressedEvaluation = evaluatePulseCandidatesV1(
    {
      graph: graphAfterConfirmation,
      stack: state.stack,
      observedAt,
      activeMissionWorkExists: true
    },
    {
      staleFactRevalidationDays: 120
    }
  );
  const missionSuppressed = missionSuppressedEvaluation.decisions.every(
    (entry) =>
      entry.decision.decisionCode === "SUPPRESS" &&
      entry.decision.blockDetailReason === "DERAILS_ACTIVE_MISSION"
  );

  return buildScenarioResult(
    id,
    "Long-horizon relationship drift and revalidation across months",
    transcript,
    observedAt,
    [
      buildCheck(
        "transcript_depth_is_extended",
        transcript.length >= 28,
        transcript.length >= 28
          ? `Transcript depth ${transcript.length} turns satisfies extended threshold.`
          : `Transcript depth ${transcript.length} turns did not satisfy extended threshold.`
      ),
      buildCheck(
        "timeline_spans_multiple_months",
        daySpan >= 240,
        daySpan >= 240
          ? `Timeline span ${daySpan.toFixed(1)} days meets multi-month requirement.`
          : `Timeline span ${daySpan.toFixed(1)} days did not meet multi-month requirement.`
      ),
      buildCheck(
        "entity_counts_cover_people_workplaces_events",
        counts.person >= 4 && counts.org >= 4 && counts.event >= 4,
        counts.person >= 4 && counts.org >= 4 && counts.event >= 4
          ? `Detected people=${counts.person}, orgs=${counts.org}, events=${counts.event}.`
          : `Expected people>=4/orgs>=4/events>=4 but got people=${counts.person}, orgs=${counts.org}, events=${counts.event}.`
      ),
      buildCheck(
        "bridge_candidate_for_primary_org_pair_present",
        bridgeCandidate !== null,
        bridgeCandidate
          ? `Bridge candidate ${bridgeCandidate.candidateId} found for Nimbus Labs/Harbor Systems.`
          : "No bridge candidate found for Nimbus Labs/Harbor Systems."
      ),
      buildCheck(
        "bridge_confirmation_promotes_relation",
        bridgeConfirmationPassed,
        bridgeConfirmationPassed
          ? "Bridge confirmation promoted relationship to confirmed."
          : "Bridge confirmation did not complete with a confirmed promotion."
      ),
      buildCheck(
        "stale_revalidation_candidate_present",
        staleCandidate !== null,
        staleCandidate
          ? `Stale revalidation candidate ${staleCandidate.candidateId} is available.`
          : "No STALE_FACT_REVALIDATION candidate was generated for confirmed org relationship."
      ),
      buildCheck(
        "revalidation_flow_emits_when_not_suppressed",
        staleEvaluation.emittedCandidate !== null,
        staleEvaluation.emittedCandidate
          ? `Non-suppressed flow emitted candidate ${staleEvaluation.emittedCandidate.candidateId}.`
          : "Non-suppressed flow produced no emitted candidate."
      ),
      buildCheck(
        "mission_priority_blocks_revalidation_emit",
        missionSuppressed,
        missionSuppressed
          ? "Mission-priority suppression blocked all candidates with DERAILS_ACTIVE_MISSION."
          : "Mission-priority suppression did not block all candidates during long-horizon revalidation."
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
 * Implements `runMissionPrioritySuppressionScenario` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runMissionPrioritySuppressionScenario(): Promise<Stage686AdvancedScenarioResult> {
  const id = "mission_priority_suppression";
  const transcript: readonly AdvancedTranscriptTurn[] = [
    { role: "user", at: "2026-03-30T14:00:00.000Z", text: "At Harbor Labs we still owe SprintBoard release notes." },
    { role: "assistant", at: "2026-03-30T14:00:20.000Z", text: "Captured." },
    {
      role: "user",
      at: "2026-03-30T14:02:00.000Z",
      text: "Remind me later to close SprintBoard release notes.",
      openLoopPriorityHint: 0.88
    }
  ];
  const observedAt = "2026-03-31T12:00:00.000Z";
  const state = runTranscriptConversation(id, transcript);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage686-advanced-smoke-"));
  try {
    const sessionsPath = path.join(tempDir, "sessions.json");
    const sessionStore = new InterfaceSessionStore(sessionsPath);
    const busySession = buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-busy-stage686",
      userId: "user-stage686-advanced",
      username: "agentowner",
      conversationVisibility: "private",
      receivedAt: "2026-03-31T11:50:00.000Z"
    });
    busySession.runningJobId = "job_live_advanced_001";
    const idleSession = buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-idle-stage686",
      userId: "user-stage686-advanced",
      username: "agentowner",
      conversationVisibility: "private",
      receivedAt: "2026-03-31T11:55:00.000Z"
    });
    await sessionStore.setSession(busySession);
    await sessionStore.setSession(idleSession);

    const activeMissionWorkExists = await hasActiveMissionWorkForUser(
      sessionStore,
      "user-stage686-advanced"
    );
    const suppressedEvaluation = evaluatePulseCandidatesV1({
      graph: state.graph,
      stack: state.stack,
      observedAt,
      activeMissionWorkExists
    });
    const missionSuppressed = suppressedEvaluation.decisions.every(
      (entry) =>
        entry.decision.decisionCode === "SUPPRESS" &&
        entry.decision.blockDetailReason === "DERAILS_ACTIVE_MISSION"
    );

    busySession.runningJobId = null;
    await sessionStore.setSession(busySession);
    const activeMissionWorkCleared = await hasActiveMissionWorkForUser(
      sessionStore,
      "user-stage686-advanced"
    );
    const unsuppressedEvaluation = evaluatePulseCandidatesV1({
      graph: state.graph,
      stack: state.stack,
      observedAt: "2026-03-31T12:30:00.000Z",
      activeMissionWorkExists: activeMissionWorkCleared
    });
    const followUpRestored = unsuppressedEvaluation.emittedCandidate !== null;

    return buildScenarioResult(
      id,
      "Pulse suppression respects user-global active mission work",
      transcript,
      observedAt,
      [
        buildCheck(
          "active_mission_detected_across_sessions",
          activeMissionWorkExists,
          activeMissionWorkExists
            ? "Detected active mission work from separate session."
            : "Did not detect cross-session active mission work."
        ),
        buildCheck(
          "mission_priority_suppresses_all_candidates",
          missionSuppressed,
          missionSuppressed
            ? "All candidates were suppressed with DERAILS_ACTIVE_MISSION."
            : "Mission-priority suppression did not block all candidates."
        ),
        buildCheck(
          "follow_up_restores_after_work_clears",
          !activeMissionWorkCleared && followUpRestored,
          !activeMissionWorkCleared && followUpRestored
            ? "Follow-up emission resumed after active mission work cleared."
            : "Follow-up emission did not resume after active mission work cleared."
        )
      ]
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Implements `computeCoverage` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function computeCoverage(
  byId: ReadonlyMap<string, Stage686AdvancedScenarioResult>
): Stage686AdvancedCoverage {
  const workplaceFollowUp = byId.get("workplace_followup_lifecycle")?.pass ?? false;
  const bridgeSingleShot = byId.get("relationship_bridge_single_shot")?.pass ?? false;
  const privacyPeopleEvent = byId.get("privacy_sensitive_people_event_suppression")?.pass ?? false;
  const threadResume = byId.get("thread_resume_binding")?.pass ?? false;
  const missionSuppression = byId.get("mission_priority_suppression")?.pass ?? false;
  const longMultiParty = byId.get("long_multi_party_continuity")?.pass ?? false;
  const longHorizon = byId.get("long_horizon_relationship_revalidation")?.pass ?? false;
  return {
    people: privacyPeopleEvent && longMultiParty && longHorizon,
    workplaces: workplaceFollowUp && bridgeSingleShot && threadResume && longMultiParty && longHorizon,
    events: threadResume && privacyPeopleEvent && longMultiParty && longHorizon,
    followUpEmits: workplaceFollowUp && missionSuppression && longHorizon,
    followUpSuppresses: workplaceFollowUp && privacyPeopleEvent && missionSuppression && longHorizon,
    bridgeClarification: bridgeSingleShot && longHorizon,
    privacySuppression: privacyPeopleEvent,
    threadResume: threadResume && longHorizon,
    longConversationDepth: longMultiParty && longHorizon,
    multiPersonContinuity: longMultiParty && longHorizon,
    longHorizonRevalidation: longHorizon
  };
}

/**
 * Implements `runStage686AdvancedLiveSmoke` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage686AdvancedLiveSmoke(): Promise<Stage686AdvancedLiveSmokeArtifact> {
  const scenarios: Stage686AdvancedScenarioResult[] = [
    runWorkplaceFollowUpLifecycleScenario(),
    runRelationshipBridgeSingleShotScenario(),
    runPrivacySensitivePeopleEventSuppressionScenario(),
    runThreadResumeBindingScenario(),
    runLongMultiPartyContinuityScenario(),
    runLongHorizonRelationshipRevalidationScenario(),
    await runMissionPrioritySuppressionScenario()
  ];
  const failedScenarioIds = scenarios.filter((scenario) => !scenario.pass).map((scenario) => scenario.id);
  const checks = scenarios.flatMap((scenario) => scenario.checks);
  const failedChecks = checks.filter((check) => !check.pass).length;
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const coverage = computeCoverage(byId);
  const coverageComplete = Object.values(coverage).every((value) => value);
  const allScenariosPass = failedScenarioIds.length === 0;
  const overallPass = allScenariosPass && coverageComplete;

  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND_NAME,
    status: overallPass ? "PASS" : "FAIL",
    scenarios,
    summary: {
      totalScenarios: scenarios.length,
      passedScenarios: scenarios.length - failedScenarioIds.length,
      failedScenarioIds,
      totalChecks: checks.length,
      failedChecks
    },
    coverage,
    passCriteria: {
      allScenariosPass,
      coverageComplete,
      overallPass
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage686AdvancedLiveSmoke();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.86 advanced live smoke status: ${artifact.status}`);
  console.log(`Artifact: ${ARTIFACT_PATH}`);

  if (!artifact.passCriteria.overallPass) {
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
