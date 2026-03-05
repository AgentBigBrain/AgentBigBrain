/**
 * @fileoverview Computes deterministic governor drift and disagreement telemetry from governance-memory events.
 */

import {
  FULL_COUNCIL_GOVERNOR_IDS,
  GovernanceMemoryEvent,
  GovernorId
} from "./types";

const FAST_PATH_GOVERNOR: GovernorId = "security";
const DEFAULT_WINDOW_SIZE = 120;
const DEFAULT_TREND_WINDOW_SIZE = 40;
const DEFAULT_DRIFT_THRESHOLD = 0.2;
const DEFAULT_MIN_TREND_SAMPLES = 5;

interface GovernorAccumulator {
  opportunities: number;
  rejects: number;
  disagreementCount: number;
  loneNoCount: number;
}

interface VoteSnapshot {
  event: GovernanceMemoryEvent;
  participants: readonly GovernorId[];
  hadDisagreement: boolean;
  loneNoGovernorId: GovernorId | null;
}

export interface GovernorTrendMetrics {
  previousRejectRate: number | null;
  recentRejectRate: number | null;
  deltaRejectRate: number | null;
  driftDetected: boolean;
  previousOpportunities: number;
  recentOpportunities: number;
}

export interface GovernorDriftMetrics {
  opportunities: number;
  rejects: number;
  rejectRate: number;
  disagreementCount: number;
  disagreementRate: number;
  loneNoCount: number;
  loneNoRate: number;
  trend: GovernorTrendMetrics;
}

export interface GovernorDriftAuditOptions {
  windowSize?: number;
  trendWindowSize?: number;
  driftThreshold?: number;
  minTrendSamples?: number;
}

export interface GovernorDriftAuditReport {
  generatedAt: string;
  sourceEventCount: number;
  consideredEventCount: number;
  voteEventCount: number;
  disagreementEventCount: number;
  disagreementRate: number;
  loneNoEventCount: number;
  loneNoRate: number;
  windowSize: number;
  trendWindowSize: number;
  driftThreshold: number;
  minTrendSamples: number;
  governorMetrics: Record<GovernorId, GovernorDriftMetrics>;
  flaggedGovernors: GovernorId[];
}

/**
 * Constrains and sanitizes positive integer to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for positive integer before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
function clampPositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

/**
 * Converts values into rounded rate form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for rounded rate deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param numerator - Value for numerator.
 * @param denominator - Numeric bound, counter, or index used by this logic.
 * @returns Computed numeric value.
 */
function toRoundedRate(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Number((numerator / denominator).toFixed(4));
}

/**
 * Builds accumulator for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of accumulator consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @returns Computed `GovernorAccumulator` result.
 */
function createAccumulator(): GovernorAccumulator {
  return {
    opportunities: 0,
    rejects: 0,
    disagreementCount: 0,
    loneNoCount: 0
  };
}

/**
 * Builds accumulator by governor for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of accumulator by governor consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `GovernorId` (import `GovernorId`) from `./types`.
 * @returns Computed `Record<GovernorId, GovernorAccumulator>` result.
 */
function createAccumulatorByGovernor(): Record<GovernorId, GovernorAccumulator> {
  return {
    ethics: createAccumulator(),
    logic: createAccumulator(),
    resource: createAccumulator(),
    security: createAccumulator(),
    continuity: createAccumulator(),
    utility: createAccumulator(),
    compliance: createAccumulator(),
    codeReview: createAccumulator()
  };
}

/**
 * Evaluates vote event and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the vote event policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `GovernanceMemoryEvent` (import `GovernanceMemoryEvent`) from `./types`.
 *
 * @param event - Value for event.
 * @returns `true` when this check passes.
 */
function isVoteEvent(event: GovernanceMemoryEvent): boolean {
  return event.threshold !== null;
}

/**
 * Derives participants from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for participants in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses `FULL_COUNCIL_GOVERNOR_IDS` (import `FULL_COUNCIL_GOVERNOR_IDS`) from `./types`.
 * - Uses `GovernanceMemoryEvent` (import `GovernanceMemoryEvent`) from `./types`.
 * - Uses `GovernorId` (import `GovernorId`) from `./types`.
 *
 * @param event - Value for event.
 * @returns Ordered collection produced by this step.
 */
