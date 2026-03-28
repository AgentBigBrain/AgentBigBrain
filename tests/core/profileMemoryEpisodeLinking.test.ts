/**
 * @fileoverview Tests deterministic episodic-memory linkage against Stage 6.86 continuity state.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createProfileEpisodeRecord
} from "../../src/core/profileMemory";
import {
  linkProfileEpisodeToContinuity
} from "../../src/core/profileMemoryRuntime/profileMemoryEpisodeLinking";
import {
  buildConversationStackFromTurnsV1
} from "../../src/core/stage6_86ConversationStack";
import {
  applyEntityExtractionToGraph,
  createEmptyEntityGraphV1,
  extractEntityCandidates
} from "../../src/core/stage6_86EntityGraph";
import {
  upsertOpenLoopOnConversationStackV1
} from "../../src/core/stage6_86OpenLoops";

test("linkProfileEpisodeToContinuity links one unresolved situation to matching entity and open loop", () => {
  const observedAt = "2026-03-08T10:00:00.000Z";
  const graph = applyEntityExtractionToGraph(
    createEmptyEntityGraphV1(observedAt),
    extractEntityCandidates({
      text: "Owen and Sarah talked after Owen fell down.",
      observedAt,
      evidenceRef: "trace:episode_linking_1"
    }),
    observedAt,
    "trace:episode_linking_1"
  ).graph;

  const seededStack = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Owen fell down a few weeks ago.",
        at: observedAt
      }
    ],
    observedAt
  );
  const threadKey = seededStack.activeThreadKey!;
  const stack = upsertOpenLoopOnConversationStackV1({
    stack: seededStack,
    threadKey,
    text: "Remind me later to ask how Owen is doing after the fall.",
    observedAt,
    entityRefs: ["Owen"]
  }).stack;

  const episode = createProfileEpisodeRecord({
    title: "Owen fell down",
    summary: "Owen fell down a few weeks ago and the outcome never came up.",
    sourceTaskId: "task_episode_linking_1",
    source: "test",
    sourceKind: "explicit_user_statement",
    sensitive: false,
    observedAt,
    entityRefs: ["contact.owen"],
    tags: ["followup", "injury"]
  });

  const linked = linkProfileEpisodeToContinuity(episode, graph, stack);
  assert.equal(linked.entityLinks.length > 0, true);
  assert.equal(linked.entityLinks.some((entry) => entry.canonicalName === "Owen"), true);
  assert.equal(linked.openLoopLinks.length > 0, true);
  assert.equal(linked.openLoopLinks[0]?.threadKey, threadKey);
});
