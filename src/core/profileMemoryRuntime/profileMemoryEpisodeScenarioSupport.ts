/**
 * @fileoverview Shared scenario-pattern helpers for bounded episodic-memory extraction.
 */

import type { CreateProfileEpisodeRecordInput } from "./profileMemoryEpisodeContracts";
import {
  displayNameFromContactToken,
  normalizeProfileValue,
  trimTrailingClausePunctuation
} from "./profileMemoryNormalization";
import {
  extractEpisodeContactToken,
  extractPendingLaunchReviewCandidate,
  extractTentativeConsiderationCandidate,
  extractTentativeMoveCandidate,
  normalizeEpisodeSurface,
  normalizeScenarioEntityRefs,
  recordScenarioEpisodeCandidate,
  ScenarioEpisodeContext,
  trimTransferEpisodeObjectSurface
} from "./profileMemoryEpisodeScenarioPrimitives";

interface EpisodePattern {
  pattern: RegExp;
  canonicalEvent: string;
  tags: readonly string[];
}

const EPISODE_SUBJECT_PATTERN =
  "([A-Z][A-Za-z']+(?:[ -][A-Z][A-Za-z']+){0,2})";

const EPISODE_PATTERNS: readonly EpisodePattern[] = [
  {
    pattern: new RegExp(
      `\\b${EPISODE_SUBJECT_PATTERN}\\s+(fell down|had a fall|fell and got hurt)\\b`,
      "i"
    ),
    canonicalEvent: "fell down",
    tags: ["injury", "fall", "followup"]
  },
  {
    pattern: new RegExp(
      `\\b${EPISODE_SUBJECT_PATTERN}\\s+(got hurt|was hurt|got injured|was injured)\\b`,
      "i"
    ),
    canonicalEvent: "got hurt",
    tags: ["injury", "followup"]
  },
  {
    pattern: new RegExp(
      `\\b${EPISODE_SUBJECT_PATTERN}\\s+(got sick|was sick|has been sick)\\b`,
      "i"
    ),
    canonicalEvent: "got sick",
    tags: ["health", "followup"]
  },
  {
    pattern: new RegExp(
      `\\b${EPISODE_SUBJECT_PATTERN}\\s+(was hospitalized|went to the hospital|had surgery)\\b`,
      "i"
    ),
    canonicalEvent: "had a medical situation",
    tags: ["health", "medical", "followup"]
  },
  {
    pattern: new RegExp(
      `\\b${EPISODE_SUBJECT_PATTERN}\\s+(lost (?:his|her|their) job|got fired)\\b`,
      "i"
    ),
    canonicalEvent: "lost a job",
    tags: ["work", "followup"]
  },
  {
    pattern: new RegExp(
      `\\b${EPISODE_SUBJECT_PATTERN}\\s+(was in an accident|got into an accident)\\b`,
      "i"
    ),
    canonicalEvent: "was in an accident",
    tags: ["accident", "followup"]
  }
];

const EPISODE_TRANSFER_PATTERN = new RegExp(
  `\\b${EPISODE_SUBJECT_PATTERN}\\s+sold\\s+${EPISODE_SUBJECT_PATTERN}\\s+the\\s+([A-Za-z0-9' -]+)\\b`,
  "i"
);

/**
 * Creates scenario episode context.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ScenarioEpisodeContext` (import `ScenarioEpisodeContext`) from `./profileMemoryEpisodeScenarioPrimitives`.
 * @returns Result produced by this helper.
 */
export function createScenarioEpisodeContext(): ScenarioEpisodeContext {
  return {
    lastLaunchReviewTitle: null,
    lastLaunchReviewEntityRefs: [],
    lastMoveContactToken: null
  };
}

