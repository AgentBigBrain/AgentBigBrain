/**
 * @fileoverview Renders derived concept notes for named organizations and places surfaced from retained facts and media hints.
 */

import type { ProfileFactRecord } from "../../profileMemory";
import type { ProjectionSnapshot } from "../contracts";
import { renderProjectedCompatibilityFactValue } from "../policy";
import {
  buildMediaArtifactNoteRelativePath,
  renderObsidianWikiLink
} from "./obsidianLinks";
import {
  renderMarkdownList,
  renderObsidianFrontmatter,
  sanitizeObsidianPathSegment,
  type ObsidianProjectedNote
} from "./obsidianFrontmatter";

type DerivedConceptKind = "organization" | "place" | "document_term" | "mixed";
type DerivedConceptSourceKind =
  | "profile_direct_fact"
  | "profile_context"
  | "media_entity_hint";

interface DerivedConceptMention {
  readonly conceptKey: string;
  readonly label: string;
  readonly kind: DerivedConceptKind;
  readonly sourceKind: DerivedConceptSourceKind;
  readonly profileSubjectKey: string | null;
  readonly sourceFactKey: string | null;
  readonly mediaArtifactId: string | null;
  readonly observedAt: string;
  readonly evidence: string;
}

export interface ObsidianDerivedConceptGroup {
  readonly conceptKey: string;
  readonly label: string;
  readonly kind: DerivedConceptKind;
  readonly mentions: readonly DerivedConceptMention[];
  readonly updatedAt: string;
}

const CONCEPT_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "announced",
  "attached",
  "but",
  "county",
  "day",
  "do",
  "for",
  "from",
  "good",
  "he",
  "hello",
  "hey",
  "how",
  "i",
  "if",
  "in",
  "it",
  "just",
  "look",
  "march",
  "mid",
  "no",
  "now",
  "nobody",
  "nora",
  "okay",
  "on",
  "or",
  "pull",
  "review",
  "sam",
  "so",
  "start",
  "status",
  "stop",
  "tell",
  "thanks",
  "that",
  "the",
  "then",
  "there",
  "this",
  "treat",
  "week",
  "while",
  "who",
  "year",
  "you"
]);
const MONTH_WORDS = new Set([
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
]);
const ORG_HINT_TOKENS = new Set([
  "analytics",
  "clinic",
  "company",
  "corp",
  "corporation",
  "design",
  "group",
  "inc",
  "inc.",
  "labs",
  "llc",
  "ltd",
  "studio",
  "systems",
  "university",
  "web"
]);
const PLACE_HINT_TOKENS = new Set([
  "annarbor",
  "arbor",
  "center",
  "corktown",
  "county",
  "detroit",
  "downtown",
  "ferndale",
  "midtown",
  "office",
  "town"
]);
const PRESERVED_UPPERCASE_TOKENS = new Set([
  "AI",
  "API",
  "CSS",
  "HTML",
  "LLC",
  "OCR",
  "PDF",
  "UI",
  "UX"
]);

/**
 * Groups derived named concepts from retained facts and media hints.
 *
 * **Why it exists:**
 * Organization and place names often live inside retained fact values or media-derived hints
 * without becoming first-class profile subjects, so the mirror needs a projection-only index for
 * those concepts.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` from `../contracts`.
 * - Uses `ProfileFactRecord` and `MediaArtifactRecord` from runtime contracts.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Stable grouped concept records for note rendering and linking.
 */
