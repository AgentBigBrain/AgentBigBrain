/**
 * @fileoverview Tests Stage 6.86 runtime action wiring in production orchestrator/task-runner flow.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { makeId } from "../../src/core/ids";
import { BrainOrchestrator } from "../../src/core/orchestrator";
import { PersonalityStore } from "../../src/core/personalityStore";
import { GovernanceMemoryStore } from "../../src/core/governanceMemory";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";
import { StateStore } from "../../src/core/stateStore";
import { TaskRequest } from "../../src/core/types";
import { createDefaultGovernors } from "../../src/governors/defaultGovernors";
import { MasterGovernor } from "../../src/governors/masterGovernor";
import { MockModelClient } from "../../src/models/mockModelClient";
import {
  GovernorModelOutput,
  PlannerModelOutput,
  StructuredCompletionRequest
} from "../../src/models/types";
import { ToolExecutorOrgan } from "../../src/organs/executor";
import { PlannerOrgan } from "../../src/organs/planner";
import { ReflectionOrgan } from "../../src/organs/reflection";
import type { BridgeQuestionTimingInterpretationResolver } from "../../src/organs/languageUnderstanding/localIntentModelContracts";

class FixedStage686PlannerModelClient extends MockModelClient {
  /**
   * Initializes deterministic planner-action fixture model client.
   *
   * @param actions - Planned actions returned for `planner_v1`.
   */
  constructor(private readonly actions: PlannerModelOutput["actions"]) {
    super();
  }

  /**
   * Implements `completeJson` behavior for deterministic Stage 6.86 runtime tests.
   *
   * @param request - Structured completion request.
   * @returns Deterministic planner/governor payload.
   */
  override async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "planner_v1") {
      return {
        plannerNotes: "deterministic stage 6.86 runtime wiring plan",
        actions: this.actions
      } as T;
    }

    if (request.schemaName === "governor_v1") {
      const approveVote: GovernorModelOutput = {
        approve: true,
        reason: "allow deterministic Stage 6.86 runtime semantics coverage",
        confidence: 0.99
      };
      return approveVote as T;
    }

    return super.completeJson<T>(request);
  }
}

/**
 * Builds deterministic task fixture for Stage 6.86 runtime wiring tests.
 *
 * @param userInput - User input text.
 * @returns Task request fixture.
 */
function buildTask(userInput: string): TaskRequest {
  return {
    id: makeId("task"),
    goal: "Run deterministic stage 6.86 runtime action semantics.",
    userInput,
    createdAt: new Date().toISOString()
  };
}

/**
 * Executes callback with runtime brain under temporary working directory for isolated `runtime/` artifacts.
 *
 * @param plannerActions - Planner actions for deterministic run.
 * @param callback - Callback receiving configured orchestrator.
 */
