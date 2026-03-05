/**
 * @fileoverview Persists interface conversation session state for proposal-review workflows and continuous chat context.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { LedgerBackend } from "../core/config";
import { withFileLock, writeFileAtomic } from "../core/fileLock";
import { withSqliteDatabase } from "../core/sqliteStore";
import { ConversationStackV1, SessionSchemaVersionV1 } from "../core/types";
import {
  buildConversationStackFromTurnsV1,
  isConversationStackV1,
  migrateSessionConversationStackToV2
} from "../core/stage6_86ConversationStack";
import type { PulseEmissionRecordV1 } from "../core/stage6_86PulseCandidates";

export type ProposalStatus = "pending" | "approved" | "cancelled" | "executed";
export type ConversationJobStatus = "queued" | "running" | "completed" | "failed";
export type ConversationAckLifecycleState =
  | "NOT_SENT"
  | "SENT"
  | "REPLACED"
  | "FINAL_SENT_NO_EDIT"
  | "CANCELLED";
export type ConversationFinalDeliveryOutcome =
  | "not_attempted"
  | "sent"
  | "rate_limited"
  | "failed";
export type ConversationTurnRole = "user" | "assistant";
export type ConversationVisibility = "private" | "public" | "unknown";
export type ConversationClassifierKind = "follow_up" | "proposal_reply" | "pulse_lexical";
export type ConversationClassifierCategory =
  | "ACK"
  | "APPROVE"
  | "DENY"
  | "UNCLEAR"
  | "COMMAND"
  | "NON_COMMAND";
export type ConversationClassifierConfidenceTier = "HIGH" | "MED" | "LOW";
export type ConversationClassifierIntent =
  | "APPROVE"
  | "CANCEL"
  | "ADJUST"
  | "QUESTION"
  | "on"
  | "off"
  | "private"
  | "public"
  | "status"
  | null;
export type AgentPulseMode = "private" | "public";
export type AgentPulseRouteStrategy = "last_private_used" | "current_conversation";
export type AgentPulseDecisionCode =
  | "ALLOWED"
  | "DISABLED"
  | "OPT_OUT"
  | "NO_PRIVATE_ROUTE"
  | "NO_STALE_FACTS"
  | "NO_UNRESOLVED_COMMITMENTS"
  | "NO_CONTEXTUAL_LINKAGE"
  | "RELATIONSHIP_ROLE_SUPPRESSED"
  | "CONTEXT_DRIFT_SUPPRESSED"
  | "CONTEXTUAL_TOPIC_COOLDOWN"
  | "QUIET_HOURS"
  | "RATE_LIMIT"
  | "NOT_EVALUATED"
  | "DYNAMIC_SENT"
  | "DYNAMIC_SUPPRESSED";

export interface AgentPulseContextualLexicalEvidence {
  matchedRuleId: string;
  rulepackVersion: string;
  rulepackFingerprint: string;
  confidenceTier: ConversationClassifierConfidenceTier;
  confidence: number;
  conflict: boolean;
  candidateTokens: string[];
  evaluatedAt: string;
}

export interface ConversationTurn {
  role: ConversationTurnRole;
  text: string;
  at: string;
}

export interface AgentPulseSessionState {
  optIn: boolean;
  mode: AgentPulseMode;
  routeStrategy: AgentPulseRouteStrategy;
  lastPulseSentAt: string | null;
  lastPulseReason: string | null;
  lastPulseTargetConversationId: string | null;
  lastDecisionCode: AgentPulseDecisionCode;
  lastEvaluatedAt: string | null;
  lastContextualLexicalEvidence?: AgentPulseContextualLexicalEvidence | null;
  recentEmissions?: PulseEmissionRecordV1[];
  userStyleFingerprint?: string;
  userTimezone?: string;
}

export interface PendingProposal {
  id: string;
  originalInput: string;
  currentInput: string;
  createdAt: string;
  updatedAt: string;
  status: ProposalStatus;
}

export interface ConversationJob {
  id: string;
  input: string;
  executionInput?: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  status: ConversationJobStatus;
  resultSummary: string | null;
  errorMessage: string | null;
  isSystemJob?: boolean;
  ackTimerGeneration: number;
  ackEligibleAt: string | null;
  ackLifecycleState: ConversationAckLifecycleState;
  ackMessageId: string | null;
  ackSentAt: string | null;
  ackEditAttemptCount: number;
  ackLastErrorCode: string | null;
  finalDeliveryOutcome: ConversationFinalDeliveryOutcome;
  finalDeliveryAttemptCount: number;
  finalDeliveryLastErrorCode: string | null;
  finalDeliveryLastAttemptAt: string | null;
}

export interface ConversationClassifierEvent {
  classifier: ConversationClassifierKind;
  input: string;
  at: string;
  isShortFollowUp: boolean;
  category: ConversationClassifierCategory;
  confidenceTier: ConversationClassifierConfidenceTier;
  matchedRuleId: string;
  rulepackVersion: string;
  intent: ConversationClassifierIntent;
  conflict?: boolean;
}

export interface ConversationSession {
  conversationId: string;
  userId: string;
  username: string;
  conversationVisibility: ConversationVisibility;
  sessionSchemaVersion?: SessionSchemaVersionV1;
  conversationStack?: ConversationStackV1;
  updatedAt: string;
  activeProposal: PendingProposal | null;
  runningJobId: string | null;
  queuedJobs: ConversationJob[];
  recentJobs: ConversationJob[];
  conversationTurns: ConversationTurn[];
  classifierEvents?: ConversationClassifierEvent[];
  agentPulse: AgentPulseSessionState;
}

interface InterfaceSessionFile {
  conversations: Record<string, ConversationSession>;
}

interface InterfaceSessionStoreOptions {
  backend?: LedgerBackend;
  sqlitePath?: string;
  exportJsonOnWrite?: boolean;
}

interface SqliteSessionRow {
  conversation_id: string;
  updated_at: string;
  session_json: string;
}

/**
 * Validates a raw sqlite row shape for interface-session reads.
 */
function isSqliteSessionRow(value: unknown): value is SqliteSessionRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<SqliteSessionRow>;
  return (
    typeof candidate.conversation_id === "string" &&
    typeof candidate.updated_at === "string" &&
    typeof candidate.session_json === "string"
  );
}

/**
 * Validates and normalizes sqlite interface-session row arrays.
 */
function parseSqliteSessionRows(rows: unknown): SqliteSessionRow[] {
  if (!Array.isArray(rows)) {
    throw new Error("Interface session sqlite query returned non-array rowset.");
  }

  const normalizedRows: SqliteSessionRow[] = [];
  for (const row of rows) {
    if (!isSqliteSessionRow(row)) {
      throw new Error("Interface session sqlite row failed shape validation.");
    }
    normalizedRows.push(row);
  }

  return normalizedRows;
}

/**
 * Validates an optional sqlite interface-session row.
 */
function parseOptionalSqliteSessionRow(row: unknown): SqliteSessionRow | null {
  if (row === undefined || row === null) {
    return null;
  }
  if (!isSqliteSessionRow(row)) {
    throw new Error("Interface session sqlite row failed shape validation.");
  }
  return row;
}

const SQLITE_INTERFACE_SESSIONS_TABLE = "interface_sessions";

