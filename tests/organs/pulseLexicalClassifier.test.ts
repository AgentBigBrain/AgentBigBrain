/**
 * @fileoverview Tests deterministic pulse lexical classification, fail-closed conflict behavior, and tightening-only override loading.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  classifyPulseLexicalCommand,
  createPulseLexicalRuleContext
} from "../../src/organs/pulseLexicalClassifier";

/**
 * Implements `noOpLog` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function noOpLog(_message: string): void {
  // Intentionally blank for deterministic test output.
}

test("classifyPulseLexicalCommand resolves deterministic OFF intent for natural reminder language", () => {
  const ruleContext = createPulseLexicalRuleContext(null, noOpLog, noOpLog);
  const result = classifyPulseLexicalCommand("please turn off reminders", ruleContext);

  assert.equal(result.category, "COMMAND");
  assert.equal(result.commandIntent, "off");
  assert.equal(result.conflict, false);
  assert.equal(result.matchedRuleId, "pulse_lexical_v1_pattern_off");
  assert.equal(result.rulepackVersion, "PulseLexicalRulepackV1");
});

test("classifyPulseLexicalCommand fails closed on conflicting ON and OFF lexical signals", () => {
  const ruleContext = createPulseLexicalRuleContext(null, noOpLog, noOpLog);
  const result = classifyPulseLexicalCommand(
    "turn on and turn off pulse notifications",
    ruleContext
  );

  assert.equal(result.category, "UNCLEAR");
  assert.equal(result.commandIntent, null);
  assert.equal(result.conflict, true);
  assert.equal(result.matchedRuleId, "pulse_lexical_v1_conflicting_on_and_off");
});

test("classifyPulseLexicalCommand returns NON_COMMAND when no pulse-control lexical signal exists", () => {
  const ruleContext = createPulseLexicalRuleContext(null, noOpLog, noOpLog);
  const result = classifyPulseLexicalCommand("Could you chill with those for now?", ruleContext);

  assert.equal(result.category, "NON_COMMAND");
  assert.equal(result.commandIntent, null);
  assert.equal(result.conflict, false);
  assert.equal(result.matchedRuleId, "pulse_lexical_v1_no_pulse_signal");
});

test("classifyPulseLexicalCommand does not treat generic workspace start/open language as pulse on", () => {
  const ruleContext = createPulseLexicalRuleContext(null, noOpLog, noOpLog);
  const result = classifyPulseLexicalCommand(
    "Please build a small landing page, start a local preview server for it, and open it in a browser for me.",
    ruleContext
  );

  assert.equal(result.category, "NON_COMMAND");
  assert.equal(result.commandIntent, null);
  assert.equal(result.conflict, false);
  assert.equal(result.matchedRuleId, "pulse_lexical_v1_no_pulse_signal");
});

test("createPulseLexicalRuleContext loads tightening-only override and disables configured intents", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-lexical-override-"));
  const overridePath = path.join(tempDir, "pulse_lexical_override.json");
  const overridePayload = {
    schemaVersion: 1,
    disableIntents: ["off"],
    requirePulseKeywordForOnOff: true
  };

  try {
    await writeFile(overridePath, JSON.stringify(overridePayload, null, 2), "utf8");
    const ruleContext = createPulseLexicalRuleContext(overridePath, noOpLog, noOpLog);
    const offResult = classifyPulseLexicalCommand("turn off pulse", ruleContext);
    const noHintResult = classifyPulseLexicalCommand("turn on please", ruleContext);

    assert.ok(ruleContext.overrideFingerprint);
    assert.equal(ruleContext.overrideSourcePath, path.resolve(process.cwd(), overridePath));
    assert.equal(offResult.category, "UNCLEAR");
    assert.equal(offResult.matchedRuleId, "pulse_lexical_v1_disabled_intent_off");
    assert.equal(offResult.conflict, true);
    assert.equal(noHintResult.category, "NON_COMMAND");
    assert.equal(noHintResult.matchedRuleId, "pulse_lexical_v1_no_pulse_signal");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

