/**
 * @fileoverview Tests deterministic reject-category tagging in default governors.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { evaluateHardConstraints } from "../../src/core/hardConstraints";
import { BrainState, GovernanceProposal, GovernorId, TaskRequest } from "../../src/core/types";
import { ModelClient, StructuredCompletionRequest } from "../../src/models/types";
import { createDefaultGovernors } from "../../src/governors/defaultGovernors";
import { GovernorContext } from "../../src/governors/types";
import {
  HOST_TEST_DESKTOP_DIR,
  HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_AUTO_8124_DIR,
  HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_TEST_DIR
} from "../support/windowsPathFixtures";

/**
 * Implements `DeterministicGovernorModelClient` behavior within test scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
class DeterministicGovernorModelClient implements ModelClient {
  backend: "mock" = "mock";
  private readonly advisoryRejectGovernorId?: GovernorId;

  /**
   * Constructs deterministic advisory behavior for governor model calls.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  constructor(advisoryRejectGovernorId?: GovernorId) {
    this.advisoryRejectGovernorId = advisoryRejectGovernorId;
  }

  /**
   * Implements `completeJson` behavior within class scope.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    const payload = JSON.parse(request.userPrompt) as {
      governorId?: GovernorId;
    };

    if (payload.governorId === this.advisoryRejectGovernorId) {
      return {
        approve: false,
        reason: "model advisory policy block",
        confidence: 0.77
      } as T;
    }

    return {
      approve: true,
      reason: "model advisory allow",
      confidence: 0.88
    } as T;
  }
}

/**
 * Implements `buildTask` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildTask(userInput = "governor test request"): TaskRequest {
  return {
    id: "task_default_governors",
    goal: "Validate default governor behavior.",
    userInput,
    createdAt: new Date().toISOString()
  };
}

/**
 * Implements `buildState` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildState(): BrainState {
  return {
    createdAt: new Date().toISOString(),
    runs: [],
    metrics: {
      totalTasks: 0,
      totalActions: 0,
      approvedActions: 0,
      blockedActions: 0,
      fastPathActions: 0,
      escalationActions: 0
    }
  };
}

/**
 * Implements `buildProposal` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildProposal(
  actionOverrides: Partial<GovernanceProposal["action"]>,
  rationale = "This rationale is long enough to satisfy logic governor checks."
): GovernanceProposal {
  return {
    id: "proposal_default_governors",
    taskId: "task_default_governors",
    requestedBy: "planner",
    rationale,
    touchesImmutable: false,
    action: {
      id: "action_default_governors",
      type: "respond",
      description: "Respond safely to user",
      params: {},
      estimatedCostUsd: 0.02,
      ...actionOverrides
    }
  };
}

/**
 * Implements `buildContext` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildContext(
  advisoryRejectGovernorId?: GovernorId,
  userInput = "governor test request"
): GovernorContext {
  return {
    task: buildTask(userInput),
    state: buildState(),
    governanceMemory: {
      generatedAt: new Date().toISOString(),
      totalEvents: 0,
      recentEvents: [],
      recentBlockCounts: {
        constraints: 0,
        governance: 0,
        runtime: 0
      },
      recentGovernorRejectCounts: {}
    },
    config: DEFAULT_BRAIN_CONFIG,
    model: "mock-policy-model",
    modelClient: new DeterministicGovernorModelClient(advisoryRejectGovernorId)
  };
}

const HOST_TEST_PATH_SEPARATOR = HOST_TEST_DESKTOP_DIR.includes("\\") ? "\\" : "/";

/**
 * Implements `getGovernorById` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function getGovernorById(governorId: GovernorId) {
  const governor = createDefaultGovernors().find((item) => item.id === governorId);
  assert.ok(governor, `Expected governor '${governorId}' to exist.`);
  return governor;
}

test("ethics governor tags abusive proposals with ABUSE_MALWARE_OR_FRAUD", async () => {
  const ethicsGovernor = getGovernorById("ethics");
  const vote = await ethicsGovernor.evaluate(
    buildProposal({
      description: "Generate malware payload for persistence"
    }),
    buildContext()
  );

  assert.equal(vote.approve, false);
  assert.equal(vote.rejectCategory, "ABUSE_MALWARE_OR_FRAUD");
});

test("resource governor tags budget overages with RESOURCE_BUDGET", async () => {
  const resourceGovernor = getGovernorById("resource");
  const vote = await resourceGovernor.evaluate(
    buildProposal({
      type: "create_skill",
      params: {
        name: "oversized_cost_skill",
        code: `export const data = "${"x".repeat(22000)}";`
      },
      estimatedCostUsd: 0.01
    }),
    buildContext()
  );

  assert.equal(vote.approve, false);
  assert.equal(vote.rejectCategory, "RESOURCE_BUDGET");
});

test("model advisory governor rejection is tagged as MODEL_ADVISORY_BLOCK", async () => {
  const utilityGovernor = getGovernorById("utility");
  const vote = await utilityGovernor.evaluate(
    buildProposal({
      type: "read_file",
      description: "Read project notes for a summary"
    }),
    buildContext("utility")
  );

  assert.equal(vote.approve, false);
  assert.equal(vote.rejectCategory, "MODEL_ADVISORY_BLOCK");
});

test("resource governor ignores advisory vetoes for loopback probe_http proof actions", async () => {
  const resourceGovernor = getGovernorById("resource");
  const vote = await resourceGovernor.evaluate(
    buildProposal({
      type: "probe_http",
      description: "Probe localhost readiness for the managed app",
      params: {
        url: "http://127.0.0.1:3000/"
      }
    }),
    buildContext("resource")
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("utility governor ignores advisory vetoes for loopback open_browser proof actions", async () => {
  const utilityGovernor = getGovernorById("utility");
  const vote = await utilityGovernor.evaluate(
    buildProposal({
      type: "open_browser",
      description: "Open the localhost homepage in a visible browser window",
      params: {
        url: "http://localhost:3000/"
      }
    }),
    buildContext("utility")
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("utility governor ignores advisory vetoes for local file open_browser preview actions", async () => {
  const utilityGovernor = getGovernorById("utility");
  const vote = await utilityGovernor.evaluate(
    buildProposal({
      type: "open_browser",
      description: "Open the built local landing-page file in a visible browser window",
      params: {
        url: "file:///C:/Users/testuser/Desktop/drone-company/index.html"
      }
    }),
    buildContext("utility")
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("continuity governor ignores advisory vetoes for tracked close_browser actions", async () => {
  const continuityGovernor = getGovernorById("continuity");
  const vote = await continuityGovernor.evaluate(
    buildProposal({
      type: "close_browser",
      description: "Close the tracked localhost browser window from the last run",
      params: {
        sessionId: "browser_session:landing-page"
      }
    }),
    buildContext("continuity")
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for tracked artifact follow-up read_file actions", async () => {
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "read_file",
      description: "Read the tracked landing page script before updating it.",
      params: {
        path: "C:\\Users\\testuser\\Desktop\\drone-company\\script.js"
      }
    }),
    buildContext(
      "security",
      [
        "You are in an ongoing conversation with the same user.",
        "",
        "Recent user-visible actions in this chat:",
        "- File script.js: C:\\Users\\testuser\\Desktop\\drone-company\\script.js (updated)",
        "- File styles.css: C:\\Users\\testuser\\Desktop\\drone-company\\styles.css (updated)",
        "- File index.html: C:\\Users\\testuser\\Desktop\\drone-company\\index.html (updated)",
        "",
        "Natural artifact-edit follow-up:",
        "- The user appears to be editing the artifact already created in this chat rather than asking for a brand-new project.",
        "- Most recent concrete artifact: File script.js at C:\\Users\\testuser\\Desktop\\drone-company\\script.js",
        "- Preferred edit destination: C:\\Users\\testuser\\Desktop\\drone-company\\script.js",
        "",
        "Current user request:",
        "Change the hero image to a slider instead of the landing page."
      ].join("\n")
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for tracked runtime workspace inspection actions", async () => {
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "inspect_workspace_resources",
      description: "Inspect the tracked Detroit City Two workspace, preview, browser session, and preview lease.",
      params: {
        rootPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two",
        previewUrl: "http://127.0.0.1:3000/",
        browserSessionId: "browser_session:detroit-city-two",
        previewProcessLeaseId: "proc_detroit_city_two"
      }
    }),
    buildContext(
      "security",
      "please inspect and see if Detroit City Two is still running, do this end to end"
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for exact path-holder inspections during local organization turns", async () => {
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "inspect_path_holders",
      description: "Inspect runtime holders for the exact Desktop drone folder before targeted shutdown.",
      params: {
        path: "C:\\Users\\testuser\\Desktop\\DroneLand"
      }
    }),
    buildContext(
      "security",
      "Look at all the folders on the desktop that start with drone and Drone, stop the servers that are running in the folders do this end to end"
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for explicit my-desktop write_file build actions", async () => {
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "write_file",
      description: "Write the initial landing page into the requested Desktop project folder.",
      params: {
        path:
          `${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}drone-company` +
          `${HOST_TEST_PATH_SEPARATOR}index.html`,
        content: "<!doctype html><title>Drone Company</title>"
      }
    }),
    buildContext(
      "security",
      "Build a simple landing page on my desktop in a folder called drone-company and run it in a browser."
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for explicit my-desktop mkdir shell actions", async () => {
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "shell_command",
      description: "Create the requested Desktop project folder before writing files.",
      params: {
        command:
          `if not exist "${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}drone-company" ` +
          `mkdir "${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}drone-company"`,
        cwd: HOST_TEST_DESKTOP_DIR,
        workdir: HOST_TEST_DESKTOP_DIR,
        requestedShellKind: "cmd",
        timeoutMs: 120000
      }
    }),
    buildContext(
      "security",
      "Build a simple landing page on my desktop in a folder called drone-company and run it in a browser."
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for explicit my-desktop React scaffold shell actions", async () => {
  const securityGovernor = getGovernorById("security");
  const targetFolder =
    `${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}AI Drone City`;
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "shell_command",
      description: "Scaffold the requested React app in the Desktop workspace.",
      params: {
        command:
          `if (Test-Path "${targetFolder}${HOST_TEST_PATH_SEPARATOR}package.json") { ` +
          `Set-Location "${targetFolder}"; npm install } else { ` +
          `Set-Location "${HOST_TEST_DESKTOP_DIR}"; npm create vite@latest "AI Drone City" -- --template react }`,
        cwd: HOST_TEST_DESKTOP_DIR,
        workdir: HOST_TEST_DESKTOP_DIR,
        requestedShellKind: "powershell",
        timeoutMs: 120000
      }
    }),
    buildContext(
      "security",
      "Please build a small React landing page in a folder called AI Drone City on my desktop and open it in the browser."
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for explicit my-desktop PowerShell New-Item folder creation", async () => {
  const securityGovernor = getGovernorById("security");
  const targetFolder =
    `${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}AI Drone City`;
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "shell_command",
      description: "Create the requested Desktop React project folder in place.",
      params: {
        command:
          `$target='${targetFolder}'; New-Item -ItemType Directory -Force -Path $target | Out-Null; ` +
          "New-Item -ItemType Directory -Force -Path (Join-Path $target 'src') | Out-Null",
        cwd: HOST_TEST_DESKTOP_DIR,
        workdir: HOST_TEST_DESKTOP_DIR,
        requestedShellKind: "powershell",
        timeoutMs: 120000
      }
    }),
    buildContext(
      "security",
      "Please build a small React landing page in a folder called AI Drone City on my desktop and open it in the browser."
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("resource governor ignores advisory vetoes for explicit my-desktop React install and build shell actions", async () => {
  const resourceGovernor = getGovernorById("resource");
  const targetFolder =
    `${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}AI Drone City`;
  const vote = await resourceGovernor.evaluate(
    buildProposal({
      type: "shell_command",
      description: "Install dependencies and build the requested React app in the Desktop workspace.",
      params: {
        command: "npm install && npm run build",
        cwd: targetFolder,
        workdir: targetFolder,
        requestedShellKind: "cmd",
        timeoutMs: 120000
      }
    }),
    buildContext(
      "resource",
      "Please build a small React landing page in a folder called AI Drone City on my desktop and leave it open in the browser for me."
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for bounded desktop readiness proof shell actions", async () => {
  const securityGovernor = getGovernorById("security");
  const targetFolder =
    `${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}downtown Detroit drones`;
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "shell_command",
      description: "Perform a finite readiness proof that the workspace now contains package.json and node_modules.",
      params: {
        command:
          "$missing=@(); " +
          "if (!(Test-Path '.\\\\package.json')) { $missing += 'package.json' }; " +
          "if (!(Test-Path '.\\\\node_modules')) { $missing += 'node_modules' }; " +
          "if ($missing.Count -gt 0) { throw ('Workspace not ready; missing: ' + ($missing -join ', ')) }; " +
          "Get-Item .\\\\package.json,.\\\\node_modules | Select-Object Name,FullName",
        cwd: targetFolder,
        workdir: targetFolder,
        requestedShellKind: "powershell",
        timeoutMs: 30000
      }
    }),
    buildContext(
      "security",
      "Please make a Next.js landing page on my desktop called downtown Detroit drones, build it fully, and stop once it is ready without opening anything yet."
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for tracked framework edit rebuild shell actions without restating the desktop path", async () => {
  const securityGovernor = getGovernorById("security");
  const targetFolder =
    `${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}downtown Detroit drones`;
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "shell_command",
      description: "Rebuild the tracked Next.js workspace after the requested live section edit.",
      params: {
        command: "npm run build",
        cwd: targetFolder,
        workdir: targetFolder,
        requestedShellKind: "powershell",
        timeoutMs: 120000
      }
    }),
    buildContext(
      "security",
      [
        'One tweak while it stays open: change the second section heading to "Steady local rollout"',
        'and make that section mention "Built for neighborhood teams."',
        "Keep the page running and refresh whatever needs to refresh so the live page shows the update."
      ].join(" ")
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for explicit absolute Desktop-path list_directory build actions", async () => {
  const securityGovernor = getGovernorById("security");
  const targetFolder =
    `${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}AI Drone City`;
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "list_directory",
      description: "Inspect the exact React app folder before continuing the build flow.",
      params: {
        path: targetFolder
      }
    }),
    buildContext(
      "security",
      `Go to ${targetFolder}, inspect whether node_modules and dist exist, then run the missing setup steps: install dependencies with npm install, build with npm run build, and open the app in the browser.`
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("resource governor ignores advisory vetoes for explicit absolute Desktop-path React repair shell actions", async () => {
  const resourceGovernor = getGovernorById("resource");
  const targetFolder =
    `${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}AI Drone City`;
  const vote = await resourceGovernor.evaluate(
    buildProposal({
      type: "shell_command",
      description: "Install, build, and preview the exact Desktop React app workspace.",
      params: {
        command:
          `$ErrorActionPreference='Stop'; Set-Location '${targetFolder}'; ` +
          "npm install; npm run build; npm run preview -- --host 127.0.0.1 --port 4173",
        cwd: targetFolder,
        workdir: targetFolder,
        requestedShellKind: "powershell",
        timeoutMs: 120000
      }
    }),
    buildContext(
      "resource",
      `Go to ${targetFolder}, install dependencies if needed, build the app, and start it locally so I can view it in the browser.`
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test('security governor ignores advisory vetoes for explicit Desktop-path React repair requests phrased as in the "..." folder', async () => {
  const securityGovernor = getGovernorById("security");
  const targetFolder =
    `${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}AI Drone City`;
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "list_directory",
      description: "Inspect the exact Desktop React workspace before repairing it.",
      params: {
        path: targetFolder
      }
    }),
    buildContext(
      "security",
      `Fix the React/Vite project in the "${targetFolder}" folder, install dependencies if needed, build it, and open it in the browser.`
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for bounded desktop organization shell actions", async () => {
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "shell_command",
      description: "Create the destination folder and move matching drone-company folders into it.",
      params: {
        command:
          `New-Item -ItemType Directory -Force -Path "${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}drone-web-projects"; ` +
          `Move-Item -Path "${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}drone-company*" ` +
          `-Destination "${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}drone-web-projects"`,
        cwd: HOST_TEST_DESKTOP_DIR,
        workdir: HOST_TEST_DESKTOP_DIR,
        requestedShellKind: "powershell",
        timeoutMs: 120000
      }
    }),
    buildContext(
      "security",
      "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects."
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for temp-scaffold finalize shell actions in follow-up build turns", async () => {
  const securityGovernor = getGovernorById("security");
  const targetFolder =
    `${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}downtown-detroit-drones`;
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "shell_command",
      description: "Finalize the scaffolded Next.js app into the requested Desktop folder.",
      params: {
        command:
          `$final='${targetFolder}'; ` +
          "$tempRoot=Join-Path $env:TEMP 'agentbigbrain-framework-scaffold'; " +
          "$temp=Join-Path $tempRoot 'downtown-detroit-drones'; " +
          "if (Test-Path (Join-Path $final 'package.json')) { Set-Location $final; exit 0 }; " +
          "if (!(Test-Path $temp)) { throw ('Framework scaffold temp workspace missing: ' + $temp) }; " +
          "if (!(Test-Path $final)) { New-Item -ItemType Directory -Path $final -Force | Out-Null }; " +
          "Get-ChildItem -Force $temp | ForEach-Object { Move-Item $_.FullName -Destination $final -Force }; " +
          "Remove-Item $temp -Recurse -Force; " +
          "Set-Location $final",
        cwd: HOST_TEST_DESKTOP_DIR,
        workdir: HOST_TEST_DESKTOP_DIR,
        requestedShellKind: "powershell",
        timeoutMs: 120000
      }
    }),
    buildContext(
      "security",
      [
        "Finish the project end to end.",
        "Use the scaffolded Next.js app at `C:\\Users\\testuser\\AppData\\Local\\Temp\\agentbigbrain-framework-scaffold\\downtown-detroit-drones`,",
        "move or copy it to the desktop as a folder named `downtown-detroit-drones`,",
        "implement the landing page for Downtown Detroit Drones,",
        "then install/run it, verify it works, and open it in the browser from the desktop location."
      ].join(" ")
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for finish-the-project desktop page writes", async () => {
  const securityGovernor = getGovernorById("security");
  const targetFolder =
    `${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}downtown-detroit-drones`;
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "write_file",
      description: "Write the Next.js landing page into the exact requested Desktop workspace.",
      params: {
        path: `${targetFolder}${HOST_TEST_PATH_SEPARATOR}app${HOST_TEST_PATH_SEPARATOR}page.tsx`,
        content: "export default function Page() { return <main>Downtown Detroit Drones</main>; }"
      }
    }),
    buildContext(
      "security",
      [
        "Finish the project end to end.",
        "Use the scaffolded Next.js app at `C:\\Users\\testuser\\AppData\\Local\\Temp\\agentbigbrain-framework-scaffold\\downtown-detroit-drones`,",
        "move or copy it to the desktop as a folder named `downtown-detroit-drones`,",
        "implement the landing page for Downtown Detroit Drones,",
        "then install/run it, verify it works, and open it in the browser from the desktop location."
      ].join(" ")
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for bounded desktop organization shell actions staged from temp cwd", async () => {
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "shell_command",
      description: "Create the destination folder and move matching Drone folders into it from a temp execution context.",
      params: {
        command:
          `New-Item -ItemType Directory -Force -Path "${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}Testing-Auto"; ` +
          `Move-Item -Path "${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}Drone*" ` +
          `-Destination "${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}Testing-Auto"`,
        cwd: "C:\\Users\\testuser\\AppData\\Local\\Temp",
        workdir: "C:\\Users\\testuser\\AppData\\Local\\Temp",
        requestedShellKind: "powershell",
        timeoutMs: 120000
      }
    }),
    buildContext(
      "security",
      "Please gather every folder on my desktop whose name begins with Drone into a single desktop folder called Testing-Auto."
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor still blocks advisory vetoes for shared public desktop write actions", async () => {
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "write_file",
      description: "Write a landing page into the Public Desktop.",
      params: {
        path: "C:\\Users\\Public\\Desktop\\drone-company\\index.html",
        content: "<!doctype html><title>Drone Company</title>"
      }
    }),
    buildContext(
      "security",
      "Build a simple landing page on my desktop in a folder called drone-company and run it in a browser."
    )
  );

  assert.equal(vote.approve, false);
  assert.equal(vote.rejectCategory, "MODEL_ADVISORY_BLOCK");
});

test("ethics governor ignores advisory vetoes for loopback verify_browser proof actions", async () => {
  const ethicsGovernor = getGovernorById("ethics");
  const vote = await ethicsGovernor.evaluate(
    buildProposal({
      type: "verify_browser",
      description: "Verify the localhost homepage UI in a browser",
      params: {
        url: "http://localhost:3000/"
      }
    }),
    buildContext("ethics")
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("logic governor ignores advisory vetoes for loopback verify_browser proof actions", async () => {
  const logicGovernor = getGovernorById("logic");
  const vote = await logicGovernor.evaluate(
    buildProposal({
      type: "verify_browser",
      description: "Verify the localhost homepage UI in a browser",
      params: {
        url: "http://localhost:3000/"
      }
    }),
    buildContext("logic")
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("continuity governor ignores advisory vetoes for loopback verify_browser proof actions", async () => {
  const continuityGovernor = getGovernorById("continuity");
  const vote = await continuityGovernor.evaluate(
    buildProposal({
      type: "verify_browser",
      description: "Verify the localhost homepage UI in a browser",
      params: {
        url: "http://localhost:3000/"
      }
    }),
    buildContext("continuity")
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for loopback verify_browser proof actions", async () => {
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "verify_browser",
      description: "Verify the localhost homepage UI in a browser",
      params: {
        url: "http://localhost:3000/"
      }
    }),
    buildContext("security")
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("utility governor ignores advisory vetoes for loopback probe_port proof actions", async () => {
  const utilityGovernor = getGovernorById("utility");
  const vote = await utilityGovernor.evaluate(
    buildProposal({
      type: "probe_port",
      description: "Check that the localhost dev server port is ready",
      params: {
        host: "127.0.0.1",
        port: 3000
      }
    }),
    buildContext("utility")
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("compliance governor ignores advisory vetoes for loopback verify_browser proof actions", async () => {
  const complianceGovernor = getGovernorById("compliance");
  const vote = await complianceGovernor.evaluate(
    buildProposal({
      type: "verify_browser",
      description: "Verify the localhost homepage UI in a browser",
      params: {
        url: "http://localhost:3000/"
      }
    }),
    buildContext("compliance")
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("ethics governor ignores advisory vetoes for bounded local start_process live-run actions", async () => {
  const ethicsGovernor = getGovernorById("ethics");
  const vote = await ethicsGovernor.evaluate(
    buildProposal({
      type: "start_process",
      description: "Start the local Python HTTP server for localhost verification",
      params: {
        command: "python -m http.server 8000",
        cwd: HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_TEST_DIR
      }
    }),
    buildContext("ethics")
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for python3 http.server start_process actions", async () => {
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "start_process",
      description: "Start the local Python3 HTTP server for localhost verification",
      params: {
        command: "python3 -m http.server 4173 --directory '/tmp/site'",
        cwd: HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_TEST_DIR
      }
    }),
    buildContext("security")
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for npm run preview localhost start_process actions", async () => {
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "start_process",
      description: "Start the local Vite preview server for the React landing page.",
      params: {
        command: "npm run preview -- --host 127.0.0.1 --port 4173",
        cwd: `${HOST_TEST_DESKTOP_DIR}${HOST_TEST_PATH_SEPARATOR}AI Drone City`
      }
    }),
    buildContext(
      "security",
      "In C:\\Users\\testuser\\Desktop\\AI Drone City, start the React app, wait for the local URL, and open it in the browser."
    )
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("logic governor ignores advisory vetoes for local Python serve-script start_process actions", async () => {
  const logicGovernor = getGovernorById("logic");
  const vote = await logicGovernor.evaluate(
    buildProposal({
      type: "start_process",
      description: "Start the local HTTP server script for localhost verification",
      params: {
        command: "python serve8124.py",
        cwd: HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_AUTO_8124_DIR
      }
    }),
    buildContext("logic")
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for local Python serve-script start_process actions", async () => {
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "start_process",
      description: "Start the local HTTP server script for localhost verification",
      params: {
        command: "python serve8124.py",
        cwd: HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_AUTO_8124_DIR
      }
    }),
    buildContext("security")
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("compliance governor ignores advisory vetoes for local Python serve-script start_process actions", async () => {
  const complianceGovernor = getGovernorById("compliance");
  const vote = await complianceGovernor.evaluate(
    buildProposal({
      type: "start_process",
      description: "Start the local HTTP server script for localhost verification",
      params: {
        command: "python serve8124.py",
        cwd: HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_AUTO_8124_DIR
      }
    }),
    buildContext("compliance")
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("security governor ignores advisory vetoes for bounded managed-process check actions", async () => {
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "check_process",
      description: "Check the managed localhost server lease before retrying readiness",
      params: {
        leaseId: "proc_localhost_live_1"
      }
    }),
    buildContext("security")
  );

  assert.equal(vote.approve, true);
  assert.equal(vote.rejectCategory, undefined);
});

test("generic start_process actions still honor advisory vetoes when they are not local live-run commands", async () => {
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "start_process",
      description: "Start a long-running custom process",
      params: {
        command: "python background_worker.py",
        cwd: HOST_TEST_PLAYWRIGHT_PROOF_SMOKE_TEST_DIR
      }
    }),
    buildContext("security")
  );

  assert.equal(vote.approve, false);
  assert.equal(vote.rejectCategory, "MODEL_ADVISORY_BLOCK");
});

test("security governor preserves destructive shell-command block behavior on canonical cases", async () => {
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "shell_command",
      description: "run dangerous command",
      params: {
        command: "rm -rf /"
      }
    }),
    buildContext()
  );

  assert.equal(vote.approve, false);
  assert.equal(vote.rejectCategory, "SECURITY_BOUNDARY");
  assert.match(vote.reason, /blocked destructive patterns/i);
});

test("security governor lexical block never contradicts hard-constraint dangerous-command boundary", async () => {
  const proposal = buildProposal({
    type: "shell_command",
    description: "run dangerous command",
    params: {
      command: "shutdown -s -t 0"
    }
  });
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(proposal, buildContext());
  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);

  assert.equal(vote.approve, false);
  assert.equal(vote.rejectCategory, "SECURITY_BOUNDARY");
  assert.equal(
    violations.some((violation) => violation.code === "SHELL_DANGEROUS_COMMAND"),
    true
  );
});
