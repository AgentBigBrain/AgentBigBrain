/**
 * @fileoverview Focused tests for profile-memory write authority gates.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { governProfileMemoryCandidates } from "../../src/core/profileMemoryRuntime/profileMemoryTruthGovernance";
import {
  buildValidatedProfileFactCandidates,
  buildValidatedSemanticRelationshipFactCandidates,
  extractProfileFactCandidatesFromUserInput
} from "../../src/core/profileMemoryRuntime/profileMemoryExtraction";
import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import type {
  ProfileMemoryIngestPolicy,
  ProfileMemoryIngestRequest,
  ProfileMemoryWriteProvenance
} from "../../src/core/profileMemoryRuntime/contracts";
import { buildProfileMemoryIngestPolicy } from "../../src/core/profileMemoryRuntime/profileMemoryIngestPolicy";
import { buildConversationSessionFixture } from "../helpers/conversationFixtures";
import { buildDirectCasualConversationReply } from "../../src/interfaces/conversationRuntime/conversationRoutingDirectReplies";
import { MemoryAccessAuditStore } from "../../src/core/memoryAccessAudit";
import { MemoryBrokerOrgan } from "../../src/organs/memoryBroker";
import type { TaskRequest } from "../../src/core/types";

test("direct chat keeps lexical relationship wording off the durable memory write seam", async () => {
  const remembered: ProfileMemoryIngestRequest[] = [];
  const reply = await buildDirectCasualConversationReply({
    session: buildConversationSessionFixture(),
    input: "I work with Milo at Northstar Creative.",
    receivedAt: "2026-05-02T12:00:00.000Z",
    maxContextTurnsForExecution: 6,
    routingClassification: null,
    rememberConversationProfileInput: async (input) => {
      assert.notEqual(typeof input, "string");
      remembered.push(input as ProfileMemoryIngestRequest);
      return true;
    },
    media: null,
    semanticRoute: null,
    semanticHint: null,
    semanticRouteId: null,
    memoryAccessAuditStore: undefined,
    runDirectConversationTurn: async () => ({ summary: "Noted." })
  });

  assert.equal(reply, "Noted.");
  assert.equal(remembered.length, 0);
});

test("broker ingest without route-approved memory intent uses closed no-op policy", async () => {
  class CapturingStore {
    lastIngestPolicy: ProfileMemoryIngestPolicy | null = null;
    lastProvenance: ProfileMemoryWriteProvenance | null = null;

    async ingestFromTaskInput(
      _taskId: string,
      _userInput: string,
      _observedAt: string,
      options?: {
        ingestPolicy?: ProfileMemoryIngestPolicy;
        provenance?: ProfileMemoryWriteProvenance;
      }
    ): Promise<{ appliedFacts: number; supersededFacts: number }> {
      this.lastIngestPolicy = options?.ingestPolicy ?? null;
      this.lastProvenance = options?.provenance ?? null;
      return { appliedFacts: 0, supersededFacts: 0 };
    }

    async openReadSession(): Promise<{
      getPlanningContext(): string;
      getEpisodePlanningContext(): string;
      queryFactsForPlanningContext(): readonly [];
      queryEpisodesForPlanningContext(): readonly [];
    }> {
      return {
        getPlanningContext: () => "",
        getEpisodePlanningContext: () => "",
        queryFactsForPlanningContext: () => [],
        queryEpisodesForPlanningContext: () => []
      };
    }
  }

  const store = new CapturingStore();
  const broker = new MemoryBrokerOrgan(
    store as unknown as ProfileMemoryStore,
    new MemoryAccessAuditStore()
  );
  const task: TaskRequest = {
    id: "task_memory_authority_gate",
    goal: "Provide safe and helpful assistance.",
    userInput: "I work with Milo at Northstar Creative.",
    createdAt: "2026-05-02T12:00:00.000Z"
  };

  const result = await broker.buildPlannerInput(task);

  assert.equal(result.profileMemoryStatus, "available");
  assert.equal(store.lastIngestPolicy?.memoryIntent, "none");
  assert.equal(store.lastIngestPolicy?.fragmentPolicy, "ignore");
  assert.equal(store.lastProvenance?.sourceSurface, "broker_task_ingest");
});

test("lexical relationship candidates do not become current truth by governance alone", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "I work with Milo at Northstar Creative.",
    "task_lexical_relationship_candidate",
    "2026-05-02T12:00:00.000Z"
  );
  const result = governProfileMemoryCandidates({
    factCandidates: candidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    result.allowedCurrentStateFactCandidates.some((candidate) =>
      candidate.key === "contact.milo.relationship" ||
      candidate.key === "contact.milo.work_association"
    ),
    false
  );
  assert.equal(
    result.quarantinedFactCandidates.some((entry) =>
      entry.candidate.key === "contact.milo.relationship" ||
      entry.candidate.key === "contact.milo.work_association"
    ),
    true
  );
});

test("strict stores do not apply missing-policy relationship writes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-authority-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const store = new ProfileMemoryStore(profilePath, Buffer.alloc(32, 9), 90);

  try {
    const result = await store.ingestFromTaskInput(
      "task_strict_missing_policy",
      "I work with Milo at Northstar Creative.",
      "2026-05-02T12:00:00.000Z"
    );
    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.equal(result.appliedFacts, 0);
    assert.equal(facts.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("semantic relationship candidates require route-approved memory write authority", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-semantic-relationship-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const store = new ProfileMemoryStore(profilePath, Buffer.alloc(32, 7), 90);
  const observedAt = "2026-05-02T12:30:00.000Z";
  const validatedFactCandidates = buildValidatedSemanticRelationshipFactCandidates([
    {
      subject: "current_user",
      objectDisplayName: "Milo",
      relationLabel: "employee",
      lifecycle: "current",
      workAssociation: "Northstar Creative",
      sourceFamily: "semantic_model",
      ambiguity: "none",
      evidenceSpan: {
        text: "Milo helps me keep the studio operations moving at Northstar Creative.",
        startOffset: 0,
        endOffset: 68
      },
      confidence: 0.92
    }
  ]);

  try {
    const closedResult = await store.ingestFromTaskInput(
      "task_semantic_relationship_closed",
      "Milo helps me keep the studio operations moving at Northstar Creative.",
      observedAt,
      { validatedFactCandidates }
    );
    const closedFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.equal(closedResult.appliedFacts, 0);
    assert.equal(closedFacts.length, 0);

    const approvedResult = await store.ingestFromTaskInput(
      "task_semantic_relationship_approved",
      "Milo helps me keep the studio operations moving at Northstar Creative.",
      observedAt,
      {
        validatedFactCandidates,
        ingestPolicy: buildProfileMemoryIngestPolicy({
          memoryIntent: "profile_update",
          sourceSurface: "conversation_profile_input",
          hasValidatedFactCandidates: validatedFactCandidates.length > 0
        })
      }
    );
    const approvedFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.equal(approvedResult.appliedFacts, 3);
    assert.equal(
      approvedFacts.find((fact) => fact.key === "contact.milo.name")?.value,
      "Milo"
    );
    assert.equal(
      approvedFacts.find((fact) => fact.key === "contact.milo.relationship")?.value,
      "employee"
    );
    assert.equal(
      approvedFacts.find((fact) => fact.key === "contact.milo.work_association")?.value,
      "Northstar Creative"
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("semantic relationship lifecycle keeps historical and uncertain candidates out of current truth", () => {
  const observedAt = "2026-05-02T12:45:00.000Z";
  const historicalCandidates = buildValidatedProfileFactCandidates(
    buildValidatedSemanticRelationshipFactCandidates([
      {
        subject: "current_user",
        objectDisplayName: "Avery",
        relationLabel: "work_peer",
        lifecycle: "historical",
        workAssociation: "Northstar Creative",
        sourceFamily: "semantic_model",
        ambiguity: "none",
        evidenceSpan: {
          text: "Avery was part of my old studio team at Northstar Creative.",
          startOffset: 0,
          endOffset: 60
        },
        confidence: 0.9
      }
    ]),
    "task_semantic_relationship_historical",
    observedAt
  );
  const uncertainCandidates = buildValidatedProfileFactCandidates(
    buildValidatedSemanticRelationshipFactCandidates([
      {
        subject: "current_user",
        objectDisplayName: "Jordan",
        relationLabel: "colleague",
        lifecycle: "uncertain",
        sourceFamily: "semantic_model",
        ambiguity: "ambiguous_relation",
        evidenceSpan: {
          text: "Jordan might be connected to my work somehow.",
          startOffset: 0,
          endOffset: 45
        },
        confidence: 0.72
      }
    ]),
    "task_semantic_relationship_uncertain",
    observedAt
  );

  const historicalGovernance = governProfileMemoryCandidates({
    factCandidates: historicalCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });
  const uncertainGovernance = governProfileMemoryCandidates({
    factCandidates: uncertainCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    historicalGovernance.allowedCurrentStateFactCandidates.some((candidate) =>
      candidate.key === "contact.avery.relationship" ||
      candidate.key === "contact.avery.work_association"
    ),
    false
  );
  assert.equal(
    historicalGovernance.allowedSupportOnlyFactCandidates.some((candidate) =>
      candidate.key === "contact.avery.relationship" ||
      candidate.key === "contact.avery.work_association"
    ),
    true
  );
  assert.equal(
    uncertainGovernance.allowedCurrentStateFactCandidates.some((candidate) =>
      candidate.key === "contact.jordan.relationship"
    ),
    false
  );
  assert.equal(
    uncertainGovernance.quarantinedFactCandidates.some((entry) =>
      entry.candidate.key === "contact.jordan.relationship"
    ),
    true
  );
});
