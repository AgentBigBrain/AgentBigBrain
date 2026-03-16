/**
 * @fileoverview Emits the deterministic transcript-style autonomy evidence report.
 */

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  computeAutonomousRuntimeAffordancesScenarioDiagnostics,
  loadAutonomousRuntimeAffordancesScenarioInventory
} from "./autonomousRuntimeAffordancesScenarioInventory";

type ArtifactStatus = "PASS" | "FAIL";

interface TranscriptTurn {
  speaker: string;
  text: string;
}

interface ScenarioReportEntry {
  id: string;
  title: string;
  summary: string;
  openingUserPrompt: string;
  transcript: readonly TranscriptTurn[];
  expectedOutcomeClass: readonly string[];
}

interface CategoryEvidenceEntry {
  category: string;
  positiveScenario: ScenarioReportEntry;
  negativeControl: ScenarioReportEntry;
}

export interface AutonomousRuntimeAffordancesEvidenceArtifact {
  generatedAt: string;
  command: string;
  status: ArtifactStatus;
  checks: {
    categoryCoverageComplete: boolean;
    positiveNegativeCoveragePerCategory: boolean;
    transcriptsRemainHumanCentered: boolean;
    outcomeClassesRendered: boolean;
  };
  diagnostics: {
    scenarioCount: number;
    transcriptTurnCount: number;
    categoryCounts: Record<string, number>;
    polarityCounts: Record<string, number>;
    warningCount: number;
  };
  categories: readonly CategoryEvidenceEntry[];
}

const COMMAND_NAME = "tsx scripts/evidence/autonomousRuntimeAffordancesEvidence.ts";
const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/autonomous_runtime_affordances_report.json"
);

function buildScenarioReportEntry(scenario: {
  id: string;
  title: string;
  summary: string;
  transcript: readonly { speaker: string; text: string }[];
  expectedBehavior: readonly string[];
}): ScenarioReportEntry {
  const openingUserPrompt =
    scenario.transcript.find((turn) => turn.speaker === "user")?.text ?? "";
  return {
    id: scenario.id,
    title: scenario.title,
    summary: scenario.summary,
    openingUserPrompt,
    transcript: scenario.transcript.map((turn) => ({
      speaker: turn.speaker,
      text: turn.text
    })),
    expectedOutcomeClass: scenario.expectedBehavior
  };
}

export async function runAutonomousRuntimeAffordancesEvidence():
Promise<AutonomousRuntimeAffordancesEvidenceArtifact> {
  const inventory = await loadAutonomousRuntimeAffordancesScenarioInventory();
  const diagnostics = computeAutonomousRuntimeAffordancesScenarioDiagnostics(inventory);
  const categories = [...new Set(inventory.scenarios.map((scenario) => scenario.category))]
    .sort((left, right) => left.localeCompare(right))
    .map((category) => {
      const positiveScenario = inventory.scenarios.find(
        (scenario) => scenario.category === category && scenario.polarity === "positive"
      );
      const negativeScenario = inventory.scenarios.find(
        (scenario) => scenario.category === category && scenario.polarity === "negative"
      );
      if (!positiveScenario || !negativeScenario) {
        throw new Error(`Missing paired positive/negative scenarios for category ${category}.`);
      }
      return {
        category,
        positiveScenario: buildScenarioReportEntry(positiveScenario),
        negativeControl: buildScenarioReportEntry(negativeScenario)
      };
    });

  const checks = {
    categoryCoverageComplete: categories.length > 0 &&
      categories.length === Object.keys(diagnostics.summary.categoryCounts).length,
    positiveNegativeCoveragePerCategory: categories.every(
      (category) =>
        category.positiveScenario.expectedOutcomeClass.length > 0 &&
        category.negativeControl.expectedOutcomeClass.length > 0
    ),
    transcriptsRemainHumanCentered:
      diagnostics.errors.length === 0 &&
      categories.every(
        (category) =>
          category.positiveScenario.openingUserPrompt.length >= 40 &&
          category.negativeControl.openingUserPrompt.length >= 40
      ),
    outcomeClassesRendered: categories.every(
      (category) =>
        category.positiveScenario.expectedOutcomeClass.length > 0 &&
        category.negativeControl.expectedOutcomeClass.length > 0
    )
  };

  const artifact: AutonomousRuntimeAffordancesEvidenceArtifact = {
    generatedAt: new Date().toISOString(),
    command: COMMAND_NAME,
    status:
      diagnostics.errors.length === 0 && Object.values(checks).every(Boolean)
        ? "PASS"
        : "FAIL",
    checks,
    diagnostics: {
      scenarioCount: diagnostics.summary.scenarioCount,
      transcriptTurnCount: diagnostics.summary.transcriptTurnCount,
      categoryCounts: diagnostics.summary.categoryCounts,
      polarityCounts: diagnostics.summary.polarityCounts,
      warningCount: diagnostics.warnings.length
    },
    categories
  };

  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}${os.EOL}`, "utf8");
  return artifact;
}

async function main(): Promise<void> {
  const artifact = await runAutonomousRuntimeAffordancesEvidence();
  console.log(`Autonomous runtime affordances evidence status: ${artifact.status}`);
  console.log(`Artifact: ${ARTIFACT_PATH}`);
  if (artifact.status === "FAIL") {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
