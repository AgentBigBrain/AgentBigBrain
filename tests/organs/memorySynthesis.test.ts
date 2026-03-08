/**
 * @fileoverview Covers bounded cross-memory synthesis helpers.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildPlannerContextSynthesisBlock } from "../../src/organs/memorySynthesis/plannerContextSynthesis";
import { buildRecallSynthesis } from "../../src/organs/memorySynthesis/recallSynthesis";
import type {
  MemorySynthesisEpisodeRecord,
  MemorySynthesisFactRecord
} from "../../src/organs/memorySynthesis/contracts";

function buildEpisode(): MemorySynthesisEpisodeRecord {
  return {
    episodeId: "episode_billy_fall",
    title: "Billy fell down",
    summary: "Billy fell down a few weeks ago and the outcome is still unresolved.",
    status: "unresolved",
    lastMentionedAt: "2026-02-14T15:00:00.000Z",
    entityRefs: ["Billy"],
    entityLinks: [
      {
        entityKey: "entity_billy",
        canonicalName: "Billy"
      }
    ],
    openLoopLinks: [
      {
        loopId: "loop_billy",
        threadKey: "thread_billy",
        status: "open",
        priority: 0.9
      }
    ]
  };
}

function buildFacts(): readonly MemorySynthesisFactRecord[] {
  return [
    {
      factId: "fact_work_association",
      key: "contact.billy.work_association",
      value: "Flare Web Design",
      status: "confirmed",
      observedAt: "2026-02-10T12:00:00.000Z",
      lastUpdatedAt: "2026-02-10T12:00:00.000Z",
      confidence: 0.88
    }
  ];
}

test("buildRecallSynthesis returns one bounded supported hypothesis", () => {
  const synthesis = buildRecallSynthesis([buildEpisode()], buildFacts());

  assert.ok(synthesis);
  assert.equal(synthesis?.topicLabel, "Billy fell down");
  assert.match(synthesis?.summary ?? "", /Flare Web Design/i);
  assert.ok((synthesis?.evidence.length ?? 0) >= 3);
});

test("buildPlannerContextSynthesisBlock suppresses weak unsupported synthesis", () => {
  const block = buildPlannerContextSynthesisBlock(
    [
      {
        episodeId: "episode_weak",
        title: "Vague concern",
        summary: "Something may have happened at some point.",
        status: "resolved",
        lastMentionedAt: "2026-02-14T15:00:00.000Z",
        entityRefs: [],
        entityLinks: [],
        openLoopLinks: []
      }
    ],
    []
  );

  assert.equal(block, "");
});

