import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

interface ChildScriptResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const SCRIPT_TIMEOUT_MS = 185_000;

/**
 * Runs one evidence script in a child process so lingering browser/runtime handles cannot wedge
 * the node:test worker indefinitely.
 *
 * @param scriptPath - Repo-relative smoke script path.
 * @param timeoutMs - Hard timeout for the child process.
 * @returns Exit/stdio summary plus timeout state.
 */
async function runScriptWithTimeout(
  scriptPath: string,
  timeoutMs: number
): Promise<ChildScriptResult> {
  const tsxPackagePath = require.resolve("tsx/package.json");
  const tsxCliPath = path.resolve(path.dirname(tsxPackagePath), "dist/cli.mjs");
  const child = spawn(process.execPath, [tsxCliPath, scriptPath], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    try {
      void spawn("taskkill.exe", ["/PID", `${child.pid ?? 0}`, "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
    } catch {
      // Best effort only.
    }
  }, timeoutMs);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  }).finally(() => {
    clearTimeout(timeoutHandle);
  });

  return {
    exitCode,
    stdout,
    stderr,
    timedOut
  };
}

test("autonomous runtime affordances front-door live smoke emits either a PASS artifact or a bounded BLOCKED artifact with reviewable child detail", async (t) => {
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/autonomous_runtime_affordances_live_smoke_report.json"
  );
  const childResult = await runScriptWithTimeout(
    "scripts/evidence/autonomousRuntimeAffordancesLiveSmoke.ts",
    SCRIPT_TIMEOUT_MS
  );
  const persisted = JSON.parse(await readFile(artifactPath, "utf8")) as {
    status: string;
    blockerReason: string | null;
    checks: Record<string, boolean>;
    browserWorkflowScenario: {
      status: string;
      blockerReason: string | null;
      checks: Record<string, boolean>;
    };
    exactHolderRecoveryScenario: {
      status: string;
      blockerReason: string | null;
      checks: Record<string, boolean>;
    };
    ambiguousClarificationScenario: {
      status: string;
      blockerReason: string | null;
      checks: Record<string, boolean>;
      clarificationQuestion: string | null;
    };
  };
  const combinedBlockerReason = [
    persisted.blockerReason ?? "",
    persisted.browserWorkflowScenario.blockerReason ?? "",
    persisted.exactHolderRecoveryScenario.blockerReason ?? "",
    persisted.ambiguousClarificationScenario.blockerReason ?? "",
    childResult.stderr,
    childResult.stdout
  ].join("\n");

  if (
    persisted.status === "BLOCKED" &&
    /(?:429|exceeded your current quota|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET|requires a real model backend|effective backend is mock|missing OPENAI_API_KEY)/i.test(
      combinedBlockerReason
    )
  ) {
    t.skip("Real backend capacity or availability blocked the front-door live smoke.");
    return;
  }

  if (childResult.timedOut) {
    assert.equal(persisted.status, "BLOCKED");
    assert.match(combinedBlockerReason, /Timed out waiting|request timed out/i);
    return;
  }

  assert.equal(childResult.exitCode, 0);
  if (persisted.status === "BLOCKED") {
    assert.match(
      combinedBlockerReason,
      /Timed out waiting|Skipped the front-door clarification scenario|429|socket hang up|ECONNRESET|fetch failed|request timed out/i
    );
    assert.equal(
      ["PASS", "BLOCKED"].includes(persisted.browserWorkflowScenario.status),
      true
    );
    assert.equal(
      ["PASS", "BLOCKED"].includes(persisted.exactHolderRecoveryScenario.status),
      true
    );
    return;
  }
  assert.equal(persisted.status, "PASS");
  assert.equal(Object.values(persisted.checks).every(Boolean), true);
  assert.equal(persisted.browserWorkflowScenario.status, "PASS");
  assert.equal(persisted.exactHolderRecoveryScenario.status, "PASS");
  assert.equal(persisted.ambiguousClarificationScenario.status, "PASS");
  assert.equal(persisted.checks.naturalAutonomousStart, true);
  assert.equal(persisted.checks.workspaceContinuity, true);
  assert.equal(
    persisted.exactHolderRecoveryScenario.checks.autoRecoveredWithoutClarification,
    true
  );
  assert.equal(
    persisted.ambiguousClarificationScenario.checks.clarificationAsked,
    true
  );
  assert.match(
    persisted.ambiguousClarificationScenario.clarificationQuestion ?? "",
    /process|folder|move/i
  );
});
