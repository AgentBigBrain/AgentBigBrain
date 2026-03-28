/**
 * @fileoverview Covers bounded Codex model-client auth gating and usage telemetry.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";

import {
  CodexModelClient,
  MIN_CODEX_PLANNER_REQUEST_TIMEOUT_MS,
  resolveCodexRequestTimeoutMs
} from "../../src/models/codexModelClient";

test("CodexModelClient starts with subscription billing mode and zero spend", () => {
  const client = new CodexModelClient();
  const usage = client.getUsageSnapshot();
  assert.equal(usage.calls, 0);
  assert.equal(usage.billingMode, "subscription_quota");
  assert.equal(usage.estimatedSpendUsd, 0);
});

test("resolveCodexRequestTimeoutMs gives planner turns a higher bounded timeout floor", () => {
  assert.equal(resolveCodexRequestTimeoutMs("planner_v1", 180_000), MIN_CODEX_PLANNER_REQUEST_TIMEOUT_MS);
  assert.equal(resolveCodexRequestTimeoutMs("planner_v1", 600_000), 600_000);
  assert.equal(resolveCodexRequestTimeoutMs("response_v1", 180_000), 180_000);
});

test("CodexModelClient fails closed when Codex auth is unavailable", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-codex-client-"));
  try {
    const client = new CodexModelClient({
      env: {
        ...process.env,
        CODEX_AUTH_STATE_DIR: tempDir
      }
    });

    await assert.rejects(
      () =>
        client.completeJson({
          model: "small-fast-model",
          schemaName: "planner_v1",
          systemPrompt: "Return planner JSON.",
          userPrompt: "Plan a safe next step.",
          temperature: 0
        }),
      /Codex auth is not available/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
