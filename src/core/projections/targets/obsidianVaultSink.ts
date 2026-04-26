/**
 * @fileoverview Writes the runtime memory mirror into an Obsidian vault subtree using deterministic Markdown, Bases files, and owned asset copies.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../../fileLock";
import type { MediaArtifactRecord } from "../../mediaArtifacts";
import { renderObsidianDashboardNote } from "../renderers/obsidianDashboardRenderer";
import { renderObsidianEntityNotes } from "../renderers/obsidianEntityRenderer";
import { renderObsidianEpisodeNotes } from "../renderers/obsidianEpisodeRenderer";
import { renderObsidianConceptNotes } from "../renderers/obsidianConceptRenderer";
import { renderObsidianProfileSubjectNotes } from "../renderers/obsidianProfileSubjectRenderer";
import {
  renderObsidianFrontmatter,
  renderMarkdownList,
  type ObsidianProjectedNote
} from "../renderers/obsidianFrontmatter";
import { renderObsidianGovernanceNotes } from "../renderers/obsidianGovernanceRenderer";
import { renderObsidianLoopNotes } from "../renderers/obsidianLoopRenderer";
import { renderObsidianMediaArtifactNotes } from "../renderers/obsidianMediaArtifactRenderer";
import { renderObsidianReceiptNotes } from "../renderers/obsidianReceiptRenderer";
import { renderObsidianSkillNotes } from "../renderers/obsidianSkillRenderer";
import { renderObsidianWorkflowLearningNotes } from "../renderers/obsidianWorkflowLearningRenderer";
import { renderObsidianBasesFiles } from "../renderers/obsidianBasesRenderer";
import { shouldMirrorMediaAsset } from "../policy";
import type {
  ProjectionChangeSet,
  ProjectionHealth,
  ProjectionSink,
  ProjectionSnapshot
} from "../contracts";

export interface ObsidianVaultSinkOptions {
  vaultPath: string;
  rootDirectoryName: string;
  mirrorAssets: boolean;
}

type ObsidianCollectionId =
  | "dashboard"
  | "entities"
  | "profile_subjects"
  | "concepts"
  | "episodes"
  | "open_loops"
  | "continuity"
  | "governance"
  | "receipts"
  | "media_artifacts"
  | "bases"
  | "workflow_learning"
  | "skills"
  | "review_actions_guide"
  | "assets";

interface ObsidianProjectedCollection {
  id: ObsidianCollectionId;
  clearTargets: readonly string[];
  notes: readonly ObsidianProjectedNote[];
  assets?: readonly MediaArtifactRecord[];
  preserveExistingFiles?: boolean;
}

/**
 * Writes the AgentBigBrain mirror into one Obsidian vault subtree.
 */
export class ObsidianVaultSink implements ProjectionSink {
  readonly id = "obsidian";

  /**
   * Initializes the Obsidian vault sink.
   *
   * **Why it exists:**
   * The runtime should treat Obsidian as one swappable target, and encapsulating vault paths here
   * keeps the filesystem mirror logic out of the core orchestration and memory stores.
   *
   * **What it talks to:**
   * - Uses local sink configuration within this module.
   *
   * @param options - Vault path and mirror-root settings.
   */
  constructor(private readonly options: ObsidianVaultSinkOptions) {}

  /**
   * Persists one change-driven snapshot update into the vault mirror.
   *
   * **Why it exists:**
   * The first sink implementation prioritizes correctness over fine-grained diffing, so change
   * sync currently shares the same full rebuild path as manual export and recovery.
   *
   * **What it talks to:**
   * - Uses `ProjectionSnapshot` from `../contracts`.
   * - Uses local vault rebuild helpers within this module.
   *
   * @param changeSet - Canonical projection change-set.
   * @param snapshot - Projection snapshot associated with the change.
   * @returns Promise resolving after the mirror subtree is rebuilt.
   */
  async sync(changeSet: ProjectionChangeSet, snapshot: ProjectionSnapshot): Promise<void> {
    if (changeSet.kinds.includes("manual_rebuild")) {
      await this.rebuild(snapshot);
      return;
    }

    const rootPath = path.resolve(this.options.vaultPath, this.options.rootDirectoryName);
    await mkdir(rootPath, { recursive: true });

    const selectedCollectionIds = new Set<ObsidianCollectionId>([
      ...selectCollectionIdsForChangeSet(changeSet),
      "review_actions_guide"
    ]);
    for (const collection of buildProjectedCollections(snapshot)) {
      if (!selectedCollectionIds.has(collection.id)) {
        continue;
      }
      await writeProjectedCollection(rootPath, collection, this.options.mirrorAssets, snapshot.mode);
    }
  }

