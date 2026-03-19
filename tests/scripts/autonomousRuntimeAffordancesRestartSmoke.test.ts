import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const SCRIPT_TIMEOUT_MS = 120_000;

interface ChildRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runRestartSmokeScript(): Promise<ChildRunResult> {
  const tsxPackagePath = require.resolve("tsx/package.json");
  const tsxCliPath = path.resolve(path.dirname(tsxPackagePath), "dist/cli.mjs");
  const child = spawn(process.execPath, [tsxCliPath, "scripts/evidence/autonomousRuntimeAffordancesRestartSmoke.ts"], {
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
      // Best-effort only.
    }
  }, SCRIPT_TIMEOUT_MS);

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

test("autonomous runtime affordances restart smoke exits cleanly and emits a PASS artifact with reload-safe close and unknown-resource stop proof", async (t) => {
  const childRun = await runRestartSmokeScript();
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/autonomous_runtime_affordances_restart_report.json"
  );
  const persisted = JSON.parse(await readFile(artifactPath, "utf8")) as {
    status: string;
    blockerReason: string | null;
    checks: Record<string, boolean>;
    reloadBeforeClose: {
      browserTrackedCurrent: boolean;
      browserTrackedOrphaned: boolean;
      browserStatus: string | null;
      processTrackedCurrent: boolean;
    };
    reloadAfterClose: {
      browserTrackedStale: boolean;
      processTrackedStale: boolean;
    };
  };

  if (
    persisted.status === "BLOCKED" &&
    /(?:429|exceeded your current quota|rate limit|fetch failed|request timed out|timed out waiting for turn_|stream disconnected before completion|an error occurred while processing your request|requires a real model backend|effective backend is mock|missing OPENAI_API_KEY)/i.test(
      persisted.blockerReason ?? ""
    )
  ) {
    t.skip("Real backend capacity or availability blocked the restart live smoke.");
    return;
  }

  assert.equal(
    childRun.timedOut,
    false,
    `Restart smoke exceeded ${SCRIPT_TIMEOUT_MS}ms.\nSTDOUT:\n${childRun.stdout}\nSTDERR:\n${childRun.stderr}`
  );
  assert.equal(
    childRun.exitCode,
    0,
    `Restart smoke exited with code ${childRun.exitCode}.\nSTDOUT:\n${childRun.stdout}\nSTDERR:\n${childRun.stderr}`
  );
  assert.equal(persisted.status, "PASS");
  assert.equal(Object.values(persisted.checks).every(Boolean), true);
  assert.equal(persisted.reloadBeforeClose.browserStatus, "open");
  assert.equal(
    persisted.reloadBeforeClose.browserTrackedCurrent ||
      persisted.reloadBeforeClose.browserTrackedOrphaned,
    true
  );
  assert.equal(persisted.reloadBeforeClose.processTrackedCurrent, true);
  assert.equal(persisted.reloadAfterClose.browserTrackedStale, true);
  assert.equal(persisted.reloadAfterClose.processTrackedStale, true);
});
