/**
 * @fileoverview Deterministic mixed durable-memory plus browser-status recap rendering.
 */

import {
  basenameCrossPlatformPath,
  dirnameCrossPlatformPath,
  normalizeCrossPlatformPath
} from "../../core/crossPlatformPath";
import { normalizeWhitespace } from "../conversationManagerHelpers";
import type { ConversationBrowserSessionRecord, ConversationSession } from "../sessionStore";
import { ensureStructuredContinuityFactResult } from "./contextualRecallContinuitySupport";
import { resolveConversationStack } from "./contextualRecallSupport";
import type {
  ConversationContinuityEpisodeRecord,
  QueryConversationContinuityEpisodes,
  QueryConversationContinuityFacts
} from "./managerContracts";
import { collectRelationshipContinuityEntityHints } from "./relationshipContinuityContext";

const MONTH_DAY_PATTERN =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/i;

const MONTH_INDEX_BY_NAME: Readonly<Record<string, number>> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
};

interface MixedMemoryStatusRecallInput {
  session: ConversationSession;
  userInput: string;
  queryContinuityFacts?: QueryConversationContinuityFacts;
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
}

interface EmploymentSummary {
  current: string[];
  historical: string[];
}

interface PendingReviewDateCandidate {
  label: string;
  ordinal: number;
  sourcePriority: number;
}

/**
 * Extracts one human-readable subject name from a contact-style fact key.
 *
 * @param key - Stored profile-memory fact key.
 * @returns Human label for the subject, or `null` when unavailable.
 */
