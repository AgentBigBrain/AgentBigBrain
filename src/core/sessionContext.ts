/**
 * @fileoverview Shared conversation-domain contracts and pure reducers used by routing, memory,
 * and lifecycle coordination.
 */

export const MAX_CONVERSATION_DOMAIN_LANE_HISTORY = 8;
export const MAX_CONVERSATION_DOMAIN_ROUTING_SIGNALS = 6;

const CONVERSATION_DOMAIN_LANES = [
  "profile",
  "relationship",
  "workflow",
  "system_policy",
  "unknown"
] as const;
const CONVERSATION_DOMAIN_ROUTING_MODES = [
  "chat",
  "explain",
  "plan",
  "build",
  "static_html_build",
  "framework_app_build",
  "clarify_build_format",
  "autonomous",
  "review",
  "discover_available_capabilities",
  "status_or_recall",
  "unclear"
] as const;
const CONVERSATION_DOMAIN_LANE_SIGNAL_SOURCES = [
  "keyword",
  "semantic_route",
  "routing_mode",
  "continuity_state",
  "manual",
  "unknown"
] as const;

export type ConversationDomainLane = (typeof CONVERSATION_DOMAIN_LANES)[number];
export type ConversationDomainRoutingMode = (typeof CONVERSATION_DOMAIN_ROUTING_MODES)[number];
export type ConversationDomainLaneSignalSource =
  (typeof CONVERSATION_DOMAIN_LANE_SIGNAL_SOURCES)[number];

export interface ConversationDomainLaneSignal {
  lane: ConversationDomainLane;
  observedAt: string;
  source: ConversationDomainLaneSignalSource;
  weight: number;
}

export interface ConversationDomainRoutingSignal {
  mode: ConversationDomainRoutingMode;
  observedAt: string;
}

export interface ConversationDomainContinuitySignals {
  activeWorkspace: boolean;
  returnHandoff: boolean;
  modeContinuity: boolean;
}

export interface ConversationDomainContext {
  conversationId: string;
  dominantLane: ConversationDomainLane;
  recentLaneHistory: ConversationDomainLaneSignal[];
  recentRoutingSignals: ConversationDomainRoutingSignal[];
  continuitySignals: ConversationDomainContinuitySignals;
  activeSince: string | null;
  lastUpdatedAt: string | null;
}

export interface ConversationDomainSignalWindowUpdate {
  observedAt: string;
  laneSignals?: readonly ConversationDomainLaneSignal[];
  routingSignals?: readonly ConversationDomainRoutingSignal[];
  continuitySignals?: Partial<ConversationDomainContinuitySignals>;
}

/**
 * Creates the canonical empty domain-context shape for one conversation.
 */
export function createEmptyConversationDomainContext(
  conversationId: string
): ConversationDomainContext {
  return {
    conversationId,
    dominantLane: "unknown",
    recentLaneHistory: [],
    recentRoutingSignals: [],
    continuitySignals: {
      activeWorkspace: false,
      returnHandoff: false,
      modeContinuity: false
    },
    activeSince: null,
    lastUpdatedAt: null
  };
}

/**
 * Normalizes one persisted or synthetic domain-context candidate into the stable runtime shape.
 */
export function normalizeConversationDomainContext(
  candidate: unknown,
  conversationId: string
): ConversationDomainContext {
  const empty = createEmptyConversationDomainContext(conversationId);
  if (!isRecord(candidate)) {
    return empty;
  }

  const recentLaneHistory = normalizeBoundedWindow(
    candidate.recentLaneHistory,
    normalizeConversationDomainLaneSignal,
    MAX_CONVERSATION_DOMAIN_LANE_HISTORY
  );
  const recentRoutingSignals = normalizeBoundedWindow(
    candidate.recentRoutingSignals,
    normalizeConversationDomainRoutingSignal,
    MAX_CONVERSATION_DOMAIN_ROUTING_SIGNALS
  );
  const dominantLaneCandidate = normalizeConversationDomainLane(candidate.dominantLane) ?? "unknown";
  const dominantLane =
    recentLaneHistory.length > 0
      ? resolveSessionDomain(recentLaneHistory, dominantLaneCandidate)
      : dominantLaneCandidate;
  const lastSignalAt =
    getLastLaneSignalTimestamp(recentLaneHistory) ?? getLastRoutingSignalTimestamp(recentRoutingSignals);
  const lastUpdatedAt = normalizeOptionalTimestamp(candidate.lastUpdatedAt) ?? lastSignalAt ?? null;
  const activeSince =
    dominantLane === "unknown"
      ? null
      : normalizeOptionalTimestamp(candidate.activeSince) ?? lastUpdatedAt ?? null;

  return {
    conversationId,
    dominantLane,
    recentLaneHistory,
    recentRoutingSignals,
    continuitySignals: normalizeConversationDomainContinuitySignals(candidate.continuitySignals),
    activeSince,
    lastUpdatedAt
  };
}

