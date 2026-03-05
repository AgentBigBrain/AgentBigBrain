/**
 * @fileoverview Runs Stage 1 validation gates, records evidence in runtime/reward_score.json, and requests reviewer sign-off without auto-awarding.
 */

import { exec as execCallback } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCallback);
const SCOREBOARD_PATH = path.resolve(process.cwd(), "runtime/reward_score.json");
const STAGE_ID = "stage_1_foundation";

interface CommandResult {
  command: string;
  ok: boolean;
  output: string;
}

interface StageCheckpoint {
  id: string;
  status: "pending" | "passed";
  passedAt: string | null;
  lastCheckedAt: string | null;
  lastPassed: boolean | null;
  lastNote: string;
}

interface StageReview {
  signOffRequired: boolean;
  signOffRequestedAt: string | null;
  signOffRequestedBy: string | null;
  decision: "pending" | "approved" | "rejected";
  signedOffAt: string | null;
  signedOffBy: string | null;
  signOffNotes: string;
}

interface StageLedger {
  id: string;
  status: "pending" | "ready_for_review" | "awarded";
  awardedAt: string | null;
  lastCheckedAt: string | null;
  lastPassed: boolean | null;
  lastNote: string;
  checkpoints: StageCheckpoint[];
  review: StageReview;
}

interface ScoreSection {
  totalStages: number;
  awardedStages: number;
  stagePercent: number;
  totalCheckpoints: number;
  passedCheckpoints: number;
  checkpointPercent: number;
}

interface RewardLedger {
  score: ScoreSection;
  stages: StageLedger[];
}

interface Stage1Evaluation {
  reproducibleBaseline: boolean;
  deterministicCore: boolean;
  stateDurability: boolean;
  failureRobustness: boolean;
  modelContractReadiness: boolean;
  runOutputs: string[];
}

