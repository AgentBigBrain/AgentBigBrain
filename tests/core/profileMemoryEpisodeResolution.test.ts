/**
 * @fileoverview Focused tests for canonical episodic-memory resolution inference helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyProfileEpisodeCandidates,
  buildInferredProfileEpisodeResolutionCandidates,
  createEmptyProfileMemoryState
} from "../../src/core/profileMemory";

test("episode resolution inference resolves a matching named-person situation", () => {
  const seededState = applyProfileEpisodeCandidates(createEmptyProfileMemoryState(), [{
    title: "Billy fell down",
    summary: "Billy fell down three weeks ago and the outcome was never mentioned.",
    sourceTaskId: "task_profile_episode_resolution_1",
    source: "test",
    sourceKind: "explicit_user_statement",
    sensitive: false,
    observedAt: "2026-03-08T10:00:00.000Z",
    entityRefs: ["contact.billy"],
    tags: ["fall", "followup"]
  }]).nextState;

  const resolutions = buildInferredProfileEpisodeResolutionCandidates(
    seededState,
    "Billy is doing better now after the fall.",
    "task_profile_episode_resolution_2",
    "2026-03-08T12:00:00.000Z"
  );

  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0]?.status, "resolved");
  assert.equal(resolutions[0]?.source, "user_input_pattern.episode_resolution_inferred");
  assert.equal(resolutions[0]?.episodeId, seededState.episodes[0]?.id);
});

test("episode resolution inference fails closed when multiple same-entity episodes remain ambiguous", () => {
  const seededState = applyProfileEpisodeCandidates(createEmptyProfileMemoryState(), [
    {
      title: "Billy fell down",
      summary: "Billy fell down three weeks ago.",
      sourceTaskId: "task_profile_episode_resolution_3",
      source: "test",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-03-08T10:00:00.000Z",
      entityRefs: ["contact.billy"],
      tags: ["fall", "followup"]
    },
    {
      title: "Billy got sick",
      summary: "Billy got sick last month.",
      sourceTaskId: "task_profile_episode_resolution_4",
      source: "test",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-03-08T10:05:00.000Z",
      entityRefs: ["contact.billy"],
      tags: ["health", "followup"]
    }
  ]).nextState;

  const resolutions = buildInferredProfileEpisodeResolutionCandidates(
    seededState,
    "Billy is doing better now.",
    "task_profile_episode_resolution_5",
    "2026-03-08T12:00:00.000Z"
  );

  assert.deepEqual(resolutions, []);
});

test("episode resolution inference resolves the freshest duplicate when same-key episodes remain after persistence drift", () => {
  const seededState = applyProfileEpisodeCandidates(createEmptyProfileMemoryState(), [{
    title: "Billy fell down",
    summary: "Billy fell down three weeks ago.",
    sourceTaskId: "task_profile_episode_resolution_6",
    source: "test",
    sourceKind: "explicit_user_statement",
    sensitive: false,
    observedAt: "2026-03-08T10:00:00.000Z",
    entityRefs: ["contact.billy"],
    tags: ["fall", "followup"]
  }]).nextState;
  const driftedState = {
    ...seededState,
    episodes: [
      ...seededState.episodes,
      {
        ...seededState.episodes[0]!,
        id: "episode_duplicate_billy_fall",
        summary: "Billy fell down three weeks ago and the outcome was never mentioned.",
        lastMentionedAt: "2026-03-08T11:00:00.000Z",
        lastUpdatedAt: "2026-03-08T11:00:00.000Z"
      }
    ]
  };

  const resolutions = buildInferredProfileEpisodeResolutionCandidates(
    driftedState,
    "Billy is doing better now after the fall.",
    "task_profile_episode_resolution_7",
    "2026-03-08T12:00:00.000Z"
  );

  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0]?.episodeId, "episode_duplicate_billy_fall");
});
