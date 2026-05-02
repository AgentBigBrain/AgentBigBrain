/**
 * @fileoverview Tests explicit-action intent inference and run-skill filtering directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  filterNonExplicitRunSkillActions,
  hasRequiredAction,
  inferRequiredActionType
} from "../../src/organs/plannerPolicy/explicitActionIntent";
import {
  MAX_FAILURE_FINGERPRINT_SEGMENT_LENGTH,
  normalizeFingerprintSegment
} from "../../src/organs/plannerPolicy/plannerFailurePolicy";

test("inferRequiredActionType recognizes explicit runtime tools and create-skill intent", () => {
  assert.equal(
    inferRequiredActionType('verify_browser url=http://localhost:3000 expect_title="Smoke"'),
    "verify_browser"
  );
  assert.equal(
    inferRequiredActionType("open_browser url=http://localhost:3000"),
    "open_browser"
  );
  assert.equal(
    inferRequiredActionType("Create a skill called workflow_helper that validates smoke state."),
    "create_skill"
  );
  assert.equal(
    inferRequiredActionType("Update skill agency_site_guidance with the revised Markdown notes."),
    "update_skill"
  );
  assert.equal(
    inferRequiredActionType("Approve skill agency_site_guidance so it can be reused."),
    "approve_skill"
  );
  assert.equal(
    inferRequiredActionType("Reject skill draft_skill_notes."),
    "reject_skill"
  );
  assert.equal(
    inferRequiredActionType("Deprecate skill legacy_text_helper."),
    "deprecate_skill"
  );
});

test("inferRequiredActionType promotes natural browser follow-ups when tracked session context exists", () => {
  const trackedBrowserExecutionInput = [
    "Tracked browser sessions:",
    "- Landing page preview: sessionId=browser_session:landing-page; url=http://127.0.0.1:4173/; status=open; visibility=visible; controller=playwright_managed; control=available",
    "",
    "Current user request:",
    "Close the landing page so we can work on something else."
  ].join("\n");

  assert.equal(
    inferRequiredActionType(
      "Close the landing page so we can work on something else.",
      trackedBrowserExecutionInput
    ),
    "close_browser"
  );
  assert.equal(
    inferRequiredActionType(
      "Open the landing page browser again so I can see it.",
      trackedBrowserExecutionInput
    ),
    "open_browser"
  );
});

test("inferRequiredActionType does not require open_browser when a tracked preview warm-up explicitly says not to open the browser yet", () => {
  const trackedBrowserExecutionInput = [
    "Current tracked workspace in this chat:",
    "- Root path: C:\\Users\\testuser\\Desktop\\Sample City Showcase Smoke 1775919630732",
    "- Preview URL: none",
    "",
    "Tracked browser sessions:",
    "- none",
    "",
    "Current user request:",
    "Nice. Pull up the Sample City Showcase Smoke 1775919630732 landing page you just built so it is ready to view, but do not pop the browser open yet. Use a real localhost run on host 127.0.0.1 and port 49249, and keep that preview server running."
  ].join("\n");

  assert.equal(
    inferRequiredActionType(
      "Nice. Pull up the Sample City Showcase Smoke 1775919630732 landing page you just built so it is ready to view, but do not pop the browser open yet. Use a real localhost run on host 127.0.0.1 and port 49249, and keep that preview server running.",
      trackedBrowserExecutionInput
    ),
    null
  );
});

test("inferRequiredActionType treats closing a named tracked workspace as close_browser", () => {
  const trackedBrowserExecutionInput = [
    "Current tracked workspace in this chat:",
    "- Root path: C:\\Users\\testuser\\Desktop\\Sample City\\dist",
    "- Primary artifact: C:\\Users\\testuser\\Desktop\\Sample City\\dist\\index.html",
    "- Preview URL: file:///C:/Users/testuser/Desktop/AI%20Sample%20City/dist/index.html",
    "",
    "Tracked browser sessions:",
    "- Sample City preview: sessionId=browser_session:ai-sample-city; url=file:///C:/Users/testuser/Desktop/AI%20Sample%20City/dist/index.html; status=open; visibility=visible; controller=playwright_managed; control=available; workspaceRoot=C:\\Users\\testuser\\Desktop\\Sample City\\dist",
    "",
    "Current user request:",
    "Thanks. Please close Sample City and anything it needs so we can move on."
  ].join("\n");

  assert.equal(
    inferRequiredActionType(
      "Thanks. Please close Sample City and anything it needs so we can move on.",
      trackedBrowserExecutionInput
    ),
    "close_browser"
  );
});

test("inferRequiredActionType promotes tracked artifact-edit follow-ups to write_file", () => {
  const trackedArtifactExecutionInput = [
    "Natural artifact-edit follow-up:",
    "- The user appears to be editing the artifact already created in this chat rather than asking for a brand-new project.",
    "- Preferred edit destination: C:\\Users\\testuser\\Desktop\\sample-company",
    "- Preferred primary artifact: C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
    "- Visible preview already exists: http://127.0.0.1:4173/; keep the preview aligned with the edited artifact when practical.",
    "- This run must include a real file mutation under the tracked workspace. Do not satisfy this request by only reopening, focusing, or closing the preview.",
    "",
    "Current user request:",
    "Change the hero image to a slider instead of the landing page."
  ].join("\n");

  assert.equal(
    inferRequiredActionType(
      "Change the hero image to a slider instead of the landing page.",
      trackedArtifactExecutionInput
    ),
    "write_file"
  );
});

test("inferRequiredActionType does not promote artifact edits when the resolved semantic route is non-build recall", () => {
  const trackedArtifactExecutionInput = [
    "Resolved semantic route:",
    "- routeId: status_recall",
    "",
    "Natural artifact-edit follow-up:",
    "- The user appears to be editing the artifact already created in this chat rather than asking for a brand-new project.",
    "- Preferred edit destination: C:\\Users\\testuser\\Desktop\\sample-company",
    "- Preferred primary artifact: C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
    "",
    "Current user request:",
    "Change the hero image to a slider instead of the landing page."
  ].join("\n");

  assert.equal(
    inferRequiredActionType(
      "Change the hero image to a slider instead of the landing page.",
      trackedArtifactExecutionInput
    ),
    null
  );
});

test("inferRequiredActionType consumes route-approved runtime-control intent before natural fallback", () => {
  const executionInput = [
    "Resolved semantic route:",
    "- routeId: build_request",
    "- runtimeControlIntent: close_browser",
    "",
    "Current user request:",
    "Please handle the tracked runtime target."
  ].join("\n");

  assert.equal(
    inferRequiredActionType("Please handle the tracked runtime target.", executionInput),
    "close_browser"
  );
});

test("inferRequiredActionType does not let natural browser wording override resolved route metadata", () => {
  const executionInput = [
    "Resolved semantic route:",
    "- routeId: status_recall",
    "- runtimeControlIntent: none",
    "",
    "Tracked browser sessions:",
    "- url=http://localhost:3000; workspaceRoot=C:\\Users\\testuser\\Desktop\\Sample City",
    "",
    "Current user request:",
    "Close the browser for the landing page."
  ].join("\n");

  assert.equal(
    inferRequiredActionType("Close the browser for the landing page.", executionInput),
    null
  );
});

test("filterNonExplicitRunSkillActions removes run_skill work unless the request explicitly asks for it", () => {
  const actions = [
    {
      id: "action_run_skill",
      type: "run_skill" as const,
      description: "run workflow skill",
      params: {
        name: "workflow_skill"
      },
      estimatedCostUsd: 0.05
    },
    {
      id: "action_respond",
      type: "respond" as const,
      description: "respond",
      params: {
        message: "fallback"
      },
      estimatedCostUsd: 0.01
    }
  ];

  assert.deepEqual(
    filterNonExplicitRunSkillActions(
      actions,
      "Summarize deterministic sandboxing controls rather than running a skill."
    ).map((action) => action.type),
    ["respond"]
  );
  assert.deepEqual(
    filterNonExplicitRunSkillActions(
      actions,
      "Run skill workflow_skill to capture the browser replay."
    ).map((action) => action.type),
    ["run_skill", "respond"]
  );
  assert.equal(hasRequiredAction(actions, "run_skill"), true);
});

test("normalizeFingerprintSegment lowercases, collapses whitespace, and truncates deterministically", () => {
  const noisy = `  MULTI   space ${"x".repeat(MAX_FAILURE_FINGERPRINT_SEGMENT_LENGTH + 20)}  `;
  const normalized = normalizeFingerprintSegment(noisy);

  assert.equal(normalized, normalized.toLowerCase());
  assert.ok(!/\s{2,}/.test(normalized));
  assert.ok(normalized.length <= MAX_FAILURE_FINGERPRINT_SEGMENT_LENGTH);
});
