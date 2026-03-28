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
  EntityGraphV1,
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
 * @returns Conversation stack containing an older paused Owen thread.
 */
function buildPausedOwenStack(): ConversationStackV1 {
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
        threadKey: "thread_owen",
        topicKey: "owen_fall",
        topicLabel: "Owen Fall",
        state: "paused",
        resumeHint: "Owen fell down a few weeks ago and you wanted to hear how that situation ended up.",
        openLoops: [
          {
            loopId: "loop_owen",
            threadKey: "thread_owen",
            entityRefs: ["owen"],
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
        topicKey: "owen_fall",
        label: "Owen Fall",
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

function buildEntityGraph(entities: EntityGraphV1["entities"]): EntityGraphV1 {
  return {
    schemaVersion: "v1",
    updatedAt: "2026-03-08T11:00:00.000Z",
    entities,
    edges: []
  };
}

test("resolveContextualRecallCandidate prefers a concrete unresolved episode over generic paused-topic overlap", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "Owen fell down a few weeks ago.",
        at: "2026-02-14T15:00:00.000Z"
      },
      {
        role: "assistant",
        text: "I hope Owen is okay.",
        at: "2026-02-14T15:01:00.000Z"
      },
      {
        role: "assistant",
        text: "The rollout can wait until after lunch.",
        at: "2026-03-08T10:50:00.000Z"
      }
    ],
    conversationStack: buildPausedOwenStack()
  });
  const queryContinuityEpisodes = buildEpisodeQuery(async (request) => {
    assert.ok(request.entityHints.includes("owen"));
    return [
      {
        episodeId: "episode_owen_fall",
        title: "Owen fell down",
        summary: "Owen fell down a few weeks ago and the outcome never got resolved.",
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
            priority: 0.8
          }
        ]
      }
    ];
  });

  const candidate = await resolveContextualRecallCandidate(
    session,
    "How is Owen doing lately?",
    queryContinuityEpisodes
  );

  assert.ok(candidate);
  assert.equal(candidate?.kind, "episode");
  assert.equal(candidate?.threadKey, "thread_owen");
  assert.equal(candidate?.topicLabel, "Owen fell down");
  assert.equal(candidate?.openLoopCount, 1);
  assert.equal(candidate?.episodeStatus, "unresolved");
  assert.match(candidate?.supportingCue ?? "", /Owen/i);
});

test("resolveContextualRecallCandidate allows strong direct overlap even when the recall phrasing is human and not canned", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: [
          "Owen had a rough fall a few weeks ago and it turned into a whole mess.",
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
    conversationStack: buildPausedOwenStack()
  });
  const queryContinuityEpisodes = buildEpisodeQuery(async ({ entityHints }) => {
    assert.ok(entityHints.includes("owen"));
    assert.ok(entityHints.includes("mri"));
    return [
      {
        episodeId: "episode_owen_mri",
        title: "Owen was waiting on MRI results",
        summary: "Owen had a rough fall, ended up in urgent care, and was waiting on MRI results.",
        status: "outcome_unknown",
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
            priority: 0.8
          }
        ]
      }
    ];
  });

  const candidate = await resolveContextualRecallCandidate(
    session,
    [
      "Owen came up again this morning when I was texting someone from home.",
      "It made me think about that whole MRI situation from a few weeks back, and I realized I still do not know how it ended up.",
      "I keep feeling like I missed the ending to that whole thing."
    ].join(" "),
    queryContinuityEpisodes
  );

  assert.ok(candidate);
  assert.equal(candidate?.kind, "episode");
  assert.match(candidate?.topicLabel ?? "", /Owen/i);
  assert.match(candidate?.topicLabel ?? "", /MRI/i);
});

test("buildContextualRecallBlock suppresses recall when no paused thread or concrete episode exists", async () => {
  const session = buildSession();
  const block = await buildContextualRecallBlock(
    session,
    "How is Owen doing lately?"
  );

  assert.equal(block, null);
});