/**
 * Builds empty state for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of empty state consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @returns Computed `InterfaceSessionFile` result.
 */
function createEmptyState(): InterfaceSessionFile {
  return {
    conversations: {}
  };
}

/**
 * Builds default agent pulse state for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of default agent pulse state consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @returns Computed `AgentPulseSessionState` result.
 */
function createDefaultAgentPulseState(): AgentPulseSessionState {
  return {
    optIn: false,
    mode: "private",
    routeStrategy: "last_private_used",
    lastPulseSentAt: null,
    lastPulseReason: null,
    lastPulseTargetConversationId: null,
    lastDecisionCode: "NOT_EVALUATED",
    lastEvaluatedAt: null,
    lastContextualLexicalEvidence: null,
    recentEmissions: []
  };
}

/**
 * Normalizes agent pulse contextual lexical evidence into a stable shape for `sessionStore` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for agent pulse contextual lexical evidence so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param raw - Value for raw.
 * @returns Computed `AgentPulseContextualLexicalEvidence | null` result.
 */
function normalizeAgentPulseContextualLexicalEvidence(
  raw: unknown
): AgentPulseContextualLexicalEvidence | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const candidate = raw as Partial<AgentPulseContextualLexicalEvidence>;
  if (
    typeof candidate.matchedRuleId !== "string" ||
    typeof candidate.rulepackVersion !== "string" ||
    typeof candidate.rulepackFingerprint !== "string" ||
    typeof candidate.confidenceTier !== "string" ||
    typeof candidate.confidence !== "number" ||
    typeof candidate.conflict !== "boolean" ||
    typeof candidate.evaluatedAt !== "string" ||
    !Array.isArray(candidate.candidateTokens)
  ) {
    return null;
  }

  const confidenceTierCandidate = candidate.confidenceTier as ConversationClassifierConfidenceTier;
  if (
    (confidenceTierCandidate !== "HIGH" &&
      confidenceTierCandidate !== "MED" &&
      confidenceTierCandidate !== "LOW") ||
    !Number.isFinite(candidate.confidence)
  ) {
    return null;
  }

  const normalizedTokens = candidate.candidateTokens
    .filter((token): token is string => typeof token === "string")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)
    .slice(0, 10);

  return {
    matchedRuleId: candidate.matchedRuleId,
    rulepackVersion: candidate.rulepackVersion,
    rulepackFingerprint: candidate.rulepackFingerprint,
    confidenceTier: confidenceTierCandidate,
    confidence: Math.max(0, Math.min(1, Number(candidate.confidence.toFixed(4)))),
    conflict: candidate.conflict,
    candidateTokens: [...new Set(normalizedTokens)],
    evaluatedAt: candidate.evaluatedAt
  };
}

const MAX_RECENT_EMISSIONS = 10;

/**
 * Normalizes persisted recent pulse emissions, capping at {@link MAX_RECENT_EMISSIONS}.
 */
function normalizeRecentEmissions(raw: unknown): PulseEmissionRecordV1[] {
  if (!Array.isArray(raw)) return [];
  const valid: PulseEmissionRecordV1[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as PulseEmissionRecordV1).emittedAt === "string" &&
      typeof (item as PulseEmissionRecordV1).reasonCode === "string" &&
      Array.isArray((item as PulseEmissionRecordV1).candidateEntityRefs)
    ) {
      valid.push(item as PulseEmissionRecordV1);
    }
  }
  return valid.slice(-MAX_RECENT_EMISSIONS);
}

/**
 * Appends a pulse emission record and caps at {@link MAX_RECENT_EMISSIONS}.
 */
export function appendPulseEmission(
  state: AgentPulseSessionState,
  record: PulseEmissionRecordV1
): void {
  const emissions = state.recentEmissions ?? [];
  emissions.push(record);
  if (emissions.length > MAX_RECENT_EMISSIONS) {
    emissions.splice(0, emissions.length - MAX_RECENT_EMISSIONS);
  }
  state.recentEmissions = emissions;
}

const EMOJI_PATTERN = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
const FORMALITY_MARKERS = /\b(hi|hey|yo|sup|lol|haha|omg|tbh|imo|nah|yep|yeah|cool|btw|thx|ty)\b/i;
const STYLE_FINGERPRINT_MAX_TURNS = 20;

/**
 * Computes a lightweight user communication style fingerprint from recent conversation turns.
 * Uses heuristics: average message length, emoji density, and formality markers.
 * Pure function, no model call.
 */
export function computeUserStyleFingerprint(turns: ConversationTurn[]): string {
  const userTurns = turns
    .filter((turn) => turn.role === "user")
    .slice(-STYLE_FINGERPRINT_MAX_TURNS);

  if (userTurns.length === 0) return "unknown style";

  const totalChars = userTurns.reduce((sum, turn) => sum + turn.text.length, 0);
  const avgLength = Math.round(totalChars / userTurns.length);

  let emojiCount = 0;
  let informalCount = 0;
  for (const turn of userTurns) {
    const emojis = turn.text.match(EMOJI_PATTERN);
    if (emojis) emojiCount += emojis.length;
    if (FORMALITY_MARKERS.test(turn.text)) informalCount += 1;
  }

  const traits: string[] = [];

  if (avgLength < 40) traits.push("short messages");
  else if (avgLength < 120) traits.push("medium-length messages");
  else traits.push("detailed messages");

  const informalRatio = informalCount / userTurns.length;
  if (informalRatio > 0.5) traits.push("casual");
  else if (informalRatio < 0.15) traits.push("formal");

  const emojiPerMessage = emojiCount / userTurns.length;
  if (emojiPerMessage > 0.5) traits.push("uses emoji");

  return traits.join(", ") || "neutral style";
}

const IANA_TIMEZONE_MAP: ReadonlyMap<string, string> = new Map([
  ["est", "America/New_York"],
  ["eastern", "America/New_York"],
  ["new york", "America/New_York"],
  ["edt", "America/New_York"],
  ["pst", "America/Los_Angeles"],
  ["pacific", "America/Los_Angeles"],
  ["los angeles", "America/Los_Angeles"],
  ["pdt", "America/Los_Angeles"],
  ["cst", "America/Chicago"],
  ["central", "America/Chicago"],
  ["chicago", "America/Chicago"],
  ["cdt", "America/Chicago"],
  ["mst", "America/Denver"],
  ["mountain", "America/Denver"],
  ["denver", "America/Denver"],
  ["mdt", "America/Denver"],
  ["utc", "UTC"],
  ["gmt", "UTC"],
  ["greenwich", "UTC"],
  ["bst", "Europe/London"],
  ["london", "Europe/London"],
  ["cet", "Europe/Paris"],
  ["paris", "Europe/Paris"],
  ["berlin", "Europe/Berlin"],
  ["jst", "Asia/Tokyo"],
  ["tokyo", "Asia/Tokyo"],
  ["kst", "Asia/Seoul"],
  ["seoul", "Asia/Seoul"],
  ["ist", "Asia/Kolkata"],
  ["mumbai", "Asia/Kolkata"],
  ["aest", "Australia/Sydney"],
  ["sydney", "Australia/Sydney"],
  ["aedt", "Australia/Sydney"],
  ["nzst", "Pacific/Auckland"],
  ["auckland", "Pacific/Auckland"],
  ["hst", "Pacific/Honolulu"],
  ["hawaii", "Pacific/Honolulu"],
  ["akst", "America/Anchorage"],
  ["alaska", "America/Anchorage"]
]);

