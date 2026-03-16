/**
 * @fileoverview Covers canonical conversation-manager contracts and autonomous execution helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTONOMOUS_EXECUTION_PREFIX,
  buildAutonomousExecutionInput,
  parseAutonomousExecutionInput
} from "../../src/interfaces/conversationRuntime/managerContracts";

test("buildAutonomousExecutionInput prefixes goals deterministically", () => {
  assert.equal(
    buildAutonomousExecutionInput("verify localhost in a real browser"),
    `${AUTONOMOUS_EXECUTION_PREFIX} verify localhost in a real browser`
  );
});

test("buildAutonomousExecutionInput can encode a richer first-step autonomous execution brief", () => {
  const executionInput = buildAutonomousExecutionInput(
    "verify localhost in a real browser",
    "Deterministic routing hint:\n- Route type: execute\n\nCurrent user request:\nverify localhost in a real browser"
  );

  assert.match(executionInput, new RegExp(`^\\${AUTONOMOUS_EXECUTION_PREFIX} \\{`));
});

test("parseAutonomousExecutionInput extracts prefixed goals and rejects plain inputs", () => {
  assert.deepEqual(
    parseAutonomousExecutionInput(
      `${AUTONOMOUS_EXECUTION_PREFIX} verify localhost in a real browser`
    ),
    {
      goal: "verify localhost in a real browser",
      initialExecutionInput: null
    }
  );
  assert.deepEqual(
    parseAutonomousExecutionInput(
      `${AUTONOMOUS_EXECUTION_PREFIX} {"goal":"verify localhost in a real browser","initialExecutionInput":"Deterministic routing hint:\\n- Route type: execute"}`
    ),
    {
      goal: "verify localhost in a real browser",
      initialExecutionInput: "Deterministic routing hint:\n- Route type: execute"
    }
  );
  assert.equal(parseAutonomousExecutionInput("plain task input"), null);
});
