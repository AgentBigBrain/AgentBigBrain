/**
 * @fileoverview Tests Telegram completion matrix fixture and evidence contract without live Telegram.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildBlockedCompletionMatrixEvidence,
  buildCompletionMatrixEvidence,
  buildCompletionMatrixScenarioResult,
  loadCompletionMatrixScenarios,
  TELEGRAM_COMPLETION_MATRIX_ARTIFACT_PATH,
  TELEGRAM_COMPLETION_MATRIX_CONFIRM_ENV,
  validateCompletionMatrixEvidence,
  validateCompletionMatrixScenarios
} from "../../scripts/evidence/telegramCompletionMatrixSupport";
import {
  runTelegramCompletionMatrixLiveSmoke
} from "../../scripts/evidence/telegramCompletionMatrixLiveSmoke";

test("Telegram completion matrix fixture covers every family with positive and negative controls", async () => {
  const scenarios = await loadCompletionMatrixScenarios();
  validateCompletionMatrixScenarios(scenarios);

  const families = new Set(scenarios.map((scenario) => scenario.family));
  assert.deepEqual(
    [...families].sort(),
    [
      "blocked_or_clarify",
      "document_attachment",
      "followup_edit",
      "memory_recall",
      "skill_lifecycle",
      "static_site"
    ]
  );
  for (const family of families) {
    const controls = new Set(
      scenarios.filter((scenario) => scenario.family === family).map((scenario) => scenario.control)
    );
    assert.deepEqual([...controls].sort(), ["negative", "positive"]);
  }
});

test("Telegram completion matrix schema-only mode writes a passing review-safe artifact", async () => {
  const artifact = await runTelegramCompletionMatrixLiveSmoke(["--schema-only"]);
  const persisted = JSON.parse(await readFile(TELEGRAM_COMPLETION_MATRIX_ARTIFACT_PATH, "utf8")) as {
    status: string;
    mode: string;
    redactionStatus: string;
    summary: {
      scenarioCount: number;
      passedScenarios: number;
    };
    results: Array<{
      id: string;
      status: string;
      selectedGuidanceProof: Record<string, unknown> | null;
      mediaProof: Record<string, unknown> | null;
    }>;
  };

  assert.equal(artifact.status, "PASS");
  assert.equal(persisted.status, "PASS");
  assert.equal(persisted.mode, "schema_only");
  assert.equal(persisted.redactionStatus, "review_safe");
  assert.equal(persisted.summary.passedScenarios, persisted.summary.scenarioCount);
});

test("Telegram completion matrix produces bounded BLOCKED evidence without live confirmation", async () => {
  const previous = process.env[TELEGRAM_COMPLETION_MATRIX_CONFIRM_ENV];
  delete process.env[TELEGRAM_COMPLETION_MATRIX_CONFIRM_ENV];
  try {
    const artifact = await runTelegramCompletionMatrixLiveSmoke([
      "--scenario=static_html_markdown_guidance_positive"
    ]);
    assert.equal(artifact.status, "BLOCKED");
    assert.equal(artifact.summary.blockedScenarios, 1);
    assert.match(artifact.results[0]?.blockerReason ?? "", /TELEGRAM_COMPLETION_MATRIX/i);
  } finally {
    if (previous === undefined) {
      delete process.env[TELEGRAM_COMPLETION_MATRIX_CONFIRM_ENV];
    } else {
      process.env[TELEGRAM_COMPLETION_MATRIX_CONFIRM_ENV] = previous;
    }
  }
});

test("Telegram completion matrix evidence rejects unredacted local paths", async () => {
  const scenario = (await loadCompletionMatrixScenarios())[0];
  assert.ok(scenario);
  const result = buildCompletionMatrixScenarioResult(scenario, {
    status: "PASS"
  });
  const artifact = buildCompletionMatrixEvidence("schema_only", [
    {
      ...result,
      artifactPaths: ["C:\\Users\\PrivateName\\Desktop\\site\\index.html"],
      status: "PASS"
    }
  ]);

  assert.throws(
    () => validateCompletionMatrixEvidence(artifact),
    /unredacted local path/i
  );
});

test("Telegram completion matrix can represent provider-unavailable BLOCKED evidence", async () => {
  const scenarios = await loadCompletionMatrixScenarios();
  const artifact = buildBlockedCompletionMatrixEvidence(
    scenarios.slice(0, 2),
    "provider unavailable for live Telegram run"
  );

  validateCompletionMatrixEvidence(artifact);
  assert.equal(artifact.status, "BLOCKED");
  assert.equal(artifact.summary.blockedScenarios, 2);
});

test("package scripts expose Telegram completion matrix live-smoke commands", async () => {
  const packageJson = JSON.parse(
    await readFile(path.resolve(process.cwd(), "package.json"), "utf8")
  ) as { scripts?: Record<string, string> };

  assert.equal(
    packageJson.scripts?.["test:telegram_desktop_workflow_cleanup:live_smoke"],
    "tsx scripts/evidence/telegramDesktopWorkflowAndCleanupLiveSmoke.ts"
  );
  assert.equal(
    packageJson.scripts?.["test:telegram_completion_matrix:live_smoke"],
    "tsx scripts/evidence/telegramCompletionMatrixLiveSmoke.ts"
  );
});
