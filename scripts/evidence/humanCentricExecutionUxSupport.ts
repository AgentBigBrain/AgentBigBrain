/**
 * @fileoverview Shared scenario inventory contracts and validation helpers for human-centric execution UX evidence.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export type HumanCentricExecutionUxScenarioCategory =
  | "natural_intent"
  | "clarification"
  | "status_recall"
  | "capability_discovery"
  | "voice_convergence";

export type HumanCentricExecutionUxScenarioPolarity = "positive" | "negative";
export type HumanCentricExecutionUxTranscriptSpeaker = "user" | "assistant";

export interface HumanCentricExecutionUxScenarioQualities {
  messyLanguage?: boolean;
  shortMessageEdgeCase?: boolean;
}

export interface HumanCentricExecutionUxTranscriptTurn {
  speaker: HumanCentricExecutionUxTranscriptSpeaker;
  text: string;
}

export interface HumanCentricExecutionUxScenario {
  id: string;
  category: HumanCentricExecutionUxScenarioCategory;
  polarity: HumanCentricExecutionUxScenarioPolarity;
  title: string;
  summary: string;
  expectedBehavior: readonly string[];
  qualities: HumanCentricExecutionUxScenarioQualities;
  transcript: readonly HumanCentricExecutionUxTranscriptTurn[];
}

export interface HumanCentricExecutionUxScenarioInventory {
  schemaVersion: number;
  scenarios: readonly HumanCentricExecutionUxScenario[];
}

export interface HumanCentricExecutionUxScenarioDiagnostic {
  scenarioId: string;
  message: string;
}

export interface HumanCentricExecutionUxScenarioDiagnostics {
  errors: readonly HumanCentricExecutionUxScenarioDiagnostic[];
  warnings: readonly HumanCentricExecutionUxScenarioDiagnostic[];
  summary: {
    scenarioCount: number;
    categoryCounts: Record<HumanCentricExecutionUxScenarioCategory, number>;
    polarityCounts: Record<HumanCentricExecutionUxScenarioPolarity, number>;
    transcriptTurnCount: number;
  };
}

export const HUMAN_CENTRIC_EXECUTION_UX_SCENARIO_FIXTURE_PATH = path.resolve(
  process.cwd(),
  "tests/fixtures/humanCentricExecutionUxScenarios.json"
);

const CATEGORY_ORDER: readonly HumanCentricExecutionUxScenarioCategory[] = [
  "natural_intent",
  "clarification",
  "status_recall",
  "capability_discovery",
  "voice_convergence"
];

const POLARITY_ORDER: readonly HumanCentricExecutionUxScenarioPolarity[] = [
  "positive",
  "negative"
];

function countSentences(text: string): number {
  return text
    .split(/[.!?]+(?:\s+|$)/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0).length;
}

function createEmptyCategoryCounts(): Record<HumanCentricExecutionUxScenarioCategory, number> {
  return {
    natural_intent: 0,
    clarification: 0,
    status_recall: 0,
    capability_discovery: 0,
    voice_convergence: 0
  };
}

function createEmptyPolarityCounts(): Record<HumanCentricExecutionUxScenarioPolarity, number> {
  return {
    positive: 0,
    negative: 0
  };
}

/**
 * Loads the human-centric execution UX scenario inventory fixture.
 *
 * @param fixturePath - Optional fixture path override for tests.
 * @returns Parsed scenario inventory payload.
 */
export async function loadHumanCentricExecutionUxScenarioInventory(
  fixturePath: string = HUMAN_CENTRIC_EXECUTION_UX_SCENARIO_FIXTURE_PATH
): Promise<HumanCentricExecutionUxScenarioInventory> {
  const raw = await readFile(fixturePath, "utf8");
  return JSON.parse(raw) as HumanCentricExecutionUxScenarioInventory;
}

/**
 * Computes deterministic diagnostics for the scenario inventory.
 *
 * @param inventory - Parsed inventory payload.
 * @returns Validation diagnostics used by evidence scripts and tests.
 */
