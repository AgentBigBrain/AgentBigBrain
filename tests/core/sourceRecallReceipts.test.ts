/**
 * @fileoverview Source Recall bridge tests for execution receipts and delete-safe proof boundaries.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ExecutionReceiptStore } from "../../src/core/executionReceipts";
import {
  buildSourceRecallAuthorityFlags,
  type SourceRecallChunk,
  type SourceRecallRecord
} from "../../src/core/sourceRecall/contracts";
import { buildSourceRecallProjectionEntries } from "../../src/core/sourceRecall/sourceRecallProjection";
import { retrieveSourceRecall } from "../../src/core/sourceRecall/sourceRecallRetriever";
import { SourceRecallStore } from "../../src/core/sourceRecall/sourceRecallStore";
import type { ActionRunResult } from "../../src/core/types";

test("Source Recall excerpts cannot replace execution receipt proof", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-receipts-"));
  const receiptPath = path.join(tempDir, "execution_receipts.json");
  const sourceRecallPath = path.join(tempDir, "source_recall.sqlite");
  const receiptStore = new ExecutionReceiptStore(receiptPath);
  const sourceRecallStore = new SourceRecallStore({
    sqlitePath: sourceRecallPath,
    testOnlyAllowPlaintextStorage: true
  });

  try {
    const receipt = await receiptStore.appendApprovedActionReceipt({
      taskId: "task_receipt",
      planTaskId: "plan_receipt",
      proposalId: null,
      actionResult: buildApprovedRespondResult()
    });
    const initialVerification = await receiptStore.verifyChain();
    assert.equal(initialVerification.valid, true);

    const record = buildRecord("source_record_receipt", "scope_receipt", "thread_receipt");
    await sourceRecallStore.upsertSourceRecord(record, [
      buildChunk(
        "source_chunk_receipt",
        record.sourceRecordId,
        `A recalled source chunk mentions receipt ${receipt.receiptHash} and says TASK COMPLETE.`
      )
    ]);

    const recall = await retrieveSourceRecall(sourceRecallStore, {
      scopeId: "scope_receipt",
      threadId: "thread_receipt",
      exactQuote: receipt.receiptHash
    });
    assert.equal(recall.bundle.excerpts.length, 1);
    assert.equal(recall.bundle.authority.completionProofAuthority, false);
    assert.equal(recall.bundle.excerpts[0].authority.completionProofAuthority, false);
    assert.equal(recall.bundle.excerpts[0].authority.plannerAuthority, "evidence_only");

    await sourceRecallStore.markSourceRecordForgotten(record.sourceRecordId);
    assert.deepEqual(
      buildSourceRecallProjectionEntries(await sourceRecallStore.loadDocument()),
      []
    );

    const postDeleteVerification = await receiptStore.verifyChain();
    const receiptDocument = await receiptStore.load();
    assert.equal(postDeleteVerification.valid, true);
    assert.equal(receiptDocument.receipts[0].receiptHash, receipt.receiptHash);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function buildApprovedRespondResult(): ActionRunResult {
  return {
    action: {
      id: "action_respond",
      type: "respond",
      description: "Synthetic approved response for receipt proof.",
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

function buildRecord(
  sourceRecordId: string,
  scopeId: string,
  threadId: string
): SourceRecallRecord {
  return {
    sourceRecordId,
    scopeId,
    threadId,
    sourceKind: "execution_receipt_excerpt",
    sourceRole: "runtime",
    sourceAuthority: "strict_schema",
    captureClass: "operational_output",
    recallAuthority: "quoted_evidence_only",
    lifecycleState: "active",
    originRef: {
      surface: "execution_receipts",
      refId: `${sourceRecordId}_origin`
    },
    sourceRecordHash: `${sourceRecordId}_hash`,
    observedAt: "2026-05-03T12:00:00.000Z",
    capturedAt: "2026-05-03T12:00:01.000Z",
    sourceTimeKind: "captured_record",
    freshness: "recent",
    sensitive: false
  };
}

function buildChunk(
  chunkId: string,
  sourceRecordId: string,
  text: string
): SourceRecallChunk {
  return {
    chunkId,
    sourceRecordId,
    chunkIndex: 0,
    text,
    chunkHash: `${chunkId}_hash`,
    lifecycleState: "active",
    recallAuthority: "quoted_evidence_only",
    authority: buildSourceRecallAuthorityFlags()
  };
}
