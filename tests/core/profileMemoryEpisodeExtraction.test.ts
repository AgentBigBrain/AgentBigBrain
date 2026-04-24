/**
 * @fileoverview Focused tests for canonical episodic-memory extraction helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { extractProfileEpisodeCandidatesFromUserInput } from "../../src/core/profileMemoryRuntime/profileMemoryEpisodeExtraction";

test("canonical episode extraction captures named-person situation candidates", () => {
  const candidates = extractProfileEpisodeCandidatesFromUserInput(
    "Owen fell down at the store three weeks ago and I never told you how it ended.",
    "task_profile_episode_extract_1",
    "2026-03-08T12:00:00.000Z"
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.title, "Owen fell down");
  assert.equal(
    candidates[0]?.summary,
    "Owen fell down at the store three weeks ago and I never told you how it ended"
  );
  assert.deepEqual(candidates[0]?.entityRefs, ["contact.owen"]);
  assert.equal(candidates[0]?.tags?.includes("fall"), true);
});

test("canonical episode extraction deduplicates equivalent sentences in one utterance", () => {
  const candidates = extractProfileEpisodeCandidatesFromUserInput(
    "Owen fell down. Owen fell down yesterday and it has been a mess.",
    "task_profile_episode_extract_2",
    "2026-03-08T12:00:00.000Z"
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.title, "Owen fell down");
});

test("canonical episode extraction captures bounded transfer events with both people and the shared object surface", () => {
  const candidates = extractProfileEpisodeCandidatesFromUserInput(
    "Milo sold Jordan the gray Accord in late 2024.",
    "task_profile_episode_extract_transfer_1",
    "2026-04-09T19:00:00.000Z"
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.title, "Milo sold Jordan the gray Accord");
  assert.equal(
    candidates[0]?.summary,
    "Milo sold Jordan the gray Accord in late 2024"
  );
  assert.deepEqual(
    candidates[0]?.entityRefs,
    ["contact.milo", "contact.jordan", "gray Accord"]
  );
  assert.deepEqual(candidates[0]?.tags, ["followup", "transaction", "transfer"]);
});

test("canonical episode extraction captures pending launch reviews from timeline corrections", () => {
  const candidates = extractProfileEpisodeCandidatesFromUserInput(
    "The March 27 Docklight launch review is still pending.",
    "task_profile_episode_extract_pending_review",
    "2026-04-13T08:30:38.000Z"
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.title, "Docklight launch review");
  assert.equal(candidates[0]?.status, "unresolved");
  assert.deepEqual(candidates[0]?.entityRefs, ["Docklight"]);
  assert.deepEqual(candidates[0]?.tags, ["followup", "milestone", "pending", "review"]);
});

test("canonical episode extraction captures tentative work items and possible moves", () => {
  const candidates = extractProfileEpisodeCandidatesFromUserInput(
    [
      "Crimson Analytics is considering a case-study page, but that is still tentative and not scheduled.",
      "Billy says he may revisit moving in summer."
    ].join(" "),
    "task_profile_episode_extract_tentative",
    "2026-04-13T08:30:38.000Z"
  );

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]?.title, "Crimson Analytics case-study page");
  assert.equal(candidates[0]?.status, "outcome_unknown");
  assert.deepEqual(candidates[0]?.entityRefs, ["Crimson Analytics"]);
  assert.deepEqual(candidates[0]?.tags, ["planning", "tentative", "work"]);

  assert.equal(candidates[1]?.title, "Billy possible move");
  assert.equal(candidates[1]?.status, "outcome_unknown");
  assert.deepEqual(candidates[1]?.entityRefs, ["contact.billy"]);
  assert.deepEqual(candidates[1]?.tags, ["move", "planning", "tentative"]);
});

test("canonical episode extraction reuses within-turn review and move context for follow-up sentences", () => {
  const candidates = extractProfileEpisodeCandidatesFromUserInput(
    [
      "The Docklight launch review did not happen on March 20.",
      "It was pushed to March 27, which means the March 27 review is the current pending milestone.",
      "Billy decided not to move right away.",
      "He may revisit that in summer."
    ].join(" "),
    "task_profile_episode_extract_contextual_followups",
    "2026-04-13T08:30:38.000Z"
  );

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]?.title, "Docklight launch review");
  assert.match(candidates[0]?.summary ?? "", /current pending milestone/i);
  assert.deepEqual(candidates[0]?.entityRefs, ["Docklight"]);

  assert.equal(candidates[1]?.title, "Billy possible move");
  assert.deepEqual(candidates[1]?.entityRefs, ["contact.billy"]);
});
