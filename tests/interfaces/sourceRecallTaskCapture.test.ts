/**
 * @fileoverview Tests for Source Recall capture from persisted conversation jobs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  SourceRecallChunk,
  SourceRecallRecord
} from "../../src/core/sourceRecall/contracts";
import { createDefaultSourceRecallRetentionPolicy } from "../../src/core/sourceRecall/sourceRecallRetention";
import { captureConversationJobSourceRecall } from "../../src/interfaces/conversationRuntime/sourceRecallTaskCapture";
import { buildConversationJobPrincipalSnapshotFromAccess } from "../../src/interfaces/conversationRuntime/conversationJobPrincipalSnapshot";
import {
  buildTaskExecutionPrincipalAccess,
  derivePrincipalContextFromIngress
} from "../../src/interfaces/principalRuntime/principalAccess";
import { createOwnerOperatorPrincipalConfigFromEnv } from "../../src/interfaces/principalRuntime/principalConfig";
import {
  buildConversationJobFixture,
  buildConversationSessionFixture
} from "../helpers/conversationFixtures";
import { buildTestOwnerTaskPrincipalAccess } from "../helpers/principalAccess";

test("captureConversationJobSourceRecall suppresses task capture for legacy job-origin snapshots", async () => {
  const records: SourceRecallRecord[] = [];
  const chunks: SourceRecallChunk[] = [];
  const session = buildConversationSessionFixture();
  const job = buildConversationJobFixture({
    status: "completed",
    resultSummary: "Synthetic task completed."
  });

  const result = await captureConversationJobSourceRecall({
    session,
    job,
    sourceRecallCapture: {
      policy: buildJobCapturePolicy(),
      writer: {
        async upsertSourceRecord(record, recordChunks) {
          records.push(record);
          chunks.push(...recordChunks);
        }
      },
      capturedAt: "2026-05-10T12:00:00.000Z"
    }
  });

  assert.equal(result.taskInputResult, null);
  assert.equal(result.taskSummaryResult, null);
  assert.equal(result.assistantTurnResult, null);
  assert.equal(records.length, 0);
  assert.equal(chunks.length, 0);
});

test("captureConversationJobSourceRecall records redacted job-origin principal metadata when verified", async () => {
  const records: SourceRecallRecord[] = [];
  const principalAccess = buildTestOwnerTaskPrincipalAccess();
  const session = buildConversationSessionFixture({
    principalContext: principalAccess.principalContext
  });
  const job = buildConversationJobFixture({
    status: "completed",
    resultSummary: "Synthetic task completed.",
    principalSnapshot: buildConversationJobPrincipalSnapshotFromAccess(principalAccess)
  });

  const result = await captureConversationJobSourceRecall({
    session,
    job,
    sourceRecallCapture: {
      policy: buildJobCapturePolicy(),
      writer: {
        async upsertSourceRecord(record) {
          records.push(record);
        }
      },
      capturedAt: "2026-05-10T12:00:00.000Z"
    }
  });

  assert.equal(result.taskInputResult?.status, "captured");
  assert.equal(records[0]?.principalMetadata?.actorPrincipalRole, "owner");
  assert.equal(records[0]?.principalMetadata?.accessOperation, "source_recall_capture");
  assert.equal(records[0]?.principalMetadata?.accessClass, "owner_private");
  assert.equal(records[0]?.threadId.includes(principalAccess.principalContext.actor.providerUserIdHash ?? ""), true);
  assert.equal(JSON.stringify(records[0]?.principalMetadata).includes("owner-user-1"), false);
});

test("captureConversationJobSourceRecall uses job-origin principal over current session principal", async () => {
  const records: SourceRecallRecord[] = [];
  const ownerAccess = buildTestOwnerTaskPrincipalAccess();
  const nonOwnerAccess = buildTaskExecutionPrincipalAccess(
    derivePrincipalContextFromIngress({
      provider: "telegram",
      conversationId: "test-private-chat",
      userId: "different-user-1",
      username: "different",
      conversationVisibility: "private",
      receivedAt: "2026-05-10T12:05:00.000Z",
      principalConfig: createOwnerOperatorPrincipalConfigFromEnv({
        BRAIN_PRINCIPAL_HMAC_KEY: "test-principal-hmac-key",
        BRAIN_OWNER_TELEGRAM_USER_IDS: "owner-user-1"
      })
    })
  );
  const session = buildConversationSessionFixture({
    principalContext: nonOwnerAccess.principalContext
  });
  const job = buildConversationJobFixture({
    status: "completed",
    resultSummary: "Synthetic delayed task completed.",
    principalSnapshot: buildConversationJobPrincipalSnapshotFromAccess(ownerAccess)
  });

  await captureConversationJobSourceRecall({
    session,
    job,
    sourceRecallCapture: {
      policy: buildJobCapturePolicy(),
      writer: {
        async upsertSourceRecord(record) {
          records.push(record);
        }
      },
      capturedAt: "2026-05-10T12:06:00.000Z"
    }
  });

  assert.equal(records[0]?.principalMetadata?.actorPrincipalRole, "owner");
  assert.equal(
    records[0]?.principalMetadata?.actorProviderUserIdHash,
    ownerAccess.principalContext.actor.providerUserIdHash
  );
  assert.notEqual(
    records[0]?.principalMetadata?.actorProviderUserIdHash,
    nonOwnerAccess.principalContext.actor.providerUserIdHash
  );
  assert.equal(records[0]?.threadId.includes(ownerAccess.principalContext.actor.providerUserIdHash ?? ""), true);
});

/**
 * Builds the narrow test-only policy for lower-authority job source capture.
 */
function buildJobCapturePolicy() {
  return {
    ...createDefaultSourceRecallRetentionPolicy(),
    enabled: true,
    captureEnabled: true,
    encryptedPayloadsAvailable: true,
    sourceKindCaptureAllowlist: [
      "assistant_turn",
      "task_input",
      "task_summary"
    ] as const,
    captureClassAllowlist: [
      "assistant_output",
      "operational_output"
    ] as const
  };
}
