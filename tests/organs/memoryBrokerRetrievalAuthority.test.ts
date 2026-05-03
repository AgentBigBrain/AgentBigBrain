/**
 * @fileoverview Focused authority tests for brokered memory retrieval and context injection.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import type { TaskRequest } from "../../src/core/types";
import type { TemporalMemorySynthesis } from "../../src/core/profileMemoryRuntime/profileMemoryTemporalQueryContracts";
import { MemoryBrokerOrgan } from "../../src/organs/memoryBroker";

function buildTask(id: string, userInput: string): TaskRequest {
  return {
    id,
    goal: "Provide safe and helpful assistance.",
    userInput,
    createdAt: "2026-05-02T12:00:00.000Z"
  };
}

function wrapWithRouteMetadata(
  currentUserRequest: string,
  memoryIntent: "relationship_recall" | "contextual_recall" | "document_derived_recall" = "relationship_recall"
): string {
  return [
    "You are in an ongoing conversation with the same user.",
    "",
    "Resolved semantic route:",
    "- routeId: relationship_recall",
    "- executionMode: chat",
    "- continuationKind: relationship_memory",
    `- memoryIntent: ${memoryIntent}`,
    "- runtimeControlIntent: none",
    "- disallowBrowserOpen: false",
    "- disallowServerStart: false",
    "- requiresUserOwnedLocation: false",
    "",
    "Current user request:",
    currentUserRequest
  ].join("\n");
}

function buildTemporalSynthesis(): TemporalMemorySynthesis {
  return {
    currentState: ["Avery is tied to Sample Studio."],
    historicalContext: [],
    contradictionNotes: [],
    answerMode: "current",
    proof: {
      synthesisVersion: "v1",
      semanticMode: "relationship_inventory",
      relevanceScope: "global_profile",
      asOfValidTime: null,
      asOfObservedTime: "2026-05-02T12:00:00.000Z",
      focusStableRefIds: ["stable_contact_avery"],
      degradedNotes: []
    },
    laneMetadata: [{
      laneId: "stable_contact_avery:contact.work_association",
      focusStableRefId: "stable_contact_avery",
      family: "contact.work_association",
      answerMode: "current",
      dominantLane: "current_state",
      supportingLanes: [],
      chosenClaimId: "claim_avery_work",
      supportingObservationIds: [],
      rejectedClaims: [],
      lifecycleBuckets: {
        current: ["claim_avery_work"],
        historical: [],
        ended: [],
        overflowNote: null
      },
      degradedNotes: []
    }]
  };
}

class RetrievalAuthorityProfileStore {
  constructor(
    private readonly profileContext: string,
    private readonly temporalSynthesis: TemporalMemorySynthesis | null
  ) {}

  async ingestFromTaskInput(): Promise<{ appliedFacts: number; supersededFacts: number }> {
    return {
      appliedFacts: 0,
      supersededFacts: 0
    };
  }

  async openReadSession(): Promise<{
    getPlanningContext(): string;
    getEpisodePlanningContext(): string;
    queryFactsForPlanningContext(): readonly [];
    queryEpisodesForPlanningContext(): readonly [];
    queryTemporalPlanningSynthesis(): TemporalMemorySynthesis | null;
  }> {
    return {
      getPlanningContext: () => this.profileContext,
      getEpisodePlanningContext: () => "",
      queryFactsForPlanningContext: () => [],
      queryEpisodesForPlanningContext: () => [],
      queryTemporalPlanningSynthesis: () => this.temporalSynthesis
    };
  }
}

test("memory broker suppresses compatibility retrieval when route metadata is absent", async () => {
  const broker = new MemoryBrokerOrgan(
    new RetrievalAuthorityProfileStore(
      "contact.avery.name: Avery",
      null
    ) as unknown as ProfileMemoryStore
  );

  const enriched = await broker.buildPlannerInput(
    buildTask("task_retrieval_authority_absent_route", "Who is Avery?")
  );

  assert.equal(enriched.profileMemoryStatus, "available");
  assert.match(enriched.userInput, /\[AgentFriendMemoryBroker\]/);
  assert.match(enriched.userInput, /retrievalMode=compatibility_token_overlap/);
  assert.match(enriched.userInput, /sourceAuthority=legacy_compatibility/);
  assert.match(enriched.userInput, /plannerAuthority=none/);
  assert.match(enriched.userInput, /currentTruthAuthority=false/);
  assert.match(enriched.userInput, /domainBoundaryDecision=suppress_profile_context/);
  assert.match(enriched.userInput, /domainBoundaryReason=memory_retrieval_authority_blocked/);
  assert.doesNotMatch(enriched.userInput, /contact\.avery\.name/);
});

test("memory broker injects route-approved semantic retrieval with current-truth metadata", async () => {
  const broker = new MemoryBrokerOrgan(
    new RetrievalAuthorityProfileStore(
      "",
      buildTemporalSynthesis()
    ) as unknown as ProfileMemoryStore
  );

  const enriched = await broker.buildPlannerInput(
    buildTask(
      "task_retrieval_authority_semantic_route",
      wrapWithRouteMetadata("Who is Avery?")
    )
  );

  assert.equal(enriched.profileMemoryStatus, "available");
  assert.match(enriched.userInput, /\[AgentFriendMemoryBroker\]/);
  assert.match(enriched.userInput, /retrievalMode=semantic_entity_match/);
  assert.match(enriched.userInput, /sourceAuthority=semantic_model/);
  assert.match(enriched.userInput, /plannerAuthority=route_approved/);
  assert.match(enriched.userInput, /currentTruthAuthority=true/);
  assert.match(enriched.userInput, /domainBoundaryDecision=inject_profile_context/);
  assert.match(enriched.userInput, /Temporal memory context \(bounded\):/);
  assert.match(enriched.userInput, /Avery is tied to Sample Studio\./);
});

test("memory broker keeps route-approved compatibility retrieval evidence-only", async () => {
  const broker = new MemoryBrokerOrgan(
    new RetrievalAuthorityProfileStore(
      "contact.avery.name: Avery",
      null
    ) as unknown as ProfileMemoryStore
  );

  const enriched = await broker.buildPlannerInput(
    buildTask(
      "task_retrieval_authority_compat_route",
      wrapWithRouteMetadata("Who is Avery?")
    )
  );

  assert.equal(enriched.profileMemoryStatus, "available");
  assert.match(enriched.userInput, /retrievalMode=compatibility_token_overlap/);
  assert.match(enriched.userInput, /sourceAuthority=legacy_compatibility/);
  assert.match(enriched.userInput, /plannerAuthority=evidence_only/);
  assert.match(enriched.userInput, /currentTruthAuthority=false/);
  assert.match(enriched.userInput, /\[AgentFriendProfileContext\]/);
  assert.match(enriched.userInput, /contact\.avery\.name: Avery/);
});
