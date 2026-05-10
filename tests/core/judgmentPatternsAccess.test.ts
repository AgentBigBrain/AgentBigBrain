/**
 * @fileoverview Tests principal/access classification for judgment-pattern learning hints.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { JudgmentPatternStore } from "../../src/core/judgmentPatterns";
import type { TaskPrincipalAccessEnvelope } from "../../src/core/types";

function buildPrincipalAccess(input: {
  role: string;
  providerUserIdHash: string;
  accessClass: string;
}): TaskPrincipalAccessEnvelope {
  return {
    principalContext: {
      requestId: `request_judgment_${input.role}_${input.providerUserIdHash}`,
      actor: {
        principalRole: input.role,
        identityAuthority: "configured_provider_user_id",
        legacyIdentityState: "principal_verified",
        ownerMatchSource: input.role === "owner" ? "provider_user_id" : "none",
        providerUserIdHash: input.providerUserIdHash
      },
      route: {
        visibility: "private"
      },
      subject: {}
    },
    accessDecision: {
      decisionId: `decision_judgment_${input.role}_${input.providerUserIdHash}`,
      requestId: `request_judgment_${input.role}_${input.providerUserIdHash}`,
      operation: "task_execution",
      accessClass: input.accessClass,
      allowed: true,
      reason: "synthetic_judgment_principal"
    }
  };
}

async function withJudgmentStore(
  callback: (store: JudgmentPatternStore) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-judgment-access-"));
  try {
    await callback(new JudgmentPatternStore(path.join(tempDir, "judgment_patterns.json")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("judgment patterns persist access metadata and gate private hints by principal", async () => {
  await withJudgmentStore(async (store) => {
    const ownerAccess = buildPrincipalAccess({
      role: "owner",
      providerUserIdHash: "hash_judgment_owner",
      accessClass: "owner_private"
    });
    const otherAccess = buildPrincipalAccess({
      role: "allowed_user",
      providerUserIdHash: "hash_judgment_other",
      accessClass: "session_only"
    });

    const ownerPattern = await store.recordPattern({
      sourceTaskId: "task_judgment_owner",
      context: "choose safe release path",
      options: "respond",
      choice: "respond",
      rationale: "bounded response",
      riskPosture: "balanced",
      principalAccess: ownerAccess
    });
    assert.equal(ownerPattern.accessMetadata?.classification, "owner_private");

    const noPrincipalHints = await store.getRelevantPatterns("choose safe release path", 3);
    const otherHints = await store.getRelevantPatterns("choose safe release path", 3, {
      principalAccess: otherAccess
    });
    const ownerHints = await store.getRelevantPatterns("choose safe release path", 3, {
      principalAccess: ownerAccess
    });

    assert.equal(noPrincipalHints.length, 0);
    assert.equal(otherHints.length, 0);
    assert.equal(ownerHints.length, 1);
    assert.equal(ownerHints[0]?.id, ownerPattern.id);
  });
});
