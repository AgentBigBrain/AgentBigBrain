/**
 * @fileoverview Tests redacted principal/access metadata on execution receipts.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ExecutionReceiptStore } from "../../src/core/executionReceipts";
import type { ActionRunResult, TaskPrincipalAccessEnvelope } from "../../src/core/types";

const SYNTHETIC_PROVIDER_HASH_SENTINEL = "synthetic-provider-hash-not-rendered";

test("json execution receipts persist redacted principal access metadata without raw ids", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-receipt-principal-"));
  const receiptPath = path.join(tempDir, "execution_receipts.json");
  const store = new ExecutionReceiptStore(receiptPath);

  try {
    const receipt = await store.appendApprovedActionReceipt({
      taskId: "task_receipt_principal",
      planTaskId: "plan_receipt_principal",
      proposalId: null,
      actionResult: buildApprovedRespondResult(),
      principalAccess: buildPrincipalAccess()
    });
    const document = await store.load();
    const verification = await store.verifyChain();

    assert.equal(verification.valid, true);
    assert.equal(receipt.principalAccess?.principalRole, "owner");
    assert.equal(document.receipts[0]?.principalAccess?.accessClass, "owner_private");
    assert.equal(document.receipts[0]?.principalAccess?.accessAllowed, true);
    assert.equal(JSON.stringify(document).includes(SYNTHETIC_PROVIDER_HASH_SENTINEL), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("sqlite execution receipts persist redacted principal access metadata without raw ids", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-receipt-principal-sqlite-"));
  const receiptPath = path.join(tempDir, "execution_receipts.json");
  const sqlitePath = path.join(tempDir, "execution_receipts.sqlite");
  const store = new ExecutionReceiptStore(receiptPath, {
    backend: "sqlite",
    sqlitePath
  });

  try {
    await store.appendApprovedActionReceipt({
      taskId: "task_receipt_principal_sqlite",
      planTaskId: "plan_receipt_principal_sqlite",
      proposalId: null,
      actionResult: buildApprovedRespondResult(),
      principalAccess: buildPrincipalAccess()
    });
    const reloadedStore = new ExecutionReceiptStore(receiptPath, {
      backend: "sqlite",
      sqlitePath
    });
    const document = await reloadedStore.load();
    const verification = await reloadedStore.verifyChain();

    assert.equal(verification.valid, true);
    assert.equal(document.receipts[0]?.principalAccess?.principalRole, "owner");
    assert.equal(document.receipts[0]?.principalAccess?.accessOperation, "task_execution");
    assert.equal(document.receipts[0]?.principalAccess?.routeVisibility, "private");
    assert.equal(JSON.stringify(document).includes(SYNTHETIC_PROVIDER_HASH_SENTINEL), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function buildPrincipalAccess(): TaskPrincipalAccessEnvelope {
  return {
    principalContext: {
      requestId: "request_receipt_principal",
      actor: {
        principalRole: "owner",
        identityAuthority: "configured_owner_provider_user_id",
        legacyIdentityState: "principal_verified",
        ownerMatchSource: "provider_user_id",
        providerUserIdHash: SYNTHETIC_PROVIDER_HASH_SENTINEL
      },
      route: {
        visibility: "private"
      },
      subject: {}
    },
    accessDecision: {
      decisionId: "decision_receipt_principal",
      requestId: "request_receipt_principal",
      operation: "task_execution",
      accessClass: "owner_private",
      allowed: true,
      reason: "owner_principal_matched"
    }
  };
}

function buildApprovedRespondResult(): ActionRunResult {
  return {
    action: {
      id: "action_receipt_principal",
      type: "respond",
      description: "Synthetic approved response for principal receipt metadata.",
      params: {
        message: "Synthetic response complete."
      },
      estimatedCostUsd: 0
    },
    mode: "fast_path",
    approved: true,
    output: "Synthetic response complete.",
    executionStatus: "success",
    executionMetadata: {
      synthetic: true
    },
    blockedBy: [],
    violations: [],
    votes: [
      {
        governorId: "logic",
        approve: true,
        reason: "Synthetic test approval.",
        confidence: 1
      }
    ],
    decision: {
      approved: true,
      yesVotes: 1,
      noVotes: 0,
      threshold: 1,
      dissent: []
    }
  };
}
