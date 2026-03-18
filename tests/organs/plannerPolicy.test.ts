/**
 * @fileoverview Tests extracted planner-policy modules directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TaskRequest } from "../../src/core/types";
import { ModelClient, StructuredCompletionRequest } from "../../src/models/types";
import {
  assertPlannerActionValidation,
  evaluatePlannerActionValidation,
  preparePlannerActions,
  shouldUseNonExplicitRunSkillFallback
} from "../../src/organs/plannerPolicy/explicitActionRepair";
import { inferRequiredActionType } from "../../src/organs/plannerPolicy/explicitActionIntent";
import {
  PlannerPromptBuildInput,
  type PlannerExecutionEnvironmentContext
} from "../../src/organs/plannerPolicy/executionStyleContracts";
import {
  buildPlannerRepairSystemPrompt,
  buildPlannerSystemPrompt
} from "../../src/organs/plannerPolicy/promptAssembly";
import {
  assessExecutionStyleBuildPlan,
  requiresExecutableBuildPlan
} from "../../src/organs/plannerPolicy/buildExecutionPolicy";
import {
  buildWorkspaceRecoveryNextUserInput,
  buildWorkspaceRecoveryPostShutdownRetryInput
} from "../../src/core/autonomy/workspaceRecoveryPolicy";
import {
  isExecutionStyleBuildRequest,
  isLocalWorkspaceOrganizationRequest,
  requiresFrameworkAppScaffoldAction
} from "../../src/organs/plannerPolicy/liveVerificationPolicy";
import {
  buildNonExplicitRunSkillFallbackAction,
  enforceRunSkillIntentPolicy,
  ensureRespondMessages
} from "../../src/organs/plannerPolicy/responseSynthesisFallback";
import { buildDeterministicExplicitRuntimeActionFallbackActions } from "../../src/organs/plannerPolicy/explicitRuntimeActionFallback";
import { buildDeterministicWorkspaceRecoveryFallbackActions } from "../../src/organs/plannerPolicy/workspaceRecoveryFallback";
import { buildWorkspaceRecoverySignalFixture } from "../helpers/conversationFixtures";

class ResponseOnlyModelClient implements ModelClient {
  readonly backend = "mock" as const;

  constructor(private readonly message: string) {}

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "response_v1") {
      throw new Error(`Unexpected schema request: ${request.schemaName}`);
    }
    return {
      message: this.message
    } as T;
  }
}

function buildTask(userInput: string): TaskRequest {
  return {
    id: "task_planner_policy",
    agentId: "main-agent",
    goal: "Handle user request safely and efficiently.",
    userInput,
    createdAt: new Date().toISOString()
  };
}

function buildExecutionEnvironment(): PlannerExecutionEnvironmentContext {
  return {
    platform: "linux",
    shellKind: "bash",
    invocationMode: "inline_command",
    commandMaxChars: 2048,
    desktopPath: "/home/testuser/Desktop",
    documentsPath: "/home/testuser/Documents",
    downloadsPath: "/home/testuser/Downloads"
  };
}

function buildPromptInput(
  currentUserRequest: string,
  executionEnvironment: PlannerExecutionEnvironmentContext = buildExecutionEnvironment()
): PlannerPromptBuildInput {
  const task = buildTask(currentUserRequest);
  return {
    task,
    plannerModel: "mock-planner",
    lessonsText: "",
    firstPrinciplesGuidance: "",
    learningGuidance: "",
    currentUserRequest,
    requiredActionType: null,
    playbookSelection: null,
    executionEnvironment
  };
}

test("preparePlannerActions filters non-explicit run_skill-only output and flags the collapse", () => {
  const preparation = preparePlannerActions(
    {
      plannerNotes: "run skill only",
      actions: [
        {
          type: "run_skill",
          description: "run workflow skill",
          params: {
            name: "workflow_skill"
          }
        }
      ]
    },
    "Research deterministic sandboxing controls and provide distilled findings.",
    null
  );

  assert.deepEqual(preparation.actions, []);
  assert.equal(preparation.filteredRunSkillOnly, true);
});

test("preparePlannerActions strips respond actions from execution-style build plans with real work", () => {
  const preparation = preparePlannerActions(
    {
      plannerNotes: "build plus completion message",
      actions: [
        {
          type: "write_file",
          description: "write the landing page",
          params: {
            path: "/home/testuser/Desktop/drone-company/index.html",
            content: "<html></html>"
          }
        },
        {
          type: "respond",
          description: "confirm completion",
          params: {
            message: "Done."
          }
        }
      ]
    },
    "Build a landing page on my Desktop and run it in a browser for me.",
    null
  );

  assert.equal(preparation.actions.length, 1);
  assert.equal(preparation.actions[0]?.type, "write_file");
});

test("preparePlannerActions appends linked preview shutdown when a natural close-browser follow-up targets a tracked preview stack", () => {
  const fullExecutionInput = [
    "Tracked browser sessions:",
    "- Browser window: sessionId=browser_session:landing-page; url=http://127.0.0.1:8125/; status=open; visibility=visible; controller=playwright_managed; control=available; linkedPreviewLease=proc_preview_1; linkedPreviewCwd=C:\\Users\\testuser\\Desktop\\drone-company",
    "",
    "Natural browser-session follow-up:",
    "- Linked preview process: leaseId=proc_preview_1; cwd=C:\\Users\\testuser\\Desktop\\drone-company",
    "- If the user wants that visible page closed now, prefer close_browser with params.sessionId=browser_session:landing-page and then stop_process with params.leaseId=proc_preview_1 so the linked local preview stack shuts down fully. Do not stop unrelated processes.",
    "",
    "Current user request:",
    "Close the landing page so we can work on something else."
  ].join("\n");
  const preparation = preparePlannerActions(
    {
      plannerNotes: "close the tracked browser only",
      actions: [
        {
          type: "close_browser",
          description: "Close the tracked landing page preview.",
          params: {
            sessionId: "browser_session:landing-page"
          }
        }
      ]
    },
    "Close the landing page so we can work on something else.",
    "close_browser",
    fullExecutionInput
  );

  assert.equal(preparation.actions.some((action) => action.type === "close_browser"), true);
  assert.equal(
    preparation.actions.some(
      (action) =>
        action.type === "stop_process" && action.params.leaseId === "proc_preview_1"
    ),
    true
  );
});

test("preparePlannerActions appends exact shutdown steps for every tracked preview lease in a close-browser follow-up", () => {
  const fullExecutionInput = [
    "Current tracked workspace in this chat:",
    "- Label: Current project workspace",
    "- Root path: C:\\Users\\testuser\\Desktop\\AI Drone City",
    "- Preview process leases: proc_preview_1, proc_preview_2",
    "",
    "Tracked browser sessions:",
    "- Browser window: sessionId=browser_session:ai-drone-city; url=http://127.0.0.1:4173/; status=open; visibility=visible; controller=playwright_managed; control=available; linkedPreviewLease=proc_preview_2; linkedPreviewCwd=C:\\Users\\testuser\\Desktop\\AI Drone City",
    "",
    "Current user request:",
    "Close AI Drone City and anything it needs so we can move on."
  ].join("\n");
  const preparation = preparePlannerActions(
    {
      plannerNotes: "close the tracked browser only",
      actions: [
        {
          type: "close_browser",
          description: "Close the tracked AI Drone City preview.",
          params: {
            sessionId: "browser_session:ai-drone-city"
          }
        }
      ]
    },
    "Close AI Drone City and anything it needs so we can move on.",
    "close_browser",
    fullExecutionInput
  );

  const stopProcessLeaseIds = preparation.actions
    .filter((action) => action.type === "stop_process")
    .map((action) => action.params.leaseId)
    .sort();
  assert.deepEqual(stopProcessLeaseIds, ["proc_preview_1", "proc_preview_2"]);
});

test("preparePlannerActions backfills open-browser workspace context from tracked preview metadata", () => {
  const fullExecutionInput = [
    "Current tracked workspace in this chat:",
    "- Label: Current project workspace",
    "- Root path: C:\\Users\\testuser\\Desktop\\drone-company",
    "- Preview URL: http://127.0.0.1:8125/",
    "",
    "Tracked browser sessions:",
    "- Browser window: sessionId=browser_session:landing-page; url=http://127.0.0.1:8125/; status=open; visibility=visible; controller=playwright_managed; control=available; linkedPreviewLease=proc_preview_1; linkedPreviewCwd=C:\\Users\\testuser\\Desktop\\drone-company",
    "",
    "Current user request:",
    "Reopen the landing page preview for me."
  ].join("\n");
  const preparation = preparePlannerActions(
    {
      plannerNotes: "bring the existing preview forward",
      actions: [
        {
          type: "open_browser",
          description: "Bring the preview back up.",
          params: {
            url: "http://127.0.0.1:8125/"
          }
        }
      ]
    },
    "Reopen the landing page preview for me.",
    null,
    fullExecutionInput
  );

  const openBrowserAction = preparation.actions.find((action) => action.type === "open_browser");
  assert.ok(openBrowserAction);
  assert.equal(openBrowserAction.params.previewProcessLeaseId, "proc_preview_1");
  assert.equal(openBrowserAction.params.rootPath, "C:\\Users\\testuser\\Desktop\\drone-company");
});

test("preparePlannerActions appends tracked preview refresh after artifact edits when a visible preview already exists", () => {
  const fullExecutionInput = [
    "Current tracked workspace in this chat:",
    "- Label: Current project workspace",
    "- Root path: C:\\Users\\testuser\\Desktop\\drone-company",
    "- Preview URL: file:///C:/Users/testuser/Desktop/drone-company/index.html",
    "",
    "Natural artifact-edit follow-up:",
    "- Preferred primary artifact: C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
    "- Visible preview already exists: file:///C:/Users/testuser/Desktop/drone-company/index.html; keep the preview aligned with the edited artifact when practical.",
    "",
    "Current user request:",
    "Change the hero image to a slider instead of the landing page."
  ].join("\n");

  const preparation = preparePlannerActions(
    {
      plannerNotes: "edit the tracked artifact only",
      actions: [
        {
          type: "write_file",
          description: "Update the tracked landing page artifact.",
          params: {
            path: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
            content: "<section class=\"hero-slider\">updated</section>"
          }
        }
      ]
    },
    "Change the hero image to a slider instead of the landing page.",
    "write_file",
    fullExecutionInput
  );

  const openBrowserAction = preparation.actions.find((action) => action.type === "open_browser");
  assert.ok(openBrowserAction);
  assert.equal(
    openBrowserAction.params.url,
    "file:///C:/Users/testuser/Desktop/drone-company/index.html"
  );
  assert.equal(openBrowserAction.params.rootPath, "C:\\Users\\testuser\\Desktop\\drone-company");
});

test("evaluatePlannerActionValidation and assertPlannerActionValidation fail closed for missing browser proof", () => {
  const currentUserRequest =
    "Create a React app on my Desktop, run the app, and verify the homepage UI. Execute now.";
  const validation = evaluatePlannerActionValidation(currentUserRequest, null, [
    {
      id: "action_shell_build",
      type: "shell_command",
      description: "install and build the app",
      params: {
        command: "npm install && npm run build"
      },
      estimatedCostUsd: 0.12
    },
    {
      id: "action_start_live_run",
      type: "start_process",
      description: "start the local app",
      params: {
        command: "npm run dev"
      },
      estimatedCostUsd: 0.08
    },
    {
      id: "action_probe_http",
      type: "probe_http",
      description: "probe localhost readiness",
      params: {
        url: "http://localhost:3000"
      },
      estimatedCostUsd: 0.03
    }
  ]);

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.buildPlanAssessment.issueCode, "BROWSER_VERIFICATION_ACTION_REQUIRED");
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /no verify_browser action for explicit browser\/UI verification request/i
  );
});

test("evaluatePlannerActionValidation and assertPlannerActionValidation fail closed for missing persistent browser open step", () => {
  const currentUserRequest =
    "Create a React app on my Desktop, run it, verify the homepage UI, and leave it open for me when you're done. Execute now.";
  const validation = evaluatePlannerActionValidation(currentUserRequest, null, [
    {
      id: "action_shell_build",
      type: "shell_command",
      description: "install and build the app",
      params: {
        command: "npm install && npm run build"
      },
      estimatedCostUsd: 0.12
    },
    {
      id: "action_start_live_run",
      type: "start_process",
      description: "start the local app",
      params: {
        command: "npm run dev"
      },
      estimatedCostUsd: 0.08
    },
    {
      id: "action_probe_http",
      type: "probe_http",
      description: "probe localhost readiness",
      params: {
        url: "http://localhost:3000"
      },
      estimatedCostUsd: 0.03
    },
    {
      id: "action_verify_browser",
      type: "verify_browser",
      description: "verify the homepage UI",
      params: {
        url: "http://localhost:3000",
        expectedText: "App"
      },
      estimatedCostUsd: 0.09
    }
  ]);

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.buildPlanAssessment.issueCode, "PERSISTENT_BROWSER_OPEN_REQUIRED");
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /no open_browser action for an explicit leave-it-open browser request/i
  );
});

test("evaluatePlannerActionValidation allows file-open previews for static leave-open requests", () => {
  const currentUserRequest =
    "Build the landing page on my Desktop, run it in a browser, and leave it open for me.";
  const validation = evaluatePlannerActionValidation(currentUserRequest, null, [
    {
      id: "action_write_file",
      type: "write_file",
      description: "write the landing page",
      params: {
        path: "/home/testuser/Desktop/drone-company/index.html",
        content: "<html></html>"
      },
      estimatedCostUsd: 0.08
    },
    {
      id: "action_open_browser",
      type: "open_browser",
      description: "open the static file in the browser",
      params: {
        url: "file:///home/testuser/Desktop/drone-company/index.html"
      },
      estimatedCostUsd: 0.03
    }
  ]);

  assert.equal(validation.needsRepair, false);
  assert.equal(validation.buildPlanAssessment.issueCode, null);
});

test("evaluatePlannerActionValidation does not treat a plain open-browser preview request as browser verification", () => {
  const currentUserRequest =
    "Build a small drone landing page on my Desktop, then open it in a browser and leave it open for me.";
  const validation = evaluatePlannerActionValidation(currentUserRequest, null, [
    {
      id: "action_write_file",
      type: "write_file",
      description: "write the landing page",
      params: {
        path: "/home/testuser/Desktop/drone-company/index.html",
        content: "<html></html>"
      },
      estimatedCostUsd: 0.08
    },
    {
      id: "action_open_browser",
      type: "open_browser",
      description: "open the static file in the browser",
      params: {
        url: "file:///home/testuser/Desktop/drone-company/index.html"
      },
      estimatedCostUsd: 0.03
    }
  ]);

  assert.equal(validation.needsRepair, false);
  assert.equal(validation.buildPlanAssessment.issueCode, null);
});

test("fresh framework-app requests require a real scaffold-capable action instead of write-file-only plans", () => {
  const currentUserRequest =
    "Create a React landing page app on my Desktop, open it in a browser, and leave it open for me.";
  const validation = evaluatePlannerActionValidation(currentUserRequest, null, [
    {
      id: "action_write_app_source",
      type: "write_file",
      description: "write the React app source file",
      params: {
        path: "/home/testuser/Desktop/ai-drone-city/src/App.jsx",
        content: "export default function App() { return <main>AI Drone City</main>; }"
      },
      estimatedCostUsd: 0.08
    },
    {
      id: "action_open_static_preview",
      type: "open_browser",
      description: "open the preview",
      params: {
        url: "file:///home/testuser/Desktop/ai-drone-city/dist/index.html"
      },
      estimatedCostUsd: 0.03
    }
  ]);

  assert.equal(requiresFrameworkAppScaffoldAction(currentUserRequest), true);
  assert.equal(validation.needsRepair, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "FRAMEWORK_APP_SCAFFOLD_ACTION_REQUIRED"
  );
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /fresh framework-app request like a file-only edit/i
  );
});

test("framework-app requests accept real toolchain actions for scaffold/build flow", () => {
  const currentUserRequest =
    "Create a React landing page app on my Desktop, open it in a browser, and leave it open for me.";
  const validation = evaluatePlannerActionValidation(currentUserRequest, null, [
    {
      id: "action_scaffold_app",
      type: "shell_command",
      description: "scaffold the React app",
      params: {
        command: "npm create vite@latest ai-drone-city -- --template react"
      },
      estimatedCostUsd: 0.12
    },
    {
      id: "action_build_app",
      type: "shell_command",
      description: "build the app",
      params: {
        command: "npm run build"
      },
      estimatedCostUsd: 0.12
    },
    {
      id: "action_open_preview",
      type: "open_browser",
      description: "open the built preview",
      params: {
        url: "file:///home/testuser/Desktop/ai-drone-city/dist/index.html"
      },
      estimatedCostUsd: 0.03
    }
  ]);

  assert.equal(validation.needsRepair, false);
  assert.equal(validation.buildPlanAssessment.issueCode, null);
});

test('execution-style build detection accepts explicit Desktop paths phrased as in the "..." folder', () => {
  const currentUserRequest =
    'Fix the React/Vite project in the "C:\\Users\\testuser\\OneDrive\\Desktop\\AI Drone City" folder, install dependencies if needed, build it, and open it in the browser.';

  assert.equal(isExecutionStyleBuildRequest(currentUserRequest), true);
  assert.equal(requiresFrameworkAppScaffoldAction(currentUserRequest), true);
});

test("fresh framework-app requests fail closed when scaffold logic keys reuse on folder existence alone", () => {
  const currentUserRequest =
    "Create a React landing page app on my Desktop, open it in a browser, and leave it open for me.";
  const validation = evaluatePlannerActionValidation(currentUserRequest, null, [
    {
      id: "action_scaffold_with_directory_only_guard",
      type: "shell_command",
      description: "scaffold only when the directory is missing",
      params: {
        command:
          "$desktop = 'C:\\Users\\testuser\\Desktop'; $project = Join-Path $desktop 'AI Drone City'; if (-not (Test-Path $project)) { npm create vite@latest \"$project\" -- --template react }"
      },
      estimatedCostUsd: 0.12
    },
    {
      id: "action_build_app",
      type: "shell_command",
      description: "build the app",
      params: {
        command: "npm run build"
      },
      estimatedCostUsd: 0.12
    },
    {
      id: "action_open_preview",
      type: "open_browser",
      description: "open the built preview",
      params: {
        url: "file:///home/testuser/Desktop/ai-drone-city/dist/index.html"
      },
      estimatedCostUsd: 0.03
    }
  ]);

  assert.equal(validation.needsRepair, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "FRAMEWORK_APP_ARTIFACT_CHECK_REQUIRED"
  );
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /directory existence alone as proof a framework app already exists/i
  );
});

test("fresh framework-app requests fail closed when package.json-guarded scaffold recreates the named folder from its parent", () => {
  const currentUserRequest =
    "Create a React landing page app on my Desktop in a folder called AI Drone City, open it in a browser, and leave it open for me.";
  const validation = evaluatePlannerActionValidation(currentUserRequest, null, [
    {
      id: "action_scaffold_named_folder_from_parent",
      type: "shell_command",
      description: "Scaffold or reuse the React app.",
      params: {
        command: [
          "$desktop = 'C:\\Users\\testuser\\Desktop'",
          "$app = Join-Path $desktop 'AI Drone City'",
          "if (!(Test-Path (Join-Path $app 'package.json'))) {",
          "  Set-Location $desktop",
          "  npm create vite@latest 'AI Drone City' -- --template react",
          "}",
          "Set-Location $app",
          "npm install"
        ].join("; ")
      },
      estimatedCostUsd: 0.2
    },
    {
      id: "action_open_preview",
      type: "open_browser",
      description: "open the built preview",
      params: {
        url: "file:///home/testuser/Desktop/ai-drone-city/dist/index.html"
      },
      estimatedCostUsd: 0.03
    }
  ]);

  assert.equal(validation.needsRepair, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "FRAMEWORK_APP_IN_PLACE_SCAFFOLD_REQUIRED"
  );
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /scaffold or repair inside the exact requested folder/i
  );
});

test("framework-app live-run requests fail closed when they use an ad-hoc preview server", () => {
  const currentUserRequest =
    "Create a React landing page app on my Desktop, run it locally on localhost, open it in a browser, and leave it open for me.";
  const validation = evaluatePlannerActionValidation(currentUserRequest, null, [
    {
      id: "action_repair_workspace",
      type: "shell_command",
      description: "Repair the React workspace in place.",
      params: {
        command: "npm install && npm run build"
      },
      estimatedCostUsd: 0.18
    },
    {
      id: "action_start_ad_hoc_server",
      type: "start_process",
      description: "Serve the built dist folder.",
      params: {
        command:
          "powershell -NoProfile -Command \"$ErrorActionPreference='Stop'; Set-Location 'C:\\Users\\testuser\\Desktop\\AI Drone City'; npx --yes serve -s dist -l 4173\""
      },
      estimatedCostUsd: 0.28
    },
    {
      id: "action_probe_http",
      type: "probe_http",
      description: "Wait for localhost readiness.",
      params: {
        url: "http://127.0.0.1:4173",
        expectedStatus: 200
      },
      estimatedCostUsd: 0.04
    },
    {
      id: "action_open_browser",
      type: "open_browser",
      description: "Open the local page and leave it open.",
      params: {
        url: "http://127.0.0.1:4173"
      },
      estimatedCostUsd: 0.03
    }
  ]);

  assert.equal(validation.needsRepair, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "FRAMEWORK_APP_NATIVE_PREVIEW_REQUIRED"
  );
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /ad-hoc preview server/i
  );
});

test("execution-style build requests fail closed when shell commands exceed the runtime command budget", () => {
  const currentUserRequest =
    "Create a React landing page app on my Desktop, run it locally on localhost, open it in a browser, and leave it open for me.";
  const oversizedCommand = "Write-Output '" + "x".repeat(5000) + "'";
  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action_oversized_shell",
        type: "shell_command",
        description: "Write the whole app inside one giant shell command.",
        params: {
          command: oversizedCommand
        },
        estimatedCostUsd: 0.25
      }
    ],
    currentUserRequest,
    {
      platform: "win32",
      shellKind: "powershell",
      invocationMode: "inline_command",
      commandMaxChars: 4096,
      desktopPath: "C:\\Users\\testuser\\Desktop",
      documentsPath: "C:\\Users\\testuser\\Documents",
      downloadsPath: "C:\\Users\\testuser\\Downloads"
    }
  );

  assert.equal(validation.needsRepair, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "SHELL_COMMAND_MAX_CHARS_EXCEEDED"
  );
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /longer than the configured runtime command budget/i
  );
});

test("framework-app start_process plans fail closed when they use an ad-hoc preview server even without explicit localhost wording", () => {
  const currentUserRequest =
    "Create a React landing page app on my Desktop, open it in the browser, and leave it open for me.";
  const validation = evaluatePlannerActionValidation(currentUserRequest, null, [
    {
      id: "action_repair_workspace",
      type: "shell_command",
      description: "Repair the React workspace in place.",
      params: {
        command:
          "Set-Location 'C:\\Users\\testuser\\Desktop\\AI Drone City'; npm install; npm run build"
      },
      estimatedCostUsd: 0.18
    },
    {
      id: "action_start_ad_hoc_server",
      type: "start_process",
      description: "Serve the built dist folder.",
      params: {
        command:
          "powershell -NoProfile -Command \"$ErrorActionPreference='Stop'; Set-Location 'C:\\Users\\testuser\\Desktop\\AI Drone City'; npx --yes serve -s dist -l 4173\""
      },
      estimatedCostUsd: 0.28
    },
    {
      id: "action_probe_http",
      type: "probe_http",
      description: "Wait for localhost readiness.",
      params: {
        url: "http://127.0.0.1:4173",
        expectedStatus: 200
      },
      estimatedCostUsd: 0.04
    },
    {
      id: "action_open_browser",
      type: "open_browser",
      description: "Open the local page and leave it open.",
      params: {
        url: "http://127.0.0.1:4173"
      },
      estimatedCostUsd: 0.03
    }
  ]);

  assert.equal(validation.needsRepair, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "FRAMEWORK_APP_NATIVE_PREVIEW_REQUIRED"
  );
});

test("evaluatePlannerActionValidation fails closed when live verification uses a file target", () => {
  const currentUserRequest =
    "Build the landing page on my Desktop, verify the homepage UI, and leave it open for me.";
  const validation = evaluatePlannerActionValidation(currentUserRequest, null, [
    {
      id: "action_write_file",
      type: "write_file",
      description: "write the landing page",
      params: {
        path: "/home/testuser/Desktop/drone-company/index.html",
        content: "<html></html>"
      },
      estimatedCostUsd: 0.08
    },
    {
      id: "action_verify_browser",
      type: "verify_browser",
      description: "verify the homepage UI",
      params: {
        url: "http://localhost:8000",
        expectedText: "Drone Company"
      },
      estimatedCostUsd: 0.09
    },
    {
      id: "action_open_browser",
      type: "open_browser",
      description: "open the static file in the browser",
      params: {
        url: "file:///home/testuser/Desktop/drone-company/index.html"
      },
      estimatedCostUsd: 0.03
    }
  ]);

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.buildPlanAssessment.issueCode, "OPEN_BROWSER_HTTP_URL_REQUIRED");
});

test("evaluatePlannerActionValidation fails closed when my desktop request uses Public Desktop", () => {
  const currentUserRequest =
    "Build the landing page on my Desktop and leave it open for me.";
  const validation = evaluatePlannerActionValidation(currentUserRequest, null, [
    {
      id: "action_write_file",
      type: "write_file",
      description: "write the landing page",
      params: {
        path: "C:\\Users\\Public\\Desktop\\drone-company\\index.html",
        content: "<html></html>"
      },
      estimatedCostUsd: 0.08
    },
    {
      id: "action_start_process",
      type: "start_process",
      description: "serve the landing page locally",
      params: {
        command: "python -m http.server 8000",
        cwd: "C:\\Users\\Public\\Desktop\\drone-company"
      },
      estimatedCostUsd: 0.08
    },
    {
      id: "action_probe_http",
      type: "probe_http",
      description: "confirm localhost readiness",
      params: {
        url: "http://localhost:8000"
      },
      estimatedCostUsd: 0.03
    }
  ]);

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.buildPlanAssessment.issueCode, "SHARED_DESKTOP_PATH_DISALLOWED");
});

test("buildPlannerSystemPrompt includes execution environment and live-verification guidance", () => {
  const prompt = buildPlannerSystemPrompt(
    buildPromptInput(
      "Create a React app on my Desktop, run the app, and verify the homepage UI. Execute now."
    )
  );

  assert.match(prompt, /Execution Environment:/i);
  assert.match(prompt, /shellKind:\s+bash/i);
  assert.match(prompt, /desktopPath:\s+\/home\/testuser\/Desktop/i);
  assert.match(prompt, /Live-run verification intent detected/i);
  assert.match(prompt, /use verify_browser with params\.url/i);
});

test("buildPlannerSystemPrompt includes local capability guidance for desktop plus leave-open requests", () => {
  const prompt = buildPlannerSystemPrompt(
    buildPromptInput(
      "Create a React app on my Desktop, run it, verify the homepage UI, and leave it open for me when you're done. Execute now."
    )
  );

  assert.match(prompt, /named a local destination they want used/i);
  assert.match(prompt, /prefer \/home\/testuser\/Desktop instead of guessing Public Desktop/i);
  assert.match(prompt, /launch a real visible local browser window with open_browser/i);
  assert.match(prompt, /include open_browser as the final visible-browser step/i);
  assert.match(prompt, /Do not use file:\/\/ URLs for open_browser when live verification or browser proof is required/i);
});

test("buildPlannerSystemPrompt includes static preview guidance for non-verification leave-open requests", () => {
  const prompt = buildPlannerSystemPrompt(
    buildPromptInput(
      "Build a tech landing page on my Desktop and leave it open in a browser for me."
    )
  );

  assert.match(prompt, /prefer opening a static artifact directly with an absolute file:\/\/ URL/i);
  assert.doesNotMatch(prompt, /Live-run verification intent detected/i);
});

test("local workspace organization requests are classified as executable local work", () => {
  const currentUserRequest =
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.";

  assert.equal(isExecutionStyleBuildRequest(currentUserRequest), false);
  assert.equal(isLocalWorkspaceOrganizationRequest(currentUserRequest), true);
});

test("implicit go-into phrasing still classifies as executable local organization work", () => {
  const currentUserRequest =
    "Every folder with the name beginning in drone should go in drone-folder on my desktop.";

  assert.equal(isExecutionStyleBuildRequest(currentUserRequest), false);
  assert.equal(isLocalWorkspaceOrganizationRequest(currentUserRequest), true);
});

test("clean-up phrasing over my desktop still classifies as executable local organization work", () => {
  const currentUserRequest =
    "One last real-world thing: please go ahead and clean up my desktop now by moving every folder there that starts with drone-company into drone-folder. I do mean all of them, so you do not need to ask again before doing it.";

  assert.equal(isExecutionStyleBuildRequest(currentUserRequest), false);
  assert.equal(isLocalWorkspaceOrganizationRequest(currentUserRequest), true);
  assert.equal(requiresExecutableBuildPlan(currentUserRequest), true);
});

test("starting an existing React app from an explicit Desktop path still classifies as execution-style build work", () => {
  const currentUserRequest =
    "In C:\\Users\\testuser\\Desktop\\AI Drone City, start the React app, wait for the local URL, and open it in the browser.";

  assert.equal(isExecutionStyleBuildRequest(currentUserRequest), true);
});

test("repairing an existing React app in an explicit Desktop path still classifies as execution-style build work", () => {
  const currentUserRequest =
    "Fix the React/Vite project so it runs correctly in C:\\Users\\testuser\\Desktop\\AI Drone City, then open it in the browser.";

  assert.equal(isExecutionStyleBuildRequest(currentUserRequest), true);
});

test("repairing an existing React app via an explicit POSIX Desktop path still classifies as execution-style build work", () => {
  const currentUserRequest =
    "Go to /home/testuser/Desktop/AI Drone City, inspect whether node_modules and dist exist, then run the missing setup steps: install dependencies with npm install, build with npm run build, and open the app in the browser.";

  assert.equal(isExecutionStyleBuildRequest(currentUserRequest), true);
});

test("local workspace organization classification uses the active request from wrapped input", () => {
  const wrappedRequest = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
    "- assistant: I moved most of them already.",
    "",
    "Current user request:",
    "Change the hero image to a slider instead of the landing page."
  ].join("\n");

  assert.equal(isExecutionStyleBuildRequest(wrappedRequest), false);
  assert.equal(isLocalWorkspaceOrganizationRequest(wrappedRequest), false);
});

test("local workspace organization classification ignores trailing AgentFriend broker packets after the active request", () => {
  const wrappedRequest = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
    "- assistant: I moved most of them already.",
    "",
    "Current user request:",
    "Change the hero image to a slider instead of the landing page.",
    "",
    "[AgentFriendMemoryBroker]",
    "retrievalMode=query_aware",
    "domainLanes=workflow",
    "domainBoundaryDecision=inject_profile_context",
    "",
    "[AgentFriendProfileContext]",
    "contact.billy.note: moved projects earlier."
  ].join("\n");

  assert.equal(isExecutionStyleBuildRequest(wrappedRequest), false);
  assert.equal(isLocalWorkspaceOrganizationRequest(wrappedRequest), false);
});

test("buildPlannerSystemPrompt includes organization guidance for earlier project folders", () => {
  const prompt = buildPlannerSystemPrompt(
    buildPromptInput(
      "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects."
    )
  );

  assert.match(prompt, /local workspace-organization goal/i);
  assert.match(prompt, /executable local workspace organization, not a guidance-only question/i);
  assert.match(prompt, /prefer \/home\/testuser\/Desktop as the concrete user-owned root/i);
  assert.match(prompt, /bounded finite shell_command is allowed here for folder creation and move steps/i);
  assert.match(prompt, /do not complete the organization request by themselves/i);
  assert.match(prompt, /same plan must retry the actual scoped move after those recovery steps/i);
  assert.match(prompt, /explicitly exclude that destination from the move set before moving anything/i);
  assert.match(prompt, /Prefer exact tracked stop_process actions first, then holder inspection or clarification/i);
  assert.doesNotMatch(prompt, /do not emit shell_command/i);
});

test("buildPlannerSystemPrompt reuses exact workspace-recovery ids from current request context", () => {
  const prompt = buildPlannerSystemPrompt(
    buildPromptInput(
      [
        "Workspace recovery context for this chat:",
        "- Preferred workspace root: C:\\Users\\testuser\\Desktop\\drone-company",
        "- Preferred preview URL: http://127.0.0.1:4173/",
        "- Exact tracked browser session ids: browser_session:landing-page",
        "- Exact tracked preview lease ids: proc_preview_1",
        "",
        "Current user request:",
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects."
      ].join("\n"),
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4096,
        desktopPath: "C:\\Users\\testuser\\Desktop",
        documentsPath: "C:\\Users\\testuser\\Documents",
        downloadsPath: "C:\\Users\\testuser\\Downloads"
      }
    )
  );

  assert.match(prompt, /workspace-recovery facts from the runtime/i);
  assert.match(prompt, /Prefer the tracked workspace root C:\\Users\\testuser\\Desktop\\drone-company/i);
  assert.match(prompt, /Prefer the tracked preview URL http:\/\/127\.0\.0\.1:4173\//i);
  assert.match(prompt, /prefer these exact tracked browser session ids: browser_session:landing-page/i);
  assert.match(prompt, /prefer these exact tracked preview lease ids: proc_preview_1/i);
  assert.match(prompt, /Do not ignore exact runtime ids from the request context and replace them with broad process-name shutdown/i);
});

test("buildPlannerSystemPrompt treats candidate-only workspace-recovery hints as inspection-only", () => {
  const prompt = buildPlannerSystemPrompt(
    buildPromptInput(
      [
        "Workspace recovery context for this chat:",
        "- No exact tracked workspace holder is currently known for this request.",
        "- Candidate runtime-managed preview lease: leaseId=proc_preview_candidate; cwd=C:\\Users\\testuser\\Desktop\\drone-company; status=PROCESS_STILL_RUNNING; stopRequested=no",
        "",
        "Current user request:",
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects."
      ].join("\n"),
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4096,
        desktopPath: "C:\\Users\\testuser\\Desktop",
        documentsPath: "C:\\Users\\testuser\\Documents",
        downloadsPath: "C:\\Users\\testuser\\Downloads"
      }
    )
  );

  assert.match(prompt, /no exact tracked workspace holder is known yet/i);
  assert.match(prompt, /Candidate preview leases from this context are inspection hints only, not automatic shutdown proof/i);
  assert.match(prompt, /Do not emit stop_process for candidate-only preview leases until inspect_workspace_resources or inspect_path_holders proves the exact blocker/i);
});

test("buildPlannerSystemPrompt adds Windows PowerShell organization guidance for real move commands and source verification", () => {
  const prompt = buildPlannerSystemPrompt(
    buildPromptInput(
      "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4096,
        desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
        documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
        downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
      }
    )
  );

  assert.match(prompt, /Do not treat an empty shell output as proof that folders were moved/i);
  assert.match(prompt, /verify both sides after the move/i);
  assert.match(prompt, /For this Windows PowerShell runtime, emit real PowerShell syntax only/i);
  assert.match(prompt, /Do not emit cmd\.exe batch syntax such as if not exist, %D, %~fD, or chained && loops/i);
  assert.match(prompt, /do not write invalid fragments like "\$name:" inside double-quoted strings/i);
  assert.match(prompt, /Use \$\{name\}, \$\(\$name\), or concatenation instead/i);
});

test("evaluatePlannerActionValidation repairs inspection-only organization plans into concrete execution", () => {
  const validation = evaluatePlannerActionValidation(
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
    null,
    [
      {
        id: "action_list_only",
        type: "list_directory",
        description: "Inspect the Desktop first.",
        params: {
          path: "/home/testuser/Desktop"
        },
        estimatedCostUsd: 0.02
      }
    ]
  );

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.invalidExecutionStyleBuildPlan, true);
  assert.equal(validation.buildPlanAssessment.issueCode, "INSPECTION_ONLY_BUILD_PLAN");
});

test("evaluatePlannerActionValidation fails closed when organization plan only creates the destination folder", () => {
  const currentUserRequest =
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.";
  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action_create_destination_only",
        type: "shell_command",
        description: "Create the destination folder only.",
        params: {
          command:
            "New-Item -ItemType Directory -Path 'C:\\Users\\testuser\\OneDrive\\Desktop\\drone-web-projects' -Force | Out-Null",
          requestedShellKind: "powershell"
        },
        estimatedCostUsd: 0.08
      },
      {
        id: "action_verify_destination_only",
        type: "list_directory",
        description: "Inspect the destination folder.",
        params: {
          path: "C:\\Users\\testuser\\OneDrive\\Desktop\\drone-web-projects"
        },
        estimatedCostUsd: 0.04
      }
    ],
    currentUserRequest,
    {
      platform: "win32",
      shellKind: "powershell",
      invocationMode: "inline_command",
      commandMaxChars: 4096,
      desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
      documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
      downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
    }
  );

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.invalidExecutionStyleBuildPlan, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "LOCAL_ORGANIZATION_SHELL_ACTION_REQUIRED"
  );
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /did not include a real folder-move step/i
  );
});

test("evaluatePlannerActionValidation fails closed when the move selector also matches the named destination", () => {
  const currentUserRequest =
    'Every folder with the name beginning in drone should go in "drone-folder" on my desktop.';
  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action_move_drone_folders_without_exclusion",
        type: "shell_command",
        description: "Move every matching drone folder into the destination.",
        params: {
          command: [
            "$destination = 'C:\\Users\\testuser\\OneDrive\\Desktop\\drone-folder'",
            "if (-not (Test-Path -LiteralPath $destination)) {",
            "  New-Item -ItemType Directory -Path $destination -Force | Out-Null",
            "}",
            "Get-ChildItem -Path 'C:\\Users\\testuser\\OneDrive\\Desktop' -Directory |",
            "  Where-Object { $_.Name -like 'drone*' } |",
            "  ForEach-Object {",
            "    Move-Item -LiteralPath $_.FullName -Destination $destination -Force -ErrorAction Stop",
            "  }"
            ].join("\n"),
          requestedShellKind: "powershell"
        },
        estimatedCostUsd: 0.21
      }
    ],
    currentUserRequest,
    {
      platform: "win32",
      shellKind: "powershell",
      invocationMode: "inline_command",
      commandMaxChars: 4096,
      desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
      documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
      downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
    }
  );

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.invalidExecutionStyleBuildPlan, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "LOCAL_ORGANIZATION_DESTINATION_SELF_MATCH_DISALLOWED"
  );
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /destination folder as part of the same move set/i
  );
});

test("evaluatePlannerActionValidation allows organization moves that explicitly exclude the destination", () => {
  const currentUserRequest =
    'Every folder with the name beginning in drone should go in "drone-folder" on my desktop.';
  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action_move_drone_folders_with_exclusion",
        type: "shell_command",
        description: "Move matching drone folders while excluding the destination itself.",
        params: {
          command: [
            "$destination = 'C:\\Users\\testuser\\OneDrive\\Desktop\\drone-folder'",
            "$destinationName = 'drone-folder'",
            "if (-not (Test-Path -LiteralPath $destination)) {",
            "  New-Item -ItemType Directory -Path $destination -Force | Out-Null",
            "}",
            "Get-ChildItem -Path 'C:\\Users\\testuser\\OneDrive\\Desktop' -Directory |",
            "  Where-Object { $_.Name -like 'drone*' -and $_.Name -ne $destinationName } |",
            "  ForEach-Object {",
            "    Move-Item -LiteralPath $_.FullName -Destination $destination -Force -ErrorAction Stop",
            "  }",
            "Write-Output 'DEST_CONTENTS:'",
            "Get-ChildItem -LiteralPath $destination -Directory | Select-Object -ExpandProperty Name",
            "Write-Output 'ROOT_REMAINING_MATCHES:'",
            "Get-ChildItem -Path 'C:\\Users\\testuser\\OneDrive\\Desktop' -Directory |",
            "  Where-Object { $_.Name -like 'drone*' -and $_.Name -ne $destinationName } |",
            "  Select-Object -ExpandProperty Name"
            ].join("\n"),
          requestedShellKind: "powershell"
        },
        estimatedCostUsd: 0.21
      }
    ],
    currentUserRequest,
    {
      platform: "win32",
      shellKind: "powershell",
      invocationMode: "inline_command",
      commandMaxChars: 4096,
      desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
      documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
      downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
    }
  );

  assert.equal(validation.needsRepair, false);
  assert.equal(validation.invalidExecutionStyleBuildPlan, false);
  assert.equal(validation.buildPlanAssessment.issueCode, null);
});

test("evaluatePlannerActionValidation fails closed when an organization move has no bounded proof", () => {
  const currentUserRequest =
    'Every folder with the name beginning in drone should go in "drone-folder" on my desktop.';
  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action_move_drone_folders_without_proof",
        type: "shell_command",
        description: "Move matching drone folders while excluding the destination itself.",
        params: {
          command: [
            "$destination = 'C:\\Users\\testuser\\OneDrive\\Desktop\\drone-folder'",
            "$destinationName = 'drone-folder'",
            "if (-not (Test-Path -LiteralPath $destination)) {",
            "  New-Item -ItemType Directory -Path $destination -Force | Out-Null",
            "}",
            "Get-ChildItem -Path 'C:\\Users\\testuser\\OneDrive\\Desktop' -Directory |",
            "  Where-Object { $_.Name -like 'drone*' -and $_.Name -ne $destinationName } |",
            "  ForEach-Object {",
            "    Move-Item -LiteralPath $_.FullName -Destination $destination -Force -ErrorAction Stop",
            "  }"
          ].join("\n"),
          requestedShellKind: "powershell"
        },
        estimatedCostUsd: 0.21
      }
    ],
    currentUserRequest,
    {
      platform: "win32",
      shellKind: "powershell",
      invocationMode: "inline_command",
      commandMaxChars: 4096,
      desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
      documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
      downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
    }
  );

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.invalidExecutionStyleBuildPlan, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "LOCAL_ORGANIZATION_PROOF_REQUIRED"
  );
});

test("evaluatePlannerActionValidation fails closed when post-shutdown retry still targets the destination itself", () => {
  const currentUserRequest = buildWorkspaceRecoveryPostShutdownRetryInput(
    'Every folder with the name beginning in drone should go in "drone-folder" on my desktop.'
  );
  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action_retry_bad_destination_self_match",
        type: "shell_command",
        description: "Retry the move without excluding the destination.",
        params: {
          command: [
            "$destination = 'C:\\Users\\testuser\\OneDrive\\Desktop\\drone-folder'",
            "Get-ChildItem -Path 'C:\\Users\\testuser\\OneDrive\\Desktop' -Directory |",
            "  Where-Object { $_.Name -like 'drone*' } |",
            "  ForEach-Object {",
            "    Move-Item -LiteralPath $_.FullName -Destination $destination -Force -ErrorAction Stop",
            "  }"
          ].join("\n"),
          requestedShellKind: "powershell"
        },
        estimatedCostUsd: 0.18
      }
    ],
    currentUserRequest,
    {
      platform: "win32",
      shellKind: "powershell",
      invocationMode: "inline_command",
      commandMaxChars: 4096,
      desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
      documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
      downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
    }
  );

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.invalidExecutionStyleBuildPlan, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "LOCAL_ORGANIZATION_DESTINATION_SELF_MATCH_DISALLOWED"
  );
});

test("evaluatePlannerActionValidation fails closed when a Windows organization plan uses cmd shell moves", () => {
  const currentUserRequest =
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.";
  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action_list_desktop",
        type: "list_directory",
        description: "Inspect Desktop entries before move.",
        params: {
          path: "C:\\Users\\testuser\\OneDrive\\Desktop"
        },
        estimatedCostUsd: 0.06
      },
      {
        id: "action_move_with_cmd",
        type: "shell_command",
        description: "Move matching folders with cmd syntax.",
        params: {
          command:
            "if not exist \"C:\\Users\\testuser\\OneDrive\\Desktop\\drone-web-projects\" mkdir \"C:\\Users\\testuser\\OneDrive\\Desktop\\drone-web-projects\" && for /d %D in (\"C:\\Users\\testuser\\OneDrive\\Desktop\\drone-company*\") do move \"%D\" \"C:\\Users\\testuser\\OneDrive\\Desktop\\drone-web-projects\\\"",
          cwd: "C:\\Users\\testuser\\OneDrive\\Desktop",
          workdir: "C:\\Users\\testuser\\OneDrive\\Desktop",
          requestedShellKind: "cmd"
        },
        estimatedCostUsd: 0.25
      }
    ],
    currentUserRequest,
    {
      platform: "win32",
      shellKind: "powershell",
      invocationMode: "inline_command",
      commandMaxChars: 4096,
      desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
      documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
      downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
    }
  );

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.invalidExecutionStyleBuildPlan, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "WINDOWS_ORGANIZATION_REQUIRES_POWERSHELL"
  );
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /Windows PowerShell organization request/i
  );
});

test("evaluatePlannerActionValidation fails closed when a Windows organization plan uses invalid PowerShell interpolation", () => {
  const currentUserRequest =
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.";
  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action_list_desktop",
        type: "list_directory",
        description: "Inspect Desktop entries before move.",
        params: {
          path: "C:\\Users\\testuser\\OneDrive\\Desktop"
        },
        estimatedCostUsd: 0.06
      },
      {
        id: "action_move_with_invalid_interpolation",
        type: "shell_command",
        description: "Move matching folders and record failures.",
        params: {
          command:
            "$destination = 'C:\\Users\\testuser\\OneDrive\\Desktop\\drone-web-projects';\n$results = @();\nGet-ChildItem -Path 'C:\\Users\\testuser\\OneDrive\\Desktop' -Directory | Where-Object { $_.Name -like 'drone-company*' } | ForEach-Object {\n  $name = $_.Name;\n  try {\n    Move-Item -LiteralPath $_.FullName -Destination $destination -Force -ErrorAction Stop;\n    $results += \"moved:$name\";\n  } catch {\n    $results += \"failed:$name:$($_.Exception.Message)\";\n  }\n}\n$results -join \"`n\"",
          cwd: "C:\\Users\\testuser\\OneDrive\\Desktop",
          workdir: "C:\\Users\\testuser\\OneDrive\\Desktop",
          requestedShellKind: "powershell"
        },
        estimatedCostUsd: 0.25
      }
    ],
    currentUserRequest,
    {
      platform: "win32",
      shellKind: "powershell",
      invocationMode: "inline_command",
      commandMaxChars: 4096,
      desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
      documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
      downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
    }
  );

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.invalidExecutionStyleBuildPlan, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "WINDOWS_ORGANIZATION_INVALID_POWERSHELL_INTERPOLATION"
  );
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /invalid PowerShell variable interpolation/i
  );
});

test("evaluatePlannerActionValidation fails closed when organization recovery omits the actual move step", () => {
  const currentUserRequest =
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.";
  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action_inspect_workspace",
        type: "inspect_workspace_resources",
        description: "Inspect the tracked workspace holders first.",
        params: {
          rootPath: "C:\\Users\\testuser\\OneDrive\\Desktop\\drone-company"
        },
        estimatedCostUsd: 0.03
      },
      {
        id: "action_stop_exact_holder",
        type: "stop_process",
        description: "Stop the exact tracked preview holder.",
        params: {
          leaseId: "proc_preview_1"
        },
        estimatedCostUsd: 0.02
      },
      {
        id: "action_reopen_preview",
        type: "open_browser",
        description: "Bring the remaining preview forward.",
        params: {
          url: "http://127.0.0.1:4173/"
        },
        estimatedCostUsd: 0.03
      }
    ],
    currentUserRequest,
    {
      platform: "win32",
      shellKind: "powershell",
      invocationMode: "inline_command",
      commandMaxChars: 4096,
      desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
      documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
      downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
    }
  );

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.invalidExecutionStyleBuildPlan, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "LOCAL_ORGANIZATION_SHELL_ACTION_REQUIRED"
  );
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /did not include a real folder-move step/i
  );
});

test("evaluatePlannerActionValidation fails closed when a plan uses broad process-name shutdown for recovery", () => {
  const currentUserRequest =
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.";
  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action_broad_shutdown",
        type: "shell_command",
        description: "Stop common apps that might be locking the folders.",
        params: {
          command: "Stop-Process -Name node,Code,OneDrive,explorer -Force"
        },
        estimatedCostUsd: 0.15
      },
      {
        id: "action_move_after_shutdown",
        type: "shell_command",
        description: "Move the matching folders afterward.",
        params: {
          command: "Move-Item \"C:\\Users\\testuser\\OneDrive\\Desktop\\drone-company*\" \"C:\\Users\\testuser\\OneDrive\\Desktop\\drone-web-projects\\\""
        },
        estimatedCostUsd: 0.12
      }
    ],
    currentUserRequest,
    {
      platform: "win32",
      shellKind: "powershell",
      invocationMode: "inline_command",
      commandMaxChars: 4096,
      desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
      documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
      downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
    }
  );

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.invalidExecutionStyleBuildPlan, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "BROAD_PROCESS_SHUTDOWN_DISALLOWED"
  );
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /broad process-name shutdown/i
  );
});

test("evaluatePlannerActionValidation fails closed when candidate-only organization context jumps straight to stop_process", () => {
  const currentUserRequest = [
    "Workspace recovery context for this chat:",
    "- No exact tracked workspace holder is currently known for this request.",
    "- Candidate runtime-managed preview lease: leaseId=proc_preview_candidate; cwd=C:\\Users\\testuser\\Desktop\\drone-company; status=PROCESS_STILL_RUNNING; stopRequested=no",
    "",
    "Current user request:",
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects."
  ].join("\n");

  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action_stop_candidate",
        type: "stop_process",
        description: "Stop the candidate preview holder immediately.",
        params: {
          leaseId: "proc_preview_candidate"
        },
        estimatedCostUsd: 0.02
      }
    ]
  );

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.invalidExecutionStyleBuildPlan, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "CANDIDATE_HOLDER_SHUTDOWN_REQUIRES_INSPECTION"
  );
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /candidate preview holders before inspection proved they were the exact blocker/i
  );
});

test("evaluatePlannerActionValidation allows exact pid shutdown after targeted recovery confirmation", () => {
  const currentUserRequest = [
    "Workspace recovery context for this chat:",
    "- No exact tracked workspace holder is currently known for this request.",
    "",
    "[WORKSPACE_RECOVERY_STOP_EXACT]",
    "A folder move was blocked because one high-confidence local holder still owns the target folders. Stop only this exact confirmed local holder if it is still active: pid=8840 (Code (pid 8840)).",
    "Verify it stopped, then retry this original folder-organization goal: \"Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.\"."
  ].join("\n");

  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action_stop_exact_non_preview_pid",
        type: "stop_process",
        description: "Stop the exact confirmed local holder.",
        params: {
          pid: 8840
        },
        estimatedCostUsd: 0.02
      },
      {
        id: "action_retry_move_after_exact_pid_stop",
        type: "shell_command",
        description: "Retry the scoped folder move.",
        params: {
          command:
            "$destination = 'C:\\Users\\testuser\\Desktop\\drone-web-projects'; " +
            "Get-ChildItem -Path 'C:\\Users\\testuser\\Desktop' -Directory | " +
            "Where-Object { $_.Name -like 'drone-company*' -and $_.Name -ne 'drone-web-projects' } | " +
            "Move-Item -Destination $destination -Force"
        },
        estimatedCostUsd: 0.08
      }
    ]
  );

  assert.equal(validation.needsRepair, false);
  assert.equal(validation.buildPlanAssessment.issueCode, null);
});

test("evaluatePlannerActionValidation allows inspect-only runtime inspection for autonomous workspace recovery", () => {
  const currentUserRequest = buildWorkspaceRecoveryNextUserInput(
    'Every folder with the name beginning in drone should go in "drone-folder" on my desktop.',
    buildWorkspaceRecoverySignalFixture({
      recommendedAction: "inspect_first",
      matchedRuleId: "post_execution_locked_folder_recovery",
      reasoning: "inspect first",
      question: "inspect first?",
      recoveryInstruction: "inspect first"
    })
  );

  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action_inspect_workspace_runtime",
        type: "inspect_workspace_resources",
        description: "Inspect runtime-owned workspace resources first.",
        params: {
          rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
        },
        estimatedCostUsd: 0.04
      }
    ]
  );

  assert.equal(validation.needsRepair, false);
  assert.equal(validation.invalidExecutionStyleBuildPlan, false);
  assert.equal(validation.buildPlanAssessment.issueCode, null);
});

test("evaluatePlannerActionValidation fails closed when autonomous workspace recovery uses handle/openfiles shell inspection", () => {
  const currentUserRequest = buildWorkspaceRecoveryNextUserInput(
    'Every folder with the name beginning in drone should go in "drone-folder" on my desktop.',
    buildWorkspaceRecoverySignalFixture({
      recommendedAction: "inspect_first",
      matchedRuleId: "post_execution_locked_folder_recovery",
      reasoning: "inspect first",
      question: "inspect first?",
      recoveryInstruction: "inspect first"
    })
  );

  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action_shell_handle_probe",
        type: "shell_command",
        description: "Use handle.exe and openfiles to inspect locks.",
        params: {
          command:
            "$handleCmd=(Get-Command handle64.exe,handle.exe -ErrorAction SilentlyContinue | Select-Object -First 1); if($handleCmd){ & $handleCmd.Source 'C:\\Users\\testuser\\Desktop\\drone-company' } else { openfiles /query /fo csv /v }"
        },
        estimatedCostUsd: 0.08
      }
    ]
  );

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.invalidExecutionStyleBuildPlan, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "WORKSPACE_RECOVERY_RUNTIME_INSPECTION_REQUIRED"
  );
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /Use inspect_workspace_resources or inspect_path_holders instead of handle\/openfiles shell scripts/i
  );
});

test("evaluatePlannerActionValidation allows exact-holder recovery to stop the tracked holder before retrying the move", () => {
  const currentUserRequest = buildWorkspaceRecoveryNextUserInput(
    'Every folder with the name beginning in drone should go in "drone-folder" on my desktop.',
    buildWorkspaceRecoverySignalFixture({
      recommendedAction: "stop_exact_tracked_holders",
      matchedRuleId: "post_execution_exact_holder_folder_recovery",
      reasoning: "stop exact tracked holders",
      question: "stop exact tracked holders?",
      recoveryInstruction: "stop exact tracked holders",
      trackedPreviewProcessLeaseIds: ["proc_preview_1"]
    })
  );

  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action_stop_exact_holder",
        type: "stop_process",
        description: "Stop the exact tracked preview holder.",
        params: {
          leaseId: "proc_preview_1"
        },
        estimatedCostUsd: 0.02
      }
    ]
  );

  assert.equal(validation.needsRepair, false);
  assert.equal(validation.invalidExecutionStyleBuildPlan, false);
  assert.equal(validation.buildPlanAssessment.issueCode, null);
});

test("evaluatePlannerActionValidation fails closed when post-shutdown workspace recovery omits the move retry", () => {
  const currentUserRequest = buildWorkspaceRecoveryPostShutdownRetryInput(
    'Every folder with the name beginning in drone should go in "drone-folder" on my desktop.'
  );
  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action-retry-respond",
        type: "respond",
        description: "Acknowledge the retry.",
        params: {
          message: "Retrying now."
        },
        estimatedCostUsd: 0.02
      }
    ]
  );

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.invalidExecutionStyleBuildPlan, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "LOCAL_ORGANIZATION_SHELL_ACTION_REQUIRED"
  );
});

test("evaluatePlannerActionValidation fails closed when post-shutdown workspace recovery omits bounded move proof", () => {
  const currentUserRequest = buildWorkspaceRecoveryPostShutdownRetryInput(
    'Every folder with the name beginning in drone should go in "drone-folder" on my desktop.'
  );
  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    null,
    [
      {
        id: "action_retry_move_without_proof",
        type: "shell_command",
        description: "Retry the move after shutdown without verifying the result.",
        params: {
          command: [
            "$destination = 'C:\\Users\\testuser\\OneDrive\\Desktop\\drone-folder'",
            "$destinationName = 'drone-folder'",
            "if (-not (Test-Path -LiteralPath $destination)) {",
            "  New-Item -ItemType Directory -Path $destination -Force | Out-Null",
            "}",
            "Get-ChildItem -Path 'C:\\Users\\testuser\\OneDrive\\Desktop' -Directory |",
            "  Where-Object { $_.Name -like 'drone*' -and $_.Name -ne $destinationName } |",
            "  ForEach-Object {",
            "    Move-Item -LiteralPath $_.FullName -Destination $destination -Force -ErrorAction Stop",
            "  }"
          ].join("\n"),
          requestedShellKind: "powershell"
        },
        estimatedCostUsd: 0.19
      }
    ],
    currentUserRequest,
    {
      platform: "win32",
      shellKind: "powershell",
      invocationMode: "inline_command",
      commandMaxChars: 4096,
      desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
      documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
      downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
    }
  );

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.invalidExecutionStyleBuildPlan, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "LOCAL_ORGANIZATION_PROOF_REQUIRED"
  );
});

test("buildPlannerRepairSystemPrompt includes repair-specific action requirements", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput('verify_browser url=http://localhost:8000 expect_title="Smoke"'),
    requiredActionType: "verify_browser",
    previousOutput: {
      plannerNotes: "invalid output",
      actions: []
    },
    repairReason: "missing_required_action:verify_browser"
  });

  assert.match(prompt, /repairing a planner JSON output that had no valid actions/i);
  assert.match(prompt, /Repair must include at least one verify_browser action/i);
});

test("browser-control follow-ups are not treated as execution-style build requests", () => {
  const currentUserRequest = "Close the landing page so we can work on something else.";
  assert.equal(isExecutionStyleBuildRequest(currentUserRequest), false);

  const validation = evaluatePlannerActionValidation(currentUserRequest, "close_browser", [
    {
      id: "action_close_browser",
      type: "close_browser",
      description: "Close the tracked landing page preview.",
      params: {
        sessionId: "browser_session:landing-page"
      },
      estimatedCostUsd: 0.03
    }
  ]);

  assert.equal(validation.needsRepair, false);
  assert.equal(validation.invalidExecutionStyleBuildPlan, false);
  assert.equal(validation.missingRequiredAction, false);
});

test("evaluatePlannerActionValidation fails closed when a linked preview stack is not stopped", () => {
  const currentUserRequest = "Close the landing page so we can work on something else.";
  const fullExecutionInput = [
    "Tracked browser sessions:",
    "- Browser window: sessionId=browser_session:landing-page; url=http://127.0.0.1:8125/; status=open; visibility=visible; controller=playwright_managed; control=available; linkedPreviewLease=proc_preview_1; linkedPreviewCwd=C:\\Users\\testuser\\Desktop\\drone-company",
    "",
    "Natural browser-session follow-up:",
    "- Linked preview process: leaseId=proc_preview_1; cwd=C:\\Users\\testuser\\Desktop\\drone-company",
    "",
    "Current user request:",
    currentUserRequest
  ].join("\n");
  const validation = evaluatePlannerActionValidation(
    currentUserRequest,
    "close_browser",
    [
      {
        id: "action_close_browser",
        type: "close_browser",
        description: "Close the tracked landing page preview.",
        params: {
          sessionId: "browser_session:landing-page"
        },
        estimatedCostUsd: 0.03
      }
    ],
    fullExecutionInput
  );

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.missingLinkedPreviewStopProcess, true);
  assert.equal(validation.repairReason, "missing_linked_preview_stop_process:proc_preview_1");
  assert.throws(
    () => assertPlannerActionValidation(validation, "close_browser"),
    /without stopping the linked preview process/i
  );
});

test("buildPlannerSystemPrompt gives tracked-session guidance for natural close-browser follow-ups", () => {
  const prompt = buildPlannerSystemPrompt({
    ...buildPromptInput("Close the landing page so we can work on something else."),
    requiredActionType: "close_browser"
  });

  assert.match(prompt, /explicitly asks to close a tracked browser window/i);
  assert.match(prompt, /prefer the tracked session id from the current request context/i);
  assert.match(prompt, /follow the browser close with stop_process for that same lease/i);
  assert.doesNotMatch(prompt, /Live-run verification intent detected/i);
});

test("buildPlannerSystemPrompt gives mutation guidance for tracked artifact-edit follow-ups", () => {
  const prompt = buildPlannerSystemPrompt({
    ...buildPromptInput("Change the hero image to a slider instead of the landing page."),
    requiredActionType: "write_file"
  });

  assert.match(prompt, /tracked artifact-edit follow-up/i);
  assert.match(prompt, /Include at least one write_file action/i);
  assert.match(prompt, /Do not satisfy this request by only reopening or focusing the preview/i);
  assert.match(prompt, /visible tracked preview already exists in the request context/i);
  assert.match(prompt, /user sees the updated artifact instead of stale content/i);
  assert.match(prompt, /not as a fresh live-verification build/i);
});

test("evaluatePlannerActionValidation fails closed when tracked artifact-edit follow-up returns no write_file", () => {
  const validation = evaluatePlannerActionValidation(
    "Change the hero image to a slider instead of the landing page.",
    "write_file",
    [
      {
        id: "action_open_browser_only",
        type: "open_browser",
        description: "Bring the preview forward.",
        params: {
          url: "http://127.0.0.1:4173/"
        },
        estimatedCostUsd: 0.03
      }
    ]
  );

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.missingRequiredAction, true);
  assert.throws(
    () => assertPlannerActionValidation(validation, "write_file"),
    /missing required write_file action/i
  );
});

test("evaluatePlannerActionValidation allows tracked artifact-edit previews when context proves the edit flow even without explicit required action", () => {
  const fullExecutionInput = [
    "You are in an ongoing conversation with the same user.",
    "Natural artifact-edit follow-up:",
    "- Preferred primary artifact: C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
    "- Visible preview already exists: file:///C:/Users/testuser/Desktop/drone-company/index.html; keep the preview aligned with the edited artifact when practical.",
    "",
    "Current user request:",
    "Change the hero image to a slider instead of the landing page."
  ].join("\n");

  const validation = evaluatePlannerActionValidation(
    "Change the hero image to a slider instead of the landing page.",
    null,
    [
      {
        id: "action_write_file_slider",
        type: "write_file",
        description: "Update the tracked landing page artifact.",
        params: {
          path: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
          content: "<section class=\"hero-slider\">updated</section>"
        },
        estimatedCostUsd: 0.08
      },
      {
        id: "action_open_browser_preview",
        type: "open_browser",
        description: "Reopen the same local preview.",
        params: {
          url: "file:///C:/Users/testuser/Desktop/drone-company/index.html"
        },
        estimatedCostUsd: 0.03
      }
    ],
    fullExecutionInput
  );

  assert.equal(validation.needsRepair, false);
  assert.equal(validation.invalidExecutionStyleBuildPlan, false);
  assert.equal(validation.buildPlanAssessment.issueCode, null);
});

test("evaluatePlannerActionValidation does not require folder-move steps for wrapped artifact-edit follow-ups", () => {
  const wrappedRequest = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
    "- assistant: I moved most of them already.",
    "",
    "Natural artifact-edit follow-up:",
    "- Preferred primary artifact: C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
    "",
    "Current user request:",
    "Change the hero image to a slider instead of the landing page."
  ].join("\n");

  const validation = evaluatePlannerActionValidation(
    wrappedRequest,
    "write_file",
    [
      {
        id: "action_write_file_slider_wrapped",
        type: "write_file",
        description: "Update the tracked landing page artifact.",
        params: {
          path: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
          content: "<section class=\"hero-slider\">updated</section>"
        },
        estimatedCostUsd: 0.08
      }
    ],
    wrappedRequest
  );

  assert.equal(validation.needsRepair, false);
  assert.equal(validation.invalidExecutionStyleBuildPlan, false);
  assert.equal(validation.buildPlanAssessment.issueCode, null);
});

test("buildPlannerRepairSystemPrompt explains linked preview shutdown repairs", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput("Close the landing page so we can work on something else."),
    requiredActionType: "close_browser",
    previousOutput: {
      plannerNotes: "close browser only",
      actions: []
    },
    repairReason: "missing_linked_preview_stop_process:proc_preview_1"
  });

  assert.match(prompt, /closed the tracked browser window without stopping the linked local preview process/i);
  assert.match(prompt, /adding stop_process with params\.leaseId set to the linked preview lease/i);
});

test("buildPlannerRepairSystemPrompt explains Windows organization shell repairs", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput(
      "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4096,
        desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
        documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
        downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
      }
    ),
    previousOutput: {
      plannerNotes: "cmd move plan",
      actions: []
    },
    repairReason: "invalid_execution_style_build_plan:WINDOWS_ORGANIZATION_REQUIRES_POWERSHELL"
  });

  assert.match(prompt, /used cmd-style folder-move commands for a Windows PowerShell organization request/i);
  assert.match(prompt, /using PowerShell-native syntax only/i);
  assert.match(prompt, /Get-ChildItem, Where-Object, and Move-Item/i);
});

test("buildPlannerRepairSystemPrompt explains missing organization move repairs", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput(
      "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4096,
        desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
        documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
        downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
      }
    ),
    previousOutput: {
      plannerNotes: "inspection and holder cleanup only",
      actions: []
    },
    repairReason: "invalid_execution_style_build_plan:LOCAL_ORGANIZATION_SHELL_ACTION_REQUIRED"
  });

  assert.match(prompt, /stopped at inspection or holder cleanup without retrying the actual folder move/i);
  assert.match(prompt, /including a real shell_command that creates the destination folder if needed and retries the scoped move/i);
  assert.match(prompt, /verify both the destination and the original root/i);
});

test("buildPlannerRepairSystemPrompt explains destination self-match organization repairs", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput(
      'Every folder with the name beginning in drone should go in "drone-folder" on my desktop.',
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4096,
        desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
        documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
        downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
      }
    ),
    previousOutput: {
      plannerNotes: "move every drone* folder into drone-folder",
      actions: []
    },
    repairReason:
      "invalid_execution_style_build_plan:LOCAL_ORGANIZATION_DESTINATION_SELF_MATCH_DISALLOWED"
  });

  assert.match(prompt, /move selector also matched the named destination folder/i);
  assert.match(prompt, /excluding the destination explicitly from the source filter/i);
  assert.match(prompt, /verify that only the matching source folders moved into the destination/i);
});

test("buildPlannerRepairSystemPrompt explains bounded proof repairs for organization retries", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput(
      'Every folder with the name beginning in drone should go in "drone-folder" on my desktop.',
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4096,
        desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
        documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
        downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
      }
    ),
    previousOutput: {
      plannerNotes: "retry the move only",
      actions: []
    },
    repairReason: "invalid_execution_style_build_plan:LOCAL_ORGANIZATION_PROOF_REQUIRED"
  });

  assert.match(prompt, /retried the folder move without bounded proof/i);
  assert.match(prompt, /destination and original root/i);
  assert.match(prompt, /MOVED_TO_DEST \/ REMAINING_AT_DESKTOP/i);
});

test("buildPlannerRepairSystemPrompt explains Windows organization interpolation repairs", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput(
      "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4096,
        desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
        documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
        downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
      }
    ),
    previousOutput: {
      plannerNotes: "powershell move plan with invalid interpolation",
      actions: []
    },
    repairReason:
      "invalid_execution_style_build_plan:WINDOWS_ORGANIZATION_INVALID_POWERSHELL_INTERPOLATION"
  });

  assert.match(prompt, /invalid PowerShell string interpolation/i);
  assert.match(prompt, /avoiding raw variable fragments like "\$name:"/i);
  assert.match(prompt, /Use \$\{name\}, subexpressions like \$\(\$name\), or string concatenation instead/i);
});

test("buildPlannerRepairSystemPrompt explains broad shutdown repairs", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput(
      "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4096,
        desktopPath: "C:\\Users\\testuser\\OneDrive\\Desktop",
        documentsPath: "C:\\Users\\testuser\\OneDrive\\Documents",
        downloadsPath: "C:\\Users\\testuser\\OneDrive\\Downloads"
      }
    ),
    previousOutput: {
      plannerNotes: "stop common apps and move the folders",
      actions: []
    },
    repairReason: "invalid_execution_style_build_plan:BROAD_PROCESS_SHUTDOWN_DISALLOWED"
  });

  assert.match(prompt, /stopping broad apps by process name/i);
  assert.match(prompt, /use exact tracked stop_process actions/i);
  assert.match(prompt, /Do not emit Stop-Process -Name, taskkill \/IM, pkill, killall/i);
});

test("buildPlannerRepairSystemPrompt explains framework app scaffold repairs", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput(
      "Create a React landing page app on my Desktop, open it in a browser, and leave it open for me."
    ),
    previousOutput: {
      plannerNotes: "write src files only",
      actions: []
    },
    repairReason:
      "invalid_execution_style_build_plan:FRAMEWORK_APP_SCAFFOLD_ACTION_REQUIRED"
  });

  assert.match(prompt, /fresh framework-app request like a file-only edit/i);
  assert.match(prompt, /real toolchain step that can scaffold, install, build, preview, or run the app/i);
  assert.match(prompt, /Do not return only src-file writes/i);
});

test("buildPlannerRepairSystemPrompt explains framework app artifact-check repairs", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput(
      "Create a React landing page app on my Desktop, open it in a browser, and leave it open for me."
    ),
    previousOutput: {
      plannerNotes: "skip scaffold when the folder exists",
      actions: []
    },
    repairReason:
      "invalid_execution_style_build_plan:FRAMEWORK_APP_ARTIFACT_CHECK_REQUIRED"
  });

  assert.match(prompt, /folder existence alone as proof the framework app already exists/i);
  assert.match(prompt, /checking for real scaffold artifacts such as package\.json/i);
  assert.match(prompt, /If the folder exists but package\.json is missing, complete the scaffold or repair in place/i);
});

test("buildPlannerRepairSystemPrompt explains framework app in-place scaffold repairs", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput(
      "Create a React landing page app on my Desktop in a folder called AI Drone City, open it in a browser, and leave it open for me."
    ),
    previousOutput: {
      plannerNotes: "recreate named folder from parent",
      actions: []
    },
    repairReason:
      "invalid_execution_style_build_plan:FRAMEWORK_APP_IN_PLACE_SCAFFOLD_REQUIRED"
  });

  assert.match(prompt, /checked the exact folder for package\.json/i);
  assert.match(prompt, /scaffolding or repairing in place inside the exact requested folder/i);
  assert.match(prompt, /using '\.' as the scaffold target|using '.' as the scaffold target/i);
});

test("buildPlannerRepairSystemPrompt explains framework app native preview repairs", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput(
      "Create a React landing page app on my Desktop, run it locally on localhost, open it in a browser, and leave it open for me."
    ),
    previousOutput: {
      plannerNotes: "serve the dist folder with npx serve",
      actions: []
    },
    repairReason:
      "invalid_execution_style_build_plan:FRAMEWORK_APP_NATIVE_PREVIEW_REQUIRED"
  });

  assert.match(prompt, /used an ad-hoc preview server/i);
  assert.match(prompt, /workspace-native preview\/runtime command/i);
  assert.match(prompt, /npm run preview, npm run dev, vite preview, or vite dev/i);
});

test("buildPlannerRepairSystemPrompt explains shell command budget repairs", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput(
      "Create a React landing page app on my Desktop, run it locally on localhost, open it in a browser, and leave it open for me."
    ),
    previousOutput: {
      plannerNotes: "inline everything in one giant shell script",
      actions: []
    },
    repairReason:
      "invalid_execution_style_build_plan:SHELL_COMMAND_MAX_CHARS_EXCEEDED"
  });

  assert.match(prompt, /exceeded the runtime's command-length budget/i);
  assert.match(prompt, /splitting large inline file creation into separate write_file actions/i);
  assert.match(prompt, /separate npm install, npm run build, and npm run preview commands/i);
});

test("buildPlannerRepairSystemPrompt keeps exact workspace-recovery ids visible during repair", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput(
      [
        "Workspace recovery context for this chat:",
        "- Preferred workspace root: C:\\Users\\testuser\\Desktop\\drone-company",
        "- Exact tracked preview lease ids: proc_preview_1",
        "",
        "Current user request:",
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects."
      ].join("\n"),
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4096,
        desktopPath: "C:\\Users\\testuser\\Desktop",
        documentsPath: "C:\\Users\\testuser\\Documents",
        downloadsPath: "C:\\Users\\testuser\\Downloads"
      }
    ),
    previousOutput: {
      plannerNotes: "broad shutdown repair",
      actions: []
    },
    repairReason: "invalid_execution_style_build_plan:BROAD_PROCESS_SHUTDOWN_DISALLOWED"
  });

  assert.match(prompt, /workspace-recovery facts from the runtime/i);
  assert.match(prompt, /Prefer the tracked workspace root C:\\Users\\testuser\\Desktop\\drone-company/i);
  assert.match(prompt, /prefer these exact tracked preview lease ids: proc_preview_1/i);
});

test("buildPlannerRepairSystemPrompt explains candidate-only holder repairs", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput(
      [
        "Workspace recovery context for this chat:",
        "- No exact tracked workspace holder is currently known for this request.",
        "- Candidate runtime-managed preview lease: leaseId=proc_preview_candidate; cwd=C:\\Users\\testuser\\Desktop\\drone-company; status=PROCESS_STILL_RUNNING; stopRequested=no",
        "",
        "Current user request:",
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects."
      ].join("\n"),
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4096,
        desktopPath: "C:\\Users\\testuser\\Desktop",
        documentsPath: "C:\\Users\\testuser\\Documents",
        downloadsPath: "C:\\Users\\testuser\\Downloads"
      }
    ),
    previousOutput: {
      plannerNotes: "stop candidate lease now",
      actions: []
    },
    repairReason: "invalid_execution_style_build_plan:CANDIDATE_HOLDER_SHUTDOWN_REQUIRES_INSPECTION"
  });

  assert.match(prompt, /treated candidate preview-holder hints as if they were exact shutdown proof/i);
  assert.match(prompt, /Repair by inspecting first with inspect_workspace_resources or inspect_path_holders/i);
  assert.match(prompt, /If the result still leaves only likely holders, ask for clarification before shutdown/i);
});

test("buildPlannerRepairSystemPrompt explains runtime inspection repairs for autonomous workspace recovery", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput(
      buildWorkspaceRecoveryNextUserInput(
        'Every folder with the name beginning in drone should go in "drone-folder" on my desktop.',
        buildWorkspaceRecoverySignalFixture({
          recommendedAction: "inspect_first",
          matchedRuleId: "post_execution_locked_folder_recovery",
          reasoning: "inspect first",
          question: "inspect first?",
          recoveryInstruction: "inspect first"
        })
      ),
      {
        platform: "win32",
        shellKind: "powershell",
        invocationMode: "inline_command",
        commandMaxChars: 4096,
        desktopPath: "C:\\Users\\testuser\\Desktop",
        documentsPath: "C:\\Users\\testuser\\Documents",
        downloadsPath: "C:\\Users\\testuser\\Downloads"
      }
    ),
    previousOutput: {
      plannerNotes: "use handle.exe for lock discovery",
      actions: []
    },
    repairReason: "invalid_execution_style_build_plan:WORKSPACE_RECOVERY_RUNTIME_INSPECTION_REQUIRED"
  });

  assert.match(prompt, /must stay on the governed runtime inspection tools/i);
  assert.match(prompt, /inspect_workspace_resources or inspect_path_holders first/i);
  assert.match(prompt, /Do not use handle\.exe, handle64\.exe, openfiles/i);
});

test("ensureRespondMessages backfills missing respond text and run-skill post-policy can fall back to respond", async () => {
  const modelClient = new ResponseOnlyModelClient("safe response-only plan");
  const task = buildTask("Research deterministic sandboxing controls and provide distilled findings.");
  const backfilledActions = await ensureRespondMessages(
    modelClient,
    [
      {
        id: "action_missing_message",
        type: "respond",
        description: "reply to the user",
        params: {},
        estimatedCostUsd: 0.01
      }
    ],
    task,
    "mock-synth"
  );

  assert.equal(backfilledActions[0].params.message, "safe response-only plan");

  const postPolicy = await enforceRunSkillIntentPolicy(
    modelClient,
    [
      {
        id: "action_run_skill_only",
        type: "run_skill",
        description: "run workflow skill",
        params: {
          name: "workflow_skill"
        },
        estimatedCostUsd: 0.05
      }
    ],
    task,
    "mock-synth",
    task.userInput
  );

  assert.equal(postPolicy.usedFallback, true);
  assert.equal(postPolicy.actions[0].type, "respond");
  assert.equal(postPolicy.actions[0].params.message, "safe response-only plan");

  const fallback = buildNonExplicitRunSkillFallbackAction("fallback message");
  assert.equal(fallback.type, "respond");
  assert.equal(fallback.params.message, "fallback message");
});

test("workspace-recovery marker requests fail closed instead of collapsing to run-skill fallback", async () => {
  const currentUserRequest = buildWorkspaceRecoveryNextUserInput(
    "Every folder with the name beginning in drone should go in drone-folder on my desktop.",
    buildWorkspaceRecoverySignalFixture({
      recommendedAction: "inspect_first",
      matchedRuleId: "post_execution_locked_folder_recovery",
      reasoning: "Inspect first.",
      question: "Inspect first?",
      recoveryInstruction: "Inspect first."
    })
  );

  assert.equal(
    shouldUseNonExplicitRunSkillFallback(
      currentUserRequest,
      null,
      {
        actions: [],
        filteredRunSkillOnly: true
      },
      {
        actions: [],
        filteredRunSkillOnly: true
      }
    ),
    false
  );

  const modelClient = new ResponseOnlyModelClient("safe response-only plan");
  const task = buildTask(currentUserRequest);
  await assert.rejects(
    () =>
      enforceRunSkillIntentPolicy(
        modelClient,
        [
          {
            id: "action_run_skill_only",
            type: "run_skill",
            description: "run workflow skill",
            params: {
              name: "workflow_skill"
            },
            estimatedCostUsd: 0.05
          }
        ],
        task,
        "mock-synth",
        currentUserRequest
      ),
    /workspace-recovery step into non-explicit run_skill output/i
  );
});

test("assessExecutionStyleBuildPlan enforces inspect-first recovery markers from wrapped execution input", () => {
  const currentUserRequest =
    'Every folder with the name beginning in drone should go in "drone-folder" on my desktop.';
  const fullExecutionInput = buildWorkspaceRecoveryNextUserInput(
    currentUserRequest,
    buildWorkspaceRecoverySignalFixture({
      recommendedAction: "inspect_first",
      matchedRuleId: "post_execution_locked_folder_recovery",
      reasoning: "Inspect first.",
      question: "Inspect first?",
      recoveryInstruction:
        "Inspect the relevant workspace resources or path holders first.",
      blockedFolderPaths: [
        "C:\\Users\\testuser\\Desktop\\drone-company-a"
      ]
    })
  );

  const assessment = assessExecutionStyleBuildPlan(
    currentUserRequest,
    [
      {
        id: "action_move_only",
        type: "shell_command",
        description: "Retry the move immediately.",
        params: {
          command:
            "Move-Item -LiteralPath 'C:\\Users\\testuser\\Desktop\\drone-company-a' -Destination 'C:\\Users\\testuser\\Desktop\\drone-folder' -Force"
        },
        estimatedCostUsd: 0.08
      }
    ],
    null,
    {
      platform: "win32",
      shellKind: "powershell",
      invocationMode: "inline_command",
      commandMaxChars: 4096,
      desktopPath: "C:\\Users\\testuser\\Desktop",
      documentsPath: "C:\\Users\\testuser\\Documents",
      downloadsPath: "C:\\Users\\testuser\\Downloads"
    },
    fullExecutionInput
  );

  assert.deepEqual(assessment, {
    valid: false,
    issueCode: "WORKSPACE_RECOVERY_EXACT_PATH_INSPECTION_REQUIRED"
  });
});

test("buildDeterministicWorkspaceRecoveryFallbackActions prefers blocked path inspection for inspect-first recovery", () => {
  const currentUserRequest = [
    "[WORKSPACE_RECOVERY_INSPECT_FIRST]",
    "A folder move was blocked because the target folders are still in use.",
    "Blocked folder paths: C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1."
  ].join("\n");
  const fullExecutionInput = [
    "Workspace recovery context for this chat:",
    "- Preferred workspace root: C:\\Users\\testuser\\Desktop\\drone-company",
    "- Preferred preview URL: http://127.0.0.1:4173/",
    "- Exact tracked browser session ids: browser_session:drone-page",
    "- Exact tracked preview lease ids: proc_preview_drone"
  ].join("\n");

  const actions = buildDeterministicWorkspaceRecoveryFallbackActions(
    currentUserRequest,
    fullExecutionInput
  );

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "inspect_path_holders");
  assert.equal(
    actions[0]?.params.path,
    "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1."
  );
});

test("buildDeterministicWorkspaceRecoveryFallbackActions inspects each blocked path for inspect-first recovery", () => {
  const currentUserRequest = [
    "[WORKSPACE_RECOVERY_INSPECT_FIRST]",
    "A folder move was blocked because the target folders are still in use.",
    "Blocked folder paths: C:\\Users\\testuser\\Desktop\\drone-company, C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1."
  ].join("\n");

  const actions = buildDeterministicWorkspaceRecoveryFallbackActions(
    currentUserRequest,
    currentUserRequest
  );

  assert.deepEqual(
    actions.map((action) => ({
      type: action.type,
      path: action.params.path
    })),
    [
      {
        type: "inspect_path_holders",
        path: "C:\\Users\\testuser\\Desktop\\drone-company"
      },
      {
        type: "inspect_path_holders",
        path: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1."
      }
    ]
  );
});

test("buildDeterministicWorkspaceRecoveryFallbackActions reuses exact workspace selectors when blocked path is absent", () => {
  const currentUserRequest = [
    "[WORKSPACE_RECOVERY_INSPECT_FIRST]",
    "Inspect the relevant workspace resources or path holders first."
  ].join("\n");
  const fullExecutionInput = [
    "Workspace recovery context for this chat:",
    "- Preferred workspace root: C:\\Users\\testuser\\Desktop\\drone-company",
    "- Preferred preview URL: http://127.0.0.1:4173/",
    "- Exact tracked browser session ids: browser_session:drone-page",
    "- Exact tracked preview lease ids: proc_preview_drone"
  ].join("\n");

  const actions = buildDeterministicWorkspaceRecoveryFallbackActions(
    currentUserRequest,
    fullExecutionInput
  );

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "inspect_workspace_resources");
  assert.equal(actions[0]?.params.rootPath, "C:\\Users\\testuser\\Desktop\\drone-company");
  assert.equal(actions[0]?.params.previewUrl, "http://127.0.0.1:4173/");
  assert.equal(actions[0]?.params.browserSessionId, "browser_session:drone-page");
  assert.equal(actions[0]?.params.previewProcessLeaseId, "proc_preview_drone");
});

test("buildDeterministicWorkspaceRecoveryFallbackActions emits exact stop_process actions for stop-exact recovery", () => {
  const currentUserRequest = [
    "[WORKSPACE_RECOVERY_STOP_EXACT]",
    "Stop only these exact tracked preview-process lease ids if they are still active: leaseId=\"proc_preview_1\", leaseId=\"proc_preview_2\"."
  ].join("\n");

  const actions = buildDeterministicWorkspaceRecoveryFallbackActions(
    currentUserRequest,
    currentUserRequest
  );

  assert.deepEqual(
    actions.map((action) => ({
      type: action.type,
      leaseId: action.params.leaseId
    })),
    [
      {
        type: "stop_process",
        leaseId: "proc_preview_1"
      },
      {
        type: "stop_process",
        leaseId: "proc_preview_2"
      }
    ]
  );
});

test("buildDeterministicWorkspaceRecoveryFallbackActions emits exact stop_process pid actions when recovery proved recovered holders", () => {
  const currentUserRequest = [
    "[WORKSPACE_RECOVERY_STOP_EXACT]",
    "Stop only these exact preview holders if they are still active: pid=5724, pid=31908."
  ].join("\n");

  const actions = buildDeterministicWorkspaceRecoveryFallbackActions(
    currentUserRequest,
    currentUserRequest
  );

  assert.deepEqual(
    actions.map((action) => ({
      type: action.type,
      pid: action.params.pid
    })),
    [
      {
        type: "stop_process",
        pid: 5724
      },
      {
        type: "stop_process",
        pid: 31908
      }
    ]
  );
});

test("buildDeterministicExplicitRuntimeActionFallbackActions synthesizes inspect_path_holders actions from explicit tool requests", () => {
  const actions = buildDeterministicExplicitRuntimeActionFallbackActions(
    "Execute inspect_path_holders on `C:\\Users\\testuser\\Desktop\\drone-company-a` and `C:\\Users\\testuser\\Desktop\\drone-company-b` now.",
    "inspect_path_holders"
  );

  assert.deepEqual(
    actions.map((action) => ({
      type: action.type,
      path: action.params.path
    })),
    [
      {
        type: "inspect_path_holders",
        path: "C:\\Users\\testuser\\Desktop\\drone-company-a"
      },
      {
        type: "inspect_path_holders",
        path: "C:\\Users\\testuser\\Desktop\\drone-company-b"
      }
    ]
  );
});

test("buildDeterministicExplicitRuntimeActionFallbackActions keeps exact blocked paths from verbose workspace recovery inspect requests", () => {
  const actions = buildDeterministicExplicitRuntimeActionFallbackActions(
    "Continue workspace-recovery for the same goal. First run inspect_path_holders (or inspect_workspace_resources) on the remaining blocked paths: 1) C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1773407921176 and 2) C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1773414171194. If exact tracked preview/runtime holders are found, stop only those exact tracked holders, then retry the organization task: move every Desktop folder whose name begins with \"drone\" into C:\\Users\\testuser\\Desktop\\drone-folder. If inspection finds only likely untracked holders, stop and report that user confirmation is required before shutting them down. Do not stop unrelated apps by name.",
    "inspect_path_holders"
  );

  assert.deepEqual(
    actions.map((action) => ({
      type: action.type,
      path: action.params.path
    })),
    [
      {
        type: "inspect_path_holders",
        path: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1773407921176"
      },
      {
        type: "inspect_path_holders",
        path: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1773414171194"
      }
    ]
  );
});

test("buildDeterministicExplicitRuntimeActionFallbackActions synthesizes inspect_workspace_resources from explicit tool requests", () => {
  const actions = buildDeterministicExplicitRuntimeActionFallbackActions(
    "Run inspect_workspace_resources on `C:\\Users\\testuser\\Desktop\\drone-company-a` and report the holders.",
    "inspect_workspace_resources"
  );

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "inspect_workspace_resources");
  assert.equal(actions[0]?.params.rootPath, "C:\\Users\\testuser\\Desktop\\drone-company-a");
});

test("inferRequiredActionType recognizes later-in-sentence inspect tool requests", () => {
  assert.equal(
    inferRequiredActionType(
      "Continue workspace recovery before retrying moves. Use inspect_path_holders on C:\\Users\\testuser\\Desktop\\drone-company-a now."
    ),
    "inspect_path_holders"
  );
});
