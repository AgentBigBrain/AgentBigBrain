/**
 * @fileoverview Tests the extracted shared runtime-type subsystem and the stable `types.ts` compatibility surface.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALL_GOVERNOR_IDS,
  CONSTRAINT_VIOLATION_CODES,
  FULL_COUNCIL_GOVERNOR_IDS,
  isConstraintViolationCode,
  isGovernorId
} from "../../src/core/types";
import {
  CONSTRAINT_VIOLATION_CODES as CANONICAL_CONSTRAINT_VIOLATION_CODES,
  isConstraintViolationCode as canonicalIsConstraintViolationCode,
} from "../../src/core/runtimeTypes/governanceOutcomeTypes";
import type {
  FailureTaxonomyResultV1 as CanonicalFailureTaxonomyResultV1,
  FirstPrinciplesPacketV1 as CanonicalFirstPrinciplesPacketV1
} from "../../src/core/runtimeTypes/decisionSupportTypes";
import {
  ALL_GOVERNOR_IDS as CANONICAL_GOVERNOR_IDS,
  FULL_COUNCIL_GOVERNOR_IDS as CANONICAL_FULL_COUNCIL_IDS,
  isGovernorId as canonicalGovernanceIdGuard
} from "../../src/core/runtimeTypes/governanceTypes";
import {
  STAGE_6_86_BLOCK_CODES as CANONICAL_STAGE_6_86_BLOCK_CODES,
  STAGE_6_86_PULSE_DECISION_CODES as CANONICAL_STAGE_6_86_PULSE_DECISION_CODES,
  type BridgeQuestionV1 as CanonicalBridgeQuestionV1,
  type ConversationStackV1 as CanonicalConversationStackV1,
  type PulseDecisionV1 as CanonicalPulseDecisionV1
} from "../../src/core/runtimeTypes/interfaceTypes";
import {
  MISSION_UX_STATES_V1 as CANONICAL_MISSION_UX_STATES_V1,
  STAGE_6_75_BLOCK_CODES as CANONICAL_STAGE_6_75_BLOCK_CODES,
  type MissionTimelineV1 as CanonicalMissionTimelineV1,
  type WorkflowRunReceiptV1 as CanonicalWorkflowRunReceiptV1
} from "../../src/core/runtimeTypes/persistenceTypes";
import type {
  BrainState as CanonicalBrainState,
  TaskRunResult as CanonicalTaskRunResult
} from "../../src/core/runtimeTypes/runtimeStateTypes";
import type {
  ActionType,
  BrainState,
  BridgeQuestionV1,
  ConversationStackV1,
  ExecutionMode,
  FailureTaxonomyResultV1,
  FirstPrinciplesPacketV1,
  MissionTimelineV1,
  PulseDecisionV1,
  ShellKindV1,
  TaskRequest,
  TaskRunResult,
  WorkflowRunReceiptV1
} from "../../src/core/types";
import {
  MISSION_UX_STATES_V1,
  STAGE_6_75_BLOCK_CODES,
  STAGE_6_86_BLOCK_CODES,
  STAGE_6_86_PULSE_DECISION_CODES
} from "../../src/core/types";

test("types.ts re-exports canonical governance constants and helpers", () => {
  assert.equal(ALL_GOVERNOR_IDS, CANONICAL_GOVERNOR_IDS);
  assert.equal(FULL_COUNCIL_GOVERNOR_IDS, CANONICAL_FULL_COUNCIL_IDS);
  assert.equal(isGovernorId, canonicalGovernanceIdGuard);
});

test("types.ts re-exports canonical constraint violation constants and helpers", () => {
  assert.equal(CONSTRAINT_VIOLATION_CODES, CANONICAL_CONSTRAINT_VIOLATION_CODES);
  assert.equal(isConstraintViolationCode, canonicalIsConstraintViolationCode);
});

test("types.ts re-exports canonical interface-facing runtime constants", () => {
  assert.equal(STAGE_6_86_BLOCK_CODES, CANONICAL_STAGE_6_86_BLOCK_CODES);
  assert.equal(STAGE_6_86_PULSE_DECISION_CODES, CANONICAL_STAGE_6_86_PULSE_DECISION_CODES);
});

test("types.ts re-exports canonical persistence/runtime constants", () => {
  assert.equal(STAGE_6_75_BLOCK_CODES, CANONICAL_STAGE_6_75_BLOCK_CODES);
  assert.equal(MISSION_UX_STATES_V1, CANONICAL_MISSION_UX_STATES_V1);
});

test("runtime type helpers still enforce the same deterministic guard behavior", () => {
  const actionType: ActionType = "probe_http";
  const executionMode: ExecutionMode = "escalation_path";
  const shellKind: ShellKindV1 = "zsh";
  const taskRequest: TaskRequest = {
    id: "task_1",
    goal: "Verify shared runtime contracts",
    userInput: "verify",
    createdAt: "2026-03-08T00:00:00.000Z"
  };

  assert.equal(actionType, "probe_http");
  assert.equal(executionMode, "escalation_path");
  assert.equal(shellKind, "zsh");
  assert.equal(taskRequest.id, "task_1");
  assert.equal(isGovernorId("security"), true);
  assert.equal(isGovernorId("not_a_governor"), false);
  assert.equal(isConstraintViolationCode("PROCESS_NOT_READY"), true);
  assert.equal(isConstraintViolationCode("NOT_A_REAL_VIOLATION"), false);
});

test("types.ts re-exports canonical interface-facing runtime contracts", () => {
  const stack: ConversationStackV1 = {
    schemaVersion: "v1",
    updatedAt: "2026-03-08T00:00:00.000Z",
    activeThreadKey: "thread_1",
    threads: [],
    topics: []
  };
  const decision: PulseDecisionV1 = {
    decisionCode: "EMIT",
    candidateId: "candidate_1",
    blockCode: null,
    blockDetailReason: null,
    evidenceRefs: [],
    sourceAuthority: "stale_runtime_context",
    provenanceTier: "supporting",
    sensitive: false,
    activeMissionSuppressed: false
  };
  const question: BridgeQuestionV1 = {
    questionId: "bridge_1",
    sourceEntityKey: "alice",
    targetEntityKey: "bob",
    prompt: "Are Alice and Bob related?",
    createdAt: "2026-03-08T00:00:00.000Z",
    cooldownUntil: "2026-03-09T00:00:00.000Z",
    threadKey: "thread_1",
    evidenceRefs: [],
    sourceAuthority: "stale_runtime_context",
    provenanceTier: "supporting",
    sensitive: false,
    activeMissionSuppressed: false
  };

  const canonicalStack: CanonicalConversationStackV1 = stack;
  const canonicalDecision: CanonicalPulseDecisionV1 = decision;
  const canonicalQuestion: CanonicalBridgeQuestionV1 = question;

  assert.equal(canonicalStack.activeThreadKey, "thread_1");
  assert.equal(canonicalDecision.decisionCode, "EMIT");
  assert.equal(canonicalQuestion.targetEntityKey, "bob");
});

test("types.ts re-exports canonical persistence/runtime contracts", () => {
  const workflowReceipt: WorkflowRunReceiptV1 = {
    runId: "run_1",
    scriptId: "script_1",
    operation: "replay_step",
    actionFamily: "computer_use",
    actionTypeBridge: "run_skill",
    approved: true,
    blockCode: null,
    conflictCode: null
  };
  const timeline: MissionTimelineV1 = {
    missionId: "mission_1",
    events: [
      {
        sequence: 1,
        phase: "verify",
        eventType: "receipt",
        detail: "workflow receipt recorded",
        observedAt: "2026-03-08T00:00:00.000Z"
      }
    ]
  };

  const canonicalWorkflowReceipt: CanonicalWorkflowRunReceiptV1 = workflowReceipt;
  const canonicalTimeline: CanonicalMissionTimelineV1 = timeline;

  assert.equal(canonicalWorkflowReceipt.operation, "replay_step");
  assert.equal(canonicalTimeline.events[0]?.eventType, "receipt");
});

test("types.ts re-exports canonical decision-support and runtime-state contracts", () => {
  const failure: FailureTaxonomyResultV1 = {
    failureCategory: "quality",
    failureCode: "quality_rejected"
  };
  const firstPrinciples: FirstPrinciplesPacketV1 = {
    required: true,
    triggerReasons: ["novel_task"],
    rubric: {
      facts: ["fact_1"],
      assumptions: ["assumption_1"],
      constraints: ["constraint_1"],
      unknowns: ["unknown_1"],
      minimalPlan: "do the smallest valid thing first"
    },
    validation: {
      valid: true,
      violationCodes: []
    }
  };
  const run: TaskRunResult = {
    task: {
      id: "task_2",
      goal: "persist state",
      userInput: "persist",
      createdAt: "2026-03-08T00:00:00.000Z"
    },
    plan: {
      taskId: "task_2",
      plannerNotes: "notes",
      actions: []
    },
    actionResults: [],
    summary: "ok",
    failureTaxonomy: failure,
    startedAt: "2026-03-08T00:00:00.000Z",
    completedAt: "2026-03-08T00:01:00.000Z"
  };
  const brainState: BrainState = {
    createdAt: "2026-03-08T00:00:00.000Z",
    runs: [run],
    metrics: {
      totalTasks: 1,
      totalActions: 0,
      approvedActions: 0,
      blockedActions: 0,
      fastPathActions: 0,
      escalationActions: 0
    }
  };

  const canonicalFailure: CanonicalFailureTaxonomyResultV1 = failure;
  const canonicalFirstPrinciples: CanonicalFirstPrinciplesPacketV1 = firstPrinciples;
  const canonicalRun: CanonicalTaskRunResult = run;
  const canonicalBrainState: CanonicalBrainState = brainState;

  assert.equal(canonicalFailure.failureCode, "quality_rejected");
  assert.equal(canonicalFirstPrinciples.required, true);
  assert.equal(canonicalRun.summary, "ok");
  assert.equal(canonicalBrainState.runs.length, 1);
});