  /**
   * Rebuilds the full vault subtree from the current projection snapshot.
   *
   * **Why it exists:**
   * Rebuild-first mirroring keeps recovery, export, and live sync behavior aligned while the mirror
   * schema stabilizes.
   *
   * **What it talks to:**
   * - Uses rendering helpers from the Obsidian renderer modules.
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `../../fileLock`.
   * - Uses filesystem helpers from `node:fs/promises`.
   *
   * @param snapshot - Full projection snapshot.
   * @returns Promise resolving after the vault subtree is rebuilt.
   */
  async rebuild(snapshot: ProjectionSnapshot): Promise<void> {
    const rootPath = path.resolve(this.options.vaultPath, this.options.rootDirectoryName);
    await mkdir(rootPath, { recursive: true });
    for (const collection of buildProjectedCollections(snapshot)) {
      await writeProjectedCollection(rootPath, collection, this.options.mirrorAssets, snapshot.mode);
    }
  }

  /**
   * Reports sink health based on vault-root availability.
   *
   * **Why it exists:**
   * Operators should be able to verify that the configured vault path is reachable before they rely
   * on the mirror for review or recovery.
   *
   * **What it talks to:**
   * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
   * - Uses `path.resolve` (import `default`) from `node:path`.
   *
   * @returns Health result for the Obsidian sink.
   */
  async healthCheck(): Promise<ProjectionHealth> {
    const rootPath = path.resolve(this.options.vaultPath, this.options.rootDirectoryName);
    await mkdir(rootPath, { recursive: true });
    return {
      healthy: true,
      detail: `Obsidian vault mirror ready at ${rootPath}.`
    };
  }
}

/**
 * Collects all projected Markdown and `.base` artifacts for one rebuild.
 *
 * **Why it exists:**
 * The vault sink needs one place to assemble dashboard, entity, continuity, artifact, and Bases
 * outputs before writing them, which keeps the public rebuild path simple.
 *
 * **What it talks to:**
 * - Uses the Obsidian renderer modules under `../renderers/`.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Ordered projected note and `.base` artifacts.
 */
function buildProjectedCollections(
  snapshot: ProjectionSnapshot
): readonly ObsidianProjectedCollection[] {
  return [
    {
      id: "dashboard",
      clearTargets: ["00 Dashboard.md"],
      notes: [renderObsidianDashboardNote(snapshot)]
    },
    {
      id: "entities",
      clearTargets: ["10 Entities"],
      notes: renderObsidianEntityNotes(snapshot)
    },
    {
      id: "profile_subjects",
      clearTargets: ["11 Profile Subjects"],
      notes: renderObsidianProfileSubjectNotes(snapshot)
    },
    {
      id: "concepts",
      clearTargets: ["15 Concepts"],
      notes: renderObsidianConceptNotes(snapshot)
    },
    {
      id: "episodes",
      clearTargets: ["12 Episodes"],
      notes: renderObsidianEpisodeNotes(snapshot)
    },
    {
      id: "open_loops",
      clearTargets: ["13 Open Loops"],
      notes: renderObsidianLoopNotes(snapshot)
    },
    {
      id: "continuity",
      clearTargets: ["14 Continuity"],
      notes: [renderContinuityNote(snapshot)]
    },
    {
      id: "governance",
      clearTargets: ["20 Governance"],
      notes: renderObsidianGovernanceNotes(snapshot)
    },
    {
      id: "receipts",
      clearTargets: ["21 Receipts"],
      notes: renderObsidianReceiptNotes(snapshot)
    },
    {
      id: "media_artifacts",
      clearTargets: ["22 Media Artifacts"],
      notes: renderObsidianMediaArtifactNotes(snapshot)
    },
    {
      id: "bases",
      clearTargets: ["30 Bases"],
      notes: renderObsidianBasesFiles(snapshot)
    },
    {
      id: "workflow_learning",
      clearTargets: ["31 Workflow Learning"],
      notes: renderObsidianWorkflowLearningNotes(snapshot)
    },
    {
      id: "skills",
      clearTargets: ["32 Skills"],
      notes: renderObsidianSkillNotes(snapshot)
    },
    {
      id: "review_actions_guide",
      clearTargets: [],
      preserveExistingFiles: true,
      notes: [renderReviewActionGuideNote()]
    },
    {
      id: "assets",
      clearTargets: ["50 Assets"],
      notes: [],
      assets: snapshot.mediaArtifacts
    }
  ];
}