test("resolveContextualRecallCandidate suppresses a bare repeated name when the current turn is clearly light and unrelated", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "Owen fell down a few weeks ago and it still feels unresolved.",
        at: "2026-02-14T15:00:00.000Z"
      },
      {
        role: "assistant",
        text: "If Owen comes up again in a related way, I can help you revisit that situation once.",
        at: "2026-02-14T15:01:00.000Z"
      }
    ],
    conversationStack: buildPausedOwenStack()
  });
  const queryContinuityEpisodes = buildEpisodeQuery(async ({ entityHints }) => {
    assert.ok(entityHints.includes("owen"));
    return [
      {
        episodeId: "episode_owen_fall",
        title: "Owen fell down",
        summary: "Owen fell down a few weeks ago and the outcome never got resolved.",
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
            priority: 0.8
          }
        ]
      }
    ];
  });

  const candidate = await resolveContextualRecallCandidate(
    session,
    [
      "Owen texted me this morning about a movie recommendation and a new coffee place near his office.",
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
        text: "Did Owen end up okay after the fall?",
        at: "2026-03-08T10:59:00.000Z"
      }
    ],
    conversationStack: buildPausedOwenStack()
  });
  const queryContinuityEpisodes = buildEpisodeQuery(async () => [
    {
      episodeId: "episode_owen_fall",
      title: "Owen fell down",
      summary: "Owen fell down a few weeks ago and the outcome never got resolved.",
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
          priority: 0.8
        }
      ]
    }
  ]);

  const block = await buildContextualRecallBlock(
    session,
    "How is Owen doing lately?",
    queryContinuityEpisodes
  );

  assert.equal(block, null);
});

test("buildContextualRecallBlock renders a bounded unresolved-situation recall block", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "Owen fell down a few weeks ago.",
        at: "2026-02-14T15:00:00.000Z"
      }
    ],
    conversationStack: buildPausedOwenStack()
  });
  const block = await buildContextualRecallBlock(
    session,
    "How is Owen doing lately?",
    buildEpisodeQuery(async () => [
      {
        episodeId: "episode_owen_fall",
        title: "Owen fell down",
        summary: "Owen fell down a few weeks ago and the outcome never got resolved.",
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
            priority: 0.8
          }
        ]
      }
    ])
  );

  assert.match(block ?? "", /older unresolved situation/i);
  assert.match(block ?? "", /Relevant situation: Owen fell down/);
  assert.match(block ?? "", /Situation status: unresolved/i);
  assert.match(block ?? "", /ask at most one brief follow-up/i);
});

test("resolveContextualRecallCandidate can use contextual-reference interpretation for vague recall wording", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "Owen had a rough fall and was waiting on MRI results.",
        at: "2026-02-14T15:00:00.000Z"
      },
      {
        role: "assistant",
        text: "I hope he heard back soon.",
        at: "2026-02-14T15:01:00.000Z"
      }
    ],
    conversationStack: buildPausedOwenStack()
  });
  let interpretationCalls = 0;

  const candidate = await resolveContextualRecallCandidate(
    session,
    "How is he?",
    undefined,
    null,
    async () => {
      interpretationCalls += 1;
      return {
        source: "local_intent_model",
        kind: "open_loop_resume_reference",
        entityHints: ["owen"],
        topicHints: ["mri"],
        confidence: "medium",
        explanation: "The user is referring back to Owen's unresolved MRI situation."
      };
    }
  );

  assert.equal(interpretationCalls, 1);
  assert.ok(candidate);
  assert.equal(candidate?.kind, "thread");
  assert.equal(candidate?.threadKey, "thread_owen");
  assert.match(candidate?.supportingCue ?? "", /Owen|MRI/i);
});

test("resolveContextualRecallCandidate promotes deterministic open-loop resume matching for interpreted resume references", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "We should circle back on Sarah's MRI once we hear something.",
        at: "2026-02-14T15:00:00.000Z"
      },
      {
        role: "assistant",
        text: "Okay, we can leave that unresolved for now and return to it later.",
        at: "2026-02-14T15:01:00.000Z"
      }
    ],
    conversationStack: {
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
          threadKey: "thread_family",
          topicKey: "family_follow_up",
          topicLabel: "Family Follow Up",
          state: "paused",
          resumeHint: "We should return to that family update later.",
          openLoops: [
            {
              loopId: "loop_sarah_mri",
              threadKey: "thread_family",
              entityRefs: ["sarah", "mri"],
              createdAt: "2026-02-14T15:00:00.000Z",
              lastMentionedAt: "2026-02-14T15:00:00.000Z",
              priority: 0.9,
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
          topicKey: "family_follow_up",
          label: "Family Follow Up",
          firstSeenAt: "2026-02-14T15:00:00.000Z",
          lastSeenAt: "2026-02-14T15:00:00.000Z",
          mentionCount: 2
        }
      ]
    }
  });

  const candidate = await resolveContextualRecallCandidate(
    session,
    "Can we go back to that MRI thing?",
    undefined,
    null,
    async () => ({
      source: "local_intent_model",
      kind: "open_loop_resume_reference",
      entityHints: ["sarah"],
      topicHints: ["mri"],
      confidence: "high",
      explanation: "The user is resuming Sarah's unresolved MRI follow-up."
    })
  );

  assert.ok(candidate);
  assert.equal(candidate?.kind, "thread");
  assert.equal(candidate?.threadKey, "thread_family");
  assert.equal(candidate?.matchSource, "open_loop_resume");
  assert.equal(candidate?.matchedOpenLoopId, "loop_sarah_mri");
  assert.deepEqual(candidate?.matchedHintTerms, ["mri", "sarah"]);
});

