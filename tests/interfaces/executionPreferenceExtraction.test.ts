import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractExecutionPreferences
} from "../../src/interfaces/conversationRuntime/executionPreferenceExtraction";

test("extractExecutionPreferences keeps natural build wording ambiguous enough for the local intent model", () => {
  const preferences = extractExecutionPreferences(
    "Hey can you build me a simple tech landing page and leave it open for me to view?"
  );

  assert.equal(preferences.executeNow, false);
  assert.equal(preferences.statusOrRecall, false);
  assert.equal(preferences.presentation.leaveOpen, true);
});

test("extractExecutionPreferences treats polite edit imperatives as execute-now work", () => {
  const preferences = extractExecutionPreferences(
    "Please change the hero section so the headline says calmer sample operations start here."
  );

  assert.equal(preferences.executeNow, true);
  assert.equal(preferences.statusOrRecall, false);
});

test("extractExecutionPreferences does not misread build requests with a noun change object as direct edit execution", () => {
  const preferences = extractExecutionPreferences(
    "BigBrain I recorded a short clip so you can see what the UI is doing. The wrong panel slides in right after the menu opens and the dashboard feels off. Please build the dashboard change using this clip."
  );

  assert.equal(preferences.executeNow, false);
  assert.equal(preferences.statusOrRecall, false);
});

test("extractExecutionPreferences preserves mixed edit-plus-status overlap for the boundary interpreter", () => {
  const preferences = extractExecutionPreferences(
    "Please update the hero section and tell me what you changed."
  );

  assert.equal(preferences.executeNow, true);
  assert.equal(preferences.statusOrRecall, true);
});

test("extractExecutionPreferences leaves nuanced return-handoff review wording for the model-backed handoff interpreter", () => {
  const preferences = extractExecutionPreferences(
    "When I get back later, what should I inspect first from the draft you left me?"
  );

  assert.equal(preferences.executeNow, false);
  assert.equal(preferences.statusOrRecall, false);
});