function deriveParticipants(event: GovernanceMemoryEvent): GovernorId[] {
  const participants = new Set<GovernorId>();
  if (event.mode === "fast_path") {
    participants.add(FAST_PATH_GOVERNOR);
  } else {
    for (const governorId of FULL_COUNCIL_GOVERNOR_IDS) {
      participants.add(governorId);
    }
  }
  for (const governorId of event.dissentGovernorIds) {
    participants.add(governorId);
  }
  return [...participants];
}

/**
 * Converts values into vote snapshot form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for vote snapshot deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses `GovernanceMemoryEvent` (import `GovernanceMemoryEvent`) from `./types`.
 *
 * @param event - Value for event.
 * @returns Computed `VoteSnapshot` result.
 */
function toVoteSnapshot(event: GovernanceMemoryEvent): VoteSnapshot {
  const hadDisagreement = event.noVotes > 0 || event.dissentGovernorIds.length > 0;
  const loneNoGovernorId =
    event.noVotes === 1 && event.dissentGovernorIds.length === 1
      ? event.dissentGovernorIds[0]
      : null;

  return {
    event,
    participants: deriveParticipants(event),
    hadDisagreement,
    loneNoGovernorId
  };
}

/**
 * Builds accumulator for snapshots for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of accumulator for snapshots consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `GovernorId` (import `GovernorId`) from `./types`.
 *
 * @param snapshots - Value for snapshots.
 * @returns Computed `Record<GovernorId, GovernorAccumulator>` result.
 */
function buildAccumulatorForSnapshots(
  snapshots: readonly VoteSnapshot[]
): Record<GovernorId, GovernorAccumulator> {
  const accumulatorByGovernor = createAccumulatorByGovernor();

  for (const snapshot of snapshots) {
    const dissentSet = new Set<GovernorId>(snapshot.event.dissentGovernorIds);
    for (const governorId of snapshot.participants) {
      const governorAccumulator = accumulatorByGovernor[governorId];
      governorAccumulator.opportunities += 1;
      if (snapshot.hadDisagreement) {
        governorAccumulator.disagreementCount += 1;
      }
      if (dissentSet.has(governorId)) {
        governorAccumulator.rejects += 1;
      }
      if (snapshot.loneNoGovernorId === governorId) {
        governorAccumulator.loneNoCount += 1;
      }
    }
  }

  return accumulatorByGovernor;
}

/**
 * Builds trend metrics for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of trend metrics consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `GovernorId` (import `GovernorId`) from `./types`.
 *
 * @param governorId - Stable identifier used to reference an entity or record.
 * @param snapshots - Value for snapshots.
 * @param minTrendSamples - Numeric bound, counter, or index used by this logic.
 * @param driftThreshold - Value for drift threshold.
 * @returns Computed `GovernorTrendMetrics` result.
 */
function buildTrendMetrics(
  governorId: GovernorId,
  snapshots: readonly VoteSnapshot[],
  minTrendSamples: number,
  driftThreshold: number
): GovernorTrendMetrics {
  if (snapshots.length < 2) {
    return {
      previousRejectRate: null,
      recentRejectRate: null,
      deltaRejectRate: null,
      driftDetected: false,
      previousOpportunities: 0,
      recentOpportunities: 0
    };
  }

  const splitIndex = Math.floor(snapshots.length / 2);
  const previousSnapshots = snapshots.slice(0, splitIndex);
  const recentSnapshots = snapshots.slice(splitIndex);

  const previousAccumulator = buildAccumulatorForSnapshots(previousSnapshots)[governorId];
  const recentAccumulator = buildAccumulatorForSnapshots(recentSnapshots)[governorId];

  const previousRejectRate =
    previousAccumulator.opportunities > 0
      ? toRoundedRate(previousAccumulator.rejects, previousAccumulator.opportunities)
      : null;
  const recentRejectRate =
    recentAccumulator.opportunities > 0
      ? toRoundedRate(recentAccumulator.rejects, recentAccumulator.opportunities)
      : null;

  const hasSufficientSamples =
    previousAccumulator.opportunities >= minTrendSamples &&
    recentAccumulator.opportunities >= minTrendSamples &&
    previousRejectRate !== null &&
    recentRejectRate !== null;

  if (!hasSufficientSamples) {
    return {
      previousRejectRate,
      recentRejectRate,
      deltaRejectRate: null,
      driftDetected: false,
      previousOpportunities: previousAccumulator.opportunities,
      recentOpportunities: recentAccumulator.opportunities
    };
  }

  const deltaRejectRate = Number((recentRejectRate - previousRejectRate).toFixed(4));
  return {
    previousRejectRate,
    recentRejectRate,
    deltaRejectRate,
    driftDetected: Math.abs(deltaRejectRate) >= driftThreshold,
    previousOpportunities: previousAccumulator.opportunities,
    recentOpportunities: recentAccumulator.opportunities
  };
}