async function withStage686RuntimeBrain(
  plannerActions: PlannerModelOutput["actions"],
  callback: (brain: BrainOrchestrator, tempDir: string) => Promise<void>,
  bridgeQuestionTimingInterpretationResolver?: BridgeQuestionTimingInterpretationResolver
): Promise<void> {
  const originalCwd = process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbb-stage686-runtime-"));
  process.chdir(tempDir);
  try {
    const config = {
      ...DEFAULT_BRAIN_CONFIG
    };
    const modelClient = new FixedStage686PlannerModelClient(plannerActions);
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "semantic_memory.json"));
    const brain = new BrainOrchestrator(
      config,
      new PlannerOrgan(modelClient, memoryStore),
      new ToolExecutorOrgan(config),
      createDefaultGovernors(),
      new MasterGovernor(config.governance.supermajorityThreshold),
      new StateStore(path.join(tempDir, "state.json")),
      modelClient,
      new ReflectionOrgan(memoryStore, modelClient),
      new PersonalityStore(path.join(tempDir, "personality.json")),
      new GovernanceMemoryStore(path.join(tempDir, "governance_memory.json")),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      bridgeQuestionTimingInterpretationResolver
    );
    await callback(brain, tempDir);
  } finally {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("stage 6.86 runtime wiring executes real memory_mutation semantics with durable receipt linkage", async () => {
  await withStage686RuntimeBrain(
    [
      {
        type: "memory_mutation",
        description: "Update pulse emitted count through governed memory mutation.",
        params: {
          store: "pulse_state",
          operation: "upsert",
          mutationPath: ["emittedTodayCount"],
          payload: {
            value: 1
          },
          evidenceRefs: ["trace:stage686:memory_mutation"]
        }
      }
    ],
    async (brain) => {
      const result = await brain.runTask(buildTask("apply stage 6.86 memory mutation"));
      assert.equal(result.actionResults.length, 1);
      assert.equal(result.actionResults[0]?.approved, true);
      assert.match(result.actionResults[0]?.output ?? "", /Memory mutation applied/i);
      assert.equal(
        typeof result.actionResults[0]?.executionMetadata?.stage686MutationId,
        "string"
      );

      const runtimeStateRaw = await readFile(
        path.resolve(process.cwd(), "runtime/stage6_86_runtime_state.json"),
        "utf8"
      );
      const runtimeState = JSON.parse(runtimeStateRaw) as {
        lastMemoryMutationReceiptHash?: unknown;
      };
      assert.equal(
        runtimeState.lastMemoryMutationReceiptHash,
        result.actionResults[0]?.executionMetadata?.stage686MutationId
      );
    }
  );
});

test("stage 6.86 runtime wiring executes open_loop_resume topic_resume and stale_fact_revalidation pulse kinds", async () => {
  await withStage686RuntimeBrain(
    [
      {
        type: "pulse_emit",
        description: "Resume deterministic open loop.",
        params: {
          kind: "open_loop_resume",
          threadKey: "thread_budget",
          reasonCode: "OPEN_LOOP_RESUME"
        }
      },
      {
        type: "pulse_emit",
        description: "Resume current topic.",
        params: {
          kind: "topic_resume",
          threadKey: "thread_budget",
          reasonCode: "TOPIC_DRIFT_RESUME"
        }
      },
      {
        type: "pulse_emit",
        description: "Emit stale fact revalidation pulse.",
        params: {
          kind: "stale_fact_revalidation",
          entityRefs: ["entity_runtime_fact"],
          reasonCode: "STALE_FACT_REVALIDATION"
        }
      }
    ],
    async (brain) => {
      const result = await brain.runTask(buildTask("execute all stage 6.86 pulse kinds"));
      assert.equal(result.actionResults.length, 3);
      assert.equal(result.actionResults.every((entry) => entry.approved), true);
      assert.equal(
        result.actionResults[0]?.executionMetadata?.stage686PulseKind,
        "open_loop_resume"
      );
      assert.equal(
        result.actionResults[1]?.executionMetadata?.stage686PulseKind,
        "topic_resume"
      );
      assert.equal(
        result.actionResults[2]?.executionMetadata?.stage686PulseKind,
        "stale_fact_revalidation"
      );

      const runtimeStateRaw = await readFile(
        path.resolve(process.cwd(), "runtime/stage6_86_runtime_state.json"),
        "utf8"
      );
      const runtimeState = JSON.parse(runtimeStateRaw) as {
        pulseState?: { emittedTodayCount?: unknown };
        conversationStack?: { activeThreadKey?: unknown };
      };
      assert.equal(typeof runtimeState.pulseState?.emittedTodayCount, "number");
      assert.equal(runtimeState.conversationStack?.activeThreadKey, "thread_budget");
    }
  );
});

test("stage 6.86 runtime wiring executes bridge-question emission then answer-resolution path", async () => {
  await withStage686RuntimeBrain(
    [
      {
        type: "pulse_emit",
        description: "Emit bridge question for two entities.",
        params: {
          kind: "bridge_question",
          reasonCode: "RELATIONSHIP_CLARIFICATION",
          threadKey: "thread_relationship",
          entityRefs: ["entity_alpha", "entity_beta"],
          evidenceRefs: ["trace:stage686:bridge_emit"]
        }
      },
      {
        type: "pulse_emit",
        description: "Resolve latest pending bridge question as confirmed friend relation.",
        params: {
          kind: "bridge_question",
          reasonCode: "RELATIONSHIP_CLARIFICATION",
          answerKind: "confirmed",
          relationType: "friend",
          evidenceRefs: ["trace:stage686:bridge_resolve"]
        }
      }
    ],
    async (brain) => {
      const result = await brain.runTask(buildTask("run bridge question lifecycle"));
      assert.equal(result.actionResults.length, 2);
      assert.equal(result.actionResults[0]?.approved, true);
      assert.equal(result.actionResults[1]?.approved, true);
      assert.equal(
        typeof result.actionResults[0]?.executionMetadata?.stage686BridgeQuestionId,
        "string"
      );
      assert.equal(
        typeof result.actionResults[1]?.executionMetadata?.stage686BridgeResolvedQuestionId,
        "string"
      );

      const graphRaw = await readFile(path.resolve(process.cwd(), "runtime/entity_graph.json"), "utf8");
      const graph = JSON.parse(graphRaw) as {
        edges?: Array<{
          sourceEntityKey?: unknown;
          targetEntityKey?: unknown;
          relationType?: unknown;
        }>;
      };
      const hasConfirmedRelation =
        graph.edges?.some((edge) => {
          if (edge.relationType !== "friend") {
            return false;
          }
          const pair = [edge.sourceEntityKey, edge.targetEntityKey]
            .filter((entry): entry is string => typeof entry === "string")
            .sort((left, right) => left.localeCompare(right));
          return pair.length === 2 && pair[0] === "entity_alpha" && pair[1] === "entity_beta";
        }) ?? false;
      assert.equal(hasConfirmedRelation, true);
    }
  );
});

test("stage 6.86 runtime wiring can soft-defer bridge emission when conversational timing is awkward", async () => {
  const bridgeQuestionTimingInterpretationResolver: BridgeQuestionTimingInterpretationResolver = async () => ({
    source: "local_intent_model",
    kind: "defer_for_context",
    confidence: "high",
    explanation: "The user is focused on active workflow execution."
  });
  await withStage686RuntimeBrain(
    [
      {
        type: "pulse_emit",
        description: "Attempt bridge question for two entities.",
        params: {
          kind: "bridge_question",
          reasonCode: "RELATIONSHIP_CLARIFICATION",
          threadKey: "thread_relationship",
          entityRefs: ["entity_alpha", "entity_beta"],
          evidenceRefs: ["trace:stage686:bridge_emit"]
        }
      }
    ],
    async (brain) => {
      const result = await brain.runTask(buildTask("please finish the css deployment fix first"));
      assert.equal(result.actionResults.length, 1);
      assert.equal(result.actionResults[0]?.approved, true);
      assert.match(result.actionResults[0]?.output ?? "", /Bridge question deferred for context/i);
      assert.equal(
        result.actionResults[0]?.executionMetadata?.stage686BridgeTimingDeferred,
        true
      );
      assert.equal(
        result.actionResults[0]?.executionMetadata?.stage686BridgeTimingDecision,
        "defer_for_context"
      );

      const runtimeStateRaw = await readFile(
        path.resolve(process.cwd(), "runtime/stage6_86_runtime_state.json"),
        "utf8"
      );
      const runtimeState = JSON.parse(runtimeStateRaw) as {
        pendingBridgeQuestions?: unknown[];
        pulseState?: { emittedTodayCount?: unknown };
      };
      assert.deepEqual(runtimeState.pendingBridgeQuestions, []);
      assert.equal(runtimeState.pulseState?.emittedTodayCount, 0);
    },
    bridgeQuestionTimingInterpretationResolver
  );
});
