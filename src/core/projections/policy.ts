/**
 * @fileoverview Applies projection redaction policy for mirrored notes, claims, and owned media assets.
 */

import { getStopWordsForLanguageDomain } from "../languageRuntime/stopWordPolicy";
import type { MediaArtifactRecord } from "../mediaArtifacts";
import type { ProfileFactRecord, ProfileMemoryGraphClaimRecord, ProfileMemoryState } from "../profileMemory";
import type { EntityNodeV1 } from "../types";
import type { ProjectionMode } from "./contracts";
import type { ProjectionSnapshot } from "./contracts";

const LOW_SIGNAL_ENTITY_EXTRA_STOP_WORDS = new Set([
  "also",
  "both",
  "can",
  "correct",
  "good",
  "hello",
  "hey",
  "how",
  "i",
  "i'd",
  "i'm",
  "if",
  "it",
  "look",
  "no",
  "now",
  "okay",
  "please",
  "status",
  "stop",
  "tell",
  "thanks",
  "this",
  "well"
]);

/**
 * Returns whether one raw media asset may be mirrored in the current projection mode.
 *
 * **Why it exists:**
 * The vault mirror can expose a wider surface than the encrypted runtime stores, so asset copying
 * needs one central policy gate instead of scattering mode checks across renderers.
 *
 * **What it talks to:**
 * - Uses `MediaArtifactRecord` from `../mediaArtifacts`.
 *
 * @param mode - Active projection mode.
 * @param artifact - Canonical media artifact under consideration.
 * @returns `true` when the raw owned asset may be mirrored.
 */
export function shouldMirrorMediaAsset(
  mode: ProjectionMode,
  artifact: MediaArtifactRecord
): boolean {
  if (mode === "operator_full") {
    return true;
  }
  return artifact.kind === "document" ? false : false;
}

/**
 * Returns whether one graph claim may expose its raw value in the current projection mode.
 *
 * **Why it exists:**
 * Review-safe mirrors still need relational visibility, but sensitive claim values should stay
 * redacted unless the operator has explicitly enabled the fuller projection mode.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryGraphClaimRecord` from `../profileMemory`.
 *
 * @param mode - Active projection mode.
 * @param claim - Graph-backed claim record under consideration.
 * @returns `true` when the claim value may be rendered directly.
 */
export function canExposeClaimValue(
  mode: ProjectionMode,
  claim: ProfileMemoryGraphClaimRecord
): boolean {
  return mode === "operator_full" || claim.payload.sensitive !== true;
}

/**
 * Builds a safe user-facing claim value for the current projection mode.
 *
 * **Why it exists:**
 * Renderers should not each invent their own redaction labels, because that causes mirror drift
 * across entities, dashboards, Bases files, and review artifacts.
 *
 * **What it talks to:**
 * - Uses `canExposeClaimValue(...)` within this module.
 *
 * @param mode - Active projection mode.
 * @param claim - Graph-backed claim record under consideration.
 * @returns Safe value string for note rendering.
 */
export function renderProjectedClaimValue(
  mode: ProjectionMode,
  claim: ProfileMemoryGraphClaimRecord
): string {
  if (canExposeClaimValue(mode, claim)) {
    return claim.payload.normalizedValue ?? "(no value)";
  }
  return "[redacted in review_safe mode]";
}

/**
 * Builds a safe user-facing compatibility-fact value for the current projection mode.
 *
 * **Why it exists:**
 * The Obsidian mirror now exposes retained compatibility facts directly, so that note surface
 * needs the same centralized redaction rule as graph-backed claim rendering.
 *
 * **What it talks to:**
 * - Uses `ProfileFactRecord` from `../profileMemory`.
 *
 * @param mode - Active projection mode.
 * @param fact - Retained compatibility fact under consideration.
 * @returns Safe value string for note rendering.
 */
export function renderProjectedCompatibilityFactValue(
  mode: ProjectionMode,
  fact: ProfileFactRecord
): string {
  if (mode === "operator_full" || fact.sensitive !== true) {
    return fact.value;
  }
  return "[redacted in review_safe mode]";
}

/**
 * Returns the count of sensitive compatibility facts currently present in profile memory.
 *
 * **Why it exists:**
 * Dashboard summaries should explain that redaction removed some values without leaking those
 * values, and this helper keeps the count logic centralized.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryState` from `../profileMemory`.
 *
 * @param state - Profile-memory snapshot, or `null` when disabled.
 * @returns Number of sensitive compatibility facts in the snapshot.
 */
export function countSensitiveCompatibilityFacts(
  state: ProfileMemoryState | null
): number {
  return state?.facts.filter((fact) => fact.sensitive).length ?? 0;
}

