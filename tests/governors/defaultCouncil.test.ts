/**
 * @fileoverview Tests bounded localhost live-run exemptions in the default governor council helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isLoopbackProofAction,
  isManagedProcessLiveRunAction,
  isRuntimeOwnershipInspectionAction
} from "../../src/governors/defaultCouncil/liveRunExemptions";

test("isManagedProcessLiveRunAction accepts bounded localhost server starts", () => {
  assert.equal(
    isManagedProcessLiveRunAction({
      id: "proposal_1",
      taskId: "task_1",
      requestedBy: "planner",
      rationale: "Need to start the local preview server before browser verification.",
      touchesImmutable: false,
      action: {
        id: "action_1",
        type: "start_process",
        description: "Start the local preview server",
        estimatedCostUsd: 0.05,
        params: {
          command: "python serve8124.py",
          cwd: "C:\\workspace\\smoke"
        }
      }
    }),
    true
  );
});

test("isManagedProcessLiveRunAction rejects unrelated process starts", () => {
  assert.equal(
    isManagedProcessLiveRunAction({
      id: "proposal_2",
      taskId: "task_2",
      requestedBy: "planner",
      rationale: "Run a background worker.",
      touchesImmutable: false,
      action: {
        id: "action_2",
        type: "start_process",
        description: "Start a generic background process",
        estimatedCostUsd: 0.05,
        params: {
          command: "python background_worker.py",
          cwd: "C:\\workspace\\smoke"
        }
      }
    }),
    false
  );
});

test("isLoopbackProofAction accepts localhost browser-proof actions", () => {
  assert.equal(
    isLoopbackProofAction({
      id: "proposal_3",
      taskId: "task_3",
      requestedBy: "planner",
      rationale: "Need to verify the localhost UI.",
      touchesImmutable: false,
      action: {
        id: "action_3",
        type: "verify_browser",
        description: "Verify the localhost UI in a browser",
        estimatedCostUsd: 0.05,
        params: {
          url: "http://localhost:3000/"
        }
      }
    }),
    true
  );
});

test("isLoopbackProofAction rejects non-loopback proof actions", () => {
  assert.equal(
    isLoopbackProofAction({
      id: "proposal_4",
      taskId: "task_4",
      requestedBy: "planner",
      rationale: "Need to verify a remote page.",
      touchesImmutable: false,
      action: {
        id: "action_4",
        type: "verify_browser",
        description: "Verify a remote page in a browser",
        estimatedCostUsd: 0.05,
        params: {
          url: "https://example.com/"
        }
      }
    }),
    false
  );
});

test("isRuntimeOwnershipInspectionAction accepts tracked workspace inspection for runtime management turns", () => {
  assert.equal(
    isRuntimeOwnershipInspectionAction(
      {
        id: "proposal_5",
        taskId: "task_5",
        requestedBy: "planner",
        rationale: "Inspect the tracked preview/browser/process stack first.",
        touchesImmutable: false,
        action: {
          id: "action_5",
          type: "inspect_workspace_resources",
          description: "Inspect tracked workspace resources",
          estimatedCostUsd: 0.04,
          params: {
            rootPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two",
            previewUrl: "http://127.0.0.1:3000/",
            browserSessionId: "browser_session:detroit-city-two",
            previewProcessLeaseId: "proc_detroit_city_two"
          }
        }
      },
      "please inspect and see if Detroit City Two is still running, do this end to end"
    ),
    true
  );
});

test("isRuntimeOwnershipInspectionAction rejects unrelated inspections outside runtime-management turns", () => {
  assert.equal(
    isRuntimeOwnershipInspectionAction(
      {
        id: "proposal_6",
        taskId: "task_6",
        requestedBy: "planner",
        rationale: "Inspect one workspace path.",
        touchesImmutable: false,
        action: {
          id: "action_6",
          type: "inspect_workspace_resources",
          description: "Inspect workspace resources",
          estimatedCostUsd: 0.04,
          params: {
            rootPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two"
          }
        }
      },
      "summarize the design ideas we discussed"
    ),
    false
  );
});
