/**
 * @fileoverview Tests structured runtime trace logging persistence and read behavior.
 */

import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RuntimeTraceLogger } from "../../src/core/runtimeTraceLogger";

test("runtime trace logger appends JSONL events with correlation and span fields", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-trace-"));
  const tracePath = path.join(tempDir, "runtime_trace.jsonl");
  const logger = new RuntimeTraceLogger({
    enabled: true,
    filePath: tracePath
  });

  try {
    const appended = await logger.appendEvent({
      eventType: "governance_voted",
      taskId: "task_trace_1",
      actionId: "action_trace_1",
      proposalId: "proposal_trace_1",
      mode: "escalation_path",
      durationMs: 17.3,
      details: {
        yesVotes: 7,
        noVotes: 0,
        approved: true
      }
    });

    assert.ok(appended);
    const events = await logger.readEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].taskId, "task_trace_1");
    assert.equal(events[0].actionId, "action_trace_1");
    assert.equal(events[0].proposalId, "proposal_trace_1");
    assert.equal(events[0].mode, "escalation_path");
    assert.equal(events[0].durationMs, 17);
    assert.equal(events[0].details?.approved, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime trace logger is no-op when disabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-trace-disabled-"));
  const tracePath = path.join(tempDir, "runtime_trace.jsonl");
  const logger = new RuntimeTraceLogger({
    enabled: false,
    filePath: tracePath
  });

  try {
    const appended = await logger.appendEvent({
      eventType: "task_started",
      taskId: "task_disabled"
    });
    assert.equal(appended, null);
    await assert.rejects(access(tracePath));
    const events = await logger.readEvents();
    assert.equal(events.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

