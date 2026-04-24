/**
 * @fileoverview Manually rebuilds the Obsidian memory projection from canonical runtime state.
 */

import { createSharedBrainRuntimeDependencies } from "../core/buildBrain";
import { ensureEnvLoaded } from "../core/envLoader";
import { createProjectionRuntimeConfigFromEnv } from "../core/projections/config";
import { buildObsidianDashboardPath } from "../core/projections/targets/obsidianOpenHelpers";

export interface ExportObsidianProjectionResult {
  dashboardPath: string;
  sinkIds: readonly string[];
}

/**
 * Rebuilds the Obsidian projection from canonical runtime stores.
 *
 * **Why it exists:**
 * Operators need one deterministic export entrypoint for recovery, schema validation, and manual
 * rebuilds before relying on real-time projection updates.
 *
 * **What it talks to:**
 * - Uses `createSharedBrainRuntimeDependencies` from `../core/buildBrain`.
 * - Uses projection config helpers from `../core/projections/config`.
 * - Uses Obsidian path helpers from `../core/projections/targets/obsidianOpenHelpers`.
 *
 * @param env - Environment map carrying projection configuration.
 * @returns Dashboard path plus enabled sink ids for the completed rebuild.
 */
export async function exportObsidianProjection(
  env: NodeJS.ProcessEnv = process.env
): Promise<ExportObsidianProjectionResult> {
  const projectionConfig = createProjectionRuntimeConfigFromEnv(env);
  if (!projectionConfig.obsidian.enabled) {
    throw new Error(
      "Obsidian projection is not enabled. Set BRAIN_PROJECTION_SINKS to include obsidian and configure BRAIN_OBSIDIAN_VAULT_PATH."
    );
  }

  const shared = createSharedBrainRuntimeDependencies(env);
  if (!shared.projectionService.isEnabled()) {
    throw new Error("Projection service is disabled.");
  }

  await shared.projectionService.rebuild("manual_export");
  return {
    dashboardPath: buildObsidianDashboardPath(
      projectionConfig.obsidian.vaultPath,
      projectionConfig.obsidian.rootDirectoryName
    ),
    sinkIds: projectionConfig.sinkIds
  };
}

/**
 * Runs the manual Obsidian export command from the terminal entrypoint.
 *
 * **Why it exists:**
 * Repo tooling needs a thin CLI surface for operators and tests without duplicating the export
 * logic that the callable helper already owns.
 *
 * **What it talks to:**
 * - Uses `exportObsidianProjection(...)` in this module.
 *
 * @returns Promise resolving after the export command completes.
 */
async function main(): Promise<void> {
  ensureEnvLoaded();
  const result = await exportObsidianProjection(process.env);
  console.log(
    `Obsidian projection rebuilt. Dashboard: ${result.dashboardPath}. Sinks: ${result.sinkIds.join(", ")}`
  );
}

if (require.main === module) {
  void main();
}
