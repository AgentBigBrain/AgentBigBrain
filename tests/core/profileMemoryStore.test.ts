/**
 * @fileoverview Tests encrypted profile-memory persistence, access controls, and env-based initialization behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createProfileEpisodeRecord,
  createEmptyProfileMemoryState,
  upsertTemporalProfileFact
} from "../../src/core/profileMemory";
import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import { saveProfileMemoryState } from "../../src/core/profileMemoryRuntime/profileMemoryPersistence";
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

/**
 * Implements `withProfileStore` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withProfileStore(
  callback: (store: ProfileMemoryStore, filePath: string) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-profile-"));
  const filePath = path.join(tempDir, "profile_memory.secure.json");
  const keyBase64 = Buffer.alloc(32, 7).toString("base64");
  const store = new ProfileMemoryStore(filePath, Buffer.from(keyBase64, "base64"), 90);

  try {
    await callback(store, filePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("profile memory persists encrypted content and omits plaintext values at rest", async () => {
  await withProfileStore(async (store, filePath) => {
    await store.ingestFromTaskInput(
      "task_profile_1",
      "my address is 123 Main Street and I work at Lantern",
      "2026-02-23T00:00:00.000Z"
    );

    const raw = await readFile(filePath, "utf8");
    assert.equal(raw.includes("123 Main Street"), false);
    assert.equal(raw.includes("employment.current"), false);
  });
});

test("readFacts hides sensitive fields unless explicit approval is present", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_2",
      "my address is 123 Main Street and my job is Lantern",
      "2026-02-23T00:00:00.000Z"
    );

    const withoutApproval = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: false
    });
    assert.equal(withoutApproval.some((fact) => fact.key.includes("address")), false);

    const withApproval = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_123"
    });
    const addressFact = withApproval.find((fact) => fact.key.includes("address"));
    assert.ok(addressFact);
    assert.equal(addressFact?.value, "123 Main Street");
  });
});

test("planning context excludes sensitive facts and includes active non-sensitive facts", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_3",
      "my address is 123 Main Street and my job is Lantern",
      "2026-02-23T00:00:00.000Z"
    );

    const planningContext = await store.getPlanningContext(6);
    assert.equal(planningContext.includes("employment.current"), true);
    assert.equal(planningContext.includes("address"), false);
    assert.equal(planningContext.includes("123 Main Street"), false);
  });
});

test("planning context is query-aware and surfaces matching contact facts", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_query_1",
      "my favorite editor is Helix and my name is Benny",
      "2026-02-24T00:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_query_2",
      "I used to work with Owen at Lantern Studio.",
      "2026-02-24T00:01:00.000Z"
    );

    const planningContext = await store.getPlanningContext(4, "who is Owen?");
    assert.equal(planningContext.includes("contact.owen.name: Owen"), true);
    assert.equal(
      planningContext.includes("contact.owen.work_association: Lantern Studio"),
      true
    );
  });
});

test("episode planning context is query-aware and surfaces matching unresolved situations", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_episode_context_1",
      "Owen fell down three weeks ago and I never told you how it ended.",
      "2026-03-08T10:00:00.000Z"
    );

    const episodePlanningContext = await store.getEpisodePlanningContext(
      2,
      "How is Owen doing after the fall?"
    );

    assert.match(episodePlanningContext, /Owen fell down/);
    assert.match(episodePlanningContext, /status=unresolved/);
  });
});

test("readEpisodes hides sensitive episodes unless explicit approval is present", async () => {
  await withProfileStore(async (store) => {
    const seededState = {
      ...createEmptyProfileMemoryState(),
      episodes: [
        createProfileEpisodeRecord({
          title: "Owen fell down",
          summary: "Owen fell down and the outcome was unresolved.",
          sourceTaskId: "task_profile_store_read_episode_1",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt: "2026-03-08T10:00:00.000Z"
        }),
        createProfileEpisodeRecord({
          title: "Private family health situation",
          summary: "A private health situation came up.",
          sourceTaskId: "task_profile_store_read_episode_2",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: true,
          observedAt: "2026-03-08T11:00:00.000Z"
        })
      ]
    };

    await (store as unknown as { save: (state: typeof seededState) => Promise<void> }).save(
      seededState
    );

    const withoutApproval = await store.readEpisodes({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: false
    });
    assert.equal(withoutApproval.length, 1);
    assert.equal(withoutApproval[0]?.title, "Owen fell down");

    const withApproval = await store.readEpisodes({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_episode_read_1"
    });
    assert.equal(withApproval.length, 2);
  });
});

test("queryEpisodesForContinuity returns linked unresolved episodes for re-mentioned entity hints", async () => {
  await withProfileStore(async (store, filePath) => {
    const observedAt = "2026-03-08T10:00:00.000Z";
    const seededState = {
      ...createEmptyProfileMemoryState(),
      episodes: [
        createProfileEpisodeRecord({
          title: "Owen fell down",
          summary: "Owen fell down a few weeks ago and the outcome was unresolved.",
          sourceTaskId: "task_profile_store_query_episode_1",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt,
          entityRefs: ["contact.owen"],
          tags: ["followup", "injury"]
        })
      ]
    };

    await saveProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const graph = applyEntityExtractionToGraph(
      createEmptyEntityGraphV1(observedAt),
      extractEntityCandidates({
        text: "Owen checked in after the fall.",
        observedAt,
        evidenceRef: "trace:store_query_episode_1"
      }),
      observedAt,
      "trace:store_query_episode_1"
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

    const matches = await store.queryEpisodesForContinuity(graph, stack, {
      entityHints: ["Owen"]
    });

    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.episode.title, "Owen fell down");
    assert.equal(matches[0]?.entityLinks.length > 0, true);
    assert.equal(matches[0]?.openLoopLinks.length > 0, true);
  });
});

test("profile memory store load preserves persisted episodic-memory state", async () => {
  await withProfileStore(async (store, filePath) => {
    const seededState = {
      ...createEmptyProfileMemoryState(),
      episodes: [
        createProfileEpisodeRecord({
          title: "Owen fall situation",
          summary: "Owen fell down a few weeks ago and the outcome was never mentioned.",
          sourceTaskId: "task_profile_store_episode_1",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt: "2026-03-08T10:00:00.000Z",
          entityRefs: ["entity_owen"],
          openLoopRefs: ["loop_owen"],
          tags: ["followup", "injury"]
        })
      ]
    };

    await saveProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const loaded = await store.load();
    assert.equal(loaded.episodes.length, 1);
    assert.equal(loaded.episodes[0]?.title, "Owen fall situation");
    assert.deepEqual(loaded.episodes[0]?.entityRefs, ["entity_owen"]);
  });
});

test("profile memory store load consolidates duplicate episodic-memory records", async () => {
  await withProfileStore(async (store, filePath) => {
    const seededState = {
      ...createEmptyProfileMemoryState(),
      episodes: [
        createProfileEpisodeRecord({
          title: "Owen fell down",
          summary: "Owen fell down near the stairs.",
          sourceTaskId: "task_profile_store_episode_consolidation_1",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt: "2026-03-01T10:00:00.000Z",
          entityRefs: ["contact.owen"],
          openLoopRefs: ["loop_old"],
          tags: ["injury"]
        }),
        createProfileEpisodeRecord({
          title: "Owen fell down",
          summary: "Owen fell down near the stairs and the outcome was unresolved.",
          sourceTaskId: "task_profile_store_episode_consolidation_2",
          source: "test",
          sourceKind: "assistant_inference",
          sensitive: false,
          observedAt: "2026-03-02T10:00:00.000Z",
          entityRefs: ["contact.owen"],
          openLoopRefs: ["loop_new"],
          tags: ["followup", "injury"]
        })
      ]
    };

    await saveProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const loaded = await store.load();
    assert.equal(loaded.episodes.length, 1);
    assert.match(loaded.episodes[0]?.summary ?? "", /outcome was unresolved/i);
    assert.deepEqual(loaded.episodes[0]?.openLoopRefs, ["loop_new", "loop_old"]);
  });
});

test("ingestFromTaskInput extracts and later resolves bounded episodic-memory situations", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_store_episode_ingest_1",
      "Owen fell down three weeks ago and I never told you how it ended.",
      "2026-03-08T10:00:00.000Z"
    );

    let state = await store.load();
    assert.equal(state.episodes.length, 1);
    assert.equal(state.episodes[0]?.title, "Owen fell down");
    assert.equal(state.episodes[0]?.status, "unresolved");

    await store.ingestFromTaskInput(
      "task_profile_store_episode_ingest_2",
      "Owen is doing better now after the fall.",
      "2026-03-08T12:00:00.000Z"
    );

    state = await store.load();
    assert.equal(state.episodes.length, 1);
    assert.equal(state.episodes[0]?.status, "resolved");
    assert.equal(state.episodes[0]?.resolvedAt, "2026-03-08T12:00:00.000Z");
  });
});

test("ingestFromTaskInput uses voice transcripts for durable fact and episode extraction", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_store_media_voice_1",
      [
        "Please fix this before lunch.",
        "",
        "Attached media context:",
        "- Voice note transcript: My name is Benny and Owen fell down last week."
      ].join("\n"),
      "2026-03-08T13:00:00.000Z"
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_profile_media_voice_1",
      maxFacts: 10
    });
    assert.equal(
      facts.some((fact) => fact.key === "identity.preferred_name" && fact.value === "Benny"),
      true
    );

    const episodes = await store.reviewEpisodesForUser(5, "2026-03-08T13:05:00.000Z");
    assert.equal(episodes.some((episode) => episode.title === "Owen fell down"), true);
  });
});

test("ingestFromTaskInput suppresses generic media-only prompts but still accepts interpreted situation summaries", async () => {
  await withProfileStore(async (store) => {
    const genericResult = await store.ingestFromTaskInput(
      "task_profile_store_media_generic_1",
      "Please review the attached image and respond based on what it shows.",
      "2026-03-08T14:00:00.000Z"
    );
    assert.deepEqual(genericResult, {
      appliedFacts: 0,
      supersededFacts: 0
    });

    await store.ingestFromTaskInput(
      "task_profile_store_media_summary_1",
      [
        "You did this wrong.",
        "",
        "Attached media context:",
        "- image summary: Owen fell down near the stairs and the outcome still sounds unresolved.",
        "- OCR text: Owen fell down near the stairs"
      ].join("\n"),
      "2026-03-08T14:10:00.000Z"
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_profile_media_summary_1",
      maxFacts: 10
    });
    assert.equal(facts.some((fact) => fact.key === "identity.preferred_name"), false);

    const episodes = await store.reviewEpisodesForUser(5, "2026-03-08T14:15:00.000Z");
    assert.equal(episodes.some((episode) => episode.title === "Owen fell down"), true);
  });
});

test("fromEnv returns undefined when profile memory is disabled", () => {
  const store = ProfileMemoryStore.fromEnv({});
  assert.equal(store, undefined);
});

test("fromEnv throws when enabled without encryption key", () => {
  assert.throws(
    () =>
      ProfileMemoryStore.fromEnv({
        BRAIN_PROFILE_MEMORY_ENABLED: "true"
      }),
    /BRAIN_PROFILE_ENCRYPTION_KEY/
  );
});

test("fromEnv initializes store when enabled with valid key", () => {
  const key = Buffer.alloc(32, 9).toString("base64");
  const store = ProfileMemoryStore.fromEnv({
    BRAIN_PROFILE_MEMORY_ENABLED: "true",
    BRAIN_PROFILE_ENCRYPTION_KEY: key
  });
  assert.ok(store);
});

test("evaluateAgentPulse allows stale-fact revalidation when stale facts exist", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_stale_1",
      "my favorite editor is vscode",
      "2025-01-10T00:00:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 60
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "stale_fact_revalidation",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.staleFactCount > 0, true);
    assert.equal(evaluation.decision.allowed, true);
    assert.equal(evaluation.decision.decisionCode, "ALLOWED");
  });
});

test("ingestFromTaskInput accepts validated identity candidates without requiring discourse-heavy raw extraction", async () => {
  await withProfileStore(async (store) => {
    const result = await store.ingestFromTaskInput(
      "task_profile_store_validated_identity_1",
      "I already told you my name is Avery several times.",
      "2026-03-21T12:00:00.000Z",
      {
        validatedFactCandidates: [
          {
            key: "identity.preferred_name",
            candidateValue: "Avery",
            source: "conversation.identity_interpretation",
            confidence: 0.95
          }
        ]
      }
    );

    assert.equal(result.appliedFacts, 1);

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_profile_validated_identity_1",
      maxFacts: 10
    });
    assert.equal(
      facts.some((fact) => fact.key === "identity.preferred_name" && fact.value === "Avery"),
      true
    );
  });
});

test("evaluateAgentPulse suppresses stale-fact revalidation for workflow-dominant sessions", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_stale_workflow_1",
      "my favorite editor is vscode",
      "2025-01-10T00:00:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "stale_fact_revalidation",
        lastPulseSentAtIso: null,
        sessionDominantLane: "workflow",
        sessionHasActiveWorkflowContinuity: true,
        overrideQuietHours: true
      }
    );

    assert.equal(evaluation.staleFactCount > 0, true);
    assert.equal(evaluation.decision.allowed, false);
    assert.equal(evaluation.decision.decisionCode, "SESSION_DOMAIN_SUPPRESSED");
  });
});

test("evaluateAgentPulse exposes bounded fresh unresolved situations for pulse grounding", async () => {
  await withProfileStore(async (store, filePath) => {
    const seededState = {
      ...createEmptyProfileMemoryState(),
      episodes: [
        createProfileEpisodeRecord({
          title: "Owen finished rehab",
          summary: "Owen finished rehab and fully recovered.",
          sourceTaskId: "task_profile_store_pulse_episode_1",
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
          sourceTaskId: "task_profile_store_pulse_episode_2",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt: "2026-03-07T10:00:00.000Z",
          lastMentionedAt: "2026-03-07T10:00:00.000Z",
          entityRefs: ["contact.owen"]
        })
      ]
    };

    await saveProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-03-08T10:00:00.000Z",
        userOptIn: true,
        reason: "contextual_followup",
        contextualLinkageConfidence: 0.9,
        lastPulseSentAtIso: null,
        overrideQuietHours: true
      }
    );

    assert.equal(evaluation.decision.allowed, true);
    assert.deepEqual(
      evaluation.relevantEpisodes.map((episode) => episode.title),
      ["Owen fell down"]
    );
  });
});

test("evaluateAgentPulse blocks stale-fact reason when no stale facts exist", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_stale_2",
      "my favorite editor is vscode",
      "2026-02-23T12:00:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 60
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "stale_fact_revalidation",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.staleFactCount, 0);
    assert.equal(evaluation.decision.allowed, false);
    assert.equal(evaluation.decision.decisionCode, "NO_STALE_FACTS");
  });
});

test("evaluateAgentPulse applies unresolved-commitment signal and deterministic rate limit", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_commitment_1",
      "my todo item is finish taxes",
      "2026-02-23T10:00:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 60
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: "2026-02-23T14:20:00.000Z"
      }
    );

    assert.equal(evaluation.unresolvedCommitmentCount, 1);
    assert.equal(evaluation.decision.allowed, false);
    assert.equal(evaluation.decision.decisionCode, "RATE_LIMIT");
    assert.equal(evaluation.decision.nextEligibleAtIso, "2026-02-23T15:20:00.000Z");
  });
});

test("evaluateAgentPulse treats noisy follow-up keys as unresolved commitments", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_commitment_noisy_key",
      "my followup'sda tax filing is pending.",
      "2026-02-23T10:00:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.unresolvedCommitmentCount > 0, true);
    assert.equal(evaluation.decision.allowed, true);
    assert.equal(evaluation.decision.decisionCode, "ALLOWED");
  });
});

test("evaluateAgentPulse exposes unresolved commitment topics for prompt grounding", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_commitment_topics",
      "my followup.tax filing is pending.",
      "2026-02-23T10:00:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.unresolvedCommitmentCount, 1);
    assert.equal(evaluation.unresolvedCommitmentTopics.includes("tax filing"), true);
  });
});

test("ingest resolves unresolved follow-up when completion update references same topic", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_commitment_topic_resolve_1",
      "my followup.tax filing is pending.",
      "2026-02-25T02:03:42.097Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_commitment_topic_resolve_2",
      "my tax filing is complete, I dont need help",
      "2026-02-25T02:04:24.081Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-25T03:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null,
        overrideQuietHours: true
      }
    );

    assert.equal(evaluation.unresolvedCommitmentCount, 0);
    assert.deepEqual(evaluation.unresolvedCommitmentTopics, []);

    const state = await store.load();
    const resolvedFollowup = state.facts
      .filter((fact) => fact.status !== "superseded")
      .find((fact) => fact.key === "followup.tax.filing");
    assert.ok(resolvedFollowup);
    assert.equal(resolvedFollowup?.value, "resolved");
    assert.ok(resolvedFollowup?.mutationAudit);
    assert.equal(
      resolvedFollowup?.mutationAudit?.rulepackVersion,
      "CommitmentSignalRulepackV1"
    );
    assert.equal(
      resolvedFollowup?.mutationAudit?.matchedRuleId ===
        "commitment_signal_v1_user_input_topic_resolution_candidate" ||
      resolvedFollowup?.mutationAudit?.matchedRuleId ===
        "commitment_signal_v1_user_input_generic_resolution",
      true
    );
    assert.equal(resolvedFollowup?.mutationAudit?.confidenceTier, "HIGH");
    assert.equal(resolvedFollowup?.mutationAudit?.conflict, false);
  });
});

test("ingest keeps unresolved follow-up when commitment text contains conflicting resolution and unresolved signals", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_conflict_1",
      "my followup.tax filing is pending.",
      "2026-02-25T02:03:42.097Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_conflict_2",
      "my tax filing is complete but still pending",
      "2026-02-25T02:04:24.081Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-25T03:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null,
        overrideQuietHours: true
      }
    );

    assert.equal(evaluation.unresolvedCommitmentCount, 1);
    assert.equal(evaluation.unresolvedCommitmentTopics.includes("tax filing"), true);
  });
});

test("load reconciles contradictory completion facts and unresolved follow-up facts", async () => {
  await withProfileStore(async (store) => {
    let seededState = createEmptyProfileMemoryState();
    seededState = upsertTemporalProfileFact(seededState, {
      key: "followup.tax.filing",
      value: "pending",
      sensitive: false,
      sourceTaskId: "seed_followup_pending",
      source: "test.seed",
      observedAt: "2026-02-25T02:03:42.097Z",
      confidence: 0.95
    }).nextState;
    seededState = upsertTemporalProfileFact(seededState, {
      key: "tax.filing",
      value: "complete",
      sensitive: false,
      sourceTaskId: "seed_topic_complete",
      source: "test.seed",
      observedAt: "2026-02-25T02:04:24.081Z",
      confidence: 0.95
    }).nextState;

    await (store as unknown as { save: (state: typeof seededState) => Promise<void> }).save(
      seededState
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-25T03:10:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null,
        overrideQuietHours: true
      }
    );
    assert.equal(evaluation.unresolvedCommitmentCount, 0);

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "test_approval",
      maxFacts: 20
    });
    const followupTax = facts.find((fact) => fact.key === "followup.tax.filing");
    assert.ok(followupTax);
    assert.equal(followupTax?.value, "resolved");

    const state = await store.load();
    const resolvedFollowup = state.facts
      .filter((fact) => fact.status !== "superseded")
      .find((fact) => fact.key === "followup.tax.filing");
    assert.ok(resolvedFollowup?.mutationAudit);
    assert.equal(
      resolvedFollowup?.mutationAudit?.matchedRuleId,
      "commitment_signal_v1_fact_value_resolved_marker"
    );
    assert.equal(
      resolvedFollowup?.mutationAudit?.rulepackVersion,
      "CommitmentSignalRulepackV1"
    );
  });
});

test("evaluateAgentPulse blocks check-ins during quiet hours unless overridden", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_commitment_2",
      "my todo item is finish taxes",
      "2026-02-23T10:00:00.000Z"
    );

    const blocked = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T23:30:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(blocked.decision.allowed, false);
    assert.equal(blocked.decision.decisionCode, "QUIET_HOURS");

    const overridden = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T23:30:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null,
        overrideQuietHours: true
      }
    );

    assert.equal(overridden.decision.allowed, true);
    assert.equal(overridden.decision.decisionCode, "ALLOWED");
  });
});

test("reviewEpisodesForUser and explicit user episode updates remain bounded and deterministic", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_store_user_review_1",
      "Owen fell down three weeks ago and I never told you how it ended.",
      "2026-03-08T10:00:00.000Z"
    );

    const reviewed = await store.reviewEpisodesForUser(
      5,
      "2026-03-08T10:05:00.000Z"
    );
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0]?.status, "unresolved");

    const resolved = await store.updateEpisodeFromUser(
      reviewed[0]!.episodeId,
      "resolved",
      "memory_resolve_1",
      "/memory resolve episode",
      "Owen recovered and is fine now.",
      "2026-03-08T11:00:00.000Z"
    );
    assert.equal(resolved?.status, "resolved");
    assert.equal(resolved?.resolvedAt, "2026-03-08T11:00:00.000Z");

    const forgotten = await store.forgetEpisodeFromUser(
      reviewed[0]!.episodeId,
      "memory_forget_1",
      "/memory forget episode",
      "2026-03-08T12:00:00.000Z"
    );
    assert.equal(forgotten?.episodeId, reviewed[0]?.episodeId);

    const afterForget = await store.reviewEpisodesForUser(
      5,
      "2026-03-08T12:10:00.000Z"
    );
    assert.equal(afterForget.length, 0);
  });
});

test("relationship-aware temporal nudging role taxonomy suppresses socially distant unresolved-commitment nudges", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_relationship_1",
      "my relationship role is acquaintance",
      "2026-02-23T10:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_relationship_2",
      "my todo item is finish taxes",
      "2026-02-23T10:05:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.relationship.role, "acquaintance");
    assert.equal(evaluation.decision.allowed, false);
    assert.equal(evaluation.decision.decisionCode, "RELATIONSHIP_ROLE_SUPPRESSED");
  });
});

test("relationship-aware temporal nudging context drift requires revalidation before allowed nudge", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_drift_1",
      "my manager is Jordan",
      "2026-02-23T08:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_drift_2",
      "my job is OldCo",
      "2026-02-23T08:30:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_drift_3",
      "my new job is NewCo",
      "2026-02-23T09:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_drift_4",
      "my todo item is finish taxes",
      "2026-02-23T09:10:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.relationship.role, "manager");
    assert.equal(evaluation.contextDrift.detected, true);
    assert.equal(evaluation.contextDrift.domains.includes("job"), true);
    assert.equal(evaluation.contextDrift.requiresRevalidation, true);
    assert.equal(evaluation.decision.allowed, true);
    assert.equal(evaluation.decision.decisionCode, "ALLOWED");
  });
});

test("relationship-aware temporal nudging role taxonomy updates behavior after context drift relationship changes", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_relationship_change_1",
      "my relationship role is acquaintance",
      "2026-02-23T10:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_relationship_change_2",
      "my todo item is finish taxes",
      "2026-02-23T10:05:00.000Z"
    );

    const first = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );
    assert.equal(first.decision.decisionCode, "RELATIONSHIP_ROLE_SUPPRESSED");

    await store.ingestFromTaskInput(
      "task_profile_relationship_change_3",
      "my relationship role is friend",
      "2026-02-23T10:10:00.000Z"
    );

    const second = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(second.relationship.role, "friend");
    assert.equal(second.decision.allowed, true);
    assert.equal(second.decision.decisionCode, "ALLOWED");
  });
});