/**
 * Returns whether a domain context carries any meaningful routing or continuity state.
 */
export function isConversationDomainContextMeaningful(
  context: ConversationDomainContext | null | undefined
): boolean {
  if (!context) {
    return false;
  }

  return (
    context.dominantLane !== "unknown" ||
    context.recentLaneHistory.length > 0 ||
    context.recentRoutingSignals.length > 0 ||
    hasActiveConversationDomainContinuity(context.continuitySignals)
  );
}

/**
 * Resolves the dominant conversation lane from bounded recent lane history.
 */
export function resolveSessionDomain(
  laneHistory: readonly ConversationDomainLaneSignal[],
  currentDominant: ConversationDomainLane = "unknown"
): ConversationDomainLane {
  const scores = new Map<ConversationDomainLane, number>();
  const mostRecentIndex = new Map<ConversationDomainLane, number>();
  const relevantSignals = laneHistory.filter((signal) => signal.lane !== "unknown" && signal.weight > 0);

  for (const [index, signal] of relevantSignals.entries()) {
    scores.set(signal.lane, (scores.get(signal.lane) ?? 0) + signal.weight);
    mostRecentIndex.set(signal.lane, index);
  }

  const rankedLanes = [...scores.entries()].sort((left, right) => {
    const scoreOrder = right[1] - left[1];
    if (scoreOrder !== 0) {
      return scoreOrder;
    }

    const leftIsCurrent = left[0] === currentDominant ? 1 : 0;
    const rightIsCurrent = right[0] === currentDominant ? 1 : 0;
    if (leftIsCurrent !== rightIsCurrent) {
      return rightIsCurrent - leftIsCurrent;
    }

    const leftRecent = mostRecentIndex.get(left[0]) ?? -1;
    const rightRecent = mostRecentIndex.get(right[0]) ?? -1;
    if (leftRecent !== rightRecent) {
      return rightRecent - leftRecent;
    }

    return left[0].localeCompare(right[0]);
  });

  return rankedLanes[0]?.[0] ?? currentDominant;
}

/**
 * Returns whether the candidate lane looks like a bounded dip away from the active session lane.
 */
export function detectCrossDomainDip(
  context: Pick<ConversationDomainContext, "dominantLane" | "continuitySignals"> | null | undefined,
  candidateLane: ConversationDomainLane
): boolean {
  if (!context) {
    return false;
  }
  if (context.dominantLane === "unknown" || candidateLane === "unknown") {
    return false;
  }
  if (context.dominantLane === candidateLane) {
    return false;
  }

  return hasActiveConversationDomainContinuity(context.continuitySignals);
}

/**
 * Applies a bounded lane/routing update window and returns the next canonical domain context.
 */
export function applyDomainSignalWindow(
  context: ConversationDomainContext,
  update: ConversationDomainSignalWindowUpdate
): ConversationDomainContext {
  const normalizedContext = normalizeConversationDomainContext(context, context.conversationId);
  const laneSignals = normalizeBoundedWindow(
    update.laneSignals,
    normalizeConversationDomainLaneSignal,
    MAX_CONVERSATION_DOMAIN_LANE_HISTORY
  );
  const routingSignals = normalizeBoundedWindow(
    update.routingSignals,
    normalizeConversationDomainRoutingSignal,
    MAX_CONVERSATION_DOMAIN_ROUTING_SIGNALS
  );
  const recentLaneHistory = trimBoundedWindow(
    [...normalizedContext.recentLaneHistory, ...laneSignals],
    MAX_CONVERSATION_DOMAIN_LANE_HISTORY
  );
  const recentRoutingSignals = trimBoundedWindow(
    [...normalizedContext.recentRoutingSignals, ...routingSignals],
    MAX_CONVERSATION_DOMAIN_ROUTING_SIGNALS
  );
  const continuitySignals = {
    activeWorkspace:
      update.continuitySignals?.activeWorkspace ?? normalizedContext.continuitySignals.activeWorkspace,
    returnHandoff:
      update.continuitySignals?.returnHandoff ?? normalizedContext.continuitySignals.returnHandoff,
    modeContinuity:
      update.continuitySignals?.modeContinuity ?? normalizedContext.continuitySignals.modeContinuity
  };
  const signalObservedAt =
    normalizeOptionalTimestamp(update.observedAt) ??
    getLastLaneSignalTimestamp(recentLaneHistory) ??
    getLastRoutingSignalTimestamp(recentRoutingSignals) ??
    normalizedContext.lastUpdatedAt;
  const dominantLane = resolveSessionDomain(recentLaneHistory, normalizedContext.dominantLane);
  const activeSince =
    dominantLane === "unknown"
      ? null
      : dominantLane === normalizedContext.dominantLane
        ? normalizedContext.activeSince ?? signalObservedAt ?? null
        : signalObservedAt ?? null;

  return {
    conversationId: normalizedContext.conversationId,
    dominantLane,
    recentLaneHistory,
    recentRoutingSignals,
    continuitySignals,
    activeSince,
    lastUpdatedAt: signalObservedAt ?? null
  };
}

