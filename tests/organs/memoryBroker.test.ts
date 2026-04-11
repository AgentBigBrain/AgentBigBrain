/**
 * @fileoverview Tests memory-broker extraction and planner-input enrichment behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MemoryAccessAuditStore } from "../../src/core/memoryAccessAudit";
import {
  createEmptyProfileMemoryState,
  upsertTemporalProfileFact
} from "../../src/core/profileMemory";
import { saveProfileMemoryState } from "../../src/core/profileMemoryRuntime/profileMemoryPersistence";
import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import { TaskRequest } from "../../src/core/types";
import type {
  ProfileFactPlanningInspectionResult,
  ProfileMemoryRequestTelemetry,
  ProfileMemoryWriteProvenance,
  ProfileReadableFact
} from "../../src/core/profileMemoryRuntime/contracts";
import type { ProfileMemoryQueryDecisionRecord } from "../../src/core/profileMemoryRuntime/profileMemoryDecisionRecordContracts";
import {
  buildConversationProfileMemoryTurnId,
  buildProfileMemorySourceFingerprint
} from "../../src/core/profileMemoryRuntime/profileMemoryIngestProvenance";
import { MockModelClient } from "../../src/models/mockModelClient";
import { LanguageUnderstandingOrgan } from "../../src/organs/languageUnderstanding/episodeExtraction";
import { extractCurrentUserRequest, MemoryBrokerOrgan } from "../../src/organs/memoryBroker";
import { assessBrokerPromptCutoverGate } from "../../src/organs/memoryBrokerPlannerInput";
import type { ConversationDomainContext } from "../../src/core/types";

/**
 * Implements `buildTask` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildTask(id: string, userInput: string): TaskRequest {
  return {
    id,
    goal: "Provide safe and helpful assistance.",
    userInput,
    createdAt: new Date().toISOString()
  };
}

function buildWorkflowDomainContext(): ConversationDomainContext {
  return {
    conversationId: "telegram:chat:user",
    dominantLane: "workflow",
    recentLaneHistory: [
      {
        lane: "workflow",
        observedAt: "2026-03-20T12:00:00.000Z",
        source: "routing_mode",
        weight: 2
      }
    ],
    recentRoutingSignals: [
      {
        mode: "build",
        observedAt: "2026-03-20T12:00:00.000Z"
      },
      {
        mode: "autonomous",
        observedAt: "2026-03-20T12:01:00.000Z"
      }
    ],
    continuitySignals: {
      activeWorkspace: true,
      returnHandoff: false,
      modeContinuity: true
    },
    activeSince: "2026-03-20T12:00:00.000Z",
    lastUpdatedAt: "2026-03-20T12:01:00.000Z"
  };
}

class CapturingBrokerIngestProfileStore {
  lastTaskId = "";
  lastUserInput = "";
  lastProvenance: ProfileMemoryWriteProvenance | null = null;

  async ingestFromTaskInput(
    taskId: string,
    userInput: string,
    _observedAt: string,
    options?: { provenance?: ProfileMemoryWriteProvenance }
  ): Promise<{ appliedFacts: number; supersededFacts: number }> {
    this.lastTaskId = taskId;
    this.lastUserInput = userInput;
    this.lastProvenance = options?.provenance ?? null;
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
  }> {
    return {
      getPlanningContext: () => "",
      getEpisodePlanningContext: () => "",
      queryFactsForPlanningContext: () => [],
      queryEpisodesForPlanningContext: () => []
    };
  }
}

class CountingProfileMemoryStore extends ProfileMemoryStore {
  loadCount = 0;

  override async load() {
    this.loadCount += 1;
    return super.load();
  }
}

class TemporalPlanningSynthesisProfileStore {
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
    queryTemporalPlanningSynthesis(): {
      currentState: readonly string[];
      historicalContext: readonly string[];
      contradictionNotes: readonly string[];
      answerMode: "current";
      proof: {
        synthesisVersion: "v1";
        semanticMode: "relationship_inventory";
        relevanceScope: "global_profile";
        asOfValidTime: null;
        asOfObservedTime: string;
        focusStableRefIds: readonly ["stable_contact_billy"];
        degradedNotes: readonly [];
      };
      laneMetadata: readonly [{
        laneId: "stable_contact_billy:contact.work_association";
        focusStableRefId: "stable_contact_billy";
        family: "contact.work_association";
        answerMode: "current";
        dominantLane: "current_state";
        supportingLanes: readonly [];
        chosenClaimId: "claim_billy_work";
        supportingObservationIds: readonly [];
        rejectedClaims: readonly [];
        lifecycleBuckets: {
          current: readonly ["claim_billy_work"];
          historical: readonly [];
          ended: readonly [];
          overflowNote: null;
        };
        degradedNotes: readonly [];
      }];
    };
  }> {
    return {
      getPlanningContext: () => "",
      getEpisodePlanningContext: () => "",
      queryFactsForPlanningContext: () => [],
      queryEpisodesForPlanningContext: () => [],
      queryTemporalPlanningSynthesis: () => ({
        currentState: ["Billy is tied to Flare Web Design."],
        historicalContext: [],
        contradictionNotes: [],
        answerMode: "current",
        proof: {
          synthesisVersion: "v1",
          semanticMode: "relationship_inventory",
          relevanceScope: "global_profile",
          asOfValidTime: null,
          asOfObservedTime: "2026-04-10T12:00:00.000Z",
          focusStableRefIds: ["stable_contact_billy"],
          degradedNotes: []
        },
        laneMetadata: [{
          laneId: "stable_contact_billy:contact.work_association",
          focusStableRefId: "stable_contact_billy",
          family: "contact.work_association",
          answerMode: "current",
          dominantLane: "current_state",
          supportingLanes: [],
          chosenClaimId: "claim_billy_work",
          supportingObservationIds: [],
          rejectedClaims: [],
          lifecycleBuckets: {
            current: ["claim_billy_work"],
            historical: [],
            ended: [],
            overflowNote: null
          },
          degradedNotes: []
        }]
      })
    };
  }
}

test("extractCurrentUserRequest parses wrapper payloads deterministically", () => {
  const wrapped = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: my favorite editor is Helix.",
    "",
    "Current user request:",
    "who is Owen?"
  ].join("\n");

  const extracted = extractCurrentUserRequest(wrapped);
  assert.equal(extracted, "who is Owen?");
});

test(
  "extractCurrentUserRequest avoids history leakage for scaffolded prompts without current-request marker",
  () => {
    const scaffolded = [
      "System-generated Agent Pulse check-in request.",
      "Return one concise proactive check-in message.",
      "",
      "Recent conversation context (oldest to newest):",
      "- user: Create skill stage6_live_gate for promotion control proof.",
      "- assistant: I couldn't complete that request because a safety policy blocked it."
    ].join("\n");

    const extracted = extractCurrentUserRequest(scaffolded);
    assert.equal(extracted, "System-generated Agent Pulse check-in request.");
  }
);

test(
  "extractCurrentUserRequest avoids profile-context leakage for Agent Friend broker packets without current-request marker",
  () => {
    const scaffolded = [
      "Research deterministic sandboxing controls and provide distilled findings with proof refs.",
      "",
      "[AgentFriendMemoryBroker]",
      "retrievalMode=query_aware",
      "domainLanes=workflow",
      "domainBoundaryDecision=inject_profile_context",
      "",
      "[AgentFriendProfileContext]",
      "contact.owen.note: run skill failures happened before."
    ].join("\n");

    const extracted = extractCurrentUserRequest(scaffolded);
    assert.equal(
      extracted,
      "Research deterministic sandboxing controls and provide distilled findings with proof refs."
    );
  }
);

test("memory broker prefers direct temporal planning synthesis over compatibility synthesis rebuilds", async () => {
  const broker = new MemoryBrokerOrgan(
    new TemporalPlanningSynthesisProfileStore() as unknown as ProfileMemoryStore
  );

  const enriched = await broker.buildPlannerInput(
    buildTask("task_memory_broker_temporal_direct", "Who is Billy?")
  );

  assert.equal(enriched.profileMemoryStatus, "available");
  assert.match(enriched.userInput, /\[AgentFriendProfileContext\]/);
  assert.match(enriched.userInput, /Temporal memory context \(bounded\):/i);
  assert.match(enriched.userInput, /Billy is tied to Flare Web Design\./);
  assert.match(enriched.userInput, /domainBoundaryDecision=inject_profile_context/i);
});

test("memory broker injects query-aware profile context with domain metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 42);
  const store = new ProfileMemoryStore(profilePath, key, 90);
  const broker = new MemoryBrokerOrgan(store);

  const narrativeTask = buildTask(
    "task_memory_broker_1",
    "I used to work with Owen at Lantern Studio."
  );
  const recallTask = buildTask(
    "task_memory_broker_2",
    [
      "You are in an ongoing conversation with the same user.",
      "Recent conversation context (oldest to newest):",
      "- user: I used to work with Owen at Lantern Studio.",
      "- assistant: thanks for sharing.",
      "",
      "Current user request:",
      "who is Owen?"
    ].join("\n")
  );

  try {
    await broker.buildPlannerInput(narrativeTask);
    const enriched = await broker.buildPlannerInput(recallTask);

    assert.equal(enriched.profileMemoryStatus, "available");
    assert.match(enriched.userInput, /\[AgentFriendMemoryBroker\]/);
    assert.match(enriched.userInput, /retrievalMode=query_aware/);
    assert.match(enriched.userInput, /domainLanes=.*relationship/i);
    assert.match(enriched.userInput, /domainBoundaryDecision=inject_profile_context/i);
    assert.match(enriched.userInput, /\[AgentFriendProfileContext\]/);
    assert.match(enriched.userInput, /contact\.owen\.name: Owen/i);
    assert.match(enriched.userInput, /contact\.owen\.context\.[a-f0-9]{8}: I used to work with Owen at Lantern Studio/i);
    assert.doesNotMatch(enriched.userInput, /contact\.owen\.work_association: Lantern Studio/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("memory broker scores typed relationship lane metadata without depending on rendered profile prefixes", async () => {
  const fact: ProfileReadableFact = {
    factId: "fact_relationship_lane",
    key: "contact.owen.work_association",
    value: "Lantern Studio",
    status: "confirmed",
    observedAt: "2026-04-09T10:00:00.000Z",
    lastUpdatedAt: "2026-04-09T10:00:00.000Z",
    confidence: 0.92,
    sensitive: false
  };
  const decisionRecord: ProfileMemoryQueryDecisionRecord = {
    family: "contact.work_association",
    evidenceClass: "user_explicit_fact",
    governanceAction: "allow_current_state",
    governanceReason: "explicit_user_fact",
    disposition: "selected_current_state",
    answerModeFallback: "report_ambiguous_contested",
    candidateRefs: ["fact_relationship_lane"],
    evidenceRefs: ["fact_relationship_lane"]
  };
  const store = {
    async ingestFromTaskInput() {
      return { appliedFacts: 0, supersededFacts: 0 };
    },
    async openReadSession() {
      return {
        getPlanningContext: () => "remember the person from earlier",
        getEpisodePlanningContext: () => "",
        queryFactsForPlanningContext: () => [fact],
        inspectFactsForPlanningContext: () =>
          ({
            entries: [{ fact, decisionRecord }],
            hiddenDecisionRecords: [],
            asOfObservedTime: undefined,
            asOfValidTime: undefined
          }) satisfies ProfileFactPlanningInspectionResult,
        queryEpisodesForPlanningContext: () => [],
        queryTemporalPlanningSynthesis: () => ({
          currentState: ["Owen is tied to Lantern Studio."],
          historicalContext: [],
          contradictionNotes: [],
          answerMode: "current",
          proof: {
            synthesisVersion: "v1",
            semanticMode: "relationship_inventory",
            relevanceScope: "global_profile",
            asOfValidTime: null,
            asOfObservedTime: "2026-04-09T10:00:00.000Z",
            focusStableRefIds: ["stable_contact_owen"],
            degradedNotes: []
          },
          laneMetadata: [{
            laneId: "stable_contact_owen:contact.work_association",
            focusStableRefId: "stable_contact_owen",
            family: "contact.work_association",
            answerMode: "current",
            dominantLane: "current_state",
            supportingLanes: [],
            chosenClaimId: "claim_owen_work",
            supportingObservationIds: [],
            rejectedClaims: [],
            lifecycleBuckets: {
              current: ["claim_owen_work"],
              historical: [],
              ended: [],
              overflowNote: null
            },
            degradedNotes: []
          }]
        })
      };
    }
  } as unknown as ProfileMemoryStore;
  const broker = new MemoryBrokerOrgan(store);

  const enriched = await broker.buildPlannerInput(
    buildTask("task_memory_broker_typed_lane", "who is Owen?")
  );

  assert.equal(enriched.profileMemoryStatus, "available");
  assert.match(enriched.userInput, /domainLanes=.*relationship/i);
  assert.match(enriched.userInput, /domainBoundaryDecision=inject_profile_context/i);
  assert.match(enriched.userInput, /\[AgentFriendProfileContext\]/);
  assert.match(enriched.userInput, /Current State:/i);
  assert.doesNotMatch(enriched.userInput, /\[AgentFriendMemorySynthesis\]/i);
});

test("memory broker keeps historical school association out of query-aware profile context", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-school-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 43);
  const store = new ProfileMemoryStore(profilePath, key, 90);
  const broker = new MemoryBrokerOrgan(store);

  const narrativeTask = buildTask(
    "task_memory_broker_school_1",
    "I went to school with a guy named Owen."
  );
  const recallTask = buildTask(
    "task_memory_broker_school_2",
    [
      "You are in an ongoing conversation with the same user.",
      "Recent conversation context (oldest to newest):",
      "- user: I went to school with a guy named Owen.",
      "- assistant: thanks for sharing.",
      "",
      "Current user request:",
      "who is Owen?"
    ].join("\n")
  );

  try {
    await broker.buildPlannerInput(narrativeTask);
    const enriched = await broker.buildPlannerInput(recallTask);

    assert.equal(enriched.profileMemoryStatus, "available");
    assert.match(enriched.userInput, /\[AgentFriendProfileContext\]/);
    assert.match(enriched.userInput, /Current State:/i);
    assert.match(enriched.userInput, /Historical Context:/i);
    assert.doesNotMatch(enriched.userInput, /contact\.owen\.school_association: went_to_school_together/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("memory broker suppresses profile context for workflow-dominant requests", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 24);
  const store = new ProfileMemoryStore(profilePath, key, 90);
  const broker = new MemoryBrokerOrgan(store);

  const profileTask = buildTask("task_memory_broker_profile", "My favorite editor is Helix.");
  const workflowTask = buildTask(
    "task_memory_broker_workflow",
    "Deploy the workspace repo and run build verification."
  );

  try {
    await broker.buildPlannerInput(profileTask);
    const enriched = await broker.buildPlannerInput(workflowTask);

    assert.equal(enriched.profileMemoryStatus, "available");
    assert.match(enriched.userInput, /domainLanes=.*workflow/i);
    assert.match(enriched.userInput, /domainBoundaryDecision=suppress_profile_context/i);
    assert.match(
      enriched.userInput,
      /domainBoundaryReason=(non_profile_dominant_request|no_profile_signal)/i
    );
    assert.match(enriched.userInput, /\[AgentFriendProfileContext\]\nsuppressed=true/i);
    assert.doesNotMatch(enriched.userInput, /identity\./i);
    assert.doesNotMatch(enriched.userInput, /contact\./i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("memory broker appends memory-access audit events with required fields", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const auditPath = path.join(tempDir, "memory_access_log.json");
  const key = Buffer.alloc(32, 81);
  const store = new ProfileMemoryStore(profilePath, key, 90);
  const auditStore = new MemoryAccessAuditStore(auditPath);
  const broker = new MemoryBrokerOrgan(store, auditStore);

  const narrativeTask = buildTask(
    "task_memory_audit_1",
    "I used to work with Owen at Lantern Studio."
  );
  const recallTask = buildTask("task_memory_audit_2", "who is Owen?");

  try {
    await broker.buildPlannerInput(narrativeTask);
    await broker.buildPlannerInput(recallTask);
    await broker.buildPlannerInput(recallTask);

    const raw = await readFile(auditPath, "utf8");
    const document = JSON.parse(raw) as {
      events: Array<{
        eventType: string;
        taskId: string;
        queryHash: string;
        storeLoadCount?: number;
        ingestOperationCount?: number;
        retrievalOperationCount?: number;
        synthesisOperationCount?: number;
        renderOperationCount?: number;
        promptMemoryOwnerCount?: number;
        promptMemorySurfaceCount?: number;
        mixedMemoryOwnerDecisionCount?: number;
        promptCutoverGateDecision?: string;
        promptCutoverGateReasons?: string[];
        retrievedCount: number;
        retrievedEpisodeCount: number;
        redactedCount: number;
        domainLanes: string[];
      }>;
    };

    assert.ok(Array.isArray(document.events));
    assert.ok(document.events.length >= 2);

    const lastEvent = document.events[document.events.length - 1];
    assert.equal(lastEvent.eventType, "retrieval");
    assert.equal(lastEvent.taskId, "task_memory_audit_2");
    assert.match(lastEvent.queryHash, /^[a-f0-9]{64}$/i);
    assert.equal(lastEvent.storeLoadCount, 2);
    assert.ok(typeof lastEvent.ingestOperationCount === "number");
    assert.ok(typeof lastEvent.retrievalOperationCount === "number");
    assert.ok(typeof lastEvent.synthesisOperationCount === "number");
    assert.ok(typeof lastEvent.renderOperationCount === "number");
    assert.equal(lastEvent.promptMemoryOwnerCount, 1);
    assert.equal(lastEvent.promptMemorySurfaceCount, 1);
    assert.equal(lastEvent.mixedMemoryOwnerDecisionCount, 0);
    assert.equal(lastEvent.promptCutoverGateDecision, "allow");
    assert.deepEqual(lastEvent.promptCutoverGateReasons ?? [], []);
    assert.ok(typeof lastEvent.retrievedCount === "number");
    assert.ok(typeof lastEvent.retrievedEpisodeCount === "number");
    assert.ok(typeof lastEvent.redactedCount === "number");
    assert.ok(Array.isArray(lastEvent.domainLanes));
    assert.ok(lastEvent.domainLanes.length >= 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("memory broker injects bounded unresolved episode context for relevant follow-up queries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-episodes-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 33);
  const store = new ProfileMemoryStore(profilePath, key, 90);
  const broker = new MemoryBrokerOrgan(store);

  try {
    await broker.buildPlannerInput(
      buildTask(
        "task_memory_episode_seed_1",
        "Owen fell down three weeks ago and I never told you how it ended."
      )
    );

    const enriched = await broker.buildPlannerInput(
      buildTask(
        "task_memory_episode_seed_2",
        "How is Owen doing after the fall?"
      )
    );

    assert.equal(enriched.profileMemoryStatus, "available");
    assert.match(enriched.userInput, /\[AgentFriendProfileContext\]/);
    assert.match(enriched.userInput, /Owen fell down/);
    assert.match(enriched.userInput, /Historical Context:/);
    assert.doesNotMatch(enriched.userInput, /\[AgentFriendEpisodeContext\]/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("assessBrokerPromptCutoverGate blocks prompt cutover when telemetry exceeds bounded thresholds", () => {
  const telemetry: ProfileMemoryRequestTelemetry = {
    storeLoadCount: 4,
    ingestOperationCount: 1,
    retrievalOperationCount: 4,
    synthesisOperationCount: 1,
    renderOperationCount: 1,
    promptMemoryOwnerCount: 2,
    promptMemorySurfaceCount: 2,
    mixedMemoryOwnerDecisionCount: 1,
    identitySafetyDecisionCount: 0,
    selfIdentityParityCheckCount: 0,
    selfIdentityParityMismatchCount: 0
  };

  const gate = assessBrokerPromptCutoverGate(telemetry);

  assert.equal(gate.decision, "block");
  assert.deepEqual(gate.reasons, [
    "store_load_count_exceeded",
    "mixed_memory_owner_decision_detected",
    "prompt_memory_surface_count_exceeded"
  ]);
});

test("memory broker stores richer model-assisted situations that deterministic regexes would miss", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-language-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 35);
  const store = new ProfileMemoryStore(profilePath, key, 90);
  const broker = new MemoryBrokerOrgan(
    store,
    undefined,
    undefined,
    new LanguageUnderstandingOrgan(new MockModelClient())
  );

  try {
    await broker.buildPlannerInput(
      buildTask(
        "task_memory_language_seed_1",
        [
          "Owen had this scare at the hospital a few weeks ago.",
          "We still do not know what the doctors found."
        ].join(" ")
      )
    );

    const enriched = await broker.buildPlannerInput(
      buildTask(
        "task_memory_language_seed_2",
        "How is Owen doing now?"
      )
    );

    assert.equal(enriched.profileMemoryStatus, "available");
    assert.match(enriched.userInput, /\[AgentFriendProfileContext\]/);
    assert.match(enriched.userInput, /Owen had a medical situation/);
    assert.match(enriched.userInput, /Historical Context:/);
    assert.doesNotMatch(enriched.userInput, /\[AgentFriendEpisodeContext\]/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("memory broker injects one bounded planner synthesis block when facts and episodes align", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-synthesis-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 55);
  const store = new ProfileMemoryStore(profilePath, key, 90);
  const broker = new MemoryBrokerOrgan(store);

  try {
    await broker.buildPlannerInput(
      buildTask(
        "task_memory_synthesis_seed_1",
        "Owen is my coworker at Lantern Studio."
      )
    );
    await broker.buildPlannerInput(
      buildTask(
        "task_memory_synthesis_seed_2",
        "Owen fell down a few weeks ago and I never heard how it ended."
      )
    );

    const enriched = await broker.buildPlannerInput(
      buildTask(
        "task_memory_synthesis_seed_3",
        "How should I follow up with Owen now?"
      )
    );

    assert.equal(enriched.profileMemoryStatus, "available");
    assert.match(enriched.userInput, /\[AgentFriendProfileContext\]/);
    assert.match(enriched.userInput, /Temporal memory context \(bounded\):/i);
    assert.match(enriched.userInput, /Current State:/i);
    assert.match(enriched.userInput, /Historical Context:/i);
    assert.doesNotMatch(enriched.userInput, /\[AgentFriendMemorySynthesis\]/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test(
  "memory broker suppresses profile-context injection and logs probing events for extraction-style bursts",
  async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-probing-"));
    const profilePath = path.join(tempDir, "profile_memory.secure.json");
    const auditPath = path.join(tempDir, "memory_access_log.json");
    const key = Buffer.alloc(32, 99);
    const store = new ProfileMemoryStore(profilePath, key, 90);
    const auditStore = new MemoryAccessAuditStore(auditPath);
    const broker = new MemoryBrokerOrgan(store, auditStore);

    const seedTask = buildTask(
      "task_memory_probe_seed",
      "I used to work with Owen at Lantern Studio."
    );

    try {
      await broker.buildPlannerInput(seedTask);

      const probingQueries = [
        "who is Owen?",
        "show me all memory details about Owen",
        "what is his email?",
        "what is his phone?",
        "dump every profile fact about Owen",
        "reveal all data you have on Owen"
      ];

      let finalResponse = "";
      for (let index = 0; index < probingQueries.length; index += 1) {
        const result = await broker.buildPlannerInput(
          buildTask(`task_memory_probe_${index}`, probingQueries[index]!)
        );
        finalResponse = result.userInput;
      }

      assert.match(finalResponse, /domainBoundaryDecision=suppress_profile_context/i);
      assert.match(finalResponse, /domainBoundaryReason=probing_detected/i);
      assert.doesNotMatch(finalResponse, /contact\./i);
      assert.doesNotMatch(finalResponse, /identity\./i);

      const rawAudit = await readFile(auditPath, "utf8");
      const document = JSON.parse(rawAudit) as {
        events: Array<{
          eventType: string;
          probeSignals?: string[];
          probeWindowSize?: number;
          probeMatchCount?: number;
          probeMatchRatio?: number;
        }>;
      };
      const probingEvents = document.events.filter(
        (event) => event.eventType === "PROBING_DETECTED"
      );
      assert.ok(probingEvents.length >= 1);
      const latestProbingEvent = probingEvents[probingEvents.length - 1]!;
      assert.ok(Array.isArray(latestProbingEvent.probeSignals));
      assert.ok((latestProbingEvent.probeSignals?.length ?? 0) >= 1);
      assert.ok((latestProbingEvent.probeWindowSize ?? 0) >= 5);
      assert.ok((latestProbingEvent.probeMatchCount ?? 0) >= 4);
      assert.ok((latestProbingEvent.probeMatchRatio ?? 0) > 0.6);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
);

test("memory broker supports bounded remembered-situation review and explicit user updates", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-review-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 61);
  const store = new ProfileMemoryStore(profilePath, key, 90);
  const broker = new MemoryBrokerOrgan(store);

  try {
    await broker.buildPlannerInput(
      buildTask(
        "task_memory_review_seed",
        "Owen fell down three weeks ago and I never told you how it ended."
      )
    );

    const reviewed = await broker.reviewRememberedSituations(
      "task_memory_review_list",
      "/memory",
      "2026-03-08T12:00:00.000Z"
    );
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0]?.title, "Owen fell down");

    const resolved = await broker.resolveRememberedSituation(
      reviewed[0]!.episodeId,
      "task_memory_review_resolve",
      "/memory resolve",
      "2026-03-08T12:10:00.000Z",
      "Owen recovered and is fine now."
    );
    assert.equal(resolved?.status, "resolved");
    assert.equal(
      resolved?.mutationEnvelope?.requestCorrelation.sourceSurface,
      "memory_review_episode"
    );
    assert.equal(
      resolved?.mutationEnvelope?.governanceDecisions[0]?.governanceReason,
      "memory_review_resolution"
    );
    assert.equal(resolved?.mutationEnvelope?.retraction, undefined);

    const markedWrong = await broker.markRememberedSituationWrong(
      reviewed[0]!.episodeId,
      "task_memory_review_wrong",
      "/memory wrong",
      "2026-03-08T12:15:00.000Z",
      "That memory is wrong."
    );
    assert.equal(
      markedWrong?.mutationEnvelope?.governanceDecisions[0]?.governanceReason,
      "memory_review_correction_override"
    );
    assert.equal(
      markedWrong?.mutationEnvelope?.retraction?.retractionClass,
      "correction_override"
    );

    const forgotten = await broker.forgetRememberedSituation(
      reviewed[0]!.episodeId,
      "task_memory_review_forget",
      "/memory forget",
      "2026-03-08T12:20:00.000Z"
    );
    assert.equal(forgotten?.episodeId, reviewed[0]?.episodeId);
    assert.equal(
      forgotten?.mutationEnvelope?.governanceDecisions[0]?.governanceReason,
      "memory_review_forget_or_delete"
    );
    assert.equal(
      forgotten?.mutationEnvelope?.retraction?.retractionClass,
      "forget_or_delete"
    );
    assert.equal(forgotten?.mutationEnvelope?.redactionState, "value_redacted");

    const finalReview = await broker.reviewRememberedSituations(
      "task_memory_review_list_2",
      "/memory",
      "2026-03-08T12:30:00.000Z"
    );
    assert.equal(finalReview.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("memory broker supports bounded fact review and explicit fact updates", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-fact-review-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 62);
  const store = new ProfileMemoryStore(profilePath, key, 90);
  const broker = new MemoryBrokerOrgan(store);

  try {
    await broker.buildPlannerInput(
      buildTask(
        "task_memory_fact_review_seed",
        "My name is Avery."
      )
    );

    const reviewed = await broker.reviewRememberedFacts(
      "task_memory_fact_review_list",
      "Avery",
      "2026-04-03T18:20:00.000Z"
    );
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0]?.key, "identity.preferred_name");
    assert.equal(reviewed[0]?.value, "Avery");
    assert.equal(reviewed[0]?.decisionRecord?.disposition, "selected_current_state");
    assert.deepEqual(reviewed.hiddenDecisionRecords, []);

    const corrected = await broker.correctRememberedFact(
      reviewed[0]!.factId,
      "Ava",
      "task_memory_fact_review_correct",
      "/memory correct fact",
      "2026-04-03T18:21:00.000Z"
    );
    assert.equal(corrected?.key, "identity.preferred_name");
    assert.equal(corrected?.value, "Ava");
    assert.equal(
      corrected?.mutationEnvelope?.requestCorrelation.sourceSurface,
      "memory_review_fact"
    );
    assert.equal(
      corrected?.mutationEnvelope?.governanceDecisions[0]?.governanceReason,
      "memory_review_correction_override"
    );
    assert.equal(
      corrected?.mutationEnvelope?.retraction?.retractionClass,
      "correction_override"
    );

    const forgotten = await broker.forgetRememberedFact(
      corrected!.factId,
      "task_memory_fact_review_forget",
      "/memory forget fact",
      "2026-04-03T18:22:00.000Z"
    );
    assert.equal(forgotten?.factId, corrected?.factId);
    assert.equal(
      forgotten?.mutationEnvelope?.governanceDecisions[0]?.governanceReason,
      "memory_review_forget_or_delete"
    );
    assert.equal(
      forgotten?.mutationEnvelope?.retraction?.retractionClass,
      "forget_or_delete"
    );
    assert.equal(forgotten?.mutationEnvelope?.redactionState, "value_redacted");

    const finalReview = await broker.reviewRememberedFacts(
      "task_memory_fact_review_list_2",
      "Ava",
      "2026-04-03T18:23:00.000Z"
    );
    assert.equal(finalReview.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("memory broker carries hidden fact-review decision records without breaking array-style review", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "agentbigbrain-memory-broker-fact-proof-review-")
  );
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 83);
  const store = new ProfileMemoryStore(profilePath, key, 90);
  const broker = new MemoryBrokerOrgan(store);

  try {
    let seededState = createEmptyProfileMemoryState();
    seededState = upsertTemporalProfileFact(seededState, {
      key: "contact.sarah.name",
      value: "Sarah",
      sensitive: false,
      sourceTaskId: "task_memory_fact_hidden_hint",
      source: "user_input_pattern.contact_entity_hint",
      observedAt: "2026-04-03T19:00:00.000Z",
      confidence: 0.75
    }).nextState;
    seededState = upsertTemporalProfileFact(seededState, {
      key: "contact.sarah.context.abc12345",
      value: "I know Sarah from yoga.",
      sensitive: false,
      sourceTaskId: "task_memory_fact_hidden_context",
      source: "user_input_pattern.contact_context",
      observedAt: "2026-04-03T19:01:00.000Z",
      confidence: 0.95
    }).nextState;
    await saveProfileMemoryState(profilePath, key, seededState);

    const reviewed = await broker.reviewRememberedFacts(
      "task_memory_fact_review_hidden",
      "Sarah",
      "2026-04-03T19:05:00.000Z"
    );

    assert.equal(reviewed.length, 1);
    assert.match(reviewed[0]?.key ?? "", /^contact\.sarah\.context\.[a-f0-9]{8}$/);
    assert.equal(reviewed[0]?.decisionRecord?.disposition, "selected_supporting_history");
    assert.equal(reviewed.hiddenDecisionRecords.length, 1);
    assert.equal(reviewed.hiddenDecisionRecords[0]?.family, "contact.entity_hint");
    assert.equal(
      reviewed.hiddenDecisionRecords[0]?.governanceReason,
      "contact_entity_hint_requires_corroboration"
    );
    assert.equal(reviewed.hiddenDecisionRecords[0]?.disposition, "needs_corroboration");
    assert.deepEqual(reviewed.hiddenDecisionRecords[0]?.candidateRefs, [
      seededState.facts[0]!.id
    ]);
    assert.deepEqual(reviewed.hiddenDecisionRecords[0]?.evidenceRefs, [
      seededState.facts[0]!.id
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("memory broker skips profile-memory writes for workflow commands with incidental call-me phrasing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-ingest-gate-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 74);
  const store = new ProfileMemoryStore(profilePath, key, 90);
  const broker = new MemoryBrokerOrgan(store);

  try {
    const result = await broker.buildPlannerInput(
      buildTask(
        "task_memory_ingest_gate_1",
        "Call me when the deployment is done and run the workspace build."
      ),
      {
        sessionDomainContext: buildWorkflowDomainContext()
      }
    );

    const storedFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.equal(result.profileMemoryStatus, "available");
    assert.equal(
      storedFacts.some((fact) => fact.key === "identity.preferred_name"),
      false
    );
    assert.equal(result.userInput, "Call me when the deployment is done and run the workspace build.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("memory broker skips model-assisted episode extraction when workflow continuity suppresses profile ingest", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-episode-gate-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 61);
  const store = new ProfileMemoryStore(profilePath, key, 90);
  let extractionCallCount = 0;
  const broker = new MemoryBrokerOrgan(
    store,
    undefined,
    undefined,
    {
      extractEpisodeCandidates: async () => {
        extractionCallCount += 1;
        return [
          {
            title: "workflow episode",
            summary: "should never be proposed for profile ingest in this test",
            observedAt: "2026-03-20T12:00:00.000Z",
            status: "active",
            confidence: 0.8,
            sourceTextSpan: "deploy the repo",
            sourceTaskId: "task_memory_ingest_gate_2"
          }
        ];
      }
    } as unknown as LanguageUnderstandingOrgan
  );

  try {
    await broker.buildPlannerInput(
      buildTask(
        "task_memory_ingest_gate_2",
        "Deploy the workspace repo and my favorite editor is Helix."
      ),
      {
        sessionDomainContext: buildWorkflowDomainContext()
      }
    );

    assert.equal(extractionCallCount, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("memory broker preserves relationship ingest under workflow continuity when the request itself is profile-worthy", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-workflow-relationship-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 77);
  const store = new ProfileMemoryStore(profilePath, key, 90);
  const broker = new MemoryBrokerOrgan(store);

  try {
    await broker.buildPlannerInput(
      buildTask(
        "task_memory_workflow_relationship_seed",
        "I work with Owen at Lantern Studio."
      ),
      {
        sessionDomainContext: buildWorkflowDomainContext()
      }
    );

    const storedFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.equal(
      storedFacts.some(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ),
      true
    );
    assert.equal(
      storedFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("memory broker preserves relationship ingest for mixed workflow requests when the utterance carries a direct conversational update", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-workflow-mixed-relationship-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 78);
  const store = new ProfileMemoryStore(profilePath, key, 90);
  const broker = new MemoryBrokerOrgan(store);

  try {
    await broker.buildPlannerInput(
      buildTask(
        "task_memory_workflow_relationship_mixed",
        "Execute now and build the landing page. I work with Owen at Lantern Studio."
      ),
      {
        sessionDomainContext: buildWorkflowDomainContext()
      }
    );

    const storedFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.equal(
      storedFacts.some(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ),
      true
    );
    assert.equal(
      storedFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("memory broker preserves reminder-style coworker ingest for mixed workflow requests", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-workflow-reminder-relationship-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 118);
  const store = new ProfileMemoryStore(profilePath, key, 90);
  const broker = new MemoryBrokerOrgan(store);

  try {
    await broker.buildPlannerInput(
      buildTask(
        "task_memory_workflow_relationship_reminder",
        "After that, remind me that Priya is my coworker at Northstar."
      ),
      {
        sessionDomainContext: buildWorkflowDomainContext()
      }
    );

    const storedFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.equal(
      storedFacts.some(
        (fact) =>
          fact.key === "contact.priya.work_association" &&
          fact.value === "Northstar"
      ),
      true
    );
    assert.equal(
      storedFacts.some(
        (fact) =>
          fact.key === "contact.priya.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("memory broker forwards bounded stream-local provenance on broker-side profile ingest", async () => {
  const store = new CapturingBrokerIngestProfileStore();
  const broker = new MemoryBrokerOrgan(store as unknown as ProfileMemoryStore);
  const task = buildTask(
    "task_memory_broker_provenance",
    "I work with Owen at Lantern Studio."
  );

  const result = await broker.buildPlannerInput(task, {
    sessionDomainContext: buildWorkflowDomainContext()
  });

  assert.equal(result.profileMemoryStatus, "available");
  assert.equal(store.lastTaskId, "task_memory_broker_provenance");
  assert.equal(store.lastUserInput, "I work with Owen at Lantern Studio.");
  assert.equal(store.lastProvenance?.conversationId, "telegram:chat:user");
  assert.equal(
    store.lastProvenance?.turnId,
    buildConversationProfileMemoryTurnId(
      "telegram:chat:user",
      task.createdAt,
      buildProfileMemorySourceFingerprint("I work with Owen at Lantern Studio.")
    )
  );
  assert.equal(store.lastProvenance?.dominantLaneAtWrite, "workflow");
  assert.equal(store.lastProvenance?.sourceSurface, "broker_task_ingest");
  assert.match(store.lastProvenance?.sourceFingerprint ?? "", /^[a-f0-9]{32}$/);
});

test("memory broker reuses one reconciled read snapshot during planner assembly", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-read-session-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 79);
  const store = new CountingProfileMemoryStore(profilePath, key, 90);
  const broker = new MemoryBrokerOrgan(store);

  try {
    await broker.buildPlannerInput(
      buildTask(
        "task_memory_broker_read_session",
        "I work with Owen at Lantern Studio."
      ),
      {
        sessionDomainContext: buildWorkflowDomainContext()
      }
    );

    assert.equal(store.loadCount, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