/**
 * Splits into episode sentences.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `normalizeProfileValue` (import `normalizeProfileValue`) from `./profileMemoryNormalization`.
 * @param text - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function splitIntoEpisodeSentences(text: string): string[] {
  return text
    .split(/[\n.!?]+/)
    .map((segment) => normalizeProfileValue(segment))
    .filter((segment) => segment.length >= 8);
}

/**
 * Extracts pattern episode candidate.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `CreateProfileEpisodeRecordInput` (import `CreateProfileEpisodeRecordInput`) from `./profileMemoryEpisodeContracts`.
 * - Uses `extractEpisodeContactToken` (import `extractEpisodeContactToken`) from `./profileMemoryEpisodeScenarioPrimitives`.
 * - Uses `displayNameFromContactToken` (import `displayNameFromContactToken`) from `./profileMemoryNormalization`.
 * - Uses `trimTrailingClausePunctuation` (import `trimTrailingClausePunctuation`) from `./profileMemoryNormalization`.
 * @param sentence - Input consumed by this helper.
 * @param sourceTaskId - Input consumed by this helper.
 * @param observedAt - Input consumed by this helper.
 * @param seen - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function extractPatternEpisodeCandidate(
  sentence: string,
  sourceTaskId: string,
  observedAt: string,
  seen: Set<string>
): CreateProfileEpisodeRecordInput | null {
  for (const episodePattern of EPISODE_PATTERNS) {
    const match = episodePattern.pattern.exec(sentence);
    if (!match) {
      continue;
    }

    const rawName = trimTrailingClausePunctuation(match[1] ?? "");
    const contactToken = extractEpisodeContactToken(rawName);
    if (!contactToken) {
      return null;
    }

    const displayName = displayNameFromContactToken(contactToken);
    const title = `${displayName} ${episodePattern.canonicalEvent}`;
    const summary = trimTrailingClausePunctuation(sentence);
    const signature = `${contactToken}|${episodePattern.canonicalEvent}`;
    if (seen.has(signature)) {
      return null;
    }
    seen.add(signature);
    return {
      title,
      summary,
      sourceTaskId,
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt,
      confidence: toEpisodeConfidence(sentence),
      entityRefs: [`contact.${contactToken}`],
      tags: episodePattern.tags
    };
  }

  return null;
}

/**
 * Extracts scenario episode candidate.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `CreateProfileEpisodeRecordInput` (import `CreateProfileEpisodeRecordInput`) from `./profileMemoryEpisodeContracts`.
 * - Uses `extractPendingLaunchReviewCandidate` (import `extractPendingLaunchReviewCandidate`) from `./profileMemoryEpisodeScenarioPrimitives`.
 * - Uses `extractTentativeConsiderationCandidate` (import `extractTentativeConsiderationCandidate`) from `./profileMemoryEpisodeScenarioPrimitives`.
 * - Uses `extractTentativeMoveCandidate` (import `extractTentativeMoveCandidate`) from `./profileMemoryEpisodeScenarioPrimitives`.
 * - Uses `recordScenarioEpisodeCandidate` (import `recordScenarioEpisodeCandidate`) from `./profileMemoryEpisodeScenarioPrimitives`.
 * - Uses `ScenarioEpisodeContext` (import `ScenarioEpisodeContext`) from `./profileMemoryEpisodeScenarioPrimitives`.
 * @param sentence - Input consumed by this helper.
 * @param sourceTaskId - Input consumed by this helper.
 * @param observedAt - Input consumed by this helper.
 * @param seen - Input consumed by this helper.
 * @param context - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function extractScenarioEpisodeCandidate(
  sentence: string,
  sourceTaskId: string,
  observedAt: string,
  seen: Set<string>,
  context: ScenarioEpisodeContext
): CreateProfileEpisodeRecordInput | null {
  const pendingLaunchReviewCandidate = extractPendingLaunchReviewCandidate(
    sentence,
    sourceTaskId,
    observedAt,
    context,
    toEpisodeConfidence
  );
  if (pendingLaunchReviewCandidate) {
    return recordScenarioEpisodeCandidate(pendingLaunchReviewCandidate, seen);
  }

  const tentativeConsiderationCandidate = extractTentativeConsiderationCandidate(
    sentence,
    sourceTaskId,
    observedAt,
    toEpisodeConfidence
  );
  if (tentativeConsiderationCandidate) {
    return recordScenarioEpisodeCandidate(tentativeConsiderationCandidate, seen);
  }

  const tentativeMoveCandidate = extractTentativeMoveCandidate(
    sentence,
    sourceTaskId,
    observedAt,
    context,
    toEpisodeConfidence
  );
  if (tentativeMoveCandidate) {
    return recordScenarioEpisodeCandidate(tentativeMoveCandidate, seen);
  }

  return null;
}

/**
 * Extracts transfer episode candidate.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `CreateProfileEpisodeRecordInput` (import `CreateProfileEpisodeRecordInput`) from `./profileMemoryEpisodeContracts`.
 * - Uses `extractEpisodeContactToken` (import `extractEpisodeContactToken`) from `./profileMemoryEpisodeScenarioPrimitives`.
 * - Uses `trimTransferEpisodeObjectSurface` (import `trimTransferEpisodeObjectSurface`) from `./profileMemoryEpisodeScenarioPrimitives`.
 * - Uses `displayNameFromContactToken` (import `displayNameFromContactToken`) from `./profileMemoryNormalization`.
 * - Uses `trimTrailingClausePunctuation` (import `trimTrailingClausePunctuation`) from `./profileMemoryNormalization`.
 * @param sentence - Input consumed by this helper.
 * @param sourceTaskId - Input consumed by this helper.
 * @param observedAt - Input consumed by this helper.
 * @param seen - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function extractTransferEpisodeCandidate(
  sentence: string,
  sourceTaskId: string,
  observedAt: string,
  seen: Set<string>
): CreateProfileEpisodeRecordInput | null {
  const match = EPISODE_TRANSFER_PATTERN.exec(sentence);
  if (!match) {
    return null;
  }

  const sellerRawName = trimTrailingClausePunctuation(match[1] ?? "");
  const buyerRawName = trimTrailingClausePunctuation(match[2] ?? "");
  const rawObject = trimTrailingClausePunctuation(match[3] ?? "");
  const sellerToken = extractEpisodeContactToken(sellerRawName);
  const buyerToken = extractEpisodeContactToken(buyerRawName);
  const objectSurface = trimTransferEpisodeObjectSurface(rawObject);
  if (!sellerToken || !buyerToken || !objectSurface || sellerToken === buyerToken) {
    return null;
  }

  const sellerDisplayName = displayNameFromContactToken(sellerToken);
  const buyerDisplayName = displayNameFromContactToken(buyerToken);
  const title = `${sellerDisplayName} sold ${buyerDisplayName} the ${objectSurface}`;
  const summary = trimTrailingClausePunctuation(sentence);
  const signature = `sale|${sellerToken}|${buyerToken}|${objectSurface.toLowerCase()}`;
  if (seen.has(signature)) {
    return null;
  }
  seen.add(signature);
  return {
    title,
    summary,
    sourceTaskId,
    source: "user_input_pattern.episode_candidate",
    sourceKind: "explicit_user_statement",
    sensitive: false,
    observedAt,
    confidence: toEpisodeConfidence(sentence),
    entityRefs: [`contact.${sellerToken}`, `contact.${buyerToken}`, objectSurface],
    tags: ["followup", "transaction", "transfer"]
  };
}

/**
 * Updates scenario episode context.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `extractEpisodeContactToken` (import `extractEpisodeContactToken`) from `./profileMemoryEpisodeScenarioPrimitives`.
 * - Uses `ScenarioEpisodeContext` (import `ScenarioEpisodeContext`) from `./profileMemoryEpisodeScenarioPrimitives`.
 * - Uses `trimTrailingClausePunctuation` (import `trimTrailingClausePunctuation`) from `./profileMemoryNormalization`.
 * @param context - Input consumed by this helper.
 * @param sentence - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function updateScenarioEpisodeContext(
  context: ScenarioEpisodeContext,
  sentence: string
): void {
  const nextReviewTitle = extractLaunchReviewTitle(sentence);
  if (nextReviewTitle) {
    context.lastLaunchReviewTitle = nextReviewTitle;
    context.lastLaunchReviewEntityRefs = extractLaunchReviewEntityRefs(sentence);
  }

  if (!/\bmov/i.test(sentence.toLowerCase())) {
    return;
  }
  const moveSubjectMatch = new RegExp(`${EPISODE_SUBJECT_PATTERN}\\s+.*\\bmov`, "i").exec(sentence);
  const contactToken = extractEpisodeContactToken(
    trimTrailingClausePunctuation(moveSubjectMatch?.[1] ?? "")
  );
  if (contactToken) {
    context.lastMoveContactToken = contactToken;
  }
}

/**
 * Converts to episode confidence.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param text - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function toEpisodeConfidence(text: string): number {
  const normalized = text.toLowerCase();
  return normalized.includes("maybe") ||
    normalized.includes("might") ||
    normalized.includes("not sure") ||
    normalized.includes("i think")
    ? 0.72
    : 0.9;
}

/**
 * Extracts launch review title.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `normalizeEpisodeSurface` (import `normalizeEpisodeSurface`) from `./profileMemoryEpisodeScenarioPrimitives`.
 * - Uses `trimTrailingClausePunctuation` (import `trimTrailingClausePunctuation`) from `./profileMemoryNormalization`.
 * @param sentence - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function extractLaunchReviewTitle(sentence: string): string | null {
  const explicitTargetMatch =
    /\blaunch review for (?:the )?([A-Z][A-Za-z0-9'&/-]+(?:[ -][A-Z][A-Za-z0-9'&/-]+){0,4})\b/i.exec(
      sentence
    );
  const namedReviewMatch =
    /\b([A-Z][A-Za-z0-9'&/-]+(?:[ -][A-Z][A-Za-z0-9'&/-]+){0,4}\s+launch review)\b/i.exec(
      sentence
    );
  const targetSurface = normalizeEpisodeSurface(
    trimTrailingClausePunctuation(explicitTargetMatch?.[1] ?? "")
  );
  const namedReviewSurface = normalizeEpisodeSurface(
    trimTrailingClausePunctuation(namedReviewMatch?.[1] ?? "")
  );
  if (targetSurface) {
    return `${targetSurface} launch review`;
  }
  return namedReviewSurface.replace(
    /^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\s+/u,
    ""
  ) || null;
}

/**
 * Extracts launch review entity refs.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `normalizeEpisodeSurface` (import `normalizeEpisodeSurface`) from `./profileMemoryEpisodeScenarioPrimitives`.
 * - Uses `normalizeScenarioEntityRefs` (import `normalizeScenarioEntityRefs`) from `./profileMemoryEpisodeScenarioPrimitives`.
 * - Uses `trimTrailingClausePunctuation` (import `trimTrailingClausePunctuation`) from `./profileMemoryNormalization`.
 * @param sentence - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function extractLaunchReviewEntityRefs(sentence: string): string[] {
  const explicitTargetMatch =
    /\blaunch review for (?:the )?([A-Z][A-Za-z0-9'&/-]+(?:[ -][A-Z][A-Za-z0-9'&/-]+){0,4})\b/i.exec(
      sentence
    );
  const namedReviewMatch =
    /\b([A-Z][A-Za-z0-9'&/-]+(?:[ -][A-Z][A-Za-z0-9'&/-]+){0,4}\s+launch review)\b/i.exec(
      sentence
    );
  const targetSurface = normalizeEpisodeSurface(
    trimTrailingClausePunctuation(explicitTargetMatch?.[1] ?? "")
  );
  const namedReviewSurface = normalizeEpisodeSurface(
    trimTrailingClausePunctuation(namedReviewMatch?.[1] ?? "")
  );
  const reviewEntitySurface = targetSurface ||
    namedReviewSurface
      .replace(
        /^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\s+/u,
        ""
      )
      .replace(/\s+launch review$/iu, "")
      .replace(/\s+website$/iu, "");
  return normalizeScenarioEntityRefs([reviewEntitySurface]);
}
