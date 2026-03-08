/**
 * @fileoverview Covers bounded in-conversation contextual recall helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildContextualRecallBlock,
  resolveContextualRecallCandidate
} from "../../src/interfaces/conversationRuntime/contextualRecall";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import type { QueryConversationContinuityEpisodes } from "../../src/interfaces/conversationRuntime/managerContracts";
import type {
  ConversationStackV1
} from "../../src/core/types";
import type {
  ConversationSession
} from "../../src/interfaces/sessionStore";

/**
 * Creates a stable session fixture for contextual-recall tests.
 *
 * @param overrides - Optional session overrides.
 * @returns Fresh seeded conversation session.
 */
function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-contextual-recall",
      userId: "user-1",
      username: "owner",
      conversationVisibility: "private",
      receivedAt: "2026-03-08T11:00:00.000Z"
    }),
    ...overrides
  };
}

/**
 * Builds one paused-thread stack fixture.
 *
 * @returns Conversation stack containing an older paused Billy thread.
 */
function buildPausedBillyStack(): ConversationStackV1 {
  return {
    schemaVersion: "v1",
    updatedAt: "2026-03-08T11:00:00.000Z",
    activeThreadKey: "thread_current",
    threads: [
      {
        threadKey: "thread_current",
        topicKey: "release_rollout",
        topicLabel: "Release Rollout",
        state: "active",
        resumeHint: "Need to finish the rollout.",
        openLoops: [],
        lastTouchedAt: "2026-03-08T10:55:00.000Z"
      },
      {
        threadKey: "thread_billy",
        topicKey: "billy_fall",
        topicLabel: "Billy Fall",
        state: "paused",
        resumeHint: "Billy fell down a few weeks ago and you wanted to hear how that situation ended up.",
        openLoops: [
          {
            loopId: "loop_billy",
            threadKey: "thread_billy",
            entityRefs: ["billy"],
            createdAt: "2026-02-14T15:00:00.000Z",
            lastMentionedAt: "2026-02-14T15:00:00.000Z",
            priority: 0.8,
            status: "open"
          }
        ],
        lastTouchedAt: "2026-02-14T15:00:00.000Z"
      }
    ],
    topics: [
      {
        topicKey: "release_rollout",
        label: "Release Rollout",
        firstSeenAt: "2026-03-08T10:40:00.000Z",
        lastSeenAt: "2026-03-08T10:55:00.000Z",
        mentionCount: 3
      },
      {
        topicKey: "billy_fall",
        label: "Billy Fall",
        firstSeenAt: "2026-02-14T15:00:00.000Z",
        lastSeenAt: "2026-02-14T15:00:00.000Z",
        mentionCount: 2
      }
    ]
  };
}

function buildEpisodeQuery(
  implementation: QueryConversationContinuityEpisodes
): QueryConversationContinuityEpisodes {
  return implementation;
}

test("resolveContextualRecallCandidate prefers a concrete unresolved episode over generic paused-topic overlap", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "Billy fell down a few weeks ago.",
        at: "2026-02-14T15:00:00.000Z"
      },
      {
        role: "assistant",
        text: "I hope Billy is okay.",
        at: "2026-02-14T15:01:00.000Z"
      },
      {
        role: "assistant",
        text: "The rollout can wait until after lunch.",
        at: "2026-03-08T10:50:00.000Z"
      }
    ],
    conversationStack: buildPausedBillyStack()
  });
  const queryContinuityEpisodes = buildEpisodeQuery(async (request) => {
    assert.ok(request.entityHints.includes("billy"));
    return [
      {
        episodeId: "episode_billy_fall",
        title: "Billy fell down",
        summary: "Billy fell down a few weeks ago and the outcome never got resolved.",
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
            priority: 0.8
          }
        ]
      }
    ];
  });

  const candidate = await resolveContextualRecallCandidate(
    session,
    "How is Billy doing lately?",
    queryContinuityEpisodes
  );

  assert.ok(candidate);
  assert.equal(candidate?.kind, "episode");
  assert.equal(candidate?.threadKey, "thread_billy");
  assert.equal(candidate?.topicLabel, "Billy fell down");
  assert.equal(candidate?.openLoopCount, 1);
  assert.equal(candidate?.episodeStatus, "unresolved");
  assert.match(candidate?.supportingCue ?? "", /Billy/i);
});