export function computeHumanCentricExecutionUxScenarioDiagnostics(
  inventory: HumanCentricExecutionUxScenarioInventory
): HumanCentricExecutionUxScenarioDiagnostics {
  const errors: HumanCentricExecutionUxScenarioDiagnostic[] = [];
  const warnings: HumanCentricExecutionUxScenarioDiagnostic[] = [];
  const categoryCounts = createEmptyCategoryCounts();
  const polarityCounts = createEmptyPolarityCounts();
  const seenIds = new Set<string>();

  if (inventory.schemaVersion !== 1) {
    errors.push({
      scenarioId: "inventory",
      message: `Unsupported schemaVersion ${inventory.schemaVersion}; expected 1.`
    });
  }

  if (!Array.isArray(inventory.scenarios) || inventory.scenarios.length === 0) {
    errors.push({
      scenarioId: "inventory",
      message: "Scenario inventory must include at least one scenario."
    });
  }

  for (const scenario of inventory.scenarios) {
    if (seenIds.has(scenario.id)) {
      errors.push({
        scenarioId: scenario.id,
        message: "Scenario ids must be unique."
      });
      continue;
    }
    seenIds.add(scenario.id);

    if (!CATEGORY_ORDER.includes(scenario.category)) {
      errors.push({
        scenarioId: scenario.id,
        message: `Unsupported category '${scenario.category}'.`
      });
      continue;
    }
    if (!POLARITY_ORDER.includes(scenario.polarity)) {
      errors.push({
        scenarioId: scenario.id,
        message: `Unsupported polarity '${scenario.polarity}'.`
      });
      continue;
    }

    categoryCounts[scenario.category] += 1;
    polarityCounts[scenario.polarity] += 1;

    if (!scenario.title.trim() || !scenario.summary.trim()) {
      errors.push({
        scenarioId: scenario.id,
        message: "Scenario title and summary must be non-empty."
      });
    }
    if (!Array.isArray(scenario.expectedBehavior) || scenario.expectedBehavior.length === 0) {
      errors.push({
        scenarioId: scenario.id,
        message: "Scenario expectedBehavior must include at least one behavior id."
      });
    }
    if (!Array.isArray(scenario.transcript) || scenario.transcript.length === 0) {
      errors.push({
        scenarioId: scenario.id,
        message: "Scenario transcript must include at least one turn."
      });
      continue;
    }

    const userTurns = scenario.transcript.filter((turn) => turn.speaker === "user");
    if (userTurns.length === 0) {
      errors.push({
        scenarioId: scenario.id,
        message: "Scenario transcript must include at least one user turn."
      });
    }

    for (const [index, turn] of scenario.transcript.entries()) {
      if (!turn.text.trim()) {
        errors.push({
          scenarioId: scenario.id,
          message: `Transcript turn ${index + 1} must not be empty.`
        });
        continue;
      }
      if (turn.speaker !== "user" || scenario.qualities.shortMessageEdgeCase === true) {
        continue;
      }
      const sentenceCount = countSentences(turn.text);
      if (sentenceCount < 2 || sentenceCount > 4) {
        errors.push({
          scenarioId: scenario.id,
          message:
            `User turn ${index + 1} must be 2 to 4 sentences long for realistic evidence; got ${sentenceCount}.`
        });
      }
    }
  }

  for (const category of CATEGORY_ORDER) {
    const positiveCount = inventory.scenarios.filter(
      (scenario) => scenario.category === category && scenario.polarity === "positive"
    ).length;
    const negativeCount = inventory.scenarios.filter(
      (scenario) => scenario.category === category && scenario.polarity === "negative"
    ).length;
    if (positiveCount === 0 || negativeCount === 0) {
      errors.push({
        scenarioId: category,
        message: "Each category must include at least one positive and one negative scenario."
      });
    }
  }

  if (inventory.scenarios.length < 10) {
    warnings.push({
      scenarioId: "inventory",
      message: "Scenario inventory is small; add more messy-language variants before claiming broad coverage."
    });
  }

  return {
    errors,
    warnings,
    summary: {
      scenarioCount: inventory.scenarios.length,
      categoryCounts,
      polarityCounts,
      transcriptTurnCount: inventory.scenarios.reduce(
        (total, scenario) => total + scenario.transcript.length,
        0
      )
    }
  };
}

/**
 * Fails closed when scenario inventory validation reports any errors.
 *
 * @param fixturePath - Optional fixture path override for tests.
 * @returns Validation diagnostics when the inventory passes.
 */
export async function assertHumanCentricExecutionUxScenarioInventory(
  fixturePath: string = HUMAN_CENTRIC_EXECUTION_UX_SCENARIO_FIXTURE_PATH
): Promise<HumanCentricExecutionUxScenarioDiagnostics> {
  const inventory = await loadHumanCentricExecutionUxScenarioInventory(fixturePath);
  const diagnostics = computeHumanCentricExecutionUxScenarioDiagnostics(inventory);
  if (diagnostics.errors.length === 0) {
    return diagnostics;
  }
  const detail = diagnostics.errors
    .map((diagnostic) => `${diagnostic.scenarioId}: ${diagnostic.message}`)
    .join("\n");
  throw new Error(`Human-centric execution UX scenario inventory check failed.\n${detail}`);
}

