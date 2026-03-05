/**
 * @fileoverview Deterministic Stage 6.85 playbook-policy helpers for trace compilation, registry envelope hashing, and selection scoring.
 */

import { toSortedUnique } from "./cryptoUtils";
import { createSchemaEnvelopeV1, verifySchemaEnvelopeV1 } from "./schemaEnvelope";
import { PlaybookRiskProfileV1, PlaybookV1, SchemaEnvelopeV1 } from "./types";

export interface PlaybookTraceStepInput {
  actionFamily: string;
  operation: string;
  succeeded: boolean;
  durationMs: number;
  denyCount: number;
  verificationPassed: boolean;
}

export interface CompilePlaybookInput {
  traceId: string;
  goal: string;
  intentTags: readonly string[];
  inputSchema: string;
  steps: readonly PlaybookTraceStepInput[];
}

export interface PlaybookSelectionSignal {
  playbookId: string;
  passCount: number;
  failCount: number;
  lastSuccessAt: string | null;
  averageDenyRate: number;
  averageTimeToCompleteMs: number;
  verificationPassRate: number;
}

export interface PlaybookSelectionScore {
  playbookId: string;
  score: number;
  components: {
    tagMatch: number;
    successRate: number;
    recency: number;
    denyPenalty: number;
    speed: number;
    verification: number;
  };
}

export interface PlaybookSelectionDecision {
  selectedPlaybook: PlaybookV1 | null;
  scores: readonly PlaybookSelectionScore[];
  fallbackToPlanner: boolean;
  reason: string;
}

/**
 * Normalizes positive number into a stable shape for `stage6_85PlaybookPolicy` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for positive number so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed numeric value.
 */
function normalizePositiveNumber(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

/**
 * Resolves risk profile from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of risk profile by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `PlaybookRiskProfileV1` (import `PlaybookRiskProfileV1`) from `./types`.
 *
 * @param steps - Value for steps.
 * @returns Computed `PlaybookRiskProfileV1` result.
 */
function resolveRiskProfile(steps: readonly PlaybookTraceStepInput[]): PlaybookRiskProfileV1 {
  if (steps.some((step) => step.denyCount > 0 || step.actionFamily === "computer_use")) {
    return "high";
  }
  if (steps.some((step) => !step.succeeded || !step.verificationPassed)) {
    return "medium";
  }
  return "low";
}

/**
 * Normalizes intent tags into a stable shape for `stage6_85PlaybookPolicy` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for intent tags so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `toSortedUnique` (import `toSortedUnique`) from `./cryptoUtils`.
 *
 * @param tags - Value for tags.
 * @returns Ordered collection produced by this step.
 */
function normalizeIntentTags(tags: readonly string[]): string[] {
  return toSortedUnique(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0));
}

/**
 * Compiles candidate playbook from trace into deterministic output artifacts.
 *
 * **Why it exists:**
 * Centralizes candidate playbook from trace state-transition logic to keep evolution deterministic and reviewable.
 *
 * **What it talks to:**
 * - Uses `PlaybookV1` (import `PlaybookV1`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `PlaybookV1` result.
 */
export function compileCandidatePlaybookFromTrace(input: CompilePlaybookInput): PlaybookV1 {
  const normalizedTags = normalizeIntentTags(input.intentTags);
  const normalizedSteps = input.steps.map((step, index) => ({
    stepId: `step_${String(index + 1).padStart(2, "0")}`,
    actionFamily: step.actionFamily.trim().toLowerCase(),
    operation: step.operation.trim().toLowerCase(),
    deterministic: step.succeeded && step.verificationPassed
  }));
  return {
    id: `playbook_${input.traceId.trim().toLowerCase()}`,
    name: `Candidate playbook for ${input.goal.trim() || "mission"}`,
    intentTags: normalizedTags,
    inputsSchema: input.inputSchema.trim() || "unknown_input_schema",
    steps: normalizedSteps,
    riskProfile: resolveRiskProfile(input.steps),
    defaultStopConditions: ["approval_missing", "workflow_drift_detected", "budget_limit_reached"],
    requiredEvidenceTypes: ["trace", "receipt", "verification_gate"]
  };
}

