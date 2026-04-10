/**
 * @fileoverview Tests approval-aware episode reads and continuity-aware episodic-memory queries.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createEmptyProfileMemoryState,
  createProfileEpisodeRecord
} from "../../src/core/profileMemory";
import {
  queryProfileEpisodesForContinuity,
  readProfileEpisodes
} from "../../src/core/profileMemoryRuntime/profileMemoryEpisodeQueries";
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

test("readProfileEpisodes hides sensitive episodes without explicit approval", () => {
  const state = {
    ...createEmptyProfileMemoryState(),
    episodes: [
      createProfileEpisodeRecord({
        title: "Owen fell down",
        summary: "Owen fell down and the outcome was unresolved.",
        sourceTaskId: "task_episode_query_read_1",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-03-08T10:00:00.000Z"
      }),
      createProfileEpisodeRecord({
        title: "Private family health situation",
        summary: "A private health situation came up.",
        sourceTaskId: "task_episode_query_read_2",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: true,
        observedAt: "2026-03-08T11:00:00.000Z"
      })
    ]
  };

  const readable = readProfileEpisodes(state, {
    purpose: "operator_view",
    includeSensitive: true,
    explicitHumanApproval: false
  });

  assert.equal(readable.length, 1);
  assert.equal(readable[0]?.title, "Owen fell down");
});

test("queryProfileEpisodesForContinuity returns unresolved linked episode for re-mentioned entity hint", () => {
  const observedAt = "2026-03-08T10:00:00.000Z";
  const state = {
    ...createEmptyProfileMemoryState(),
    episodes: [
      createProfileEpisodeRecord({
        title: "Owen fell down",
        summary: "Owen fell down a few weeks ago and the outcome was never mentioned.",
        sourceTaskId: "task_episode_query_continuity_1",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt,
        entityRefs: ["contact.owen"],
        tags: ["followup", "injury"]
      }),
      createProfileEpisodeRecord({
        title: "Owen changed jobs",
        summary: "Owen changed jobs months ago and the outcome was never revisited.",
        sourceTaskId: "task_episode_query_continuity_2",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2025-10-01T10:00:00.000Z",
        lastMentionedAt: "2025-10-01T10:00:00.000Z",
        entityRefs: ["contact.owen"],
        tags: ["followup", "work"]
      })
    ]
  };

  const graph = applyEntityExtractionToGraph(
    createEmptyEntityGraphV1(observedAt),
    extractEntityCandidates({
      text: "Owen asked Sarah for help after the fall.",
      observedAt,
      evidenceRef: "trace:episode_query_continuity_1"
    }),
    observedAt,
    "trace:episode_query_continuity_1"
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
  const stack = upsertOpenLoopOnConversationStackV1({
    stack: seededStack,
    threadKey: seededStack.activeThreadKey!,
    text: "Remind me later to ask how Owen is doing after the fall.",
    observedAt,
    entityRefs: ["Owen"]
  }).stack;

  const matches = queryProfileEpisodesForContinuity(state, graph, stack, {
    entityHints: ["Owen"],
    maxEpisodes: 2
  }, "2026-03-08T10:00:00.000Z", 90);

  assert.equal(matches.length, 2);
  assert.equal(matches[0]?.episode.title, "Owen fell down");
  assert.equal(matches[1]?.episode.title, "Owen changed jobs");
  assert.equal(matches[0]?.entityLinks.some((entry) => entry.canonicalName === "Owen"), true);
  assert.equal(matches[0]?.openLoopLinks.length, 1);
});

test("queryProfileEpisodesForContinuity returns a bounded transfer event for buyer and object follow-up wording", () => {
  const observedAt = "2026-04-09T19:05:00.000Z";
  const state = {
    ...createEmptyProfileMemoryState(),
    episodes: [
      createProfileEpisodeRecord({
        title: "Milo sold Jordan the gray Accord",
        summary: "Milo sold Jordan the gray Accord in late 2024.",
        sourceTaskId: "task_episode_query_transfer_1",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt,
        entityRefs: ["contact.milo", "contact.jordan", "gray Accord"],
        tags: ["followup", "transaction", "transfer"]
      })
    ]
  };

  const graph = applyEntityExtractionToGraph(
    createEmptyEntityGraphV1(observedAt),
    extractEntityCandidates({
      text: "Milo sold Jordan the gray Accord in late 2024.",
      observedAt,
      evidenceRef: "trace:episode_query_transfer_1"
    }),
    observedAt,
    "trace:episode_query_transfer_1"
  ).graph;

  const stack = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Who bought the gray Accord?",
        at: observedAt
      }
    ],
    observedAt
  );

  const matches = queryProfileEpisodesForContinuity(
    state,
    graph,
    stack,
    {
      entityHints: ["bought", "gray", "accord"],
      semanticMode: "event_history",
      relevanceScope: "conversation_local",
      maxEpisodes: 1
    },
    observedAt,
    90
  );

  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.episode.title, "Milo sold Jordan the gray Accord");
  assert.deepEqual(
    matches[0]?.entityLinks.map((entry) => entry.canonicalName).sort(),
    ["Accord", "Jordan", "Milo"]
  );
});

test("queryProfileEpisodesForContinuity fails closed when the requested participant role has no matching event evidence", () => {
  const observedAt = "2026-04-09T19:05:00.000Z";
  const state = {
    ...createEmptyProfileMemoryState(),
    episodes: [
      createProfileEpisodeRecord({
        title: "Milo sold Jordan the gray Accord",
        summary: "Milo sold Jordan the gray Accord in late 2024.",
        sourceTaskId: "task_episode_query_transfer_2",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt,
        entityRefs: ["contact.milo", "contact.jordan", "gray Accord"],
        tags: ["followup", "transaction", "transfer"]
      })
    ]
  };

  const graph = applyEntityExtractionToGraph(
    createEmptyEntityGraphV1(observedAt),
    extractEntityCandidates({
      text: "Milo sold Jordan the gray Accord in late 2024.",
      observedAt,
      evidenceRef: "trace:episode_query_transfer_2"
    }),
    observedAt,
    "trace:episode_query_transfer_2"
  ).graph;

  const stack = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Who handled the paperwork?",
        at: observedAt
      }
    ],
    observedAt
  );

  const matches = queryProfileEpisodesForContinuity(
    state,
    graph,
    stack,
    {
      entityHints: ["handled", "paperwork"],
      semanticMode: "event_history",
      relevanceScope: "conversation_local",
      maxEpisodes: 1
    },
    observedAt,
    90
  );

  assert.deepEqual(matches, []);
});

test("readProfileEpisodes sorts fresh unresolved situations ahead of stale terminal ones", () => {
  const state = {
    ...createEmptyProfileMemoryState(),
    episodes: [
      createProfileEpisodeRecord({
        title: "Owen finished rehab",
        summary: "Owen finished rehab and fully recovered.",
        sourceTaskId: "task_episode_query_read_sort_1",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-03-05T10:00:00.000Z",
        lastMentionedAt: "2026-03-05T10:00:00.000Z",
        status: "resolved",
        resolvedAt: "2026-03-05T12:00:00.000Z",
        entityRefs: ["contact.owen"]
      }),
      createProfileEpisodeRecord({
        title: "Owen fell down",
        summary: "Owen fell down and the outcome is unresolved.",
        sourceTaskId: "task_episode_query_read_sort_2",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-03-07T10:00:00.000Z",
        lastMentionedAt: "2026-03-07T10:00:00.000Z",
        entityRefs: ["contact.owen"]
      })
    ]
  };

  const readable = readProfileEpisodes(
    state,
    {
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_episode_query_sort_1"
    },
    "2026-03-08T10:00:00.000Z",
    90
  );

  assert.equal(readable[0]?.title, "Owen fell down");
  assert.equal(readable[1]?.title, "Owen finished rehab");
});

test("queryProfileEpisodesForContinuity uses thread-local scope to prefer the active-thread episode when the current turn is vague", () => {
  const observedAt = "2026-04-09T18:00:00.000Z";
  const state = {
    ...createEmptyProfileMemoryState(),
    episodes: [
      createProfileEpisodeRecord({
        title: "Milo client delivery follow-up",
        summary: "Milo needed a follow-up after the Northstar Creative delivery slipped.",
        sourceTaskId: "task_episode_query_scope_milo",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt,
        entityRefs: ["contact.milo"],
        tags: ["followup", "northstar"]
      }),
      createProfileEpisodeRecord({
        title: "Nora client delivery follow-up",
        summary: "Nora needed a follow-up after the Riverpoint Labs delivery slipped.",
        sourceTaskId: "task_episode_query_scope_nora",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-04-09T17:59:00.000Z",
        entityRefs: ["contact.nora"],
        tags: ["followup", "riverpoint"]
      })
    ]
  };

  const graph = {
    schemaVersion: "v1",
    updatedAt: observedAt,
    entities: [
      {
        entityKey: "entity_milo",
        canonicalName: "Milo",
        entityType: "person",
        disambiguator: null,
        domainHint: "relationship",
        aliases: ["Milo"],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 2,
        evidenceRefs: ["trace:milo"]
      },
      {
        entityKey: "entity_nora",
        canonicalName: "Nora",
        entityType: "person",
        disambiguator: null,
        domainHint: "relationship",
        aliases: ["Nora"],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 1,
        evidenceRefs: ["trace:nora"]
      }
    ],
    edges: []
  } as const;

  const stack = {
    schemaVersion: "v1",
    updatedAt: observedAt,
    activeThreadKey: "thread_milo",
    threads: [
      {
        threadKey: "thread_milo",
        topicKey: "topic_milo",
        topicLabel: "Milo at Northstar Creative",
        state: "active",
        resumeHint: "You were talking about Milo and the delayed Northstar Creative delivery.",
        openLoops: [
          {
            loopId: "loop_milo",
            threadKey: "thread_milo",
            entityRefs: ["Milo", "Northstar Creative"],
            createdAt: observedAt,
            lastMentionedAt: observedAt,
            priority: 1,
            status: "open"
          }
        ],
        lastTouchedAt: observedAt
      },
      {
        threadKey: "thread_nora",
        topicKey: "topic_nora",
        topicLabel: "Nora at Riverpoint Labs",
        state: "paused",
        resumeHint: "You also discussed Nora and the Riverpoint Labs delivery.",
        openLoops: [
          {
            loopId: "loop_nora",
            threadKey: "thread_nora",
            entityRefs: ["Nora", "Riverpoint Labs"],
            createdAt: "2026-04-09T17:59:00.000Z",
            lastMentionedAt: "2026-04-09T17:59:00.000Z",
            priority: 1,
            status: "open"
          }
        ],
        lastTouchedAt: "2026-04-09T17:59:00.000Z"
      }
    ],
    topics: []
  } as const;

  const matches = queryProfileEpisodesForContinuity(
    state,
    graph,
    stack,
    {
      entityHints: [],
      relevanceScope: "thread_local",
      maxEpisodes: 2
    },
    observedAt,
    90
  );

  assert.equal(matches.length, 2);
  assert.equal(matches[0]?.episode.title, "Milo client delivery follow-up");
  assert.equal(
    matches[0]?.openLoopLinks.some((entry) => entry.threadKey === "thread_milo"),
    true
  );
  assert.equal(matches[1]?.episode.title, "Nora client delivery follow-up");
});
