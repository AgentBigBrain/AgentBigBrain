/**
 * @fileoverview Prunes low-signal conversational residue from the persisted Stage 6.86 entity graph.
 */

import { ensureEnvLoaded } from "../core/envLoader";
import { createBrainConfigFromEnv } from "../core/config";
import { EntityGraphStore } from "../core/entityGraphStore";
import { pruneLowSignalEntitiesFromGraph } from "../core/stage6_86EntityGraph";

/**
 * Builds the shared entity-graph store using the same persistence config as the main runtime.
 *
 * **Why it exists:**
 * Manual cleanup should touch the same JSON or SQLite-backed graph the runtime uses, not a second
 * ad hoc path with different persistence settings.
 *
 * **What it talks to:**
 * - Uses `ensureEnvLoaded` (import `ensureEnvLoaded`) from `../core/envLoader`.
 * - Uses `createBrainConfigFromEnv` (import `createBrainConfigFromEnv`) from `../core/config`.
 * - Uses `EntityGraphStore` (import `EntityGraphStore`) from `../core/entityGraphStore`.
 *
 * @returns Runtime-aligned entity-graph store.
 */
function buildRuntimeEntityGraphStore(): EntityGraphStore {
  ensureEnvLoaded();
  const config = createBrainConfigFromEnv();
  return new EntityGraphStore(undefined, {
    backend: config.persistence.ledgerBackend,
    sqlitePath: config.persistence.ledgerSqlitePath,
    exportJsonOnWrite: config.persistence.exportJsonOnWrite
  });
}

/**
 * Runs one low-signal graph-pruning pass and reports what changed.
 *
 * **Why it exists:**
 * Obsidian and other operator views become much more useful once old conversational residue is
 * removed from the durable graph, and this gives maintainers one bounded cleanup entrypoint.
 *
 * **What it talks to:**
 * - Uses `buildRuntimeEntityGraphStore()` within this module.
 * - Uses `pruneLowSignalEntitiesFromGraph` (import `pruneLowSignalEntitiesFromGraph`) from `../core/stage6_86EntityGraph`.
 *
 * @returns Promise resolving after the graph has been inspected and optionally rewritten.
 */
async function main(): Promise<void> {
  const store = buildRuntimeEntityGraphStore();
  const graph = await store.getGraph();
  const pruned = pruneLowSignalEntitiesFromGraph(graph, new Date().toISOString());
  if (pruned.removedEntityKeys.length === 0) {
    console.log("No low-signal entity nodes were pruned.");
    return;
  }
  await store.persistGraph(pruned.graph);
  console.log(
    `Pruned ${pruned.removedEntityKeys.length} low-signal entities and ${pruned.removedEdgeKeys.length} edges from the Stage 6.86 graph.`
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
