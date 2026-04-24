/**
 * @fileoverview Applies pending Obsidian review-action notes through canonical runtime mutation seams.
 */

import path from "node:path";

import { createSharedBrainRuntimeDependencies } from "../core/buildBrain";
import { ensureEnvLoaded } from "../core/envLoader";
import { createProjectionRuntimeConfigFromEnv } from "../core/projections/config";
import {
  applyObsidianReviewActionsFromDirectory,
  type ApplyObsidianReviewActionsReport
} from "../core/projections/reviewActionIngestion";

/**
 * Applies pending review-action notes from the configured Obsidian mirror root.
 *
 * **Why it exists:**
 * Review-action write-back should be opt-in and deterministic, and this tool provides the
 * operator-facing batch entrypoint without teaching the runtime to parse freeform vault edits in
 * normal conversation flow.
 *
 * **What it talks to:**
 * - Uses `createSharedBrainRuntimeDependencies` from `../core/buildBrain`.
 * - Uses projection config helpers from `../core/projections/config`.
 * - Uses review-action ingestion helpers from `../core/projections/reviewActionIngestion`.
 *
 * @param env - Environment map carrying projection configuration.
 * @returns Batch apply report for the configured review-action folder.
 */
export async function applyObsidianReviewActions(
  env: NodeJS.ProcessEnv = process.env
): Promise<ApplyObsidianReviewActionsReport> {
  const projectionConfig = createProjectionRuntimeConfigFromEnv(env);
  if (!projectionConfig.obsidian.enabled) {
    throw new Error(
      "Obsidian projection is not enabled. Set BRAIN_PROJECTION_SINKS to include obsidian and configure BRAIN_OBSIDIAN_VAULT_PATH."
    );
  }

  const shared = createSharedBrainRuntimeDependencies(env);
  const reviewActionDirectoryPath = path.resolve(
    projectionConfig.obsidian.vaultPath,
    projectionConfig.obsidian.rootDirectoryName,
    "40 Review Actions"
  );
  return applyObsidianReviewActionsFromDirectory(reviewActionDirectoryPath, {
    profileMemoryStore: shared.profileMemoryStore,
    runtimeStateStore: shared.stage686RuntimeStateStore,
    projectionService: shared.projectionService
  });
}

/**
 * Runs the review-action apply command from the terminal entrypoint.
 *
 * **Why it exists:**
 * Repo tooling needs a thin CLI wrapper for operators and tests while the real write-back logic
 * stays inside the projection subsystem.
 *
 * **What it talks to:**
 * - Uses `applyObsidianReviewActions(...)` in this module.
 *
 * @returns Promise resolving after the review-action batch completes.
 */
async function main(): Promise<void> {
  ensureEnvLoaded();
  const report = await applyObsidianReviewActions(process.env);
  console.log(
    `Applied Obsidian review actions. Applied=${report.appliedCount}, Failed=${report.failedCount}, Skipped=${report.skippedCount}.`
  );
}

if (require.main === module) {
  void main();
}
