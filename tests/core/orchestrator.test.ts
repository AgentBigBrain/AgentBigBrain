/**
 * @fileoverview End-to-end tests for planning, constraints, voting, and execution outcomes.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { makeId } from "../../src/core/ids";
import { BrainOrchestrator } from "../../src/core/orchestrator";
import { StateStore } from "../../src/core/stateStore";
import { TaskRequest } from "../../src/core/types";
import { createDefaultGovernors } from "../../src/governors/defaultGovernors";
import { MasterGovernor } from "../../src/governors/masterGovernor";
import { RuntimeTraceLogger } from "../../src/core/runtimeTraceLogger";
import { Stage685PlaybookPlanningContext } from "../../src/core/stage6_85PlaybookRuntime";
import { MockModelClient } from "../../src/models/mockModelClient";
import {
  ModelClient,
  ModelUsageSnapshot,
  PlannerModelOutput,
  StructuredCompletionRequest
} from "../../src/models/types";
import { ToolExecutorOrgan } from "../../src/organs/executor";
import { PlannerOrgan } from "../../src/organs/planner";
import { ReflectionOrgan } from "../../src/organs/reflection";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";
import { PersonalityStore } from "../../src/core/personalityStore";
import { GovernanceMemoryStore } from "../../src/core/governanceMemory";

/**
 * Implements `withTestBrain` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withTestBrain(
  callback: (
    brain: BrainOrchestrator,
    personalityStore: PersonalityStore,
    governanceMemoryStore: GovernanceMemoryStore
  ) => Promise<void>
): Promise<void> {
  await withTestBrainForModelAndConfig(new MockModelClient(), DEFAULT_BRAIN_CONFIG, callback);
}

/**
 * Implements `withTestBrainForModel` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withTestBrainForModel(
  modelClient: ModelClient,
  callback: (
    brain: BrainOrchestrator,
    personalityStore: PersonalityStore,
    governanceMemoryStore: GovernanceMemoryStore
  ) => Promise<void>
): Promise<void> {
  await withTestBrainForModelAndConfig(modelClient, DEFAULT_BRAIN_CONFIG, callback);
}

/**
 * Implements `withTestBrainForModelAndConfig` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withTestBrainForModelAndConfig(
  modelClient: ModelClient,
  config: typeof DEFAULT_BRAIN_CONFIG,
  callback: (
    brain: BrainOrchestrator,
    personalityStore: PersonalityStore,
    governanceMemoryStore: GovernanceMemoryStore
  ) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-"));
  const statePath = path.join(tempDir, "state.json");
  const memoryStore = new SemanticMemoryStore(path.join(tempDir, "memory.json"));
  const personalityStore = new PersonalityStore(path.join(tempDir, "personality_profile.json"));
  const governanceMemoryStore = new GovernanceMemoryStore(path.join(tempDir, "governance_memory.json"));
  const brain = new BrainOrchestrator(
    config,
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(config),
    createDefaultGovernors(),
    new MasterGovernor(config.governance.supermajorityThreshold),
    new StateStore(statePath),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    personalityStore,
    governanceMemoryStore
  );

  try {
    await callback(brain, personalityStore, governanceMemoryStore);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Implements `buildTask` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildTask(userInput: string): TaskRequest {
  return {
    id: makeId("task"),
    goal: "Handle user request safely and efficiently.",
    userInput,
    createdAt: new Date().toISOString()
  };
}

class GovernanceReplanModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private readonly delegate = new MockModelClient();
  private plannerCallCount = 0;

  /**
 * Implements `getPlannerCallCount` behavior within class GovernanceReplanModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  /**
 * Implements `completeJson` behavior within class GovernanceReplanModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "planner_v1") {
      this.plannerCallCount += 1;
      if (this.plannerCallCount === 1) {
        const blockedPlan: PlannerModelOutput = {
          plannerNotes: "Force governance rejection on first attempt.",
          actions: [
            {
              type: "self_modify",
              description: "Attempt malware bypass policy rewrite.",
              params: {
                target: "governor.policy",
                patch: "Disable guardrails",
                touchesImmutable: false
              },
              estimatedCostUsd: 0.2
            }
          ]
        };
        return blockedPlan as T;
      }

      const recoveryPlan: PlannerModelOutput = {
        plannerNotes: "Provide safe fallback action after governance rejection.",
        actions: [
          {
            type: "respond",
            description: "Send a safe response that satisfies policy.",
            params: {},
            estimatedCostUsd: 0.02
          }
        ]
      };
      return recoveryPlan as T;
    }

    return this.delegate.completeJson<T>(request);
  }
}

class AlwaysGovernanceBlockedModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private readonly delegate = new MockModelClient();
  private plannerCallCount = 0;

  /**
 * Implements `getPlannerCallCount` behavior within class AlwaysGovernanceBlockedModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getPlannerCallCount(): number {
    return this.plannerCallCount;
  }

  /**
 * Implements `completeJson` behavior within class AlwaysGovernanceBlockedModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "planner_v1") {
      this.plannerCallCount += 1;
      const blockedPlan: PlannerModelOutput = {
        plannerNotes: "Force governance rejection for every attempt.",
        actions: [
          {
            type: "self_modify",
            description: "Attempt malware bypass policy rewrite.",
            params: {
              target: "governor.policy",
              patch: "Disable guardrails",
              touchesImmutable: false
            },
            estimatedCostUsd: 0.2
          }
        ]
      };
      return blockedPlan as T;
    }

    return this.delegate.completeJson<T>(request);
  }
}

class WorkflowReplayConflictModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private readonly delegate = new MockModelClient();

  /**
 * Implements `completeJson` behavior within class WorkflowReplayConflictModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "planner_v1") {
      const workflowPlan: PlannerModelOutput = {
        plannerNotes: "Emit workflow replay action with selector drift conflict.",
        actions: [
          {
            type: "run_skill",
            description: "Run governed computer-use workflow replay step.",
            params: {
              name: "computer_use_runtime",
              actionFamily: "computer_use",
              operation: "replay_step",
              schemaSupported: true,
              windowFocused: true,
              navigationMatches: true,
              selectorFound: false,
              assertionPassed: true
            },
            estimatedCostUsd: 0.2
          }
        ]
      };
      return workflowPlan as T;
    }

    return this.delegate.completeJson<T>(request);
  }
}

class CumulativeBudgetModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private readonly delegate = new MockModelClient();

  /**
 * Implements `completeJson` behavior within class CumulativeBudgetModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "planner_v1") {
      const plan: PlannerModelOutput = {
        plannerNotes: "Emit two safe actions to exercise cumulative budget gate.",
        actions: [
          {
            type: "create_skill",
            description: "First create_skill action.",
            params: {
              name: "budget_skill_one",
              code: "export function budgetSkillOne(input: string): string { return input.trim(); }"
            },
            estimatedCostUsd: 0.01
          },
          {
            type: "create_skill",
            description: "Second create_skill action.",
            params: {
              name: "budget_skill_two",
              code: "export function budgetSkillTwo(input: string): string { return input.trim(); }"
            },
            estimatedCostUsd: 0.01
          }
        ]
      };
      return plan as T;
    }

    return this.delegate.completeJson<T>(request);
  }
}

class ModelSpendBudgetModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private readonly delegate = new MockModelClient();
  private usage: ModelUsageSnapshot = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedSpendUsd: 0
  };

  /**
 * Implements `getUsageSnapshot` behavior within class ModelSpendBudgetModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getUsageSnapshot(): ModelUsageSnapshot {
    return { ...this.usage };
  }

  /**
 * Implements `completeJson` behavior within class ModelSpendBudgetModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    this.usage.calls += 1;
    this.usage.promptTokens += 500;
    this.usage.completionTokens += 100;
    this.usage.totalTokens += 600;
    this.usage.estimatedSpendUsd = Number((this.usage.estimatedSpendUsd + 0.2).toFixed(8));
    return this.delegate.completeJson<T>(request);
  }
}

class RunSkillFailureModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private readonly delegate = new MockModelClient();

  /**
 * Implements `completeJson` behavior within class RunSkillFailureModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "planner_v1") {
      const runSkillPlan: PlannerModelOutput = {
        plannerNotes: "Emit run_skill action that fails at runtime.",
        actions: [
          {
            type: "run_skill",
            description: "Run missing deterministic CLI scaffold skill.",
            params: {
              name: "build_deterministic_typescript_cli",
              input: "build deterministic scaffold"
            },
            estimatedCostUsd: 0.1
          }
        ]
      };
      return runSkillPlan as T;
    }

    return this.delegate.completeJson<T>(request);
  }
}

class WriteFileMissingContentModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private readonly delegate = new MockModelClient();

  /**
  * Implements `completeJson` behavior within class WriteFileMissingContentModelClient.
  * Interacts with local collaborators through imported modules and typed inputs/outputs.
  */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "planner_v1") {
      const writeFilePlan: PlannerModelOutput = {
        plannerNotes: "Emit write_file action missing content to verify fail-closed execution handling.",
        actions: [
          {
            type: "write_file",
            description: "Write app file without required content payload.",
            params: {
              path: "runtime/generated/missing-content.txt"
            },
            estimatedCostUsd: 0.08
          }
        ]
      };
      return writeFilePlan as T;
    }

    return this.delegate.completeJson<T>(request);
  }
}

class RespondOnlyPlannerModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private readonly delegate = new MockModelClient();

  /**
 * Implements `completeJson` behavior within class RespondOnlyPlannerModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "planner_v1") {
      const respondPlan: PlannerModelOutput = {
        plannerNotes: "Emit deterministic respond-only plan for verification gate regression coverage.",
        actions: [
          {
            type: "respond",
            description: "Provide concise response text.",
            params: {
              message: "Deterministic respond output."
            },
            estimatedCostUsd: 0.02
          }
        ]
      };
      return respondPlan as T;
    }

    return this.delegate.completeJson<T>(request);
  }
}

class PreparedRespondExecutor extends ToolExecutorOrgan {
  private prepareCalls = 0;
  private executeCalls = 0;

  /**
 * Implements `getPrepareCalls` behavior within class PreparedRespondExecutor.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getPrepareCalls(): number {
    return this.prepareCalls;
  }

  /**
 * Implements `getExecuteCalls` behavior within class PreparedRespondExecutor.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getExecuteCalls(): number {
    return this.executeCalls;
  }

  /**
 * Implements `prepare` behavior within class PreparedRespondExecutor.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  override async prepare(action: Parameters<ToolExecutorOrgan["prepare"]>[0]): Promise<string | null> {
    this.prepareCalls += 1;
    if (action.type === "respond") {
      return "prepared reply from executor";
    }
    return super.prepare(action);
  }

  /**
 * Implements `execute` behavior within class PreparedRespondExecutor.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  override async execute(action: Parameters<ToolExecutorOrgan["execute"]>[0]): Promise<string> {
    this.executeCalls += 1;
    if (action.type === "respond") {
      throw new Error("respond execute should not run when prepared output exists");
    }
    return super.execute(action);
  }
}

class CapturingPlannerOrgan extends PlannerOrgan {
  private lastPlaybookSelection: Stage685PlaybookPlanningContext | null = null;

  /**
 * Implements `getLastPlaybookSelection` behavior within class CapturingPlannerOrgan.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getLastPlaybookSelection(): Stage685PlaybookPlanningContext | null {
    return this.lastPlaybookSelection;
  }

  /**
 * Implements `plan` behavior within class CapturingPlannerOrgan.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  override async plan(
    task: TaskRequest,
    plannerModel: string,
    synthesizerModel: string = plannerModel,
    options: Parameters<PlannerOrgan["plan"]>[3] = {}
  ): Promise<Awaited<ReturnType<PlannerOrgan["plan"]>>> {
    this.lastPlaybookSelection = options.playbookSelection ?? null;
    return super.plan(task, plannerModel, synthesizerModel, options);
  }
}

test("orchestrator approves fast-path response task", async () => {
  await withTestBrain(async (brain) => {
    const result = await brain.runTask(buildTask("Give me a concise status update."));
    assert.equal(result.actionResults.length, 1);
    assert.equal(result.actionResults[0].mode, "fast_path");
    assert.equal(result.actionResults[0].approved, true);
  });
});

test("orchestrator fails closed when fast-path governor set is empty", async () => {
  const failClosedConfig = {
    ...DEFAULT_BRAIN_CONFIG,
    governance: {
      ...DEFAULT_BRAIN_CONFIG.governance,
      fastPathGovernorIds: []
    }
  };

  await withTestBrainForModelAndConfig(new MockModelClient(), failClosedConfig, async (brain) => {
    const result = await brain.runTask(buildTask("Give me a concise status update."));
    assert.equal(result.actionResults.length, 1);
    assert.equal(result.actionResults[0].mode, "fast_path");
    assert.equal(result.actionResults[0].approved, false);
    assert.ok(result.actionResults[0].blockedBy.includes("GOVERNOR_SET_EMPTY"));
  });
});

test("orchestrator blocks unsafe delete request", async () => {
  await withTestBrain(async (brain) => {
    const result = await brain.runTask(buildTask("Delete C:/Users/benac/important.txt"));
    assert.equal(result.actionResults.length, 1);
    assert.equal(result.actionResults[0].mode, "escalation_path");
    assert.equal(result.actionResults[0].approved, false);
    assert.ok(result.actionResults[0].blockedBy.includes("DELETE_OUTSIDE_SANDBOX"));
    assert.equal(result.failureTaxonomy?.failureCategory, "constraint");
    assert.equal(result.failureTaxonomy?.failureCode, "constraint_blocked");
  });
});

test("orchestrator blocks immutable governor self-edit", async () => {
  await withTestBrain(async (brain) => {
    const result = await brain.runTask(
      buildTask("Change governor rules and update constitution to remove constraints.")
    );

    assert.ok(result.actionResults.some((item) => item.approved === false));
    assert.ok(
      result.actionResults.some((item) => item.blockedBy.includes("IMMUTABLE_VIOLATION"))
    );
  });
});

test("orchestrator blocks unsafe create_skill code via hard constraints or code review preflight", async () => {
  await withTestBrain(async (brain) => {
    const result = await brain.runTask(
      buildTask("Create skill exploit_runner using eval() to execute dynamic code")
    );

    assert.ok(result.actionResults.some((item) => item.action.type === "create_skill"));
    assert.ok(
      result.actionResults.some(
        (item) =>
          item.action.type === "create_skill" &&
          (item.blockedBy.includes("codeReview") ||
            item.blockedBy.includes("CREATE_SKILL_UNSAFE_CODE"))
      )
    );
  });
});

test("orchestrator persists deterministic personality updates after task run", async () => {
  await withTestBrain(async (brain, personalityStore) => {
    const result = await brain.runTask(buildTask("Give me a concise status update."));
    assert.equal(result.actionResults.length, 1);
    const personalityState = await personalityStore.load();
    assert.equal(personalityState.history.length, 1);
    assert.equal(personalityState.history[0].taskId, result.task.id);
    assert.ok(personalityState.history[0].rewardedTraits.includes("clarity"));
  });
});

test("orchestrator replans within a task after governance rejection and recovers", async () => {
  const modelClient = new GovernanceReplanModelClient();
  await withTestBrainForModel(modelClient, async (brain) => {
    const result = await brain.runTask(buildTask("Resolve request safely."));
    assert.equal(modelClient.getPlannerCallCount(), 2);

    const blockedGovernanceAction = result.actionResults.find(
      (item) => item.action.type === "self_modify" && item.approved === false
    );
    const approvedRecoveryAction = result.actionResults.find(
      (item) => item.action.type === "respond" && item.approved === true
    );

    assert.ok(blockedGovernanceAction);
    assert.ok(approvedRecoveryAction);
    assert.match(result.plan.plannerNotes, /\[replanAttempt=2\]/);
  });
});

test("orchestrator enforces Stage 6.85 retry stop-limit with deterministic recovery postmortem summary", async () => {
  const modelClient = new AlwaysGovernanceBlockedModelClient();
  const constrainedConfig = {
    ...DEFAULT_BRAIN_CONFIG,
    limits: {
      ...DEFAULT_BRAIN_CONFIG.limits,
      maxPlanAttemptsPerTask: 2
    }
  };

  await withTestBrainForModelAndConfig(modelClient, constrainedConfig, async (brain) => {
    const result = await brain.runTask(buildTask("Resolve request safely under strict policy."));
    assert.equal(modelClient.getPlannerCallCount(), 2);
    assert.equal(result.actionResults.every((entry) => entry.approved === false), true);
    assert.match(result.summary, /MISSION_STOP_LIMIT_REACHED/);
  });
});

test("orchestrator blocks workflow replay drift in live task runner path", async () => {
  const modelClient = new WorkflowReplayConflictModelClient();
  await withTestBrainForModel(modelClient, async (brain) => {
    const result = await brain.runTask(buildTask("Replay this captured workflow deterministically."));
    assert.equal(result.actionResults.length, 1);
    assert.equal(result.actionResults[0]?.approved, false);
    assert.equal(result.actionResults[0]?.blockedBy.includes("WORKFLOW_DRIFT_DETECTED"), true);
    assert.equal(
      result.actionResults[0]?.violations.some(
        (violation) => violation.code === "WORKFLOW_DRIFT_DETECTED"
      ),
      true
    );
  });
});

test("orchestrator enforces cumulative budget in runtime path", async () => {
  const modelClient = new CumulativeBudgetModelClient();
  const constrainedConfig = {
    ...DEFAULT_BRAIN_CONFIG,
    limits: {
      ...DEFAULT_BRAIN_CONFIG.limits,
      maxEstimatedCostUsd: 1.25,
      maxCumulativeEstimatedCostUsd: 0.3
    }
  };

  await withTestBrainForModelAndConfig(modelClient, constrainedConfig, async (brain) => {
    const result = await brain.runTask(buildTask("Return two concise responses."));
    assert.equal(result.actionResults.length, 2);
    assert.equal(result.actionResults[0].approved, true);
    assert.equal(result.actionResults[1].approved, false);
    assert.ok(
      result.actionResults[1].blockedBy.includes("CUMULATIVE_COST_LIMIT_EXCEEDED")
    );
    assert.match(result.summary, /Estimated approved action cost 0.22\/0.30 USD/i);
  });
});

test("orchestrator blocks actions when cumulative model spend limit is exceeded", async () => {
  const modelClient = new ModelSpendBudgetModelClient();
  const constrainedConfig = {
    ...DEFAULT_BRAIN_CONFIG,
    limits: {
      ...DEFAULT_BRAIN_CONFIG.limits,
      maxCumulativeModelSpendUsd: 0.1
    }
  };

  await withTestBrainForModelAndConfig(modelClient, constrainedConfig, async (brain) => {
    const result = await brain.runTask(buildTask("Give me a concise status update."));
    assert.equal(result.actionResults.length, 1);
    assert.equal(result.actionResults[0].approved, false);
    assert.ok(result.actionResults[0].blockedBy.includes("MODEL_SPEND_LIMIT_EXCEEDED"));
    assert.ok(result.modelUsage);
    assert.equal(result.modelUsage?.calls >= 1, true);
    assert.equal(result.modelUsage?.estimatedSpendUsd > 0.1, true);
  });
});

test("orchestrator fails closed when approved run_skill execution returns deterministic failure output", async () => {
  const modelClient = new RunSkillFailureModelClient();

  await withTestBrainForModel(modelClient, async (brain) => {
    const result = await brain.runTask(
      buildTask("Run skill build_deterministic_typescript_cli to build deterministic TypeScript CLI scaffold.")
    );
    assert.equal(result.actionResults.length, 1);
    assert.equal(result.actionResults[0].approved, false);
    assert.equal(result.actionResults[0].executionStatus, "failed");
    assert.equal(result.actionResults[0].executionFailureCode, "RUN_SKILL_ARTIFACT_MISSING");
    assert.ok(result.actionResults[0].blockedBy.includes("RUN_SKILL_ARTIFACT_MISSING"));
    assert.equal(
      result.actionResults[0].violations.some(
        (violation) => violation.code === "RUN_SKILL_ARTIFACT_MISSING"
      ),
      true
    );
    assert.match(result.actionResults[0].output ?? "", /Run skill failed: no skill artifact found/i);
    assert.match(result.summary, /0 approved action\(s\) and 1 blocked action\(s\)/i);
    assert.doesNotMatch(result.summary, /Recovery postmortem: MISSION_STOP_LIMIT_REACHED/i);
  });
});

test("orchestrator fails closed when approved write_file execution is missing params.content", async () => {
  const modelClient = new WriteFileMissingContentModelClient();

  await withTestBrainForModel(modelClient, async (brain) => {
    const result = await brain.runTask(
      buildTask("Create a file but omit content to verify fail-closed execution behavior.")
    );
    assert.equal(result.actionResults.length, 1);
    assert.equal(result.actionResults[0].approved, false);
    assert.equal(result.actionResults[0].executionStatus, "blocked");
    assert.equal(result.actionResults[0].executionFailureCode, "ACTION_EXECUTION_FAILED");
    assert.ok(result.actionResults[0].blockedBy.includes("ACTION_EXECUTION_FAILED"));
    assert.equal(
      result.actionResults[0].violations.some(
        (violation) => violation.code === "ACTION_EXECUTION_FAILED"
      ),
      true
    );
    assert.match(result.actionResults[0].output ?? "", /missing params\.content/i);
    assert.match(result.summary, /0 approved action\(s\) and 1 blocked action\(s\)/i);
  });
});

test("orchestrator does not overblock respond-only research prompts with verification gate failures", async () => {
  const modelClient = new RespondOnlyPlannerModelClient();

  await withTestBrainForModel(modelClient, async (brain) => {
    const result = await brain.runTask(
      buildTask("Research deterministic sandboxing controls and provide distilled findings with proof refs.")
    );
    assert.equal(result.actionResults.length, 1);
    assert.equal(result.actionResults[0].action.type, "respond");
    assert.equal(result.actionResults[0].approved, true);
    assert.equal(result.actionResults[0].blockedBy.includes("VERIFICATION_GATE_FAILED"), false);
  });
});

test("orchestrator fail-closes completion-claim prompts when deterministic proof artifacts are missing", async () => {
  const modelClient = new RespondOnlyPlannerModelClient();

  await withTestBrainForModel(modelClient, async (brain) => {
    const result = await brain.runTask(
      buildTask(
        "Claim this task is complete only if deterministic proof artifacts exist; otherwise block the done claim."
      )
    );
    assert.equal(result.actionResults.length, 1);
    assert.equal(result.actionResults[0].action.type, "respond");
    assert.equal(result.actionResults[0].approved, false);
    assert.equal(result.actionResults[0].blockedBy.includes("VERIFICATION_GATE_FAILED"), true);
    assert.equal(
      result.actionResults[0].violations.some(
        (violation) => violation.code === "VERIFICATION_GATE_FAILED"
      ),
      true
    );
  });
});

test("orchestrator does not enforce verification gate for system pulse prompts containing historical completion-claim text in context", async () => {
  const modelClient = new RespondOnlyPlannerModelClient();
  const pulsePrompt = [
    "System-generated Agent Pulse check-in request.",
    "Return one concise proactive check-in message as an explicit AI assistant identity.",
    "",
    "Agent Pulse request:",
    "Agent Pulse proactive check-in request.",
    "Reason code: stale_fact_revalidation",
    "Generate one concise, friendly follow-up message in explicit AI assistant identity.",
    "",
    "Recent conversation context (oldest to newest):",
    "- user: Claim this task is complete only if deterministic proof artifacts exist; otherwise block the done claim."
  ].join("\n");

  await withTestBrainForModel(modelClient, async (brain) => {
    const result = await brain.runTask(buildTask(pulsePrompt));
    assert.equal(result.actionResults.length, 1);
    assert.equal(result.actionResults[0].action.type, "respond");
    assert.equal(result.actionResults[0].approved, true);
    assert.equal(result.actionResults[0].blockedBy.includes("VERIFICATION_GATE_FAILED"), false);
  });
});

test("orchestrator appends governance-memory events for approved and blocked actions", async () => {
  await withTestBrain(async (brain, _personalityStore, governanceMemoryStore) => {
    await brain.runTask(buildTask("Give me a concise status update."));
    await brain.runTask(buildTask("Delete C:/Users/benac/important.txt"));

    const view = await governanceMemoryStore.getReadView(10);
    assert.equal(view.totalEvents >= 2, true);
    assert.equal(
      view.recentEvents.some((event) => event.outcome === "approved"),
      true
    );
    assert.equal(
      view.recentEvents.some(
        (event) =>
          event.outcome === "blocked" &&
          event.blockCategory === "constraints" &&
          event.violationCodes.includes("DELETE_OUTSIDE_SANDBOX")
      ),
      true
    );
  });
});

test("poisoned governance memory cannot bypass hard constraints", async () => {
  await withTestBrain(async (brain, _personalityStore, governanceMemoryStore) => {
    await governanceMemoryStore.appendEvent({
      taskId: "poison-seed-task",
      proposalId: "poison-seed-proposal",
      actionId: "poison-seed-action",
      actionType: "delete_file",
      mode: "escalation_path",
      outcome: "approved",
      blockCategory: "none",
      blockedBy: [],
      violationCodes: [],
      yesVotes: 7,
      noVotes: 0,
      threshold: 6,
      dissentGovernorIds: []
    });

    const result = await brain.runTask(buildTask("Delete C:/Users/benac/important.txt"));
    assert.equal(result.actionResults.length, 1);
    assert.equal(result.actionResults[0].approved, false);
    assert.equal(
      result.actionResults[0].blockedBy.includes("DELETE_OUTSIDE_SANDBOX"),
      true
    );
  });
});

test("orchestrator uses prepared respond output before execute to reduce response latency", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-prep-"));
  const statePath = path.join(tempDir, "state.json");
  const memoryStore = new SemanticMemoryStore(path.join(tempDir, "memory.json"));
  const personalityStore = new PersonalityStore(path.join(tempDir, "personality_profile.json"));
  const governanceMemoryStore = new GovernanceMemoryStore(path.join(tempDir, "governance_memory.json"));
  const modelClient = new MockModelClient();
  const executor = new PreparedRespondExecutor(DEFAULT_BRAIN_CONFIG);

  const brain = new BrainOrchestrator(
    DEFAULT_BRAIN_CONFIG,
    new PlannerOrgan(modelClient, memoryStore),
    executor,
    createDefaultGovernors(),
    new MasterGovernor(DEFAULT_BRAIN_CONFIG.governance.supermajorityThreshold),
    new StateStore(statePath),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    personalityStore,
    governanceMemoryStore
  );

  try {
    const result = await brain.runTask(buildTask("say hello"));
    assert.equal(result.actionResults.length, 1);
    assert.equal(result.actionResults[0].approved, true);
    assert.equal(result.actionResults[0].output, "prepared reply from executor");
    assert.equal(executor.getPrepareCalls() >= 1, true);
    assert.equal(executor.getExecuteCalls(), 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("orchestrator injects deterministic playbook selection context into planner runs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-playbook-plan-"));
  const statePath = path.join(tempDir, "state.json");
  const memoryStore = new SemanticMemoryStore(path.join(tempDir, "memory.json"));
  const personalityStore = new PersonalityStore(path.join(tempDir, "personality_profile.json"));
  const governanceMemoryStore = new GovernanceMemoryStore(path.join(tempDir, "governance_memory.json"));
  const modelClient = new MockModelClient();
  const capturingPlanner = new CapturingPlannerOrgan(modelClient, memoryStore);

  const playbookSelection: Stage685PlaybookPlanningContext = {
    selectedPlaybookId: "playbook_stage685_a_build",
    selectedPlaybookName: "Candidate playbook for Build deterministic backup CLI",
    fallbackToPlanner: false,
    reason: "Deterministic playbook match selected from explicit score components.",
    requestedTags: ["build", "cli", "verify"],
    requiredInputSchema: "build_cli_v1",
    registryValidated: true,
    scoreSummary: [
      {
        playbookId: "playbook_stage685_a_build",
        score: 1.107775
      }
    ]
  };

  const brain = new BrainOrchestrator(
    DEFAULT_BRAIN_CONFIG,
    capturingPlanner,
    new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG),
    createDefaultGovernors(),
    new MasterGovernor(DEFAULT_BRAIN_CONFIG.governance.supermajorityThreshold),
    new StateStore(statePath),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    personalityStore,
    governanceMemoryStore,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => playbookSelection
  );

  try {
    const result = await brain.runTask(
      buildTask("Build and test a deterministic TypeScript CLI scaffold with runbook and tests.")
    );
    assert.equal(result.actionResults.length >= 1, true);
    assert.equal(
      capturingPlanner.getLastPlaybookSelection()?.selectedPlaybookId,
      "playbook_stage685_a_build"
    );
    assert.match(result.plan.plannerNotes, /\[playbook=playbook_stage685_a_build\]/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("orchestrator emits structured runtime trace events when tracing is enabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-trace-orchestrator-"));
  const statePath = path.join(tempDir, "state.json");
  const tracePath = path.join(tempDir, "runtime_trace.jsonl");
  const memoryStore = new SemanticMemoryStore(path.join(tempDir, "memory.json"));
  const personalityStore = new PersonalityStore(path.join(tempDir, "personality_profile.json"));
  const governanceMemoryStore = new GovernanceMemoryStore(path.join(tempDir, "governance_memory.json"));
  const modelClient = new MockModelClient();

  const configWithTrace = {
    ...DEFAULT_BRAIN_CONFIG,
    observability: {
      ...DEFAULT_BRAIN_CONFIG.observability,
      traceEnabled: true,
      traceLogPath: tracePath
    }
  };

  const brain = new BrainOrchestrator(
    configWithTrace,
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(configWithTrace),
    createDefaultGovernors(),
    new MasterGovernor(configWithTrace.governance.supermajorityThreshold),
    new StateStore(statePath),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    personalityStore,
    governanceMemoryStore
  );

  try {
    const result = await brain.runTask(buildTask("Give me a concise status update."));
    assert.equal(result.actionResults.length, 1);

    const traceLogger = new RuntimeTraceLogger({
      enabled: true,
      filePath: tracePath
    });
    const events = await traceLogger.readEvents();
    const eventTypes = events.map((event) => event.eventType);

    assert.equal(eventTypes.includes("task_started"), true);
    assert.equal(eventTypes.includes("planner_completed"), true);
    assert.equal(eventTypes.includes("governance_voted"), true);
    assert.equal(eventTypes.includes("action_executed"), true);
    assert.equal(eventTypes.includes("task_completed"), true);

    const plannerEvent = events.find((event) => event.eventType === "planner_completed");
    assert.equal(typeof plannerEvent?.durationMs, "number");
    assert.equal((plannerEvent?.durationMs ?? -1) >= 0, true);

    const governancePersisted = events.find(
      (event) =>
        event.eventType === "governance_event_persisted" &&
        event.actionId === result.actionResults[0].action.id
    );
    assert.equal(typeof governancePersisted?.governanceEventId, "string");
    assert.equal((governancePersisted?.governanceEventId?.length ?? 0) > 0, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test(
  "orchestrator traces first-principles and typed failure taxonomy details for blocked high-risk runs",
  async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-trace-risk-blocked-"));
    const statePath = path.join(tempDir, "state.json");
    const tracePath = path.join(tempDir, "runtime_trace.jsonl");
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "memory.json"));
    const personalityStore = new PersonalityStore(path.join(tempDir, "personality_profile.json"));
    const governanceMemoryStore = new GovernanceMemoryStore(path.join(tempDir, "governance_memory.json"));
    const modelClient = new MockModelClient();

    const configWithTrace = {
      ...DEFAULT_BRAIN_CONFIG,
      observability: {
        ...DEFAULT_BRAIN_CONFIG.observability,
        traceEnabled: true,
        traceLogPath: tracePath
      }
    };

    const brain = new BrainOrchestrator(
      configWithTrace,
      new PlannerOrgan(modelClient, memoryStore),
      new ToolExecutorOrgan(configWithTrace),
      createDefaultGovernors(),
      new MasterGovernor(configWithTrace.governance.supermajorityThreshold),
      new StateStore(statePath),
      modelClient,
      new ReflectionOrgan(memoryStore, modelClient),
      personalityStore,
      governanceMemoryStore
    );

    try {
      const result = await brain.runTask(buildTask("Delete C:/Users/benac/important.txt"));
      assert.equal(result.failureTaxonomy?.failureCategory, "constraint");
      assert.equal(result.failureTaxonomy?.failureCode, "constraint_blocked");

      const traceLogger = new RuntimeTraceLogger({
        enabled: true,
        filePath: tracePath
      });
      const events = await traceLogger.readEvents();
      const plannerEvent = events.find((event) => event.eventType === "planner_completed");
      const plannerDetails = (plannerEvent?.details ?? {}) as Record<string, unknown>;
      assert.equal(plannerDetails.firstPrinciplesRequired, true);
      assert.equal(Number(plannerDetails.firstPrinciplesTriggerCount ?? 0) >= 1, true);

      const taskCompletedEvent = events.find((event) => event.eventType === "task_completed");
      const taskCompletedDetails = (taskCompletedEvent?.details ?? {}) as Record<string, unknown>;
      assert.equal(taskCompletedDetails.firstPrinciplesRequired, true);
      assert.equal(taskCompletedDetails.failureCategory, "constraint");
      assert.equal(taskCompletedDetails.failureCode, "constraint_blocked");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
);
