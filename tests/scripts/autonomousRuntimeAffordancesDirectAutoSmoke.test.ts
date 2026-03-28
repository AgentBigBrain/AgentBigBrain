import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  runAutonomousRuntimeAffordancesDirectAutoSmoke
} from "../../scripts/evidence/autonomousRuntimeAffordancesDirectAutoSmoke";

test("autonomous runtime affordances direct-auto smoke emits a PASS artifact for the destination self-match organization case", async (t) => {
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
    && /(?:429|exceeded your current quota|usage limit|purchase more credits|try again at|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET|governor timeout or failure|requires a real model backend|effective backend is mock|missing OPENAI_API_KEY|bounded direct-auto smoke budget expired)/i.test([
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
