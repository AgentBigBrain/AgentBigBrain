/**
 * @fileoverview Persists run history and aggregate metrics to runtime state storage.
 */

import { readFile } from "node:fs/promises";

import { BrainMetrics, BrainState, TaskRunResult } from "./types";
import { withFileLock, writeFileAtomic } from "./fileLock";

/**
 * Builds initial metrics for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of initial metrics consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `BrainMetrics` (import `BrainMetrics`) from `./types`.
 * @returns Computed `BrainMetrics` result.
 */
function createInitialMetrics(): BrainMetrics {
  return {
    totalTasks: 0,
    totalActions: 0,
    approvedActions: 0,
    blockedActions: 0,
    fastPathActions: 0,
    escalationActions: 0
  };
}

/**
 * Builds initial state for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of initial state consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `BrainState` (import `BrainState`) from `./types`.
 * @returns Computed `BrainState` result.
 */
function createInitialState(): BrainState {
  return {
    createdAt: new Date().toISOString(),
    runs: [],
    metrics: createInitialMetrics()
  };
}

/**
 * Resolves the runtime state-store path from environment overrides when present.
 *
 * **Why it exists:**
 * Lets governed live-smoke runs isolate their runtime state without rewriting the normal
 * default runtime path or fighting over one shared lock file.
 *
 * **What it talks to:**
 * - Reads `process.env.BRAIN_STATE_JSON_PATH` from the current Node.js environment.
 *
 * @returns Resolved filesystem path for the durable state store.
 */
function resolveStateStorePathFromEnv(): string {
  const configuredPath = process.env.BRAIN_STATE_JSON_PATH?.trim();
  return configuredPath && configuredPath.length > 0
    ? configuredPath
    : "runtime/state.json";
}

/**
 * Persists metrics with deterministic state semantics.
 *
 * **Why it exists:**
 * Centralizes metrics mutations for auditability and replay.
 *
 * **What it talks to:**
 * - Uses `BrainState` (import `BrainState`) from `./types`.
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `./types`.
 *
 * @param state - Value for state.
 * @param run - Value for run.
 */
function updateMetrics(state: BrainState, run: TaskRunResult): void {
  state.metrics.totalTasks += 1;
  state.metrics.totalActions += run.actionResults.length;
  state.metrics.approvedActions += run.actionResults.filter((result) => result.approved).length;
  state.metrics.blockedActions += run.actionResults.filter((result) => !result.approved).length;
  state.metrics.fastPathActions += run.actionResults.filter(
    (result) => result.mode === "fast_path"
  ).length;
  state.metrics.escalationActions += run.actionResults.filter(
    (result) => result.mode === "escalation_path"
  ).length;
}

export class StateStore {
/**
 * Initializes `StateStore` with deterministic runtime dependencies.
 *
 * **Why it exists:**
 * Captures required dependencies at initialization time so runtime behavior remains explicit.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param filePath - Filesystem location used by this operation.
 */
constructor(private readonly filePath = resolveStateStorePathFromEnv()) {}

/**
 * Reads input needed for this execution step.
 *
 * **Why it exists:**
 * Separates input read-path handling from orchestration and mutation code.
 *
 * **What it talks to:**
 * - Uses `BrainState` (import `BrainState`) from `./types`.
 * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
 * @returns Promise resolving to BrainState.
 */
async load(): Promise<BrainState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as BrainState;
    } catch {
      return createInitialState();
    }
  }

/**
 * Persists run with deterministic state semantics.
 *
 * **Why it exists:**
 * Centralizes run mutations for auditability and replay.
 *
 * **What it talks to:**
 * - Uses `withFileLock` (import `withFileLock`) from `./fileLock`.
 * - Uses `BrainState` (import `BrainState`) from `./types`.
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `./types`.
 *
 * @param run - Value for run.
 * @returns Promise resolving to BrainState.
 */
async appendRun(run: TaskRunResult): Promise<BrainState> {
    return withFileLock(this.filePath, async () => {
      const state = await this.load();
      state.lastRunAt = run.completedAt;
      state.runs.push(run);
      updateMetrics(state, run);
      await this.save(state);
      return state;
    });
  }

/**
 * Persists input with deterministic state semantics.
 *
 * **Why it exists:**
 * Centralizes input mutations for auditability and replay.
 *
 * **What it talks to:**
 * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `./fileLock`.
 * - Uses `BrainState` (import `BrainState`) from `./types`.
 *
 * @param state - Value for state.
 * @returns Promise resolving to void.
 */
private async save(state: BrainState): Promise<void> {
    await writeFileAtomic(this.filePath, JSON.stringify(state, null, 2));
  }
}

