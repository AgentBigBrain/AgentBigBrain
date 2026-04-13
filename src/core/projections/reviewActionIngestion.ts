/**
 * @fileoverview Applies guarded Obsidian review-action notes through canonical profile-memory and continuity mutation seams.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProfileMemoryStore } from "../profileMemoryStore";
import type { ProjectionService } from "./service";
import { buildProjectionChangeSet } from "./service";
import {
  parseObsidianReviewActionMarkdown,
  rewriteObsidianReviewActionMarkdown,
  type ObsidianReviewAction
} from "./reviewActions";
import type { Stage686RuntimeStateAdapter } from "../stage6_86/contracts";
import { upsertOpenLoopOnConversationStackV1 } from "../stage6_86/openLoops";
import type { ConversationStackV1 } from "../types";

export interface ApplyObsidianReviewActionsDependencies {
  profileMemoryStore?: ProfileMemoryStore;
  runtimeStateStore: Stage686RuntimeStateAdapter;
  projectionService?: ProjectionService;
}

export interface AppliedObsidianReviewAction {
  actionId: string;
  actionKind: ObsidianReviewAction["actionKind"];
  sourcePath: string;
  status: "applied" | "failed" | "skipped";
  message: string;
}

export interface ApplyObsidianReviewActionsReport {
  appliedCount: number;
  failedCount: number;
  skippedCount: number;
  outcomes: readonly AppliedObsidianReviewAction[];
}

/**
 * Applies all pending review-action notes from one Obsidian review-action directory.
 *
 * **Why it exists:**
 * Write-back should stay opt-in and deterministic, so one bounded batch entrypoint keeps review
 * note discovery, mutation routing, and audit-note rewrites out of generic runtime flows.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryStore` from `../profileMemoryStore`.
 * - Uses Stage 6.86 runtime-state contracts from `../stage6_86/contracts`.
 * - Uses `ProjectionService` and review-action helpers from this subsystem.
 *
 * @param reviewActionDirectoryPath - Absolute review-action note directory inside the vault mirror.
 * @param dependencies - Canonical runtime stores used for governed mutations.
 * @returns Batch apply report for the scanned review-action notes.
 */
export async function applyObsidianReviewActionsFromDirectory(
  reviewActionDirectoryPath: string,
  dependencies: ApplyObsidianReviewActionsDependencies
): Promise<ApplyObsidianReviewActionsReport> {
  const reviewActionPaths = await collectReviewActionNotePaths(reviewActionDirectoryPath);
  const outcomes: AppliedObsidianReviewAction[] = [];

  for (const reviewActionPath of reviewActionPaths) {
    const markdown = await readFile(reviewActionPath, "utf8");
    const parsedAction = parseObsidianReviewActionMarkdown(markdown, reviewActionPath);
    if (!parsedAction) {
      outcomes.push({
        actionId: path.basename(reviewActionPath),
        actionKind: "forget_fact",
        sourcePath: reviewActionPath,
        status: "skipped",
        message: "Skipped note without a valid Obsidian review-action schema."
      });
      continue;
    }
    if (parsedAction.status !== "pending") {
      outcomes.push({
        actionId: parsedAction.actionId,
        actionKind: parsedAction.actionKind,
        sourcePath: reviewActionPath,
        status: "skipped",
        message: `Skipped review action with status ${parsedAction.status}.`
      });
      continue;
    }

    const outcome = await applySingleReviewAction(parsedAction, markdown, dependencies);
    outcomes.push(outcome);
  }

  const appliedCount = outcomes.filter((outcome) => outcome.status === "applied").length;
  const failedCount = outcomes.filter((outcome) => outcome.status === "failed").length;
  const skippedCount = outcomes.filter((outcome) => outcome.status === "skipped").length;

  if (appliedCount > 0 && dependencies.projectionService) {
    await dependencies.projectionService.notifyChange(
      buildProjectionChangeSet(
        ["review_actions_applied"],
        ["obsidian_review_actions"],
        { appliedCount, failedCount, skippedCount }
      )
    );
  }

  return {
    appliedCount,
    failedCount,
    skippedCount,
    outcomes
  };
}

/**
 * Lists candidate review-action Markdown files from one vault directory.
 *
 * **Why it exists:**
 * The review-action batch runner should only touch explicit operator note files and avoid
 * reprocessing the folder guide note or hidden metadata files.
 *
 * **What it talks to:**
 * - Uses `readdir` (import `readdir`) from `node:fs/promises`.
 * - Uses `path.extname` and `path.basename` (import `default`) from `node:path`.
 *
 * @param reviewActionDirectoryPath - Absolute review-action note directory.
 * @returns Sorted absolute Markdown note paths to inspect.
 */
