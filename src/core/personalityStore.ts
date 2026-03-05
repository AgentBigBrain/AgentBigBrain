/**
 * @fileoverview Persists personality profile state and applies deterministic, safety-filtered reward updates per run.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applySafePersonalityUpdate,
  buildPersonalityRewardEvaluation,
  createDefaultPersonalityProfile,
  PersonalityProfile
} from "./personality";
import { TaskRunResult } from "./types";

export interface PersonalityHistoryEntry {
  taskId: string;
  appliedAt: string;
  rewardedTraits: string[];
  acceptedTraits: string[];
  rejectedTraits: string[];
  rationale: string[];
}

export interface PersonalityState {
  profile: PersonalityProfile;
  history: PersonalityHistoryEntry[];
}

/**
 * Builds initial personality state for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of initial personality state consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `createDefaultPersonalityProfile` (import `createDefaultPersonalityProfile`) from `./personality`.
 * @returns Computed `PersonalityState` result.
 */
function createInitialPersonalityState(): PersonalityState {
  return {
    profile: createDefaultPersonalityProfile(),
    history: []
  };
}

/**
 * Evaluates valid history entry and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the valid history entry policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param entry - Value for entry.
 * @returns Computed `entry is PersonalityHistoryEntry` result.
 */
function isValidHistoryEntry(entry: unknown): entry is PersonalityHistoryEntry {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  const candidate = entry as PersonalityHistoryEntry;
  return (
    typeof candidate.taskId === "string" &&
    typeof candidate.appliedAt === "string" &&
    Array.isArray(candidate.rewardedTraits) &&
    Array.isArray(candidate.acceptedTraits) &&
    Array.isArray(candidate.rejectedTraits) &&
    Array.isArray(candidate.rationale)
  );
}

/**
 * Normalizes personality state into a stable shape for `personalityStore` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for personality state so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param raw - Value for raw.
 * @returns Computed `PersonalityState` result.
 */
function normalizePersonalityState(raw: unknown): PersonalityState {
  const initial = createInitialPersonalityState();
  if (!raw || typeof raw !== "object") {
    return initial;
  }

  const candidate = raw as Partial<PersonalityState>;
  const profile = candidate.profile && typeof candidate.profile === "object"
    ? candidate.profile
    : initial.profile;

  const history = Array.isArray(candidate.history)
    ? candidate.history.filter((entry) => isValidHistoryEntry(entry))
    : [];

  return {
    profile: {
      tone:
        profile.tone === "direct" || profile.tone === "balanced" || profile.tone === "warm"
          ? profile.tone
          : initial.profile.tone,
      traits:
        profile.traits && typeof profile.traits === "object"
          ? { ...initial.profile.traits, ...profile.traits }
          : initial.profile.traits,
      updatedAt: typeof profile.updatedAt === "string" ? profile.updatedAt : initial.profile.updatedAt
    },
    history
  };
}

export class PersonalityStore {
  /**
   * Initializes `PersonalityStore` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param filePath - Filesystem location used by this operation.
   */
  constructor(private readonly filePath = "runtime/personality_profile.json") { }

  /**
   * Reads input needed for this execution step.
   *
   * **Why it exists:**
   * Separates input read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
   * @returns Promise resolving to PersonalityState.
   */
  async load(): Promise<PersonalityState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return normalizePersonalityState(parsed);
    } catch {
      return createInitialPersonalityState();
    }
  }

  /**
   * Executes run reward as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the run reward runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses `applySafePersonalityUpdate` (import `applySafePersonalityUpdate`) from `./personality`.
   * - Uses `buildPersonalityRewardEvaluation` (import `buildPersonalityRewardEvaluation`) from `./personality`.
   * - Uses `TaskRunResult` (import `TaskRunResult`) from `./types`.
   *
   * @param run - Value for run.
   * @returns Promise resolving to PersonalityState.
   */
  async applyRunReward(run: TaskRunResult): Promise<PersonalityState> {
    const state = await this.load();
    const evaluation = buildPersonalityRewardEvaluation(state.profile, run);
    const updateResult = applySafePersonalityUpdate(state.profile, evaluation.proposal);

    const nextState: PersonalityState = {
      profile: updateResult.profile,
      history: state.history.concat({
        taskId: run.task.id,
        appliedAt: new Date().toISOString(),
        rewardedTraits: evaluation.rewardedTraits,
        acceptedTraits: updateResult.acceptedTraits,
        rejectedTraits: updateResult.rejectedTraits,
        rationale: evaluation.rationale
      })
    };

    await this.save(nextState);
    return nextState;
  }

  /**
   * Persists input with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes input mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
   * - Uses `writeFile` (import `writeFile`) from `node:fs/promises`.
   * - Uses `path` (import `default`) from `node:path`.
   *
   * @param state - Value for state.
   * @returns Promise resolving to void.
   */
  private async save(state: PersonalityState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }
}
