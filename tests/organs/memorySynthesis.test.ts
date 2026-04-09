/**
 * @fileoverview Covers bounded cross-memory synthesis helpers.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildPlannerContextSynthesisBlock } from "../../src/organs/memorySynthesis/plannerContextSynthesis";
import { buildRecallSynthesis } from "../../src/organs/memorySynthesis/recallSynthesis";
import type {
  MemorySynthesisEpisodeRecord,
  MemorySynthesisFactRecord,
  TemporalMemorySynthesisDecisionRecord
} from "../../src/organs/memorySynthesis/contracts";

function buildEpisode(): MemorySynthesisEpisodeRecord {
  return {
    episodeId: "episode_owen_fall",
    title: "Owen fell down",
    summary: "Owen fell down a few weeks ago and the outcome is still unresolved.",
    status: "unresolved",
    lastMentionedAt: "2026-02-14T15:00:00.000Z",
    entityRefs: ["Owen"],
    entityLinks: [
      {
        entityKey: "entity_owen",
        canonicalName: "Owen"
      }
    ],
    openLoopLinks: [
      {
        loopId: "loop_owen",
        threadKey: "thread_owen",
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
      key: "contact.owen.work_association",
      value: "Lantern Studio",
      status: "confirmed",
      observedAt: "2026-02-10T12:00:00.000Z",
      lastUpdatedAt: "2026-02-10T12:00:00.000Z",
      confidence: 0.88,
      decisionRecord: {
        family: "contact.work_association",
        evidenceClass: "user_explicit_fact",
        governanceAction: "allow_current_state",
        governanceReason: "explicit_user_fact",
        disposition: "selected_current_state",
        answerModeFallback: "report_ambiguous_contested",
        candidateRefs: ["fact_work_association"],
        evidenceRefs: ["fact_work_association"],
        asOfObservedTime: "2026-02-14T15:00:00.000Z"
      } satisfies TemporalMemorySynthesisDecisionRecord
    }
  ];
}

test("buildRecallSynthesis returns one bounded supported hypothesis", () => {
  const synthesis = buildRecallSynthesis([buildEpisode()], buildFacts());

  assert.ok(synthesis);
  assert.equal(synthesis?.contractMode, "legacy_adapter_only");
  assert.equal(synthesis?.topicLabel, "Owen fell down");
  assert.match(synthesis?.summary ?? "", /Lantern Studio/i);
  assert.ok((synthesis?.evidence.length ?? 0) >= 3);
  assert.equal(synthesis?.decisionRecords?.length, 1);
  assert.equal(synthesis?.decisionRecords?.[0]?.family, "contact.work_association");
  assert.equal(
    synthesis?.decisionRecords?.[0]?.asOfObservedTime,
    "2026-02-14T15:00:00.000Z"
  );
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