function extractSubjectLabelFromFactKey(key: string): string | null {
  const match = /^contact\.([^.]+)/i.exec(key);
  if (!match?.[1]) {
    return null;
  }
  const normalized = match[1].replace(/[_-]+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

/**
 * Normalizes whitespace and light punctuation for human-facing concept labels.
 *
 * @param value - Raw stored organization/place value.
 * @returns Clean display label.
 */
function normalizeFactValueLabel(value: string): string {
  return normalizeWhitespace(value.replace(/\s+/g, " ").trim());
}

/**
 * Collects current and historical employment lines from bounded continuity facts.
 *
 * @param facts - Continuity fact records selected for the current turn.
 * @returns Current and historical employment summaries.
 */
function collectEmploymentSummary(
  facts: readonly { key: string; value: string }[]
): EmploymentSummary {
  const current = new Set<string>();
  const historical = new Set<string>();
  for (const fact of facts) {
    const subjectLabel = extractSubjectLabelFromFactKey(fact.key);
    const normalizedValue = normalizeWhitespace(fact.value);
    if (!subjectLabel || !normalizedValue) {
      continue;
    }
    if (fact.key.endsWith(".work_association")) {
      current.add(`${subjectLabel}: ${normalizeFactValueLabel(normalizedValue)}`);
      continue;
    }
    const historicalMatch =
      /\bno longer at\s+(.+?)(?:[.!]|$)/i.exec(normalizedValue) ??
      /\bused to work at\s+(.+?)(?:[.!]|$)/i.exec(normalizedValue) ??
      /\bformer client\/company[, ]+\s+where .* worked .*? at\s+(.+?)(?:[.!]|$)/i.exec(
        normalizedValue
      );
    if (historicalMatch?.[1]) {
      historical.add(`${subjectLabel}: ${normalizeFactValueLabel(historicalMatch[1])}`);
    }
  }
  return {
    current: [...current],
    historical: [...historical]
  };
}

/**
 * Finds the strongest pending review date from facts or unresolved episodes.
 *
 * @param facts - Continuity fact records selected for the current turn.
 * @param episodes - Continuity episode records selected for the current turn.
 * @returns Active pending review date, or `null` when unavailable.
 */
function findPendingReviewDate(
  facts: readonly { value: string }[],
  episodes: readonly ConversationContinuityEpisodeRecord[]
): string | null {
  const candidates: PendingReviewDateCandidate[] = [];
  for (const fact of facts) {
    const normalizedValue = normalizeWhitespace(fact.value);
    if (
      /\breview\b/i.test(normalizedValue) &&
      /\b(current|active|pending)\b/i.test(normalizedValue)
    ) {
      const factDateCandidate = buildPendingReviewDateCandidate(normalizedValue, 2);
      if (factDateCandidate) {
        candidates.push(factDateCandidate);
      }
    }
  }
  for (const episode of episodes) {
    if (episode.status !== "unresolved") {
      continue;
    }
    const surface = normalizeWhitespace(`${episode.title} ${episode.summary}`);
    if (!/\breview\b/i.test(surface)) {
      continue;
    }
    const episodeDateCandidate = buildPendingReviewDateCandidate(surface, 1);
    if (episodeDateCandidate) {
      candidates.push(episodeDateCandidate);
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((left, right) => {
    if (right.ordinal !== left.ordinal) {
      return right.ordinal - left.ordinal;
    }
    if (right.sourcePriority !== left.sourcePriority) {
      return right.sourcePriority - left.sourcePriority;
    }
    return right.label.localeCompare(left.label);
  });
  return candidates[0]?.label ?? null;
}

/**
 * Builds pending review date candidate.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param surface - Input consumed by this helper.
 * @param sourcePriority - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function buildPendingReviewDateCandidate(
  surface: string,
  sourcePriority: number
): PendingReviewDateCandidate | null {
  const explicitReviewDate =
    /\b([A-Z][a-z]+\s+\d{1,2})\s+review\b/.exec(surface)?.[1] ??
    /\breview\b[\s\S]{0,24}\b([A-Z][a-z]+\s+\d{1,2})\b/.exec(surface)?.[1] ??
    null;
  const candidateLabel =
    explicitReviewDate ??
    (() => {
      const matches = [...surface.matchAll(new RegExp(MONTH_DAY_PATTERN, "gi"))]
        .map((match) => match[0] ?? null)
        .filter((match): match is string => match !== null);
      return matches.length > 0 ? matches[matches.length - 1] ?? null : null;
    })() ??
    null;
  if (!candidateLabel) {
    return null;
  }
  const ordinal = parseMonthDayOrdinal(candidateLabel);
  if (ordinal === null) {
    return null;
  }
  return {
    label: candidateLabel,
    ordinal,
    sourcePriority
  };
}

/**
 * Parses month day ordinal.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param label - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function parseMonthDayOrdinal(label: string): number | null {
  const match = /^\s*([A-Za-z]+)\s+(\d{1,2})\s*$/.exec(label);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const month = MONTH_INDEX_BY_NAME[match[1].toLowerCase()];
  const day = Number.parseInt(match[2], 10);
  if (!month || !Number.isInteger(day) || day < 1 || day > 31) {
    return null;
  }
  return month * 100 + day;
}

/**
 * Finds the current billing-cleanup owner from continuity facts.
 *
 * @param facts - Continuity fact records selected for the current turn.
 * @returns Human-readable billing owner summary, or `null` when unavailable.
 */
function findBillingCleanupOwner(
  facts: readonly { key: string; value: string }[]
): string | null {
  for (const fact of facts) {
    const normalizedValue = normalizeWhitespace(fact.value);
    if (!/\bbilling cleanup\b/i.test(`${fact.key} ${normalizedValue}`)) {
      continue;
    }
    const subjectLabel = extractSubjectLabelFromFactKey(fact.key);
    if (subjectLabel) {
      return `${subjectLabel} currently handles the billing cleanup.`;
    }
    const subjectMatch = /^([A-Z][a-z]+)\b/.exec(normalizedValue);
    if (subjectMatch?.[1]) {
      return `${subjectMatch[1]} currently handles the billing cleanup.`;
    }
  }
  return null;
}

/**
 * Resolves one stable project name for a tracked browser session.
 *
 * @param browserSession - Stored browser session ledger record.
 * @returns Human-facing project name, or `null` when unavailable.
 */
function resolveBrowserProjectName(
  browserSession: ConversationBrowserSessionRecord
): string | null {
  if (browserSession.workspaceRootPath) {
    const basename = basenameCrossPlatformPath(browserSession.workspaceRootPath);
    if (basename) {
      return basename;
    }
  }
  const normalizedUrl = normalizeWhitespace(browserSession.url);
  if (!normalizedUrl) {
    return null;
  }
  if (/^file:\/\//i.test(normalizedUrl)) {
    const decodedPath = normalizeCrossPlatformPath(
      decodeURIComponent(normalizedUrl.replace(/^file:\/\/\/?/i, ""))
    );
    const parentBasename = basenameCrossPlatformPath(
      dirnameCrossPlatformPath(decodedPath)
    );
    if (parentBasename) {
      return parentBasename;
    }
  }
  return browserSession.label.trim() || null;
}

/**
 * Renders deterministic browser/project status lines from tracked browser sessions.
 *
 * @param session - Current conversation session.
 * @returns Human-readable browser/project status lines.
 */
function renderBrowserProjectStatuses(session: ConversationSession): readonly string[] {
  const latestByProject = new Map<
    string,
    { status: ConversationBrowserSessionRecord["status"]; sortKey: string }
  >();
  for (const browserSession of session.browserSessions) {
    const projectName = resolveBrowserProjectName(browserSession);
    if (!projectName) {
      continue;
    }
    const sortKey =
      browserSession.closedAt ??
      browserSession.openedAt ??
      browserSession.sourceJobId ??
      "";
    const existing = latestByProject.get(projectName);
    if (!existing || sortKey.localeCompare(existing.sortKey) >= 0) {
      latestByProject.set(projectName, {
        status: browserSession.status,
        sortKey
      });
    }
  }
  return [...latestByProject.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([projectName, entry]) => `- ${projectName}: ${entry.status === "open" ? "open" : "closed"}.`);
}

/**
 * Builds a deterministic reply for mixed durable-memory plus desktop/browser status recap turns.
 *
 * @param input - Current session, question, and bounded continuity query helpers.
 * @returns Deterministic recap reply, or `null` when continuity queries are unavailable.
 */
export async function renderMixedConversationMemoryStatusRecall(
  input: MixedMemoryStatusRecallInput
): Promise<string | null> {
  if (
    typeof input.queryContinuityFacts !== "function" ||
    typeof input.queryContinuityEpisodes !== "function"
  ) {
    return null;
  }
  const entityHints = collectRelationshipContinuityEntityHints(
    input.session,
    input.userInput
  );
  if (entityHints.length === 0) {
    return null;
  }
  const stack = resolveConversationStack(input.session);
  const [supportingFacts, supportingEpisodes] = await Promise.all([
    input.queryContinuityFacts({
      stack,
      entityHints,
      semanticMode: "relationship_inventory",
      relevanceScope: "conversation_local",
      maxFacts: 18
    }).catch(() => []),
    input.queryContinuityEpisodes({
      stack,
      entityHints,
      semanticMode: "event_history",
      relevanceScope: "conversation_local",
      maxEpisodes: 8
    }).catch(() => [])
  ]);
  const structuredFacts = ensureStructuredContinuityFactResult(supportingFacts, {
    semanticMode: "relationship_inventory",
    relevanceScope: "conversation_local"
  });
  const employmentSummary = collectEmploymentSummary(structuredFacts);
  const pendingReviewDate = findPendingReviewDate(structuredFacts, supportingEpisodes);
  const billingCleanupOwner = findBillingCleanupOwner(structuredFacts);
  const personalLines: string[] = [];
  if (employmentSummary.current.length > 0) {
    personalLines.push(`- Current employment: ${employmentSummary.current.join("; ")}.`);
  }
  if (employmentSummary.historical.length > 0) {
    personalLines.push(`- Historical employment: ${employmentSummary.historical.join("; ")}.`);
  }
  if (pendingReviewDate) {
    personalLines.push(`- Active pending review date: ${pendingReviewDate}.`);
  }
  if (billingCleanupOwner) {
    personalLines.push(`- Billing cleanup: ${billingCleanupOwner}`);
  }
  if (personalLines.length === 0) {
    const temporalCurrent = structuredFacts.temporalSynthesis?.currentState ?? [];
    const temporalHistorical = structuredFacts.temporalSynthesis?.historicalContext ?? [];
    if (temporalCurrent.length > 0) {
      personalLines.push(`- Current memory context: ${temporalCurrent.join(" ")}`);
    }
    if (temporalHistorical.length > 0) {
      personalLines.push(`- Historical memory context: ${temporalHistorical.join(" ")}`);
    }
  }
  if (personalLines.length === 0) {
    personalLines.push("- I do not have enough durable memory to answer the personal side cleanly yet.");
  }

  const browserProjectLines = [...renderBrowserProjectStatuses(input.session)];
  if (browserProjectLines.length === 0) {
    browserProjectLines.push("- I do not have any tracked browser sessions for those projects right now.");
  }

  return [
    "Personal facts:",
    ...personalLines,
    "",
    "Desktop project status:",
    ...browserProjectLines
  ].join("\n");
}
