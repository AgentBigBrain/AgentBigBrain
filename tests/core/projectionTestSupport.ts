/**
 * @fileoverview Shared projection test fixtures for Obsidian mirror and projection-service coverage.
 */

import {
  createEmptyProfileMemoryState,
  createProfileEpisodeRecord,
  type ProfileMemoryState
} from "../../src/core/profileMemory";
import type { ProjectionSnapshot } from "../../src/core/projections/contracts";
import type {
  BridgeQuestionV1,
  ConversationStackV1,
  EntityGraphV1,
  GovernanceMemoryReadView
} from "../../src/core/types";
import type { Stage686PulseStateV1 } from "../../src/core/stage6_86/memoryGovernance";

const DEFAULT_NOW_ISO = "2026-04-12T12:00:00.000Z";

/**
 * Builds one deterministic Stage 6.86 conversation stack fixture.
 *
 * **Why it exists:**
 * Projection tests need a stable continuity fixture without repeating the same thread and topic
 * scaffolding in every test file.
 *
 * **What it talks to:**
 * - Uses Stage 6.86 continuity contracts from `../../src/core/types`.
 *
 * @param nowIso - Timestamp applied across the fixture.
 * @returns Deterministic conversation stack fixture.
 */
export function buildConversationStackFixture(nowIso = DEFAULT_NOW_ISO): ConversationStackV1 {
  return {
    schemaVersion: "v1",
    updatedAt: nowIso,
    activeThreadKey: "thread_detroit",
    threads: [
      {
        threadKey: "thread_detroit",
        topicKey: "topic_detroit",
        topicLabel: "Detroit work",
        state: "active",
        resumeHint: "Resume Detroit work.",
        openLoops: [
          {
            loopId: "loop_detroit_1",
            threadKey: "thread_detroit",
            entityRefs: ["entity_detroit"],
            createdAt: nowIso,
            lastMentionedAt: nowIso,
            priority: 0.82,
            status: "open"
          }
        ],
        lastTouchedAt: nowIso
      }
    ],
    topics: [
      {
        topicKey: "topic_detroit",
        label: "Detroit work",
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        mentionCount: 2
      }
    ]
  };
}

/**
 * Builds one deterministic Stage 6.86 pulse-state fixture.
 *
 * **Why it exists:**
 * Projection snapshots include pulse state even when tests focus on different collections, so a
 * shared helper keeps that required shape small and consistent.
 *
 * **What it talks to:**
 * - Uses `Stage686PulseStateV1` from `../../src/core/stage6_86/memoryGovernance`.
 *
 * @param nowIso - Timestamp applied across the fixture.
 * @returns Deterministic pulse-state fixture.
 */
export function buildPulseStateFixture(nowIso = DEFAULT_NOW_ISO): Stage686PulseStateV1 {
  return {
    schemaVersion: "v1",
    updatedAt: nowIso,
    lastPulseAt: null,
    emittedTodayCount: 0,
    bridgeHistory: []
  };
}

/**
 * Builds one deterministic pending bridge-question fixture list.
 *
 * **Why it exists:**
 * Dashboard and continuity rendering tests need at least one bridge question to prove the mirror
 * renders reviewable Stage 6.86 continuity detail.
 *
 * **What it talks to:**
 * - Uses `BridgeQuestionV1` from `../../src/core/types`.
 *
 * @param nowIso - Timestamp applied across the fixture.
 * @returns Deterministic pending bridge-question list.
 */
export function buildBridgeQuestionFixtures(nowIso = DEFAULT_NOW_ISO): readonly BridgeQuestionV1[] {
  return [
    {
      questionId: "bridge_detroit_follow_up",
      sourceEntityKey: "entity_detroit",
      targetEntityKey: "entity_owen",
      prompt: "Ask whether Owen still plans to come to Detroit.",
      createdAt: nowIso,
      cooldownUntil: nowIso,
      threadKey: "thread_detroit",
      evidenceRefs: ["trace:bridge_detroit_follow_up"],
      sourceAuthority: "stale_runtime_context",
      provenanceTier: "supporting",
      sensitive: false,
      activeMissionSuppressed: false
    }
  ];
}

/**
 * Builds one deterministic entity-graph fixture.
 *
 * **Why it exists:**
 * Entity notes and related-entity rendering need one canonical graph input that is small enough
 * for tests but still exercises the mirror's link logic.
 *
 * **What it talks to:**
 * - Uses `EntityGraphV1` from `../../src/core/types`.
 *
 * @param nowIso - Timestamp applied across the fixture.
 * @returns Deterministic entity-graph fixture.
 */