const TZ_MENTION_PATTERN = /\b(?:i(?:'m| am) in|my (?:time\s*zone|tz) is|i(?:'m| am) on)\s+([a-z][a-z\s]{1,20})\b/i;
const TZ_BARE_ABBREVIATION_PATTERN = /\b(EST|EDT|PST|PDT|CST|CDT|MST|MDT|UTC|GMT|BST|CET|JST|KST|IST|AEST|AEDT|NZST|HST|AKST)\b/;

/**
 * Detects timezone mentions in user text and maps them to IANA timezone strings.
 * Returns the IANA string (e.g., "America/New_York") or null if no timezone detected.
 */
export function detectTimezoneFromMessage(text: string): string | null {
  const mentionMatch = text.match(TZ_MENTION_PATTERN);
  if (mentionMatch) {
    const mentioned = mentionMatch[1].trim().toLowerCase();
    const resolved = IANA_TIMEZONE_MAP.get(mentioned);
    if (resolved) return resolved;
  }

  const bareMatch = text.match(TZ_BARE_ABBREVIATION_PATTERN);
  if (bareMatch) {
    const abbr = bareMatch[1].toLowerCase();
    const resolved = IANA_TIMEZONE_MAP.get(abbr);
    if (resolved) return resolved;
  }

  for (const [key, value] of IANA_TIMEZONE_MAP) {
    if (key.length > 3 && text.toLowerCase().includes(key)) {
      return value;
    }
  }

  return null;
}

export interface ResolvedUserLocalTime {
  formatted: string;
  dayOfWeek: string;
  hour: number;
}

const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * Resolves the user's local time using a stored IANA timezone string, falling back to system clock.
 * Uses `Intl.DateTimeFormat` for IANA resolution (handles DST natively, no external dependency).
 */
export function resolveUserLocalTime(
  userTimezone: string | undefined,
  nowIso: string
): ResolvedUserLocalTime {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    const fallback = new Date();
    return {
      formatted: `${DAYS_OF_WEEK[fallback.getDay()]} ${formatTime(fallback.getHours(), fallback.getMinutes())}`,
      dayOfWeek: DAYS_OF_WEEK[fallback.getDay()],
      hour: fallback.getHours()
    };
  }

  const baseDate = new Date(nowMs);

  if (userTimezone) {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: userTimezone,
        weekday: "long",
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      });
      const parts = formatter.formatToParts(baseDate);
      const weekday = parts.find((p) => p.type === "weekday")?.value ?? DAYS_OF_WEEK[baseDate.getDay()];
      const hourPart = parts.find((p) => p.type === "hour")?.value ?? "";
      const minutePart = parts.find((p) => p.type === "minute")?.value ?? "";
      const dayPeriod = parts.find((p) => p.type === "dayPeriod")?.value ?? "";

      const hourFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: userTimezone,
        hour: "numeric",
        hour12: false
      });
      const hourParts = hourFormatter.formatToParts(baseDate);
      const hour24 = parseInt(hourParts.find((p) => p.type === "hour")?.value ?? "0", 10);

      return {
        formatted: `${weekday} ${hourPart}:${minutePart} ${dayPeriod}`,
        dayOfWeek: weekday,
        hour: hour24
      };
    } catch {
      // Invalid IANA string, fall through to system clock
    }
  }

  const dayOfWeek = DAYS_OF_WEEK[baseDate.getDay()];
  return {
    formatted: `${dayOfWeek} ${formatTime(baseDate.getHours(), baseDate.getMinutes())}`,
    dayOfWeek,
    hour: baseDate.getHours()
  };
}

/**
 * Formats hour and minute into a 12-hour time string.
 */
function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
}

/**
 * Strips a UTF-8 BOM prefix from a string.
 */
function stripUtf8Bom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

const TERMINAL_JOB_STATUSES = new Set<ConversationJobStatus>(["completed", "failed"]);

/**
 * Evaluates terminal conversation job status and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the terminal conversation job status policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param status - Value for status.
 * @returns `true` when this check passes.
 */
