import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  runAutonomousRuntimeAffordancesDirectAutoSmoke
} from "../../scripts/evidence/autonomousRuntimeAffordancesDirectAutoSmoke";

const KNOWN_BLOCKER_REASON_REGEX =
  /(?:429|exceeded your current quota|usage limit|purchase more credits|try again at|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET|governor timeout or failure|requires a real model backend|effective backend is mock|missing OPENAI_API_KEY|bounded direct-auto smoke budget expired|Planner model did not include a real folder-move step for this local organization request|Planner model retried the local organization move without also proving what moved into the destination and what remained at the original root|Planner model selected the named destination folder as part of the same move set, which risks nesting the destination inside itself|Planner model used cmd-style shell moves for a Windows PowerShell organization request|Planner model used invalid PowerShell variable interpolation for a Windows organization move command)/i;

test("autonomous runtime affordances direct-auto smoke emits a PASS artifact for the destination self-match organization case", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Desktop/browser direct-auto smoke is currently validated on Windows hosts only.");
    return;
  }
  const artifact = await runAutonomousRuntimeAffordancesDirectAutoSmoke();
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/autonomous_runtime_affordances_direct_auto_report.json"
  );
  const persisted = JSON.parse(await readFile(artifactPath, "utf8")) as {
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

  if (
    persisted.status === "BLOCKED"
    && KNOWN_BLOCKER_REASON_REGEX.test([
      persisted.successScenario.blockerReason ?? "",
      persisted.boundedStopScenario.blockerReason ?? ""
    ].join("\n"))
  ) {
    t.skip("Real backend capacity or availability blocked the direct-auto smoke.");
    return;
  }

  assert.equal(artifact.status, "PASS");
  assert.equal(persisted.status, "PASS");
  assert.equal(
    Object.values(persisted.successScenario.checks).every((value) => value === true),
    true
  );
  assert.equal(
    Object.values(persisted.boundedStopScenario.checks).every((value) => value === true),
    true
  );
  assert.equal(persisted.successScenario.desktopEntriesAfter.length, 1);
  assert.ok(persisted.successScenario.movedEntries.length >= 2);
  assert.equal(persisted.boundedStopScenario.terminalOutcome, "stopped");
  assert.equal(
    persisted.boundedStopScenario.progressStates.some((entry) => entry.status === "stopped"),
    true
  );
});
