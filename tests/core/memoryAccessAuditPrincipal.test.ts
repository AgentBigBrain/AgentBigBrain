/**
 * @fileoverview Principal/access metadata coverage for memory-access audit persistence.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MemoryAccessAuditStore } from "../../src/core/memoryAccessAudit";

async function withAuditStore(
  callback: (store: MemoryAccessAuditStore, auditPath: string) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-principal-audit-"));
  const auditPath = path.join(tempDir, "memory_access_log.json");
  const store = new MemoryAccessAuditStore(auditPath);

  try {
    await callback(store, auditPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("MemoryAccessAuditStore persists redacted principal access labels only", async () => {
  await withAuditStore(async (store, auditPath) => {
    await store.appendEvent({
      taskId: "task_principal_audit",
      query: "private query text should be hashed",
      retrievedCount: 1,
      retrievedEpisodeCount: 0,
      redactedCount: 0,
      domainLanes: ["profile"],
      principalAudit: {
        principalRole: "owner",
        routeVisibility: "private",
        accessOperation: "task_execution",
        accessClass: "owner_private",
        accessAllowed: true,
        accessReason: "owner_principal_matched",
        identityAuthority: "configured_owner_provider_user_id",
        legacyIdentityState: "principal_verified",
        ownerMatchSource: "provider_user_id"
      }
    });

    const document = await store.load();
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

    const persisted = await readFile(auditPath, "utf8");
    assert.doesNotMatch(persisted, /private query text should be hashed/i);
    assert.doesNotMatch(persisted, /synthetic-provider-principal/i);
    assert.doesNotMatch(persisted, /synthetic-provider-route/i);
  });
});

test("MemoryAccessAuditStore drops malformed principal audit labels", async () => {
  await withAuditStore(async (store) => {
    await store.appendEvent({
      taskId: "task_malformed_principal_audit",
      query: "synthetic query",
      retrievedCount: 0,
      retrievedEpisodeCount: 0,
      redactedCount: 0,
      domainLanes: ["unknown"],
      principalAudit: {
        principalRole: "owner",
        routeVisibility: "private",
        accessOperation: "task_execution raw provider id synthetic-provider-principal",
        accessClass: "owner_private",
        accessAllowed: true,
        accessReason: "owner_principal_matched",
        identityAuthority: "configured_owner_provider_user_id",
        legacyIdentityState: "principal_verified",
        ownerMatchSource: "provider_user_id"
      }
    });

    const document = await store.load();
    assert.equal(document.events.length, 1);
    const [event] = document.events;
    assert.equal(event.principalRole, undefined);
    assert.equal(event.accessOperation, undefined);
    assert.equal(event.accessClass, undefined);
  });
});
