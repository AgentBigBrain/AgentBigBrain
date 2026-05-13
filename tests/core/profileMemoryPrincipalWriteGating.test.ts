/**
 * @fileoverview Tests principal-aware profile-memory write gating.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import { buildProfileMemoryIngestPolicy } from "../../src/core/profileMemoryRuntime/profileMemoryIngestPolicy";
import {
  buildTaskExecutionPrincipalAccess,
  derivePrincipalContextFromIngress
} from "../../src/interfaces/principalRuntime/principalAccess";
import { createOwnerOperatorPrincipalConfigFromEnv } from "../../src/interfaces/principalRuntime/principalConfig";

const PRINCIPAL_KEY = "test-principal-hmac-key";
const OBSERVED_AT = "2026-05-10T12:00:00.000Z";

function buildOwnerAccess() {
  const principalConfig = createOwnerOperatorPrincipalConfigFromEnv({
    BRAIN_PRINCIPAL_HMAC_KEY: PRINCIPAL_KEY,
    BRAIN_OWNER_TELEGRAM_USER_IDS: "owner-user-1"
  });
  return buildTaskExecutionPrincipalAccess(
    derivePrincipalContextFromIngress({
      provider: "telegram",
      conversationId: "chat-1",
      userId: "owner-user-1",
      username: "owner",
      conversationVisibility: "private",
      receivedAt: OBSERVED_AT,
      principalConfig
    })
  );
}

function buildParticipantAccess() {
  return buildTaskExecutionPrincipalAccess(
    derivePrincipalContextFromIngress({
      provider: "telegram",
      conversationId: "chat-1",
      userId: "participant-user-1",
      username: "participant",
      conversationVisibility: "private",
      receivedAt: OBSERVED_AT,
      allowedUsernames: ["participant"]
    })
  );
}

test("profile-memory ingest blocks non-owner writes to owner profile", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-principal-write-"));
  const profilePath = path.join(tempDir, "profile_memory.secure.json");
  const store = new ProfileMemoryStore(profilePath, Buffer.alloc(32, 11), 90);
  const ingestPolicy = buildProfileMemoryIngestPolicy({
    memoryIntent: "profile_update",
    sourceSurface: "conversation_profile_input"
  });

  try {
    const blocked = await store.ingestFromTaskInput(
      "task_non_owner_owner_write",
      "My name is Sample.",
      OBSERVED_AT,
      {
        principalAccess: buildParticipantAccess(),
        requestedSubjectKind: "owner_profile",
        ingestPolicy
      }
    );
    const allowed = await store.ingestFromTaskInput(
      "task_owner_owner_write",
      "My name is Sample.",
      OBSERVED_AT,
      {
        principalAccess: buildOwnerAccess(),
        requestedSubjectKind: "owner_profile",
        ingestPolicy
      }
    );
    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      principalAccess: buildOwnerAccess(),
      requestedSubjectKind: "owner_profile"
    });

    assert.equal(blocked.appliedFacts, 0);
    assert.equal(allowed.appliedFacts, 1);
    assert.equal(facts.find((fact) => fact.key === "identity.preferred_name")?.value, "Sample");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