/**
 * Returns whether one entity should appear as a first-class mirrored note.
 *
 * **Why it exists:**
 * The raw entity graph can contain lexical artifacts that are useful internally for continuity but
 * produce empty, distracting Obsidian notes, so the mirror needs a higher bar for what becomes a
 * browsable operator note.
 *
 * **What it talks to:**
 * - Uses `getStopWordsForLanguageDomain(...)` from `../languageRuntime/stopWordPolicy`.
 * - Uses `ProjectionSnapshot` from `./contracts`.
 * - Uses `EntityNodeV1` from `../types`.
 *
 * @param snapshot - Full projection snapshot.
 * @param entity - Entity under consideration.
 * @returns `true` when the entity has enough signal to project as a note.
 */
export function shouldProjectEntityNote(
  snapshot: ProjectionSnapshot,
  entity: EntityNodeV1
): boolean {
  const matchingClaims = snapshot.resolvedCurrentClaims.filter((claim) =>
    claim.payload.entityRefIds.includes(entity.entityKey)
  ).length;
  const relatedEdges = snapshot.entityGraph.edges.filter((edge) =>
    edge.sourceEntityKey === entity.entityKey || edge.targetEntityKey === entity.entityKey
  ).length;
  const relatedEpisodes = (snapshot.profileMemory?.episodes ?? []).filter((episode) =>
    episode.entityRefs.includes(entity.entityKey)
  ).length;
  const relatedOpenLoops = snapshot.runtimeState.conversationStack.threads
    .flatMap((thread) => thread.openLoops ?? [])
    .filter((loop) => loop.entityRefs.includes(entity.entityKey)).length;
  const relatedArtifacts = snapshot.mediaArtifacts.filter((artifact) =>
    artifact.derivedMeaning.entityHints.includes(entity.entityKey)
    || artifact.derivedMeaning.entityHints.includes(entity.canonicalName)
    || entity.aliases.some((alias) => artifact.derivedMeaning.entityHints.includes(alias))
  ).length;
  const strongAnchors =
    matchingClaims > 0
    || relatedEpisodes > 0
    || relatedOpenLoops > 0
    || relatedArtifacts > 0;

  const normalizedName = entity.canonicalName.trim().toLowerCase();
  const tokenStopWords = getStopWordsForLanguageDomain("conversation_topic");
  const tokens = normalizedName
    .split(/[^a-z0-9']+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const containsSentencePunctuation = /[.!?]/.test(entity.canonicalName);
  const isLowSignalToken = (token: string): boolean =>
    token.length <= 2
    || tokenStopWords.has(token)
    || LOW_SIGNAL_ENTITY_EXTRA_STOP_WORDS.has(token);
  const lowSignalRatio = tokens.length === 0
    ? 1
    : tokens.filter((token) => isLowSignalToken(token)).length / tokens.length;
  const hasLowSignalBoundary =
    tokens.length > 1 && (isLowSignalToken(tokens[0]) || isLowSignalToken(tokens[tokens.length - 1]));
  const hasStandaloneProperShape = /^[A-Z0-9][A-Za-z0-9'’.+-]*(?: [A-Z0-9][A-Za-z0-9'’.+-]*){0,3}$/
    .test(entity.canonicalName.trim());

  if (tokens.length === 0) {
    return false;
  }
  if (
    tokens.length === 1
    && isLowSignalToken(tokens[0])
  ) {
    return strongAnchors;
  }
  if (tokens.every((token) => isLowSignalToken(token))) {
    return strongAnchors;
  }

  if (strongAnchors) {
    return true;
  }

  if (containsSentencePunctuation) {
    return false;
  }

  if (lowSignalRatio >= 0.5) {
    return false;
  }

  if (hasLowSignalBoundary && relatedEdges < 2) {
    return false;
  }

  if (
    (entity.entityType === "person" || entity.entityType === "place" || entity.entityType === "org")
    && hasStandaloneProperShape
  ) {
    return entity.salience >= 0.75 && entity.evidenceRefs.length >= 1;
  }

  if (relatedEdges > 0) {
    return entity.evidenceRefs.length >= 2 && entity.salience >= 1.5;
  }

  if (hasStandaloneProperShape && entity.entityType === "thing") {
    return entity.evidenceRefs.length >= 3 && entity.salience >= 3;
  }

  if (entity.entityType === "person" || entity.entityType === "place" || entity.entityType === "org") {
    return entity.salience >= 0.75 && entity.evidenceRefs.length >= 1;
  }

  if (entity.evidenceRefs.length >= 2) {
    return true;
  }
  return entity.salience >= 3 && entity.evidenceRefs.length >= 1;
}
