/**
 * @fileoverview Covers bounded Codex model-client auth gating and usage telemetry.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";

import { CodexModelClient } from "../../src/models/codexModelClient";

test("CodexModelClient starts with subscription billing mode and zero spend", () => {
  const client = new CodexModelClient();
  const usage = client.getUsageSnapshot();
  assert.equal(usage.calls, 0);
  assert.equal(usage.billingMode, "subscription_quota");
  assert.equal(usage.estimatedSpendUsd, 0);
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