test("buildContextualRecallBlock includes model-assisted contextual evidence for vague recall turns", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "Owen had a rough fall and was waiting on MRI results.",
        at: "2026-02-14T15:00:00.000Z"
      }
    ],
    conversationStack: buildPausedOwenStack()
  });

  const block = await buildContextualRecallBlock(
    session,
    "How is he?",
    undefined,
    undefined,
    null,
    async () => ({
      source: "local_intent_model",
      kind: "contextual_recall_reference",
      entityHints: ["owen"],
      topicHints: ["mri"],
      confidence: "high",
      explanation: "The user is referring back to Owen's unresolved MRI situation."
    })
  );

  assert.match(block ?? "", /Model-assisted contextual hints: owen, mri/i);
  assert.match(block ?? "", /Model-assisted cue type: contextual_recall_reference/i);
});

test("buildContextualRecallBlock includes deterministic open-loop evidence for interpreted resume references", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "We should circle back on Sarah's MRI once we hear something.",
        at: "2026-02-14T15:00:00.000Z"
      }
    ],
    conversationStack: {
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
          threadKey: "thread_family",
          topicKey: "family_follow_up",
          topicLabel: "Family Follow Up",
          state: "paused",
          resumeHint: "We should return to that family update later.",
          openLoops: [
            {
              loopId: "loop_sarah_mri",
              threadKey: "thread_family",
              entityRefs: ["sarah", "mri"],
              createdAt: "2026-02-14T15:00:00.000Z",
              lastMentionedAt: "2026-02-14T15:00:00.000Z",
              priority: 0.9,
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
          topicKey: "family_follow_up",
          label: "Family Follow Up",
          firstSeenAt: "2026-02-14T15:00:00.000Z",
          lastSeenAt: "2026-02-14T15:00:00.000Z",
          mentionCount: 2
        }
      ]
    }
  });

  const block = await buildContextualRecallBlock(
    session,
    "Can we go back to that MRI thing?",
    undefined,
    undefined,
    null,
    async () => ({
      source: "local_intent_model",
      kind: "open_loop_resume_reference",
      entityHints: ["sarah"],
      topicHints: ["mri"],
      confidence: "high",
      explanation: "The user is resuming Sarah's unresolved MRI follow-up."
    })
  );

  assert.match(block ?? "", /Matched unresolved loop: loop_sarah_mri/i);
  assert.match(block ?? "", /Matched open-loop cues: mri, sarah/i);
  assert.match(block ?? "", /Model-assisted cue type: open_loop_resume_reference/i);
});

test("buildContextualRecallBlock does not invoke contextual-reference interpretation for obvious workflow turns", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "Owen had a rough fall and was waiting on MRI results.",
        at: "2026-02-14T15:00:00.000Z"
      }
    ],
    conversationStack: buildPausedOwenStack()
  });
  let interpretationCalls = 0;

  const block = await buildContextualRecallBlock(
    session,
    "Close the browser for the landing page.",
    undefined,
    undefined,
    null,
    async () => {
      interpretationCalls += 1;
      return {
        source: "local_intent_model",
        kind: "contextual_recall_reference",
        entityHints: ["owen"],
        topicHints: ["mri"],
        confidence: "high",
        explanation: "This should never be used."
      };
    }
  );

  assert.equal(interpretationCalls, 0);
  assert.equal(block, null);
});