function isTerminalConversationJobStatus(status: ConversationJobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

/**
 * Resolves preferred conversation job from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of preferred conversation job by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param existing - Value for existing.
 * @param incoming - Numeric bound, counter, or index used by this logic.
 * @returns Computed `ConversationJob` result.
 */
function choosePreferredConversationJob(
  existing: ConversationJob,
  incoming: ConversationJob
): ConversationJob {
  const existingTerminal = isTerminalConversationJobStatus(existing.status);
  const incomingTerminal = isTerminalConversationJobStatus(incoming.status);
  if (existingTerminal && !incomingTerminal) {
    return existing;
  }
  if (!existingTerminal && incomingTerminal) {
    return incoming;
  }

  const existingFinalAttempted = existing.finalDeliveryOutcome !== "not_attempted";
  const incomingFinalAttempted = incoming.finalDeliveryOutcome !== "not_attempted";
  if (existingFinalAttempted && !incomingFinalAttempted) {
    return existing;
  }
  if (!existingFinalAttempted && incomingFinalAttempted) {
    return incoming;
  }

  if (existing.resultSummary && !incoming.resultSummary) {
    return existing;
  }
  if (!existing.resultSummary && incoming.resultSummary) {
    return incoming;
  }

  if (existing.errorMessage && !incoming.errorMessage) {
    return existing;
  }
  if (!existing.errorMessage && incoming.errorMessage) {
    return incoming;
  }

  const existingTimestamp = existing.completedAt ?? existing.startedAt ?? existing.createdAt;
  const incomingTimestamp = incoming.completedAt ?? incoming.startedAt ?? incoming.createdAt;
  if (existingTimestamp > incomingTimestamp) {
    return existing;
  }
  if (incomingTimestamp > existingTimestamp) {
    return incoming;
  }

  return incoming;
}

/**
 * Normalizes ordering and duplication for conversation jobs.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for conversation jobs in one place.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param existingJobs - Value for existing jobs.
 * @param incomingJobs - Numeric bound, counter, or index used by this logic.
 * @returns Ordered collection produced by this step.
 */
function mergeConversationJobs(
  existingJobs: readonly ConversationJob[],
  incomingJobs: readonly ConversationJob[]
): ConversationJob[] {
  const mergedById = new Map<string, ConversationJob>();

  for (const existingJob of existingJobs) {
    mergedById.set(existingJob.id, existingJob);
  }

  for (const incomingJob of incomingJobs) {
    const current = mergedById.get(incomingJob.id);
    if (!current) {
      mergedById.set(incomingJob.id, incomingJob);
      continue;
    }
    mergedById.set(
      incomingJob.id,
      choosePreferredConversationJob(current, incomingJob)
    );
  }

  return [...mergedById.values()].sort((left, right) => {
    const timestampOrder = right.createdAt.localeCompare(left.createdAt);
    if (timestampOrder !== 0) {
      return timestampOrder;
    }
    return left.id.localeCompare(right.id);
  });
}

/**
 * Normalizes ordering and duplication for conversation turns.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for conversation turns in one place.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param existingTurns - Value for existing turns.
 * @param incomingTurns - Numeric bound, counter, or index used by this logic.
 * @returns Ordered collection produced by this step.
 */
function mergeConversationTurns(
  existingTurns: readonly ConversationTurn[],
  incomingTurns: readonly ConversationTurn[]
): ConversationTurn[] {
  const mergedByKey = new Map<string, ConversationTurn>();
  for (const turn of existingTurns) {
    mergedByKey.set(`${turn.at}|${turn.role}|${turn.text}`, turn);
  }
  for (const turn of incomingTurns) {
    mergedByKey.set(`${turn.at}|${turn.role}|${turn.text}`, turn);
  }

  return [...mergedByKey.values()].sort((left, right) => {
    const atOrder = left.at.localeCompare(right.at);
    if (atOrder !== 0) {
      return atOrder;
    }
    const roleOrder = left.role.localeCompare(right.role);
    if (roleOrder !== 0) {
      return roleOrder;
    }
    return left.text.localeCompare(right.text);
  });
}

/**
 * Normalizes ordering and duplication for classifier events.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for classifier events in one place.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param existingEvents - Value for existing events.
 * @param incomingEvents - Numeric bound, counter, or index used by this logic.
 * @returns Ordered collection produced by this step.
 */
function mergeClassifierEvents(
  existingEvents: readonly ConversationClassifierEvent[],
  incomingEvents: readonly ConversationClassifierEvent[]
): ConversationClassifierEvent[] {
  const mergedByKey = new Map<string, ConversationClassifierEvent>();
  for (const event of existingEvents) {
    mergedByKey.set(
      `${event.classifier}|${event.at}|${event.input}|${event.matchedRuleId}|${event.intent ?? "none"}|${event.conflict ? "1" : "0"}`,
      event
    );
  }
  for (const event of incomingEvents) {
    mergedByKey.set(
      `${event.classifier}|${event.at}|${event.input}|${event.matchedRuleId}|${event.intent ?? "none"}|${event.conflict ? "1" : "0"}`,
      event
    );
  }

  return [...mergedByKey.values()].sort((left, right) => left.at.localeCompare(right.at));
}

/**
 * Resolves running job id from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of running job id by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param existingRunningJobId - Stable identifier used to reference an entity or record.
 * @param incomingRunningJobId - Stable identifier used to reference an entity or record.
 * @param queuedJobs - Value for queued jobs.
 * @param recentJobs - Value for recent jobs.
 * @returns Computed `string | null` result.
 */
function selectRunningJobId(
  existingRunningJobId: string | null,
  incomingRunningJobId: string | null,
  queuedJobs: readonly ConversationJob[],
  recentJobs: readonly ConversationJob[]
): string | null {
  const jobsById = new Map<string, ConversationJob>();
  for (const job of queuedJobs) {
    jobsById.set(job.id, job);
  }
  for (const job of recentJobs) {
    jobsById.set(job.id, job);
  }

  /**
   * Verifies whether a stored running-job pointer still targets executable work.
   *
   * **Why it exists:**
   * Persisted session snapshots can reference stale jobs after restarts or merge races. This
   * helper keeps `runningJobId` recovery deterministic by accepting only queued/running jobs that
   * still exist in the merged job index.
   *
   * **What it talks to:**
   * - Reads `jobsById` built from queued and recent jobs.
   *
   * @param jobId - Candidate job id from incoming or existing session state.
   * @returns `true` when the id maps to a queued/running job record.
   */
  const isRunnable = (jobId: string | null): boolean => {
    if (!jobId) {
      return false;
    }
    const job = jobsById.get(jobId);
    if (!job) {
      return false;
    }
    return job.status === "running" || job.status === "queued";
  };

  if (isRunnable(incomingRunningJobId)) {
    return incomingRunningJobId;
  }
  if (isRunnable(existingRunningJobId)) {
    return existingRunningJobId;
  }
  return null;
}

/**
 * Normalizes ordering and duplication for conversation session.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for conversation session in one place.
 *
 * **What it talks to:**
 * - Uses `buildConversationStackFromTurnsV1` (import `buildConversationStackFromTurnsV1`) from `../core/stage6_86ConversationStack`.
 * - Uses `isConversationStackV1` (import `isConversationStackV1`) from `../core/stage6_86ConversationStack`.
 *
 * @param existing - Value for existing.
 * @param incoming - Numeric bound, counter, or index used by this logic.
 * @returns Computed `ConversationSession` result.
 */
function mergeConversationSession(
  existing: ConversationSession,
  incoming: ConversationSession
): ConversationSession {
  const mergedRecentJobs = mergeConversationJobs(existing.recentJobs, incoming.recentJobs);
  const mergedQueuedCandidates = mergeConversationJobs(existing.queuedJobs, incoming.queuedJobs);
  const completedRecentIds = new Set(
    mergedRecentJobs
      .filter((job) => isTerminalConversationJobStatus(job.status))
      .map((job) => job.id)
  );
  const mergedQueuedJobs = mergedQueuedCandidates.filter(
    (job) =>
      !completedRecentIds.has(job.id) &&
      !isTerminalConversationJobStatus(job.status)
  );
  const mergedConversationTurns = mergeConversationTurns(
    existing.conversationTurns,
    incoming.conversationTurns
  );
  const mergedUpdatedAt = existing.updatedAt > incoming.updatedAt ? existing.updatedAt : incoming.updatedAt;
  const preferredStackSource = existing.updatedAt >= incoming.updatedAt ? existing : incoming;
  const preferredStack = isConversationStackV1(preferredStackSource.conversationStack)
    ? preferredStackSource.conversationStack
    : null;
  const mergedConversationStack = buildConversationStackFromTurnsV1(
    mergedConversationTurns,
    mergedUpdatedAt,
    {},
    preferredStack
  );

  return {
    ...existing,
    ...incoming,
    sessionSchemaVersion: "v2",
    conversationStack: mergedConversationStack,
    updatedAt: mergedUpdatedAt,
    runningJobId: selectRunningJobId(
      existing.runningJobId,
      incoming.runningJobId,
      mergedQueuedJobs,
      mergedRecentJobs
    ),
    queuedJobs: mergedQueuedJobs,
    recentJobs: mergedRecentJobs,
    conversationTurns: mergedConversationTurns,
    classifierEvents: mergeClassifierEvents(
      existing.classifierEvents ?? [],
      incoming.classifierEvents ?? []
    )
  };
}

/**
 * Normalizes session into a stable shape for `sessionStore` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for session so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `isConversationStackV1` (import `isConversationStackV1`) from `../core/stage6_86ConversationStack`.
 * - Uses `migrateSessionConversationStackToV2` (import `migrateSessionConversationStackToV2`) from `../core/stage6_86ConversationStack`.
 * - Uses `ConversationStackV1` (import `ConversationStackV1`) from `../core/types`.
 * - Uses `SessionSchemaVersionV1` (import `SessionSchemaVersionV1`) from `../core/types`.
 *
 * @param raw - Value for raw.
 * @returns Computed `ConversationSession | null` result.
 */
function normalizeSession(raw: Partial<ConversationSession>): ConversationSession | null {
  if (
    typeof raw.conversationId !== "string" ||
    typeof raw.userId !== "string" ||
    typeof raw.username !== "string" ||
    typeof raw.updatedAt !== "string"
  ) {
    return null;
  }

  const activeProposal =
    raw.activeProposal &&
      typeof raw.activeProposal.id === "string" &&
      typeof raw.activeProposal.originalInput === "string" &&
      typeof raw.activeProposal.currentInput === "string" &&
      typeof raw.activeProposal.createdAt === "string" &&
      typeof raw.activeProposal.updatedAt === "string" &&
      typeof raw.activeProposal.status === "string"
      ? {
        id: raw.activeProposal.id,
        originalInput: raw.activeProposal.originalInput,
        currentInput: raw.activeProposal.currentInput,
        createdAt: raw.activeProposal.createdAt,
        updatedAt: raw.activeProposal.updatedAt,
        status: raw.activeProposal.status as ProposalStatus
      }
      : null;

  /**
   * Normalizes one persisted job record into the runtime `ConversationJob` shape.
   *
   * **Why it exists:**
   * Session files can contain older schema variants or partial payloads. This helper applies
   * deterministic defaults and validation so queue recovery never executes malformed job metadata.
   *
   * **What it talks to:**
   * - Uses `ConversationAckLifecycleState` and `ConversationFinalDeliveryOutcome` enums for
   *   bounded normalization.
   *
   * @param job - Raw persisted job payload.
   * @returns Normalized job object, or `null` when required fields are invalid.
   */
  const normalizeJob = (job: Partial<ConversationJob>): ConversationJob | null => {
    if (
      typeof job.id !== "string" ||
      typeof job.input !== "string" ||
      typeof job.createdAt !== "string"
    ) {
      return null;
    }

    const rawAckLifecycleState = job.ackLifecycleState;
    const ackLifecycleState: ConversationAckLifecycleState =
      rawAckLifecycleState === "NOT_SENT" ||
      rawAckLifecycleState === "SENT" ||
      rawAckLifecycleState === "REPLACED" ||
      rawAckLifecycleState === "FINAL_SENT_NO_EDIT" ||
      rawAckLifecycleState === "CANCELLED"
        ? rawAckLifecycleState
        : "NOT_SENT";
    const rawFinalDeliveryOutcome = job.finalDeliveryOutcome;
    const finalDeliveryOutcome: ConversationFinalDeliveryOutcome =
      rawFinalDeliveryOutcome === "not_attempted" ||
      rawFinalDeliveryOutcome === "sent" ||
      rawFinalDeliveryOutcome === "rate_limited" ||
      rawFinalDeliveryOutcome === "failed"
        ? rawFinalDeliveryOutcome
        : "not_attempted";
    const ackTimerGeneration =
      typeof job.ackTimerGeneration === "number" &&
      Number.isFinite(job.ackTimerGeneration) &&
      job.ackTimerGeneration >= 0
        ? Math.floor(job.ackTimerGeneration)
        : 0;
    const ackEditAttemptCount =
      typeof job.ackEditAttemptCount === "number" &&
      Number.isFinite(job.ackEditAttemptCount) &&
      job.ackEditAttemptCount >= 0
        ? Math.floor(job.ackEditAttemptCount)
        : 0;
    const finalDeliveryAttemptCount =
      typeof job.finalDeliveryAttemptCount === "number" &&
      Number.isFinite(job.finalDeliveryAttemptCount) &&
      job.finalDeliveryAttemptCount >= 0
        ? Math.floor(job.finalDeliveryAttemptCount)
        : 0;

    return {
      id: job.id,
      input: job.input,
      executionInput: typeof job.executionInput === "string" ? job.executionInput : undefined,
      createdAt: job.createdAt,
      startedAt: typeof job.startedAt === "string" ? job.startedAt : null,
      completedAt: typeof job.completedAt === "string" ? job.completedAt : null,
      status: typeof job.status === "string" ? (job.status as ConversationJobStatus) : "queued",
      resultSummary: typeof job.resultSummary === "string" ? job.resultSummary : null,
      errorMessage: typeof job.errorMessage === "string" ? job.errorMessage : null,
      isSystemJob: job.isSystemJob === true ? true : undefined,
      ackTimerGeneration,
      ackEligibleAt: typeof job.ackEligibleAt === "string" ? job.ackEligibleAt : null,
      ackLifecycleState,
      ackMessageId: typeof job.ackMessageId === "string" ? job.ackMessageId : null,
      ackSentAt: typeof job.ackSentAt === "string" ? job.ackSentAt : null,
      ackEditAttemptCount,
      ackLastErrorCode: typeof job.ackLastErrorCode === "string" ? job.ackLastErrorCode : null,
      finalDeliveryOutcome,
      finalDeliveryAttemptCount,
      finalDeliveryLastErrorCode:
        typeof job.finalDeliveryLastErrorCode === "string" ? job.finalDeliveryLastErrorCode : null,
      finalDeliveryLastAttemptAt:
        typeof job.finalDeliveryLastAttemptAt === "string" ? job.finalDeliveryLastAttemptAt : null
    };
  };

  /**
   * Validates and normalizes one conversation turn entry.
   *
   * **Why it exists:**
   * Turn history is injected into follow-up planning. Rejecting malformed turns here prevents
   * invalid role/text payloads from polluting continuity context.
   *
   * **What it talks to:**
   * - Uses `ConversationTurn` role constraints (`user` or `assistant`).
   *
   * @param turn - Raw turn candidate from persisted session state.
   * @returns Normalized turn when valid; otherwise `null`.
   */
  const normalizeTurn = (turn: Partial<ConversationTurn>): ConversationTurn | null => {
    if (
      (turn.role !== "user" && turn.role !== "assistant") ||
      typeof turn.text !== "string" ||
      typeof turn.at !== "string"
    ) {
      return null;
    }
    return {
      role: turn.role,
      text: turn.text,
      at: turn.at
    };
  };

  const queuedJobs = Array.isArray(raw.queuedJobs)
    ? raw.queuedJobs
      .map((job) => normalizeJob(job as Partial<ConversationJob>))
      .filter((job): job is ConversationJob => job !== null)
    : [];

  const recentJobs = Array.isArray(raw.recentJobs)
    ? raw.recentJobs
      .map((job) => normalizeJob(job as Partial<ConversationJob>))
      .filter((job): job is ConversationJob => job !== null)
    : [];

  const conversationTurns = Array.isArray(raw.conversationTurns)
    ? raw.conversationTurns
      .map((turn) => normalizeTurn(turn as Partial<ConversationTurn>))
      .filter((turn): turn is ConversationTurn => turn !== null)
    : [];

  let sessionSchemaVersionCandidate: SessionSchemaVersionV1 | null = null;
  if (raw.sessionSchemaVersion === undefined) {
    sessionSchemaVersionCandidate = null;
  } else if (raw.sessionSchemaVersion === "v1" || raw.sessionSchemaVersion === "v2") {
    sessionSchemaVersionCandidate = raw.sessionSchemaVersion;
  } else {
    return null;
  }

  let existingConversationStack: ConversationStackV1 | null = null;
  if (raw.conversationStack === undefined || raw.conversationStack === null) {
    existingConversationStack = null;
  } else if (isConversationStackV1(raw.conversationStack)) {
    existingConversationStack = raw.conversationStack;
  } else {
    return null;
  }

  const stackMigration = migrateSessionConversationStackToV2({
    sessionSchemaVersion: sessionSchemaVersionCandidate,
    updatedAt: raw.updatedAt,
    conversationTurns,
    conversationStack: existingConversationStack
  });

  /**
   * Normalizes one classifier telemetry event from persisted session storage.
   *
   * **Why it exists:**
   * Classifier events drive follow-up routing and audit traces. This helper fail-closes invalid
   * records so stale or malformed telemetry cannot corrupt rulepack-aware runtime behavior.
   *
   * **What it talks to:**
   * - Uses `ConversationClassifierEvent` category and confidence enums.
   * - Uses `ConversationClassifierIntent` normalization defaults.
   *
   * @param event - Raw classifier event candidate.
   * @returns Normalized classifier event, or `null` when shape constraints fail.
   */
  const normalizeClassifierEvent = (
    event: Partial<ConversationClassifierEvent>
  ): ConversationClassifierEvent | null => {
    if (
      (event.classifier !== "follow_up" &&
        event.classifier !== "proposal_reply" &&
        event.classifier !== "pulse_lexical") ||
      typeof event.input !== "string" ||
      typeof event.at !== "string" ||
      typeof event.isShortFollowUp !== "boolean" ||
      (event.category !== "ACK" &&
        event.category !== "APPROVE" &&
        event.category !== "DENY" &&
        event.category !== "UNCLEAR" &&
        event.category !== "COMMAND" &&
        event.category !== "NON_COMMAND") ||
      (event.confidenceTier !== "HIGH" &&
        event.confidenceTier !== "MED" &&
        event.confidenceTier !== "LOW") ||
      typeof event.matchedRuleId !== "string" ||
      typeof event.rulepackVersion !== "string"
    ) {
      return null;
    }

    const intentCandidate = event.intent;
    const normalizedIntent: ConversationClassifierIntent =
      intentCandidate === "APPROVE" ||
        intentCandidate === "CANCEL" ||
        intentCandidate === "ADJUST" ||
        intentCandidate === "QUESTION" ||
        intentCandidate === "on" ||
        intentCandidate === "off" ||
        intentCandidate === "private" ||
        intentCandidate === "public" ||
        intentCandidate === "status" ||
        intentCandidate === null
        ? intentCandidate
        : null;

    return {
      classifier: event.classifier,
      input: event.input,
      at: event.at,
      isShortFollowUp: event.isShortFollowUp,
      category: event.category,
      confidenceTier: event.confidenceTier,
      matchedRuleId: event.matchedRuleId,
      rulepackVersion: event.rulepackVersion,
      intent: normalizedIntent,
      conflict: typeof event.conflict === "boolean" ? event.conflict : false
    };
  };

  const classifierEvents = Array.isArray(raw.classifierEvents)
    ? raw.classifierEvents
      .map((event) => normalizeClassifierEvent(event as Partial<ConversationClassifierEvent>))
      .filter((event): event is ConversationClassifierEvent => event !== null)
    : [];

  const normalizedAgentPulseRaw =
    raw.agentPulse && typeof raw.agentPulse === "object"
      ? raw.agentPulse
      : {};

  const allowedConversationVisibilities = new Set<ConversationVisibility>([
    "private",
    "public",
    "unknown"
  ]);
  const visibilityCandidate =
    typeof raw.conversationVisibility === "string"
      ? (raw.conversationVisibility as ConversationVisibility)
      : "unknown";
  const normalizedConversationVisibility = allowedConversationVisibilities.has(visibilityCandidate)
    ? visibilityCandidate
    : "unknown";

  const allowedDecisionCodes = new Set<AgentPulseDecisionCode>([
    "ALLOWED",
    "DISABLED",
    "OPT_OUT",
    "NO_PRIVATE_ROUTE",
    "NO_STALE_FACTS",
    "NO_UNRESOLVED_COMMITMENTS",
    "NO_CONTEXTUAL_LINKAGE",
    "RELATIONSHIP_ROLE_SUPPRESSED",
    "CONTEXT_DRIFT_SUPPRESSED",
    "CONTEXTUAL_TOPIC_COOLDOWN",
    "QUIET_HOURS",
    "RATE_LIMIT",
    "NOT_EVALUATED",
    "DYNAMIC_SENT",
    "DYNAMIC_SUPPRESSED"
  ]);
  const defaultPulse = createDefaultAgentPulseState();

  const allowedModes = new Set<AgentPulseMode>(["private", "public"]);
  const modeCandidate =
    typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).mode === "string"
      ? ((normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).mode as AgentPulseMode)
      : defaultPulse.mode;

  const allowedRouteStrategies = new Set<AgentPulseRouteStrategy>([
    "last_private_used",
    "current_conversation"
  ]);
  const routeStrategyCandidate =
    typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).routeStrategy === "string"
      ? ((normalizedAgentPulseRaw as Partial<AgentPulseSessionState>)
        .routeStrategy as AgentPulseRouteStrategy)
      : defaultPulse.routeStrategy;

  const lastDecisionCandidate =
    typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastDecisionCode === "string"
      ? ((normalizedAgentPulseRaw as Partial<AgentPulseSessionState>)
        .lastDecisionCode as AgentPulseDecisionCode)
      : defaultPulse.lastDecisionCode;

  const normalizedAgentPulse: AgentPulseSessionState = {
    optIn:
      typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).optIn === "boolean"
        ? (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).optIn as boolean
        : defaultPulse.optIn,
    mode: allowedModes.has(modeCandidate) ? modeCandidate : defaultPulse.mode,
    routeStrategy: allowedRouteStrategies.has(routeStrategyCandidate)
      ? routeStrategyCandidate
      : defaultPulse.routeStrategy,
    lastPulseSentAt:
      typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastPulseSentAt === "string"
        ? (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastPulseSentAt as string
        : null,
    lastPulseReason:
      typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastPulseReason === "string"
        ? (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastPulseReason as string
        : null,
    lastPulseTargetConversationId:
      typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastPulseTargetConversationId === "string"
        ? (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>)
          .lastPulseTargetConversationId as string
        : null,
    lastDecisionCode:
      allowedDecisionCodes.has(lastDecisionCandidate)
        ? lastDecisionCandidate
        : defaultPulse.lastDecisionCode,
    lastEvaluatedAt:
      typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastEvaluatedAt === "string"
        ? (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastEvaluatedAt as string
        : null,
    lastContextualLexicalEvidence: normalizeAgentPulseContextualLexicalEvidence(
      (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastContextualLexicalEvidence
    ),
    recentEmissions: normalizeRecentEmissions(
      (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).recentEmissions
    ),
    userStyleFingerprint:
      typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).userStyleFingerprint === "string"
        ? (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).userStyleFingerprint
        : undefined,
    userTimezone:
      typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).userTimezone === "string"
        ? (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).userTimezone
        : undefined
  };

  return {
    conversationId: raw.conversationId,
    userId: raw.userId,
    username: raw.username,
    conversationVisibility: normalizedConversationVisibility,
    sessionSchemaVersion: stackMigration.sessionSchemaVersion,
    conversationStack: stackMigration.conversationStack,
    updatedAt: raw.updatedAt,
    activeProposal,
    runningJobId: typeof raw.runningJobId === "string" ? raw.runningJobId : null,
    queuedJobs,
    recentJobs,
    conversationTurns,
    classifierEvents,
    agentPulse: normalizedAgentPulse
  };
}

