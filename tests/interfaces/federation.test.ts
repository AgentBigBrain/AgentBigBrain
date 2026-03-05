/**
 * @fileoverview Integration tests for federated delegation and async result delivery protocol.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { FederatedInboundTask } from "../../src/core/federatedDelegation";
import { FederatedDelegationGateway } from "../../src/core/federatedDelegation";
import { FederatedHttpClient, FederatedAgentAuth } from "../../src/interfaces/federatedClient";
import { FederatedHttpServer } from "../../src/interfaces/federatedServer";

const TEST_SECRET = "agent-shared-secret-12345";
const TEST_SECRET_HASH = createHash("sha256").update(TEST_SECRET).digest("hex");

const TEST_CONTRACTS = [
  {
    externalAgentId: "agent_alpha",
    sharedSecretHash: TEST_SECRET_HASH,
    maxQuotedCostUsd: 5.0
  }
];

const DEFAULT_VALID_AUTH: FederatedAgentAuth = {
  externalAgentId: "agent_alpha",
  sharedSecret: TEST_SECRET
};

interface WithServerOptions {
  onTaskAccepted?: (input: Parameters<NonNullable<ConstructorParameters<typeof FederatedHttpServer>[0]["onTaskAccepted"]>>[0]) => Promise<void>;
  clientAuth?: FederatedAgentAuth;
}

const CLEANUP_RETRY_ATTEMPTS = 12;
const CLEANUP_RETRY_DELAY_MS = 25;

/**
 * Implements `sleep` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Implements `removeDirectoryWithRetries` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function removeDirectoryWithRetries(targetDir: string): Promise<void> {
  for (let attempt = 1; attempt <= CLEANUP_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await rm(targetDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "ENOTEMPTY" || code === "EPERM" || code === "EBUSY") && attempt < CLEANUP_RETRY_ATTEMPTS) {
        await sleep(CLEANUP_RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
  }
}

/**
 * Implements `buildValidInboundTask` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildValidInboundTask(overrides: Partial<FederatedInboundTask> = {}): FederatedInboundTask {
  return {
    quoteId: "q_test_001",
    quotedCostUsd: 1.0,
    goal: "Summarize the quarterly report",
    userInput: "Please provide a concise summary of Q4 results.",
    ...overrides
  };
}

/**
 * Implements `withServer` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withServer(
  callback: (client: FederatedHttpClient, server: FederatedHttpServer) => Promise<void>,
  options: WithServerOptions = {}
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbb-federation-"));
  const resultStorePath = path.join(tempDir, "federated_results.json");
  const gateway = new FederatedDelegationGateway(TEST_CONTRACTS);
  const server = new FederatedHttpServer({
    port: 0,
    gateway,
    resultStorePath,
    onTaskAccepted: options.onTaskAccepted
  });

  await server.start();
  const addr = server.getAddress();
  assert.ok(addr, "Server should return an address after starting");

  const client = new FederatedHttpClient({
    baseUrl: `http://${addr.host}:${addr.port}`,
    timeoutMs: 5000,
    auth: options.clientAuth === undefined ? DEFAULT_VALID_AUTH : options.clientAuth
  });

  try {
    await callback(client, server);
  } finally {
    await server.stop();
    await removeDirectoryWithRetries(tempDir);
  }
}

test("federation health check returns healthy", async () => {
  await withServer(async (client) => {
    const result = await client.health();
    assert.equal(result.healthy, true);
    assert.equal(result.error, null);
  });
});

test("federation delegation succeeds with valid credentials and contract", async () => {
  await withServer(async (client) => {
    const result = await client.delegate(buildValidInboundTask());

    assert.equal(result.ok, true);
    assert.equal(result.httpStatus, 200);
    assert.ok(result.decision);
    assert.equal(result.decision?.accepted, true);
    assert.ok(result.decision?.taskRequest);
    assert.ok(result.taskId);
  });
});

test("federation delegation rejects unknown agent", async () => {
  await withServer(async (client) => {
    const result = await client.delegate(buildValidInboundTask(), {
      externalAgentId: "unknown_agent",
      sharedSecret: TEST_SECRET
    });

    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 403);
    assert.ok(result.decision);
    assert.ok(result.decision?.blockedBy.includes("FEDERATED_AGENT_NOT_ALLOWLISTED"));
  });
});

test("federation delegation rejects bad secret", async () => {
  await withServer(async (client) => {
    const result = await client.delegate(buildValidInboundTask(), {
      externalAgentId: "agent_alpha",
      sharedSecret: "wrong-secret"
    });

    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 403);
    assert.ok(result.decision?.blockedBy.includes("FEDERATED_AUTH_FAILED"));
  });
});

test("federation delegation rejects quote exceeding contract max", async () => {
  await withServer(async (client) => {
    const result = await client.delegate(
      buildValidInboundTask({
        quotedCostUsd: 100
      })
    );

    assert.equal(result.ok, false);
    assert.ok(result.decision?.blockedBy.includes("FEDERATED_QUOTE_EXCEEDED"));
  });
});

test("federation delegation rejects empty goal", async () => {
  await withServer(async (client) => {
    const result = await client.delegate(
      buildValidInboundTask({
        goal: ""
      })
    );

    assert.equal(result.ok, false);
    assert.ok(result.decision?.blockedBy.includes("FEDERATED_REQUEST_INVALID"));
  });
});

test("onTaskAccepted callback fires for accepted tasks", async () => {
  let callbackFired = false;

  await withServer(
    async (client) => {
      await client.delegate(buildValidInboundTask());
      await sleep(30);
      assert.equal(callbackFired, true);
    },
    {
      onTaskAccepted: async () => {
        callbackFired = true;
      }
    }
  );
});

test("delegate returns quickly even when callback work is slow", async () => {
  await withServer(
    async (client) => {
      const startedAt = Date.now();
      const result = await client.delegate(buildValidInboundTask());
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.ok, true);
      assert.ok(result.taskId);
      assert.ok(elapsedMs < 180, `Expected non-blocking delegate path, got ${elapsedMs}ms`);
    },
    {
      onTaskAccepted: async () => {
        await sleep(250);
      }
    }
  );
});

test("full result delivery: delegate to pending to completed", async () => {
  await withServer(async (client, server) => {
    const delegateResult = await client.delegate(
      buildValidInboundTask({ quoteId: "q_result_001" })
    );

    assert.equal(delegateResult.ok, true);
    assert.ok(delegateResult.taskId);

    const pendingPoll = await client.pollResult(delegateResult.taskId as string);
    assert.equal(pendingPoll.ok, true);
    assert.equal(pendingPoll.result?.status, "pending");

    server.submitResult(delegateResult.taskId as string, "Summary ready.", null);

    const completedPoll = await client.pollResult(delegateResult.taskId as string);
    assert.equal(completedPoll.ok, true);
    assert.equal(completedPoll.result?.status, "completed");
    assert.equal(completedPoll.result?.output, "Summary ready.");
    assert.equal(completedPoll.result?.error, null);
  });
});

test("awaitResult polls until task completes", async () => {
  await withServer(async (client, server) => {
    const delegateResult = await client.delegate(
      buildValidInboundTask({ quoteId: "q_result_002" })
    );
    const taskId = delegateResult.taskId as string;

    setTimeout(() => {
      server.submitResult(taskId, "Async result delivered", null);
    }, 200);

    const result = await client.awaitResult(taskId, {
      pollIntervalMs: 50,
      timeoutMs: 5000
    });

    assert.equal(result.ok, true);
    assert.equal(result.result?.status, "completed");
    assert.equal(result.result?.output, "Async result delivered");
  });
});

test("callback failure is surfaced as failed task result", async () => {
  await withServer(
    async (client) => {
      const delegateResult = await client.delegate(
        buildValidInboundTask({ quoteId: "q_result_003" })
      );
      const taskId = delegateResult.taskId as string;

      const result = await client.awaitResult(taskId, {
        pollIntervalMs: 50,
        timeoutMs: 5000
      });

      assert.equal(result.ok, true);
      assert.equal(result.result?.status, "failed");
      assert.match(result.result?.error ?? "", /Task acceptance callback failed/i);
    },
    {
      onTaskAccepted: async () => {
        throw new Error("mock callback failure");
      }
    }
  );
});

test("poll for unknown taskId returns not found error", async () => {
  await withServer(async (client) => {
    const result = await client.pollResult("nonexistent_task_id_12345");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /No task found/i);
  });
});

test("poll client fails closed when auth credentials are missing", async () => {
  await withServer(
    async (client) => {
      const delegated = await client.delegate(buildValidInboundTask({ quoteId: "q_result_004" }));
      const noAuthClient = new FederatedHttpClient({
        baseUrl: (client as unknown as { readonly baseUrl: string }).baseUrl
      });

      const result = await noAuthClient.pollResult(delegated.taskId as string);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /Missing federation auth credentials/i);
    },
    {
      clientAuth: DEFAULT_VALID_AUTH
    }
  );
});

test("poll endpoint rejects when auth credentials are invalid", async () => {
  await withServer(async (client, server) => {
    const delegated = await client.delegate(buildValidInboundTask({ quoteId: "q_result_006" }));
    const address = server.getAddress();
    assert.ok(address);
    const wrongAuthClient = new FederatedHttpClient({
      baseUrl: `http://${address.host}:${address.port}`,
      auth: {
        externalAgentId: "agent_alpha",
        sharedSecret: "wrong-secret"
      }
    });

    const result = await wrongAuthClient.pollResult(delegated.taskId as string);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /failed authentication/i);
  });
});

test("failed task result delivery tracks explicit error status", async () => {
  await withServer(async (client, server) => {
    const delegateResult = await client.delegate(
      buildValidInboundTask({ quoteId: "q_result_005" })
    );

    const taskId = delegateResult.taskId as string;
    server.submitResult(taskId, null, "Hard constraint violation: budget exceeded");

    const poll = await client.pollResult(taskId);
    assert.equal(poll.ok, true);
    assert.equal(poll.result?.status, "failed");
    assert.equal(poll.result?.error, "Hard constraint violation: budget exceeded");
  });
});
