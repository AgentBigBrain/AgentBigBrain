/**
 * @fileoverview Tests deterministic live-run recovery helpers extracted from the autonomous loop.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildManagedProcessCheckRecoveryInput,
  buildManagedProcessPortConflictRecoveryInput,
  buildManagedProcessStillRunningRetryInput,
  findManagedProcessStartPortConflictFailure,
  goalExplicitlyRequiresLoopbackPort,
  resolveTrackedLoopbackTarget,
  type LoopbackTargetHint
} from "../../src/core/autonomy/liveRunRecovery";
import { type ActionRunResult, type TaskRunResult } from "../../src/core/types";

function buildTaskResult(actionResults: ActionRunResult[]): TaskRunResult {
  return {
    task: {
      id: "task_live_run_recovery",
      goal: "test",
      userInput: "test",
      createdAt: new Date().toISOString()
    },
    plan: {
      taskId: "task_live_run_recovery",
      plannerNotes: "stub",
      actions: actionResults.map((entry) => entry.action)
    },
    actionResults,
    summary: "stub summary",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
}

function buildBlockedStartProcessPortInUseResult(
  actionId: string,
  requestedPort = 8000,
  suggestedPort = 8125
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "start_process",
      description: "start the local server",
      params: {
        command: `python -m http.server ${requestedPort}`,
        cwd: "runtime/generated"
      },
      estimatedCostUsd: 0.28
    },
    mode: "escalation_path",
    approved: false,
    output:
      `Process start failed: http://localhost:${requestedPort} was already occupied before startup. ` +
      `Try a different free loopback port such as ${suggestedPort}.`,
    executionStatus: "failed",
    executionFailureCode: "PROCESS_START_FAILED",
    executionMetadata: {
      processStartupFailureKind: "PORT_IN_USE",
      processRequestedPort: requestedPort,
      processRequestedUrl: `http://localhost:${requestedPort}`,
      processSuggestedPort: suggestedPort,
      processSuggestedUrl: `http://localhost:${suggestedPort}`,
      processCwd: "runtime/generated"
    },
    blockedBy: ["PROCESS_START_FAILED"],
    violations: [],
    votes: []
  };
}

function buildApprovedStartProcessResult(
  actionId: string,
  command = "python -m http.server 8125"
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "start_process",
      description: "start the local server",
      params: {
        command,
        cwd: "runtime/generated"
      },
      estimatedCostUsd: 0.28
    },
    mode: "escalation_path",
    approved: true,
    output: "Process started.",
    executionStatus: "success",
    executionMetadata: {
      processLeaseId: "proc_live_run_recovery",
      processLifecycleStatus: "PROCESS_STARTED"
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

function buildApprovedProbeHttpReadyResult(
  actionId: string,
  url = "http://localhost:8125"
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "probe_http",
      description: "probe localhost readiness",
      params: {
        url
      },
      estimatedCostUsd: 0.04
    },
    mode: "escalation_path",
    approved: true,
    output: `HTTP probe ready: ${url} returned 200.`,
    executionStatus: "success",
    executionMetadata: {
      processLifecycleStatus: "PROCESS_READY",
      probeUrl: url
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

test("port-conflict recovery rewrites the server command and readiness url", () => {
  const result = buildTaskResult([
    buildBlockedStartProcessPortInUseResult("start_process_conflict_1", 8000, 8125)
  ]);

  const failure = findManagedProcessStartPortConflictFailure(result);

  assert.ok(failure);
  assert.equal(failure?.requestedPort, 8000);
  assert.equal(failure?.suggestedPort, 8125);
  assert.match(
    buildManagedProcessPortConflictRecoveryInput(failure!, true),
    /^start_process cmd="python -m http\.server 8125" cwd="runtime\/generated"\./i
  );
  assert.match(
    buildManagedProcessPortConflictRecoveryInput(failure!, true),
    /probe_http url="http:\/\/localhost:8125"/i
  );
  assert.match(
    buildManagedProcessPortConflictRecoveryInput(failure!, true),
    /Only continue to verify_browser after readiness passes\./i
  );
});

test("loopback-target tracking preserves the first approved start target until a new start replaces it", () => {
  const firstResult = buildTaskResult([
    buildApprovedStartProcessResult("start_process_target_1", "python -m http.server 8125")
  ]);
  const secondResult = buildTaskResult([
    buildApprovedProbeHttpReadyResult("probe_http_target_1", "http://localhost:8125")
  ]);

  const firstTarget = resolveTrackedLoopbackTarget(null, firstResult);
  const secondTarget = resolveTrackedLoopbackTarget(firstTarget, secondResult);

  assert.deepEqual(firstTarget, {
    url: "http://localhost:8125",
    host: "localhost",
    port: 8125
  } satisfies LoopbackTargetHint);
  assert.deepEqual(secondTarget, firstTarget);
});

test("HTTP-required recovery prompts stay pinned to probe_http when the target is known", () => {
  const target: LoopbackTargetHint = {
    url: "http://localhost:8125",
    host: "localhost",
    port: 8125
  };

  assert.match(
    buildManagedProcessCheckRecoveryInput("proc_live_1", target, true),
    /retry probe_http url="http:\/\/localhost:8125" once/i
  );
  assert.match(
    buildManagedProcessStillRunningRetryInput("proc_live_1", true, target),
    /^probe_http url="http:\/\/localhost:8125"/i
  );
  assert.doesNotMatch(
    buildManagedProcessStillRunningRetryInput("proc_live_1", true, target),
    /probe_port/i
  );
});

test("explicit loopback-port requirements only trigger when the mission pins the port", () => {
  assert.equal(
    goalExplicitlyRequiresLoopbackPort("Run the app on localhost:8125 and verify it.", 8125),
    true
  );
  assert.equal(
    goalExplicitlyRequiresLoopbackPort("Run the app locally and verify it in a browser.", 8125),
    false
  );
});