/**
 * Selects the safer persisted domain context when two session snapshots are merged.
 */
export function selectConversationDomainContext(
  existing: ConversationDomainContext | null | undefined,
  incoming: ConversationDomainContext | null | undefined,
  conversationId: string
): ConversationDomainContext {
  const normalizedExisting = normalizeConversationDomainContext(existing, conversationId);
  const normalizedIncoming = normalizeConversationDomainContext(incoming, conversationId);
  const existingMeaningful = isConversationDomainContextMeaningful(normalizedExisting);
  const incomingMeaningful = isConversationDomainContextMeaningful(normalizedIncoming);

  if (existingMeaningful && !incomingMeaningful) {
    return normalizedExisting;
  }
  if (!existingMeaningful && incomingMeaningful) {
    return normalizedIncoming;
  }

  const freshnessOrder = compareOptionalTimestamps(
    getConversationDomainContextFreshness(normalizedExisting),
    getConversationDomainContextFreshness(normalizedIncoming)
  );
  if (freshnessOrder !== 0) {
    return freshnessOrder > 0 ? normalizedExisting : normalizedIncoming;
  }

  const richnessOrder =
    getConversationDomainContextRichness(normalizedExisting) -
    getConversationDomainContextRichness(normalizedIncoming);
  if (richnessOrder !== 0) {
    return richnessOrder > 0 ? normalizedExisting : normalizedIncoming;
  }

  return normalizedIncoming;
}

/**
 * Returns whether an unknown value is a non-null object record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Normalizes a candidate lane label into the supported domain-lane union.
 */
function normalizeConversationDomainLane(value: unknown): ConversationDomainLane | null {
  return typeof value === "string" &&
    (CONVERSATION_DOMAIN_LANES as readonly string[]).includes(value)
    ? (value as ConversationDomainLane)
    : null;
}

/**
 * Normalizes a candidate routing-mode label into the supported routing-mode union.
 */
function normalizeConversationDomainRoutingMode(value: unknown): ConversationDomainRoutingMode | null {
  return typeof value === "string" &&
    (CONVERSATION_DOMAIN_ROUTING_MODES as readonly string[]).includes(value)
    ? (value as ConversationDomainRoutingMode)
    : null;
}

/**
 * Normalizes the recorded source label for one lane-history signal.
 */
function normalizeConversationDomainLaneSignalSource(
  value: unknown
): ConversationDomainLaneSignalSource {
  return typeof value === "string" &&
    (CONVERSATION_DOMAIN_LANE_SIGNAL_SOURCES as readonly string[]).includes(value)
    ? (value as ConversationDomainLaneSignalSource)
    : "unknown";
}

/**
 * Normalizes one lane-history signal candidate into the stable persisted shape.
 */
function normalizeConversationDomainLaneSignal(candidate: unknown): ConversationDomainLaneSignal | null {
  if (!isRecord(candidate)) {
    return null;
  }

  const lane = normalizeConversationDomainLane(candidate.lane);
  const observedAt = normalizeOptionalTimestamp(candidate.observedAt);
  if (!lane || !observedAt) {
    return null;
  }

  return {
    lane,
    observedAt,
    source: normalizeConversationDomainLaneSignalSource(candidate.source),
    weight: normalizeConversationDomainSignalWeight(candidate.weight)
  };
}