export function buildDerivedConceptGroups(
  snapshot: ProjectionSnapshot
): readonly ObsidianDerivedConceptGroup[] {
  const mentions: DerivedConceptMention[] = [
    ...buildProfileFactConceptMentions(snapshot),
    ...buildMediaArtifactConceptMentions(snapshot)
  ];
  const groupsByKey = new Map<string, DerivedConceptMention[]>();
  for (const mention of mentions) {
    const existing = groupsByKey.get(mention.conceptKey) ?? [];
    existing.push(mention);
    groupsByKey.set(mention.conceptKey, existing);
  }

  return [...groupsByKey.entries()]
    .map(([conceptKey, groupedMentions]) => {
      const orderedMentions = [...groupedMentions].sort((left, right) =>
        right.observedAt.localeCompare(left.observedAt)
      );
      return {
        conceptKey,
        label: selectPreferredConceptLabel(orderedMentions),
        kind: deriveGroupConceptKind(orderedMentions),
        mentions: orderedMentions,
        updatedAt: orderedMentions[0]?.observedAt ?? snapshot.generatedAt
      } satisfies ObsidianDerivedConceptGroup;
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Builds a stable note path for one derived concept note.
 *
 * @param group - Derived concept record under projection.
 * @returns Stable concept note relative path.
 */
export function buildDerivedConceptNoteRelativePath(
  group: Pick<ObsidianDerivedConceptGroup, "label">
): string {
  return `15 Concepts/${sanitizeObsidianPathSegment(group.label)}.md`;
}

/**
 * Builds a link index for derived concept notes.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Normalized concept key -> relative note path.
 */
export function buildDerivedConceptLinkIndex(
  snapshot: ProjectionSnapshot
): ReadonlyMap<string, string> {
  const mapped = new Map<string, string>();
  for (const group of buildDerivedConceptGroups(snapshot)) {
    mapped.set(group.conceptKey, buildDerivedConceptNoteRelativePath(group));
  }
  return mapped;
}

/**
 * Renders one derived concept note per grouped concept.
 *
 * **Why it exists:**
 * Operators need a readable place to inspect organizations, offices, and locations that are
 * already present in stored memory but are not canonical profile subjects.
 *
 * **What it talks to:**
 * - Uses the grouping helpers in this module.
 * - Uses Obsidian link helpers from `./obsidianLinks`.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Projected concept notes.
 */
export function renderObsidianConceptNotes(
  snapshot: ProjectionSnapshot
): readonly ObsidianProjectedNote[] {
  const conceptGroups = buildDerivedConceptGroups(snapshot);
  return conceptGroups.map((group) => {
    const subjectMentions = dedupeStrings(
      group.mentions
        .map((mention) => mention.profileSubjectKey)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
    );
    const mediaLinks = dedupeStrings(
      group.mentions
        .map((mention) => {
          if (!mention.mediaArtifactId) {
            return null;
          }
          const artifact = snapshot.mediaArtifacts.find(
            (candidate) => candidate.artifactId === mention.mediaArtifactId
          );
          if (!artifact) {
            return null;
          }
          const titleBase = artifact.fileName ?? artifact.assetFileName;
          return renderObsidianWikiLink(
            buildMediaArtifactNoteRelativePath(artifact.recordedAt, titleBase),
            titleBase
          );
        })
        .filter((value): value is string => typeof value === "string" && value.length > 0)
    );
    const evidenceLines = group.mentions.slice(0, 10).map((mention) => {
      const sourceDescriptor =
        mention.sourceKind === "media_entity_hint"
          ? "media artifact"
          : mention.profileSubjectKey
            ? mention.profileSubjectKey
            : "profile memory";
      return `${mention.evidence} (${sourceDescriptor}, ${mention.observedAt.slice(0, 10)})`;
    });

    return {
      relativePath: buildDerivedConceptNoteRelativePath(group),
      content: [
        renderObsidianFrontmatter({
          abb_type: "derived_concept",
          concept_key: group.conceptKey,
          concept_label: group.label,
          concept_kind: group.kind,
          updated_at: group.updatedAt,
          mention_count: group.mentions.length,
          profile_subject_count: subjectMentions.length,
          media_artifact_count: mediaLinks.length
        }),
        `# ${group.label}`,
        "",
        "## Overview",
        renderMarkdownList([
          "Projection lane: derived concepts from retained facts, context observations, and media hints",
          `Concept type: ${group.kind}`,
          `Mentions: ${group.mentions.length}`,
          `Profile subjects: ${subjectMentions.length}`,
          `Media artifacts: ${mediaLinks.length}`
        ]),
        "## Related Profile Subjects",
        renderMarkdownList(
          subjectMentions,
          "- No grouped profile-memory subjects reference this concept right now."
        ),
        "## Related Media Artifacts",
        renderMarkdownList(
          mediaLinks,
          "- No media artifacts reference this concept right now."
        ),
        "## Evidence Mentions",
        renderMarkdownList(evidenceLines, "- No retained evidence mentions.")
      ].join("\n")
    };
  });
}

/**
 * Builds profile fact concept mentions.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` (import `ProjectionSnapshot`) from `../contracts`.
 * - Uses `renderProjectedCompatibilityFactValue` (import `renderProjectedCompatibilityFactValue`) from `../policy`.
 * @param snapshot - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function buildProfileFactConceptMentions(
  snapshot: ProjectionSnapshot
): readonly DerivedConceptMention[] {
  const facts = snapshot.profileMemory?.facts ?? [];
  const subjectLabelByKey = buildSubjectLabelMap(facts);
  const knownSubjectKeys = new Set(subjectLabelByKey.keys());
  const knownSubjectLabels = new Set(
    [...subjectLabelByKey.values()].map((label) => normalizeConceptIdentity(label))
  );
  const mentions: DerivedConceptMention[] = [];

  for (const fact of facts) {
    const subjectKey = extractProfileSubjectKey(fact.key);
    const subjectLabel = subjectLabelByKey.get(subjectKey) ?? null;
    if (fact.key === `${subjectKey}.name`) {
      continue;
    }

    const directConceptKind = inferDirectConceptKindFromFactKey(fact.key, subjectKey);
    if (directConceptKind !== null) {
      const normalizedKey = normalizeConceptIdentity(fact.value);
      if (normalizedKey.length > 0 && !knownSubjectLabels.has(normalizedKey)) {
        mentions.push({
          conceptKey: normalizedKey,
          label: toReadableConceptLabel(fact.value),
          kind: directConceptKind,
          sourceKind: "profile_direct_fact",
          profileSubjectKey: subjectLabel ?? subjectKey,
          sourceFactKey: fact.key,
          mediaArtifactId: null,
          observedAt: fact.observedAt,
          evidence: renderProjectedCompatibilityFactValue(snapshot.mode, fact)
        });
      }
      continue;
    }

    if (!fact.key.startsWith(`${subjectKey}.context.`)) {
      continue;
    }
    for (const mention of extractConceptMentionsFromContextFact(
      fact,
      subjectLabel,
      knownSubjectKeys,
      knownSubjectLabels
    )) {
      mentions.push(mention);
    }
  }

  return mentions;
}

/**
 * Infers direct concept kind from fact key.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param key - Input consumed by this helper.
 * @param subjectKey - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function inferDirectConceptKindFromFactKey(
  key: string,
  subjectKey: string
): DerivedConceptKind | null {
  if (
    key === `${subjectKey}.work_association`
    || key === `${subjectKey}.organization_association`
  ) {
    return "organization";
  }
  if (
    key === `${subjectKey}.location_association`
    || key === `${subjectKey}.primary_location_association`
    || key === `${subjectKey}.secondary_location_association`
  ) {
    return "place";
  }
  return null;
}

/**
 * Builds media artifact concept mentions.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` (import `ProjectionSnapshot`) from `../contracts`.
 * @param snapshot - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function buildMediaArtifactConceptMentions(
  snapshot: ProjectionSnapshot
): readonly DerivedConceptMention[] {
  const mentions: DerivedConceptMention[] = [];
  for (const artifact of snapshot.mediaArtifacts) {
    for (const rawHint of artifact.derivedMeaning.entityHints) {
      const normalizedKey = normalizeConceptIdentity(rawHint);
      if (
        !shouldKeepDerivedConcept(
          rawHint,
          normalizedKey,
          null,
          new Set<string>(),
          new Set<string>()
        )
      ) {
        continue;
      }
      mentions.push({
        conceptKey: normalizedKey,
        label: toReadableConceptLabel(rawHint),
        kind: inferConceptKind(rawHint),
        sourceKind: "media_entity_hint",
        profileSubjectKey: null,
        sourceFactKey: null,
        mediaArtifactId: artifact.artifactId,
        observedAt: artifact.recordedAt,
        evidence: rawHint
      });
    }
  }
  return mentions;
}

/**
 * Extracts concept mentions from context fact.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileFactRecord` (import `ProfileFactRecord`) from `../../profileMemory`.
 * @param fact - Input consumed by this helper.
 * @param subjectLabel - Input consumed by this helper.
 * @param knownSubjectKeys - Input consumed by this helper.
 * @param knownSubjectLabels - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function extractConceptMentionsFromContextFact(
  fact: ProfileFactRecord,
  subjectLabel: string | null,
  knownSubjectKeys: ReadonlySet<string>,
  knownSubjectLabels: ReadonlySet<string>
): readonly DerivedConceptMention[] {
  const mentions: DerivedConceptMention[] = [];
  const subjectKey = extractProfileSubjectKey(fact.key);
  const sentence = fact.value;
  const betweenPlacesPattern =
    /\bbetween\s+([A-Z][A-Za-z0-9'.&-]*(?:\s+[A-Z][A-Za-z0-9'.&-]*){0,2})\s+and\s+([A-Z][A-Za-z0-9'.&-]*(?:\s+[A-Z][A-Za-z0-9'.&-]*){0,2})(?=(?:\s+for\b)|(?:\s+on\b)|(?:\s+because\b)|(?:\s+three\b)|(?:\s+two\b)|(?:\s+days?\b)|[,.]|$)/g;
  const officePattern = /\b(?:the\s+)?([A-Z][A-Za-z0-9'.&-]*(?:\s+[A-Z][A-Za-z0-9'.&-]*){0,2})\s+office\b/g;
  const placePrepositionPattern =
    /\b(?:in|at|between|from|to)\s+([A-Z][A-Za-z0-9'.&-]*(?:\s+[A-Z][A-Za-z0-9'.&-]*){0,2})(?=(?:\s+and\b)|(?:\s+office\b)|(?:\s+for\b)|(?:\s+on\b)|(?:\s+because\b)|(?:\s+three\b)|(?:\s+two\b)|(?:\s+days?\b)|[,.]|$)/g;
  const organizationPattern =
    /\b([A-Z][A-Za-z0-9'.&-]*(?:\s+[A-Z][A-Za-z0-9'.&-]*){0,3})\b/g;

  for (const match of sentence.matchAll(betweenPlacesPattern)) {
    for (const capturedLabel of [match[1], match[2]]) {
      const rawLabel = capturedLabel?.trim() ?? "";
      const normalizedKey = normalizeConceptIdentity(rawLabel);
      if (
        !shouldKeepDerivedConcept(
          rawLabel,
          normalizedKey,
          subjectLabel,
          knownSubjectKeys,
          knownSubjectLabels
        )
      ) {
        continue;
      }
      if (inferConceptKind(rawLabel) !== "place") {
        continue;
      }
      mentions.push({
        conceptKey: normalizedKey,
        label: toReadableConceptLabel(rawLabel),
        kind: "place",
        sourceKind: "profile_context",
        profileSubjectKey: subjectLabel ?? subjectKey,
        sourceFactKey: fact.key,
        mediaArtifactId: null,
        observedAt: fact.observedAt,
        evidence: sentence
      });
    }
  }

  for (const match of sentence.matchAll(officePattern)) {
    const rawLabel = match[1]?.trim() ?? "";
    const normalizedKey = normalizeConceptIdentity(rawLabel);
    if (!shouldKeepDerivedConcept(rawLabel, normalizedKey, subjectLabel, knownSubjectKeys, knownSubjectLabels)) {
      continue;
    }
    mentions.push({
      conceptKey: normalizedKey,
      label: toReadableConceptLabel(rawLabel),
      kind: "place",
      sourceKind: "profile_context",
      profileSubjectKey: subjectLabel ?? subjectKey,
      sourceFactKey: fact.key,
      mediaArtifactId: null,
      observedAt: fact.observedAt,
      evidence: sentence
    });
  }

  for (const match of sentence.matchAll(placePrepositionPattern)) {
    const rawLabel = match[1]?.trim() ?? "";
    const normalizedKey = normalizeConceptIdentity(rawLabel);
    if (!shouldKeepDerivedConcept(rawLabel, normalizedKey, subjectLabel, knownSubjectKeys, knownSubjectLabels)) {
      continue;
    }
    if (inferConceptKind(rawLabel) !== "place") {
      continue;
    }
    mentions.push({
      conceptKey: normalizedKey,
      label: toReadableConceptLabel(rawLabel),
      kind: "place",
      sourceKind: "profile_context",
      profileSubjectKey: subjectLabel ?? subjectKey,
      sourceFactKey: fact.key,
      mediaArtifactId: null,
      observedAt: fact.observedAt,
      evidence: sentence
    });
  }

  for (const match of sentence.matchAll(organizationPattern)) {
    const rawLabel = match[1]?.trim() ?? "";
    const normalizedKey = normalizeConceptIdentity(rawLabel);
    if (!shouldKeepDerivedConcept(rawLabel, normalizedKey, subjectLabel, knownSubjectKeys, knownSubjectLabels)) {
      continue;
    }
    const inferredKind = inferConceptKind(rawLabel);
    if (inferredKind === "place" || inferredKind === "document_term") {
      continue;
    }
    if (inferredKind !== "organization") {
      continue;
    }
    mentions.push({
      conceptKey: normalizedKey,
      label: toReadableConceptLabel(rawLabel),
      kind: "organization",
      sourceKind: "profile_context",
      profileSubjectKey: subjectLabel ?? subjectKey,
      sourceFactKey: fact.key,
      mediaArtifactId: null,
      observedAt: fact.observedAt,
      evidence: sentence
    });
  }

  return dedupeMentions(mentions);
}

/**
 * Evaluates whether keep derived concept.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param rawLabel - Input consumed by this helper.
 * @param normalizedKey - Input consumed by this helper.
 * @param subjectLabel - Input consumed by this helper.
 * @param knownSubjectKeys - Input consumed by this helper.
 * @param knownSubjectLabels - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function shouldKeepDerivedConcept(
  rawLabel: string,
  normalizedKey: string,
  subjectLabel: string | null,
  knownSubjectKeys: ReadonlySet<string>,
  knownSubjectLabels: ReadonlySet<string>
): boolean {
  if (!normalizedKey) {
    return false;
  }
  if (knownSubjectKeys.has(normalizedKey)) {
    return false;
  }
  if (knownSubjectLabels.has(normalizedKey)) {
    return false;
  }
  if (subjectLabel && normalizeConceptIdentity(subjectLabel) === normalizedKey) {
    return false;
  }
  const tokens = normalizedKey.split(" ").filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return false;
  }
  if (tokens.every((token) => MONTH_WORDS.has(token))) {
    return false;
  }
  if (tokens.every((token) => CONCEPT_STOP_WORDS.has(token))) {
    return false;
  }
  const kind = inferConceptKind(rawLabel);
  if (kind === "document_term") {
    return false;
  }
  if (/^\d+$/.test(normalizedKey.replace(/\s+/g, ""))) {
    return false;
  }
  if (
    tokens.length > 1 &&
    (CONCEPT_STOP_WORDS.has(tokens[0]) || CONCEPT_STOP_WORDS.has(tokens[tokens.length - 1]))
  ) {
    return false;
  }
  if (
    tokens.length === 1 &&
    kind !== "place" &&
    !/[a-z].*[A-Z]|[A-Z].*[a-z]/.test(rawLabel.trim())
  ) {
    return false;
  }
  return true;
}

/**
 * Infers concept kind.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param rawLabel - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function inferConceptKind(rawLabel: string): DerivedConceptKind {
  const normalizedTokens = normalizeConceptIdentity(rawLabel).split(" ").filter(Boolean);
  const compactTokens = normalizedTokens.map((token) => token.replace(/\s+/g, ""));
  if (compactTokens.some((token) => ORG_HINT_TOKENS.has(token))) {
    return "organization";
  }
  if (compactTokens.some((token) => PLACE_HINT_TOKENS.has(token))) {
    return "place";
  }
  if (rawLabel.includes(",")) {
    return "document_term";
  }
  if (normalizedTokens.length >= 2) {
    return "organization";
  }
  return "place";
}

/**
 * Derives group concept kind.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param mentions - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function deriveGroupConceptKind(mentions: readonly DerivedConceptMention[]): DerivedConceptKind {
  const kinds = new Set(mentions.map((mention) => mention.kind));
  if (kinds.size === 1) {
    return mentions[0]?.kind ?? "mixed";
  }
  if (kinds.has("organization") && !kinds.has("place")) {
    return "organization";
  }
  if (kinds.has("place") && !kinds.has("organization")) {
    return "place";
  }
  return "mixed";
}

/**
 * Selects preferred concept label.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param mentions - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function selectPreferredConceptLabel(mentions: readonly DerivedConceptMention[]): string {
  const ranked = [...mentions].sort((left, right) => {
    const sourcePriority =
      scoreConceptSource(right.sourceKind) - scoreConceptSource(left.sourceKind);
    if (sourcePriority !== 0) {
      return sourcePriority;
    }
    return scoreConceptLabel(right.label) - scoreConceptLabel(left.label);
  });
  return toReadableConceptLabel(ranked[0]?.label ?? "Concept");
}

/**
 * Scores concept source.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param sourceKind - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function scoreConceptSource(sourceKind: DerivedConceptSourceKind): number {
  switch (sourceKind) {
    case "profile_direct_fact":
      return 3;
    case "profile_context":
      return 2;
    case "media_entity_hint":
      return 1;
    default:
      return 0;
  }
}

/**
 * Scores concept label.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param label - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function scoreConceptLabel(label: string): number {
  const trimmed = label.trim();
  let score = trimmed.length;
  const normalizedDisplay = toReadableConceptLabel(trimmed);
  if (/[A-Z].*[a-z]|[a-z].*[A-Z]/.test(trimmed)) {
    score += 8;
  }
  if (/[,.&-]/.test(trimmed)) {
    score += 2;
  }
  if (/^[A-Z0-9 ,.'&-]+$/.test(trimmed) && /\s/.test(trimmed)) {
    score -= 2;
  }
  if (normalizedDisplay !== trimmed) {
    score -= 3;
  }
  if (/,\s*(LLC|INC|LTD|CORP)\.?$/i.test(trimmed)) {
    score -= 1;
  }
  return score;
}

/**
 * Normalizes concept identity.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function normalizeConceptIdentity(value: string): string {
  const normalized = value
    .trim()
    .replace(/[“”"]/g, "")
    .replace(/[()]/g, " ")
    .replace(/[,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return "";
  }
  const tokens = normalized.split(" ").filter(Boolean);
  while (tokens.length > 1) {
    const tail = tokens[tokens.length - 1];
    if (tail === "llc" || tail === "inc" || tail === "corp" || tail === "ltd") {
      tokens.pop();
      continue;
    }
    break;
  }
  return tokens.join(" ");
}

/**
 * Converts to readable concept label.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function toReadableConceptLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Concept";
  }
  if (!/^[A-Z0-9 ,.'&-]+$/.test(trimmed) || !/[A-Z]/.test(trimmed)) {
    return trimmed;
  }

  return trimmed.replace(/[A-Z0-9][A-Z0-9'.&-]*/g, (token) => {
    if (PRESERVED_UPPERCASE_TOKENS.has(token)) {
      return token;
    }
    if (/^\d+$/.test(token)) {
      return token;
    }
    return token.charAt(0) + token.slice(1).toLowerCase();
  });
}

/**
 * Builds subject label map.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileFactRecord` (import `ProfileFactRecord`) from `../../profileMemory`.
 * @param facts - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function buildSubjectLabelMap(
  facts: readonly ProfileFactRecord[]
): ReadonlyMap<string, string> {
  const mapped = new Map<string, string>();
  for (const fact of facts) {
    const subjectKey = extractProfileSubjectKey(fact.key);
    if (fact.key === `${subjectKey}.name` && fact.value.trim().length > 0 && !mapped.has(subjectKey)) {
      mapped.set(subjectKey, fact.value.trim());
    }
  }
  return mapped;
}

/**
 * Extracts profile subject key.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param key - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function extractProfileSubjectKey(key: string): string {
  const segments = key.split(".").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
  if (segments.length >= 2) {
    return `${segments[0]}.${segments[1]}`;
  }
  return segments[0] ?? "profile";
}

/**
 * Deduplicates mentions.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param mentions - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function dedupeMentions(
  mentions: readonly DerivedConceptMention[]
): readonly DerivedConceptMention[] {
  const deduped = new Map<string, DerivedConceptMention>();
  for (const mention of mentions) {
    const dedupeKey = [
      mention.conceptKey,
      mention.profileSubjectKey ?? "",
      mention.sourceFactKey ?? "",
      mention.mediaArtifactId ?? "",
      mention.sourceKind
    ].join("|");
    if (!deduped.has(dedupeKey)) {
      deduped.set(dedupeKey, mention);
    }
  }
  return [...deduped.values()];
}

/**
 * Deduplicates strings.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param values - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function dedupeStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
