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
import type {
  ProfileReadableEpisode,
  ProfileReadableFact
} from "../../src/core/profileMemoryRuntime/contracts";
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

  /**
 * Implements `ingestFromTaskInput` behavior within class CapturingIngestProfileStore.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async ingestFromTaskInput(
    _taskId: string,
    userInput: string
  ): Promise<{ appliedFacts: number; supersededFacts: number }> {
    this.lastIngestInput = userInput;
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

test("orchestrator redacts sensitive profile fields before planner model egress", async () => {
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
    assert.match(plannerInput, /\[AgentFriendProfileEgressGuard\]/);
    assert.match(plannerInput, /redactedSensitiveFields=2/);
    assert.match(plannerInput, /contact\.email: \[REDACTED\]/);
    assert.match(plannerInput, /contact\.phone: \[REDACTED\]/);
    assert.match(plannerInput, /employment\.current: Lantern/);
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
    assert.match(plannerInput, /contact\.owen\.relationship: work_peer/i);
    assert.match(plannerInput, /contact\.owen\.work_association: Lantern Studio/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
