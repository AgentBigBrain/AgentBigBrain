/**
 * @fileoverview Covers persisted clarification state creation and deterministic answer resolution.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildClarifiedExecutionInput,
  createActiveClarificationState,
  createTaskRecoveryClarificationState,
  isClarificationExpired,
  resolveClarifiedBuildFormatMetadata,
  resolveClarifiedIntentMode,
  resolveClarificationAnswer
} from "../../src/interfaces/conversationRuntime/clarificationBroker";
import type { IntentClarificationCandidate } from "../../src/interfaces/conversationRuntime/intentModeContracts";

const EXECUTION_MODE_CANDIDATE: IntentClarificationCandidate = {
  kind: "execution_mode",
  matchedRuleId: "execution_intent_build_generic",
  renderingIntent: "plan_or_build",
  question: "Do you want me to plan it first or build it now?",
  options: [
    { id: "plan", label: "Plan it first" },
    { id: "build", label: "Build it now" }
  ]
};

const BUILD_FORMAT_CANDIDATE: IntentClarificationCandidate = {
  kind: "build_format",
  matchedRuleId: "intent_mode_build_format_clarify_execution_style",
  renderingIntent: "build_format",
  question: "Would you like that built as plain HTML, or as a framework app like Next.js or React?",
  options: [
    { id: "static_html", label: "Plain HTML" },
    { id: "nextjs", label: "Next.js" },
    { id: "react", label: "React" }
  ]
};

test("createActiveClarificationState preserves original source input and option labels", () => {
  const clarification = createActiveClarificationState(
    "Create me that landing page with a hero and CTA.",
    "2026-03-11T18:00:00.000Z",
    EXECUTION_MODE_CANDIDATE
  );

  assert.equal(clarification.sourceInput, "Create me that landing page with a hero and CTA.");
  assert.equal(clarification.renderingIntent, "plan_or_build");
  assert.equal(clarification.riskClass, "medium");
  assert.match(clarification.promptFingerprint ?? "", /^clarification_prompt_[a-f0-9]+$/);
  assert.equal(clarification.options[0]?.label, "Plan it first");
});

test("resolveClarificationAnswer picks the single deterministic option from a human reply", () => {
  const clarification = createActiveClarificationState(
    "Create me that landing page with a hero and CTA.",
    "2026-03-11T18:00:00.000Z",
    EXECUTION_MODE_CANDIDATE
  );

  const resolution = resolveClarificationAnswer(
    clarification,
    "Build it now and just go ahead with the real thing."
  );

  assert.equal(resolution?.selectedOptionId, "build");
  assert.equal(resolution?.promptId, clarification.id);
  assert.equal(resolution?.promptFingerprint, clarification.promptFingerprint);
  assert.equal(resolution?.riskClass, "medium");
  assert.ok(
    buildClarifiedExecutionInput(
      clarification.sourceInput,
      clarification,
      resolution?.selectedOptionId ?? "build"
    ).includes("User selected: Build it now.")
  );
});

test("resolveClarificationAnswer stays unresolved when the reply remains ambiguous", () => {
  const clarification = createActiveClarificationState(
    "Create me that landing page with a hero and CTA.",
    "2026-03-11T18:00:00.000Z",
    EXECUTION_MODE_CANDIDATE
  );

  const resolution = resolveClarificationAnswer(
    clarification,
    "Yeah, do whichever makes sense."
  );

  assert.equal(resolution, null);
});

test("build-format clarification resolves static HTML and framework answers deterministically", () => {
  const clarification = createActiveClarificationState(
    "Build me a landing page and put it on my desktop.",
    "2026-03-11T18:00:00.000Z",
    BUILD_FORMAT_CANDIDATE
  );

  const htmlResolution = resolveClarificationAnswer(
    clarification,
    "Plain HTML please."
  );
  const nextResolution = resolveClarificationAnswer(
    clarification,
    "Next.js."
  );

  assert.equal(htmlResolution?.selectedOptionId, "static_html");
  assert.equal(nextResolution?.selectedOptionId, "nextjs");
  assert.equal(
    resolveClarifiedIntentMode(
      clarification.sourceInput,
      clarification,
      htmlResolution?.selectedOptionId ?? "static_html"
    ),
    "static_html_build"
  );
  assert.equal(
    resolveClarifiedIntentMode(
      clarification.sourceInput,
      clarification,
      nextResolution?.selectedOptionId ?? "nextjs"
    ),
    "framework_app_build"
  );
  assert.deepEqual(
    resolveClarifiedBuildFormatMetadata(
      clarification,
      htmlResolution?.selectedOptionId ?? "static_html"
    ),
    {
      format: "static_html",
      source: "clarification",
      confidence: "high"
    }
  );
  assert.deepEqual(
    resolveClarifiedBuildFormatMetadata(
      clarification,
      nextResolution?.selectedOptionId ?? "nextjs"
    ),
    {
      format: "nextjs",
      source: "clarification",
      confidence: "high"
    }
  );
  assert.match(
    buildClarifiedExecutionInput(
      clarification.sourceInput,
      clarification,
      nextResolution?.selectedOptionId ?? "nextjs"
    ),
    /Preferred framework: nextjs\./i
  );
});

test("build-format clarification expires on the bounded execution-style window", () => {
  const clarification = createActiveClarificationState(
    "Build me a landing page and put it on my desktop.",
    "2026-03-11T18:00:00.000Z",
    BUILD_FORMAT_CANDIDATE
  );

  assert.equal(isClarificationExpired(clarification, "2026-03-11T21:59:59.000Z"), false);
  assert.equal(isClarificationExpired(clarification, "2026-03-11T22:00:01.000Z"), true);
});

test("isClarificationExpired expires stale execution-mode clarification after the bounded window", () => {
  const clarification = createActiveClarificationState(
    "Create me that landing page with a hero and CTA.",
    "2026-03-11T18:00:00.000Z",
    EXECUTION_MODE_CANDIDATE
  );

  assert.equal(isClarificationExpired(clarification, "2026-03-11T21:59:59.000Z"), false);
  assert.equal(isClarificationExpired(clarification, "2026-03-11T22:00:01.000Z"), true);
});

test("task recovery clarification resolves yes/no answers and adds a recovery instruction", () => {
  const clarification = createTaskRecoveryClarificationState(
    "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.",
    "2026-03-13T14:00:00.000Z",
    "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
    "post_execution_locked_folder_recovery",
    "Recovery instruction: stop only these exact tracked preview-process lease ids if they are still active: leaseId=\"proc_preview_1\"."
  );

  const yesResolution = resolveClarificationAnswer(
    clarification,
    "Yes, go ahead and retry it."
  );
  const noResolution = resolveClarificationAnswer(
    clarification,
    "No, leave them alone."
  );

  assert.equal(yesResolution?.selectedOptionId, "retry_with_shutdown");
  assert.equal(noResolution?.selectedOptionId, "cancel");
  assert.match(
    buildClarifiedExecutionInput(
      clarification.sourceInput,
      clarification,
      yesResolution?.selectedOptionId ?? "retry_with_shutdown"
    ),
    /leaseId="proc_preview_1"/i
  );
});

test("task recovery clarification rejects generic yes for high-risk recovery options", () => {
  const shutdownClarification = createTaskRecoveryClarificationState(
    "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.",
    "2026-03-13T14:00:00.000Z",
    "I can stop only the exact tracked holder and retry the move. Do you want me to do that?",
    "post_execution_locked_folder_recovery",
    "Recovery instruction: stop only this exact tracked preview-process lease id: leaseId=\"proc_preview_1\"."
  );
  const inspectionClarification = createTaskRecoveryClarificationState(
    "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.",
    "2026-03-13T14:05:00.000Z",
    "I can inspect the likely holders more closely before taking action. Do you want me to continue that recovery?",
    "post_execution_untracked_holder_recovery_clarification",
    "Recovery instruction: inspect the likely untracked holders more closely. Do not stop them automatically.",
    [
      { id: "continue_recovery", label: "Yes, inspect and continue" },
      { id: "cancel", label: "No, leave them alone" }
    ]
  );

  assert.equal(shutdownClarification.riskClass, "high");
  assert.equal(inspectionClarification.riskClass, "high");
  assert.equal(resolveClarificationAnswer(shutdownClarification, "Yes."), null);
  assert.equal(resolveClarificationAnswer(inspectionClarification, "Yes."), null);
  assert.equal(
    resolveClarificationAnswer(shutdownClarification, "Shut it down and retry.")?.selectedOptionId,
    "retry_with_shutdown"
  );
  assert.equal(
    resolveClarificationAnswer(inspectionClarification, "Inspect and continue.")?.selectedOptionId,
    "continue_recovery"
  );
});

test("task recovery clarification can continue recovery without pretending shutdown is already proven", () => {
  const clarification = createTaskRecoveryClarificationState(
    "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.",
    "2026-03-13T14:00:00.000Z",
    "I couldn't move those folders yet because likely local preview holders may still be using them. I can inspect those holders more closely first. Do you want me to continue that recovery?",
    "post_execution_untracked_holder_recovery_clarification",
    "Recovery instruction: inspect the likely untracked holder processes more closely. Do not stop them automatically.",
    [
      {
        id: "continue_recovery",
        label: "Yes, inspect and continue"
      },
      {
        id: "cancel",
        label: "No, leave them alone"
      }
    ]
  );

  const yesResolution = resolveClarificationAnswer(
    clarification,
    "Yes, inspect them more closely first."
  );

  assert.equal(yesResolution?.selectedOptionId, "continue_recovery");
  assert.match(
    buildClarifiedExecutionInput(
      clarification.sourceInput,
      clarification,
      yesResolution?.selectedOptionId ?? "continue_recovery"
    ),
    /inspect the likely untracked holder processes more closely/i
  );
});

test("task recovery clarification preserves exact non-preview shutdown markers after confirmation", () => {
  const clarification = createTaskRecoveryClarificationState(
    "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.",
    "2026-03-14T20:15:00.000Z",
    "I found one high-confidence local holder still tied to those folders: Code (pid 8840). It still looks like an editor or IDE process is holding them. If you want, I can stop just that process and retry the move. Do you want me to do that?",
    "post_execution_exact_non_preview_holder_recovery_clarification",
    [
      "[WORKSPACE_RECOVERY_STOP_EXACT]",
      "A folder move was blocked because one high-confidence local holder still owns the target folders. Stop only this exact confirmed local holder if it is still active: pid=8840 (Code (pid 8840)).",
      "Verify it stopped, then retry this original folder-organization goal: \"Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.\"."
    ].join("\n")
  );

  const yesResolution = resolveClarificationAnswer(
    clarification,
    "Yes, shut that down and retry it."
  );

  assert.equal(yesResolution?.selectedOptionId, "retry_with_shutdown");
  assert.match(
    buildClarifiedExecutionInput(
      clarification.sourceInput,
      clarification,
      yesResolution?.selectedOptionId ?? "retry_with_shutdown"
    ),
    /\[WORKSPACE_RECOVERY_STOP_EXACT\]/i
  );
  assert.match(
    buildClarifiedExecutionInput(
      clarification.sourceInput,
      clarification,
      yesResolution?.selectedOptionId ?? "retry_with_shutdown"
    ),
    /pid=8840/i
  );
});
