/**
 * @fileoverview Focused tests for canonical episodic-memory extraction helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { extractProfileEpisodeCandidatesFromUserInput } from "../../src/core/profileMemoryRuntime/profileMemoryEpisodeExtraction";

test("canonical episode extraction captures named-person situation candidates", () => {
  const candidates = extractProfileEpisodeCandidatesFromUserInput(
    "Owen fell down at the store three weeks ago and I never told you how it ended.",
    "task_profile_episode_extract_1",
    "2026-03-08T12:00:00.000Z"
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.title, "Owen fell down");
  assert.equal(
    candidates[0]?.summary,
    "Owen fell down at the store three weeks ago and I never told you how it ended"
  );
  assert.deepEqual(candidates[0]?.entityRefs, ["contact.owen"]);
  assert.equal(candidates[0]?.tags?.includes("fall"), true);
});

test("canonical episode extraction deduplicates equivalent sentences in one utterance", () => {
  const candidates = extractProfileEpisodeCandidatesFromUserInput(
    "Owen fell down. Owen fell down yesterday and it has been a mess.",
    "task_profile_episode_extract_2",
    "2026-03-08T12:00:00.000Z"
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.title, "Owen fell down");
});
