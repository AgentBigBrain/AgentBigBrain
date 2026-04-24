/**
 * @fileoverview Tests canonical task-runner preflight checks extracted into the orchestration subsystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createBrainConfigFromEnv } from "../../src/core/config";
import { evaluateTaskRunnerPreflight } from "../../src/core/orchestration/taskRunnerPreflight";
import type { EvaluateTaskRunnerPreflightInput } from "../../src/core/orchestration/taskRunnerPreflight";

function createBaseInput(): EvaluateTaskRunnerPreflightInput {
  const baseConfig = createBrainConfigFromEnv({});
  const config = {
    ...baseConfig,
    permissions: {
      ...baseConfig.permissions,
      allowNetworkWriteAction: true
    }
  };
  return {
    action: {
      id: "action_task_runner_preflight_1",
      type: "respond" as const,
      description: "respond to the user",
      params: {},
      estimatedCostUsd: 0.01
    },
    approvalGrantById: new Map(),
    config,
    cumulativeEstimatedCostUsd: 0.01,
    estimatedModelSpendUsd: 0,
    cumulativeModelCalls: 0,
    modelBillingMode: "api_usd",
    idempotencyKey: "task_task_runner_preflight_1:1:action_task_runner_preflight_1",
    mode: "fast_path" as const,
    nowIso: "2026-03-07T12:00:00.000Z",
    startedAtMs: Date.now(),
    task: {
      id: "task_task_runner_preflight_1",
      goal: "respond",
      userInput: "respond",
      createdAt: "2026-03-07T12:00:00.000Z"
    }
  };
}

test("evaluateTaskRunnerPreflight blocks deadline overflow before proposal creation", () => {
  const input = createBaseInput();
  input.startedAtMs = Date.now() - input.config.limits.perTurnDeadlineMs - 1;

  const outcome = evaluateTaskRunnerPreflight(input);

  assert.equal(outcome.proposal, undefined);
  assert.deepEqual(outcome.blockedOutcome?.actionResult.blockedBy, ["GLOBAL_DEADLINE_EXCEEDED"]);
  assert.deepEqual(outcome.blockedOutcome?.traceDetails, {
    blockCode: "GLOBAL_DEADLINE_EXCEEDED",
    blockCategory: "runtime"
  });
});

test("evaluateTaskRunnerPreflight returns a proposal for non-network actions", () => {
  const outcome = evaluateTaskRunnerPreflight(createBaseInput());

  assert.equal(outcome.blockedOutcome, undefined);
  assert.equal(outcome.proposal?.taskId, "task_task_runner_preflight_1");
  assert.equal(outcome.connectorReceiptInput, undefined);
  assert.equal(outcome.approvalGrant, undefined);
});

test("evaluateTaskRunnerPreflight blocks preview start and browser-open actions when the user explicitly defers running and opening", () => {
  const openBrowserInput = createBaseInput();
  openBrowserInput.task.userInput =
    "Get the Next.js workspace ready for edits with the dependencies installed. Do not run it or open anything yet.";
  openBrowserInput.action = {
    id: "action_task_runner_preflight_open_browser_blocked",
    type: "open_browser",
    description: "open the preview in a visible browser",
    params: {
      url: "http://127.0.0.1:3000/"
    },
    estimatedCostUsd: 0.03
  };

  const openBrowserOutcome = evaluateTaskRunnerPreflight(openBrowserInput);

  assert.equal(openBrowserOutcome.proposal, undefined);
  assert.deepEqual(openBrowserOutcome.blockedOutcome?.actionResult.blockedBy, [
    "EXPLICIT_BROWSER_OPEN_DISALLOWED"
  ]);
  assert.deepEqual(openBrowserOutcome.blockedOutcome?.traceDetails, {
    blockCode: "EXPLICIT_BROWSER_OPEN_DISALLOWED",
    blockCategory: "constraints"
  });

  const startProcessInput = createBaseInput();
  startProcessInput.task.userInput =
    "Get the Next.js workspace ready for edits with the dependencies installed. Do not run it or open anything yet.";
  startProcessInput.action = {
    id: "action_task_runner_preflight_start_process_blocked",
    type: "start_process",
    description: "start the local preview",
    params: {
      command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
      cwd: "C:\\Users\\testuser\\Desktop\\Downtown Detroit Drones Smoke 1776091215107"
    },
    estimatedCostUsd: 0.05
  };

  const startProcessOutcome = evaluateTaskRunnerPreflight(startProcessInput);

  assert.equal(startProcessOutcome.proposal, undefined);
  assert.deepEqual(startProcessOutcome.blockedOutcome?.actionResult.blockedBy, [
    "EXPLICIT_PREVIEW_START_DISALLOWED"
  ]);
});

test("evaluateTaskRunnerPreflight blocks localhost preview verification when the user explicitly defers running the project", () => {
  const input = createBaseInput();
  input.task.userInput =
    "Get the Next.js workspace ready for edits with the dependencies installed. Do not run it or open anything yet.";
  input.action = {
    id: "action_task_runner_preflight_probe_http_blocked",
    type: "probe_http",
    description: "verify the preview responds",
    params: {
      url: "http://127.0.0.1:3000/",
      timeoutMs: 5000
    },
    estimatedCostUsd: 0.02
  };

  const outcome = evaluateTaskRunnerPreflight(input);

  assert.equal(outcome.proposal, undefined);
  assert.deepEqual(outcome.blockedOutcome?.actionResult.blockedBy, [
    "EXPLICIT_PREVIEW_VERIFICATION_DISALLOWED"
  ]);
});

test("evaluateTaskRunnerPreflight only applies explicit execution constraints from the current wrapped request", () => {
  const startProcessInput = createBaseInput();
  startProcessInput.task.userInput = [
    "You are in an ongoing conversation with the same user.",
    "",
    "Recent conversation context (oldest to newest):",
    "- user: Get the workspace ready for edits only. Do not run it or open anything yet.",
    "- assistant: I prepared the workspace and stopped before preview.",
    "",
    "Explicit execution constraints for this run:",
    "- The user explicitly said not to open the project/browser yet.",
    "- Do not open a browser window or page in this run unless a later user turn removes that restriction.",
    "",
    "Current user request:",
    "Nice. Pull up the landing page so it is ready to view, but do not pop the browser open yet. Use a real localhost run on host 127.0.0.1 and port 61884, and keep that preview server running."
  ].join("\n");
  startProcessInput.action = {
    id: "action_task_runner_preflight_start_process_allowed_wrapped",
    type: "start_process",
    description: "start the local preview",
    params: {
      command: "npm run dev -- --hostname 127.0.0.1 --port 61884",
      cwd: "C:\\Users\\testuser\\Desktop\\Downtown Detroit Drones Smoke 1776091215107"
    },
    estimatedCostUsd: 0.05
  };

  const startProcessOutcome = evaluateTaskRunnerPreflight(startProcessInput);

  assert.equal(
    startProcessOutcome.blockedOutcome?.actionResult.blockedBy.includes(
      "EXPLICIT_PREVIEW_START_DISALLOWED"
    ),
    false
  );
  assert.equal(
    startProcessOutcome.blockedOutcome?.actionResult.blockedBy.includes(
      "EXPLICIT_PREVIEW_VERIFICATION_DISALLOWED"
    ),
    false
  );

  const openBrowserInput = createBaseInput();
  openBrowserInput.task.userInput = startProcessInput.task.userInput;
  openBrowserInput.action = {
    id: "action_task_runner_preflight_open_browser_still_blocked_wrapped",
    type: "open_browser",
    description: "open the preview in a visible browser",
    params: {
      url: "http://127.0.0.1:61884/"
    },
    estimatedCostUsd: 0.03
  };

  const openBrowserOutcome = evaluateTaskRunnerPreflight(openBrowserInput);

  assert.deepEqual(openBrowserOutcome.blockedOutcome?.actionResult.blockedBy, [
    "EXPLICIT_BROWSER_OPEN_DISALLOWED"
  ]);
});

test("evaluateTaskRunnerPreflight blocks non-API model-call overflow before proposal creation", () => {
  const input = createBaseInput();
  input.modelBillingMode = "subscription_quota";
  input.cumulativeModelCalls = input.config.limits.maxCumulativeNonApiModelCalls + 1;

  const outcome = evaluateTaskRunnerPreflight(input);

  assert.equal(outcome.proposal, undefined);
  assert.deepEqual(outcome.blockedOutcome?.actionResult.blockedBy, ["MODEL_CALL_LIMIT_EXCEEDED"]);
  assert.deepEqual(outcome.blockedOutcome?.traceDetails, {
    blockCode: "MODEL_CALL_LIMIT_EXCEEDED",
    blockCategory: "runtime"
  });
});

test("evaluateTaskRunnerPreflight blocks network_write actions without JIT approval", () => {
  const input = createBaseInput();
  input.action = {
    id: "action_task_runner_preflight_network_missing_approval",
    type: "network_write",
    description: "write to connector",
    params: {
      url: "https://example.com/api",
      connector: "gmail",
      operation: "write",
      lastReadAtIso: "2026-03-07T12:00:00.000Z"
    },
    estimatedCostUsd: 0.08
  };
  input.idempotencyKey = "task_task_runner_preflight_1:1:action_task_runner_preflight_network_missing_approval";

  const outcome = evaluateTaskRunnerPreflight(input);

  assert.equal(outcome.proposal?.taskId, "task_task_runner_preflight_1");
  assert.deepEqual(outcome.blockedOutcome?.actionResult.blockedBy, ["JIT_APPROVAL_REQUIRED"]);
  assert.equal(outcome.approvalGrant, undefined);
});

test("evaluateTaskRunnerPreflight registers approval use and connector receipt seed for approved connector reads", () => {
  const input = createBaseInput();
  input.action = {
    id: "action_task_runner_preflight_network_success",
    type: "network_write",
    description: "read connector state",
    params: {
      url: "https://example.com/api",
      connector: "gmail",
      operation: "read",
      lastReadAtIso: "2026-03-07T12:00:00.000Z",
      approvalId: "approval_task_runner_preflight_1",
      approvedBy: "tester",
      approvalActionIds: ["action_task_runner_preflight_network_success"],
      idempotencyKeys: ["task_task_runner_preflight_1:1:action_task_runner_preflight_network_success"],
      payload: {
        query: "inbox"
      },
      externalIds: ["thread_123"]
    },
    estimatedCostUsd: 0.08
  };
  input.idempotencyKey = "task_task_runner_preflight_1:1:action_task_runner_preflight_network_success";

  const outcome = evaluateTaskRunnerPreflight(input);

  assert.equal(outcome.blockedOutcome, undefined);
  assert.equal(outcome.proposal?.taskId, "task_task_runner_preflight_1");
  assert.equal(outcome.approvalGrant?.approvalId, "approval_task_runner_preflight_1");
  assert.equal(outcome.approvalGrant?.grant.uses, 1);
  assert.deepEqual(outcome.connectorReceiptInput, {
    connector: "gmail",
    operation: "read",
    requestPayload: {
      query: "inbox"
    },
    responseMetadata: {
      endpoint: "https://example.com/api"
    },
    externalIds: ["thread_123"]
  });
});
