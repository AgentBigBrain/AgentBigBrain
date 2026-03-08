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

test("parseAutonomousExecutionInput extracts prefixed goals and rejects plain inputs", () => {
  assert.equal(
    parseAutonomousExecutionInput(
      `${AUTONOMOUS_EXECUTION_PREFIX} verify localhost in a real browser`
    ),
    "verify localhost in a real browser"
  );
  assert.equal(parseAutonomousExecutionInput("plain task input"), null);
});