/**
 * Builds playbook envelope v1 for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of playbook envelope v1 consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `createSchemaEnvelopeV1` (import `createSchemaEnvelopeV1`) from `./schemaEnvelope`.
 * - Uses `verifySchemaEnvelopeV1` (import `verifySchemaEnvelopeV1`) from `./schemaEnvelope`.
 * - Uses `PlaybookV1` (import `PlaybookV1`) from `./types`.
 * - Uses `SchemaEnvelopeV1` (import `SchemaEnvelopeV1`) from `./types`.
 *
 * @param playbook - Value for playbook.
 * @param createdAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed `SchemaEnvelopeV1<PlaybookV1>` result.
 */
export function createPlaybookEnvelopeV1(
  playbook: PlaybookV1,
  createdAt: string
): SchemaEnvelopeV1<PlaybookV1> {
  const envelope = createSchemaEnvelopeV1("PlaybookV1", playbook, createdAt);
  if (!verifySchemaEnvelopeV1(envelope)) {
    throw new Error("Playbook envelope hash validation failed.");
  }
  return envelope;
}

/**
 * Constrains and sanitizes ratio to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for ratio before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed numeric value.
 */
function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

/**
 * Derives tag match from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps `calculate tag match` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `PlaybookV1` (import `PlaybookV1`) from `./types`.
 *
 * @param playbook - Value for playbook.
 * @param requestedTags - Structured input object for this operation.
 * @returns Computed numeric value.
 */
function calculateTagMatch(playbook: PlaybookV1, requestedTags: readonly string[]): number {
  const requested = normalizeIntentTags(requestedTags);
  if (requested.length === 0) {
    return 0;
  }
  const overlap = requested.filter((tag) => playbook.intentTags.includes(tag)).length;
  return clampRatio(overlap / requested.length);
}

/**
 * Derives recency score from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps `calculate recency score` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param lastSuccessAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param nowIso - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed numeric value.
 */
function calculateRecencyScore(lastSuccessAt: string | null, nowIso: string): number {
  if (lastSuccessAt === null) {
    return 0;
  }
  const nowMs = Date.parse(nowIso);
  const thenMs = Date.parse(lastSuccessAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(thenMs) || thenMs > nowMs) {
    return 0;
  }
  const dayDiff = (nowMs - thenMs) / (24 * 60 * 60 * 1000);
  return clampRatio(1 - Math.min(1, dayDiff / 30));
}

/**
 * Implements score playbook for selection behavior used by `stage6_85PlaybookPolicy`.
 *
 * **Why it exists:**
 * Defines public behavior from `stage6_85PlaybookPolicy.ts` for other modules/tests.
 *
 * **What it talks to:**
 * - Uses `PlaybookV1` (import `PlaybookV1`) from `./types`.
 *
 * @param playbook - Value for playbook.
 * @param signal - Value for signal.
 * @param requestedTags - Structured input object for this operation.
 * @param requiredInputSchema - Structured input object for this operation.
 * @param nowIso - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed `PlaybookSelectionScore` result.
 */
export function scorePlaybookForSelection(
  playbook: PlaybookV1,
  signal: PlaybookSelectionSignal,
  requestedTags: readonly string[],
  requiredInputSchema: string,
  nowIso: string
): PlaybookSelectionScore {
  const tagMatch = calculateTagMatch(playbook, requestedTags);
  const totalRuns = Math.max(1, signal.passCount + signal.failCount);
  const successRate = clampRatio(signal.passCount / totalRuns);
  const recency = calculateRecencyScore(signal.lastSuccessAt, nowIso);
  const denyPenalty = clampRatio(signal.averageDenyRate);
  const speed = clampRatio(1 - Math.min(1, normalizePositiveNumber(signal.averageTimeToCompleteMs) / 180_000));
  const verification = clampRatio(signal.verificationPassRate);
  const schemaBonus = playbook.inputsSchema === requiredInputSchema ? 0.15 : 0;

  const rawScore =
    tagMatch * 0.25 +
    successRate * 0.25 +
    recency * 0.15 +
    speed * 0.15 +
    verification * 0.2 -
    denyPenalty * 0.2 +
    schemaBonus;

  return {
    playbookId: playbook.id,
    score: Number(Math.max(0, rawScore).toFixed(6)),
    components: {
      tagMatch,
      successRate,
      recency,
      denyPenalty,
      speed,
      verification
    }
  };
}

