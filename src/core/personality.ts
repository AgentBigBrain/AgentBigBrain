/**
 * @fileoverview Defines personality profile rules and deterministic safety filtering for personality updates.
 */

import { TaskRunResult } from "./types";

export type PersonalityTone = "direct" | "balanced" | "warm";

export interface PersonalityProfile {
  tone: PersonalityTone;
  traits: Record<string, number>;
  updatedAt: string;
}

export interface PersonalityUpdateProposal {
  tone?: PersonalityTone;
  traitAdjustments?: Record<string, number>;
}

export interface PersonalityUpdateResult {
  profile: PersonalityProfile;
  acceptedTraits: string[];
  rejectedTraits: string[];
}

export interface PersonalityRewardEvaluation {
  proposal: PersonalityUpdateProposal;
  rewardedTraits: string[];
  rationale: string[];
}

const ALLOWED_TRAITS = [
  "clarity",
  "discipline",
  "humility",
  "curiosity",
  "patience",
  "initiative"
] as const;
const BANNED_TRAITS = ["deceptive", "manipulative", "coercive", "reckless", "harmful"] as const;
const MIN_TRAIT = 0;
const MAX_TRAIT = 1;
const APPROVED_REWARD_STEP = 0.01;
const BLOCKED_REFLECTION_STEP = 0.01;
const INITIATIVE_DAMPEN_STEP = 0.01;
const MAX_APPROVED_REWARD = 0.04;
const MAX_BLOCKED_REFLECTION_REWARD = 0.03;

/**
 * Evaluates allowed trait and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the allowed trait policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param trait - Value for trait.
 * @returns `true` when this check passes.
 */
function isAllowedTrait(trait: string): boolean {
  return ALLOWED_TRAITS.includes(trait as (typeof ALLOWED_TRAITS)[number]);
}

/**
 * Evaluates banned trait and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the banned trait policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param trait - Value for trait.
 * @returns `true` when this check passes.
 */
function isBannedTrait(trait: string): boolean {
  return BANNED_TRAITS.includes(trait as (typeof BANNED_TRAITS)[number]);
}

/**
 * Constrains and sanitizes trait to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for trait before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed numeric value.
 */
function clampTrait(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_TRAIT;
  }
  return Math.max(MIN_TRAIT, Math.min(MAX_TRAIT, value));
}

/**
 * Builds default personality profile for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of default personality profile consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @returns Computed `PersonalityProfile` result.
 */
export function createDefaultPersonalityProfile(): PersonalityProfile {
  return {
    tone: "balanced",
    traits: {
      clarity: 0.9,
      discipline: 0.85,
      humility: 0.8,
      curiosity: 0.8,
      patience: 0.75,
      initiative: 0.8
    },
    updatedAt: new Date().toISOString()
  };
}

/**
 * Counts approved safe actions for downstream policy and scoring decisions.
 *
 * **Why it exists:**
 * Keeps `count approved safe actions` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `./types`.
 *
 * @param run - Value for run.
 * @returns Computed numeric value.
 */
function countApprovedSafeActions(run: TaskRunResult): number {
  return run.actionResults.filter(
    (result) => result.approved && result.violations.length === 0
  ).length;
}

/**
 * Counts safety blocked actions for downstream policy and scoring decisions.
 *
 * **Why it exists:**
 * Keeps `count safety blocked actions` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `./types`.
 *
 * @param run - Value for run.
 * @returns Computed numeric value.
 */
function countSafetyBlockedActions(run: TaskRunResult): number {
  return run.actionResults.filter((result) => !result.approved && result.blockedBy.length > 0).length;
}

/**
 * Computes the next trait value value for this runtime flow.
 *
 * **Why it exists:**
 * Keeps candidate selection logic for trait value centralized so outcomes stay consistent.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param current - Value for current.
 * @param delta - Value for delta.
 * @returns Computed numeric value.
 */
function nextTraitValue(current: number, delta: number): number {
  return clampTrait(current + delta);
}

/**
 * Builds personality reward evaluation for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of personality reward evaluation consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `./types`.
 *
 * @param current - Value for current.
 * @param run - Value for run.
 * @returns Computed `PersonalityRewardEvaluation` result.
 */
export function buildPersonalityRewardEvaluation(
  current: PersonalityProfile,
  run: TaskRunResult
): PersonalityRewardEvaluation {
  const approvedSafeActions = countApprovedSafeActions(run);
  const blockedSafetyActions = countSafetyBlockedActions(run);

  const approvedReward = Math.min(
    approvedSafeActions * APPROVED_REWARD_STEP,
    MAX_APPROVED_REWARD
  );
  const blockedReflectionReward = Math.min(
    blockedSafetyActions * BLOCKED_REFLECTION_STEP,
    MAX_BLOCKED_REFLECTION_REWARD
  );

  const traitAdjustments: Record<string, number> = {
    clarity: nextTraitValue(current.traits.clarity ?? 0.8, approvedReward),
    discipline: nextTraitValue(current.traits.discipline ?? 0.8, approvedReward),
    humility: nextTraitValue(current.traits.humility ?? 0.8, blockedReflectionReward),
    patience: nextTraitValue(current.traits.patience ?? 0.7, blockedReflectionReward),
    initiative: nextTraitValue(
      current.traits.initiative ?? 0.8,
      blockedSafetyActions > 0 ? -INITIATIVE_DAMPEN_STEP : APPROVED_REWARD_STEP / 2
    )
  };

  const rewardedTraits = Object.entries(traitAdjustments)
    .filter(([name, value]) => isAllowedTrait(name) && value > (current.traits[name] ?? 0))
    .map(([name]) => name);

  const rationale = [
    `approvedSafeActions=${approvedSafeActions}`,
    `blockedSafetyActions=${blockedSafetyActions}`,
    "Only allowed traits are eligible for positive reinforcement."
  ];

  return {
    proposal: {
      traitAdjustments
    },
    rewardedTraits,
    rationale
  };
}

/**
 * Executes safe personality update as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the safe personality update runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param current - Value for current.
 * @param proposal - Value for proposal.
 * @returns Computed `PersonalityUpdateResult` result.
 */
export function applySafePersonalityUpdate(
  current: PersonalityProfile,
  proposal: PersonalityUpdateProposal
): PersonalityUpdateResult {
  const next: PersonalityProfile = {
    tone: proposal.tone ?? current.tone,
    traits: { ...current.traits },
    updatedAt: new Date().toISOString()
  };

  const acceptedTraits: string[] = [];
  const rejectedTraits: string[] = [];
  const adjustments = proposal.traitAdjustments ?? {};

  for (const [trait, value] of Object.entries(adjustments)) {
    const normalizedTrait = trait.trim().toLowerCase();
    if (!normalizedTrait) {
      continue;
    }
    if (isBannedTrait(normalizedTrait) || !isAllowedTrait(normalizedTrait)) {
      rejectedTraits.push(normalizedTrait);
      continue;
    }
    next.traits[normalizedTrait] = clampTrait(value);
    acceptedTraits.push(normalizedTrait);
  }

  return {
    profile: next,
    acceptedTraits,
    rejectedTraits
  };
}
