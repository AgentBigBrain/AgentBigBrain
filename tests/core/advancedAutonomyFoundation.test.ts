/**
 * @fileoverview Tests Stage 6.5 advanced-autonomy foundations for first-principles rigor, deterministic failure taxonomy, and workflow adaptation.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  adaptWorkflowPatterns,
  buildFailureTaxonomySignalFromRun,
  classifyFailureTaxonomy,
  createFirstPrinciplesRubric,
  validateFirstPrinciplesRubric
} from "../../src/core/advancedAutonomyFoundation";
import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { makeId } from "../../src/core/ids";
import { BrainOrchestrator } from "../../src/core/orchestrator";
import { PersonalityStore } from "../../src/core/personalityStore";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";
import { StateStore } from "../../src/core/stateStore";
import { TaskRequest, WorkflowPattern } from "../../src/core/types";
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
    goal: "Validate Stage 6.5 advanced autonomy foundations.",
    userInput,
    createdAt: new Date().toISOString()
  };
}

/**
 * Implements `withAdvancedAutonomyTestBrain` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withAdvancedAutonomyTestBrain(
  callback: (brain: BrainOrchestrator) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage6_5-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  const modelClient = new MockModelClient();
  const semanticMemory = new SemanticMemoryStore(path.join(tempDir, "runtime/semantic_memory.json"));
  const brain = new BrainOrchestrator(
    DEFAULT_BRAIN_CONFIG,
    new PlannerOrgan(modelClient, semanticMemory),
    new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG),
    createDefaultGovernors(),
    new MasterGovernor(DEFAULT_BRAIN_CONFIG.governance.supermajorityThreshold),
    new StateStore(path.join(tempDir, "runtime/state.json")),
    modelClient,
    new ReflectionOrgan(semanticMemory, modelClient),
    new PersonalityStore(path.join(tempDir, "runtime/personality_profile.json")),
    new GovernanceMemoryStore(path.join(tempDir, "runtime/governance_memory.json"))
  );

  try {
    await callback(brain);
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Implements `stage65FirstPrinciplesRubricValidationEnforcesRequiredSections` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function stage65FirstPrinciplesRubricValidationEnforcesRequiredSections(): void {
  const validRubric = createFirstPrinciplesRubric({
    facts: ["Current task requires file promotion control proof."],
    assumptions: ["No external provider outage during run."],
    constraints: ["Do not bypass hard constraints or governance votes."],
    unknowns: ["Whether provider response drift will require repair retry."],
    minimalPlan: "Create bounded plan, validate output shape, execute under governors."
  });
  const validResult = validateFirstPrinciplesRubric(validRubric);
  assert.equal(validResult.valid, true);
  assert.equal(validResult.violationCodes.length, 0);

  const invalidRubric = createFirstPrinciplesRubric({
    facts: [],
    assumptions: [],
    constraints: [],
    unknowns: [],
    minimalPlan: "too short"
  });
  const invalidResult = validateFirstPrinciplesRubric(invalidRubric);
  assert.equal(invalidResult.valid, false);
  assert.ok(invalidResult.violationCodes.includes("FIRST_PRINCIPLES_FACTS_REQUIRED"));
  assert.ok(invalidResult.violationCodes.includes("FIRST_PRINCIPLES_ASSUMPTIONS_REQUIRED"));
  assert.ok(invalidResult.violationCodes.includes("FIRST_PRINCIPLES_CONSTRAINTS_REQUIRED"));
  assert.ok(invalidResult.violationCodes.includes("FIRST_PRINCIPLES_UNKNOWNS_REQUIRED"));
  assert.ok(invalidResult.violationCodes.includes("FIRST_PRINCIPLES_MINIMAL_PLAN_REQUIRED"));
}

/**
 * Implements `stage65FailureTaxonomyClassifiesOutcomesDeterministically` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function stage65FailureTaxonomyClassifiesOutcomesDeterministically(): Promise<void> {
  const reasoningCategory = classifyFailureTaxonomy({
    blockCategory: "runtime",
    violationCodes: [],
    objectivePass: false,
    humanFeedbackOnly: false,
    summary: "Model output failed schema validation due to malformed payload."
  });
  assert.equal(reasoningCategory, "reasoning");

  const objectiveCategory = classifyFailureTaxonomy({
    blockCategory: "none",
    violationCodes: [],
    objectivePass: false,
    humanFeedbackOnly: false,
    summary: "Task failed outcome target despite no hard-constraint violations."
  });
  assert.equal(objectiveCategory, "objective");

  const qualityCategory = classifyFailureTaxonomy({
    blockCategory: "none",
    violationCodes: [],
    objectivePass: true,
    humanFeedbackOnly: false,
    summary: "Response quality was generic and not helpful for the user."
  });
  assert.equal(qualityCategory, "quality");

  const humanFeedbackCategory = classifyFailureTaxonomy({
    blockCategory: "none",
    violationCodes: [],
    objectivePass: true,
    humanFeedbackOnly: true,
    summary: "User disliked response style."
  });
  assert.equal(humanFeedbackCategory, "human_feedback");

  await withAdvancedAutonomyTestBrain(async (brain) => {
  const blockedRun = await brain.runTask(buildTask(`Delete ${WINDOWS_TEST_TOP_SECRET_FILE_PATH}`));
    const signal = buildFailureTaxonomySignalFromRun(blockedRun);
    const constraintCategory = classifyFailureTaxonomy(signal);
    assert.equal(constraintCategory, "constraint");
  });
}

/**
 * Implements `stage65WorkflowLearningAdaptsConfidenceWithDecayAndSupersession` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function stage65WorkflowLearningAdaptsConfidenceWithDecayAndSupersession(): void {
  const startingPatterns: readonly WorkflowPattern[] = [
    {
      id: "workflow_pattern_old_tax",
      workflowKey: "followup.tax.filing",
      status: "active",
      confidence: 0.8,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-15T00:00:00.000Z",
      supersededAt: null,
      domainLane: "workflow",
      successCount: 4,
      failureCount: 1,
      suppressedCount: 0,
      contextTags: ["tax", "followup"]
    },
    {
      id: "workflow_pattern_vet",
      workflowKey: "followup.vet.payment",
      status: "active",
      confidence: 0.6,
      firstSeenAt: "2026-01-20T00:00:00.000Z",
      lastSeenAt: "2026-02-10T00:00:00.000Z",
      supersededAt: null,
      domainLane: "workflow",
      successCount: 2,
      failureCount: 1,
      suppressedCount: 0,
      contextTags: ["vet"]
    }
  ];

  const result = adaptWorkflowPatterns(
    startingPatterns,
    {
      workflowKey: "followup.tax.completed",
      outcome: "success",
      observedAt: "2026-02-26T00:00:00.000Z",
      domainLane: "workflow",
      contextTags: ["tax", "complete"],
      supersedesKeys: ["followup.tax.filing"]
    },
    {
      decayIntervalDays: 7,
      decayStep: 0.05,
      successBoost: 0.1
    }
  );

  assert.ok(result.supersededPatternIds.includes("workflow_pattern_old_tax"));
  const supersededPattern = result.patterns.find(
    (pattern) => pattern.id === "workflow_pattern_old_tax"
  );
  assert.equal(supersededPattern?.status, "superseded");
  assert.equal(supersededPattern?.supersededAt, "2026-02-26T00:00:00.000Z");

  assert.equal(result.updatedPattern.workflowKey, "followup.tax.completed");
  assert.equal(result.updatedPattern.status, "active");
  assert.ok(result.updatedPattern.confidence > 0.55);

  const decayedVetPattern = result.patterns.find(
    (pattern) => pattern.id === "workflow_pattern_vet"
  );
  assert.ok((decayedVetPattern?.confidence ?? 0) < 0.6);
}

test(
  "stage 6.5 first-principles rubric validation enforces facts assumptions constraints unknowns and minimal plan",
  stage65FirstPrinciplesRubricValidationEnforcesRequiredSections
);
test(
  "stage 6.5 failure taxonomy classifies constraint objective reasoning quality and human-feedback outcomes deterministically",
  stage65FailureTaxonomyClassifiesOutcomesDeterministically
);
test(
  "stage 6.5 workflow learning updates confidence with decay and supersedes stale routines on changed behavior",
  stage65WorkflowLearningAdaptsConfidenceWithDecayAndSupersession
);
