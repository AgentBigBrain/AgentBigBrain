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
} from "../../src/interfaces/userFacing/stopSummarySurface";

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
  const rendered = humanizeAutonomousStopReason("Cancelled by user.");

  assert.match(rendered, /stopped because you cancelled the run/i);
  assert.match(rendered, /next step: restart the run when you are ready to continue/i);
});

test("humanizeAutonomousStopReason explains explicit browser-proof gating plainly", () => {
  const rendered = humanizeAutonomousStopReason(
    "[reasonCode=AUTONOMOUS_EXECUTION_STYLE_BROWSER_EVIDENCE_REQUIRED] Goal completion deferred: missing mission requirement(s) BROWSER_PROOF."
  );

  assert.match(rendered, /need browser or UI proof/i);
  assert.match(rendered, /next step: keep the app running and add verify_browser after readiness passes/i);
});

test("humanizeAutonomousStopReason explains internal localhost-lesson failures plainly", () => {
  const rendered = humanizeAutonomousStopReason(
    "[reasonCode=AUTONOMOUS_TASK_EXECUTION_FAILED] Iteration 10 failed before completion: Retrieval quarantine blocked lesson lesson_demo: PRIVATE_RANGE_TARGET_DENIED (Private-range or localhost target patterns are denied in retrieval quarantine.)"
  );

  assert.match(rendered, /internal saved lesson about localhost was filtered out/i);
  assert.match(rendered, /next step: retry the same request/i);
});

test("humanizeAutonomousStopReason explains planner live-run verification failures plainly", () => {
  const rendered = humanizeAutonomousStopReason(
    "[reasonCode=AUTONOMOUS_TASK_EXECUTION_FAILED] Iteration 1 failed before completion: Planner model returned no live-verification actions for execution-style live-run request."
  );

  assert.match(rendered, /planner never produced a valid live-run verification plan/i);
  assert.match(
    rendered,
    /next step: retry with an explicit request to start the app, prove readiness with probe_http, and then verify the page with verify_browser/i
  );
});

test("humanizeAutonomousStopReason explains blocked live verification plainly", () => {
  const rendered = humanizeAutonomousStopReason(
    "[reasonCode=AUTONOMOUS_EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED] Live verification stopped because the environment blocked localhost readiness and browser verification steps, so I could not truthfully confirm the app or page in this run."
  );

  assert.match(rendered, /environment blocked the localhost readiness or browser verification steps/i);
  assert.match(rendered, /next step: allow local process and browser verification/i);
});

test("humanizeAutonomousStopReason explains never-ready local processes plainly", () => {
  const rendered = humanizeAutonomousStopReason(
    "[reasonCode=AUTONOMOUS_EXECUTION_STYLE_PROCESS_NEVER_READY] Live verification stopped because the running local process never became HTTP-ready at http://localhost:8000, so I stopped retrying and could not truthfully confirm the app or page in this run."
  );

  assert.match(rendered, /local server process kept running but never became HTTP-ready/i);
  assert.match(rendered, /next step: inspect the server command, chosen port, and startup logs/i);
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
  assert.match(rendered, /I started this, but I hit a blocker before I could finish it after 4 iteration\(s\)\./i);
  assert.match(rendered, /configured iteration limit/i);
  assert.match(rendered, /next step: narrow the goal or raise the iteration limit/i);
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

  assert.match(rendered, /I started this, but the run stopped before it finished after 3 iteration\(s\)\./i);
  assert.match(rendered, /Stopped because you cancelled the run\./i);
  assert.match(rendered, /Next step: restart the run when you are ready to continue\./i);
  assert.match(rendered, /Approved 2, blocked 1\./i);
});

test("buildAutonomousTerminalSummaryMessage keeps completed summaries human-first", () => {
  const rendered = buildAutonomousTerminalSummaryMessage(true, 2, 3, 1);

  assert.match(rendered, /Autonomous task completed after 2 iteration\(s\)\./i);
  assert.match(rendered, /I finished the goal with 3 approved action\(s\) and 1 blocked\./i);
});
