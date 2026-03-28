/**
 * @fileoverview Tests episodic-memory state helpers behind the profile-memory runtime subsystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clampProfileEpisodeConfidence,
  createProfileEpisodeRecord,
  isTerminalProfileEpisodeStatus
} from "../../src/core/profileMemory";

test("clampProfileEpisodeConfidence bounds episodic confidence deterministically", () => {
  assert.equal(clampProfileEpisodeConfidence(undefined), 0.5);
  assert.equal(clampProfileEpisodeConfidence(-5), 0);
  assert.equal(clampProfileEpisodeConfidence(5), 1);
  assert.equal(clampProfileEpisodeConfidence(0.333333), 0.3333);
});

test("createProfileEpisodeRecord normalizes optional lists and timestamps", () => {
  const record = createProfileEpisodeRecord({
    title: "Owen fall situation",
    summary: "Owen fell down a few weeks ago and the outcome was not mentioned yet.",
    sourceTaskId: "task_episode_state_1",
    source: "test",
    sourceKind: "explicit_user_statement",
    sensitive: false,
    observedAt: "2026-03-08T12:00:00.000Z",
    confidence: 0.9,
    entityRefs: ["entity_owen", "entity_owen", " entity_owen ", "entity_park"],
    openLoopRefs: ["loop_2", "loop_1", "loop_1"],
    tags: ["followup", "injury", "followup"]
  });

  assert.match(record.id, /^episode_/);
  assert.equal(record.status, "unresolved");
  assert.deepEqual(record.entityRefs, ["entity_owen", "entity_park"]);
  assert.deepEqual(record.openLoopRefs, ["loop_1", "loop_2"]);
  assert.deepEqual(record.tags, ["followup", "injury"]);
  assert.equal(record.lastMentionedAt, "2026-03-08T12:00:00.000Z");
  assert.equal(record.lastUpdatedAt, "2026-03-08T12:00:00.000Z");
});

test("isTerminalProfileEpisodeStatus recognizes terminal episode states", () => {
  assert.equal(isTerminalProfileEpisodeStatus("resolved"), true);
  assert.equal(isTerminalProfileEpisodeStatus("no_longer_relevant"), true);
  assert.equal(isTerminalProfileEpisodeStatus("outcome_unknown"), false);
});
