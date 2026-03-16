import assert from "node:assert/strict";
import test from "node:test";

import { classifyThreeStepArtifactStatus } from "../../scripts/evidence/realThreeStepWorkflowLiveSmoke";

test("classifyThreeStepArtifactStatus treats provider blockers as BLOCKED", () => {
  assert.equal(
    classifyThreeStepArtifactStatus("OpenAI responses request failed with 429"),
    "BLOCKED"
  );
});

test("classifyThreeStepArtifactStatus treats bounded running-turn timeouts as BLOCKED", () => {
  assert.equal(
    classifyThreeStepArtifactStatus("Error: Timed out waiting for turn_1 to complete.", {
      runningJobId: "job_123",
      progressState: {
        status: "working"
      }
    } as never),
    "BLOCKED"
  );
});

test("classifyThreeStepArtifactStatus keeps ordinary failures as FAIL", () => {
  assert.equal(
    classifyThreeStepArtifactStatus("Turn 2 did not apply a slider/carousel update to index.html."),
    "FAIL"
  );
});
