/**
 * @fileoverview Tests federation runtime config parsing and accepted-task production-path execution wiring.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BrainOrchestrator } from "../../src/core/orchestrator";
import { TaskRequest } from "../../src/core/types";
import { FederatedHttpClient } from "../../src/interfaces/federatedClient";
import {
  createFederationRuntimeConfigFromEnv,
  FederationRuntimeConfig,
  startFederationRuntime
} from "../../src/interfaces/federationRuntime";

const TEST_AGENT_ID = "federation_runtime_test_agent";
const TEST_SHARED_SECRET = "federation_runtime_test_secret";

/**
 * Implements SHA-256 digest derivation for deterministic auth contract fixtures.
 */
function hashSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Builds a one-contract JSON payload for env config parsing tests.
 */
function buildContractsJson(maxQuotedCostUsd = 5): string {
  return JSON.stringify([
    {
      externalAgentId: TEST_AGENT_ID,
      sharedSecretHash: hashSha256(TEST_SHARED_SECRET),
      maxQuotedCostUsd
    }
  ]);
}

/**
 * Executes callback with a temporary directory and deterministic cleanup.
 */
async function withTempDirectory(callback: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbb-federation-runtime-"));
  try {
    await callback(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Builds runtime config for integration tests using ephemeral HTTP port allocation.
 */
function buildRuntimeConfig(tempDir: string): FederationRuntimeConfig {
  return {
    enabled: true,
    port: 0,
    host: "127.0.0.1",
    maxBodyBytes: 65_536,
    resultTtlMs: 30_000,
    evictionIntervalMs: 1_000,
    resultStorePath: path.join(tempDir, "federated_results.json"),
    contracts: [
      {
        externalAgentId: TEST_AGENT_ID,
        sharedSecretHash: hashSha256(TEST_SHARED_SECRET),
        maxQuotedCostUsd: 5
      }
    ]
  };
}

test("createFederationRuntimeConfigFromEnv parses bounded config and contracts", () => {
  const config = createFederationRuntimeConfigFromEnv({
    BRAIN_ENABLE_FEDERATION_RUNTIME: "true",
    BRAIN_FEDERATION_HOST: "127.0.0.1",
    BRAIN_FEDERATION_PORT: "0",
    BRAIN_FEDERATION_MAX_BODY_BYTES: "70000",
    BRAIN_FEDERATION_RESULT_TTL_MS: "120000",
    BRAIN_FEDERATION_EVICTION_INTERVAL_MS: "15000",
    BRAIN_FEDERATION_RESULT_STORE_PATH: "runtime/evidence/federation_results_test.json",
    BRAIN_FEDERATION_CONTRACTS_JSON: buildContractsJson(7.25)
  });

  assert.equal(config.enabled, true);
  assert.equal(config.port, 0);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.maxBodyBytes, 70_000);
  assert.equal(config.resultTtlMs, 120_000);
  assert.equal(config.evictionIntervalMs, 15_000);
  assert.equal(config.resultStorePath, "runtime/evidence/federation_results_test.json");
  assert.equal(config.contracts.length, 1);
  assert.equal(config.contracts[0].externalAgentId, TEST_AGENT_ID);
  assert.equal(config.contracts[0].maxQuotedCostUsd, 7.25);
});

test("createFederationRuntimeConfigFromEnv fails closed when federation runtime is disabled", () => {
  assert.throws(
    () => createFederationRuntimeConfigFromEnv({}),
    /Federation runtime is disabled/i
  );
});

test("createFederationRuntimeConfigFromEnv fails closed on missing contracts", () => {
  assert.throws(
    () =>
      createFederationRuntimeConfigFromEnv({
        BRAIN_ENABLE_FEDERATION_RUNTIME: "true"
      }),
    /BRAIN_FEDERATION_CONTRACTS_JSON/i
  );
});

test("startFederationRuntime routes accepted tasks through orchestrator and publishes completed results", async () => {
  await withTempDirectory(async (tempDir) => {
    const seenTaskIds: string[] = [];
    const brainStub = {
      runTask: async (task: TaskRequest): Promise<{ summary: string }> => {
        seenTaskIds.push(task.id);
        return {
          summary: `federation task completed: ${task.id}`
        };
      }
    };
    const runtime = await startFederationRuntime(buildRuntimeConfig(tempDir), {
      brain: brainStub as unknown as BrainOrchestrator
    });

    try {
      const address = runtime.getAddress();
      assert.ok(address, "Runtime should expose bound address after start");

      const client = new FederatedHttpClient({
        baseUrl: `http://${address.host}:${address.port}`,
        timeoutMs: 5_000,
        auth: {
          externalAgentId: TEST_AGENT_ID,
          sharedSecret: TEST_SHARED_SECRET
        }
      });

      const delegateResult = await client.delegate({
        quoteId: "runtime_config_parse_quote",
        quotedCostUsd: 1.25,
        goal: "Return a deterministic runtime summary.",
        userInput: "Say hello from federated runtime."
      });

      assert.equal(delegateResult.ok, true);
      assert.ok(delegateResult.taskId);

      const result = await client.awaitResult(delegateResult.taskId as string, {
        pollIntervalMs: 25,
        timeoutMs: 5_000
      });

      assert.equal(result.ok, true);
      assert.equal(result.result?.status, "completed");
      assert.match(result.result?.output ?? "", /federation task completed/i);
      assert.equal(
        seenTaskIds.includes(delegateResult.taskId as string),
        true,
        "Runtime should invoke brain.runTask with accepted federated task ID"
      );
    } finally {
      await runtime.stop();
    }
  });
});

test("startFederationRuntime publishes failed results when orchestrator runTask throws", async () => {
  await withTempDirectory(async (tempDir) => {
    const brainStub = {
      runTask: async (_task: TaskRequest): Promise<{ summary: string }> => {
        throw new Error("simulated federated execution failure");
      }
    };
    const runtime = await startFederationRuntime(buildRuntimeConfig(tempDir), {
      brain: brainStub as unknown as BrainOrchestrator
    });

    try {
      const address = runtime.getAddress();
      assert.ok(address, "Runtime should expose bound address after start");

      const client = new FederatedHttpClient({
        baseUrl: `http://${address.host}:${address.port}`,
        timeoutMs: 5_000,
        auth: {
          externalAgentId: TEST_AGENT_ID,
          sharedSecret: TEST_SHARED_SECRET
        }
      });

      const delegateResult = await client.delegate({
        quoteId: "runtime_error_quote",
        quotedCostUsd: 1.0,
        goal: "Trigger failure path.",
        userInput: "Return failed task status from runtime."
      });

      assert.equal(delegateResult.ok, true);
      assert.ok(delegateResult.taskId);

      const result = await client.awaitResult(delegateResult.taskId as string, {
        pollIntervalMs: 25,
        timeoutMs: 5_000
      });

      assert.equal(result.ok, true);
      assert.equal(result.result?.status, "failed");
      assert.match(result.result?.error ?? "", /Federated task execution failed/i);
      assert.match(result.result?.error ?? "", /simulated federated execution failure/i);
    } finally {
      await runtime.stop();
    }
  });
});