export function buildEntityGraphFixture(nowIso = DEFAULT_NOW_ISO): EntityGraphV1 {
  return {
    schemaVersion: "v1",
    updatedAt: nowIso,
    entities: [
      {
        entityKey: "entity_detroit",
        canonicalName: "Detroit",
        entityType: "place",
        disambiguator: null,
        domainHint: "workflow",
        aliases: ["Detroit"],
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        salience: 0.88,
        evidenceRefs: ["trace:entity_detroit"]
      },
      {
        entityKey: "entity_owen",
        canonicalName: "Owen",
        entityType: "person",
        disambiguator: null,
        domainHint: "relationship",
        aliases: ["Owen"],
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        salience: 0.92,
        evidenceRefs: ["trace:entity_owen"]
      }
    ],
    edges: [
      {
        edgeKey: "edge_detroit_owen",
        sourceEntityKey: "entity_detroit",
        targetEntityKey: "entity_owen",
        relationType: "co_mentioned",
        status: "confirmed",
        coMentionCount: 2,
        strength: 0.74,
        firstObservedAt: nowIso,
        lastObservedAt: nowIso,
        evidenceRefs: ["trace:edge_detroit_owen"]
      }
    ]
  };
}

/**
 * Builds one deterministic governance-memory read view fixture.
 *
 * **Why it exists:**
 * Projection snapshots always include governance read state, so tests need one shared helper for
 * that shape without dragging in the store implementation.
 *
 * **What it talks to:**
 * - Uses `GovernanceMemoryReadView` from `../../src/core/types`.
 *
 * @param nowIso - Timestamp applied across the fixture.
 * @returns Deterministic governance read-view fixture.
 */
export function buildGovernanceReadViewFixture(nowIso = DEFAULT_NOW_ISO): GovernanceMemoryReadView {
  return {
    generatedAt: nowIso,
    totalEvents: 0,
    recentEvents: [],
    recentBlockCounts: {
      constraints: 0,
      governance: 0,
      runtime: 0
    },
    recentGovernorRejectCounts: {}
  };
}

/**
 * Builds one deterministic profile-memory fixture with a single retained episode.
 *
 * **Why it exists:**
 * Episode rendering tests need one stable retained memory snapshot without depending on the full
 * ingestion pipeline to synthesize an episode.
 *
 * **What it talks to:**
 * - Uses profile-memory helpers from `../../src/core/profileMemory`.
 *
 * @param nowIso - Timestamp applied across the fixture.
 * @returns Deterministic profile-memory state with one episode.
 */
export function buildProfileMemoryFixture(nowIso = DEFAULT_NOW_ISO): ProfileMemoryState {
  const state = createEmptyProfileMemoryState();
  return {
    ...state,
    updatedAt: nowIso,
    episodes: [
      createProfileEpisodeRecord({
        title: "Detroit follow-up",
        summary: "Owen still needs to confirm the Detroit follow-up.",
        sourceTaskId: "task_projection_episode",
        source: "test.seed",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        confidence: 0.9,
        observedAt: nowIso,
        entityRefs: ["entity_detroit", "entity_owen"],
        openLoopRefs: ["loop_detroit_1"],
        tags: ["followup", "detroit"]
      })
    ]
  };
}

/**
 * Builds one deterministic projection snapshot fixture.
 *
 * **Why it exists:**
 * Projection tests need a small but complete snapshot that exercises dashboard, continuity,
 * entities, episodes, and media rendering without booting the whole runtime.
 *
 * **What it talks to:**
 * - Uses local fixture helpers within this module.
 *
 * @param overrides - Partial snapshot overrides for test-specific cases.
 * @returns Deterministic projection snapshot.
 */
export function buildProjectionSnapshotFixture(
  overrides: Partial<ProjectionSnapshot> = {}
): ProjectionSnapshot {
  const nowIso = overrides.generatedAt ?? DEFAULT_NOW_ISO;
  const conversationStack = buildConversationStackFixture(nowIso);
  return {
    generatedAt: nowIso,
    mode: "review_safe",
    profileMemory: buildProfileMemoryFixture(nowIso),
    currentSurfaceClaims: [],
    resolvedCurrentClaims: [],
    runtimeState: {
      updatedAt: nowIso,
      conversationStack,
      pulseState: buildPulseStateFixture(nowIso),
      pendingBridgeQuestions: buildBridgeQuestionFixtures(nowIso),
      lastMemoryMutationReceiptHash: null
    },
    entityGraph: buildEntityGraphFixture(nowIso),
    governanceReadView: buildGovernanceReadViewFixture(nowIso),
    executionReceipts: [],
    workflowPatterns: [],
    mediaArtifacts: [],
    skillProjectionEntries: [],
    ...overrides
  };
}
