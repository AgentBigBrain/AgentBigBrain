/**
 * @fileoverview Tests frozen SafetyLexiconV1 deterministic classification and fingerprint stability characteristics.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifySafetyAbuseText,
  classifySafetyDestructiveCommandText,
  createSafetyLexiconRuleContext
} from "../../src/governors/safetyLexicon";

test("classifySafetyAbuseText detects abuse terms with deterministic metadata", () => {
  const context = createSafetyLexiconRuleContext();
  const result = classifySafetyAbuseText(
    "proposal asks for malware persistence and exploit chaining",
    context
  );

  assert.equal(result.category, "ABUSE_SIGNAL");
  assert.equal(result.matchedRuleId, "safety_lexicon_v1_abuse_term_match");
  assert.equal(result.rulepackVersion, "SafetyLexiconV1");
  assert.equal(result.matchedToken, "malware");
});

test("classifySafetyDestructiveCommandText detects destructive shell terms deterministically", () => {
  const context = createSafetyLexiconRuleContext();
  const result = classifySafetyDestructiveCommandText("sudo rm -rf /", context);

  assert.equal(result.category, "DESTRUCTIVE_COMMAND_SIGNAL");
  assert.equal(result.matchedRuleId, "safety_lexicon_v1_destructive_command_match");
  assert.equal(result.matchedToken, "rm -rf /");
});

test("createSafetyLexiconRuleContext yields stable fingerprint across invocations", () => {
  const first = createSafetyLexiconRuleContext();
  const second = createSafetyLexiconRuleContext();

  assert.equal(first.rulepackFingerprint, second.rulepackFingerprint);
  assert.equal(first.rulepackVersion, second.rulepackVersion);
});
