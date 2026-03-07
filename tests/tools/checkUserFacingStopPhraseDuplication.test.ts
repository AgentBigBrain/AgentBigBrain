/**
 * @fileoverview Tests duplicate detection for canonical autonomous stop phrases.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertUserFacingStopPhraseDuplication,
  computeStopPhraseDuplicationDiagnosticsFromText
} from "../../src/tools/checkUserFacingStopPhraseDuplication";

test("assertUserFacingStopPhraseDuplication passes for the current repo", () => {
  assert.doesNotThrow(() => assertUserFacingStopPhraseDuplication(process.cwd()));
});

test("computeStopPhraseDuplicationDiagnosticsFromText reports duplicate canonical summaries", () => {
  const diagnostics = computeStopPhraseDuplicationDiagnosticsFromText(`
    appendActionableNextStep("Same summary", "Do one thing");
    appendActionableNextStep("Same summary", "Do another thing");
  `);

  assert.deepEqual(
    diagnostics.duplicatePhrases.map((duplicate) => duplicate.phrase),
    ["Same summary"]
  );
});

test("assertUserFacingStopPhraseDuplication fails when stopReasonText repeats a summary", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stop-phrase-"));
  await mkdir(path.join(repoRoot, "src/core/autonomy"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src/core/autonomy/stopReasonText.ts"),
    `
      function appendActionableNextStep(summary: string, nextStep: string): string {
        return summary + nextStep;
      }
      appendActionableNextStep("Repeated summary", "one");
      appendActionableNextStep("Repeated summary", "two");
    `,
    "utf8"
  );

  assert.throws(
    () => assertUserFacingStopPhraseDuplication(repoRoot),
    /Duplicate canonical autonomous stop phrases detected/i
  );
});
