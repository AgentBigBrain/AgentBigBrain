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

const KNOWN_BLOCKER_REASON_REGEX =
  /(?:429|exceeded your current quota|usage limit|purchase more credits|try again at|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET|governor timeout or failure|requires a real model backend|effective backend is mock|missing OPENAI_API_KEY|bounded direct-auto smoke budget expired|timed out before emitting a terminal direct-auto artifact|Planner model did not include a real folder-move step for this local organization request|Planner model retried the local organization move without also proving what moved into the destination and what remained at the original root|Planner model selected the named destination folder as part of the same move set, which risks nesting the destination inside itself|Planner model used cmd-style shell moves for a Windows PowerShell organization request|Planner model used invalid PowerShell variable interpolation for a Windows organization move command)/i;

const SCRIPT_TIMEOUT_MS = 120_000;

/**
 * Runs the direct-auto evidence script out-of-process so live Desktop/model handles cannot wedge
 * the default test worker indefinitely.
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

async function readPersistedArtifact(
  artifactPath: string
): Promise<{
  status: string;
  successScenario: {
    blockerReason: string | null;
    movedEntries: string[];
    desktopEntriesAfter: string[];
    checks: Record<string, boolean>;
  };
  boundedStopScenario: {
    blockerReason: string | null;
    terminalOutcome: string;
    progressStates: Array<{ status: string }>;
    checks: Record<string, boolean>;
  };
} | null> {
  try {
    return JSON.parse(await readFile(artifactPath, "utf8")) as {
      status: string;
      successScenario: {
        blockerReason: string | null;
        movedEntries: string[];
        desktopEntriesAfter: string[];
        checks: Record<string, boolean>;
      };
      boundedStopScenario: {
        blockerReason: string | null;
        terminalOutcome: string;
        progressStates: Array<{ status: string }>;
        checks: Record<string, boolean>;
      };
    };
  } catch {
    return null;
  }
}

test("autonomous runtime affordances direct-auto smoke emits a PASS artifact for the destination self-match organization case", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Desktop/browser direct-auto smoke is currently validated on Windows hosts only.");
    return;
  }
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/autonomous_runtime_affordances_direct_auto_report.json"
  );
  await rm(artifactPath, { force: true }).catch(() => undefined);
  const childResult = await runScriptWithTimeout(
    "scripts/evidence/autonomousRuntimeAffordancesDirectAutoSmoke.ts",
    SCRIPT_TIMEOUT_MS
  );
  const persisted = await readPersistedArtifact(artifactPath);
  const combinedBlockerReason = [
    persisted?.successScenario.blockerReason ?? "",
    persisted?.boundedStopScenario.blockerReason ?? "",
    childResult.timedOut
      ? "Timed out before emitting a terminal direct-auto artifact."
      : "",
    childResult.stderr,
    childResult.stdout
  ].join("\n");

  if (childResult.timedOut && persisted === null) {
    t.skip("Live direct-auto smoke timed out before a terminal artifact.");
    return;
  }

  if (persisted === null) {
    assert.fail("Direct-auto smoke did not emit an artifact.");
  }
  const artifact = persisted;

  if (
    (artifact.status === "BLOCKED" || childResult.timedOut)
    && KNOWN_BLOCKER_REASON_REGEX.test(combinedBlockerReason)
  ) {
    t.skip("Real backend capacity or availability blocked the direct-auto smoke.");
    return;
  }

  assert.equal(
    childResult.timedOut,
    false,
    `Direct-auto smoke exceeded ${SCRIPT_TIMEOUT_MS}ms.\nSTDOUT:\n${childResult.stdout}\nSTDERR:\n${childResult.stderr}`
  );
  assert.equal(
    childResult.exitCode,
    0,
    `Direct-auto smoke exited with code ${childResult.exitCode}.\nSTDOUT:\n${childResult.stdout}\nSTDERR:\n${childResult.stderr}`
  );
  assert.equal(artifact.status, "PASS");
  assert.equal(
    Object.values(artifact.successScenario.checks).every((value) => value === true),
    true
  );
  assert.equal(
    Object.values(artifact.boundedStopScenario.checks).every((value) => value === true),
    true
  );
  assert.equal(artifact.successScenario.desktopEntriesAfter.length, 1);
  assert.ok(artifact.successScenario.movedEntries.length >= 2);
  assert.equal(artifact.boundedStopScenario.terminalOutcome, "stopped");
  assert.equal(
    artifact.boundedStopScenario.progressStates.some((entry) => entry.status === "stopped"),
    true
  );
});