test("resolveContextualRecallCandidate uses entity-reference interpretation to scope ambiguous recall to the selected entity", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "Sarah said the client meeting went badly, and Olivia was worried too.",
        at: "2026-03-08T10:40:00.000Z"
      },
      {
        role: "assistant",
        text: "If she comes up again later, I can help you check back on that situation.",
        at: "2026-03-08T10:41:00.000Z"
      }
    ]
  });
  const queryContinuityEpisodes = buildEpisodeQuery(async (request) => {
    assert.deepEqual(request.entityHints, ["sarah"]);
    return [
      {
        episodeId: "episode_sarah_client_meeting",
        title: "Sarah had a rough client meeting",
        summary: "Sarah left a difficult client meeting feeling discouraged, and the outcome stayed unresolved.",
        status: "unresolved",
        lastMentionedAt: "2026-03-08T10:40:00.000Z",
        entityRefs: ["Sarah"],
        entityLinks: [
          {
            entityKey: "entity_sarah",
            canonicalName: "Sarah"
          }
        ],
        openLoopLinks: []
      }
    ];
  });

  const candidate = await resolveContextualRecallCandidate(
    session,
    "How is she doing lately?",
    queryContinuityEpisodes,
    null,
    undefined,
    async () =>
      buildEntityGraph([
        {
          entityKey: "entity_sarah",
          canonicalName: "Sarah",
          entityType: "person",
          disambiguator: null,
          domainHint: "relationship",
          aliases: ["Sarah"],
          firstSeenAt: "2026-03-08T10:40:00.000Z",
          lastSeenAt: "2026-03-08T10:40:00.000Z",
          salience: 2,
          evidenceRefs: ["trace:sarah"]
        },
        {
          entityKey: "entity_olivia",
          canonicalName: "Olivia",
          entityType: "person",
          disambiguator: null,
          domainHint: "relationship",
          aliases: ["Olivia"],
          firstSeenAt: "2026-03-08T10:40:00.000Z",
          lastSeenAt: "2026-03-08T10:40:00.000Z",
          salience: 1,
          evidenceRefs: ["trace:olivia"]
        }
      ]),
    async (request) => {
      assert.equal(request.candidateEntities?.length, 2);
      assert.deepEqual(
        request.candidateEntities?.map((candidate) => candidate.entityKey).sort(),
        ["entity_olivia", "entity_sarah"]
      );
      return {
        source: "local_intent_model",
        kind: "entity_scoped_reference",
        selectedEntityKeys: ["entity_sarah"],
        aliasCandidate: null,
        confidence: "medium",
        explanation: "The vague pronoun most likely points back to Sarah."
      };
    }
  );

  assert.ok(candidate);
  assert.equal(candidate?.kind, "episode");
  assert.match(candidate?.topicLabel ?? "", /Sarah/i);
});

test("buildContextualRecallBlock includes model-assisted entity evidence when entity-reference scoping selected one entity", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "Sarah said the client meeting went badly, and Olivia was worried too.",
        at: "2026-03-08T10:40:00.000Z"
      }
    ]
  });
  const queryContinuityEpisodes = buildEpisodeQuery(async () => [
    {
      episodeId: "episode_sarah_client_meeting",
      title: "Sarah had a rough client meeting",
      summary: "Sarah left a difficult client meeting feeling discouraged, and the outcome stayed unresolved.",
      status: "unresolved",
      lastMentionedAt: "2026-03-08T10:40:00.000Z",
      entityRefs: ["Sarah"],
      entityLinks: [
        {
          entityKey: "entity_sarah",
          canonicalName: "Sarah"
        }
      ],
      openLoopLinks: []
    }
  ]);

  const block = await buildContextualRecallBlock(
    session,
    "How is she doing lately?",
    queryContinuityEpisodes,
    undefined,
    null,
    undefined,
    async () =>
      buildEntityGraph([
        {
          entityKey: "entity_sarah",
          canonicalName: "Sarah",
          entityType: "person",
          disambiguator: null,
          domainHint: "relationship",
          aliases: ["Sarah"],
          firstSeenAt: "2026-03-08T10:40:00.000Z",
          lastSeenAt: "2026-03-08T10:40:00.000Z",
          salience: 2,
          evidenceRefs: ["trace:sarah"]
        }
      ]),
    async () => ({
      source: "local_intent_model",
      kind: "entity_scoped_reference",
      selectedEntityKeys: ["entity_sarah"],
      aliasCandidate: null,
      confidence: "medium",
      explanation: "The vague pronoun most likely points back to Sarah."
    })
  );

  assert.match(block ?? "", /Model-assisted entity references: Sarah/);
  assert.match(block ?? "", /Model-assisted entity rationale: The vague pronoun most likely points back to Sarah\./);
});
