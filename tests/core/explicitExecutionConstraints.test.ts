import assert from "node:assert/strict";
import { test } from "node:test";

import { parseExplicitExecutionConstraints } from "../../src/core/explicitExecutionConstraints";

test("parseExplicitExecutionConstraints captures combined do-not-run-or-open wording", () => {
  const constraints = parseExplicitExecutionConstraints(
    "Get the workspace ready for edits with the dependencies installed. Do not run it or open anything yet."
  );

  assert.deepEqual(constraints, {
    disallowVisibleBrowserOpen: true,
    disallowPreviewStart: true
  });
});

test("parseExplicitExecutionConstraints stays narrow for unrelated negative wording", () => {
  const constraints = parseExplicitExecutionConstraints(
    "Do not use blue in the hero, but keep the landing page polished."
  );

  assert.deepEqual(constraints, {
    disallowVisibleBrowserOpen: false,
    disallowPreviewStart: false
  });
});

test("parseExplicitExecutionConstraints only uses the current request inside wrapped execution input", () => {
  const constraints = parseExplicitExecutionConstraints(
    [
      "You are in an ongoing conversation with the same user.",
      "",
      "Recent conversation context (oldest to newest):",
      "- user: Get the workspace ready for edits only. Do not run it or open anything yet.",
      "- assistant: I created the workspace and stopped before preview.",
      "",
      "Explicit execution constraints for this run:",
      "- The user explicitly said not to open the project/browser yet.",
      "- Do not open a browser window or page in this run unless a later user turn removes that restriction.",
      "",
      "Current user request:",
      "Nice. Pull up the landing page so it is ready to view, but do not pop the browser open yet. Use a real localhost run on host 127.0.0.1 and port 61884, and keep that preview server running."
    ].join("\n")
  );

  assert.deepEqual(constraints, {
    disallowVisibleBrowserOpen: true,
    disallowPreviewStart: false
  });
});
