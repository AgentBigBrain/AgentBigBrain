/**
 * @fileoverview Tests deterministic Stage 6.75 egress policy deny rules and secret-redaction behavior.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateStage675EgressPolicy,
  redactSensitiveEgressText
} from "../../src/core/stage6_75EgressPolicy";

test("egress policy blocks localhost, private-range, metadata, and .local targets", () => {
  const deniedTargets = [
    "http://localhost:3000",
    "http://127.0.0.1:8080",
    "http://169.254.169.254/latest/meta-data",
    "https://printer.local/status",
    "https://metadata.internal.example.com"
  ];
  for (const target of deniedTargets) {
    const decision = evaluateStage675EgressPolicy(target);
    assert.equal(decision.ok, false);
    assert.equal(decision.blockCode, "NETWORK_EGRESS_POLICY_BLOCKED");
  }
});

test("egress policy allows public https targets", () => {
  const decision = evaluateStage675EgressPolicy("https://api.github.com/repos/openai/openai-node");
  assert.equal(decision.ok, true);
  assert.equal(decision.blockCode, null);
});

test("secret redaction removes token-like values from logs", () => {
  const result = redactSensitiveEgressText(
    "Authorization: Bearer supersecret_token_value and api_key=abcd1234EFGH5678 cookie: session=xyz"
  );
  assert.ok(result.redactionCount >= 2);
  assert.ok(result.redactionTypes.includes("bearer_token"));
  assert.ok(result.redactedText.includes("[REDACTED_BEARER_TOKEN]"));
});
