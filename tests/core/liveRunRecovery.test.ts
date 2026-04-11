/**
 * @fileoverview Tests deterministic live-run recovery helpers extracted from the autonomous loop.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildManagedProcessConcreteRestartRecoveryInput,
  buildManagedProcessCheckRecoveryInput,
  buildManagedProcessPortConflictRecoveryInput,
  buildManagedProcessStoppedRecoveryInput,
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
  command = "python -m http.server 8125",
  loopbackTarget?: {
    host: string;
    port: number;
    url: string;
  }
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
      processLifecycleStatus: "PROCESS_STARTED",
      processRequestedHost: loopbackTarget?.host,
      processRequestedPort: loopbackTarget?.port,
      processRequestedUrl: loopbackTarget?.url
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

test("loopback-target tracking preserves an explicit 127.0.0.1 bind from the start command", () => {
  const startResult = buildTaskResult([
    buildApprovedStartProcessResult(
      "start_process_bound_target_1",
      "python -m http.server 8125 --bind 127.0.0.1"
    )
  ]);

  const target = resolveTrackedLoopbackTarget(null, startResult);

  assert.deepEqual(target, {
    url: "http://127.0.0.1:8125",
    host: "127.0.0.1",
    port: 8125
  } satisfies LoopbackTargetHint);
});

test("loopback-target tracking prefers typed start metadata for generic workspace-native commands", () => {
  const startResult = buildTaskResult([
    buildApprovedStartProcessResult("start_process_generic_target_1", "npm run dev", {
      host: "localhost",
      port: 4173,
      url: "http://localhost:4173"
    })
  ]);

  const target = resolveTrackedLoopbackTarget(null, startResult);

  assert.deepEqual(target, {
    url: "http://localhost:4173",
    host: "localhost",
    port: 4173
  } satisfies LoopbackTargetHint);
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
  assert.match(
    buildManagedProcessCheckRecoveryInput("proc_live_1", target, true),
    /supported params .*command.*cwd.*requestedShellKind/i
  );
  assert.match(
    buildManagedProcessStillRunningRetryInput("proc_live_1", true, target),
    /do not invent `profile` keys/i
  );
});

test("stopped-process recovery prompts steer restarts toward raw start_process commands", () => {
  assert.match(
    buildManagedProcessStoppedRecoveryInput("proc_live_1"),
    /use start_process with supported params only/i
  );
  assert.match(
    buildManagedProcessStoppedRecoveryInput("proc_live_1"),
    /raw server command instead of `zsh -lc` wrappers/i
  );
});

test("concrete stopped-process recovery prompts pin restart to the approved start_process command", () => {
  const prompt = buildManagedProcessConcreteRestartRecoveryInput(
    {
      leaseId: "proc_live_2",
      command: "npm run dev -- --hostname 127.0.0.1 --port 61909",
      cwd: "C:\\Users\\testuser\\Desktop\\Detroit City"
    },
    {
      url: "http://127.0.0.1:61909",
      host: "127.0.0.1",
      port: 61909
    },
    false
  );

  assert.match(
    prompt,
    /^start_process cmd="npm run dev -- --hostname 127\.0\.0\.1 --port 61909" cwd="C:\\\\Users\\\\testuser\\\\Desktop\\\\Detroit City"\./i
  );
  assert.match(prompt, /Only use start_process, check_process, probe_http, probe_port, verify_browser, open_browser, or respond/i);
  assert.doesNotMatch(prompt, /restart the local server once if needed/i);
  assert.match(prompt, /Do not use shell_command, write_file, scaffold, install, or other file-mutation actions/i);
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
