/**
 * @fileoverview Tests deterministic outbound federation config parsing and explicit intent policy evaluation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFederatedOutboundRuntimeConfigFromEnv,
  evaluateFederatedOutboundPolicy,
  parseFederatedOutboundIntent
} from "../../src/core/federatedOutboundDelegation";
import { TaskRequest } from "../../src/core/types";

/**
 * Builds a deterministic task request fixture.
 */
function buildTask(userInput: string): TaskRequest {
  return {
    id: "task_outbound_policy_001",
    goal: "Test outbound federation behavior.",
    userInput,
    createdAt: "2026-03-03T00:00:00.000Z"
  };
}

test("parseFederatedOutboundIntent parses explicit intent tag", () => {
  const intent = parseFederatedOutboundIntent(
    "[federate:agent_beta quote=1.25] Please summarize release notes."
  );

  assert.ok(intent);
  assert.equal(intent.targetAgentId, "agent_beta");
  assert.equal(intent.quotedCostUsd, 1.25);
  assert.equal(intent.delegatedUserInput, "Please summarize release notes.");
});

test("parseFederatedOutboundIntent returns null when tag is absent", () => {
  const intent = parseFederatedOutboundIntent("Please summarize release notes.");
  assert.equal(intent, null);
});

test("createFederatedOutboundRuntimeConfigFromEnv defaults to disabled mode", () => {
  const config = createFederatedOutboundRuntimeConfigFromEnv({});
  assert.equal(config.enabled, false);
  assert.equal(config.targets.length, 0);
});

test("createFederatedOutboundRuntimeConfigFromEnv fails closed when enabled with missing targets json", () => {
  assert.throws(
    () =>
      createFederatedOutboundRuntimeConfigFromEnv({
        BRAIN_ENABLE_OUTBOUND_FEDERATION: "true"
      }),
    /BRAIN_FEDERATION_OUTBOUND_TARGETS_JSON/i
  );
});

test("createFederatedOutboundRuntimeConfigFromEnv parses valid target contracts", () => {
  const config = createFederatedOutboundRuntimeConfigFromEnv({
    BRAIN_ENABLE_OUTBOUND_FEDERATION: "true",
    BRAIN_FEDERATION_OUTBOUND_TARGETS_JSON: JSON.stringify([
      {
        externalAgentId: "agent_beta",
        baseUrl: "http://127.0.0.1:9100",
        sharedSecret: "secret_value",
        maxQuotedCostUsd: 4.5,
        awaitTimeoutMs: 22000,
        pollIntervalMs: 300
      }
    ])
  });

  assert.equal(config.enabled, true);
  assert.equal(config.targets.length, 1);
  assert.equal(config.targets[0].externalAgentId, "agent_beta");
  assert.equal(config.targets[0].baseUrl, "http://127.0.0.1:9100");
  assert.equal(config.targets[0].maxQuotedCostUsd, 4.5);
  assert.equal(config.targets[0].awaitTimeoutMs, 22000);
  assert.equal(config.targets[0].pollIntervalMs, 300);
});

test("evaluateFederatedOutboundPolicy reports no-intent when task has no explicit tag", () => {
  const decision = evaluateFederatedOutboundPolicy(
    buildTask("Please summarize release notes."),
    {
      enabled: true,
      targets: []
    }
  );

  assert.equal(decision.shouldDelegate, false);
  assert.equal(decision.reasonCode, "NO_OUTBOUND_DELEGATION_INTENT");
  assert.equal(decision.intent, null);
});

test("evaluateFederatedOutboundPolicy fails closed when config is disabled", () => {
  const decision = evaluateFederatedOutboundPolicy(
    buildTask("[federate:agent_beta quote=1.0] summarize this"),
    {
      enabled: false,
      targets: []
    }
  );

  assert.equal(decision.shouldDelegate, false);
  assert.equal(decision.reasonCode, "OUTBOUND_FEDERATION_DISABLED");
});

test("evaluateFederatedOutboundPolicy fails closed for unknown target", () => {
  const decision = evaluateFederatedOutboundPolicy(
    buildTask("[federate:agent_beta quote=1.0] summarize this"),
    {
      enabled: true,
      targets: [
        {
          externalAgentId: "agent_gamma",
          baseUrl: "http://127.0.0.1:9101",
          sharedSecret: "secret",
          maxQuotedCostUsd: 2,
          awaitTimeoutMs: 10000,
          pollIntervalMs: 250
        }
      ]
    }
  );

  assert.equal(decision.shouldDelegate, false);
  assert.equal(decision.reasonCode, "OUTBOUND_TARGET_NOT_ALLOWLISTED");
});

test("evaluateFederatedOutboundPolicy fails closed when quote exceeds target cap", () => {
  const decision = evaluateFederatedOutboundPolicy(
    buildTask("[federate:agent_beta quote=8.5] summarize this"),
    {
      enabled: true,
      targets: [
        {
          externalAgentId: "agent_beta",
          baseUrl: "http://127.0.0.1:9101",
          sharedSecret: "secret",
          maxQuotedCostUsd: 2,
          awaitTimeoutMs: 10000,
          pollIntervalMs: 250
        }
      ]
    }
  );

  assert.equal(decision.shouldDelegate, false);
  assert.equal(decision.reasonCode, "OUTBOUND_QUOTE_EXCEEDED");
});

test("evaluateFederatedOutboundPolicy allows delegation when intent target and quote checks pass", () => {
  const decision = evaluateFederatedOutboundPolicy(
    buildTask("[federate:agent_beta quote=1.5] summarize this"),
    {
      enabled: true,
      targets: [
        {
          externalAgentId: "agent_beta",
          baseUrl: "http://127.0.0.1:9101",
          sharedSecret: "secret",
          maxQuotedCostUsd: 2,
          awaitTimeoutMs: 10000,
          pollIntervalMs: 250
        }
      ]
    }
  );

  assert.equal(decision.shouldDelegate, true);
  assert.equal(decision.reasonCode, "OUTBOUND_DELEGATION_ALLOWED");
  assert.equal(decision.target?.externalAgentId, "agent_beta");
});

