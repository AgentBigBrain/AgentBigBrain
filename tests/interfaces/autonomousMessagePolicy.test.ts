/**
 * @fileoverview Tests human-first autonomous progress and stop message rendering for chat interfaces.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAutonomousGoalAbortedProgressMessage,
  buildAutonomousGoalMetProgressMessage,
  buildAutonomousIterationProgressMessage,
  buildAutonomousTerminalSummaryMessage,
  humanizeAutonomousStopReason
} from "../../src/interfaces/autonomousMessagePolicy";

test("humanizeAutonomousStopReason removes raw reason-code prefixes and explains stalled evidence plainly", () => {
  const rendered = humanizeAutonomousStopReason(
    "[reasonCode=AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT] Stuck: 3 consecutive iterations with 0 required mission completion evidence."
  );

  assert.doesNotMatch(rendered, /\[reasonCode=/i);
  assert.match(rendered, /could not verify enough real execution progress/i);
});

test("humanizeAutonomousStopReason explains stalled browser-proof runs plainly", () => {
  const rendered = humanizeAutonomousStopReason(
    "[reasonCode=AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT] Stuck: 3 consecutive iterations with 0 required mission completion evidence. Missing requirement(s): BROWSER_PROOF."
  );

  assert.doesNotMatch(rendered, /\[reasonCode=/i);
  assert.match(rendered, /browser or UI proof/i);
});

test("humanizeAutonomousStopReason explains user cancellation plainly", () => {
  assert.equal(
    humanizeAutonomousStopReason("Cancelled by user."),
    "Stopped because you cancelled the run."
  );
});

test("humanizeAutonomousStopReason explains explicit browser-proof gating plainly", () => {
  assert.equal(
    humanizeAutonomousStopReason(
      "[reasonCode=AUTONOMOUS_EXECUTION_STYLE_BROWSER_EVIDENCE_REQUIRED] Goal completion deferred: missing mission requirement(s) BROWSER_PROOF."
    ),
    "I need browser or UI proof before I can say the page rendered as expected."
  );
});

test("humanizeAutonomousStopReason explains internal localhost-lesson failures plainly", () => {
  assert.equal(
    humanizeAutonomousStopReason(
      "[reasonCode=AUTONOMOUS_TASK_EXECUTION_FAILED] Iteration 10 failed before completion: Retrieval quarantine blocked lesson lesson_demo: PRIVATE_RANGE_TARGET_DENIED (Private-range or localhost target patterns are denied in retrieval quarantine.)"
    ),
    "I stopped because an internal saved lesson about localhost was filtered out. That internal note should have been ignored instead of stopping your task."
  );
});

test("humanizeAutonomousStopReason explains blocked live verification plainly", () => {
  assert.equal(
    humanizeAutonomousStopReason(
      "[reasonCode=AUTONOMOUS_EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED] Live verification stopped because the environment blocked localhost readiness and browser verification steps, so I could not truthfully confirm the app or page in this run."
    ),
    "I stopped because this environment blocked the localhost readiness or browser verification steps, so I could not truthfully confirm the app or page in this run."
  );
});

test("humanizeAutonomousStopReason explains never-ready local processes plainly", () => {
  assert.equal(
    humanizeAutonomousStopReason(
      "[reasonCode=AUTONOMOUS_EXECUTION_STYLE_PROCESS_NEVER_READY] Live verification stopped because the running local process never became HTTP-ready at http://localhost:8000, so I stopped retrying and could not truthfully confirm the app or page in this run."
    ),
    "I stopped because the local server process kept running but never became HTTP-ready, so I could not truthfully verify the app or page in this run."
  );
});

test("buildAutonomousIterationProgressMessage renders human-first step progress", () => {
  const rendered = buildAutonomousIterationProgressMessage(2, 1, 0, 3, 1);
  assert.equal(
    rendered,
    "Step 2 finished. Approved 1 action(s), blocked 0. Total so far: 3 approved, 1 blocked."
  );
});

test("buildAutonomousGoalAbortedProgressMessage keeps totals while hiding raw reason codes", () => {
  const rendered = buildAutonomousGoalAbortedProgressMessage(
    4,
    2,
    1,
    "[reasonCode=AUTONOMOUS_MAX_ITERATIONS_REACHED] Reached maximum iterations (4) for goal."
  );

  assert.doesNotMatch(rendered, /\[reasonCode=/i);
  assert.match(rendered, /Stopped after 4 iteration\(s\)\./i);
  assert.match(rendered, /configured iteration limit/i);
  assert.match(rendered, /2 action\(s\) approved, 1 blocked\./i);
});

test("buildAutonomousGoalMetProgressMessage keeps success messaging human-first", () => {
  const rendered = buildAutonomousGoalMetProgressMessage(
    1,
    1,
    0,
    "Mock model decided the overarching goal is met."
  );

  assert.match(rendered, /Finished after 1 iteration\(s\)\./i);
  assert.match(rendered, /I completed the goal with 1 approved action\(s\) and 0 blocked\./i);
  assert.match(rendered, /Why I'm confident: the completed work in this run satisfied the goal\./i);
  assert.doesNotMatch(rendered, /Mock model decided/i);
});

test("buildAutonomousTerminalSummaryMessage returns human-first stopped summaries", () => {
  const rendered = buildAutonomousTerminalSummaryMessage(
    false,
    3,
    2,
    1,
    "Cancelled by user."
  );

  assert.match(rendered, /Autonomous task stopped after 3 iteration\(s\)\./i);
  assert.match(rendered, /Why it stopped: Stopped because you cancelled the run\./i);
});

test("buildAutonomousTerminalSummaryMessage keeps completed summaries human-first", () => {
  const rendered = buildAutonomousTerminalSummaryMessage(true, 2, 3, 1);

  assert.match(rendered, /Autonomous task completed after 2 iteration\(s\)\./i);
  assert.match(rendered, /I finished the goal with 3 approved action\(s\) and 1 blocked\./i);
});
