/**
 * @fileoverview Canonical Agent Pulse session-metadata helpers for interface session runtime flows.
 */

import type { PulseEmissionRecordV1 } from "../../core/stage6_86PulseCandidates";
import type {
  AgentPulseContextualLexicalEvidence,
  AgentPulseSessionState,
  ConversationClassifierConfidenceTier,
  ConversationTurn
} from "../sessionStore";

const MAX_RECENT_EMISSIONS = 10;
const EMOJI_PATTERN =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
const FORMALITY_MARKERS = /\b(hi|hey|yo|sup|lol|haha|omg|tbh|imo|nah|yep|yeah|cool|btw|thx|ty)\b/i;
const STYLE_FINGERPRINT_MAX_TURNS = 20;
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
const TZ_MENTION_PATTERN =
  /\b(?:i(?:'m| am) in|my (?:time\s*zone|tz) is|i(?:'m| am) on)\s+([a-z][a-z\s]{1,20})\b/i;
const TZ_BARE_ABBREVIATION_PATTERN =
  /\b(EST|EDT|PST|PDT|CST|CDT|MST|MDT|UTC|GMT|BST|CET|JST|KST|IST|AEST|AEDT|NZST|HST|AKST)\b/;
const DAYS_OF_WEEK = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
] as const;

export interface ResolvedUserLocalTime {
  formatted: string;
  dayOfWeek: string;
  hour: number;
}

/**
 * Builds the default Agent Pulse session state used by normalized interface sessions.
 */
export function createDefaultAgentPulseState(): AgentPulseSessionState {
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
 * Normalizes persisted Agent Pulse lexical evidence into a bounded stable runtime shape.
 */
export function normalizeAgentPulseContextualLexicalEvidence(
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

/**
 * Normalizes persisted recent-emission history and enforces the bounded retention window.
 */
export function normalizeRecentEmissions(raw: unknown): PulseEmissionRecordV1[] {
  if (!Array.isArray(raw)) {
    return [];
  }

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
 * Appends one Agent Pulse emission record while preserving the bounded retention window.
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

/**
 * Computes a deterministic lightweight user-style fingerprint from recent user turns.
 */
export function computeUserStyleFingerprint(turns: ConversationTurn[]): string {
  const userTurns = turns.filter((turn) => turn.role === "user").slice(-STYLE_FINGERPRINT_MAX_TURNS);

  if (userTurns.length === 0) {
    return "unknown style";
  }

  const totalChars = userTurns.reduce((sum, turn) => sum + turn.text.length, 0);
  const avgLength = Math.round(totalChars / userTurns.length);

  let emojiCount = 0;
  let informalCount = 0;
  for (const turn of userTurns) {
    const emojis = turn.text.match(EMOJI_PATTERN);
    if (emojis) {
      emojiCount += emojis.length;
    }
    if (FORMALITY_MARKERS.test(turn.text)) {
      informalCount += 1;
    }
  }

  const traits: string[] = [];
  if (avgLength < 40) {
    traits.push("short messages");
  } else if (avgLength < 120) {
    traits.push("medium-length messages");
  } else {
    traits.push("detailed messages");
  }

  const informalRatio = informalCount / userTurns.length;
  if (informalRatio > 0.5) {
    traits.push("casual");
  } else if (informalRatio < 0.15) {
    traits.push("formal");
  }

  const emojiPerMessage = emojiCount / userTurns.length;
  if (emojiPerMessage > 0.5) {
    traits.push("uses emoji");
  }

  return traits.join(", ") || "neutral style";
}

/**
 * Detects common timezone mentions and maps them to IANA timezone strings when possible.
 */
export function detectTimezoneFromMessage(text: string): string | null {
  const mentionMatch = text.match(TZ_MENTION_PATTERN);
  if (mentionMatch) {
    const mentioned = mentionMatch[1].trim().toLowerCase();
    const resolved = IANA_TIMEZONE_MAP.get(mentioned);
    if (resolved) {
      return resolved;
    }
  }

  const bareMatch = text.match(TZ_BARE_ABBREVIATION_PATTERN);
  if (bareMatch) {
    const abbreviation = bareMatch[1].toLowerCase();
    const resolved = IANA_TIMEZONE_MAP.get(abbreviation);
    if (resolved) {
      return resolved;
    }
  }

  const normalizedText = text.toLowerCase();
  for (const [key, value] of IANA_TIMEZONE_MAP) {
    if (key.length > 3 && normalizedText.includes(key)) {
      return value;
    }
  }

  return null;
}

/**
 * Resolves a user-local wall-clock time from a stored IANA timezone with system-time fallback.
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
      const weekday = parts.find((part) => part.type === "weekday")?.value ?? DAYS_OF_WEEK[baseDate.getDay()];
      const hourPart = parts.find((part) => part.type === "hour")?.value ?? "";
      const minutePart = parts.find((part) => part.type === "minute")?.value ?? "";
      const dayPeriod = parts.find((part) => part.type === "dayPeriod")?.value ?? "";

      const hourFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: userTimezone,
        hour: "numeric",
        hour12: false
      });
      const hourParts = hourFormatter.formatToParts(baseDate);
      const hour24 = parseInt(hourParts.find((part) => part.type === "hour")?.value ?? "0", 10);

      return {
        formatted: `${weekday} ${hourPart}:${minutePart} ${dayPeriod}`,
        dayOfWeek: weekday,
        hour: hour24
      };
    } catch {
      // Invalid IANA string; fall through to system time.
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
 * Formats hour/minute values into a 12-hour wall-clock string.
 */
function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
}
