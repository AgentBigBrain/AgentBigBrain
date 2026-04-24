/**
 * @fileoverview Covers natural-language clarification rendering with deterministic option safety.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  renderClarificationQuestionText,
  toClarificationPromptDescriptor
} from "../../src/interfaces/conversationRuntime/clarificationPrompting";
import type { IntentClarificationCandidate } from "../../src/interfaces/conversationRuntime/intentModeContracts";

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

test("renderClarificationQuestionText accepts a natural build-format clarification that preserves valid options", async () => {
  const rendered = await renderClarificationQuestionText(
    toClarificationPromptDescriptor(
      'Build me a landing page in "C:\\Users\\testuser\\Desktop\\Solar".',
      BUILD_FORMAT_CANDIDATE
    ),
    "2026-04-18T22:00:00.000Z",
    async () => ({
      summary: "Do you want this as plain HTML, or should I build it in Next.js or React?"
    })
  );

  assert.equal(
    rendered,
    "Do you want this as plain HTML, or should I build it in Next.js or React?"
  );
});

test("renderClarificationQuestionText falls back when the model drops required option coverage", async () => {
  const rendered = await renderClarificationQuestionText(
    toClarificationPromptDescriptor(
      'Build me a landing page in "C:\\Users\\testuser\\Desktop\\Solar".',
      BUILD_FORMAT_CANDIDATE
    ),
    "2026-04-18T22:00:00.000Z",
    async () => ({
      summary: "Should I go ahead and build that now?"
    })
  );

  assert.equal(
    rendered,
    "Would you like that built as plain HTML, or as a framework app like Next.js or React?"
  );
});

test("renderClarificationQuestionText accepts natural plan-versus-build wording", async () => {
  const rendered = await renderClarificationQuestionText(
    toClarificationPromptDescriptor(
      "Please build the dashboard change using this clip.",
      EXECUTION_MODE_CANDIDATE
    ),
    "2026-04-18T22:00:00.000Z",
    async () => ({
      summary: "Should I plan this out first, or go straight into the build?"
    })
  );

  assert.equal(
    rendered,
    "Should I plan this out first, or go straight into the build?"
  );
});
