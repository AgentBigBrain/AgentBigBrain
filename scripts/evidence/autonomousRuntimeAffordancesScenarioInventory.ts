/**
 * @fileoverview Loads and validates the human-centered autonomy scenario inventory.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

type ScenarioCategory =
  | "natural_autonomous_start"
  | "direct_autonomous_mode"
  | "workspace_continuity"
  | "exact_holder_recovery"
  | "ambiguous_holder_clarification"
  | "observability_clean_exit"
  | "restart_safe_resources"
  | "user_return_handoff"
  | "tool_choice_quality"
  | "intent_engine_boundary";

type ScenarioPolarity = "positive" | "negative";
type TranscriptSpeaker = "user" | "assistant";

interface ScenarioQualities {
  messyLanguage?: boolean;
  multiTurn?: boolean;
  requiresRecovery?: boolean;
  restartChurn?: boolean;
  returnLater?: boolean;
}

interface TranscriptTurn {
  speaker: TranscriptSpeaker;
  text: string;
}

interface AutonomousRuntimeAffordancesScenario {
  id: string;
  category: ScenarioCategory;
  polarity: ScenarioPolarity;
  title: string;
  summary: string;
  expectedBehavior: readonly string[];
  qualities: ScenarioQualities;
  transcript: readonly TranscriptTurn[];
}

export interface AutonomousRuntimeAffordancesScenarioInventory {
  schemaVersion: number;
  scenarios: readonly AutonomousRuntimeAffordancesScenario[];
}

interface ScenarioDiagnostic {
  scenarioId: string;
  message: string;
}

export interface AutonomousRuntimeAffordancesScenarioDiagnostics {
  errors: readonly ScenarioDiagnostic[];
  warnings: readonly ScenarioDiagnostic[];
  summary: {
    scenarioCount: number;
    categoryCounts: Record<ScenarioCategory, number>;
    polarityCounts: Record<ScenarioPolarity, number>;
    transcriptTurnCount: number;
  };
}

const WORKSPACE_ROOT = process.cwd();
const SCENARIO_FIXTURE_PATH = path.resolve(
  WORKSPACE_ROOT,
  "tests/fixtures/autonomousRuntimeAffordancesScenarios.json"
);
const CATEGORY_ORDER: readonly ScenarioCategory[] = [
  "natural_autonomous_start",
  "direct_autonomous_mode",
  "workspace_continuity",
  "exact_holder_recovery",
  "ambiguous_holder_clarification",
  "observability_clean_exit",
  "restart_safe_resources",
  "user_return_handoff",
  "tool_choice_quality",
  "intent_engine_boundary"
];
const POLARITY_ORDER: readonly ScenarioPolarity[] = ["positive", "negative"];

function countSentences(text: string): number {
  return text
    .split(/[.!?]+(?:\s+|$)/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0).length;
}

function createEmptyCategoryCounts(): Record<ScenarioCategory, number> {
  return {
    natural_autonomous_start: 0,
    direct_autonomous_mode: 0,
    workspace_continuity: 0,
    exact_holder_recovery: 0,
    ambiguous_holder_clarification: 0,
    observability_clean_exit: 0,
    restart_safe_resources: 0,
    user_return_handoff: 0,
    tool_choice_quality: 0,
    intent_engine_boundary: 0
  };
}

function createEmptyPolarityCounts(): Record<ScenarioPolarity, number> {
  return {
    positive: 0,
    negative: 0
  };
}

function isSlashCommandPrompt(text: string): boolean {
  return /^\s*\/[a-z0-9_-]+/i.test(text);
}

function isPseudoCommandPrompt(text: string): boolean {
  return /^\s*command\s+[a-z0-9_-]+/i.test(text);
}

export async function loadAutonomousRuntimeAffordancesScenarioInventory(
  fixturePath = SCENARIO_FIXTURE_PATH
): Promise<AutonomousRuntimeAffordancesScenarioInventory> {
  const raw = await readFile(fixturePath, "utf8");
  return JSON.parse(raw) as AutonomousRuntimeAffordancesScenarioInventory;
}

export function computeAutonomousRuntimeAffordancesScenarioDiagnostics(
  inventory: AutonomousRuntimeAffordancesScenarioInventory
): AutonomousRuntimeAffordancesScenarioDiagnostics {
  const errors: ScenarioDiagnostic[] = [];
  const warnings: ScenarioDiagnostic[] = [];
  const categoryCounts = createEmptyCategoryCounts();
  const polarityCounts = createEmptyPolarityCounts();
  const seenIds = new Set<string>();
  const categoryPolarityCoverage = new Map<
    ScenarioCategory,
    Set<ScenarioPolarity>
  >();
  let transcriptTurnCount = 0;

  if (inventory.schemaVersion !== 1) {
    errors.push({
      scenarioId: "__inventory__",
      message: "schemaVersion must be 1."
    });
  }

  for (const scenario of inventory.scenarios) {
    if (seenIds.has(scenario.id)) {
      errors.push({
        scenarioId: scenario.id,
        message: "scenario id must be unique."
      });
      continue;
    }
    seenIds.add(scenario.id);

    categoryCounts[scenario.category] += 1;
    polarityCounts[scenario.polarity] += 1;
    transcriptTurnCount += scenario.transcript.length;

    const coverage = categoryPolarityCoverage.get(scenario.category) ?? new Set<ScenarioPolarity>();
    coverage.add(scenario.polarity);
    categoryPolarityCoverage.set(scenario.category, coverage);

    if (scenario.expectedBehavior.length === 0) {
      errors.push({
        scenarioId: scenario.id,
        message: "expectedBehavior must include at least one claimed outcome."
      });
    }

    if (scenario.transcript.length === 0) {
      errors.push({
        scenarioId: scenario.id,
        message: "transcript must include at least one turn."
      });
      continue;
    }

    const userTurns = scenario.transcript.filter((turn) => turn.speaker === "user");
    if (userTurns.length === 0) {
      errors.push({
        scenarioId: scenario.id,
        message: "transcript must include at least one user turn."
      });
      continue;
    }

    const openingUserTurn = userTurns[0];
    const openingSentenceCount = countSentences(openingUserTurn.text);
    if (openingSentenceCount < 2 || openingSentenceCount > 4) {
      errors.push({
        scenarioId: scenario.id,
        message: "opening user turn must be 2 to 4 sentences long."
      });
    }

    if (isSlashCommandPrompt(openingUserTurn.text) || isPseudoCommandPrompt(openingUserTurn.text)) {
      errors.push({
        scenarioId: scenario.id,
        message: "opening user turn must stay natural-language instead of slash-command or pseudo-command syntax."
      });
    }

    if (openingUserTurn.text.length < 40) {
      warnings.push({
        scenarioId: scenario.id,
        message: "opening user turn is short enough that it may stop sounding human-centered."
      });
    }
  }

  for (const category of CATEGORY_ORDER) {
    const coverage = categoryPolarityCoverage.get(category);
    if (!coverage?.has("positive") || !coverage?.has("negative")) {
      errors.push({
        scenarioId: category,
        message: "each scenario category must have both a positive case and a nearby negative control."
      });
    }
  }

  return {
    errors,
    warnings,
    summary: {
      scenarioCount: inventory.scenarios.length,
      categoryCounts,
      polarityCounts,
      transcriptTurnCount
    }
  };
}

export async function assertAutonomousRuntimeAffordancesScenarioInventory(
  fixturePath = SCENARIO_FIXTURE_PATH
): Promise<AutonomousRuntimeAffordancesScenarioDiagnostics> {
  const inventory = await loadAutonomousRuntimeAffordancesScenarioInventory(fixturePath);
  const diagnostics = computeAutonomousRuntimeAffordancesScenarioDiagnostics(inventory);
  if (diagnostics.errors.length > 0) {
    const detail = diagnostics.errors
      .map((error) => `- ${error.scenarioId}: ${error.message}`)
      .join("\n");
    throw new Error(`Autonomous runtime affordances scenario inventory check failed.\n${detail}`);
  }
  return diagnostics;
}
