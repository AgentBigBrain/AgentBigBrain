/**
 * @fileoverview Tests Obsidian review-action parsing and guarded write-back through canonical mutation seams.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createEmptyProfileMemoryState,
  createProfileEpisodeRecord,
  upsertTemporalProfileFact
} from "../../src/core/profileMemory";
import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import { saveProfileMemoryState } from "../../src/core/profileMemoryRuntime/profileMemoryPersistence";
import { Stage686RuntimeStateStore } from "../../src/core/stage6_86/runtimeState";
import {
  applyObsidianReviewActionsFromDirectory
} from "../../src/core/projections/reviewActionIngestion";
import {
  parseObsidianReviewActionMarkdown,
  rewriteObsidianReviewActionMarkdown as rewriteReviewActionMarkdown
} from "../../src/core/projections/reviewActions";

test("parseObsidianReviewActionMarkdown accepts follow-up loop actions with array entity refs", () => {
  const markdown = rewriteReviewActionMarkdown("# Follow up with Owen\n", {
    abb_review_action_id: "review_action_follow_up",
    abb_action_kind: "create_follow_up_loop",
    abb_target_id: null,
    abb_follow_up_text: "Follow up with Owen about Detroit",
    abb_thread_key: "thread_detroit",
    abb_entity_refs: ["entity_owen", "entity_detroit"],
    abb_status: "pending"
  });

  const parsed = parseObsidianReviewActionMarkdown(markdown, "40 Review Actions/follow-up.md");

  assert.ok(parsed);
  assert.equal(parsed.actionKind, "create_follow_up_loop");
  assert.equal(parsed.targetId, null);
  assert.equal(parsed.threadKey, "thread_detroit");
  assert.deepEqual(parsed.entityRefs, ["entity_owen", "entity_detroit"]);
});

test("applyObsidianReviewActionsFromDirectory routes fact, episode, and follow-up actions through canonical stores", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-review-actions-"));
  try {
    const encryptionKey = Buffer.alloc(32, 7);
    const profilePath = path.join(tempDir, "profile_memory.json");
    const reviewDir = path.join(tempDir, "40 Review Actions");
    const runtimeStatePath = path.join(tempDir, "stage6_86_runtime_state.json");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, ".keep"), "", "utf8");

    const profileStore = new ProfileMemoryStore(profilePath, encryptionKey, 90);
    await profileStore.ingestFromTaskInput(
      "task_seed_fact",
      "my name is Avery",
      "2026-04-12T12:00:00.000Z"
    );
    const ingestedState = await profileStore.load();
    const seededState = {
      ...ingestedState,
      episodes: [
        createProfileEpisodeRecord({
          title: "Detroit follow-up",
          summary: "Owen still needs to confirm the Detroit follow-up.",
          sourceTaskId: "task_seed_episode",
          source: "test.seed",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          confidence: 0.88,
          observedAt: "2026-04-12T12:00:00.000Z",
          entityRefs: ["entity_owen", "entity_detroit"],
          openLoopRefs: ["loop_detroit_seed"],
          tags: ["followup"]
        })
      ]
    };
    await saveProfileMemoryState(profilePath, encryptionKey, seededState);
    const runtimeStateStore = new Stage686RuntimeStateStore(runtimeStatePath, {
      backend: "json",
      exportJsonOnWrite: false
    });

    const initialState = await profileStore.load();
    const factId = initialState.facts[0]?.id;
    const episodeId = initialState.episodes[0]?.id;
    assert.ok(factId);
    assert.ok(episodeId);

    await writeFile(
      path.join(reviewDir, "correct-fact.md"),
      rewriteReviewActionMarkdown("Switch this to Cursor.\n", {
        abb_review_action_id: "review_action_correct_fact",
        abb_action_kind: "correct_fact",
        abb_target_id: factId,
        abb_replacement_value: "Ava",
        abb_status: "pending"
      }),
      "utf8"
    );
    await writeFile(
      path.join(reviewDir, "resolve-episode.md"),
      rewriteReviewActionMarkdown("This follow-up is resolved.\n", {
        abb_review_action_id: "review_action_resolve_episode",
        abb_action_kind: "resolve_episode",
        abb_target_id: episodeId,
        abb_status: "pending"
      }),
      "utf8"
    );
    await writeFile(
      path.join(reviewDir, "create-loop.md"),
      rewriteReviewActionMarkdown("Follow up with Owen tomorrow.\n", {
        abb_review_action_id: "review_action_follow_up",
        abb_action_kind: "create_follow_up_loop",
        abb_target_id: null,
        abb_follow_up_text: "Follow up with Owen tomorrow",
        abb_thread_key: "thread_review_actions",
        abb_entity_refs: ["entity_owen"],
        abb_status: "pending"
      }),
      "utf8"
    );

    const report = await applyObsidianReviewActionsFromDirectory(reviewDir, {
      profileMemoryStore: profileStore,
      runtimeStateStore
    });

    assert.equal(report.appliedCount, 3);
    assert.equal(report.failedCount, 0);
    assert.equal(report.skippedCount, 0);

    const finalProfileState = await profileStore.load();
    const currentNameFact = finalProfileState.facts.find(
      (fact) => fact.supersededAt === null && fact.value === "Ava"
    );
    assert.equal(currentNameFact?.value, "Ava");
    assert.equal(
      finalProfileState.episodes.find((episode) => episode.id === episodeId)?.status,
      "resolved"
    );

    const runtimeState = await runtimeStateStore.load();
    const reviewThread = runtimeState.conversationStack.threads.find(
      (thread) => thread.threadKey === "thread_review_actions"
    );
    assert.ok(reviewThread);
    assert.equal(reviewThread?.openLoops.length, 1);
    assert.deepEqual(reviewThread?.openLoops[0]?.entityRefs, ["entity_owen"]);

    const correctedNote = await readFile(path.join(reviewDir, "correct-fact.md"), "utf8");
    assert.match(correctedNote, /abb_status: "applied"/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
