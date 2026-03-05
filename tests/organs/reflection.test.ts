/**
 * @fileoverview Tests reflection behavior for blocked-action learning, success reflection, and model-failure resilience.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DistillerMergeLedgerStore } from "../../src/core/distillerLedger";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";
import { SatelliteCloneCoordinator } from "../../src/core/satelliteClone";
import { ActionRunResult, TaskRunResult } from "../../src/core/types";
import { MockModelClient } from "../../src/models/mockModelClient";
import {
  ModelClient,
  ReflectionModelOutput,
  StructuredCompletionRequest,
  SuccessReflectionModelOutput
} from "../../src/models/types";
import { ReflectionOrgan } from "../../src/organs/reflection";

class FailingReflectionModelClient implements ModelClient {
  readonly backend = "mock" as const;

  /**
   * Implements `completeJson` behavior within class FailingReflectionModelClient.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  async completeJson<T>(_request: StructuredCompletionRequest): Promise<T> {
    throw new Error("forced model failure");
  }
}

class StaticReflectionModelClient implements ModelClient {
  readonly backend = "mock" as const;

  /**
   * Initializes class StaticReflectionModelClient dependencies and runtime state.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  constructor(
    private readonly failureOutput: ReflectionModelOutput,
    private readonly successOutput: SuccessReflectionModelOutput
  ) {}

  /**
   * Implements `completeJson` behavior within class StaticReflectionModelClient.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "reflection_v1") {
      return this.failureOutput as T;
    }
    if (request.schemaName === "reflection_success_v1") {
      return this.successOutput as T;
    }
    throw new Error(`Unexpected schema requested: ${request.schemaName}`);
  }
}

/**
 * Implements `buildRunResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildRunResult(actionResults: ActionRunResult[], agentId?: string): TaskRunResult {
  return {
    task: {
      id: "task_reflection",
      agentId,
      goal: "Learn from blocked actions",
      userInput: "Try action",
      createdAt: new Date().toISOString()
    },
    plan: {
      taskId: "task_reflection",
      plannerNotes: "test",
      actions: actionResults.map((item) => item.action)
    },
    actionResults,
    summary: "reflection test summary",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
}

/**
 * Implements `withReflectionStore` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withReflectionStore(
  callback: (store: SemanticMemoryStore, tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-reflection-"));
  const memoryPath = path.join(tempDir, "semantic_memory.json");
  const store = new SemanticMemoryStore(memoryPath);

  try {
    await callback(store, tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("ReflectionOrgan stores lessons when actions are blocked", async () => {
  await withReflectionStore(async (store) => {
    const organ = new ReflectionOrgan(store, new MockModelClient());
    const blockedRun = buildRunResult([
      {
        action: {
          id: "action_blocked",
          type: "delete_file",
          description: "delete",
          params: { path: "C:/unsafe.txt" },
          estimatedCostUsd: 0.1
        },
        mode: "escalation_path",
        approved: false,
        blockedBy: ["DELETE_OUTSIDE_SANDBOX"],
        violations: [{ code: "DELETE_OUTSIDE_SANDBOX", message: "blocked" }],
        votes: []
      }
    ], "atlas-1001");

    await organ.reflectOnTask(blockedRun, "mock-planner");
    const memory = await store.load();
    assert.equal(memory.lessons.length, 1);
    assert.equal(memory.lessons[0].committedByAgentId, "atlas-1001");
    assert.ok(memory.lessons[0].signalMetadata);
    assert.equal(memory.lessons[0].signalMetadata?.rulepackVersion, "LessonSignalRulepackV1");
    assert.equal(memory.lessons[0].signalMetadata?.source, "reflection_failure");
  });
});

test("ReflectionOrgan does not store lessons when all actions are approved", async () => {
  await withReflectionStore(async (store) => {
    const organ = new ReflectionOrgan(store, new MockModelClient());
    const approvedRun = buildRunResult([
      {
        action: {
          id: "action_ok",
          type: "respond",
          description: "respond",
          params: {},
          estimatedCostUsd: 0.01
        },
        mode: "fast_path",
        approved: true,
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]);

    await organ.reflectOnTask(approvedRun, "mock-planner");
    const memory = await store.load();
    assert.equal(memory.lessons.length, 0);
  });
});

test("ReflectionOrgan handles model failure without throwing", async () => {
  await withReflectionStore(async (store) => {
    const organ = new ReflectionOrgan(store, new FailingReflectionModelClient());
    const blockedRun = buildRunResult([
      {
        action: {
          id: "action_blocked",
          type: "shell_command",
          description: "shell",
          params: { command: "echo hi" },
          estimatedCostUsd: 0.1
        },
        mode: "escalation_path",
        approved: false,
        blockedBy: ["SHELL_DISABLED_BY_POLICY"],
        violations: [{ code: "SHELL_DISABLED_BY_POLICY", message: "blocked" }],
        votes: []
      }
    ]);

    await organ.reflectOnTask(blockedRun, "mock-planner");
    const memory = await store.load();
    assert.equal(memory.lessons.length, 0);
  });
});

test("ReflectionOrgan stores success lesson when reflectOnSuccess is enabled", async () => {
  await withReflectionStore(async (store) => {
    const organ = new ReflectionOrgan(store, new MockModelClient(), { reflectOnSuccess: true });
    const approvedRun = buildRunResult([
      {
        action: {
          id: "action_ok",
          type: "respond",
          description: "respond to user",
          params: {},
          estimatedCostUsd: 0.01
        },
        mode: "fast_path",
        approved: true,
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]);

    await organ.reflectOnTask(approvedRun, "mock-planner");
    const memory = await store.load();
    assert.ok(memory.lessons.length >= 1, "Expected at least 1 success lesson");
    assert.ok(
      memory.lessons[0].text.length > 0,
      "Success lesson text should not be empty"
    );
    assert.ok(memory.lessons[0].signalMetadata);
    assert.equal(memory.lessons[0].signalMetadata?.rulepackVersion, "LessonSignalRulepackV1");
    assert.equal(memory.lessons[0].signalMetadata?.source, "reflection_success");
  });
});

test("ReflectionOrgan skips success reflection when flag is disabled (default)", async () => {
  await withReflectionStore(async (store) => {
    const organ = new ReflectionOrgan(store, new MockModelClient());
    const approvedRun = buildRunResult([
      {
        action: {
          id: "action_ok",
          type: "read_file",
          description: "read a file",
          params: { path: "runtime/sandbox/test.txt" },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]);

    await organ.reflectOnTask(approvedRun, "mock-planner");
    const memory = await store.load();
    assert.equal(memory.lessons.length, 0, "No lessons when reflectOnSuccess is false");
  });
});

test("ReflectionOrgan handles success reflection model failure gracefully", async () => {
  await withReflectionStore(async (store) => {
    const organ = new ReflectionOrgan(store, new FailingReflectionModelClient(), { reflectOnSuccess: true });
    const approvedRun = buildRunResult([
      {
        action: {
          id: "action_ok",
          type: "respond",
          description: "respond",
          params: {},
          estimatedCostUsd: 0.01
        },
        mode: "fast_path",
        approved: true,
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]);

    await organ.reflectOnTask(approvedRun, "mock-planner");
    const memory = await store.load();
    assert.equal(memory.lessons.length, 0, "No lessons when model fails");
  });
});

test("ReflectionOrgan skips low-signal success lessons", async () => {
  await withReflectionStore(async (store) => {
    const organ = new ReflectionOrgan(
      store,
      new StaticReflectionModelClient(
        {
          lessons: []
        },
        {
          lesson:
            "Prioritizing user engagement through a friendly greeting enhances the overall user experience.",
          nearMiss: null
        }
      ),
      { reflectOnSuccess: true }
    );
    const approvedRun = buildRunResult([
      {
        action: {
          id: "action_ok",
          type: "respond",
          description: "respond to user",
          params: {},
          estimatedCostUsd: 0.01
        },
        mode: "fast_path",
        approved: true,
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]);

    await organ.reflectOnTask(approvedRun, "mock-planner");
    const memory = await store.load();
    assert.equal(memory.lessons.length, 0);
  });
});

test("ReflectionOrgan suppresses generic clarification lessons in success mode", async () => {
  await withReflectionStore(async (store) => {
    const organ = new ReflectionOrgan(
      store,
      new StaticReflectionModelClient(
        {
          lessons: []
        },
        {
          lesson:
            "Clarifying user requirements upfront leads to efficient and successful task execution.",
          nearMiss: null
        }
      ),
      { reflectOnSuccess: true }
    );
    const approvedRun = buildRunResult([
      {
        action: {
          id: "action_clarify",
          type: "respond",
          description: "clarify migration requirements before response",
          params: {},
          estimatedCostUsd: 0.01
        },
        mode: "fast_path",
        approved: true,
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]);

    await organ.reflectOnTask(approvedRun, "mock-planner");
    const memory = await store.load();
    assert.equal(memory.lessons.length, 0);
  });
});

test("ReflectionOrgan suppresses generic user-context success lessons", async () => {
  await withReflectionStore(async (store) => {
    const organ = new ReflectionOrgan(
      store,
      new StaticReflectionModelClient(
        {
          lessons: []
        },
        {
          lesson:
            "Thorough understanding of user context led to a precise and relevant response.",
          nearMiss: null
        }
      ),
      { reflectOnSuccess: true }
    );
    const approvedRun = buildRunResult([
      {
        action: {
          id: "action_context",
          type: "respond",
          description: "respond to user with context",
          params: {},
          estimatedCostUsd: 0.01
        },
        mode: "fast_path",
        approved: true,
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]);

    await organ.reflectOnTask(approvedRun, "mock-planner");
    const memory = await store.load();
    assert.equal(memory.lessons.length, 0);
  });
});

test("ReflectionOrgan keeps concrete operational success lessons", async () => {
  await withReflectionStore(async (store) => {
    const organ = new ReflectionOrgan(
      store,
      new StaticReflectionModelClient(
        {
          lessons: []
        },
        {
          lesson:
            "Validate create_skill payload against policy constraints before promotion to prevent unsafe code merges.",
          nearMiss: null
        }
      ),
      { reflectOnSuccess: true }
    );
    const approvedRun = buildRunResult([
      {
        action: {
          id: "action_create_skill",
          type: "create_skill",
          description: "create sandboxed skill scaffold",
          params: {
            name: "stage6_5_quality_probe",
            code: "export function run(): string { return 'ok'; }"
          },
          estimatedCostUsd: 0.2
        },
        mode: "escalation_path",
        approved: true,
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]);

    await organ.reflectOnTask(approvedRun, "mock-planner");
    const memory = await store.load();
    assert.equal(memory.lessons.length, 1);
  });
});

test("ReflectionOrgan suppresses near-duplicate failure lessons", async () => {
  await withReflectionStore(async (store) => {
    const organ = new ReflectionOrgan(
      store,
      new StaticReflectionModelClient(
        {
          lessons: [
            "Ensure delete actions validate sandbox paths before execution.",
            "Validate sandbox path before delete action execution to prevent escapes."
          ]
        },
        {
          lesson: "unused success lesson",
          nearMiss: null
        }
      )
    );

    const blockedRun = buildRunResult([
      {
        action: {
          id: "action_blocked_duplicate",
          type: "delete_file",
          description: "delete",
          params: { path: "C:/unsafe.txt" },
          estimatedCostUsd: 0.1
        },
        mode: "escalation_path",
        approved: false,
        blockedBy: ["DELETE_OUTSIDE_SANDBOX"],
        violations: [{ code: "DELETE_OUTSIDE_SANDBOX", message: "blocked" }],
        votes: []
      }
    ]);

    await organ.reflectOnTask(blockedRun, "mock-planner");
    const memory = await store.load();
    assert.equal(memory.lessons.length, 1);
  });
});

test("ReflectionOrgan routes clone lessons through distiller ledger before memory commit", async () => {
  await withReflectionStore(async (store, tempDir) => {
    const ledgerStore = new DistillerMergeLedgerStore(
      path.join(tempDir, "distiller_rejection_ledger.json")
    );
    const coordinator = new SatelliteCloneCoordinator({
      maxClonesPerTask: 2,
      maxDepth: 1,
      maxBudgetUsd: 1
    });
    const organ = new ReflectionOrgan(
      store,
      new StaticReflectionModelClient(
        {
          lessons: [
            "Use deterministic connector diff checks before write operations."
          ]
        },
        {
          lesson:
            "Validate connector write policy constraints before merge to reduce failures.",
          nearMiss: null
        }
      ),
      { reflectOnSuccess: true },
      {
        distillerLedgerStore: ledgerStore,
        satelliteCloneCoordinator: coordinator
      }
    );
    const cloneRun = buildRunResult(
      [
        {
          action: {
            id: "action_clone_reflect",
            type: "respond",
            description: "respond",
            params: {},
            estimatedCostUsd: 0.01
          },
          mode: "fast_path",
          approved: true,
          blockedBy: [],
          violations: [],
          votes: []
        }
      ],
      "atlas-1001"
    );

    await organ.reflectOnTask(cloneRun, "mock-planner");
    const memory = await store.load();
    const ledger = await ledgerStore.load();
    assert.equal(memory.lessons.length, 1);
    assert.equal(memory.lessons[0]?.committedByAgentId, "atlas-1001");
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0]?.cloneId, "atlas-1001");
    assert.equal(ledger.entries[0]?.merged, true);
    assert.equal(ledger.entries[0]?.rejectingGovernorIds.length, 0);
  });
});

test("ReflectionOrgan records rejected distiller merge and blocks clone lesson commit on governor dissent", async () => {
  await withReflectionStore(async (store, tempDir) => {
    const ledgerStore = new DistillerMergeLedgerStore(
      path.join(tempDir, "distiller_rejection_ledger.json")
    );
    const coordinator = new SatelliteCloneCoordinator({
      maxClonesPerTask: 2,
      maxDepth: 1,
      maxBudgetUsd: 1
    });
    const organ = new ReflectionOrgan(
      store,
      new StaticReflectionModelClient(
        {
          lessons: ["Never bypass safety constraints to accelerate clone merges."]
        },
        {
          lesson: "unused success lesson",
          nearMiss: null
        }
      ),
      undefined,
      {
        distillerLedgerStore: ledgerStore,
        satelliteCloneCoordinator: coordinator
      }
    );
    const cloneRun = buildRunResult(
      [
        {
          action: {
            id: "action_clone_reflect_blocked",
            type: "write_file",
            description: "write",
            params: { path: "runtime/sandbox/x.txt", content: "x" },
            estimatedCostUsd: 0.02
          },
          mode: "escalation_path",
          approved: false,
          blockedBy: ["COST_LIMIT_EXCEEDED"],
          violations: [
            {
              code: "COST_LIMIT_EXCEEDED",
              message: "blocked"
            }
          ],
          votes: [
            {
              governorId: "security",
              approve: false,
              reason: "unsafe output",
              confidence: 0.93
            }
          ]
        }
      ],
      "milkyway-1002"
    );

    await organ.reflectOnTask(cloneRun, "mock-planner");
    const memory = await store.load();
    const ledger = await ledgerStore.load();
    assert.equal(memory.lessons.length, 0);
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0]?.cloneId, "milkyway-1002");
    assert.equal(ledger.entries[0]?.merged, false);
    assert.deepEqual(ledger.entries[0]?.rejectingGovernorIds, ["security"]);
  });
});