/**
 * Selects the collection groups affected by one projection change-set.
 *
 * **Why it exists:**
 * Real-time projection should update only the collection folders touched by a canonical runtime
 * mutation instead of rewriting the whole vault subtree on every change.
 *
 * **What it talks to:**
 * - Uses `ProjectionChangeSet` from `../contracts`.
 *
 * @param changeSet - Canonical change-set emitted by the runtime.
 * @returns Collection ids that should be refreshed.
 */
function selectCollectionIdsForChangeSet(
  changeSet: ProjectionChangeSet
): readonly ObsidianCollectionId[] {
  const selected = new Set<ObsidianCollectionId>();
  for (const kind of changeSet.kinds) {
    switch (kind) {
      case "profile_memory_changed":
        selected.add("dashboard");
        selected.add("entities");
        selected.add("profile_subjects");
        selected.add("concepts");
        selected.add("episodes");
        selected.add("bases");
        break;
      case "entity_graph_changed":
        selected.add("dashboard");
        selected.add("entities");
        selected.add("bases");
        break;
      case "continuity_changed":
        selected.add("dashboard");
        selected.add("open_loops");
        selected.add("continuity");
        selected.add("bases");
        break;
      case "governance_changed":
        selected.add("dashboard");
        selected.add("governance");
        break;
      case "execution_receipts_changed":
        selected.add("dashboard");
        selected.add("receipts");
        break;
      case "workflow_learning_changed":
        selected.add("dashboard");
        selected.add("workflow_learning");
        break;
      case "media_artifact_changed":
        selected.add("dashboard");
        selected.add("media_artifacts");
        selected.add("concepts");
        selected.add("assets");
        break;
      case "skill_registry_changed":
        selected.add("dashboard");
        selected.add("skills");
        break;
      case "review_actions_applied":
        selected.add("dashboard");
        selected.add("entities");
        selected.add("profile_subjects");
        selected.add("concepts");
        selected.add("episodes");
        selected.add("open_loops");
        selected.add("continuity");
        selected.add("media_artifacts");
        selected.add("bases");
        break;
      case "manual_rebuild":
        return [
          "dashboard",
          "entities",
          "profile_subjects",
          "concepts",
          "episodes",
          "open_loops",
          "continuity",
          "governance",
          "receipts",
          "media_artifacts",
          "bases",
          "workflow_learning",
          "skills",
          "review_actions_guide",
          "assets"
        ];
    }
  }
  return [...selected];
}

/**
 * Writes one projected collection into the Obsidian vault.
 *
 * **Why it exists:**
 * Collection-level rewrites let the mirror stay deterministic while preserving operator-authored
 * review-action notes under `40 Review Actions/`.
 *
 * **What it talks to:**
 * - Uses filesystem helpers from `node:fs/promises`.
 * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `../../fileLock`.
 * - Uses `shouldMirrorMediaAsset(...)` from `../policy`.
 *
 * @param rootPath - Absolute mirror root path inside the Obsidian vault.
 * @param collection - Projected collection to write.
 * @param mirrorAssets - Whether owned runtime assets should be copied into the vault.
 * @param mode - Active projection mode.
 * @returns Promise resolving after the collection is refreshed.
 */
