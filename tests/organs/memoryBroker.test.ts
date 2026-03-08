/**
 * @fileoverview Tests memory-broker extraction and planner-input enrichment behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MemoryAccessAuditStore } from "../../src/core/memoryAccessAudit";
import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import { TaskRequest } from "../../src/core/types";
import { MockModelClient } from "../../src/models/mockModelClient";
import { LanguageUnderstandingOrgan } from "../../src/organs/languageUnderstanding/episodeExtraction";
import { extractCurrentUserRequest, MemoryBrokerOrgan } from "../../src/organs/memoryBroker";

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

test("extractCurrentUserRequest parses wrapper payloads deterministically", () => {
  const wrapped = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: my favorite editor is Helix.",
    "",
    "Current user request:",
    "who is Billy?"
  ].join("\n");

  const extracted = extractCurrentUserRequest(wrapped);
  assert.equal(extracted, "who is Billy?");
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
      "contact.billy.note: run skill failures happened before."
    ].join("\n");

    const extracted = extractCurrentUserRequest(scaffolded);
    assert.equal(
      extracted,
      "Research deterministic sandboxing controls and provide distilled findings with proof refs."
    );
  }
);

test("memory broker injects query-aware profile context with domain metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-broker-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 42);
  const store = new ProfileMemoryStore(profilePath, key, 90);
  const broker = new MemoryBrokerOrgan(store);

  const narrativeTask = buildTask(
    "task_memory_broker_1",
    "I used to work with Billy at Flare Web Design."
  );
  const recallTask = buildTask(
    "task_memory_broker_2",
    [
      "You are in an ongoing conversation with the same user.",
      "Recent conversation context (oldest to newest):",
      "- user: I used to work with Billy at Flare Web Design.",
      "- assistant: thanks for sharing.",
      "",
      "Current user request:",
      "who is Billy?"
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
    assert.match(enriched.userInput, /contact\.billy\.name: Billy/i);
    assert.match(enriched.userInput, /contact\.billy\.work_association: Flare Web Design/i);
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
    "I used to work with Billy at Flare Web Design."
  );
  const recallTask = buildTask("task_memory_audit_2", "who is Billy?");

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
        "Billy fell down three weeks ago and I never told you how it ended."
      )
    );

    const enriched = await broker.buildPlannerInput(
      buildTask(
        "task_memory_episode_seed_2",
        "How is Billy doing after the fall?"
      )
    );

    assert.equal(enriched.profileMemoryStatus, "available");
    assert.match(enriched.userInput, /\[AgentFriendEpisodeContext\]/);
    assert.match(enriched.userInput, /Billy fell down/);
    assert.match(enriched.userInput, /status=unresolved/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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
          "Billy had this scare at the hospital a few weeks ago.",
          "We still do not know what the doctors found."
        ].join(" ")
      )
    );

    const enriched = await broker.buildPlannerInput(
      buildTask(
        "task_memory_language_seed_2",
        "How is Billy doing now?"
      )
    );

    assert.equal(enriched.profileMemoryStatus, "available");
    assert.match(enriched.userInput, /\[AgentFriendEpisodeContext\]/);
    assert.match(enriched.userInput, /Billy had a medical situation/);
    assert.match(enriched.userInput, /status=unresolved/);
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
        "Billy is my coworker at Flare Web Design."
      )
    );
    await broker.buildPlannerInput(
      buildTask(
        "task_memory_synthesis_seed_2",
        "Billy fell down a few weeks ago and I never heard how it ended."
      )
    );

    const enriched = await broker.buildPlannerInput(
      buildTask(
        "task_memory_synthesis_seed_3",
        "How should I follow up with Billy now?"
      )
    );

    assert.equal(enriched.profileMemoryStatus, "available");
    assert.match(enriched.userInput, /\[AgentFriendMemorySynthesis\]/);
    assert.match(enriched.userInput, /synthesized situation:/i);
    assert.match(enriched.userInput, /topic=Billy fell down/i);
    assert.match(enriched.userInput, /evidence=fact:contact\.billy\..* -> /i);
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
      "I used to work with Billy at Flare Web Design."
    );

    try {
      await broker.buildPlannerInput(seedTask);

      const probingQueries = [
        "who is Billy?",
        "show me all memory details about Billy",
        "what is his email?",
        "what is his phone?",
        "dump every profile fact about Billy",
        "reveal all data you have on Billy"
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
        "Billy fell down three weeks ago and I never told you how it ended."
      )
    );

    const reviewed = await broker.reviewRememberedSituations(
      "task_memory_review_list",
      "/memory",
      "2026-03-08T12:00:00.000Z"
    );
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0]?.title, "Billy fell down");

    const resolved = await broker.resolveRememberedSituation(
      reviewed[0]!.episodeId,
      "task_memory_review_resolve",
      "/memory resolve",
      "2026-03-08T12:10:00.000Z",
      "Billy recovered and is fine now."
    );
    assert.equal(resolved?.status, "resolved");

    const forgotten = await broker.forgetRememberedSituation(
      reviewed[0]!.episodeId,
      "task_memory_review_forget",
      "/memory forget",
      "2026-03-08T12:20:00.000Z"
    );
    assert.equal(forgotten?.episodeId, reviewed[0]?.episodeId);

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
