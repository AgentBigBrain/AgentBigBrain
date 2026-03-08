/**
 * @fileoverview Tests shared interface checkpoint-review routing to guarantee Telegram/Discord `/review` parity, including Stage 6.75.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GatewayCheckpointReviewRunners,
  runGatewayCheckpointReview
} from "../../src/interfaces/checkpointReviewRouting";
import type { ConversationCheckpointReviewResult } from "../../src/interfaces/conversationRuntime/managerContracts";

/**
 * Builds a deterministic review result payload for routing tests.
 *
 * **Why it exists:**
 * Keeps test fixtures compact while preserving the runtime result shape expected by
 * conversation command-policy flow.
 *
 * **What it talks to:**
 * - Uses `ConversationCheckpointReviewResult` type from `conversationRuntime/managerContracts`.
 *
 * @param checkpointId - Checkpoint id to embed in the fixture payload.
 * @returns Review result fixture with deterministic values.
 */
function buildReviewResult(checkpointId: string): ConversationCheckpointReviewResult {
  return {
    checkpointId,
    overallPass: true,
    artifactPath: `runtime/evidence/${checkpointId}.json`,
    summaryLines: [`checkpoint ${checkpointId}`]
  };
}

test("runGatewayCheckpointReview keeps deterministic 6.11/6.13/6.75 routing parity", async () => {
  let calls611 = 0;
  let calls613 = 0;
  let calls675 = 0;
  let calls685 = 0;

  const runners: GatewayCheckpointReviewRunners = {
    runCheckpoint611LiveReview: async () => {
      calls611 += 1;
      return buildReviewResult("6.11");
    },
    runCheckpoint613LiveReview: async () => {
      calls613 += 1;
      return buildReviewResult("6.13");
    },
    runCheckpoint675LiveReview: async () => {
      calls675 += 1;
      return {
        checkpointId: "6.75",
        overallPass: true,
        artifactPath: "runtime/evidence/stage6_75_live_smoke_report.json",
        summaryLines: ["stage 6.75 ok"]
      };
    },
    runStage685CheckpointLiveReview: async (checkpointId) => {
      calls685 += 1;
      return checkpointId.startsWith("6.85")
        ? buildReviewResult(checkpointId)
        : null;
    }
  };

  const review611 = await runGatewayCheckpointReview("6.11", runners);
  const review613 = await runGatewayCheckpointReview("6.13", runners);
  const review675 = await runGatewayCheckpointReview("6.75", runners);
  const review685 = await runGatewayCheckpointReview("6.85.A", runners);

  assert.equal(review611?.checkpointId, "6.11");
  assert.equal(review613?.checkpointId, "6.13");
  assert.equal(review675?.checkpointId, "6.75");
  assert.equal(review685?.checkpointId, "6.85.A");
  assert.equal(calls611, 1);
  assert.equal(calls613, 1);
  assert.equal(calls675, 1);
  assert.equal(calls685, 1);
});
