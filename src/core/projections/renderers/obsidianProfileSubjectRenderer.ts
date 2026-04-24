/**
 * @fileoverview Renders grouped profile-memory subject notes for the Obsidian projection sink.
 */

import type { ProfileFactRecord } from "../../profileMemory";
import type { ProjectionSnapshot } from "../contracts";
import { renderProjectedCompatibilityFactValue } from "../policy";
import {
  buildDerivedConceptGroups,
  buildDerivedConceptLinkIndex
} from "./obsidianConceptRenderer";
import {
  renderMarkdownList,
  renderObsidianFrontmatter,
  sanitizeObsidianPathSegment,
  type ObsidianProjectedNote
} from "./obsidianFrontmatter";
import { renderObsidianWikiLink } from "./obsidianLinks";

export interface ObsidianProfileSubjectGroup {
  readonly subjectKey: string;
  readonly label: string;
  readonly facts: readonly ProfileFactRecord[];
  readonly updatedAt: string;
}

/**
 * Groups retained compatibility facts by profile-memory subject key.
 *
 * **Why it exists:**
 * Operators need a readable note surface for what the runtime actually retained in profile memory,
 * even when the Stage 6.86 continuity graph is empty or intentionally sparse.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` from `../contracts`.
 * - Uses `ProfileFactRecord` from `../../profileMemory`.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Stable grouped subject records for note rendering and dashboard summaries.
 */
