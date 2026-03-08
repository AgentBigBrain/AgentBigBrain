/**
 * @fileoverview Canonical Stage 6.85 playbook-policy helpers for trace compilation, envelope hashing, and selection scoring.
 */

import { toSortedUnique } from "../cryptoUtils";
import { createSchemaEnvelopeV1, verifySchemaEnvelopeV1 } from "../schemaEnvelope";
import { type PlaybookRiskProfileV1, type PlaybookV1, type SchemaEnvelopeV1 } from "../types";

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
 * Normalizes positive numeric inputs before they feed scoring logic.
 *
 * @param value - Numeric input to sanitize.
 * @returns Positive finite number or `0`.
 */
function normalizePositiveNumber(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

/**
 * Derives the deterministic playbook risk profile from trace steps.
 *
 * @param steps - Candidate playbook trace steps.
 * @returns Deterministic risk profile classification.
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
 * Normalizes intent tags for deterministic comparison and hashing.
 *
 * @param tags - Raw intent-tag values.
 * @returns Trimmed, lowercased, sorted unique intent tags.
 */
function normalizeIntentTags(tags: readonly string[]): string[] {
  return toSortedUnique(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0));
}

/**
 * Compiles candidate playbook traces into deterministic Stage 6.85 playbook contracts.
 *
 * @param input - Trace metadata and normalized step evidence used to shape the candidate playbook.
 * @returns Canonical playbook contract for downstream registry and selection checks.
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
 * Wraps a Stage 6.85 playbook in a verified schema envelope.
 *
 * @param playbook - Canonical playbook payload.
 * @param createdAt - Deterministic envelope timestamp.
 * @returns Verified schema envelope for registry hashing and replayable evidence.
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
 * Clamps ratios into the deterministic `0..1` range used by playbook scoring.
 *
 * @param value - Raw ratio input.
 * @returns Clamped ratio rounded to four decimal places.
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
 * Computes deterministic tag-match strength for a candidate playbook.
 *
 * @param playbook - Candidate playbook contract.
 * @param requestedTags - Requested intent tags for the current run.
 * @returns Tag-match ratio in the `0..1` range.
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
 * Computes deterministic recency weight from the last success timestamp.
 *
 * @param lastSuccessAt - Last recorded success timestamp.
 * @param nowIso - Current deterministic comparison timestamp.
 * @returns Recency ratio in the `0..1` range.
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
 * Scores a candidate playbook against explicit deterministic selection components.
 *
 * @param playbook - Candidate playbook contract.
 * @param signal - Historical outcome signal for the playbook.
 * @param requestedTags - Requested intent tags for the current run.
 * @param requiredInputSchema - Required schema gate for this request.
 * @param nowIso - Deterministic comparison timestamp.
 * @returns Stable selection score with explicit components for review and audits.
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
  const speed = clampRatio(
    1 - Math.min(1, normalizePositiveNumber(signal.averageTimeToCompleteMs) / 180_000)
  );
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
 * Applies deterministic tag/schema compatibility gates before selection.
 *
 * @param playbook - Candidate playbook contract.
 * @param score - Precomputed selection score.
 * @param requiredInputSchema - Required schema gate for the request.
 * @returns `true` when the playbook is safe to consider as a winner.
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
 * Selects a deterministic Stage 6.85 playbook or fails closed back to planner mode.
 *
 * @param input - Candidate playbooks, historical signals, and current request gates.
 * @returns Deterministic selection decision with stable fallback reasons.
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
  if (winner.score < 0.4) {
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
