/**
 * @fileoverview Tests episodic-memory consolidation and lifecycle-priority helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assessProfileEpisodeFreshness,
  compareProfileEpisodesForLifecyclePriority,
  consolidateProfileEpisodes,
  createProfileEpisodeRecord
} from "../../src/core/profileMemory";

test("consolidateProfileEpisodes merges duplicate situations by entity/title key", () => {
  const olderEpisode = createProfileEpisodeRecord({
    title: "Billy fell down",
    summary: "Billy fell down near the stairs.",
    sourceTaskId: "task_episode_consolidation_1",
    source: "test",
    sourceKind: "explicit_user_statement",
    sensitive: false,
    observedAt: "2026-02-10T10:00:00.000Z",
    entityRefs: ["contact.billy"],
    openLoopRefs: ["loop_billy_old"],
    tags: ["injury"]
  });
  const newerEpisode = createProfileEpisodeRecord({
    title: "Billy fell down",
    summary: "Billy fell down near the stairs and the outcome was never mentioned.",
    sourceTaskId: "task_episode_consolidation_2",
    source: "test",
    sourceKind: "assistant_inference",
    sensitive: false,
    observedAt: "2026-02-12T10:00:00.000Z",
    lastMentionedAt: "2026-02-12T10:00:00.000Z",
    entityRefs: ["contact.billy"],
    openLoopRefs: ["loop_billy_new"],
    tags: ["followup", "injury"]
  });

  const result = consolidateProfileEpisodes([olderEpisode, newerEpisode]);

  assert.equal(result.consolidatedEpisodeCount, 1);
  assert.equal(result.episodes.length, 1);
  assert.equal(result.episodes[0]?.title, "Billy fell down");
  assert.match(result.episodes[0]?.summary ?? "", /outcome was never mentioned/i);
  assert.deepEqual(result.episodes[0]?.openLoopRefs, ["loop_billy_new", "loop_billy_old"]);
  assert.deepEqual(result.episodes[0]?.tags, ["followup", "injury"]);
});

test("episode freshness and lifecycle priority de-prioritize stale and terminal situations", () => {
  const freshUnresolved = createProfileEpisodeRecord({
    title: "Billy fell down",
    summary: "Billy fell down and the outcome is unresolved.",
    sourceTaskId: "task_episode_consolidation_3",
    source: "test",
    sourceKind: "explicit_user_statement",
    sensitive: false,
    observedAt: "2026-03-06T10:00:00.000Z",
    lastMentionedAt: "2026-03-06T10:00:00.000Z",
    entityRefs: ["contact.billy"]
  });
  const staleUnresolved = createProfileEpisodeRecord({
    title: "Billy changed jobs",
    summary: "Billy changed jobs and the outcome is unresolved.",
    sourceTaskId: "task_episode_consolidation_4",
    source: "test",
    sourceKind: "explicit_user_statement",
    sensitive: false,
    observedAt: "2025-10-01T10:00:00.000Z",
    lastMentionedAt: "2025-10-01T10:00:00.000Z",
    entityRefs: ["contact.billy"]
  });
  const resolvedEpisode = createProfileEpisodeRecord({
    title: "Billy finished rehab",
    summary: "Billy finished rehab and fully recovered.",
    sourceTaskId: "task_episode_consolidation_5",
    source: "test",
    sourceKind: "explicit_user_statement",
    sensitive: false,
    observedAt: "2026-03-05T10:00:00.000Z",
    lastMentionedAt: "2026-03-05T10:00:00.000Z",
    status: "resolved",
    resolvedAt: "2026-03-05T12:00:00.000Z",
    entityRefs: ["contact.billy"]
  });

  const freshness = assessProfileEpisodeFreshness(
    staleUnresolved,
    90,
    "2026-03-08T10:00:00.000Z"
  );
  assert.equal(freshness.stale, true);
  assert.ok(freshness.ageDays >= 90);

  const sorted = [resolvedEpisode, staleUnresolved, freshUnresolved].sort((left, right) =>
    compareProfileEpisodesForLifecyclePriority(
      left,
      right,
      90,
      "2026-03-08T10:00:00.000Z"
    )
  );

  assert.equal(sorted[0]?.title, "Billy fell down");
  assert.equal(sorted[1]?.title, "Billy changed jobs");
  assert.equal(sorted[2]?.title, "Billy finished rehab");
});