test("resolveContextualRecallCandidate allows strong direct overlap even when the recall phrasing is human and not canned", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: [
          "Billy had a rough fall a few weeks ago and it turned into a whole mess.",
          "He ended up in urgent care, and the doctor wanted him to get an MRI because the swelling was not going down.",
          "I never really heard how it all turned out, and I still feel like that situation is hanging open."
        ].join(" "),
        at: "2026-02-14T15:00:00.000Z"
      },
      {
        role: "assistant",
        text: [
          "That sounds exhausting, especially if the outcome stayed blurry.",
          "We can leave it there for now and come back to it later if it matters again."
        ].join(" "),
        at: "2026-02-14T15:01:00.000Z"
      }
    ],
    conversationStack: buildPausedBillyStack()
  });
  const queryContinuityEpisodes = buildEpisodeQuery(async ({ entityHints }) => {
    assert.ok(entityHints.includes("billy"));
    assert.ok(entityHints.includes("mri"));
    return [
      {
        episodeId: "episode_billy_mri",
        title: "Billy was waiting on MRI results",
        summary: "Billy had a rough fall, ended up in urgent care, and was waiting on MRI results.",
        status: "outcome_unknown",
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
            priority: 0.8
          }
        ]
      }
    ];
  });

  const candidate = await resolveContextualRecallCandidate(
    session,
    [
      "Billy came up again this morning when I was texting someone from home.",
      "It made me think about that whole MRI situation from a few weeks back, and I realized I still do not know how it ended up.",
      "I keep feeling like I missed the ending to that whole thing."
    ].join(" "),
    queryContinuityEpisodes
  );

  assert.ok(candidate);
  assert.equal(candidate?.kind, "episode");
  assert.match(candidate?.topicLabel ?? "", /Billy/i);
  assert.match(candidate?.topicLabel ?? "", /MRI/i);
});

test("buildContextualRecallBlock suppresses recall when no paused thread or concrete episode exists", async () => {
  const session = buildSession();
  const block = await buildContextualRecallBlock(
    session,
    "How is Billy doing lately?"
  );

  assert.equal(block, null);
});

test("resolveContextualRecallCandidate suppresses a bare repeated name when the current turn is clearly light and unrelated", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "Billy fell down a few weeks ago and it still feels unresolved.",
        at: "2026-02-14T15:00:00.000Z"
      },
      {
        role: "assistant",
        text: "If Billy comes up again in a related way, I can help you revisit that situation once.",
        at: "2026-02-14T15:01:00.000Z"
      }
    ],
    conversationStack: buildPausedBillyStack()
  });
  const queryContinuityEpisodes = buildEpisodeQuery(async ({ entityHints }) => {
    assert.ok(entityHints.includes("billy"));
    return [
      {
        episodeId: "episode_billy_fall",
        title: "Billy fell down",
        summary: "Billy fell down a few weeks ago and the outcome never got resolved.",
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
            priority: 0.8
          }
        ]
      }
    ];
  });

  const candidate = await resolveContextualRecallCandidate(
    session,
    [
      "Billy texted me this morning about a movie recommendation and a new coffee place near his office.",
      "We mostly joked around and traded music suggestions for a few minutes.",
      "There was nothing serious in the conversation at all.",
      "I just wanted to tell you something light for once."
    ].join(" "),
    queryContinuityEpisodes
  );

  assert.equal(candidate, null);
});

test("buildContextualRecallBlock suppresses recall when the assistant already asked that follow-up recently", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "assistant",
        text: "Did Billy end up okay after the fall?",
        at: "2026-03-08T10:59:00.000Z"
      }
    ],
    conversationStack: buildPausedBillyStack()
  });
  const queryContinuityEpisodes = buildEpisodeQuery(async () => [
    {
      episodeId: "episode_billy_fall",
      title: "Billy fell down",
      summary: "Billy fell down a few weeks ago and the outcome never got resolved.",
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
          priority: 0.8
        }
      ]
    }
  ]);

  const block = await buildContextualRecallBlock(
    session,
    "How is Billy doing lately?",
    queryContinuityEpisodes
  );

  assert.equal(block, null);
});

test("buildContextualRecallBlock renders a bounded unresolved-situation recall block", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "Billy fell down a few weeks ago.",
        at: "2026-02-14T15:00:00.000Z"
      }
    ],
    conversationStack: buildPausedBillyStack()
  });
  const block = await buildContextualRecallBlock(
    session,
    "How is Billy doing lately?",
    buildEpisodeQuery(async () => [
      {
        episodeId: "episode_billy_fall",
        title: "Billy fell down",
        summary: "Billy fell down a few weeks ago and the outcome never got resolved.",
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
            priority: 0.8
          }
        ]
      }
    ])
  );

  assert.match(block ?? "", /older unresolved situation/i);
  assert.match(block ?? "", /Relevant situation: Billy fell down/);
  assert.match(block ?? "", /Situation status: unresolved/i);
  assert.match(block ?? "", /ask at most one brief follow-up/i);
});