async function writeProjectedCollection(
  rootPath: string,
  collection: ObsidianProjectedCollection,
  mirrorAssets: boolean,
  mode: ProjectionSnapshot["mode"]
): Promise<void> {
  if (!collection.preserveExistingFiles) {
    for (const clearTarget of collection.clearTargets) {
      await rm(path.join(rootPath, clearTarget), { recursive: true, force: true });
    }
  }

  for (const note of collection.notes) {
    const absoluteNotePath = path.join(rootPath, note.relativePath);
    await mkdir(path.dirname(absoluteNotePath), { recursive: true });
    await writeFileAtomic(absoluteNotePath, `${note.content.trimEnd()}\n`);
  }

  if (!collection.assets) {
    return;
  }
  if (!mirrorAssets) {
    return;
  }
  for (const artifact of collection.assets) {
    if (!shouldMirrorMediaAsset(mode, artifact)) {
      continue;
    }
    const assetDestinationPath = path.join(rootPath, "50 Assets", artifact.assetFileName);
    await mkdir(path.dirname(assetDestinationPath), { recursive: true });
    const bytes = await readFile(artifact.ownedAssetPath);
    await writeFile(assetDestinationPath, bytes);
  }
}

/**
 * Renders one grouped continuity note from runtime state and bridge-question queues.
 *
 * **Why it exists:**
 * Continuity spans conversation stack, bridge state, and runtime mutation linkage, so the mirror
 * needs one note that shows that operator-relevant picture without exposing raw runtime JSON.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` from `../contracts`.
 * - Uses rendering helpers from `../renderers/obsidianFrontmatter`.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Grouped continuity note.
 */
function renderContinuityNote(snapshot: ProjectionSnapshot): ObsidianProjectedNote {
  return {
    relativePath: "14 Continuity/Runtime State.md",
    content: [
      renderObsidianFrontmatter({
        abb_type: "continuity_summary",
        updated_at: snapshot.runtimeState.updatedAt,
        active_thread_key: snapshot.runtimeState.conversationStack.activeThreadKey ?? null
      }),
      "# Runtime Continuity",
      "",
      "## Threads",
      renderMarkdownList(
        snapshot.runtimeState.conversationStack.threads.map((thread) =>
          `${thread.threadKey}: ${thread.state} (${thread.openLoops.length} open loops)`
        )
      ),
      "## Pending Bridge Questions",
      renderMarkdownList(
        snapshot.runtimeState.pendingBridgeQuestions.map((question) =>
          `${question.sourceEntityKey} -> ${question.targetEntityKey}: ${question.prompt}`
        )
      ),
      "## Memory Mutation Receipt",
      renderMarkdownList([
        snapshot.runtimeState.lastMemoryMutationReceiptHash ?? "No Stage 6.86 memory mutation receipt recorded."
      ])
    ].join("\n")
  };
}

/**
 * Renders one guide note describing structured review actions inside the vault.
 *
 * **Why it exists:**
 * The read-only mirror grows into guarded write-back later, and a stable guide note makes the
 * review-action folder discoverable without relying on separate docs outside the vault.
 *
 * **What it talks to:**
 * - Uses rendering helpers from `../renderers/obsidianFrontmatter`.
 *
 * @returns Review-action guide note.
 */
function renderReviewActionGuideNote(): ObsidianProjectedNote {
  return {
    relativePath: "40 Review Actions/README.md",
    content: [
      renderObsidianFrontmatter({
        abb_type: "review_action_guide"
      }),
      "# Review Actions",
      "",
      "Create Markdown notes in this folder with frontmatter fields such as:",
      "",
      renderMarkdownList([
        "abb_review_action_id",
        "abb_action_kind",
        "abb_target_id",
        "abb_replacement_value",
        "abb_follow_up_text",
        "abb_thread_key",
        "abb_entity_refs",
        "abb_status"
      ]),
      "Supported action kinds are `resolve_episode`, `mark_episode_wrong`, `forget_episode`, `correct_fact`, `forget_fact`, and `create_follow_up_loop`."
    ].join("\n")
  };
}