/**
 * Normalizes state into a stable shape for `sessionStore` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for state so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param raw - Value for raw.
 * @returns Computed `InterfaceSessionFile` result.
 */
function normalizeState(raw: Partial<InterfaceSessionFile>): InterfaceSessionFile {
  if (!raw.conversations || typeof raw.conversations !== "object") {
    return createEmptyState();
  }

  const normalizedConversations: Record<string, ConversationSession> = {};
  for (const [key, value] of Object.entries(raw.conversations)) {
    const normalized = normalizeSession(value as Partial<ConversationSession>);
    if (normalized) {
      normalizedConversations[key] = normalized;
    }
  }

  return {
    conversations: normalizedConversations
  };
}

export class InterfaceSessionStore {
  private loaded = false;
  private state: InterfaceSessionFile = createEmptyState();
  private sqliteReady = false;
  private readonly backend: LedgerBackend;
  private readonly sqlitePath: string;
  private readonly exportJsonOnWrite: boolean;

  /**
   * Initializes `InterfaceSessionStore` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses `path` (import `default`) from `node:path`.
   *
   * @param statePath - Filesystem location used by this operation.
   * @param options - Optional tuning knobs for this operation.
   */
  constructor(
    private readonly statePath: string = path.resolve(process.cwd(), "runtime/interface_sessions.json"),
    options: InterfaceSessionStoreOptions = {}
  ) {
    this.backend = options.backend ?? "json";
    this.sqlitePath = options.sqlitePath ?? path.resolve(process.cwd(), "runtime/ledgers.sqlite");
    this.exportJsonOnWrite = options.exportJsonOnWrite ?? true;
  }

