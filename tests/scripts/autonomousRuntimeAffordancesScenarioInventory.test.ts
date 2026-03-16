/**
 * @fileoverview Covers the human-centered autonomy scenario inventory and its negative controls.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertAutonomousRuntimeAffordancesScenarioInventory,
  computeAutonomousRuntimeAffordancesScenarioDiagnostics,
  loadAutonomousRuntimeAffordancesScenarioInventory
} from "../../scripts/evidence/autonomousRuntimeAffordancesScenarioInventory";

test("autonomous runtime affordances scenario inventory passes for the current fixture", async () => {
  const inventory = await loadAutonomousRuntimeAffordancesScenarioInventory();
  const diagnostics = computeAutonomousRuntimeAffordancesScenarioDiagnostics(inventory);
  assert.equal(diagnostics.errors.length, 0);
  assert.ok(diagnostics.summary.scenarioCount >= 20);
  assert.equal(diagnostics.summary.categoryCounts.intent_engine_boundary, 2);
});

test("autonomous runtime affordances scenario inventory rejects short or pseudo-command opening prompts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "autonomy-scenarios-"));
  try {
    const fixturePath = path.join(tempDir, "fixture.json");
    await writeFile(
      fixturePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          scenarios: [
            {
              id: "natural_positive",
              category: "natural_autonomous_start",
              polarity: "positive",
              title: "Positive case",
              summary: "Positive case.",
              expectedBehavior: ["route_to_autonomous"],
              qualities: {},
              transcript: [
                {
                  speaker: "user",
                  text: "/auto do it"
                }
              ]
            },
            {
              id: "natural_negative",
              category: "natural_autonomous_start",
              polarity: "negative",
              title: "Negative case",
              summary: "Negative case.",
              expectedBehavior: ["stay_build_or_chat"],
              qualities: {},
              transcript: [
                {
                  speaker: "user",
                  text: "Please keep this as a rough sketch for now. I do not want you to keep going after that."
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
      () => assertAutonomousRuntimeAffordancesScenarioInventory(fixturePath),
      /opening user turn must be 2 to 4 sentences long|natural-language instead of slash-command/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