/**
 * Normalizes one routing-signal candidate into the stable persisted shape.
 */
function normalizeConversationDomainRoutingSignal(
  candidate: unknown
): ConversationDomainRoutingSignal | null {
  if (!isRecord(candidate)) {
    return null;
  }

  const mode = normalizeConversationDomainRoutingMode(candidate.mode);
  const observedAt = normalizeOptionalTimestamp(candidate.observedAt);
  if (!mode || !observedAt) {
    return null;
  }

  return {
    mode,
    observedAt
  };
}

/**
 * Normalizes a lane-signal weight into one bounded positive number.
 */
function normalizeConversationDomainSignalWeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.round(value * 1000) / 1000;
}

/**
 * Normalizes continuity booleans into the canonical shared continuity snapshot.
 */
function normalizeConversationDomainContinuitySignals(
  candidate: unknown
): ConversationDomainContinuitySignals {
  if (!isRecord(candidate)) {
    return {
      activeWorkspace: false,
      returnHandoff: false,
      modeContinuity: false
    };
  }

  return {
    activeWorkspace: candidate.activeWorkspace === true,
    returnHandoff: candidate.returnHandoff === true,
    modeContinuity: candidate.modeContinuity === true
  };
}

/**
 * Normalizes an unknown signal window and caps it to the configured maximum length.
 */
function normalizeBoundedWindow<T>(
  candidate: unknown,
  normalizer: (value: unknown) => T | null,
  maxSize: number
): T[] {
  if (!Array.isArray(candidate)) {
    return [];
  }

  const normalized = candidate
    .map((entry) => normalizer(entry))
    .filter((entry): entry is T => entry !== null);
  return trimBoundedWindow(normalized, maxSize);
}

/**
 * Trims a signal window to its newest bounded entries.
 */
function trimBoundedWindow<T>(values: readonly T[], maxSize: number): T[] {
  if (values.length <= maxSize) {
    return [...values];
  }
  return [...values.slice(values.length - maxSize)];
}

/**
 * Normalizes optional timestamp-like strings into trimmed persisted values.
 */
function normalizeOptionalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Returns whether any continuity flag is still active on the shared domain snapshot.
 */
function hasActiveConversationDomainContinuity(
  continuitySignals: ConversationDomainContinuitySignals
): boolean {
  return (
    continuitySignals.activeWorkspace ||
    continuitySignals.returnHandoff ||
    continuitySignals.modeContinuity
  );
}

/**
 * Returns the newest lane-history timestamp when lane evidence is present.
 */
function getLastLaneSignalTimestamp(
  laneHistory: readonly ConversationDomainLaneSignal[]
): string | null {
  return laneHistory.length > 0 ? laneHistory[laneHistory.length - 1].observedAt : null;
}

/**
 * Returns the newest routing-signal timestamp when routing evidence is present.
 */
function getLastRoutingSignalTimestamp(
  routingSignals: readonly ConversationDomainRoutingSignal[]
): string | null {
  return routingSignals.length > 0 ? routingSignals[routingSignals.length - 1].observedAt : null;
}

/**
 * Compares two optional ISO-like timestamps for deterministic freshness selection.
 */
function compareOptionalTimestamps(left: string | null, right: string | null): number {
  if (left && right) {
    return left.localeCompare(right);
  }
  if (left) {
    return 1;
  }
  if (right) {
    return -1;
  }
  return 0;
}

/**
 * Resolves the freshest available timestamp carried by one normalized domain context.
 */
function getConversationDomainContextFreshness(context: ConversationDomainContext): string | null {
  return (
    context.lastUpdatedAt ??
    getLastLaneSignalTimestamp(context.recentLaneHistory) ??
    getLastRoutingSignalTimestamp(context.recentRoutingSignals) ??
    context.activeSince
  );
}

/**
 * Scores how much usable state one normalized domain context carries for tie-breaking.
 */
function getConversationDomainContextRichness(context: ConversationDomainContext): number {
  const continuityWeight =
    (context.continuitySignals.activeWorkspace ? 1 : 0) +
    (context.continuitySignals.returnHandoff ? 1 : 0) +
    (context.continuitySignals.modeContinuity ? 1 : 0);

  return (
    context.recentLaneHistory.length +
    context.recentRoutingSignals.length +
    continuityWeight +
    (context.dominantLane !== "unknown" ? 1 : 0)
  );
}
