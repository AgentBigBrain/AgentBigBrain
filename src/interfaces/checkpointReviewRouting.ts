/**
 * @fileoverview Shared checkpoint-review routing helpers for interface gateways, keeping `/review` parity deterministic across providers.
 */

import type { Stage675CheckpointReviewResult } from "../core/stage6_75CheckpointLive";
import type { ConversationCheckpointReviewResult } from "./conversationRuntime/managerContracts";

export interface GatewayCheckpointReviewRunners {
  runCheckpoint611LiveReview: () => Promise<ConversationCheckpointReviewResult>;
  runCheckpoint613LiveReview: () => Promise<ConversationCheckpointReviewResult>;
  runCheckpoint675LiveReview: () => Promise<Stage675CheckpointReviewResult>;
  runStage685CheckpointLiveReview: (
    checkpointId: string
  ) => Promise<ConversationCheckpointReviewResult | null>;
}

/**
 * Routes `/review <checkpoint-id>` to the correct live-review runner with deterministic checkpoint parity.
 *
 * **Why it exists:**
 * Telegram and Discord must use identical checkpoint mapping rules (including Stage 6.75) so
 * runtime behavior and help text remain truthful across providers.
 *
 * **What it talks to:**
 * - Uses gateway-supplied checkpoint runner callbacks for 6.11, 6.13, 6.75, and 6.85.*.
 *
 * @param checkpointId - Raw checkpoint id parsed from `/review` command input.
 * @param runners - Runner dependency bundle provided by the gateway runtime.
 * @returns Matching checkpoint review result, or null when the Stage 6.85 runner rejects the id.
 */
export async function runGatewayCheckpointReview(
  checkpointId: string,
  runners: GatewayCheckpointReviewRunners
): Promise<ConversationCheckpointReviewResult | null> {
  if (checkpointId === "6.11") {
    return runners.runCheckpoint611LiveReview();
  }
  if (checkpointId === "6.13") {
    return runners.runCheckpoint613LiveReview();
  }
  if (checkpointId === "6.75") {
    return runners.runCheckpoint675LiveReview();
  }
  return runners.runStage685CheckpointLiveReview(checkpointId);
}