  /**
   * Reads session needed for this execution step.
   *
   * **Why it exists:**
   * Separates session read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param conversationId - Stable identifier used to reference an entity or record.
   * @returns Promise resolving to ConversationSession | null.
   */
  async getSession(conversationId: string): Promise<ConversationSession | null> {
    if (this.backend === "sqlite") {
      return this.getSessionSqlite(conversationId);
    }

    await this.ensureLoaded();
    return this.state.conversations[conversationId] ?? null;
  }

  /**
   * Persists session with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes session mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `withFileLock` (import `withFileLock`) from `../core/fileLock`.
   *
   * @param session - Value for session.
   * @returns Promise resolving to void.
   */
  async setSession(session: ConversationSession): Promise<void> {
    const normalized = normalizeSession(session);
    if (!normalized) {
      throw new Error("Interface session payload is invalid.");
    }

    if (this.backend === "sqlite") {
      await this.setSessionSqlite(normalized);
      return;
    }

    await withFileLock(this.statePath, async () => {
      await this.ensureLoaded(true);
      const existing = this.state.conversations[normalized.conversationId] ?? null;
      this.state.conversations[normalized.conversationId] = existing
        ? mergeConversationSession(existing, normalized)
        : normalized;
      await this.persistJsonState();
    });
  }

