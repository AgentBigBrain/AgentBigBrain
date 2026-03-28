/**
 * @fileoverview Tests Stage 6 autonomy-foundation policy packs, sandbox validation, promotion drills, objective reward evidence, memory correlation traces, and delegation harness behavior.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  AutonomyPromotionDrill,
  buildMemoryCorrelationTrace,
  createAutonomyProposalPolicyPack,
  deriveObjectiveRewardEvidence,
  evaluateGovernedPromotionCandidate,
  runSandboxValidationCycle,
  validateAutonomyProposalPolicyPack
} from "../../src/core/autonomyFoundation";
import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { evaluateSubagentDelegation } from "../../src/core/delegationPolicy";
import { evaluateHardConstraints } from "../../src/core/hardConstraints";
import { makeId } from "../../src/core/ids";
import { BrainOrchestrator } from "../../src/core/orchestrator";
import { PersonalityStore } from "../../src/core/personalityStore";
import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";
import { SemanticLesson } from "../../src/core/semanticMemory";
import { StateStore } from "../../src/core/stateStore";
import { GovernanceProposal, TaskRequest } from "../../src/core/types";
import { GovernanceMemoryStore } from "../../src/core/governanceMemory";
import { createDefaultGovernors } from "../../src/governors/defaultGovernors";
import { MasterGovernor } from "../../src/governors/masterGovernor";
import { MockModelClient } from "../../src/models/mockModelClient";
import { ToolExecutorOrgan } from "../../src/organs/executor";
import { PlannerOrgan } from "../../src/organs/planner";
import { ReflectionOrgan } from "../../src/organs/reflection";
import { WINDOWS_TEST_TOP_SECRET_FILE_PATH } from "../support/windowsPathFixtures";

/**
 * Implements `buildTask` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildTask(userInput: string): TaskRequest {
  return {
    id: makeId("task"),
    goal: "Validate Stage 6 autonomy foundation behavior.",
    userInput,
    createdAt: new Date().toISOString()
  };
}

/**
 * Implements `buildConstraintProposal` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildConstraintProposal(action: GovernanceProposal["action"]): GovernanceProposal {
  return {
    id: makeId("proposal"),
    taskId: makeId("task"),
    requestedBy: "stage6_test",
    rationale: "Validate deterministic tamper protections for Stage 6 evidence.",
    touchesImmutable: false,
    action
  };
}

/**
 * Implements `removeTempDirWithRetry` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function removeTempDirWithRetry(tempDir: string): Promise<void> {
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rm(tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code !== "EBUSY" &&
        code !== "ENOTEMPTY"
      ) {
        throw error;
      }
      if (attempt === maxAttempts) {
        // Windows can keep dynamic-imported files locked briefly; cleanup failure
        // is non-functional for assertions, so fail open after bounded retries.
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 75));
    }
  }
}

/**
 * Implements `withAutonomyTestBrain` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withAutonomyTestBrain(
  callback: (brain: BrainOrchestrator, memoryStore: SemanticMemoryStore) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage6-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  const modelClient = new MockModelClient();
  const memoryStore = new SemanticMemoryStore(path.join(tempDir, "runtime/semantic_memory.json"));
  const brain = new BrainOrchestrator(
    DEFAULT_BRAIN_CONFIG,
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG),
    createDefaultGovernors(),
    new MasterGovernor(DEFAULT_BRAIN_CONFIG.governance.supermajorityThreshold),
    new StateStore(path.join(tempDir, "runtime/state.json")),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    new PersonalityStore(path.join(tempDir, "runtime/personality_profile.json")),
    new GovernanceMemoryStore(path.join(tempDir, "runtime/governance_memory.json"))
  );

  try {
    await callback(brain, memoryStore);
  } finally {
    process.chdir(previousCwd);
    await removeTempDirWithRetry(tempDir);
  }
}

/**
 * Implements `stage6StructuredProposalGenerationEnforcesBoundedFields` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function stage6StructuredProposalGenerationEnforcesBoundedFields(): void {
  const validProposal = createAutonomyProposalPolicyPack({
    proposedByAgentId: "stella",
    title: "Harden promotion preflight checks",
    boundedScope: "Only modify stage6 promotion drill evidence tooling and keep runtime behavior unchanged.",
    hypothesis: "If promotion preflight is explicit and bounded, rollback reliability will improve during failed upgrades.",
    expectedMetric: "Rollback drill succeeds in 100% of repeated local rehearsals.",
    riskLevel: "low",
    rollbackPlan: "Restore previous skill snapshot and mark promotion as rolled_back."
  });
  const validResult = validateAutonomyProposalPolicyPack(validProposal);
  assert.equal(validResult.valid, true);
  assert.equal(validResult.violationCodes.length, 0);

  const invalidProposal = {
    ...validProposal,
    title: "x",
    hypothesis: "too short",
    expectedMetric: "",
    rollbackPlan: "",
    riskLevel: "critical"
  } as unknown as typeof validProposal;
  const invalidResult = validateAutonomyProposalPolicyPack(invalidProposal);
  assert.equal(invalidResult.valid, false);
  assert.ok(invalidResult.violationCodes.includes("PROPOSAL_TITLE_BOUNDS_INVALID"));
  assert.ok(invalidResult.violationCodes.includes("PROPOSAL_HYPOTHESIS_BOUNDS_INVALID"));
  assert.ok(invalidResult.violationCodes.includes("PROPOSAL_METRIC_BOUNDS_INVALID"));
  assert.ok(invalidResult.violationCodes.includes("PROPOSAL_ROLLBACK_BOUNDS_INVALID"));
  assert.ok(invalidResult.violationCodes.includes("PROPOSAL_RISK_LEVEL_INVALID"));
}

/**
 * Implements `stage6SandboxedValidationCycleRunsInIsolatedModeBeforePromotion` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function stage6SandboxedValidationCycleRunsInIsolatedModeBeforePromotion(): Promise<void> {
  const result = await runSandboxValidationCycle(
    "node -e \"process.stdout.write([process.env.BRAIN_RUNTIME_MODE,process.env.BRAIN_ENABLE_REAL_SHELL,process.env.BRAIN_ENABLE_REAL_NETWORK_WRITE].join('|'))\""
  );
  assert.equal(result.ok, true);
  assert.equal(result.enforcedRuntimeMode, "isolated");
  assert.ok(result.output.includes("isolated|false|false"));
}

/**
 * Implements `stage6GovernedPromotionControlUsesOrchestratorVotes` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function stage6GovernedPromotionControlUsesOrchestratorVotes(): Promise<void> {
  await withAutonomyTestBrain(async (brain) => {
    const result = await brain.runTask(
      buildTask("Create skill stage6_promoted_skill for stage 6 promotion evidence.")
    );
    const decision = evaluateGovernedPromotionCandidate(result);
    assert.equal(decision.approved, true);
    assert.equal(decision.blockedActionIds.length, 0);
    assert.ok(decision.approvedActionIds.length >= 1);

    const createdSkillPath = path.resolve(
      process.cwd(),
      "runtime/skills/stage6_promoted_skill.js"
    );
    const createdContent = await readFile(createdSkillPath, "utf8");
    assert.ok(createdContent.includes("generatedSkill"));
  });
}

/**
 * Implements `stage6RollbackDrillRestoresPreviousSkillSnapshot` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function stage6RollbackDrillRestoresPreviousSkillSnapshot(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage6-drill-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    const skillPath = path.resolve(tempDir, "runtime/skills/stage6_rehearsal.ts");
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, "export const previousVersion = true;\n", "utf8");

    const drill = new AutonomyPromotionDrill(
      path.resolve(tempDir, "runtime/evidence/stage6_promotion_drill.json"),
      path.resolve(tempDir, "runtime/skills")
    );
    await drill.prepareSkillPromotion(
      "proposal_stage6_rehearsal",
      "stage6_rehearsal",
      "export const promotedVersion = true;\n"
    );
    await drill.applyPromotion();
    const promotedContent = await readFile(skillPath, "utf8");
    assert.ok(promotedContent.includes("promotedVersion"));

    await drill.rollbackPromotion();
    const rolledBackContent = await readFile(skillPath, "utf8");
    assert.ok(rolledBackContent.includes("previousVersion"));

    const snapshot = await drill.readSnapshot();
    assert.equal(snapshot?.status, "rolled_back");
    const snapshotPath = path.resolve(tempDir, "runtime/evidence/stage6_promotion_drill.json");
    const persistedSnapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      skillPath: string;
    };
    assert.equal(persistedSnapshot.skillPath.endsWith(".ts"), true);
  } finally {
    process.chdir(previousCwd);
    await removeTempDirWithRetry(tempDir);
  }
}

/**
 * Implements `stage6ObjectiveRewardIntegrityUsesRuntimeOutcomeCounts` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function stage6ObjectiveRewardIntegrityUsesRuntimeOutcomeCounts(): Promise<void> {
  await withAutonomyTestBrain(async (brain) => {
    const approvedRun = await brain.runTask(buildTask("Say hello in one line."));
  const blockedRun = await brain.runTask(buildTask(`Delete ${WINDOWS_TEST_TOP_SECRET_FILE_PATH}`));

    const approvedEvidence = deriveObjectiveRewardEvidence(approvedRun);
    const blockedEvidence = deriveObjectiveRewardEvidence(blockedRun);

    assert.ok(approvedEvidence.approvedSafeActionCount >= 1);
    assert.equal(approvedEvidence.objectivePass, true);
    assert.ok(approvedEvidence.recommendedRewardPoints > 0);

    assert.ok(blockedEvidence.blockedActionCount >= 1);
    assert.equal(blockedEvidence.objectivePass, false);
  });
}

/**
 * Implements `stage6DotConnectingMemoryTraceShowsCorrelatedLessonLinks` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function stage6DotConnectingMemoryTraceShowsCorrelatedLessonLinks(): Promise<void> {
  await withAutonomyTestBrain(async (_brain, memoryStore) => {
    await memoryStore.appendLesson(
      "Use sandbox path guards for delete and list actions in risky file operations.",
      "task_stage6_a"
    );
    await memoryStore.appendLesson(
      "Sandbox guard policies reduce unsafe delete mistakes in file operations.",
      "task_stage6_b"
    );
    await memoryStore.appendLesson(
      "Keep governor rationale concise and deterministic.",
      "task_stage6_c"
    );

    const query = "How should sandbox delete guards prevent unsafe file operations?";
    const relevantLessons = await memoryStore.getRelevantLessons(query, 5);
    const trace = buildMemoryCorrelationTrace(relevantLessons, query);

    assert.ok(trace.retrievedLessonIds.length >= 2);
    assert.ok(trace.linkedEdgeCount >= 1);
    assert.ok(trace.influentialConcepts.includes("sandbox"));
  });
}

/**
 * Implements `stage6MemoryCorrelationTracePrioritizesQueryOverlapConcepts` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function stage6MemoryCorrelationTracePrioritizesQueryOverlapConcepts(): void {
  const now = new Date().toISOString();
  const relevantLessons: SemanticLesson[] = [
    {
      id: "lesson_trace_1",
      text: "Prevent regressions by improving process consistency.",
      sourceTaskId: "task_trace_1",
      committedByAgentId: "main-agent",
      createdAt: now,
      concepts: ["prevent", "process", "consistency"],
      relatedLessonIds: ["lesson_trace_2"],
      memoryType: "experience"
    },
    {
      id: "lesson_trace_2",
      text: "Process quality helps prevent failures across requests.",
      sourceTaskId: "task_trace_2",
      committedByAgentId: "main-agent",
      createdAt: now,
      concepts: ["process", "quality", "prevent", "requests"],
      relatedLessonIds: ["lesson_trace_1"],
      memoryType: "experience"
    },
    {
      id: "lesson_trace_3",
      text: "Unsafe workflow edges require explicit guardrails.",
      sourceTaskId: "task_trace_3",
      committedByAgentId: "main-agent",
      createdAt: now,
      concepts: ["unsafe", "workflow", "guardrails"],
      relatedLessonIds: [],
      memoryType: "experience"
    }
  ];

  const trace = buildMemoryCorrelationTrace(
    relevantLessons,
    "How should unsafe workflow requests be handled?"
  );

  const unsafeIndex = trace.influentialConcepts.indexOf("unsafe");
  const processIndex = trace.influentialConcepts.indexOf("process");
  assert.notEqual(unsafeIndex, -1);
  if (processIndex !== -1) {
    assert.ok(unsafeIndex < processIndex);
  }
}

/**
 * Implements `stage6DelegationSafetyHarnessEnforcesLimitsAndThresholds` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function stage6DelegationSafetyHarnessEnforcesLimitsAndThresholds(): void {
  const blockedDecision = evaluateSubagentDelegation(
    {
      capabilityGapScore: 0.9,
      parallelGainScore: 0.9,
      riskReductionScore: 0.8,
      budgetPressureScore: 0.1,
      currentSubagentCount: 2,
      requestedDepth: 1,
      requiresEscalationApproval: false
    },
    {
      maxSubagentsPerTask: 2,
      maxSubagentDepth: 1,
      spawnThresholdScore: 0.6
    }
  );
  assert.equal(blockedDecision.shouldSpawn, false);
  assert.ok(blockedDecision.blockedBy.includes("SUBAGENT_LIMIT_REACHED"));

  const allowedDecision = evaluateSubagentDelegation(
    {
      capabilityGapScore: 0.95,
      parallelGainScore: 0.85,
      riskReductionScore: 0.9,
      budgetPressureScore: 0.05,
      currentSubagentCount: 0,
      requestedDepth: 1,
      requiresEscalationApproval: false
    },
    {
      maxSubagentsPerTask: 2,
      maxSubagentDepth: 1,
      spawnThresholdScore: 0.6
    }
  );
  assert.equal(allowedDecision.shouldSpawn, true);
}

/**
 * Implements `stage6LearnedSkillConversationalReuseDemonstratesCreationToLaterInvocationTrace` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function stage6LearnedSkillConversationalReuseDemonstratesCreationToLaterInvocationTrace(): Promise<void> {
  await withAutonomyTestBrain(async (brain) => {
    const createRun = await brain.runTask(
      buildTask("Create skill stage6_reuse_skill for conversational reuse evidence.")
    );
    const promotionDecision = evaluateGovernedPromotionCandidate(createRun);
    assert.equal(promotionDecision.approved, true);

    const reuseRun = await brain.runTask(
      buildTask("Use skill stage6_reuse_skill with input:   hello stage 6   ")
    );
    const runSkillResult = reuseRun.actionResults.find(
      (result) => result.action.type === "run_skill"
    );

    assert.ok(runSkillResult);
    assert.equal(runSkillResult.approved, true);
    assert.match(runSkillResult.output ?? "", /Run skill success:/i);
    assert.match(runSkillResult.output ?? "", /hello stage 6/i);
  });
}

/**
 * Implements `stage6MemoryAccessAuditLoggingWritesAppendOnlyRetrievalEventsAndBlocksTampering` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function stage6MemoryAccessAuditLoggingWritesAppendOnlyRetrievalEventsAndBlocksTampering(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage6-audit-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  const modelClient = new MockModelClient();
  const memoryStore = new SemanticMemoryStore(path.join(tempDir, "runtime/semantic_memory.json"));
  const brain = new BrainOrchestrator(
    DEFAULT_BRAIN_CONFIG,
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG),
    createDefaultGovernors(),
    new MasterGovernor(DEFAULT_BRAIN_CONFIG.governance.supermajorityThreshold),
    new StateStore(path.join(tempDir, "runtime/state.json")),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    new PersonalityStore(path.join(tempDir, "runtime/personality_profile.json")),
    new GovernanceMemoryStore(path.join(tempDir, "runtime/governance_memory.json")),
    new ProfileMemoryStore(path.join(tempDir, "runtime/profile_memory.secure.json"), Buffer.alloc(32, 17), 90)
  );

  try {
    await brain.runTask(buildTask("I used to work with Owen at Lantern Studio."));
    await brain.runTask(buildTask("who is Owen?"));
    const firstRawAudit = await readFile(path.join(tempDir, "runtime/memory_access_log.json"), "utf8");
    const firstDocument = JSON.parse(firstRawAudit) as {
      events: Array<{
        queryHash: string;
        retrievedCount: number;
        redactedCount: number;
        domainLanes: string[];
      }>;
    };
    const firstCount = firstDocument.events.length;
    assert.ok(firstCount >= 1);

    await brain.runTask(buildTask("who is Owen?"));
    const secondRawAudit = await readFile(path.join(tempDir, "runtime/memory_access_log.json"), "utf8");
    const secondDocument = JSON.parse(secondRawAudit) as {
      events: Array<{
        queryHash: string;
        retrievedCount: number;
        redactedCount: number;
        domainLanes: string[];
      }>;
    };
    assert.ok(secondDocument.events.length > firstCount);

    const latestEvent = secondDocument.events[secondDocument.events.length - 1];
    assert.match(latestEvent.queryHash, /^[a-f0-9]{64}$/i);
    assert.ok(Number.isFinite(latestEvent.retrievedCount));
    assert.ok(Number.isFinite(latestEvent.redactedCount));
    assert.ok(Array.isArray(latestEvent.domainLanes));
    assert.ok(latestEvent.domainLanes.length >= 1);

    const writeTamperViolations = evaluateHardConstraints(
      buildConstraintProposal({
        id: makeId("action"),
        type: "write_file",
        description: "Attempt to overwrite memory-access log",
        params: { path: "runtime/memory_access_log.json", content: "tamper" },
        estimatedCostUsd: 0.1
      }),
      DEFAULT_BRAIN_CONFIG
    );
    assert.ok(
      writeTamperViolations.some((violation) => violation.code === "WRITE_PROTECTED_PATH")
    );

    const deleteTamperViolations = evaluateHardConstraints(
      buildConstraintProposal({
        id: makeId("action"),
        type: "delete_file",
        description: "Attempt to delete memory-access log",
        params: { path: "runtime/memory_access_log.json" },
        estimatedCostUsd: 0.1
      }),
      DEFAULT_BRAIN_CONFIG
    );
    assert.ok(
      deleteTamperViolations.some((violation) => violation.code === "DELETE_PROTECTED_PATH")
    );
  } finally {
    process.chdir(previousCwd);
    await removeTempDirWithRetry(tempDir);
  }
}

test(
  "stage 6 structured proposal generation enforces bounded hypothesis risk and metric fields",
  stage6StructuredProposalGenerationEnforcesBoundedFields
);
test(
  "stage 6 sandboxed validation cycle runs in isolated mode before promotion",
  stage6SandboxedValidationCycleRunsInIsolatedModeBeforePromotion
);
test(
  "stage 6 governed promotion control evaluates create_skill approvals through orchestrator votes",
  stage6GovernedPromotionControlUsesOrchestratorVotes
);
test(
  "stage 6 rollback drill restores previous skill snapshot after simulated regression",
  stage6RollbackDrillRestoresPreviousSkillSnapshot
);
test(
  "stage 6 objective reward integrity uses approved-safe action counts from runtime results",
  stage6ObjectiveRewardIntegrityUsesRuntimeOutcomeCounts
);
test(
  "stage 6 dot-connecting memory efficacy surfaces correlated lesson links",
  stage6DotConnectingMemoryTraceShowsCorrelatedLessonLinks
);
test(
  "stage 6 memory-correlation trace prioritizes concepts that overlap with the current ask",
  stage6MemoryCorrelationTracePrioritizesQueryOverlapConcepts
);
test(
  "stage 6 delegation safety harness enforces spawn threshold and hard limits",
  stage6DelegationSafetyHarnessEnforcesLimitsAndThresholds
);
test(
  "stage 6 learned skill conversational reuse demonstrates creation to later invocation trace",
  stage6LearnedSkillConversationalReuseDemonstratesCreationToLaterInvocationTrace
);
test(
  "stage 6 memory access audit logging writes append-only retrieval events and blocks tampering",
  stage6MemoryAccessAuditLoggingWritesAppendOnlyRetrievalEventsAndBlocksTampering
);
