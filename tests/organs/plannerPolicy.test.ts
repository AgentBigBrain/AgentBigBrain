/**
 * @fileoverview Tests extracted planner-policy modules directly.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
  buildFrameworkLandingPageContent,
  buildFrameworkLandingPageStyles,
  buildNextLayoutContent,
  buildNextTypeScriptLayoutContent
} from "../../src/organs/plannerPolicy/frameworkRuntimeActionFallbackContent";
import {
  assessExecutionStyleBuildPlan,
  requiresExecutableBuildPlan
} from "../../src/organs/plannerPolicy/buildExecutionPolicy";
import {
  buildWorkspaceRecoveryNextUserInput,
  buildWorkspaceRecoveryPostShutdownRetryInput
} from "../../src/core/autonomy/workspaceRecoveryPolicy";
import {
  isDeterministicFrameworkBuildLaneRequest,
  isExecutionStyleBuildRequest,
  isFrameworkWorkspacePreparationRequest,
  isLocalWorkspaceOrganizationRequest,
  isLiveVerificationBuildRequest,
  requiresBrowserVerificationBuildRequest,
  requiresFrameworkAppScaffoldAction,
  requiresPersistentBrowserOpenBuildRequest
} from "../../src/organs/plannerPolicy/liveVerificationPolicy";
import {
  buildNonExplicitRunSkillFallbackAction,
  enforceRunSkillIntentPolicy,
  ensureRespondMessages
} from "../../src/organs/plannerPolicy/responseSynthesisFallback";
import {
  buildDeterministicExplicitRuntimeActionFallbackActions,
  buildDeterministicFrameworkBuildFallbackActions
} from "../../src/organs/plannerPolicy/explicitRuntimeActionFallback";
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

function buildWindowsExecutionEnvironment(): PlannerExecutionEnvironmentContext {
  return {
    platform: "win32",
    shellKind: "powershell",
    invocationMode: "inline_command",
    commandMaxChars: 4000,
    desktopPath: "C:\\Users\\testuser\\Desktop",
    documentsPath: "C:\\Users\\testuser\\Documents",
    downloadsPath: "C:\\Users\\testuser\\Downloads"
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
    "Run the existing React app in the \"C:\\Users\\testuser\\Desktop\\drone-company\" folder and verify the homepage UI. Execute now.";
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
    "Run the existing React app in the \"C:\\Users\\testuser\\Desktop\\drone-company\" folder, verify the homepage UI, and leave it open for me when you're done. Execute now.";
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
    /already-ready workspace/i
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

test("execution-style build detection accepts natural finish-the-project framework follow-ups", () => {
  const currentUserRequest =
    "Finish the project end to end. Use the scaffolded Next.js app at `C:\\Users\\testuser\\AppData\\Local\\Temp\\agentbigbrain-framework-scaffold\\downtown-detroit-drones`, move or copy it to the desktop as a folder named `downtown-detroit-drones`, implement the landing page for Downtown Detroit Drones, then install/run it, verify it works, and open it in the browser from the desktop location.";

  assert.equal(isExecutionStyleBuildRequest(currentUserRequest), true);
  assert.equal(requiresFrameworkAppScaffoldAction(currentUserRequest), true);
  assert.equal(isLiveVerificationBuildRequest(currentUserRequest), true);
});

test("framework workspace-preparation detection matches natural scaffold-only turns and excludes existing-app runs", () => {
  const workspacePrepRequest =
    "Can you get a new Next.js landing-page workspace started on my desktop and call it Downtown Detroit Drones? Just get the workspace ready for edits with the dependencies installed. Do not run it or open anything yet.";
  const existingRunRequest =
    "Please run my existing Next.js app on my Desktop and open it in the browser for me.";

  assert.equal(requiresFrameworkAppScaffoldAction(workspacePrepRequest), true);
  assert.equal(isFrameworkWorkspacePreparationRequest(workspacePrepRequest), true);
  assert.equal(requiresFrameworkAppScaffoldAction(existingRunRequest), false);
  assert.equal(isFrameworkWorkspacePreparationRequest(existingRunRequest), false);
});

test("deterministic framework build-lane detection covers tracked build, preview, and edit turns but excludes close turns", () => {
  const buildTurnRequest =
    "Great. Now turn that Downtown Detroit Drones workspace into the real landing page. Keep it calm and modern, avoid blue, put a small flying drone in the hero, use four main sections, add a clear call to action and a footer menu, then build it. Stop once the source and build proof are there, but do not run it or open anything yet.";
  const previewTurnRequest =
    "Nice. Pull up the Downtown Detroit Drones landing page you just built so it is ready to view, but do not pop the browser open yet. Use a real localhost run on host 127.0.0.1 and port 54928, and keep that preview server running.";
  const editTurnRequest =
    'One tweak while it stays open: change the second section heading to "Steady local rollout" and make that section mention "Built for neighborhood teams." Keep the page running and refresh whatever needs to refresh so the live page shows the update.';
  const closeTurnRequest =
    "Thanks. Please close the Downtown Detroit Drones landing page now, including the browser window and the linked localhost server.";

  assert.equal(isDeterministicFrameworkBuildLaneRequest(buildTurnRequest), true);
  assert.equal(isDeterministicFrameworkBuildLaneRequest(previewTurnRequest), true);
  assert.equal(isDeterministicFrameworkBuildLaneRequest(editTurnRequest), true);
  assert.equal(isDeterministicFrameworkBuildLaneRequest(closeTurnRequest), false);
});

test("preparePlannerActions rewrites temp-scaffold finalize commands into the bounded merge form", () => {
  const currentUserRequest =
    "Finish the project end to end. Use the scaffolded Next.js app at `C:\\Users\\testuser\\AppData\\Local\\Temp\\agentbigbrain-framework-scaffold\\downtown-detroit-drones`, move or copy it to the desktop as a folder named `downtown-detroit-drones`, implement the landing page for Downtown Detroit Drones, then install/run it, verify it works, and open it in the browser from the desktop location.";
  const preparation = preparePlannerActions(
    {
      plannerNotes: "finalize the scaffold and continue the run",
      actions: [
        {
          type: "shell_command",
          description: "Copy the scaffolded app to the desktop folder.",
          params: {
            command:
              "$src='C:\\Users\\testuser\\AppData\\Local\\Temp\\agentbigbrain-framework-scaffold\\downtown-detroit-drones'; " +
              "$dst='C:\\Users\\testuser\\Desktop\\downtown-detroit-drones'; " +
              "if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }; " +
              "New-Item -ItemType Directory -Path $dst -Force | Out-Null; " +
              "Get-ChildItem -Force $src | ForEach-Object { Move-Item $_.FullName -Destination $dst -Force }"
          }
        }
      ]
    },
    currentUserRequest,
    null,
    undefined,
    buildWindowsExecutionEnvironment()
  );

  assert.equal(preparation.actions.length, 1);
  assert.equal(preparation.actions[0]?.type, "shell_command");
  assert.match(String(preparation.actions[0]?.params.command), /agentbigbrain-framework-scaffold/i);
  assert.doesNotMatch(
    String(preparation.actions[0]?.params.command),
    /Remove-Item\s+-Recurse\s+-Force\s+\$dst/i
  );
  assert.match(String(preparation.actions[0]?.params.command), /Get-ChildItem -Force \$temp/i);
  assert.equal(preparation.actions[0]?.params.cwd, "C:\\Users\\testuser\\Desktop");
});

test('execution-style build detection accepts explicit Desktop paths phrased as in the "..." folder', () => {
  const currentUserRequest =
    'Fix the React/Vite project in the "C:\\Users\\testuser\\OneDrive\\Desktop\\AI Drone City" folder, install dependencies if needed, build it, and open it in the browser.';

  assert.equal(isExecutionStyleBuildRequest(currentUserRequest), true);
  assert.equal(requiresFrameworkAppScaffoldAction(currentUserRequest), false);
});

test("scaffold-only framework-app turns do not require live verification when preview is explicitly deferred", () => {
  const currentUserRequest =
    "Create a new React single page app on my Desktop. Scaffold it and install dependencies, but do not start a preview server, do not verify localhost, and do not open a browser yet.";

  assert.equal(isExecutionStyleBuildRequest(currentUserRequest), true);
  assert.equal(requiresFrameworkAppScaffoldAction(currentUserRequest), true);
  assert.equal(isLiveVerificationBuildRequest(currentUserRequest), false);
  assert.equal(requiresBrowserVerificationBuildRequest(currentUserRequest), false);
  assert.equal(requiresPersistentBrowserOpenBuildRequest(currentUserRequest), false);
});

test("preview-only framework-app turns can require live verification without requiring browser-open proof yet", () => {
  const currentUserRequest =
    "Reuse the existing React workspace on my Desktop. Start its localhost preview server on 127.0.0.1:4173, leave that preview running, and do not open a browser yet.";

  assert.equal(isExecutionStyleBuildRequest(currentUserRequest), true);
  assert.equal(requiresFrameworkAppScaffoldAction(currentUserRequest), false);
  assert.equal(isLiveVerificationBuildRequest(currentUserRequest), true);
  assert.equal(requiresBrowserVerificationBuildRequest(currentUserRequest), false);
  assert.equal(requiresPersistentBrowserOpenBuildRequest(currentUserRequest), false);
});

test("scaffold-only framework-app turns stay non-live when preview/dev server wording is explicitly deferred", () => {
  const currentUserRequest =
    "Create a new React single page app on my Desktop. Scaffold it, install dependencies, and stop after the workspace is ready for edits. Do not start any preview/dev server, do not probe localhost, and do not open or verify a browser yet.";

  assert.equal(isExecutionStyleBuildRequest(currentUserRequest), true);
  assert.equal(requiresFrameworkAppScaffoldAction(currentUserRequest), true);
  assert.equal(isLiveVerificationBuildRequest(currentUserRequest), false);
  assert.equal(requiresBrowserVerificationBuildRequest(currentUserRequest), false);
  assert.equal(requiresPersistentBrowserOpenBuildRequest(currentUserRequest), false);
});

test("natural start-locally and open-in-browser phrasing still classifies as a live persistent framework request", () => {
  const currentUserRequest =
    "Please create a Next.js landing page called Drone City on my Desktop. After you finish, start it locally, open it in my browser, and leave it up for me to view.";

  assert.equal(isExecutionStyleBuildRequest(currentUserRequest), true);
  assert.equal(requiresFrameworkAppScaffoldAction(currentUserRequest), true);
  assert.equal(isLiveVerificationBuildRequest(currentUserRequest), true);
  assert.equal(requiresBrowserVerificationBuildRequest(currentUserRequest), false);
  assert.equal(requiresPersistentBrowserOpenBuildRequest(currentUserRequest), true);
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
    "Create a React landing page app on my Desktop in a folder called drone-city, open it in a browser, and leave it open for me.";
  const validation = evaluatePlannerActionValidation(currentUserRequest, null, [
    {
      id: "action_scaffold_named_folder_from_parent",
      type: "shell_command",
      description: "Scaffold or reuse the React app.",
      params: {
        command: [
          "$desktop = 'C:\\Users\\testuser\\Desktop'",
          "$app = Join-Path $desktop 'drone-city'",
          "if (!(Test-Path (Join-Path $app 'package.json'))) {",
          "  Set-Location $desktop",
          "  npm create vite@latest 'drone-city' -- --template react",
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

test("fresh framework-app requests accept package-safe temp-slug scaffolds that merge into the exact named folder", () => {
  const assessment = assessExecutionStyleBuildPlan(
    "Create a React app on my Desktop in a folder called AI Drone City and execute now.",
    [
      {
        id: "action_framework_safe_slug_merge",
        type: "shell_command",
        description: "Scaffold through a safe slug and merge into the exact folder.",
        params: {
          command: [
            `$desktop = '${buildWindowsExecutionEnvironment().desktopPath}'`,
            "$target = 'AI Drone City'",
            "$slug = 'ai-drone-city'",
            "$targetPath = Join-Path $desktop $target",
            "$slugPath = Join-Path $desktop $slug",
            "if (!(Test-Path (Join-Path $targetPath 'package.json'))) {",
            "  npm create vite@latest $slug -- --template react",
            "  if (Test-Path $targetPath) {",
            "    Get-ChildItem -Force $slugPath | Move-Item -Destination $targetPath",
            "    Remove-Item $slugPath -Force",
            "  } else {",
            "    Rename-Item -Path $slugPath -NewName $target",
            "  }",
            "}",
            "Set-Location $targetPath",
            "npm install"
          ].join("; ")
        }
      }
    ],
    null,
    buildWindowsExecutionEnvironment()
  );

  assert.deepEqual(assessment, {
    valid: true,
    issueCode: null
  });
});

test("fresh Next.js framework-app requests fail closed when create-next-app targets an unsafe exact folder name", () => {
  const currentUserRequest =
    "Please create a Next.js landing page called Drone City on my Desktop, start it locally, open it in my browser, and leave it up for me to view.";
  const validation = evaluatePlannerActionValidation(currentUserRequest, null, [
    {
      id: "action_scaffold_named_folder_from_parent",
      type: "shell_command",
      description: "Scaffold or reuse the Next.js app.",
      params: {
        command: [
          "$desktop = 'C:\\Users\\testuser\\Desktop'",
          "$project = Join-Path $desktop 'Drone City'",
          "if (!(Test-Path (Join-Path $project 'package.json'))) {",
          "  Set-Location $desktop",
          "  npx create-next-app@latest $project --ts --eslint --app --src-dir --use-npm --skip-install --yes",
          "}",
          "Set-Location $project",
          "npm install"
        ].join("; ")
      },
      estimatedCostUsd: 0.25
    },
    {
      id: "action_start_preview",
      type: "start_process",
      description: "Start the Next.js app.",
      params: {
        command: "npm run start -- --hostname 127.0.0.1 --port 3000",
        cwd: "C:\\Users\\testuser\\Desktop\\Drone City"
      },
      estimatedCostUsd: 0.15
    },
    {
      id: "action_probe_http",
      type: "probe_http",
      description: "Wait for localhost readiness.",
      params: {
        url: "http://127.0.0.1:3000",
        expectedStatus: 200
      },
      estimatedCostUsd: 0.04
    },
    {
      id: "action_open_browser",
      type: "open_browser",
      description: "Leave the app open in the browser.",
      params: {
        url: "http://127.0.0.1:3000"
      },
      estimatedCostUsd: 0.03
    }
  ]);

  assert.equal(validation.needsRepair, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "FRAMEWORK_APP_PACKAGE_SAFE_SCAFFOLD_REQUIRED"
  );
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /not a safe npm package name/i
  );
});

test("fresh framework workspace-prep requests fail closed when the plan only creates an empty folder and then builds", () => {
  const currentUserRequest =
    "Can you get a new Next.js landing-page workspace started on my desktop and call it Downtown Detroit Drones? Just get the workspace ready for edits with the dependencies installed. Do not run it or open anything yet.";
  const validation = evaluatePlannerActionValidation(currentUserRequest, null, [
    {
      id: "action_create_empty_folder",
      type: "shell_command",
      description: "Create the requested Desktop folder.",
      params: {
        command: [
          "$desktop = 'C:\\Users\\testuser\\Desktop'",
          "$project = Join-Path $desktop 'Downtown Detroit Drones'",
          "if (!(Test-Path $project)) { New-Item -ItemType Directory -Path $project -Force | Out-Null }",
          "Set-Location $project"
        ].join("; ")
      },
      estimatedCostUsd: 0.25
    },
    {
      id: "action_build_without_scaffold",
      type: "shell_command",
      description: "Build the workspace if package.json is already there.",
      params: {
        command: [
          "if (!(Test-Path '.\\package.json')) { Write-Error 'package.json not found in the target workspace.'; exit 1 }",
          "npm.cmd run build",
          "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
        ].join("; ")
      },
      estimatedCostUsd: 0.25
    }
  ]);

  assert.equal(validation.needsRepair, true);
  assert.equal(
    validation.buildPlanAssessment.issueCode,
    "FRAMEWORK_APP_SCAFFOLD_ACTION_REQUIRED"
  );
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /materialize package\.json/i
  );
});

test("preparePlannerActions rewrites named framework-app scaffolds that still build from a parent safe slug", () => {
  const currentUserRequest =
    "Create a React landing page app on my Desktop in a folder called Drone City, open it in a browser, and leave it open for me.";
  const preparation = preparePlannerActions(
    {
      plannerNotes: "scaffold through a safe slug from the desktop root",
      actions: [
        {
          type: "shell_command",
          description: "Scaffold the React app from the desktop root.",
          params: {
            command: [
              "$desktop = 'C:\\Users\\testuser\\Desktop'",
              "Set-Location $desktop",
              "npm create vite@latest 'drone-city' -- --template react",
              "Set-Location (Join-Path $desktop 'Drone City')",
              "npm install"
            ].join("; ")
          }
        }
      ]
    },
    currentUserRequest,
    null,
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

  assert.equal(preparation.actions.length, 1);
  assert.match(String(preparation.actions[0].params.command), /Move-Item/i);
  assert.match(String(preparation.actions[0].params.command), /Drone City/i);
  assert.match(String(preparation.actions[0].params.command), /drone-city/i);
  assert.match(String(preparation.actions[0].params.command), /package\.json/i);
});

test("preparePlannerActions rewrites temp-slug framework merges that would collide with an existing exact folder", () => {
  const currentUserRequest =
    "Please create a Next.js landing page called Drone City on my Desktop, start it locally, open it in my browser, and leave it up for me to view.";
  const preparation = preparePlannerActions(
    {
      plannerNotes: "scaffold through a temp slug and merge into the existing exact folder",
      actions: [
        {
          type: "shell_command",
          description: "Scaffold the Next.js app through a temp slug and merge into the final folder.",
          params: {
            command: [
              "$final = 'C:\\Users\\testuser\\Desktop\\Drone City'",
              "$temp = Join-Path (Join-Path $env:TEMP 'agentbigbrain-framework-scaffold') 'drone-city'",
              "$tempRoot = Split-Path -Parent $temp",
              "Set-Location $tempRoot",
              "npx create-next-app@latest 'drone-city' --ts --eslint --app --use-npm --yes --skip-install --no-tailwind",
              "if (!(Test-Path $final)) { New-Item -ItemType Directory -Path $final -Force | Out-Null }",
              "Get-ChildItem -Force $temp | ForEach-Object { Move-Item $_.FullName -Destination $final -Force }",
              "Remove-Item $temp -Recurse -Force",
              "Set-Location $final",
              "npm install"
            ].join("; ")
          }
        }
      ]
    },
    currentUserRequest,
    null,
    currentUserRequest,
    buildWindowsExecutionEnvironment()
  );

  assert.equal(preparation.actions.length, 1);
  assert.match(String(preparation.actions[0].params.command), /package\.json/i);
  assert.match(String(preparation.actions[0].params.command), /if \(Test-Path \(Join-Path \$final 'package\.json'\)\)/i);
});

test("framework-app live-run requests fail closed when they use an ad-hoc preview server", () => {
  const currentUserRequest =
    "Run the existing React landing page app in the \"C:\\Users\\testuser\\Desktop\\AI Drone City\" folder locally on localhost, open it in a browser, and leave it open for me.";
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
    "Run the existing React landing page app in the \"C:\\Users\\testuser\\Desktop\\AI Drone City\" folder and leave it open for me in the browser.";
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
    "contact.owen.note: moved projects earlier."
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

  assert.match(prompt, /fresh framework-app request like an already-ready workspace/i);
  assert.match(prompt, /real scaffold or bootstrap step that can materialize package\.json/i);
  assert.match(prompt, /Generic npm install, npm run build, npm run dev, or npm run start commands do not satisfy this/i);
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

test("buildDeterministicExplicitRuntimeActionFallbackActions synthesizes tracked close-browser cleanup from browser follow-up context", () => {
  const currentUserRequest =
    "Thanks. Please close Drone React Preview Smoke 1774659110753, the browser window, and the localhost preview server so we can move on.";
  const fullExecutionInput = [
    "Tracked browser sessions:",
    "- Browser window: sessionId=browser_session:action_demo; url=http://127.0.0.1:60048/; status=open; visibility=visible; controller=playwright_managed; control=available; linkedPreviewLease=proc_preview_demo; linkedPreviewPid=55584; linkedPreviewCwd=C:\\Users\\testuser\\Desktop\\Drone React Preview Smoke 1774659110753",
    "",
    "Natural browser-session follow-up:",
    "- Preferred browser session: Browser window; sessionId=browser_session:action_demo; url=http://127.0.0.1:60048/; status=open; control=available",
    "- Linked preview process: leaseId=proc_preview_demo; cwd=C:\\Users\\testuser\\Desktop\\Drone React Preview Smoke 1774659110753",
    "- If the user wants that visible page closed now, prefer close_browser with params.sessionId=browser_session:action_demo and then stop_process with params.leaseId=proc_preview_demo so the linked local preview stack shuts down fully. Do not stop unrelated processes.",
    "",
    "Current user request:",
    currentUserRequest
  ].join("\n");

  const actions = buildDeterministicExplicitRuntimeActionFallbackActions(
    currentUserRequest,
    "close_browser",
    fullExecutionInput
  );

  assert.deepEqual(
    actions.map((action) => action.type),
    ["close_browser", "stop_process"]
  );
  assert.equal(actions[0]?.params.sessionId, "browser_session:action_demo");
  assert.equal(actions[1]?.params.leaseId, "proc_preview_demo");
});

test("buildDeterministicFrameworkBuildFallbackActions does not hijack tracked close-browser follow-ups", () => {
  const currentUserRequest = [
    "Current tracked workspace in this chat:",
    "- Root path: C:\\Users\\testuser\\Desktop\\Drone React Preview Smoke 1774659110753",
    "- Preview URL: http://127.0.0.1:60048/",
    "- Browser session id: browser_session:action_demo",
    "- Preview process lease: proc_preview_demo",
    "",
    "Tracked browser sessions:",
    "- Browser window: sessionId=browser_session:action_demo; url=http://127.0.0.1:60048/; status=open; visibility=visible; controller=playwright_managed; control=available; linkedPreviewLease=proc_preview_demo; linkedPreviewCwd=C:\\Users\\testuser\\Desktop\\Drone React Preview Smoke 1774659110753",
    "",
    "Current user request:",
    "Thanks. Please close Drone React Preview Smoke 1774659110753, the browser window, and the localhost preview server so we can move on."
  ].join("\n");

  const actions = buildDeterministicFrameworkBuildFallbackActions(
    currentUserRequest,
    buildWindowsExecutionEnvironment()
  );

  assert.deepEqual(actions, []);
});

test("deterministic framework build-lane detection treats polite close phrasing as a close turn", () => {
  assert.equal(
    isDeterministicFrameworkBuildLaneRequest(
      "Thanks. Please close Drone React Preview Smoke 1774659110753, the browser window, and the localhost preview server so we can move on."
    ),
    false
  );
});

test("buildDeterministicFrameworkBuildFallbackActions synthesizes safe-slug scaffold/install/proof actions for named React folders on Windows", () => {
  const actions = buildDeterministicFrameworkBuildFallbackActions(
    "Handle this first step only: create a new React single page app in a folder called Drone React Preview Smoke 1774618922998 on my desktop. Use a real scaffold-capable toolchain step, then install dependencies so package.json and node_modules exist. For this turn, stop after the workspace is ready for edits.",
    buildWindowsExecutionEnvironment()
  );

  assert.equal(actions.length, 3);
  assert.equal(actions[0]?.type, "shell_command");
  assert.equal(actions[1]?.type, "shell_command");
  assert.equal(actions[2]?.type, "shell_command");
  assert.match(String(actions[0]?.params.command), /agentbigbrain-framework-scaffold/i);
  assert.match(String(actions[0]?.params.command), /create-vite@latest/i);
  assert.match(String(actions[0]?.params.command), /--template react-ts/i);
  assert.match(String(actions[0]?.params.command), /--no-interactive/i);
  assert.match(String(actions[0]?.params.command), /drone-react-preview-smoke-1774618922998/i);
  assert.match(String(actions[0]?.params.command), /Drone React Preview Smoke 1774618922998/i);
  assert.equal(
    actions[1]?.params.cwd,
    "C:\\Users\\testuser\\Desktop\\Drone React Preview Smoke 1774618922998"
  );
});

test("buildDeterministicFrameworkBuildFallbackActions keeps autonomous scaffold-only React turns on workspace-ready proof instead of live preview actions", () => {
  const wrappedAutonomousInput = `[AUTONOMOUS_LOOP_GOAL] ${JSON.stringify({
    goal: "Handle this first step only.",
    initialExecutionInput: [
      "You are in an ongoing conversation with the same user.",
      "Deterministic routing hint:",
      "Intent surface: build_scaffold. Prefer governed finite proof steps first (for example scaffold, edit, install, build, finite verification) with explicit approval-diff rendering before write actions. Only use managed process plus probe actions when the user clearly asks to run or verify a live app/session.",
      "",
      "Current user request:",
      "Handle this first step only: create a new React single page app in a folder called Drone React Preview Smoke 1774661430563 on my desktop. Use a real scaffold-capable toolchain step, then install dependencies so package.json and node_modules exist. For this turn, stop after the workspace is ready for edits. Do not start a preview server, do not verify localhost, and do not open a browser yet."
    ].join("\n")
  })}`;

  const actions = buildDeterministicFrameworkBuildFallbackActions(
    wrappedAutonomousInput,
    buildWindowsExecutionEnvironment()
  );

  assert.deepEqual(
    actions.map((action) => action.type),
    ["shell_command", "shell_command", "shell_command"]
  );
  assert.equal(actions.some((action) => action.type === "start_process"), false);
  assert.equal(actions.some((action) => action.type === "probe_http"), false);
  assert.equal(actions.some((action) => action.type === "open_browser"), false);
  assert.match(String(actions[2]?.params.command), /Workspace not ready/i);
});

test("buildDeterministicFrameworkBuildFallbackActions prefers the exact Desktop path over repair-turn prose when resolving React folder names", () => {
  const currentUserRequest = [
    "You are in an ongoing conversation with the same user.",
    "Current user request:",
    "Inspect `C:\\Users\\testuser\\Desktop\\Drone React Preview Smoke 1774663596997` and verify whether the exact folder itself, not a nested subfolder, is already a valid React single-page app scaffold created by a real scaffold-capable toolchain. Use finite file inspection only: check `package.json` plus expected scaffold files such as `index.html`, `src`, and React/Vite scripts. If the scaffold is valid, report success with concrete evidence and stop. If it is not valid, recreate the React app directly in that exact folder using a real scaffold toolchain, install dependencies so `package.json` and `node_modules` exist there, and stop once the workspace is ready for edits. Do not start a preview server, do not verify localhost, and do not open a browser."
  ].join("\n");

  const actions = buildDeterministicFrameworkBuildFallbackActions(
    currentUserRequest,
    buildWindowsExecutionEnvironment()
  );

  assert.equal(actions.length, 3);
  assert.match(
    String(actions[0]?.params.command),
    /Drone React Preview Smoke 1774663596997/i
  );
  assert.match(
    String(actions[0]?.params.command),
    /drone-react-preview-smoke-1774663596997/i
  );
  assert.doesNotMatch(
    String(actions[0]?.params.command),
    /exact folder itself|nested subfolder/i
  );
  assert.equal(
    actions[1]?.params.cwd,
    "C:\\Users\\testuser\\Desktop\\Drone React Preview Smoke 1774663596997"
  );
});

test("buildDeterministicFrameworkBuildFallbackActions prefers the tracked workspace basename for natural existing-workspace React follow-ups", () => {
  const currentUserRequest = [
    "Current tracked workspace in this chat:",
    "- Root path: C:\\Users\\testuser\\Desktop\\Drone React Preview Smoke 1774664217532",
    "",
    "Current user request:",
    "Reuse the existing Drone React Preview Smoke 1774664217532 workspace on my desktop. Turn it into a calm drone-themed landing page with one homepage hero and four additional sections. Write the real page implementation, then run the build so dist/index.html exists. For this turn, stop after the source edits and build proof exist. Do not start a preview server, do not verify localhost, and do not open a browser yet."
  ].join("\n");

  const actions = buildDeterministicFrameworkBuildFallbackActions(
    currentUserRequest,
    buildWindowsExecutionEnvironment()
  );

  assert.equal(actions.length >= 5, true);
  assert.match(
    String(actions[0]?.params.command),
    /Drone React Preview Smoke 1774664217532/i
  );
  assert.doesNotMatch(
    String(actions[0]?.params.command),
    /existing Drone React Preview Smoke 1774664217532/i
  );
  assert.equal(
    actions[1]?.params.path,
    "C:\\Users\\testuser\\Desktop\\Drone React Preview Smoke 1774664217532\\src\\App.jsx"
  );
});

test("buildDeterministicFrameworkBuildFallbackActions keeps non-live Next.js build turns on source-plus-build proof instead of workspace-only proof", () => {
  const currentUserRequest = [
    "Recent conversation context (oldest to newest):",
    "- user: Can you get a new Next.js landing-page workspace started on my desktop and call it Downtown Detroit Drones? Just get the workspace ready for edits with the dependencies installed. Do not run it or open anything yet.",
    "- assistant: I ran the command successfully.",
    "",
    "Current tracked workspace in this chat:",
    "- Root path: C:\\Users\\testuser\\Desktop\\Downtown Detroit Drones",
    "",
    "Current user request:",
    "Great. Now turn that Downtown Detroit Drones workspace into the real landing page. Keep it calm and modern, avoid blue, put a small flying drone in the hero, use four main sections, add a clear call to action and a footer menu, then build it. Stop once the source and build proof are there, but do not run it or open anything yet."
  ].join("\n");
  const actions = buildDeterministicFrameworkBuildFallbackActions(
    currentUserRequest,
    buildWindowsExecutionEnvironment()
  );

  assert.equal(actions[0]?.type, "shell_command");
  assert.equal(actions[1]?.type, "write_file");
  assert.equal(actions[2]?.type, "write_file");
  assert.equal(actions[3]?.type, "write_file");
  assert.equal(actions[4]?.type, "shell_command");
  assert.equal(actions[5]?.type, "shell_command");
  assert.equal(actions[6]?.type, "shell_command");
  assert.match(String(actions[5]?.params.command), /\bnpm run build\b/i);
  assert.match(String(actions[6]?.params.command), /\.next\\BUILD_ID/i);
  assert.doesNotMatch(String(actions[6]?.params.command), /Workspace not ready/i);
  assert.equal(actions.some((action) => action.type === "start_process"), false);
  assert.equal(actions.some((action) => action.type === "open_browser"), false);
});

test("buildDeterministicFrameworkBuildFallbackActions reuses an already-built tracked Next.js workspace for preview start follow-ups", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "planner-policy-next-preview-followup-"));
  const projectPath = path.join(tempRoot, "Downtown Detroit Drones");
  try {
    mkdirSync(path.join(projectPath, "app"), { recursive: true });
    mkdirSync(path.join(projectPath, ".next"), { recursive: true });
    mkdirSync(path.join(projectPath, "node_modules"), { recursive: true });
    writeFileSync(path.join(projectPath, "package.json"), "{\n  \"name\": \"downtown-detroit-drones\"\n}\n", "utf8");
    writeFileSync(path.join(projectPath, "next-env.d.ts"), "/// <reference types=\"next\" />\n", "utf8");
    writeFileSync(path.join(projectPath, ".next", "BUILD_ID"), "smoke-build\n", "utf8");

    const currentUserRequest = [
      "Current tracked workspace in this chat:",
      `- Root path: ${projectPath}`,
      "",
      "Current user request:",
      "Nice. Pull up the Downtown Detroit Drones landing page you just built so it is ready to view, but do not pop the browser open yet. Use a real localhost run on host 127.0.0.1 and port 54928, and keep that preview server running."
    ].join("\n");

    const actions = buildDeterministicFrameworkBuildFallbackActions(
      currentUserRequest,
      {
        ...buildWindowsExecutionEnvironment(),
        desktopPath: tempRoot
      }
    );

    assert.deepEqual(
      actions.map((action) => action.type),
      ["start_process", "probe_http"]
    );
    assert.match(String(actions[0]?.params.command), /--hostname 127\.0\.0\.1 --port 54928/i);
    assert.equal(actions[1]?.params.url, "http://127.0.0.1:54928");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("buildDeterministicFrameworkBuildFallbackActions reuses an already-built tracked Next.js workspace for browser-open follow-ups", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "planner-policy-next-open-followup-"));
  const projectPath = path.join(tempRoot, "Downtown Detroit Drones");
  const previewProcessLeaseId = "proc_preview_downtown";
  try {
    mkdirSync(path.join(projectPath, "app"), { recursive: true });
    mkdirSync(path.join(projectPath, ".next"), { recursive: true });
    mkdirSync(path.join(projectPath, "node_modules"), { recursive: true });
    writeFileSync(path.join(projectPath, "package.json"), "{\n  \"name\": \"downtown-detroit-drones\"\n}\n", "utf8");
    writeFileSync(path.join(projectPath, "next-env.d.ts"), "/// <reference types=\"next\" />\n", "utf8");
    writeFileSync(path.join(projectPath, ".next", "BUILD_ID"), "smoke-build\n", "utf8");

    const currentUserRequest = [
      "Current tracked workspace in this chat:",
      `- Root path: ${projectPath}`,
      "- Preview URL: http://127.0.0.1:54928",
      `- Preview process lease: ${previewProcessLeaseId}`,
      "",
      "Current user request:",
      "Alright, open that Downtown Detroit Drones landing page in my browser and leave it up for me. Use the same tracked localhost run that is already live on port 54928."
    ].join("\n");

    const actions = buildDeterministicFrameworkBuildFallbackActions(
      currentUserRequest,
      {
        ...buildWindowsExecutionEnvironment(),
        desktopPath: tempRoot
      }
    );

    assert.deepEqual(
      actions.map((action) => action.type),
      ["probe_http", "open_browser"]
    );
    assert.equal(actions[0]?.params.url, "http://127.0.0.1:54928/");
    assert.equal(actions[1]?.params.url, "http://127.0.0.1:54928/");
    assert.equal(actions[1]?.params.rootPath, projectPath);
    assert.equal(actions[1]?.params.previewProcessLeaseId, previewProcessLeaseId);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("buildDeterministicFrameworkBuildFallbackActions synthesizes tracked Next.js live-edit actions while the preview stays open", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "planner-policy-next-edit-followup-"));
  const projectPath = path.join(tempRoot, "Downtown Detroit Drones");
  const previewProcessLeaseId = "proc_preview_downtown";
  const browserSessionId = "browser_session:downtown";
  try {
    mkdirSync(path.join(projectPath, "app"), { recursive: true });
    mkdirSync(path.join(projectPath, ".next"), { recursive: true });
    mkdirSync(path.join(projectPath, "node_modules"), { recursive: true });
    writeFileSync(path.join(projectPath, "package.json"), "{\n  \"name\": \"downtown-detroit-drones\"\n}\n", "utf8");
    writeFileSync(path.join(projectPath, "next-env.d.ts"), "/// <reference types=\"next\" />\n", "utf8");
    writeFileSync(path.join(projectPath, ".next", "BUILD_ID"), "smoke-build\n", "utf8");
    writeFileSync(
      path.join(projectPath, "app", "page.js"),
      [
        "const sections = [",
        "  { title: 'Guided setup', text: 'A calm structure that explains the product without rushing the reader.' },",
        "  { title: 'Quiet confidence', text: 'Soft visual rhythm, clear copy, and a hero that feels stable instead of noisy.' },",
        "  { title: 'Flight planning', text: 'A simple feature story that makes the path from interest to action feel obvious.' }",
        "];",
        "",
        "export default function Home() {",
        "  return <main>{sections.map((section) => <section key={section.title}><h3>{section.title}</h3><p>{section.text}</p></section>)}</main>;",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const currentUserRequest = [
      "Current tracked workspace in this chat:",
      `- Root path: ${projectPath}`,
      "- Preview URL: http://127.0.0.1:54928",
      `- Browser session id: ${browserSessionId}`,
      `- Preview process lease: ${previewProcessLeaseId}`,
      "",
      "Current user request:",
      'One tweak while it stays open: change the second section heading to "Steady local rollout" and make that section mention "Built for neighborhood teams." Keep the page running and refresh whatever needs to refresh so the live page shows the update.'
    ].join("\n");

    const actions = buildDeterministicFrameworkBuildFallbackActions(
      currentUserRequest,
      {
        ...buildWindowsExecutionEnvironment(),
        desktopPath: tempRoot
      }
    );

    assert.deepEqual(
      actions.map((action) => action.type),
      ["write_file", "probe_http", "open_browser"]
    );
    assert.match(String(actions[0]?.params.content), /Steady local rollout/);
    assert.match(String(actions[0]?.params.content), /Built for neighborhood teams/);
    assert.equal(actions[1]?.params.url, "http://127.0.0.1:54928/");
    assert.equal(actions[2]?.params.url, "http://127.0.0.1:54928/");
    assert.equal(actions[2]?.params.rootPath, projectPath);
    assert.equal("previewProcessLeaseId" in (actions[2]?.params ?? {}), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("buildDeterministicFrameworkBuildFallbackActions synthesizes a full live Next.js landing-page lifecycle for timeout recovery", () => {
  const currentUserRequest =
    "Please create a Next.js landing page called Drone City on my Desktop. It should have a flying drone in the hero, feel polished and modern, and work as a single-page landing page. After you finish, start it locally, open it in my browser, and leave it up for me to view.";
  const actions = buildDeterministicFrameworkBuildFallbackActions(
    currentUserRequest,
    buildWindowsExecutionEnvironment()
  );

  assert.ok(actions.length >= 8);
  assert.equal(actions[0]?.type, "shell_command");
  assert.match(String(actions[0]?.params.command), /create-next-app@latest/i);
  assert.match(String(actions[0]?.params.command), /--app\b/i);
  assert.match(String(actions[0]?.params.command), /--skip-install\b/i);
  assert.match(String(actions[0]?.params.command), /--no-tailwind\b/i);
  assert.match(String(actions[0]?.params.command), /--no-src-dir\b/i);
  assert.match(String(actions[0]?.params.command), /--disable-git\b/i);
  assert.match(String(actions[0]?.params.command), /--no-react-compiler\b/i);
  assert.equal(actions[1]?.type, "write_file");
  assert.equal(actions[2]?.type, "write_file");
  assert.equal(actions[3]?.type, "write_file");
  assert.equal(actions[4]?.type, "shell_command");
  assert.equal(actions[5]?.type, "shell_command");
  assert.equal(actions[6]?.type, "shell_command");
  assert.equal(actions[7]?.type, "start_process");
  assert.match(String(actions[7]?.params.command), /npm run dev -- --hostname 127\.0\.0\.1 --port 3000/i);
  assert.equal(actions[8]?.type, "probe_http");
  assert.equal(actions[8]?.params.url, "http://127.0.0.1:3000");
  assert.equal(actions[9]?.type, "open_browser");
  assert.equal(actions[9]?.params.url, "http://127.0.0.1:3000");
  assert.equal(actions[9]?.params.rootPath, "C:\\Users\\testuser\\Desktop\\Drone City");
  assert.match(String(actions[2]?.params.content), /flying drone hero/i);
});

test("framework landing-page fallback content stays generic when the request is not drone-specific", () => {
  const currentUserRequest =
    "Please create a polished modern landing page called Big Beans on my Desktop and leave it open for review when finished.";
  const pageContent = buildFrameworkLandingPageContent(
    "next_js",
    "Big Beans",
    currentUserRequest
  );
  const styleContent = buildFrameworkLandingPageStyles(currentUserRequest);

  assert.doesNotMatch(pageContent, /\bflying drone hero\b/i);
  assert.doesNotMatch(pageContent, /\bdrone-stage\b/i);
  assert.match(pageContent, /Featured flow/);
  assert.match(pageContent, /polished first impression/i);
  assert.match(styleContent, /\.hero-orb-stage/);
  assert.doesNotMatch(styleContent, /\.drone-stage/);
});

test("Next.js fallback layouts import globals.css so generated landing pages do not render unstyled", () => {
  const javaScriptLayout = buildNextLayoutContent("Drone City");
  const typeScriptLayout = buildNextTypeScriptLayoutContent("Drone City");

  assert.match(javaScriptLayout, /import "\.\/globals\.css";/);
  assert.match(typeScriptLayout, /import "\.\/globals\.css";/);
});

test("buildDeterministicFrameworkBuildFallbackActions rewrites existing Next.js tsx route files instead of shadow js files", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "planner-policy-next-fallback-"));
  const projectPath = path.join(tempRoot, "Drone City");
  const appPath = path.join(projectPath, "app");
  try {
    mkdirSync(appPath, { recursive: true });
    writeFileSync(path.join(projectPath, "package.json"), "{\n  \"name\": \"drone-city\"\n}\n", "utf8");
    writeFileSync(path.join(projectPath, "tsconfig.json"), "{\n  \"compilerOptions\": {}\n}\n", "utf8");
    writeFileSync(path.join(projectPath, "next-env.d.ts"), "/// <reference types=\"next\" />\n", "utf8");
    writeFileSync(path.join(appPath, "layout.tsx"), "export default function Layout({ children }: any) { return children; }\n", "utf8");
    writeFileSync(path.join(appPath, "page.tsx"), "export default function Page() { return null; }\n", "utf8");
    writeFileSync(path.join(appPath, "layout.js"), "export default function Layout({ children }) { return children; }\n", "utf8");
    writeFileSync(path.join(appPath, "page.js"), "export default function Page() { return null; }\n", "utf8");

    const actions = buildDeterministicFrameworkBuildFallbackActions(
      "Please create a Next.js landing page called Drone City on my Desktop. It should have a flying drone in the hero, feel polished and modern, and work as a single-page landing page. After you finish, start it locally, open it in my browser, and leave it up for me to view.",
      {
        ...buildWindowsExecutionEnvironment(),
        desktopPath: tempRoot
      }
    );

    const writePaths = actions
      .filter((action) => action.type === "write_file")
      .map((action) => String((action.params as Record<string, unknown>).path));
    assert.ok(writePaths.includes(path.join(projectPath, "app", "layout.tsx")));
    assert.ok(writePaths.includes(path.join(projectPath, "app", "page.tsx")));
    assert.ok(writePaths.includes(path.join(projectPath, "app", "layout.js")));
    assert.ok(writePaths.includes(path.join(projectPath, "app", "page.js")));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("preparePlannerActions rewrites Next.js src/app writes into the active root app tree", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "planner-policy-next-route-root-"));
  const projectPath = path.join(tempRoot, "Drone City");
  const rootAppPath = path.join(projectPath, "app");
  const srcAppPath = path.join(projectPath, "src", "app");
  try {
    mkdirSync(rootAppPath, { recursive: true });
    mkdirSync(srcAppPath, { recursive: true });
    writeFileSync(path.join(projectPath, "package.json"), "{\n  \"name\": \"drone-city\"\n}\n", "utf8");
    writeFileSync(path.join(projectPath, "next-env.d.ts"), "/// <reference types=\"next\" />\n", "utf8");
    writeFileSync(path.join(rootAppPath, "layout.tsx"), "export default function Layout({ children }: any) { return children; }\n", "utf8");
    writeFileSync(path.join(rootAppPath, "page.tsx"), "export default function Page() { return null; }\n", "utf8");

    const preparation = preparePlannerActions(
      {
        plannerNotes: "write the generated Next.js route files",
        actions: [
          {
            type: "write_file",
            description: "write the page",
            params: {
              path: path.join(projectPath, "src", "app", "page.tsx"),
              content: "export default function Page() { return <main className=\"pageShell\">Drone City</main>; }\n"
            }
          },
          {
            type: "write_file",
            description: "write the layout",
            params: {
              path: path.join(projectPath, "src", "app", "layout.tsx"),
              content: "export default function Layout({ children }: any) { return children; }\n"
            }
          },
          {
            type: "write_file",
            description: "write the stylesheet",
            params: {
              path: path.join(projectPath, "src", "app", "globals.css"),
              content: ".pageShell { color: red; }\n"
            }
          }
        ]
      },
      "Please create a Next.js landing page called Drone City on my Desktop. It should have a flying drone in the hero, feel polished and modern, and work as a single-page landing page. After you finish, start it locally, open it in my browser, and leave it up for me to view.",
      null,
      undefined,
      {
        ...buildWindowsExecutionEnvironment(),
        desktopPath: tempRoot
      }
    );

    const writePaths = preparation.actions
      .filter((action) => action.type === "write_file")
      .map((action) => String(action.params.path));
    assert.deepEqual(writePaths, [
      path.join(projectPath, "app", "page.tsx"),
      path.join(projectPath, "app", "layout.tsx"),
      path.join(projectPath, "app", "globals.css")
    ]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inferRequiredActionType recognizes later-in-sentence inspect tool requests", () => {
  assert.equal(
    inferRequiredActionType(
      "Continue workspace recovery before retrying moves. Use inspect_path_holders on C:\\Users\\testuser\\Desktop\\drone-company-a now."
    ),
    "inspect_path_holders"
  );
});