async function collectReviewActionNotePaths(
  reviewActionDirectoryPath: string
): Promise<readonly string[]> {
  const entries = await readdir(reviewActionDirectoryPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(reviewActionDirectoryPath, entry.name))
    .filter((entryPath) =>
      path.extname(entryPath).toLowerCase() === ".md"
      && path.basename(entryPath).toLowerCase() !== "readme.md"
    )
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Applies one parsed review action and rewrites its note status.
 *
 * **Why it exists:**
 * Each note should produce one deterministic outcome so the vault remains an explicit audit trail
 * instead of a loosely coupled queue with ambiguous partial state.
 *
 * **What it talks to:**
 * - Uses profile-memory mutation APIs from `../profileMemoryStore`.
 * - Uses Stage 6.86 open-loop helpers from `../stage6_86/openLoops`.
 * - Uses review-action note helpers from `./reviewActions`.
 *
 * @param action - Parsed pending review action.
 * @param originalMarkdown - Existing note contents before status rewrite.
 * @param dependencies - Canonical runtime stores used for governed mutations.
 * @returns One applied, failed, or skipped outcome.
 */
async function applySingleReviewAction(
  action: ObsidianReviewAction,
  originalMarkdown: string,
  dependencies: ApplyObsidianReviewActionsDependencies
): Promise<AppliedObsidianReviewAction> {
  const nowIso = new Date().toISOString();
  try {
    const message = await routeReviewAction(action, dependencies, nowIso);
    await writeReviewActionNoteStatus(action.sourcePath, originalMarkdown, {
      abb_status: "applied",
      abb_applied_at: nowIso,
      abb_result: message
    });
    return {
      actionId: action.actionId,
      actionKind: action.actionKind,
      sourcePath: action.sourcePath,
      status: "applied",
      message
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeReviewActionNoteStatus(action.sourcePath, originalMarkdown, {
      abb_status: "failed",
      abb_failed_at: nowIso,
      abb_error: message
    });
    return {
      actionId: action.actionId,
      actionKind: action.actionKind,
      sourcePath: action.sourcePath,
      status: "failed",
      message
    };
  }
}

/**
 * Routes one parsed action into the canonical mutation seam it targets.
 *
 * **Why it exists:**
 * Review-action parsing is file-oriented while the runtime mutations are domain-oriented, so one
 * router keeps that boundary explicit and testable.
 *
 * **What it talks to:**
 * - Uses profile-memory mutation APIs from `../profileMemoryStore`.
 * - Uses Stage 6.86 open-loop helpers from `../stage6_86/openLoops`.
 *
 * @param action - Parsed pending review action.
 * @param dependencies - Canonical runtime stores used for governed mutations.
 * @param nowIso - Timestamp assigned to this mutation attempt.
 * @returns Human-readable result message for the applied mutation.
 */
async function routeReviewAction(
  action: ObsidianReviewAction,
  dependencies: ApplyObsidianReviewActionsDependencies,
  nowIso: string
): Promise<string> {
  switch (action.actionKind) {
    case "correct_fact":
    case "forget_fact":
      return applyFactReviewAction(action, dependencies, nowIso);
    case "resolve_episode":
    case "mark_episode_wrong":
    case "forget_episode":
      return applyEpisodeReviewAction(action, dependencies, nowIso);
    case "create_follow_up_loop":
      return applyFollowUpLoopReviewAction(action, dependencies, nowIso);
  }
}

/**
 * Applies one fact-correction or fact-forget action through `ProfileMemoryStore`.
 *
 * **Why it exists:**
 * Fact review already has a governed mutation surface, so the Obsidian write-back flow should
 * reuse it instead of mutating encrypted profile-memory state directly.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryStore` from `../profileMemoryStore`.
 *
 * @param action - Parsed fact review action.
 * @param dependencies - Canonical runtime stores used for governed mutations.
 * @param nowIso - Timestamp assigned to this mutation attempt.
 * @returns Human-readable result message.
 */
async function applyFactReviewAction(
  action: ObsidianReviewAction,
  dependencies: ApplyObsidianReviewActionsDependencies,
  nowIso: string
): Promise<string> {
  if (!dependencies.profileMemoryStore) {
    throw new Error("Profile memory is disabled, so fact review actions cannot be applied.");
  }
  if (!action.targetId) {
    throw new Error("Fact review action is missing `abb_target_id`.");
  }
  if (action.actionKind === "correct_fact" && !action.replacementValue) {
    throw new Error("Fact correction requires `abb_replacement_value`.");
  }

  const result = await dependencies.profileMemoryStore.mutateFactFromUser({
    factId: action.targetId,
    action: action.actionKind === "correct_fact" ? "correct" : "forget",
    replacementValue: action.replacementValue ?? undefined,
    note: action.noteBody.trim() || undefined,
    nowIso,
    sourceTaskId: buildReviewActionSourceTaskId(action.actionId),
    sourceText: buildReviewActionSourceText(action)
  });
  if (!result.fact) {
    throw new Error(`Fact ${action.targetId} was not found.`);
  }
  return `Applied ${action.actionKind} to fact ${action.targetId}.`;
}

/**
 * Applies one episode-resolution, wrong, or forget action through `ProfileMemoryStore`.
 *
 * **Why it exists:**
 * Episode review already has bounded mutation seams, and this helper maps the vault-friendly
 * action names onto those canonical episode status transitions.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryStore` from `../profileMemoryStore`.
 *
 * @param action - Parsed episode review action.
 * @param dependencies - Canonical runtime stores used for governed mutations.
 * @param nowIso - Timestamp assigned to this mutation attempt.
 * @returns Human-readable result message.
 */
async function applyEpisodeReviewAction(
  action: ObsidianReviewAction,
  dependencies: ApplyObsidianReviewActionsDependencies,
  nowIso: string
): Promise<string> {
  if (!dependencies.profileMemoryStore) {
    throw new Error("Profile memory is disabled, so episode review actions cannot be applied.");
  }
  if (!action.targetId) {
    throw new Error("Episode review action is missing `abb_target_id`.");
  }

  const sourceTaskId = buildReviewActionSourceTaskId(action.actionId);
  const sourceText = buildReviewActionSourceText(action);
  const note = action.noteBody.trim() || undefined;
  const result = action.actionKind === "forget_episode"
    ? await dependencies.profileMemoryStore.forgetEpisodeFromUser(
        action.targetId,
        sourceTaskId,
        sourceText,
        nowIso
      )
    : await dependencies.profileMemoryStore.updateEpisodeFromUser(
        action.targetId,
        action.actionKind === "resolve_episode" ? "resolved" : "no_longer_relevant",
        sourceTaskId,
        sourceText,
        note,
        nowIso
      );
  if (!result.episode) {
    throw new Error(`Episode ${action.targetId} was not found.`);
  }
  return `Applied ${action.actionKind} to episode ${action.targetId}.`;
}

/**
 * Applies one follow-up-loop creation action through Stage 6.86 runtime-state helpers.
 *
 * **Why it exists:**
 * Review notes sometimes need to create a follow-up loop instead of mutating profile memory, and
 * this helper keeps that continuity write on the canonical conversation-stack seam.
 *
 * **What it talks to:**
 * - Uses Stage 6.86 open-loop helpers from `../stage6_86/openLoops`.
 * - Uses profile-memory lookups from `../profileMemoryStore`.
 *
 * @param action - Parsed follow-up-loop action.
 * @param dependencies - Canonical runtime stores used for governed mutations.
 * @param nowIso - Timestamp assigned to this mutation attempt.
 * @returns Human-readable result message.
 */
async function applyFollowUpLoopReviewAction(
  action: ObsidianReviewAction,
  dependencies: ApplyObsidianReviewActionsDependencies,
  nowIso: string
): Promise<string> {
  const runtimeState = await dependencies.runtimeStateStore.load();
  const followUpText = normalizeFollowUpText(action.followUpText ?? action.noteBody);
  if (!followUpText) {
    throw new Error("Follow-up loop creation requires `abb_follow_up_text` or a non-empty note body.");
  }
  const threadKey = action.threadKey ?? runtimeState.conversationStack.activeThreadKey ?? "thread_review_actions";
  const seededStack = ensureReviewActionThread(runtimeState.conversationStack, threadKey, nowIso);
  const entityRefs = await resolveReviewActionEntityRefs(action, dependencies.profileMemoryStore);
  const upserted = upsertOpenLoopOnConversationStackV1({
    stack: seededStack,
    threadKey,
    text: followUpText,
    observedAt: nowIso,
    entityRefs,
    priorityHint: 0.76
  });
  if (!upserted.loop) {
    throw new Error("Follow-up loop could not be created from the provided text.");
  }

  await dependencies.runtimeStateStore.save({
    ...runtimeState,
    updatedAt: nowIso,
    conversationStack: upserted.stack
  });
  return `Created follow-up loop ${upserted.loop.loopId} on thread ${threadKey}.`;
}

/**
 * Resolves entity refs for one follow-up-loop review action.
 *
 * **Why it exists:**
 * Follow-up loops may target an entity or episode indirectly, and this helper gathers the most
 * useful canonical entity refs without scraping arbitrary note text.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryStore` from `../profileMemoryStore`.
 *
 * @param action - Parsed follow-up-loop review action.
 * @param profileMemoryStore - Optional profile-memory store used for episode lookups.
 * @returns Stable entity refs associated with the action.
 */
async function resolveReviewActionEntityRefs(
  action: ObsidianReviewAction,
  profileMemoryStore?: ProfileMemoryStore
): Promise<readonly string[]> {
  if (action.entityRefs.length > 0) {
    return action.entityRefs;
  }
  if (!action.targetId) {
    return [];
  }
  if (action.targetId.startsWith("entity_")) {
    return [action.targetId];
  }
  if (!profileMemoryStore) {
    return [];
  }
  const state = await profileMemoryStore.load();
  const matchingEpisode = state.episodes.find((episode) => episode.id === action.targetId);
  return matchingEpisode?.entityRefs ?? [];
}

/**
 * Ensures a conversation thread exists before a review-action follow-up loop is added.
 *
 * **Why it exists:**
 * Review actions may target a thread that does not exist yet, and the runtime should create that
 * continuity lane deterministically instead of failing on a missing thread frame.
 *
 * **What it talks to:**
 * - Uses Stage 6.86 `ConversationStackV1` contracts from `../types`.
 *
 * @param stack - Current Stage 6.86 conversation stack snapshot.
 * @param threadKey - Target thread key for the new follow-up loop.
 * @param observedAt - Mutation timestamp.
 * @returns Conversation stack guaranteed to contain the target thread.
 */
function ensureReviewActionThread(
  stack: ConversationStackV1,
  threadKey: string,
  observedAt: string
): ConversationStackV1 {
  if (stack.threads.some((thread) => thread.threadKey === threadKey)) {
    return stack;
  }
  const topicKey = `topic_${threadKey}`;
  const topicLabel = threadKey.replace(/[_-]+/g, " ");
  return {
    schemaVersion: "v1",
    updatedAt: observedAt,
    activeThreadKey: stack.activeThreadKey ?? threadKey,
    threads: [
      ...stack.threads,
      {
        threadKey,
        topicKey,
        topicLabel,
        state: "active",
        resumeHint: "Resume review-action follow-up.",
        openLoops: [],
        lastTouchedAt: observedAt
      }
    ],
    topics: [
      ...stack.topics,
      {
        topicKey,
        label: topicLabel,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        mentionCount: 1
      }
    ]
  };
}

/**
 * Rewrites one review-action note on disk with updated status fields.
 *
 * **Why it exists:**
 * The vault should stay the operator-facing audit log for write-back actions, so each apply
 * attempt updates the note that requested it.
 *
 * **What it talks to:**
 * - Uses `rewriteObsidianReviewActionMarkdown(...)` from `./reviewActions`.
 * - Uses `writeFile` (import `writeFile`) from `node:fs/promises`.
 *
 * @param sourcePath - Absolute note path to rewrite.
 * @param markdown - Existing note contents.
 * @param updates - Frontmatter fields to overwrite after the attempt.
 * @returns Promise resolving after the note is rewritten.
 */
async function writeReviewActionNoteStatus(
  sourcePath: string,
  markdown: string,
  updates: Record<string, string | null>
): Promise<void> {
  await writeFile(sourcePath, rewriteObsidianReviewActionMarkdown(markdown, updates), "utf8");
}

/**
 * Builds the deterministic source-task id used for review-action mutations.
 *
 * **Why it exists:**
 * Profile-memory mutation seams expect a source task id, and this helper keeps the Obsidian
 * write-back source namespace consistent across all action kinds.
 *
 * **What it talks to:**
 * - Uses local string normalization rules within this module.
 *
 * @param actionId - Stable review-action identifier from the note.
 * @returns Canonical source-task id.
 */
function buildReviewActionSourceTaskId(actionId: string): string {
  return `obsidian_review_action:${actionId}`;
}

/**
 * Builds the bounded source text associated with one review-action mutation.
 *
 * **Why it exists:**
 * The canonical memory mutation seams expect a human-readable source string, and this helper keeps
 * the Obsidian write-back wording deterministic without overfitting to note formatting.
 *
 * **What it talks to:**
 * - Uses local string normalization rules within this module.
 *
 * @param action - Parsed review action.
 * @returns Human-readable source text for the mutation envelope.
 */
function buildReviewActionSourceText(action: ObsidianReviewAction): string {
  const body = action.noteBody.trim();
  if (body.length > 0) {
    return body;
  }
  return `Obsidian review action ${action.actionKind}.`;
}

/**
 * Normalizes follow-up text into an open-loop-friendly string.
 *
 * **Why it exists:**
 * The Stage 6.86 open-loop helper expects a trigger phrase such as “follow up”, and this helper
 * guarantees that operator-authored review actions produce a valid open-loop mutation.
 *
 * **What it talks to:**
 * - Uses local string normalization rules within this module.
 *
 * @param value - Raw follow-up text from frontmatter or note body.
 * @returns Trigger-friendly follow-up text, or `null` when empty.
 */
function normalizeFollowUpText(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return /\bfollow up\b/i.test(trimmed) ? trimmed : `Follow up: ${trimmed}`;
}
