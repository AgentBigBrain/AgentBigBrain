/**
 * @fileoverview Focused tests for canonical episodic-memory mutation helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyProfileEpisodeCandidates,
  applyProfileEpisodeResolutions
} from "../../src/core/profileMemory";
import { createEmptyProfileMemoryState } from "../../src/core/profileMemory";

test("applyProfileEpisodeCandidates creates and then updates one matching episode deterministically", () => {
  const baseState = createEmptyProfileMemoryState();
  const firstResult = applyProfileEpisodeCandidates(baseState, [{
    title: "Riley fell down",
    summary: "Riley fell down three weeks ago.",
    sourceTaskId: "task_profile_episode_mutation_1",
    source: "test",
    sourceKind: "explicit_user_statement",
    sensitive: false,
    observedAt: "2026-03-08T12:00:00.000Z",
    entityRefs: ["contact.riley"],
    tags: ["fall", "followup"]
  }]);

  assert.equal(firstResult.createdEpisodes, 1);
  assert.equal(firstResult.updatedEpisodes, 0);
  assert.equal(firstResult.nextState.episodes.length, 1);
  assert.deepEqual(firstResult.touchedEpisodeIds, [firstResult.nextState.episodes[0]!.id]);

  const secondResult = applyProfileEpisodeCandidates(firstResult.nextState, [{
    title: "Riley fell down",
    summary: "Riley fell down three weeks ago and I never heard how it ended.",
    sourceTaskId: "task_profile_episode_mutation_2",
    source: "test",
    sourceKind: "explicit_user_statement",
    sensitive: false,
    observedAt: "2026-03-08T12:05:00.000Z",
    entityRefs: ["contact.riley"],
    tags: ["fall", "followup"]
  }]);

  assert.equal(secondResult.createdEpisodes, 0);
  assert.equal(secondResult.updatedEpisodes, 1);
  assert.equal(secondResult.nextState.episodes.length, 1);
  assert.deepEqual(secondResult.touchedEpisodeIds, [firstResult.nextState.episodes[0]!.id]);
  assert.equal(
    secondResult.nextState.episodes[0]?.summary,
    "Riley fell down three weeks ago and I never heard how it ended."
  );
});

test("applyProfileEpisodeResolutions marks an existing episode resolved", () => {
  const seeded = applyProfileEpisodeCandidates(createEmptyProfileMemoryState(), [{
    title: "Riley fell down",
    summary: "Riley fell down three weeks ago.",
    sourceTaskId: "task_profile_episode_mutation_3",
    source: "test",
    sourceKind: "explicit_user_statement",
    sensitive: false,
    observedAt: "2026-03-08T12:00:00.000Z",
    entityRefs: ["contact.riley"],
    tags: ["fall", "followup"]
  }]).nextState;
  const episodeId = seeded.episodes[0]?.id;
  assert.ok(episodeId);

  const resolutionResult = applyProfileEpisodeResolutions(seeded, [{
    episodeId,
    status: "resolved",
    sourceTaskId: "task_profile_episode_mutation_4",
    source: "test",
    observedAt: "2026-03-08T12:10:00.000Z",
    summary: "Riley fell down: Riley is doing better now after the fall.",
    entityRefs: ["contact.riley"],
    tags: ["fall", "followup"]
  }]);

  assert.equal(resolutionResult.resolvedEpisodes, 1);
  assert.deepEqual(resolutionResult.touchedEpisodeIds, [episodeId]);
  assert.equal(resolutionResult.nextState.episodes[0]?.status, "resolved");
  assert.equal(resolutionResult.nextState.episodes[0]?.resolvedAt, "2026-03-08T12:10:00.000Z");
});