/**
 * Builds governor drift audit for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of governor drift audit consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `GovernanceMemoryEvent` (import `GovernanceMemoryEvent`) from `./types`.
 * - Uses `GovernorId` (import `GovernorId`) from `./types`.
 *
 * @param events - Value for events.
 * @param options - Optional tuning knobs for this operation.
 * @returns Computed `GovernorDriftAuditReport` result.
 */
export function buildGovernorDriftAudit(
  events: readonly GovernanceMemoryEvent[],
  options: GovernorDriftAuditOptions = {}
): GovernorDriftAuditReport {
  const windowSize = clampPositiveInteger(options.windowSize, DEFAULT_WINDOW_SIZE);
  const driftThresholdCandidate = options.driftThreshold ?? DEFAULT_DRIFT_THRESHOLD;
  const driftThreshold = Number(
    (
      Number.isFinite(driftThresholdCandidate)
        ? driftThresholdCandidate
        : DEFAULT_DRIFT_THRESHOLD
    ).toFixed(4)
  );
  const minTrendSamples = clampPositiveInteger(options.minTrendSamples, DEFAULT_MIN_TREND_SAMPLES);

  const consideredEvents = events.slice(-windowSize);
  const voteSnapshots = consideredEvents.filter(isVoteEvent).map(toVoteSnapshot);
  const trendWindowSize = clampPositiveInteger(
    options.trendWindowSize,
    Math.min(DEFAULT_TREND_WINDOW_SIZE, voteSnapshots.length || 1)
  );
  const trendSnapshots = voteSnapshots.slice(-trendWindowSize);

  const accumulatorByGovernor = buildAccumulatorForSnapshots(voteSnapshots);
  const disagreementEventCount = voteSnapshots.filter((snapshot) => snapshot.hadDisagreement).length;
  const loneNoEventCount = voteSnapshots.filter(
    (snapshot) => snapshot.loneNoGovernorId !== null
  ).length;

  const governorMetrics = {
    ethics: null,
    logic: null,
    resource: null,
    security: null,
    continuity: null,
    utility: null,
    compliance: null,
    codeReview: null
  } as unknown as Record<GovernorId, GovernorDriftMetrics>;
  const flaggedGovernors: GovernorId[] = [];

  for (const governorId of Object.keys(governorMetrics) as GovernorId[]) {
    const accumulator = accumulatorByGovernor[governorId];
    const trend = buildTrendMetrics(governorId, trendSnapshots, minTrendSamples, driftThreshold);
    if (trend.driftDetected) {
      flaggedGovernors.push(governorId);
    }
    governorMetrics[governorId] = {
      opportunities: accumulator.opportunities,
      rejects: accumulator.rejects,
      rejectRate: toRoundedRate(accumulator.rejects, accumulator.opportunities),
      disagreementCount: accumulator.disagreementCount,
      disagreementRate: toRoundedRate(
        accumulator.disagreementCount,
        accumulator.opportunities
      ),
      loneNoCount: accumulator.loneNoCount,
      loneNoRate: toRoundedRate(accumulator.loneNoCount, accumulator.opportunities),
      trend
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceEventCount: events.length,
    consideredEventCount: consideredEvents.length,
    voteEventCount: voteSnapshots.length,
    disagreementEventCount,
    disagreementRate: toRoundedRate(disagreementEventCount, voteSnapshots.length),
    loneNoEventCount,
    loneNoRate: toRoundedRate(loneNoEventCount, voteSnapshots.length),
    windowSize,
    trendWindowSize,
    driftThreshold,
    minTrendSamples,
    governorMetrics,
    flaggedGovernors
  };
}
