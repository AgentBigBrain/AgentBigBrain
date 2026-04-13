/**
 * @fileoverview Renders the top-level Obsidian dashboard note for the runtime memory mirror.
 */

import type { ProjectionSnapshot } from "../contracts";
import {
  renderMarkdownList,
  renderObsidianFrontmatter,
  type ObsidianProjectedNote
} from "./obsidianFrontmatter";
import { countSensitiveCompatibilityFacts } from "../policy";
import {
  buildDerivedConceptGroups,
  buildDerivedConceptNoteRelativePath
} from "./obsidianConceptRenderer";
import {
  buildProfileSubjectGroups,
  buildProfileSubjectNoteRelativePath
} from "./obsidianProfileSubjectRenderer";
import { renderObsidianWikiLink } from "./obsidianLinks";

/**
 * Renders the dashboard note summarizing the current mirror snapshot.
 *
 * **Why it exists:**
 * Operators need one front door into the projected vault that explains what the mirror currently
 * contains without opening raw entity, receipt, continuity, and artifact notes one by one.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` from `../contracts`.
 * - Uses `countSensitiveCompatibilityFacts(...)` from `../policy`.
 * - Uses rendering helpers from `./obsidianFrontmatter`.
 *
 * @param snapshot - Full projection snapshot.
 * @returns One top-level dashboard note.
 */
export function renderObsidianDashboardNote(
  snapshot: ProjectionSnapshot
): ObsidianProjectedNote {
  const openLoopCount = snapshot.runtimeState.conversationStack.threads.reduce((total, thread) => {
    const loops = (thread.openLoops ?? []) as readonly unknown[];
    return total + loops.length;
  }, 0);
  const profileSubjectGroups = buildProfileSubjectGroups(snapshot);
  const conceptGroups = buildDerivedConceptGroups(snapshot);
  const projectedProfileSubjectCounts = new Map<string, number>();
  for (const group of profileSubjectGroups) {
    projectedProfileSubjectCounts.set(
      group.label,
      (projectedProfileSubjectCounts.get(group.label) ?? 0) + 1
    );
  }

  return {
    relativePath: "00 Dashboard.md",
    content: [
      renderObsidianFrontmatter({
        abb_type: "dashboard",
        updated_at: snapshot.generatedAt,
        mode: snapshot.mode
      }),
      "# AgentBigBrain Memory Mirror",
      "",
      "## Snapshot Summary",
      renderMarkdownList([
        `Mode: ${snapshot.mode}`,
        `Continuity entities: ${snapshot.entityGraph.entities.length}`,
        `Profile subjects: ${profileSubjectGroups.length}`,
        `Derived concepts: ${conceptGroups.length}`,
        `Compatibility profile facts: ${snapshot.profileMemory?.facts.length ?? 0}`,
        `Episodes: ${snapshot.profileMemory?.episodes.length ?? 0}`,
        `Open loops: ${openLoopCount}`,
        `Governance events: ${snapshot.governanceReadView.recentEvents.length}`,
        `Receipts: ${snapshot.executionReceipts.length}`,
        `Workflow patterns: ${snapshot.workflowPatterns.length}`,
        `Media artifacts: ${snapshot.mediaArtifacts.length}`,
        `Sensitive compatibility facts: ${countSensitiveCompatibilityFacts(snapshot.profileMemory)}`
      ]),
      "## How To Read This Mirror",
      renderMarkdownList([
        "Continuity entity notes come from the Stage 6.86 continuity graph.",
        "Profile subject notes come from retained profile-memory compatibility facts grouped by subject key.",
        "Derived concept notes come from named organizations and places already present inside retained facts, context observations, or media-derived hints.",
        "Current Temporal Claims come from the graph-backed profile-memory truth surface.",
        "Evidence refs such as interface:telegram:... are provenance pointers to observed turns or artifacts, not raw chat logs acting as the truth database.",
        "Media artifacts are stored in runtime-owned artifact storage and mirrored here; Telegram file ids are provenance, not the storage layer."
      ]),
      "## Profile Subjects",
      renderMarkdownList(
        profileSubjectGroups.map((group) =>
          renderObsidianWikiLink(
            buildProfileSubjectNoteRelativePath(group, projectedProfileSubjectCounts),
            group.label
          )
        ),
        "- No grouped profile-memory subjects are projected right now."
        ),
      "## Derived Concepts",
      renderMarkdownList(
        conceptGroups.map((group) =>
          renderObsidianWikiLink(
            buildDerivedConceptNoteRelativePath(group),
            group.label
          )
        ),
        "- No derived concept notes are projected right now."
      ),
      "## Recent Bridge Questions",
      renderMarkdownList(
        snapshot.runtimeState.pendingBridgeQuestions.map((question) =>
          `${question.createdAt}: ${question.prompt}`
        )
      )
    ].join("\n")
  };
}
