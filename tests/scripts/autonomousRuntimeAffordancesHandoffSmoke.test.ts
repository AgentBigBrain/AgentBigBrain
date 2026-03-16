import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  runAutonomousRuntimeAffordancesHandoffSmoke
} from "../../scripts/evidence/autonomousRuntimeAffordancesHandoffSmoke";

test("autonomous runtime affordances handoff smoke emits a PASS artifact with natural return and resume proof", async (t) => {
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

  if (
    persisted.status === "BLOCKED" &&
    /(?:429|exceeded your current quota|rate limit|fetch failed|request timed out)/i.test(
      persisted.blockerReason ?? ""
    )
  ) {
    t.skip("Provider quota blocked the handoff live smoke.");
    return;
  }

  assert.equal(artifact.status, "PASS");
  assert.equal(persisted.status, "PASS");
  assert.equal(Object.values(persisted.checks).every(Boolean), true);
  assert.ok(persisted.targetFolder);
  assert.ok(persisted.previewUrl);
});
