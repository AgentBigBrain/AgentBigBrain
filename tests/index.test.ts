/**
 * @fileoverview Validates CLI argument parsing and daemon contract safeguards for `src/index.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCliArgs, resolveDaemonContract } from "../src/index";

test("parseCliArgs fails closed with usage when goal text is missing", () => {
  const parsed = parseCliArgs([]);
  assert.equal(parsed.ok, false);
  if (parsed.ok) {
    return;
  }
  assert.equal(parsed.failure.exitCode, 1);
  assert.equal(parsed.failure.stream, "stderr");
  assert.match(parsed.failure.message, /^Usage:/);
});

test("parseCliArgs prints usage on --help", () => {
  const parsed = parseCliArgs(["--help"]);
  assert.equal(parsed.ok, false);
  if (parsed.ok) {
    return;
  }
  assert.equal(parsed.failure.exitCode, 0);
  assert.equal(parsed.failure.stream, "stdout");
  assert.match(parsed.failure.message, /^Usage:/);
});

test("parseCliArgs defaults to task mode", () => {
  const parsed = parseCliArgs(["Ship", "the", "release"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.command.mode, "task");
  assert.equal(parsed.command.goal, "Ship the release");
});

test("parseCliArgs supports --autonomous mode", () => {
  const parsed = parseCliArgs(["--autonomous", "Refactor", "module"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.command.mode, "autonomous");
  assert.equal(parsed.command.goal, "Refactor module");
});

test("parseCliArgs supports --daemon mode", () => {
  const parsed = parseCliArgs(["--daemon", "Run", "continuous", "improvements"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.command.mode, "daemon");
  assert.equal(parsed.command.goal, "Run continuous improvements");
});

test("parseCliArgs rejects conflicting loop flags", () => {
  const parsed = parseCliArgs(["--autonomous", "--daemon", "Conflicting"]);
  assert.equal(parsed.ok, false);
  if (parsed.ok) {
    return;
  }
  assert.equal(parsed.failure.exitCode, 1);
  assert.equal(parsed.failure.stream, "stderr");
  assert.match(parsed.failure.message, /Cannot combine --autonomous and --daemon/);
});

test("parseCliArgs rejects unknown flags", () => {
  const parsed = parseCliArgs(["--unknown", "goal"]);
  assert.equal(parsed.ok, false);
  if (parsed.ok) {
    return;
  }
  assert.equal(parsed.failure.exitCode, 1);
  assert.equal(parsed.failure.stream, "stderr");
  assert.match(parsed.failure.message, /Unknown flag/);
});

test("resolveDaemonContract requires explicit daemon acknowledgement latch", () => {
  assert.throws(
    () =>
      resolveDaemonContract({
        BRAIN_MAX_DAEMON_GOAL_ROLLOVERS: "2"
      }),
    /BRAIN_ALLOW_DAEMON_MODE=true/
  );
});

test("resolveDaemonContract requires bounded rollover count", () => {
  assert.throws(
    () =>
      resolveDaemonContract({
        BRAIN_ALLOW_DAEMON_MODE: "true"
      }),
    /BRAIN_MAX_DAEMON_GOAL_ROLLOVERS/
  );
});

test("resolveDaemonContract enforces positive integer rollover values", () => {
  assert.throws(
    () =>
      resolveDaemonContract({
        BRAIN_ALLOW_DAEMON_MODE: "true",
        BRAIN_MAX_DAEMON_GOAL_ROLLOVERS: "0"
      }),
    /integer > 0/
  );
});

test("resolveDaemonContract enforces bounded autonomous-iteration config in daemon mode", () => {
  assert.throws(
    () =>
      resolveDaemonContract({
        BRAIN_ALLOW_DAEMON_MODE: "true",
        BRAIN_MAX_DAEMON_GOAL_ROLLOVERS: "1",
        BRAIN_MAX_AUTONOMOUS_ITERATIONS: "0"
      }),
    /BRAIN_MAX_AUTONOMOUS_ITERATIONS > 0/
  );
});

test("resolveDaemonContract returns bounded rollover settings when contract is valid", () => {
  const contract = resolveDaemonContract({
    BRAIN_ALLOW_DAEMON_MODE: "true",
    BRAIN_MAX_DAEMON_GOAL_ROLLOVERS: "3",
    BRAIN_MAX_AUTONOMOUS_ITERATIONS: "5"
  });
  assert.deepEqual(contract, { maxGoalRollovers: 3 });
});
