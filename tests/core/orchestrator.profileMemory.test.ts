/**
 * @fileoverview Validates real orchestrator-path integration of encrypted profile memory and planner-context enrichment.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { makeId } from "../../src/core/ids";
import { BrainOrchestrator } from "../../src/core/orchestrator";
import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import { createEmptyConversationStackV1 } from "../../src/core/stage6_86ConversationStack";
import { createEmptyEntityGraphV1 } from "../../src/core/stage6_86EntityGraph";
import type {
  ProfileMemoryMutationEnvelope,
  ProfileMemoryQueryDecisionRecord,
  ProfileReadableEpisode,
  ProfileReadableFact,
  ProfileMemoryWriteProvenance
} from "../../src/core/profileMemory";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";
import { StateStore } from "../../src/core/stateStore";
import { TaskRequest } from "../../src/core/types";
import { createDefaultGovernors } from "../../src/governors/defaultGovernors";
import { MasterGovernor } from "../../src/governors/masterGovernor";
import { GovernanceMemoryStore } from "../../src/core/governanceMemory";
import { MockModelClient } from "../../src/models/mockModelClient";
import {
  ModelClient,
  StructuredCompletionRequest
} from "../../src/models/types";
import type { MemoryBrokerOrgan } from "../../src/organs/memoryBroker";
import { ToolExecutorOrgan } from "../../src/organs/executor";
import { PlannerOrgan } from "../../src/organs/planner";
import { ReflectionOrgan } from "../../src/organs/reflection";
import { PersonalityStore } from "../../src/core/personalityStore";

/**
 * Implements `buildTask` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildTask(userInput: string): TaskRequest {
  return {
    id: makeId("task"),
    goal: "Provide safe and helpful assistance.",
    userInput,
    createdAt: new Date().toISOString()
  };
}

function buildWorkflowDomainContext() {
  return {
    conversationId: "telegram:chat:user",
    dominantLane: "workflow" as const,
    recentLaneHistory: [
      {
        lane: "workflow" as const,
        observedAt: "2026-03-20T12:00:00.000Z",
        source: "routing_mode" as const,
        weight: 2
      }
    ],
    recentRoutingSignals: [
      {
        mode: "build" as const,
        observedAt: "2026-03-20T12:00:00.000Z"
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

function buildFactDecisionRecord(
  overrides: Partial<ProfileMemoryQueryDecisionRecord> = {}
): ProfileMemoryQueryDecisionRecord {
  return {
    family: "generic.profile_fact",
    evidenceClass: "user_explicit_fact",
    governanceAction: "allow_current_state",
    governanceReason: "explicit_user_fact",
    disposition: "selected_current_state",
    answerModeFallback: "report_current_state",
    candidateRefs: ["candidate_fact_1"],
    evidenceRefs: ["fact_1"],
    ...overrides
  };
}

function buildFactMutationEnvelope(
  overrides: Partial<ProfileMemoryMutationEnvelope> = {}
): ProfileMemoryMutationEnvelope {
  return {
    requestCorrelation: {
      sourceSurface: "memory_review_fact"
    },
    candidateRefs: ["candidate_fact_1"],
    governanceDecisions: [
      {
        family: "generic.profile_fact",
        evidenceClass: "user_explicit_fact",
        governanceAction: "allow_current_state",
        governanceReason: "memory_review_correction_override",
        candidateRefs: ["candidate_fact_1"],
        appliedWriteRefs: ["write_fact_1"]
      }
    ],
    appliedWriteRefs: ["write_fact_1"],
    redactionState: "not_requested",
    ...overrides
  };
}

class CapturingPlannerModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private readonly delegate = new MockModelClient();
  lastPlannerUserPrompt = "";

  /**
 * Implements `completeJson` behavior within class CapturingPlannerModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "planner_v1") {
      this.lastPlannerUserPrompt = request.userPrompt;
    }
    return this.delegate.completeJson<T>(request);
  }
}

class InjectedSensitiveProfileStore {
  /**
 * Implements `ingestFromTaskInput` behavior within class InjectedSensitiveProfileStore.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async ingestFromTaskInput(): Promise<{ appliedFacts: number; supersededFacts: number }> {
    return {
      appliedFacts: 0,
      supersededFacts: 0
    };
  }

  /**
 * Implements `getPlanningContext` behavior within class InjectedSensitiveProfileStore.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async getPlanningContext(_maxFacts = 6, _queryInput = ""): Promise<string> {
    return [
      "contact.email: owner@example.com",
      "contact.phone: +1 555 0100",
      "employment.current: Lantern"
    ].join("\n");
  }

  /**
 * Implements `getEpisodePlanningContext` behavior within class InjectedSensitiveProfileStore.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async getEpisodePlanningContext(_maxEpisodes = 2, _queryInput = ""): Promise<string> {
    return "";
  }

  /**
 * Implements `queryFactsForPlanningContext` behavior within class InjectedSensitiveProfileStore.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async queryFactsForPlanningContext(): Promise<readonly ProfileReadableFact[]> {
    return [
      {
        factId: "fact_lantern",
        key: "employment.current",
        value: "Lantern",
        status: "confirmed",
        observedAt: new Date(0).toISOString(),
        lastUpdatedAt: new Date(0).toISOString(),
        confidence: 0.92,
        sensitive: false
      }
    ];
  }

  /**
 * Implements `queryEpisodesForPlanningContext` behavior within class InjectedSensitiveProfileStore.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async queryEpisodesForPlanningContext(): Promise<readonly ProfileReadableEpisode[]> {
    return [];
  }
}

class CapturingIngestProfileStore {
  lastIngestInput = "";
  lastProvenance: ProfileMemoryWriteProvenance | null = null;
  lastTaskId = "";

  /**
 * Implements `ingestFromTaskInput` behavior within class CapturingIngestProfileStore.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async ingestFromTaskInput(
    taskId: string,
    userInput: string,
    _observedAt?: string,
    options?: { provenance?: ProfileMemoryWriteProvenance }
  ): Promise<{ appliedFacts: number; supersededFacts: number }> {
    this.lastTaskId = taskId;
    this.lastIngestInput = userInput;
    this.lastProvenance = options?.provenance ?? null;
    return {
      appliedFacts: 0,
      supersededFacts: 0
    };
  }

  /**
 * Implements `getPlanningContext` behavior within class CapturingIngestProfileStore.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async getPlanningContext(_maxFacts = 6, _queryInput = ""): Promise<string> {
    return "";
  }

  /**
 * Implements `getEpisodePlanningContext` behavior within class CapturingIngestProfileStore.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async getEpisodePlanningContext(_maxEpisodes = 2, _queryInput = ""): Promise<string> {
    return "";
  }

  /**
 * Implements `queryFactsForPlanningContext` behavior within class CapturingIngestProfileStore.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async queryFactsForPlanningContext(): Promise<readonly ProfileReadableFact[]> {
    return [];
  }

  /**
 * Implements `queryEpisodesForPlanningContext` behavior within class CapturingIngestProfileStore.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async queryEpisodesForPlanningContext(): Promise<readonly ProfileReadableEpisode[]> {
    return [];
  }
}

class CountingContinuityProfileStore extends ProfileMemoryStore {
  loadCount = 0;
  lastFactContinuityRequest: Parameters<ProfileMemoryStore["queryFactsForContinuity"]>[2] | null = null;
  lastEpisodeContinuityRequest: Parameters<ProfileMemoryStore["queryEpisodesForContinuity"]>[2] | null = null;

  /**
 * Implements `load` behavior within class CountingContinuityProfileStore.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async load() {
    this.loadCount += 1;
    return super.load();
  }

  async openReadSession() {
    const readSession = await super.openReadSession();
    const queryFactsForContinuity = readSession.queryFactsForContinuity.bind(readSession);
    const queryEpisodesForContinuity = readSession.queryEpisodesForContinuity.bind(readSession);
    readSession.queryFactsForContinuity = (
      graph: Parameters<typeof readSession.queryFactsForContinuity>[0],
      stack: Parameters<typeof readSession.queryFactsForContinuity>[1],
      request: Parameters<typeof readSession.queryFactsForContinuity>[2]
    ) => {
      this.lastFactContinuityRequest = request;
      return queryFactsForContinuity(graph, stack, request);
    };
    readSession.queryEpisodesForContinuity = (
      graph: Parameters<typeof readSession.queryEpisodesForContinuity>[0],
      stack: Parameters<typeof readSession.queryEpisodesForContinuity>[1],
      request: Parameters<typeof readSession.queryEpisodesForContinuity>[2],
      nowIso?: Parameters<typeof readSession.queryEpisodesForContinuity>[3]
    ) => {
      this.lastEpisodeContinuityRequest = request;
      return queryEpisodesForContinuity(graph, stack, request, nowIso);
    };
    return readSession;
  }

  async queryFactsForContinuity(
    graph: Parameters<ProfileMemoryStore["queryFactsForContinuity"]>[0],
    stack: Parameters<ProfileMemoryStore["queryFactsForContinuity"]>[1],
    request: Parameters<ProfileMemoryStore["queryFactsForContinuity"]>[2]
  ) {
    this.lastFactContinuityRequest = request;
    return super.queryFactsForContinuity(graph, stack, request);
  }

  async queryEpisodesForContinuity(
    graph: Parameters<ProfileMemoryStore["queryEpisodesForContinuity"]>[0],
    stack: Parameters<ProfileMemoryStore["queryEpisodesForContinuity"]>[1],
    request: Parameters<ProfileMemoryStore["queryEpisodesForContinuity"]>[2],
    nowIso?: Parameters<ProfileMemoryStore["queryEpisodesForContinuity"]>[3]
  ) {
    this.lastEpisodeContinuityRequest = request;
    return super.queryEpisodesForContinuity(graph, stack, request, nowIso);
  }
}

test("orchestrator enriches planner input with non-sensitive profile context from encrypted store", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-orch-profile-"));
  const statePath = path.join(tempDir, "state.json");
  const semanticPath = path.join(tempDir, "semantic_memory.json");
  const personalityPath = path.join(tempDir, "personality_profile.json");
  const governancePath = path.join(tempDir, "governance_memory.json");
  const encryptedProfilePath = path.join(tempDir, "profile_memory.secure.json");
  const profileKey = Buffer.alloc(32, 21);

  const modelClient = new CapturingPlannerModelClient();
  const memoryStore = new SemanticMemoryStore(semanticPath);
  const config = {
    ...DEFAULT_BRAIN_CONFIG,
    dna: {
      ...DEFAULT_BRAIN_CONFIG.dna,
      immutableKeywords: [...DEFAULT_BRAIN_CONFIG.dna.immutableKeywords],
      protectedPathPrefixes: [...DEFAULT_BRAIN_CONFIG.dna.protectedPathPrefixes]
    }
  };
  const profileStore = new ProfileMemoryStore(encryptedProfilePath, profileKey, 90);

  const brain = new BrainOrchestrator(
    config,
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(config),
    createDefaultGovernors(),
    new MasterGovernor(config.governance.supermajorityThreshold),
    new StateStore(statePath),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    new PersonalityStore(personalityPath),
    new GovernanceMemoryStore(governancePath),
    profileStore
  );

  try {
    await brain.runTask(buildTask("I work at Lantern. Give me a concise status update."));

    const plannerPayload = JSON.parse(modelClient.lastPlannerUserPrompt) as {
      userInput?: string;
    };
    const plannerInput = plannerPayload.userInput ?? "";

    assert.match(plannerInput, /\[AgentFriendProfileContext\]/);
    assert.match(plannerInput, /employment\.current: Lantern/i);

    const encryptedRaw = await readFile(encryptedProfilePath, "utf8");
    assert.equal(encryptedRaw.includes("Lantern"), false);
    assert.equal(encryptedRaw.includes("employment.current"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("orchestrator degrades gracefully when encrypted profile memory cannot be decrypted", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-orch-profile-degraded-"));
  const statePath = path.join(tempDir, "state.json");
  const semanticPath = path.join(tempDir, "semantic_memory.json");
  const personalityPath = path.join(tempDir, "personality_profile.json");
  const governancePath = path.join(tempDir, "governance_memory.json");
  const encryptedProfilePath = path.join(tempDir, "profile_memory.secure.json");
  const seedProfileKey = Buffer.alloc(32, 31);
  const wrongProfileKey = Buffer.alloc(32, 47);
  const nowIso = new Date().toISOString();

  const seededProfileStore = new ProfileMemoryStore(encryptedProfilePath, seedProfileKey, 90);
  await seededProfileStore.ingestFromTaskInput("seed-task", "I work at Lantern.", nowIso);

  const modelClient = new CapturingPlannerModelClient();
  const memoryStore = new SemanticMemoryStore(semanticPath);
  const config = {
    ...DEFAULT_BRAIN_CONFIG,
    dna: {
      ...DEFAULT_BRAIN_CONFIG.dna,
      immutableKeywords: [...DEFAULT_BRAIN_CONFIG.dna.immutableKeywords],
      protectedPathPrefixes: [...DEFAULT_BRAIN_CONFIG.dna.protectedPathPrefixes]
    }
  };
  const degradedProfileStore = new ProfileMemoryStore(encryptedProfilePath, wrongProfileKey, 90);

  const brain = new BrainOrchestrator(
    config,
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(config),
    createDefaultGovernors(),
    new MasterGovernor(config.governance.supermajorityThreshold),
    new StateStore(statePath),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    new PersonalityStore(personalityPath),
    new GovernanceMemoryStore(governancePath),
    degradedProfileStore
  );

  try {
    const result = await brain.runTask(buildTask("Give me a concise status update."));
    assert.equal(result.actionResults.length, 1);
    assert.equal(result.actionResults[0].approved, true);
    assert.match(result.summary, /Agent Friend context unavailable \(degraded_unavailable\)/);

    const plannerPayload = JSON.parse(modelClient.lastPlannerUserPrompt) as {
      userInput?: string;
    };
    const plannerInput = plannerPayload.userInput ?? "";
    assert.match(plannerInput, /\[AgentFriendProfileStatus\]/);
    assert.match(plannerInput, /mode=degraded_unavailable/);
    assert.equal(plannerInput.includes("[AgentFriendProfileContext]"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("orchestrator suppresses sensitive profile fields before planner model egress", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-orch-profile-redact-"));
  const statePath = path.join(tempDir, "state.json");
  const semanticPath = path.join(tempDir, "semantic_memory.json");
  const personalityPath = path.join(tempDir, "personality_profile.json");
  const governancePath = path.join(tempDir, "governance_memory.json");

  const modelClient = new CapturingPlannerModelClient();
  const memoryStore = new SemanticMemoryStore(semanticPath);
  const config = {
    ...DEFAULT_BRAIN_CONFIG,
    dna: {
      ...DEFAULT_BRAIN_CONFIG.dna,
      immutableKeywords: [...DEFAULT_BRAIN_CONFIG.dna.immutableKeywords],
      protectedPathPrefixes: [...DEFAULT_BRAIN_CONFIG.dna.protectedPathPrefixes]
    }
  };

  const brain = new BrainOrchestrator(
    config,
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(config),
    createDefaultGovernors(),
    new MasterGovernor(config.governance.supermajorityThreshold),
    new StateStore(statePath),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    new PersonalityStore(personalityPath),
    new GovernanceMemoryStore(governancePath),
    new InjectedSensitiveProfileStore() as unknown as ProfileMemoryStore
  );

  try {
    await brain.runTask(buildTask("Give me a concise status update."));

    const plannerPayload = JSON.parse(modelClient.lastPlannerUserPrompt) as {
      userInput?: string;
    };
    const plannerInput = plannerPayload.userInput ?? "";
    assert.match(plannerInput, /\[AgentFriendProfileContext\]/);
    assert.match(plannerInput, /domainBoundaryDecision=suppress_profile_context/);
    assert.match(plannerInput, /suppressed=true/);
    assert.doesNotMatch(plannerInput, /contact\.email:/);
    assert.doesNotMatch(plannerInput, /contact\.phone:/);
    assert.equal(plannerInput.includes("owner@example.com"), false);
    assert.equal(plannerInput.includes("+1 555 0100"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("orchestrator ingests only current user request from conversation-wrapper execution input", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-orch-profile-ingest-"));
  const statePath = path.join(tempDir, "state.json");
  const semanticPath = path.join(tempDir, "semantic_memory.json");
  const personalityPath = path.join(tempDir, "personality_profile.json");
  const governancePath = path.join(tempDir, "governance_memory.json");

  const modelClient = new CapturingPlannerModelClient();
  const memoryStore = new SemanticMemoryStore(semanticPath);
  const config = {
    ...DEFAULT_BRAIN_CONFIG,
    dna: {
      ...DEFAULT_BRAIN_CONFIG.dna,
      immutableKeywords: [...DEFAULT_BRAIN_CONFIG.dna.immutableKeywords],
      protectedPathPrefixes: [...DEFAULT_BRAIN_CONFIG.dna.protectedPathPrefixes]
    }
  };
  const capturingStore = new CapturingIngestProfileStore();

  const brain = new BrainOrchestrator(
    config,
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(config),
    createDefaultGovernors(),
    new MasterGovernor(config.governance.supermajorityThreshold),
    new StateStore(statePath),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    new PersonalityStore(personalityPath),
    new GovernanceMemoryStore(governancePath),
    capturingStore as unknown as ProfileMemoryStore
  );

  const wrappedInput = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: my job is OldCo.",
    "- assistant: noted.",
    "",
    "Current user request:",
    "who is Owen?"
  ].join("\n");

  try {
    await brain.runTask(buildTask(wrappedInput));
    assert.equal(capturingStore.lastIngestInput, "who is Owen?");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("orchestrator remembers validated identity candidates through the canonical profile-memory store seam", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-orch-profile-validated-identity-"));
  const statePath = path.join(tempDir, "state.json");
  const semanticPath = path.join(tempDir, "semantic_memory.json");
  const personalityPath = path.join(tempDir, "personality_profile.json");
  const governancePath = path.join(tempDir, "governance_memory.json");
  const encryptedProfilePath = path.join(tempDir, "profile_memory.secure.json");
  const profileKey = Buffer.alloc(32, 19);

  const modelClient = new CapturingPlannerModelClient();
  const memoryStore = new SemanticMemoryStore(semanticPath);
  const config = {
    ...DEFAULT_BRAIN_CONFIG,
    dna: {
      ...DEFAULT_BRAIN_CONFIG.dna,
      immutableKeywords: [...DEFAULT_BRAIN_CONFIG.dna.immutableKeywords],
      protectedPathPrefixes: [...DEFAULT_BRAIN_CONFIG.dna.protectedPathPrefixes]
    }
  };
  const profileStore = new ProfileMemoryStore(encryptedProfilePath, profileKey, 90);

  const brain = new BrainOrchestrator(
    config,
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(config),
    createDefaultGovernors(),
    new MasterGovernor(config.governance.supermajorityThreshold),
    new StateStore(statePath),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    new PersonalityStore(personalityPath),
    new GovernanceMemoryStore(governancePath),
    profileStore
  );

  try {
    const remembered = await brain.rememberConversationProfileInput(
      {
        validatedFactCandidates: [
          {
            key: "identity.preferred_name",
            candidateValue: "Avery",
            source: "conversation.identity_interpretation",
            confidence: 0.95
          }
        ]
      },
      "2026-03-21T12:05:00.000Z"
    );

    assert.equal(remembered, true);
    const facts = await profileStore.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_orchestrator_validated_identity_1",
      maxFacts: 10
    });
    assert.equal(
      facts.some((fact) => fact.key === "identity.preferred_name" && fact.value === "Avery"),
      true
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("orchestrator forwards conversational write provenance and derives a stable synthetic source task id", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-orch-profile-provenance-"));
  const statePath = path.join(tempDir, "state.json");
  const semanticPath = path.join(tempDir, "semantic_memory.json");
  const personalityPath = path.join(tempDir, "personality_profile.json");
  const governancePath = path.join(tempDir, "governance_memory.json");

  const modelClient = new CapturingPlannerModelClient();
  const memoryStore = new SemanticMemoryStore(semanticPath);
  const config = {
    ...DEFAULT_BRAIN_CONFIG,
    dna: {
      ...DEFAULT_BRAIN_CONFIG.dna,
      immutableKeywords: [...DEFAULT_BRAIN_CONFIG.dna.immutableKeywords],
      protectedPathPrefixes: [...DEFAULT_BRAIN_CONFIG.dna.protectedPathPrefixes]
    }
  };
  const capturingStore = new CapturingIngestProfileStore();

  const brain = new BrainOrchestrator(
    config,
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(config),
    createDefaultGovernors(),
    new MasterGovernor(config.governance.supermajorityThreshold),
    new StateStore(statePath),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    new PersonalityStore(personalityPath),
    new GovernanceMemoryStore(governancePath),
    capturingStore as unknown as ProfileMemoryStore
  );

  try {
    const remembered = await brain.rememberConversationProfileInput(
      {
        userInput: "I work with Milo at Northstar Creative.",
        provenance: {
          conversationId: "telegram:chat-1:user-1",
          turnId: "turn_abc123abc123abc123abc123",
          dominantLaneAtWrite: "relationship",
          threadKey: "thread_contacts",
          sourceSurface: "conversation_profile_input",
          sourceFingerprint: "0123456789abcdef0123456789abcdef"
        }
      },
      "2026-03-27T14:05:00.000Z"
    );

    assert.equal(remembered, false);
    assert.equal(capturingStore.lastIngestInput, "I work with Milo at Northstar Creative.");
    assert.equal(capturingStore.lastProvenance?.conversationId, "telegram:chat-1:user-1");
    assert.equal(capturingStore.lastProvenance?.turnId, "turn_abc123abc123abc123abc123");
    assert.equal(capturingStore.lastProvenance?.dominantLaneAtWrite, "relationship");
    assert.equal(capturingStore.lastProvenance?.threadKey, "thread_contacts");
    assert.equal(capturingStore.lastProvenance?.sourceSurface, "conversation_profile_input");
    assert.equal(
      capturingStore.lastProvenance?.sourceFingerprint,
      "0123456789abcdef0123456789abcdef"
    );
    assert.match(
      capturingStore.lastTaskId,
      /^profile_ingest_conversation_profile_input_[a-f0-9]{24}$/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("orchestrator passes session domain context into broker gating for workflow-only requests", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-orch-profile-domain-gate-"));
  const statePath = path.join(tempDir, "state.json");
  const semanticPath = path.join(tempDir, "semantic_memory.json");
  const personalityPath = path.join(tempDir, "personality_profile.json");
  const governancePath = path.join(tempDir, "governance_memory.json");

  const modelClient = new CapturingPlannerModelClient();
  const memoryStore = new SemanticMemoryStore(semanticPath);
  const config = {
    ...DEFAULT_BRAIN_CONFIG,
    dna: {
      ...DEFAULT_BRAIN_CONFIG.dna,
      immutableKeywords: [...DEFAULT_BRAIN_CONFIG.dna.immutableKeywords],
      protectedPathPrefixes: [...DEFAULT_BRAIN_CONFIG.dna.protectedPathPrefixes]
    }
  };
  const capturingStore = new CapturingIngestProfileStore();

  const brain = new BrainOrchestrator(
    config,
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(config),
    createDefaultGovernors(),
    new MasterGovernor(config.governance.supermajorityThreshold),
    new StateStore(statePath),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    new PersonalityStore(personalityPath),
    new GovernanceMemoryStore(governancePath),
    capturingStore as unknown as ProfileMemoryStore
  );

  try {
    await brain.runTask(
      buildTask("Call me when the deployment is done and run the workspace build."),
      {
        conversationDomainContext: buildWorkflowDomainContext()
      }
    );
    assert.equal(capturingStore.lastIngestInput, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("orchestrator recalls Owen contact context across conversation-wrapper turns", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-orch-profile-owen-"));
  const statePath = path.join(tempDir, "state.json");
  const semanticPath = path.join(tempDir, "semantic_memory.json");
  const personalityPath = path.join(tempDir, "personality_profile.json");
  const governancePath = path.join(tempDir, "governance_memory.json");
  const encryptedProfilePath = path.join(tempDir, "profile_memory.secure.json");
  const profileKey = Buffer.alloc(32, 29);

  const modelClient = new CapturingPlannerModelClient();
  const memoryStore = new SemanticMemoryStore(semanticPath);
  const config = {
    ...DEFAULT_BRAIN_CONFIG,
    dna: {
      ...DEFAULT_BRAIN_CONFIG.dna,
      immutableKeywords: [...DEFAULT_BRAIN_CONFIG.dna.immutableKeywords],
      protectedPathPrefixes: [...DEFAULT_BRAIN_CONFIG.dna.protectedPathPrefixes]
    }
  };
  const profileStore = new ProfileMemoryStore(encryptedProfilePath, profileKey, 90);

  const brain = new BrainOrchestrator(
    config,
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(config),
    createDefaultGovernors(),
    new MasterGovernor(config.governance.supermajorityThreshold),
    new StateStore(statePath),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    new PersonalityStore(personalityPath),
    new GovernanceMemoryStore(governancePath),
    profileStore
  );

  const owenNarrativeInput = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: what's my name?",
    "- assistant: your name is Benny.",
    "",
    "Current user request:",
    "I went to school with a guy named Owen, and he also used to work with me at Lantern Studio."
  ].join("\n");

  const owenRecallInput = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: I went to school with a guy named Owen, and he also used to work with me at Lantern Studio.",
    "- assistant: Thanks for sharing that context.",
    "",
    "Current user request:",
    "who is Owen?"
  ].join("\n");

  try {
    await brain.runTask(buildTask(owenNarrativeInput));
    await brain.runTask(buildTask(owenRecallInput));

    const plannerPayload = JSON.parse(modelClient.lastPlannerUserPrompt) as {
      userInput?: string;
    };
    const plannerInput = plannerPayload.userInput ?? "";

    assert.match(plannerInput, /\[AgentFriendProfileContext\]/);
    assert.match(plannerInput, /contact\.owen\.name: Owen/i);
    assert.match(plannerInput, /contact\.owen\.context\.[a-f0-9]+: I went to school with a guy named Owen, and he also used to work with me at Lantern Studio/i);
    assert.doesNotMatch(plannerInput, /contact\.owen\.work_association: Lantern Studio/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("orchestrator exposes bounded remembered-fact review and mutation passthroughs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-orch-profile-fact-review-"));
  const statePath = path.join(tempDir, "state.json");
  const semanticPath = path.join(tempDir, "semantic_memory.json");
  const personalityPath = path.join(tempDir, "personality_profile.json");
  const governancePath = path.join(tempDir, "governance_memory.json");

  const modelClient = new CapturingPlannerModelClient();
  const memoryStore = new SemanticMemoryStore(semanticPath);
  const config = {
    ...DEFAULT_BRAIN_CONFIG,
    dna: {
      ...DEFAULT_BRAIN_CONFIG.dna,
      immutableKeywords: [...DEFAULT_BRAIN_CONFIG.dna.immutableKeywords],
      protectedPathPrefixes: [...DEFAULT_BRAIN_CONFIG.dna.protectedPathPrefixes]
    }
  };
  const fakeBroker = {
    reviewRememberedSituations: async () => [],
    resolveRememberedSituation: async () => null,
    markRememberedSituationWrong: async () => null,
    forgetRememberedSituation: async () => null,
    reviewRememberedFacts: async () =>
      Object.assign(
        [
          {
            factId: "fact_owen_role",
            key: "contact.owen.relationship",
            value: "acquaintance",
            status: "confirmed",
            confidence: 0.88,
            sensitive: false,
            observedAt: "2026-03-30T12:00:00.000Z",
            lastUpdatedAt: "2026-03-30T12:00:00.000Z",
            decisionRecord: buildFactDecisionRecord()
          }
        ],
        {
          hiddenDecisionRecords: [
            buildFactDecisionRecord({
              family: "contact.entity_hint",
              evidenceClass: "user_hint_or_context",
              governanceAction: "support_only_legacy",
              governanceReason: "contact_entity_hint_requires_corroboration",
              disposition: "needs_corroboration",
              answerModeFallback: "report_insufficient_evidence",
              candidateRefs: ["candidate_hint_1"],
              evidenceRefs: ["hint_1"]
            })
          ]
        }
      ),
    correctRememberedFact: async () => ({
      factId: "fact_owen_role",
      key: "contact.owen.relationship",
      value: "friend",
      status: "confirmed",
      confidence: 0.92,
      sensitive: false,
      observedAt: "2026-03-30T12:00:00.000Z",
      lastUpdatedAt: "2026-03-31T12:00:00.000Z",
      mutationEnvelope: buildFactMutationEnvelope()
    }),
    forgetRememberedFact: async () => ({
      factId: "fact_owen_role",
      key: "contact.owen.relationship",
      value: "[redacted]",
      status: "superseded",
      confidence: 0.92,
      sensitive: false,
      observedAt: "2026-03-30T12:00:00.000Z",
      lastUpdatedAt: "2026-03-31T12:05:00.000Z",
      mutationEnvelope: buildFactMutationEnvelope({
        appliedWriteRefs: [],
        redactionState: "value_redacted",
        retraction: {
          family: "generic.profile_fact",
          retractionClass: "forget_or_delete",
          redactionState: "value_redacted",
          clearsCompatibilityProjection: true,
          preservesAuditHandle: true
        }
      })
    })
  } satisfies Pick<
    MemoryBrokerOrgan,
    | "reviewRememberedSituations"
    | "resolveRememberedSituation"
    | "markRememberedSituationWrong"
    | "forgetRememberedSituation"
    | "reviewRememberedFacts"
    | "correctRememberedFact"
    | "forgetRememberedFact"
  >;

  const brain = new BrainOrchestrator(
    config,
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(config),
    createDefaultGovernors(),
    new MasterGovernor(config.governance.supermajorityThreshold),
    new StateStore(statePath),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    new PersonalityStore(personalityPath),
    new GovernanceMemoryStore(governancePath),
    undefined,
    fakeBroker as unknown as MemoryBrokerOrgan
  );

  try {
    const reviewed = await brain.reviewRememberedFacts(
      "review_fact_1",
      "What do you remember about Owen?",
      "2026-03-31T12:10:00.000Z",
      3
    );
    const corrected = await brain.correctRememberedFact(
      "fact_owen_role",
      "friend",
      "memory_correct_1",
      "/memory fact correct fact_owen_role friend",
      "2026-03-31T12:11:00.000Z",
      "Use the newer relationship wording."
    );
    const forgotten = await brain.forgetRememberedFact(
      "fact_owen_role",
      "memory_forget_1",
      "/memory fact forget fact_owen_role",
      "2026-03-31T12:12:00.000Z"
    );

    assert.equal(reviewed[0]?.factId, "fact_owen_role");
    assert.equal(reviewed[0]?.decisionRecord?.family, "generic.profile_fact");
    assert.equal(reviewed.hiddenDecisionRecords[0]?.disposition, "needs_corroboration");
    assert.equal(corrected?.value, "friend");
    assert.equal(
      corrected?.mutationEnvelope?.requestCorrelation.sourceSurface,
      "memory_review_fact"
    );
    assert.equal(forgotten?.status, "superseded");
    assert.equal(
      forgotten?.mutationEnvelope?.retraction?.retractionClass,
      "forget_or_delete"
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("orchestrator continuity read sessions reuse one profile-memory snapshot across fact and episode reads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-orch-profile-continuity-session-"));
  const statePath = path.join(tempDir, "state.json");
  const semanticPath = path.join(tempDir, "semantic_memory.json");
  const personalityPath = path.join(tempDir, "personality_profile.json");
  const governancePath = path.join(tempDir, "governance_memory.json");
  const encryptedProfilePath = path.join(tempDir, "profile_memory.secure.json");
  const profileKey = Buffer.alloc(32, 31);
  const nowIso = "2026-03-26T15:39:10.000Z";

  const modelClient = new CapturingPlannerModelClient();
  const memoryStore = new SemanticMemoryStore(semanticPath);
  const config = {
    ...DEFAULT_BRAIN_CONFIG,
    dna: {
      ...DEFAULT_BRAIN_CONFIG.dna,
      immutableKeywords: [...DEFAULT_BRAIN_CONFIG.dna.immutableKeywords],
      protectedPathPrefixes: [...DEFAULT_BRAIN_CONFIG.dna.protectedPathPrefixes]
    }
  };
  const profileStore = new CountingContinuityProfileStore(encryptedProfilePath, profileKey, 90);
  await profileStore.ingestFromTaskInput(
    "seed-owen",
    "I work with Owen at Lantern Studio. Owen fell down a few weeks ago.",
    nowIso
  );

  const brain = new BrainOrchestrator(
    config,
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(config),
    createDefaultGovernors(),
    new MasterGovernor(config.governance.supermajorityThreshold),
    new StateStore(statePath),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    new PersonalityStore(personalityPath),
    new GovernanceMemoryStore(governancePath),
    profileStore
  );

  try {
    profileStore.loadCount = 0;
    const readSession = await brain.openContinuityReadSession(createEmptyEntityGraphV1(nowIso));
    assert.ok(readSession);

    const facts = await readSession?.queryContinuityFacts(
      createEmptyConversationStackV1(nowIso),
      ["owen"],
      3,
      {
        semanticMode: "relationship_inventory",
        relevanceScope: "conversation_local",
        asOfObservedTime: nowIso
      }
    );
    const episodes = await readSession?.queryContinuityEpisodes(
      createEmptyConversationStackV1(nowIso),
      ["owen"],
      3,
      {
        semanticMode: "event_history",
        relevanceScope: "thread_local",
        asOfObservedTime: nowIso
      }
    );

    assert.equal(profileStore.loadCount, 1);
    assert.ok((facts ?? []).some((fact) => fact.key.startsWith("contact.owen.")));
    assert.ok(Array.isArray(episodes));
    assert.equal(profileStore.lastFactContinuityRequest?.semanticMode, "relationship_inventory");
    assert.equal(profileStore.lastFactContinuityRequest?.relevanceScope, "conversation_local");
    assert.equal(profileStore.lastFactContinuityRequest?.asOfObservedTime, nowIso);
    assert.equal(profileStore.lastEpisodeContinuityRequest?.semanticMode, "event_history");
    assert.equal(profileStore.lastEpisodeContinuityRequest?.relevanceScope, "thread_local");
    assert.equal(profileStore.lastEpisodeContinuityRequest?.asOfObservedTime, nowIso);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