/**
 * Implements `runCommand` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runCommand(command: string): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await exec(command, { cwd: process.cwd() });
    return {
      command,
      ok: true,
      output: [stdout, stderr].filter(Boolean).join("\n")
    };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    return {
      command,
      ok: false,
      output: [err.stdout ?? "", err.stderr ?? "", err.message].filter(Boolean).join("\n")
    };
  }
}

/**
 * Implements `includesAllPatterns` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function includesAllPatterns(text: string, patterns: string[]): boolean {
  const normalized = text.toLowerCase();
  return patterns.every((pattern) => normalized.includes(pattern.toLowerCase()));
}

/**
 * Implements `runStage1Validation` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runStage1Validation(): Promise<Stage1Evaluation> {
  const outputs: string[] = [];

  const runOneCommands = ["npm run build", "npm run test:stage1", "npm run check:docs"];
  const runTwoCommands = ["npm run build", "npm run test:stage1", "npm run check:docs"];

  const runOneResults: CommandResult[] = [];
  for (const command of runOneCommands) {
    const result = await runCommand(command);
    outputs.push(`[run1] ${result.command}\n${result.output}`);
    runOneResults.push(result);
    if (!result.ok) {
      break;
    }
  }

  const runTwoResults: CommandResult[] = [];
  if (runOneResults.every((result) => result.ok)) {
    for (const command of runTwoCommands) {
      const result = await runCommand(command);
      outputs.push(`[run2] ${result.command}\n${result.output}`);
      runTwoResults.push(result);
      if (!result.ok) {
        break;
      }
    }
  }

  const reproducibleBaseline =
    runOneResults.length === 3 &&
    runOneResults.every((result) => result.ok) &&
    runTwoResults.length === 3 &&
    runTwoResults.every((result) => result.ok);

  const testOutput =
    runOneResults.find((result) => result.command === "npm run test:stage1")?.output ?? "";
  const secondTestOutput =
    runTwoResults.find((result) => result.command === "npm run test:stage1")?.output ?? "";

  const deterministicCore =
    reproducibleBaseline &&
    includesAllPatterns(testOutput, [
      "orchestrator approves fast-path response task",
      "MasterGovernor approves when yes votes meet threshold"
    ]) &&
    includesAllPatterns(secondTestOutput, [
      "orchestrator approves fast-path response task",
      "MasterGovernor approves when yes votes meet threshold"
    ]);

  const stateDurability = includesAllPatterns(testOutput, [
    "StateStore persists runs and metrics across reload",
    "StateStore recovers from corrupted JSON by returning initial state"
  ]);

  const failureRobustness = includesAllPatterns(testOutput, [
    "orchestrator blocks unsafe delete request",
    "orchestrator blocks immutable governor self-edit",
    "orchestrator blocks unsafe create_skill code via code review preflight"
  ]);

  const modelContractReadiness = includesAllPatterns(testOutput, [
    "createModelClientFromEnv throws when openai key is missing",
    "createModelClientFromEnv returns openai backend when key exists",
    "OpenAIModelClient parses direct JSON content",
    "OpenAIModelClient propagates provider error message on non-ok status"
  ]);

  return {
    reproducibleBaseline,
    deterministicCore,
    stateDurability,
    failureRobustness,
    modelContractReadiness,
    runOutputs: outputs
  };
}

/**
 * Implements `stripUtf8Bom` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function stripUtf8Bom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

/**
 * Implements `toPercent` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function toPercent(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Number(((numerator / denominator) * 100).toFixed(2));
}

/**
 * Implements `recomputeScore` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function recomputeScore(ledger: RewardLedger): void {
  const totalStages = ledger.stages.length;
  const awardedStages = ledger.stages.filter((stage) => stage.status === "awarded").length;
  const totalCheckpoints = ledger.stages.reduce(
    (sum, stage) => sum + stage.checkpoints.length,
    0
  );
  const passedCheckpoints = ledger.stages.reduce(
    (sum, stage) => sum + stage.checkpoints.filter((checkpoint) => checkpoint.status === "passed").length,
    0
  );

  ledger.score = {
    totalStages,
    awardedStages,
    stagePercent: toPercent(awardedStages, totalStages),
    totalCheckpoints,
    passedCheckpoints,
    checkpointPercent: toPercent(passedCheckpoints, totalCheckpoints)
  };
}

/**
 * Implements `applyCheckpointResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function applyCheckpointResult(
  checkpoint: StageCheckpoint,
  passed: boolean,
  note: string,
  now: string
): void {
  checkpoint.lastCheckedAt = now;
  checkpoint.lastPassed = passed;
  checkpoint.lastNote = note;
  if (passed) {
    checkpoint.status = "passed";
    checkpoint.passedAt ??= now;
    return;
  }

  checkpoint.status = "pending";
}

/**
 * Implements `updateStageOne` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function updateStageOne(stage: StageLedger, evaluation: Stage1Evaluation): void {
  const now = new Date().toISOString();
  const checkpointMap: Record<string, { passed: boolean; note: string }> = {
    "1.1": {
      passed: evaluation.reproducibleBaseline,
      note: evaluation.reproducibleBaseline
        ? "Build/test/docs checks passed twice consecutively."
        : "Failed to pass build/test/docs checks twice consecutively."
    },
    "1.2": {
      passed: evaluation.deterministicCore,
      note: evaluation.deterministicCore
        ? "Deterministic core behavior observed across repeated stage1 test runs."
        : "Deterministic core behavior evidence missing from repeated stage1 test runs."
    },
    "1.3": {
      passed: evaluation.stateDurability,
      note: evaluation.stateDurability
        ? "State durability tests passed (persistence + corrupted-file recovery)."
        : "State durability test evidence missing."
    },
    "1.4": {
      passed: evaluation.failureRobustness,
      note: evaluation.failureRobustness
        ? "Failure-path robustness tests passed for unsafe/blocking scenarios."
        : "Failure-path robustness test evidence missing."
    },
    "1.5": {
      passed: evaluation.modelContractReadiness,
      note: evaluation.modelContractReadiness
        ? "Model contract readiness tests passed for backend selection and OpenAI parsing/error paths."
        : "Model contract readiness evidence missing."
    }
  };

  for (const checkpoint of stage.checkpoints) {
    const record = checkpointMap[checkpoint.id];
    if (!record) {
      continue;
    }

    applyCheckpointResult(checkpoint, record.passed, record.note, now);
  }

  const allPassed = stage.checkpoints.every((checkpoint) => checkpoint.status === "passed");
  stage.lastCheckedAt = now;
  stage.lastPassed = allPassed;
  stage.status = allPassed ? "ready_for_review" : "pending";
  stage.lastNote = allPassed
    ? "All Stage 1 checkpoints passed. Awaiting final reviewer sign-off."
    : "Stage 1 checkpoint evidence incomplete. See checkpoint notes.";

  stage.review.signOffRequired = true;
  stage.review.decision = "pending";
  stage.review.signOffRequestedAt = allPassed ? now : null;
  stage.review.signOffRequestedBy = allPassed ? "codex" : null;
  stage.review.signedOffAt = null;
  stage.review.signedOffBy = null;
  stage.review.signOffNotes = allPassed
    ? "Stage 1 evidence prepared. Awaiting final reviewer decision."
    : "Stage 1 still pending checkpoint completion.";
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const rawLedger = await readFile(SCOREBOARD_PATH, "utf8");
  const ledger = JSON.parse(stripUtf8Bom(rawLedger)) as RewardLedger;
  const stage = ledger.stages.find((item) => item.id === STAGE_ID);
  if (!stage) {
    throw new Error(`Stage ${STAGE_ID} was not found in ${SCOREBOARD_PATH}.`);
  }

  const evaluation = await runStage1Validation();
  updateStageOne(stage, evaluation);
  recomputeScore(ledger);

  await writeFile(SCOREBOARD_PATH, JSON.stringify(ledger, null, 2), "utf8");

  console.log(`Stage 1 reproducible baseline: ${evaluation.reproducibleBaseline ? "PASS" : "FAIL"}`);
  console.log(`Stage 1 deterministic core: ${evaluation.deterministicCore ? "PASS" : "FAIL"}`);
  console.log(`Stage 1 state durability: ${evaluation.stateDurability ? "PASS" : "FAIL"}`);
  console.log(`Stage 1 failure robustness: ${evaluation.failureRobustness ? "PASS" : "FAIL"}`);
  console.log(`Stage 1 model contract readiness: ${evaluation.modelContractReadiness ? "PASS" : "FAIL"}`);
  console.log(`Stage ledger updated: ${SCOREBOARD_PATH}`);
}

void main();
