/**
 * @fileoverview Tests human-first queued-worker progress narration.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConversationWorkerProgressMessage } from "../../src/interfaces/conversationRuntime/conversationWorkerProgressText";

test("buildConversationWorkerProgressMessage narrates autonomous page-building work in human terms", () => {
  const message = buildConversationWorkerProgressMessage({
    input: "Please create a sample landing page and leave it open for me.",
    executionInput:
      "[AUTONOMOUS_LOOP_GOAL] Please create a sample landing page and leave it open for me."
  });

  assert.equal(message, "I'm building the page and setting up the preview.");
});

test("buildConversationWorkerProgressMessage narrates preview edits and organization work without echoing the prompt", () => {
  const editMessage = buildConversationWorkerProgressMessage({
    input: "Please turn the hero into a slider and keep the same preview open.",
    executionInput:
      "[AUTONOMOUS_LOOP_GOAL] Please turn the hero into a slider and keep the same preview open."
  });
  const organizeMessage = buildConversationWorkerProgressMessage(
    {
      input:
        "Every folder with the name beginning in sample-company should go in sample-folder on my desktop.",
      executionInput:
        "[AUTONOMOUS_LOOP_GOAL] Every folder with the name beginning in sample-company should go in sample-folder on my desktop."
    },
    34
  );

  assert.equal(
    editMessage,
    "I'm updating the current page and keeping the preview in sync."
  );
  assert.equal(
    organizeMessage,
    "I'm organizing the project folders and checking what can be moved safely (34s elapsed)."
  );
});

test("buildConversationWorkerProgressMessage narrates close and generic work calmly", () => {
  const closeMessage = buildConversationWorkerProgressMessage({
    input: "Close the landing page so we can work on something else.",
    executionInput: "Close the landing page so we can work on something else."
  });
  const genericMessage = buildConversationWorkerProgressMessage({
    input: "Take this from start to finish.",
    executionInput: "Take this from start to finish."
  });

  assert.equal(
    closeMessage,
    "I'm closing the tracked preview and making sure that page is not left open."
  );
  assert.equal(genericMessage, "I'm working on that now.");
});
