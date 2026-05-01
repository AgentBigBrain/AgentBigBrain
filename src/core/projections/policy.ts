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

const WINDOWS_LOCAL_PATH_PATTERN =
  /\b[A-Za-z]:\\(?:Users\\[^\\\r\n]+|[^ \t\r\n]+)/g;
const POSIX_HOME_PATH_PATTERN = /\/home\/[^/\s]+\/[^\r\n\s]*/g;
const ONEDRIVE_PATH_TOKEN_PATTERN = /\bOneDrive\b/gi;
const REPO_WORKSPACE_TOKEN_PATTERN = /\bAgentBigBrain-public\b/g;

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
 * Redacts local filesystem details from text rendered into review-safe projection mirrors.
 *
 * **Why it exists:**
 * Obsidian review mirrors can leave the encrypted/local runtime boundary, so review-safe mode must
 * not expose host-specific paths, workspace names, or the current OS username even when old memory
 * episodes or workflow patterns contain them.
 *
 * **What it talks to:**
 * - Uses local path redaction patterns in this module.
 *
 * @param mode - Active projection mode.
 * @param text - Projected Markdown or note-path text.
 * @returns Redacted text in review-safe mode, or original text in operator-full mode.
 */
export function redactReviewSafeProjectionText(mode: ProjectionMode, text: string): string {
  if (mode === "operator_full" || text.length === 0) {
    return text;
  }

  let redacted = text
    .replace(WINDOWS_LOCAL_PATH_PATTERN, "[redacted local path]")
    .replace(POSIX_HOME_PATH_PATTERN, "[redacted local path]")
    .replace(ONEDRIVE_PATH_TOKEN_PATTERN, "[redacted storage root]")
    .replace(REPO_WORKSPACE_TOKEN_PATTERN, "[redacted workspace]");

  const username = (process.env.USERNAME ?? process.env.USER ?? "").trim();
  if (username.length >= 3) {
    redacted = redacted.replace(
      new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(username)}(?=$|[^A-Za-z0-9])`, "gi"),
      "$1[redacted user]"
    );
  }

  return redacted;
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
 * Escapes a literal string for use inside a dynamically constructed regular expression.
 *
 * **Why it exists:**
 * Review-safe redaction includes the current OS username when present, and usernames must be
 * treated as literal text instead of regex syntax.
 *
 * **What it talks to:**
 * - Uses local string replacement only.
 *
 * @param value - Literal string to escape.
 * @returns Regex-safe literal string.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const matchingClaims = collectProjectedCurrentSurfaceClaimsForEntity(snapshot, entity).length;
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

/**
 * Collects current-surface claims that should be shown alongside one continuity entity note.
 *
 * **Why it exists:**
 * Profile-memory truth and Stage 6.86 continuity are stored separately. Contact org/place claims
 * often reach the current surface before they are explicitly stamped into claim `entityRefIds`, so
 * the mirror needs one bounded reconciliation helper instead of pretending those claims do not
 * exist.
 *
 * @param snapshot - Full projection snapshot.
 * @param entity - Continuity entity under consideration.
 * @returns Current-surface claims that align to the entity.
 */
export function collectProjectedCurrentSurfaceClaimsForEntity(
  snapshot: ProjectionSnapshot,
  entity: EntityNodeV1
): readonly ProfileMemoryGraphClaimRecord[] {
  const normalizedEntityName = normalizeProjectionIdentityLabel(entity.canonicalName);
  const normalizedEntityToken = normalizeProjectionContactToken(entity.canonicalName);
  const contactTokensByName = collectContactTokensForProjectedEntityName(
    snapshot.currentSurfaceClaims,
    normalizedEntityName
  );

  return snapshot.currentSurfaceClaims.filter((claim) => {
    if (claim.payload.entityRefIds.includes(entity.entityKey)) {
      return true;
    }
    const normalizedKey = normalizeProjectionIdentityLabel(claim.payload.normalizedKey);
    const normalizedValue = normalizeProjectionIdentityLabel(claim.payload.normalizedValue ?? "");
    if (entity.entityType === "person") {
      const parsedContactClaim = parseProjectedContactClaimKey(normalizedKey);
      if (!parsedContactClaim) {
        return false;
      }
      return contactTokensByName.has(parsedContactClaim.contactToken)
        || (
          normalizedEntityToken.length > 0
          && parsedContactClaim.contactToken === normalizedEntityToken
        );
    }
    if (normalizedValue !== normalizedEntityName) {
      return false;
    }
    if (entity.entityType === "org") {
      return isProjectedOrganizationAssociationField(
        parseProjectedContactClaimKey(normalizedKey)?.field ?? ""
      );
    }
    if (entity.entityType === "place") {
      return isProjectedLocationAssociationField(
        parseProjectedContactClaimKey(normalizedKey)?.field ?? ""
      );
    }
    return false;
  });
}

/**
 * Collects contact tokens whose current name claim matches one projected entity name.
 *
 * **Why it exists:**
 * Contact claim keys are token based (`contact.billy.*`) while continuity person names can be
 * promoted to richer labels (`Billy Smith`). The mirror needs the token/name bridge to keep all
 * current-surface claims aligned after that promotion.
 *
 * @param claims - Current-surface graph claims.
 * @param normalizedEntityName - Normalized projected entity label.
 * @returns Contact tokens that name this entity.
 */
function collectContactTokensForProjectedEntityName(
  claims: readonly ProfileMemoryGraphClaimRecord[],
  normalizedEntityName: string
): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const claim of claims) {
    const parsedContactClaim = parseProjectedContactClaimKey(
      normalizeProjectionIdentityLabel(claim.payload.normalizedKey)
    );
    if (
      parsedContactClaim?.field === "name"
      && normalizeProjectionIdentityLabel(claim.payload.normalizedValue ?? "") === normalizedEntityName
    ) {
      tokens.add(parsedContactClaim.contactToken);
    }
  }
  return tokens;
}

/**
 * Parses one normalized contact claim key into token and field components.
 *
 * @param normalizedKey - Lowercase, trimmed graph-claim key.
 * @returns Parsed contact token and field, or `null` for non-contact keys.
 */
function parseProjectedContactClaimKey(
  normalizedKey: string
): { contactToken: string; field: string } | null {
  const segments = normalizedKey.split(".");
  if (segments.length < 3 || segments[0] !== "contact") {
    return null;
  }
  const contactToken = segments[1]?.trim() ?? "";
  const field = segments.slice(2).join(".").trim();
  return contactToken && field
    ? { contactToken, field }
    : null;
}

/**
 * Normalizes one projection identity label for conservative exact matching.
 *
 * @param value - Raw label or claim value.
 * @returns Lowercase label with collapsed whitespace.
 */
function normalizeProjectionIdentityLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Converts a projected person label into the fallback contact-token shape.
 *
 * @param value - Raw entity label.
 * @returns Contact token derived from the label.
 */
function normalizeProjectionContactToken(value: string): string {
  return normalizeProjectionIdentityLabel(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Returns whether a contact claim field represents organization association.
 *
 * @param field - Parsed contact-claim field.
 * @returns `true` for organization association fields.
 */
function isProjectedOrganizationAssociationField(field: string): boolean {
  return field === "work_association" || field === "organization_association";
}

/**
 * Returns whether a contact claim field represents location association.
 *
 * @param field - Parsed contact-claim field.
 * @returns `true` for location association fields.
 */
function isProjectedLocationAssociationField(field: string): boolean {
  return field === "location_association"
    || field === "primary_location_association"
    || field === "secondary_location_association";
}