export function buildProfileSubjectGroups(
  snapshot: ProjectionSnapshot
): readonly ObsidianProfileSubjectGroup[] {
  const facts = snapshot.profileMemory?.facts ?? [];
  const groupsBySubjectKey = new Map<string, ProfileFactRecord[]>();
  for (const fact of facts) {
    const subjectKey = extractProfileSubjectKey(fact.key);
    const existing = groupsBySubjectKey.get(subjectKey) ?? [];
    existing.push(fact);
    groupsBySubjectKey.set(subjectKey, existing);
  }

  return [...groupsBySubjectKey.entries()]
    .map(([subjectKey, subjectFacts]) => {
      const orderedFacts = [...subjectFacts].sort((left, right) =>
        right.lastUpdatedAt.localeCompare(left.lastUpdatedAt)
      );
      return {
        subjectKey,
        label: resolveProfileSubjectLabel(subjectKey, orderedFacts),
        facts: orderedFacts,
        updatedAt: orderedFacts[0]?.lastUpdatedAt ?? snapshot.generatedAt
      } satisfies ObsidianProfileSubjectGroup;
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Builds the canonical relative path for one projected profile subject note.
 *
 * **Why it exists:**
 * Dashboard links and note generation both need one stable path rule for grouped profile-memory
 * subjects so projected filenames cannot drift between collections.
 *
 * **What it talks to:**
 * - Uses `sanitizeObsidianPathSegment(...)` from `./obsidianFrontmatter`.
 *
 * @param group - Profile-memory subject group to map to a note path.
 * @param projectedNameCounts - Count of projected profile-subject labels.
 * @returns Stable relative note path.
 */
export function buildProfileSubjectNoteRelativePath(
  group: Pick<ObsidianProfileSubjectGroup, "subjectKey" | "label">,
  projectedNameCounts: ReadonlyMap<string, number>
): string {
  const duplicateCount = projectedNameCounts.get(group.label) ?? 0;
  if (duplicateCount <= 1) {
    return `11 Profile Subjects/${sanitizeObsidianPathSegment(group.label)}.md`;
  }

  return `11 Profile Subjects/${sanitizeObsidianPathSegment(
    `${group.label} (${group.subjectKey})`
  )}.md`;
}

/**
 * Renders grouped profile-memory subject notes.
 *
 * **Why it exists:**
 * Persisted compatibility facts are the easiest way to inspect what the runtime currently retains,
 * and those grouped notes make the stored shape legible without opening raw runtime JSON.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` from `../contracts`.
 * - Uses local grouping and path helpers in this module.
 * - Uses `renderProjectedCompatibilityFactValue(...)` from `../policy`.
 *
 * @param snapshot - Full projection snapshot.
 * @returns One projected note per grouped profile subject.
 */
export function renderObsidianProfileSubjectNotes(
  snapshot: ProjectionSnapshot
): readonly ObsidianProjectedNote[] {
  const groups = buildProfileSubjectGroups(snapshot);
  const conceptGroups = buildDerivedConceptGroups(snapshot);
  const conceptLinkIndex = buildDerivedConceptLinkIndex(snapshot);
  const projectedNameCounts = new Map<string, number>();
  for (const group of groups) {
    projectedNameCounts.set(group.label, (projectedNameCounts.get(group.label) ?? 0) + 1);
  }

  return groups.map((group) => {
    const identityFacts = group.facts.filter((fact) => fact.key === `${group.subjectKey}.name`);
    const directFacts = group.facts.filter((fact) =>
      fact.key !== `${group.subjectKey}.name`
      && !fact.key.startsWith(`${group.subjectKey}.context.`)
      && fact.status !== "superseded"
    );
    const contextFacts = group.facts.filter((fact) =>
      fact.key.startsWith(`${group.subjectKey}.context.`) && fact.status !== "superseded"
    );
    const supersededFacts = group.facts.filter((fact) => fact.status === "superseded");
    const referencedConceptLinks = [...new Set(
      conceptGroups
        .filter((conceptGroup) =>
          conceptGroup.mentions.some((mention) => mention.profileSubjectKey === group.label)
        )
        .map((conceptGroup) => {
          const relativePath = conceptLinkIndex.get(conceptGroup.conceptKey);
          return relativePath
            ? renderObsidianWikiLink(relativePath, conceptGroup.label)
            : conceptGroup.label;
        })
    )].sort((left, right) => left.localeCompare(right));
    const content = [
      renderObsidianFrontmatter({
        abb_type: "profile_subject",
        subject_key: group.subjectKey,
        subject_label: group.label,
        updated_at: group.updatedAt,
        total_facts: group.facts.length,
        current_direct_fact_count: directFacts.length,
        context_fact_count: contextFacts.length,
        superseded_fact_count: supersededFacts.length
      }),
      `# ${group.label}`,
      "",
      "## Overview",
      renderMarkdownList([
        "Projection lane: retained profile-memory compatibility facts",
        `Subject key: ${group.subjectKey}`,
        `Current direct facts: ${directFacts.length}`,
        `Context observations: ${contextFacts.length}`,
        `Superseded facts: ${supersededFacts.length}`,
        `Total retained facts: ${group.facts.length}`
      ]),
      "## Identity Facts",
      renderMarkdownList(
        identityFacts.map((fact) => renderProfileSubjectFactLine(snapshot, fact, group.subjectKey))
      ),
      "## Current Direct Facts",
      renderMarkdownList(
        directFacts.map((fact) => renderProfileSubjectFactLine(snapshot, fact, group.subjectKey)),
        "- No current direct facts retained for this subject."
      ),
      "## Referenced Concepts",
      renderMarkdownList(
        referencedConceptLinks,
        "- No derived organization or place concepts are linked from this subject right now."
      ),
      "## Context Observations",
      renderMarkdownList(
        contextFacts.map((fact) => renderProfileSubjectContextLine(snapshot, fact)),
        "- No retained context observations for this subject."
      ),
      "## Historical Or Superseded Facts",
      renderMarkdownList(
        supersededFacts.map((fact) => renderProfileSubjectFactLine(snapshot, fact, group.subjectKey)),
        "- No superseded facts retained for this subject."
      ),
      "## All Stored Facts",
      renderMarkdownList(
        group.facts.map((fact) => renderFullProfileFactLine(snapshot, fact)),
        "- No retained facts."
      )
    ].join("\n");

    return {
      relativePath: buildProfileSubjectNoteRelativePath(group, projectedNameCounts),
      content
    };
  });
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
 * Resolves profile subject label.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileFactRecord` (import `ProfileFactRecord`) from `../../profileMemory`.
 * @param subjectKey - Input consumed by this helper.
 * @param facts - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function resolveProfileSubjectLabel(
  subjectKey: string,
  facts: readonly ProfileFactRecord[]
): string {
  const nameFact = facts.find((fact) => fact.key === `${subjectKey}.name` && fact.value.trim().length > 0);
  if (nameFact) {
    return nameFact.value.trim();
  }

  const subjectTail = subjectKey.split(".").slice(1).join(" ").trim();
  const fallback = subjectTail.length > 0 ? subjectTail : subjectKey;
  return fallback
    .split(/[_\-\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Renders profile subject fact line.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileFactRecord` (import `ProfileFactRecord`) from `../../profileMemory`.
 * - Uses `ProjectionSnapshot` (import `ProjectionSnapshot`) from `../contracts`.
 * - Uses `renderProjectedCompatibilityFactValue` (import `renderProjectedCompatibilityFactValue`) from `../policy`.
 * @param snapshot - Input consumed by this helper.
 * @param fact - Input consumed by this helper.
 * @param subjectKey - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function renderProfileSubjectFactLine(
  snapshot: ProjectionSnapshot,
  fact: ProfileFactRecord,
  subjectKey: string
): string {
  const factLabel = humanizeProfileFactField(fact.key, subjectKey);
  const factValue = renderProjectedCompatibilityFactValue(snapshot.mode, fact);
  return `${factLabel}: ${factValue} (${fact.status}, observed ${fact.observedAt.slice(0, 10)})`;
}

/**
 * Renders profile subject context line.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileFactRecord` (import `ProfileFactRecord`) from `../../profileMemory`.
 * - Uses `ProjectionSnapshot` (import `ProjectionSnapshot`) from `../contracts`.
 * - Uses `renderProjectedCompatibilityFactValue` (import `renderProjectedCompatibilityFactValue`) from `../policy`.
 * @param snapshot - Input consumed by this helper.
 * @param fact - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function renderProfileSubjectContextLine(
  snapshot: ProjectionSnapshot,
  fact: ProfileFactRecord
): string {
  const factValue = renderProjectedCompatibilityFactValue(snapshot.mode, fact);
  return `${factValue} (\`${fact.key}\`, ${fact.status}, observed ${fact.observedAt.slice(0, 10)})`;
}

/**
 * Renders full profile fact line.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileFactRecord` (import `ProfileFactRecord`) from `../../profileMemory`.
 * - Uses `ProjectionSnapshot` (import `ProjectionSnapshot`) from `../contracts`.
 * - Uses `renderProjectedCompatibilityFactValue` (import `renderProjectedCompatibilityFactValue`) from `../policy`.
 * @param snapshot - Input consumed by this helper.
 * @param fact - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function renderFullProfileFactLine(
  snapshot: ProjectionSnapshot,
  fact: ProfileFactRecord
): string {
  const factValue = renderProjectedCompatibilityFactValue(snapshot.mode, fact);
  return `\`${fact.key}\` = ${factValue} (${fact.status}, observed ${fact.observedAt.slice(0, 10)})`;
}

/**
 * Humanizes profile fact field.
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
function humanizeProfileFactField(key: string, subjectKey: string): string {
  const rawField = key.startsWith(`${subjectKey}.`) ? key.slice(subjectKey.length + 1) : key;
  return rawField
    .replace(/\./g, " / ")
    .replace(/_/g, " ")
    .replace(/\b[a-z]/g, (character) => character.toUpperCase());
}
