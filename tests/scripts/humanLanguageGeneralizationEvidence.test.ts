/**
 * @fileoverview Covers scenario inventory validation and the final scenario-driven evidence report.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertHumanLanguageScenarioInventory,
  computeHumanLanguageScenarioDiagnostics,
  loadHumanLanguageScenarioInventory,
  runHumanLanguageGeneralizationEvidence
} from "../../scripts/evidence/humanLanguageGeneralizationEvidence";

test("human language scenario inventory passes for the current repo fixture", async () => {
  const fixture = await loadHumanLanguageScenarioInventory();
  const diagnostics = computeHumanLanguageScenarioDiagnostics(fixture);
  assert.equal(diagnostics.errors.length, 0);
  assert.ok(diagnostics.summary.scenarioCount >= 8);
});

test("human language scenario inventory rejects user turns that are too short", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "human-language-scenarios-"));
  try {
    const fixturePath = path.join(tempDir, "fixture.json");
    await writeFile(
      fixturePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          scenarios: [
            {
              id: "episode_positive",
              category: "episode_understanding",
              polarity: "positive",
              title: "Positive episode",
              summary: "A positive episode case.",
              expectedBehavior: ["extract_episode_candidate"],
              qualities: {
                resumedSituation: true,
                mixedPracticalRelational: true,
                topicDrift: true,
                vagueCallback: true
              },
              transcript: [
                {
                  speaker: "user",
                  text: "Owen fell."
                },
                {
                  speaker: "assistant",
                  text: "That sounds important. I should treat it carefully."
                }
              ]
            },
            {
              id: "episode_negative",
              category: "episode_understanding",
              polarity: "negative",
              title: "Negative episode",
              summary: "A negative episode case.",
              expectedBehavior: ["suppress_episode_candidate"],
              qualities: {},
              transcript: [
                {
                  speaker: "user",
                  text: "Owen was stressed. I was just venting. Nothing concrete happened."
                },
                {
                  speaker: "assistant",
                  text: "That should not become a concrete episode."
                }
              ]
            },
            {
              id: "recall_positive",
              category: "contextual_recall",
              polarity: "positive",
              title: "Positive recall",
              summary: "A positive recall case.",
              expectedBehavior: ["resolve_contextual_reference"],
              qualities: {},
              transcript: [
                {
                  speaker: "user",
                  text: "My mom had a scare last month. We never got a full answer. It still feels unfinished."
                },
                {
                  speaker: "assistant",
                  text: "That sounds unresolved and memorable."
                }
              ]
            },
            {
              id: "recall_negative",
              category: "contextual_recall",
              polarity: "negative",
              title: "Negative recall",
              summary: "A negative recall case.",
              expectedBehavior: ["suppress_contextual_recall"],
              qualities: {},
              transcript: [
                {
                  speaker: "user",
                  text: "Owen sent a meme today. We joked around for a bit. Nothing serious came up."
                },
                {
                  speaker: "assistant",
                  text: "That should not reopen an old issue."
                }
              ]
            },
            {
              id: "synthesis_positive",
              category: "cross_memory_synthesis",
              polarity: "positive",
              title: "Positive synthesis",
              summary: "A positive synthesis case.",
              expectedBehavior: ["produce_bounded_synthesis"],
              qualities: {},
              transcript: [
                {
                  speaker: "user",
                  text: "Owen matters to me. The fall never got a clean ending. I meant to follow up and never did."
                },
                {
                  speaker: "assistant",
                  text: "That gives enough evidence for one bounded synthesis."
                }
              ]
            },
            {
              id: "synthesis_negative",
              category: "cross_memory_synthesis",
              polarity: "negative",
              title: "Negative synthesis",
              summary: "A negative synthesis case.",
              expectedBehavior: ["suppress_bounded_synthesis"],
              qualities: {},
              transcript: [
                {
                  speaker: "user",
                  text: "I am mixing two different stories together. I do not trust my own summary yet. It is all fuzzy."
                },
                {
                  speaker: "assistant",
                  text: "That should suppress synthesis."
                }
              ]
            },
            {
              id: "proactive_positive",
              category: "proactive_utility",
              polarity: "positive",
              title: "Positive proactive",
              summary: "A positive proactive case.",
              expectedBehavior: ["allow_proactive_followup"],
              qualities: {},
              transcript: [
                {
                  speaker: "user",
                  text: "If I forget tomorrow, remind me to ask Owen about his MRI results. I really do want a nudge. A generic check-in would not help."
                },
                {
                  speaker: "assistant",
                  text: "That is a good proactive case."
                }
              ]
            },
            {
              id: "proactive_negative",
              category: "proactive_utility",
              polarity: "negative",
              title: "Negative proactive",
              summary: "A negative proactive case.",
              expectedBehavior: ["suppress_generic_proactive_nudge"],
              qualities: {},
              transcript: [
                {
                  speaker: "user",
                  text: "Nothing is really open. I am just chatting. If there is no concrete reason, I do not want a follow-up."
                },
                {
                  speaker: "assistant",
                  text: "That should suppress proactive outreach."
                }
              ]
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    await assert.rejects(
      () => assertHumanLanguageScenarioInventory(fixturePath),
      /must be 2 to 4 sentences long/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("human language generalization evidence emits a scenario-driven report with required proofs", async () => {
  const artifact = await runHumanLanguageGeneralizationEvidence();
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/human_language_generalization_report.json"
  );
  const persisted = JSON.parse(await readFile(artifactPath, "utf8")) as {
    status: string;
    requiredProofs: Record<string, boolean>;
    summary: {
      scenarioCount: number;
      passedScenarios: number;
      failedScenarios: number;
    };
    scenarioResults: Array<{
      scenarioId: string;
      passed: boolean;
    }>;
  };

  assert.equal(artifact.status, "PASS");
  assert.equal(persisted.status, "PASS");
  assert.equal(persisted.summary.failedScenarios, 0);
  assert.equal(persisted.summary.scenarioCount, persisted.summary.passedScenarios);
  assert.equal(
    Object.values(persisted.requiredProofs).every((value) => value === true),
    true
  );
  assert.ok(
    persisted.scenarioResults.some(
      (scenario) =>
        scenario.scenarioId === "contextual_recall_mom_hospital_positive"
        && scenario.passed
    )
  );
  assert.ok(
    persisted.scenarioResults.some(
      (scenario) =>
        scenario.scenarioId === "proactive_followup_generic_ping_negative"
        && scenario.passed
    )
  );
});