  /**
   * Removes session according to deterministic lifecycle rules.
   *
   * **Why it exists:**
   * Ensures session removal follows deterministic lifecycle and retention rules.
   *
   * **What it talks to:**
   * - Uses `withFileLock` (import `withFileLock`) from `../core/fileLock`.
   *
   * @param conversationId - Stable identifier used to reference an entity or record.
   * @returns Promise resolving to void.
   */
  async deleteSession(conversationId: string): Promise<void> {
    if (this.backend === "sqlite") {
      await this.deleteSessionSqlite(conversationId);
      return;
    }

    await withFileLock(this.statePath, async () => {
      await this.ensureLoaded(true);
      delete this.state.conversations[conversationId];
      await this.persistJsonState();
    });
  }

  /**
   * Reads sessions needed for this execution step.
   *
   * **Why it exists:**
   * Separates sessions read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   * @returns Ordered collection produced by this step.
   */
  async listSessions(): Promise<ConversationSession[]> {
    if (this.backend === "sqlite") {
      return this.listSessionsSqlite();
    }

    await this.ensureLoaded();
    return Object.values(this.state.conversations);
  }

  /**
   * Applies deterministic validity checks for loaded.
   *
   * **Why it exists:**
   * Fails fast when loaded is invalid so later control flow stays safe and predictable.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param forceReload - Value for force reload.
   * @returns Promise resolving to void.
   */
  private async ensureLoaded(forceReload = false): Promise<void> {
    if (this.backend === "sqlite") {
      return;
    }

    if (this.loaded && !forceReload) {
      return;
    }

    this.state = await this.readJsonStateFile();
    this.loaded = true;
  }