/**
 * Evaluates compatible playbook candidate and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the compatible playbook candidate policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `PlaybookV1` (import `PlaybookV1`) from `./types`.
 *
 * @param playbook - Value for playbook.
 * @param score - Value for score.
 * @param requiredInputSchema - Structured input object for this operation.
 * @returns `true` when this check passes.
 */
function isCompatiblePlaybookCandidate(
  playbook: PlaybookV1,
  score: PlaybookSelectionScore,
  requiredInputSchema: string
): boolean {
  const normalizedRequiredSchema = requiredInputSchema.trim().toLowerCase();
  const schemaIsKnown =
    normalizedRequiredSchema.length > 0 &&
    normalizedRequiredSchema !== "unknown_input_schema";
  const schemaMatches =
    !schemaIsKnown || playbook.inputsSchema.toLowerCase() === normalizedRequiredSchema;
  const hasPositiveTagMatch = score.components.tagMatch > 0;
  return schemaMatches && hasPositiveTagMatch;
}

/**
 * Resolves playbook deterministically from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of playbook deterministically by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `PlaybookV1` (import `PlaybookV1`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `PlaybookSelectionDecision` result.
 */
export function selectPlaybookDeterministically(input: {
  playbooks: readonly PlaybookV1[];
  signals: readonly PlaybookSelectionSignal[];
  requestedTags: readonly string[];
  requiredInputSchema: string;
  nowIso: string;
}): PlaybookSelectionDecision {
  const scoreRows: PlaybookSelectionScore[] = [];
  const signalById = new Map(input.signals.map((signal) => [signal.playbookId, signal]));

  for (const playbook of input.playbooks) {
    const signal = signalById.get(playbook.id);
    if (!signal) {
      continue;
    }
    scoreRows.push(
      scorePlaybookForSelection(
        playbook,
        signal,
        input.requestedTags,
        input.requiredInputSchema,
        input.nowIso
      )
    );
  }

  const sortedScores = [...scoreRows].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.playbookId.localeCompare(right.playbookId);
  });
  const playbooksById = new Map(input.playbooks.map((playbook) => [playbook.id, playbook]));
  const compatibleScores = sortedScores.filter((score) => {
    const playbook = playbooksById.get(score.playbookId);
    if (!playbook) {
      return false;
    }
    return isCompatiblePlaybookCandidate(playbook, score, input.requiredInputSchema);
  });
  const winner = compatibleScores[0];
  if (!winner) {
    return {
      selectedPlaybook: null,
      scores: sortedScores,
      fallbackToPlanner: true,
      reason:
        "No safe playbook match passed deterministic tag/schema compatibility gates; fallback to planner."
    };
  }
  if (!winner || winner.score < 0.4) {
    return {
      selectedPlaybook: null,
      scores: sortedScores,
      fallbackToPlanner: true,
      reason: "No safe playbook match met deterministic threshold; fallback to planner."
    };
  }

  const selectedPlaybook = playbooksById.get(winner.playbookId) ?? null;
  if (!selectedPlaybook) {
    return {
      selectedPlaybook: null,
      scores: sortedScores,
      fallbackToPlanner: true,
      reason: "Playbook score resolved to unknown ID; fallback to planner."
    };
  }

  return {
    selectedPlaybook,
    scores: sortedScores,
    fallbackToPlanner: false,
    reason: "Deterministic playbook match selected from explicit score components."
  };
}
