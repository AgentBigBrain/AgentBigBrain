/**
 * @fileoverview Tests episodic-memory normalization helpers behind the profile-memory runtime subsystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeProfileMemoryEpisodes } from "../../src/core/profileMemory";

test("normalizeProfileMemoryEpisodes drops malformed episode payloads and normalizes valid ones", () => {
  const episodes = normalizeProfileMemoryEpisodes([
    {
      id: "episode_valid",
      title: "Owen fall situation",
      summary: "Owen fell down and the outcome is still unclear.",
      status: "outcome_unknown",
      sourceTaskId: "task_episode_normalization_1",
      source: "test",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      confidence: 1.2,
      observedAt: "2026-03-08T12:00:00.000Z",
      lastMentionedAt: "2026-03-08T12:15:00.000Z",
      lastUpdatedAt: "2026-03-08T12:15:00.000Z",
      resolvedAt: null,
      entityRefs: ["entity_owen", "entity_owen"],
      openLoopRefs: ["loop_owen", "loop_owen"],
      tags: ["injury", "injury", "followup"]
    },
    {
      id: 1,
      title: "bad"
    }
  ]);

  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]?.confidence, 1);
  assert.deepEqual(episodes[0]?.entityRefs, ["entity_owen"]);
  assert.deepEqual(episodes[0]?.openLoopRefs, ["loop_owen"]);
  assert.deepEqual(episodes[0]?.tags, ["followup", "injury"]);
});
