/**
 * @fileoverview Tests the legacy adapter from canonical temporal synthesis to bounded memory synthesis.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptTemporalMemorySynthesisToBoundedMemorySynthesis,
  buildLegacyCompatibleTemporalSynthesis,
  buildTemporalMemorySynthesisFromCompatibilityRecords
} from "../../src/organs/memorySynthesis/temporalSynthesisAdapter";
import type {
  MemorySynthesisEpisodeRecord,
  MemorySynthesisFactRecord,
  TemporalMemorySynthesisDecisionRecord
} from "../../src/organs/memorySynthesis/contracts";

function buildEpisode(): MemorySynthesisEpisodeRecord {
  return {
    episodeId: "episode_owen_followup",
    title: "Owen follow-up",
    summary: "Owen fell down and the outcome still matters.",
    status: "unresolved",
    lastMentionedAt: "2026-04-09T15:00:00.000Z",
    entityRefs: ["contact.owen"],
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
      factId: "fact_owen_work",
      key: "contact.owen.work_association",
      value: "Lantern Studio",
      status: "confirmed",
      observedAt: "2026-04-08T12:00:00.000Z",
      lastUpdatedAt: "2026-04-08T12:00:00.000Z",
      confidence: 0.91,
      decisionRecord: {
        family: "contact.work_association",
        evidenceClass: "user_explicit_fact",
        governanceAction: "allow_current_state",
        governanceReason: "explicit_user_fact",
        disposition: "selected_current_state",
        answerModeFallback: "report_ambiguous_contested",
        candidateRefs: ["fact_owen_work"],
        evidenceRefs: ["fact_owen_work"],
        asOfObservedTime: "2026-04-09T15:00:00.000Z"
      } satisfies TemporalMemorySynthesisDecisionRecord
    }
  ];
}

test("buildTemporalMemorySynthesisFromCompatibilityRecords produces canonical temporal output", () => {
  const temporal = buildTemporalMemorySynthesisFromCompatibilityRecords(
    [buildEpisode()],
    buildFacts()
  );

  assert.ok(temporal);
  assert.equal(temporal?.proof.synthesisVersion, "v1");
  assert.equal(temporal?.proof.relevanceScope, "global_profile");
  assert.match(temporal?.currentState.join("\n") ?? "", /Lantern Studio/);
});

test("adaptTemporalMemorySynthesisToBoundedMemorySynthesis preserves one-way compatibility output", () => {
  const temporal = buildTemporalMemorySynthesisFromCompatibilityRecords(
    [buildEpisode()],
    buildFacts()
  );
  assert.ok(temporal);

  const synthesis = adaptTemporalMemorySynthesisToBoundedMemorySynthesis(
    temporal!,
    [buildEpisode()],
    buildFacts()
  );

  assert.equal(synthesis.contractMode, "legacy_adapter_only");
  assert.equal(synthesis.temporalSynthesis.proof.synthesisVersion, "v1");
  assert.equal(synthesis.laneBoundaries.length > 0, true);
  assert.match(synthesis.summary, /Lantern Studio/);
});

test("buildLegacyCompatibleTemporalSynthesis returns null when support is empty", () => {
  const synthesis = buildLegacyCompatibleTemporalSynthesis([], []);
  assert.equal(synthesis, null);
});
