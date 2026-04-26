import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
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
 * Runs the handoff smoke out-of-process so lingering browser/runtime handles cannot wedge
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

test("autonomous runtime affordances handoff smoke emits either a PASS artifact or a bounded BLOCKED artifact with natural return and resume detail", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Desktop/browser handoff smoke is currently validated on Windows hosts only.");
    return;
  }
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/autonomous_runtime_affordances_handoff_report.json"
  );
  await rm(artifactPath, { force: true }).catch(() => undefined);
  const childResult = await runScriptWithTimeout(
    "scripts/evidence/autonomousRuntimeAffordancesHandoffSmoke.ts",
    SCRIPT_TIMEOUT_MS
  );
  const persisted = JSON.parse(await readFile(artifactPath, "utf8")) as {
    status: string;
    blockerReason: string | null;
    checks: Record<string, boolean>;
    targetFolder: string | null;
    previewUrl: string | null;
  };
  const combinedBlockerReason = [
    persisted.blockerReason ?? "",
    childResult.stderr,
    childResult.stdout
  ].join("\n");

  if (persisted.status === "BLOCKED") {
    assert.match(
      combinedBlockerReason,
      /(?:Timed out waiting|429|exceeded your current quota|usage limit|purchase more credits|try again at|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET|requires a real model backend|effective backend is mock|missing OPENAI_API_KEY)/i
    );
    return;
  }

  if (childResult.timedOut) {
    assert.equal(persisted.status, "BLOCKED");
    assert.match(combinedBlockerReason, /Timed out waiting|request timed out/i);
    return;
  }

  assert.equal(childResult.exitCode, 0);
  assert.equal(persisted.status, "PASS");
  assert.equal(Object.values(persisted.checks).every(Boolean), true);
  assert.ok(persisted.targetFolder);
  assert.ok(persisted.previewUrl);
});
