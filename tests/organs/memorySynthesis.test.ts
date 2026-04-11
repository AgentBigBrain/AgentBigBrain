/**
 * @fileoverview Covers bounded cross-memory synthesis helpers.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { TemporalMemorySynthesis } from "../../src/core/profileMemoryRuntime/profileMemoryTemporalQueryContracts";
import { buildPlannerContextSynthesisBlock } from "../../src/organs/memorySynthesis/plannerContextSynthesis";
import {
  buildRecallSynthesis,
  renderRecallSynthesisSupportLines
} from "../../src/organs/memorySynthesis/recallSynthesis";
import { buildTemporalMemorySynthesisFromCompatibilityRecords } from "../../src/organs/memorySynthesis/temporalSynthesisAdapter";
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
  const temporalSynthesis = buildTemporalMemorySynthesisFromCompatibilityRecords(
    [buildEpisode()],
    buildFacts()
  );
  assert.ok(temporalSynthesis);

  const synthesis = buildRecallSynthesis(temporalSynthesis!, [buildEpisode()], buildFacts());

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
  assert.deepEqual(renderRecallSynthesisSupportLines(synthesis), [
    "- Current State: contact.work_association: Lantern Studio; Owen fell down: Owen fell down a few weeks ago and the outcome is still unresolved.",
    "- Historical Context: none",
    "- Contradiction Notes: none"
  ]);
});

test("buildPlannerContextSynthesisBlock renders bounded historical-only temporal synthesis", () => {
  const temporalSynthesis = buildTemporalMemorySynthesisFromCompatibilityRecords(
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
  assert.ok(temporalSynthesis);

  const block = buildPlannerContextSynthesisBlock(temporalSynthesis);

  assert.match(block, /Temporal memory context \(bounded\):/i);
  assert.match(block, /Current State:\s*-\s*none/i);
  assert.match(block, /Historical Context:\s*-\s*Vague concern: Something may have happened at some point\./i);
  assert.match(block, /Contradiction Notes:\s*-\s*none/i);
});

test("buildPlannerContextSynthesisBlock renders a bounded temporal split view", () => {
  const temporalSynthesis = buildTemporalMemorySynthesisFromCompatibilityRecords(
    [buildEpisode()],
    buildFacts()
  );
  assert.ok(temporalSynthesis);

  const block = buildPlannerContextSynthesisBlock(temporalSynthesis!);

  assert.match(block, /Temporal memory context \(bounded\):/);
  assert.match(block, /Current State:/);
  assert.match(block, /Historical Context:/);
  assert.match(block, /Contradiction Notes:/);
  assert.match(block, /Lantern Studio/);
});

test("buildRecallSynthesis records shadow parity mismatch when temporal recall diverges from compatibility fallback", () => {
  const compatibilityTemporal = buildTemporalMemorySynthesisFromCompatibilityRecords(
    [buildEpisode()],
    buildFacts()
  );
  assert.ok(compatibilityTemporal);
  const divergentTemporal: TemporalMemorySynthesis = {
    ...compatibilityTemporal!,
    currentState: [],
    historicalContext: [],
    contradictionNotes: ["Need corroboration before surfacing this current relationship state."],
    answerMode: "insufficient_evidence",
    laneMetadata: compatibilityTemporal!.laneMetadata.map((lane) => ({
      ...lane,
      answerMode: "insufficient_evidence",
      dominantLane: "insufficient_evidence",
      supportingLanes: []
    }))
  };

  const synthesis = buildRecallSynthesis(
    divergentTemporal,
    [buildEpisode()],
    buildFacts()
  );

  assert.ok(synthesis?.shadowParity);
  assert.equal(synthesis?.shadowParity?.compared, true);
  assert.equal(synthesis?.shadowParity?.decisionMatches, false);
  assert.equal(synthesis?.shadowParity?.renderMatches, false);
  assert.deepEqual(
    synthesis?.shadowParity?.mismatchedFields,
    [
      "answer_mode",
      "current_state",
      "contradiction_notes",
      "lane_boundaries",
      "rendered_split_view"
    ]
  );
});

test("buildRecallSynthesis records shadow parity mismatch for quarantined identity fail-closed recall", () => {
  const compatibilityTemporal = buildTemporalMemorySynthesisFromCompatibilityRecords(
    [buildEpisode()],
    buildFacts()
  );
  assert.ok(compatibilityTemporal);
  const quarantinedTemporal: TemporalMemorySynthesis = {
    ...compatibilityTemporal!,
    currentState: [],
    historicalContext: [],
    contradictionNotes: ["I can't safely tell which Owen this refers to yet."],
    answerMode: "quarantined_identity",
    laneMetadata: compatibilityTemporal!.laneMetadata.map((lane) => ({
      ...lane,
      answerMode: "quarantined_identity",
      dominantLane: "quarantined_identity",
      supportingLanes: []
    }))
  };

  const synthesis = buildRecallSynthesis(
    quarantinedTemporal,
    [buildEpisode()],
    buildFacts()
  );

  assert.ok(synthesis?.shadowParity);
  assert.equal(synthesis?.shadowParity?.compared, true);
  assert.equal(synthesis?.shadowParity?.decisionMatches, false);
  assert.equal(synthesis?.shadowParity?.renderMatches, false);
  assert.deepEqual(
    synthesis?.shadowParity?.mismatchedFields,
    [
      "answer_mode",
      "current_state",
      "contradiction_notes",
      "lane_boundaries",
      "rendered_split_view"
    ]
  );
});
