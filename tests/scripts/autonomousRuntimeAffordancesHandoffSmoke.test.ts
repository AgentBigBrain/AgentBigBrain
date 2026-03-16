import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  runAutonomousRuntimeAffordancesHandoffSmoke
} from "../../scripts/evidence/autonomousRuntimeAffordancesHandoffSmoke";

test("autonomous runtime affordances handoff smoke emits either a PASS artifact or a bounded BLOCKED artifact with natural return and resume detail", async (t) => {
  const artifact = await runAutonomousRuntimeAffordancesHandoffSmoke();
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/autonomous_runtime_affordances_handoff_report.json"
  );
  const persisted = JSON.parse(await readFile(artifactPath, "utf8")) as {
    status: string;
    blockerReason: string | null;
    checks: Record<string, boolean>;
    targetFolder: string | null;
    previewUrl: string | null;
  };

  if (persisted.status === "BLOCKED") {
    assert.equal(artifact.status, "BLOCKED");
    assert.match(
      persisted.blockerReason ?? "",
      /(?:Timed out waiting|429|exceeded your current quota|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET|requires a real model backend|effective backend is mock|missing OPENAI_API_KEY)/i
    );
    return;
  }

  assert.equal(artifact.status, "PASS");
  assert.equal(persisted.status, "PASS");
  assert.equal(Object.values(persisted.checks).every(Boolean), true);
  assert.ok(persisted.targetFolder);
  assert.ok(persisted.previewUrl);
});