  /**
   * Reads json state file needed for this execution step.
   *
   * **Why it exists:**
   * Separates json state file read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
   * @returns Promise resolving to InterfaceSessionFile.
   */
  private async readJsonStateFile(): Promise<InterfaceSessionFile> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(stripUtf8Bom(raw)) as Partial<InterfaceSessionFile>;
      return normalizeState(parsed);
    } catch {
      return createEmptyState();
    }
  }

  /**
   * Persists json state with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes json state mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `../core/fileLock`.
   * @returns Promise resolving to void.
   */
  private async persistJsonState(): Promise<void> {
    await writeFileAtomic(this.statePath, JSON.stringify(this.state, null, 2));
  }

  /**
   * Reads session sqlite needed for this execution step.
   *
   * **Why it exists:**
   * Separates session sqlite read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `../core/sqliteStore`.
   *
   * @param conversationId - Stable identifier used to reference an entity or record.
   * @returns Promise resolving to ConversationSession | null.
   */
  private async getSessionSqlite(conversationId: string): Promise<ConversationSession | null> {
    await this.ensureSqliteReady();
    return withSqliteDatabase(this.sqlitePath, async (db) => {
      this.ensureSqliteSchema(db);
      const row = db
        .prepare(
          `SELECT conversation_id, updated_at, session_json
           FROM ${SQLITE_INTERFACE_SESSIONS_TABLE}
           WHERE conversation_id = ?`
        )
        .get(conversationId);
      const validatedRow = parseOptionalSqliteSessionRow(row);

      if (!validatedRow) {
        return null;
      }

      return this.deserializeSqliteSessionRow(validatedRow);
    });
  }

  /**
   * Persists session sqlite with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes session sqlite mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `../core/sqliteStore`.
   *
   * @param session - Value for session.
   * @returns Promise resolving to void.
   */
  private async setSessionSqlite(session: ConversationSession): Promise<void> {
    await this.ensureSqliteReady();
    await withSqliteDatabase(this.sqlitePath, async (db) => {
      this.ensureSqliteSchema(db);
      db.exec("BEGIN IMMEDIATE;");
      try {
        this.insertOrReplaceSqliteSession(db, session);
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
    });

    if (this.exportJsonOnWrite) {
      await this.persistSqliteSnapshotToJson();
    }
  }

  /**
   * Removes session sqlite according to deterministic lifecycle rules.
   *
   * **Why it exists:**
   * Ensures session sqlite removal follows deterministic lifecycle and retention rules.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `../core/sqliteStore`.
   *
   * @param conversationId - Stable identifier used to reference an entity or record.
   * @returns Promise resolving to void.
   */
  private async deleteSessionSqlite(conversationId: string): Promise<void> {
    await this.ensureSqliteReady();
    await withSqliteDatabase(this.sqlitePath, async (db) => {
      this.ensureSqliteSchema(db);
      db.prepare(
        `DELETE FROM ${SQLITE_INTERFACE_SESSIONS_TABLE}
         WHERE conversation_id = ?`
      ).run(conversationId);
    });

    if (this.exportJsonOnWrite) {
      await this.persistSqliteSnapshotToJson();
    }
  }

  /**
   * Reads sessions sqlite needed for this execution step.
   *
   * **Why it exists:**
   * Separates sessions sqlite read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `../core/sqliteStore`.
   * @returns Ordered collection produced by this step.
   */
  private async listSessionsSqlite(): Promise<ConversationSession[]> {
    await this.ensureSqliteReady();
    return withSqliteDatabase(this.sqlitePath, async (db) => {
      this.ensureSqliteSchema(db);
      const rows = db
        .prepare(
          `SELECT conversation_id, updated_at, session_json
           FROM ${SQLITE_INTERFACE_SESSIONS_TABLE}
           ORDER BY updated_at DESC, conversation_id ASC`
        )
        .all();
      const validatedRows = parseSqliteSessionRows(rows);

      const sessions: ConversationSession[] = [];
      for (const row of validatedRows) {
        const normalized = this.deserializeSqliteSessionRow(row);
        if (normalized) {
          sessions.push(normalized);
        }
      }

      return sessions;
    });
  }

  /**
   * Applies deterministic validity checks for sqlite ready.
   *
   * **Why it exists:**
   * Fails fast when sqlite ready is invalid so later control flow stays safe and predictable.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `../core/sqliteStore`.
   * @returns Promise resolving to void.
   */
  private async ensureSqliteReady(): Promise<void> {
    if (this.sqliteReady) {
      return;
    }

    await withSqliteDatabase(this.sqlitePath, async (db) => {
      this.ensureSqliteSchema(db);
    });

    await this.importJsonSnapshotIntoSqliteIfEmpty();
    this.sqliteReady = true;
  }

  /**
   * Applies deterministic validity checks for sqlite schema.
   *
   * **Why it exists:**
   * Fails fast when sqlite schema is invalid so later control flow stays safe and predictable.
   *
   * **What it talks to:**
   * - Uses `DatabaseSync` (import `DatabaseSync`) from `node:sqlite`.
   *
   * @param db - Value for db.
   */
  private ensureSqliteSchema(db: DatabaseSync): void {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${SQLITE_INTERFACE_SESSIONS_TABLE} (
         conversation_id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         username TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         session_json TEXT NOT NULL
       );`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${SQLITE_INTERFACE_SESSIONS_TABLE}_updated_at
       ON ${SQLITE_INTERFACE_SESSIONS_TABLE}(updated_at);`
    );
  }

  /**
   * Implements insert or replace sqlite session behavior used by `sessionStore`.
   *
   * **Why it exists:**
   * Keeps `insert or replace sqlite session` behavior centralized so collaborating call sites stay consistent.
   *
   * **What it talks to:**
   * - Uses `DatabaseSync` (import `DatabaseSync`) from `node:sqlite`.
   *
   * @param db - Value for db.
   * @param session - Value for session.
   */
  private insertOrReplaceSqliteSession(db: DatabaseSync, session: ConversationSession): void {
    db.prepare(
      `INSERT INTO ${SQLITE_INTERFACE_SESSIONS_TABLE} (
         conversation_id, user_id, username, updated_at, session_json
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id)
       DO UPDATE SET
         user_id = excluded.user_id,
         username = excluded.username,
         updated_at = excluded.updated_at,
         session_json = excluded.session_json`
    ).run(
      session.conversationId,
      session.userId,
      session.username,
      session.updatedAt,
      JSON.stringify(session)
    );
  }

  /**
   * Transforms sqlite session row into a stable output representation.
   *
   * **Why it exists:**
   * Keeps `deserialize sqlite session row` logic in one place to reduce behavior drift.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param row - Value for row.
   * @returns Computed `ConversationSession | null` result.
   */
  private deserializeSqliteSessionRow(row: SqliteSessionRow): ConversationSession | null {
    try {
      const parsed = JSON.parse(row.session_json) as Partial<ConversationSession>;
      return normalizeSession(parsed);
    } catch {
      return null;
    }
  }

  /**
   * Imports json snapshot into sqlite if empty into local state while preserving deterministic ordering.
   *
   * **Why it exists:**
   * Ensures json snapshot into sqlite if empty import follows one deterministic migration/bootstrap path.
   *
   * **What it talks to:**
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `../core/sqliteStore`.
   * @returns Promise resolving to void.
   */
  private async importJsonSnapshotIntoSqliteIfEmpty(): Promise<void> {
    const snapshot = await this.readJsonStateFile();
    const sessions = Object.values(snapshot.conversations);
    if (sessions.length === 0) {
      return;
    }

    await withSqliteDatabase(this.sqlitePath, async (db) => {
      this.ensureSqliteSchema(db);
      const row = db
        .prepare(
          `SELECT COUNT(*) AS totalSessions
           FROM ${SQLITE_INTERFACE_SESSIONS_TABLE}`
        )
        .get() as { totalSessions?: number } | undefined;
      if (Number(row?.totalSessions ?? 0) > 0) {
        return;
      }

      db.exec("BEGIN IMMEDIATE;");
      try {
        for (const session of sessions) {
          this.insertOrReplaceSqliteSession(db, session);
        }
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
    });
  }

  /**
   * Reads state from sqlite needed for this execution step.
   *
   * **Why it exists:**
   * Separates state from sqlite read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `DatabaseSync` (import `DatabaseSync`) from `node:sqlite`.
   *
   * @param db - Value for db.
   * @returns Computed `InterfaceSessionFile` result.
   */
  private readStateFromSqlite(db: DatabaseSync): InterfaceSessionFile {
    this.ensureSqliteSchema(db);
    const rows = db
      .prepare(
        `SELECT conversation_id, updated_at, session_json
         FROM ${SQLITE_INTERFACE_SESSIONS_TABLE}
         ORDER BY updated_at DESC, conversation_id ASC`
      )
      .all();
    const validatedRows = parseSqliteSessionRows(rows);

    const conversations: Record<string, ConversationSession> = {};
    for (const row of validatedRows) {
      const normalized = this.deserializeSqliteSessionRow(row);
      if (normalized) {
        conversations[normalized.conversationId] = normalized;
      }
    }

    return { conversations };
  }

  /**
   * Persists sqlite snapshot to json with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes sqlite snapshot to json mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `withFileLock` (import `withFileLock`) from `../core/fileLock`.
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `../core/fileLock`.
   * - Uses `withSqliteDatabase` (import `withSqliteDatabase`) from `../core/sqliteStore`.
   * @returns Promise resolving to void.
   */
  private async persistSqliteSnapshotToJson(): Promise<void> {
    const snapshot = await withSqliteDatabase(this.sqlitePath, async (db) =>
      this.readStateFromSqlite(db)
    );

    await withFileLock(this.statePath, async () => {
      await writeFileAtomic(this.statePath, JSON.stringify(snapshot, null, 2));
    });
  }
}
