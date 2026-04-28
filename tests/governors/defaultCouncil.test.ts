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
import { isExplicitUserOwnedBuildWorkspaceAction } from "../../src/governors/defaultCouncil/userOwnedBuildExemptions";

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

test("isExplicitUserOwnedBuildWorkspaceAction accepts exact relative Desktop organization moves", () => {
  const taskUserInput = [
    "You are in an ongoing conversation with the same user.",
    "",
    "Natural desktop-organization follow-up:",
    "- The user is asking for a real Desktop folder move, not just an inspection or summary.",
    "- Strongest remembered Desktop root in this chat: C:\\Users\\testuser\\OneDrive\\Desktop",
    "- Treat the named destination as C:\\Users\\testuser\\OneDrive\\Desktop\\sample-folder unless fresher path evidence in this chat proves a different location.",
    "- Move exactly the Desktop folder named agentbigbrain-static-html-smoke-123; do not move sibling folders that merely share a prefix or contain similar words.",
    "",
    "Current user request:",
    "Please clean up my desktop now by moving only the folder named agentbigbrain-static-html-smoke-123 into sample-folder. Do not move any other desktop folders."
  ].join("\n");

  assert.equal(
    isExplicitUserOwnedBuildWorkspaceAction(
      {
        id: "proposal_7",
        taskId: "task_7",
        requestedBy: "planner",
        rationale: "Move the exact requested Desktop folder into the exact requested destination.",
        touchesImmutable: false,
        action: {
          id: "action_7",
          type: "shell_command",
          description: "Move the exact requested Desktop folder and print bounded proof",
          estimatedCostUsd: 0.04,
          params: {
            cwd: "C:\\Users\\testuser\\OneDrive\\Desktop",
            command: [
              "$source = 'agentbigbrain-static-html-smoke-123'",
              "$destination = 'sample-folder'",
              "if (-not (Test-Path -LiteralPath $destination)) { New-Item -ItemType Directory -Path $destination -Force | Out-Null }",
              "Move-Item -LiteralPath $source -Destination $destination -Force -ErrorAction Stop",
              "Write-Output \"MOVED_TO_DEST=$destination/$source\""
            ].join("; ")
          }
        }
      },
      taskUserInput
    ),
    true
  );
});

test("isExplicitUserOwnedBuildWorkspaceAction rejects relative organization moves without exact names", () => {
  const taskUserInput = [
    "Natural desktop-organization follow-up:",
    "- Strongest remembered Desktop root in this chat: C:\\Users\\testuser\\OneDrive\\Desktop",
    "",
    "Current user request:",
    "Please clean up my desktop."
  ].join("\n");

  assert.equal(
    isExplicitUserOwnedBuildWorkspaceAction(
      {
        id: "proposal_8",
        taskId: "task_8",
        requestedBy: "planner",
        rationale: "Move some Desktop folders.",
        touchesImmutable: false,
        action: {
          id: "action_8",
          type: "shell_command",
          description: "Move Desktop folders",
          estimatedCostUsd: 0.04,
          params: {
            cwd: "C:\\Users\\testuser\\OneDrive\\Desktop",
            command: "Move-Item -LiteralPath * -Destination sample-folder -Force"
          }
        }
      },
      taskUserInput
    ),
    false
  );
});
