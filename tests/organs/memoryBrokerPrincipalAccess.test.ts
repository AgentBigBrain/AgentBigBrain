/**
 * @fileoverview Tests broker profile-memory access requires owner-capable principal metadata.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import type { TaskRequest } from "../../src/core/types";
import { MemoryAccessAuditStore } from "../../src/core/memoryAccessAudit";
import { MemoryBrokerOrgan } from "../../src/organs/memoryBroker";
import {
  buildTaskExecutionPrincipalAccess,
  derivePrincipalContextFromIngress
} from "../../src/interfaces/principalRuntime/principalAccess";
import { createOwnerOperatorPrincipalConfigFromEnv } from "../../src/interfaces/principalRuntime/principalConfig";

function wrapResolvedMemoryRoute(userInput: string): string {
  return [
    "Resolved semantic route:",
    "- routeId: memory_context",
    "- source: test_route_metadata",
    "- confidence: high",
    "- memoryIntent: relationship_recall",
    "",
    "Current user request:",
    userInput
  ].join("\n");
}

function buildOwnerTask(id: string, userInput: string): TaskRequest {
  const principalConfig = createOwnerOperatorPrincipalConfigFromEnv({
    BRAIN_PRINCIPAL_HMAC_KEY: "test-principal-hmac-key",
    BRAIN_OWNER_TELEGRAM_USER_IDS: "synthetic-provider-principal"
  });
  return {
    id,
    goal: "Provide safe and helpful assistance.",
    userInput: wrapResolvedMemoryRoute(userInput),
    createdAt: "2026-05-10T12:00:00.000Z",
    principalAccess: buildTaskExecutionPrincipalAccess(
      derivePrincipalContextFromIngress({
        provider: "telegram",
        conversationId: "chat-1",
        userId: "synthetic-provider-principal",
        username: "owner",
        conversationVisibility: "private",
        receivedAt: "2026-05-10T12:00:00.000Z",
        principalConfig
      })
    )
  };
}

class PrincipalAwareBrokerStore {
  public ingestCalls = 0;
  public readSessionCalls = 0;

  async ingestFromTaskInput(): Promise<{ appliedFacts: number; supersededFacts: number }> {
    this.ingestCalls += 1;
    return { appliedFacts: 0, supersededFacts: 0 };
  }

  async openReadSession() {
    this.readSessionCalls += 1;
    return {
      getPlanningContext: () =>
        "- identity.preferred_name: Sample (status=confirmed, observedAt=2026-05-10T12:00:00.000Z)",
      getEpisodePlanningContext: () => "",
      queryFactsForPlanningContext: () => [],
      queryEpisodesForPlanningContext: () => []
    };
  }
}

async function withAuditStore(
  callback: (store: MemoryAccessAuditStore) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-broker-principal-audit-"));
  const auditStore = new MemoryAccessAuditStore(path.join(tempDir, "memory_access_log.json"));
  try {
    await callback(auditStore);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("broker does not inject owner profile memory for missing-principal task", async () => {
  const store = new PrincipalAwareBrokerStore();
  const broker = new MemoryBrokerOrgan(
    store as unknown as ProfileMemoryStore,
    new MemoryAccessAuditStore()
  );
  const task: TaskRequest = {
    id: "task_missing_principal_memory",
    goal: "Provide safe and helpful assistance.",
    userInput: wrapResolvedMemoryRoute("who is the saved contact?"),
    createdAt: "2026-05-10T12:00:00.000Z"
  };

  const result = await broker.buildPlannerInput(task);

  assert.equal(result.profileMemoryStatus, "available");
  assert.equal(result.userInput, task.userInput);
  assert.equal(store.ingestCalls, 0);
  assert.equal(store.readSessionCalls, 0);
});

test("broker may inject owner profile memory for owner-principal task", async () => {
  const store = new PrincipalAwareBrokerStore();
  const broker = new MemoryBrokerOrgan(
    store as unknown as ProfileMemoryStore,
    new MemoryAccessAuditStore()
  );

  const result = await broker.buildPlannerInput(
    buildOwnerTask("task_owner_principal_memory", "who is the saved contact?")
  );

  assert.equal(result.profileMemoryStatus, "available");
  assert.match(result.userInput, /\[AgentFriendProfileContext\]/);
  assert.match(result.userInput, /identity\.preferred_name: Sample/);
  assert.equal(store.ingestCalls, 1);
  assert.equal(store.readSessionCalls, 1);
});

test("broker audit records redacted principal access labels", async () => {
  await withAuditStore(async (auditStore) => {
    const store = new PrincipalAwareBrokerStore();
    const broker = new MemoryBrokerOrgan(store as unknown as ProfileMemoryStore, auditStore);

    await broker.buildPlannerInput(
      buildOwnerTask("task_owner_principal_memory_audit", "who is the saved contact?")
    );

    const document = await auditStore.load();
    assert.equal(document.events.length, 1);
    const [event] = document.events;
    assert.equal(event.principalRole, "owner");
    assert.equal(event.routeVisibility, "private");
    assert.equal(event.accessOperation, "task_execution");
    assert.equal(event.accessClass, "owner_private");
    assert.equal(event.accessAllowed, true);
    assert.equal(event.accessReason, "owner_principal_matched");
    assert.equal(event.identityAuthority, "configured_owner_provider_user_id");
    assert.equal(event.legacyIdentityState, "principal_verified");
    assert.equal(event.ownerMatchSource, "provider_user_id");
  });
});
