/**
 * @fileoverview Verifies legacy `src/cli.ts` entrypoint forwards to canonical CLI behavior.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { runLegacyCliFromArgv } from "../src/cli";

test("legacy CLI shim returns usage failure code when goal is missing", async () => {
  const exitCode = await runLegacyCliFromArgv([]);
  assert.equal(exitCode, 1);
});

test("legacy CLI shim returns help success code", async () => {
  const exitCode = await runLegacyCliFromArgv(["--help"]);
  assert.equal(exitCode, 0);
});
