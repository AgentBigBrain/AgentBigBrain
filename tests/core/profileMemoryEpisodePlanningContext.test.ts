/**
 * @fileoverview Tests bounded episodic-memory planning-context rendering.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildProfileEpisodePlanningContext,
  createEmptyProfileMemoryState,
  createProfileEpisodeRecord
} from "../../src/core/profileMemory";

test("buildProfileEpisodePlanningContext renders bounded unresolved situations for matching queries", () => {
  const state = {
    ...createEmptyProfileMemoryState(),
    episodes: [
      createProfileEpisodeRecord({
        title: "Owen fell down",
        summary: "Owen fell down a few weeks ago and the outcome was unresolved.",
        sourceTaskId: "task_episode_planning_1",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-03-08T10:00:00.000Z",
        entityRefs: ["contact.owen"],
        tags: ["injury", "followup"]
      }),
      createProfileEpisodeRecord({
        title: "Quarterly filing status",
        summary: "The quarterly filing was still pending.",
        sourceTaskId: "task_episode_planning_2",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-03-08T11:00:00.000Z",
        tags: ["work", "paperwork"]
      })
    ]
  };

  const context = buildProfileEpisodePlanningContext(
    state,
    2,
    "How is Owen doing after the fall?"
  );

  assert.match(context, /Owen fell down/);
  assert.match(context, /status=unresolved/);
  assert.doesNotMatch(context, /Quarterly filing status/);
});

test("buildProfileEpisodePlanningContext suppresses resolved and sensitive episodes", () => {
  const state = {
    ...createEmptyProfileMemoryState(),
    episodes: [
      createProfileEpisodeRecord({
        title: "Owen fell down",
        summary: "Owen fell down and later recovered fully.",
        sourceTaskId: "task_episode_planning_3",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-03-08T10:00:00.000Z",
        status: "resolved",
        resolvedAt: "2026-03-08T12:00:00.000Z",
        entityRefs: ["contact.owen"]
      }),
      createProfileEpisodeRecord({
        title: "Private family health situation",
        summary: "A private family health situation remained unresolved.",
        sourceTaskId: "task_episode_planning_4",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: true,
        observedAt: "2026-03-08T10:00:00.000Z",
        entityRefs: ["family"]
      })
    ]
  };

  const context = buildProfileEpisodePlanningContext(
    state,
    2,
    "How did that family situation end up?"
  );

  assert.equal(context, "");
});
