/**
 * @fileoverview Runs Stage 3 governance validation, updates checkpoint evidence, and writes reviewer artifacts.
 */

import { exec as execCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCallback);
const SCOREBOARD_PATH = path.resolve(process.cwd(), "runtime/reward_score.json");
const EVIDENCE_REPORT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage3_evidence.md");
const BOUNDARY_MATRIX_PATH = path.resolve(process.cwd(), "runtime/evidence/stage3_boundary_matrix.md");
const DEGRADED_NOTES_PATH = path.resolve(process.cwd(), "runtime/evidence/stage3_degraded_notes.md");
const OVERRIDE_TRACE_PATH = path.resolve(process.cwd(), "runtime/evidence/stage3_override_trace.md");
const REGRESSION_GUARD_PATH = path.resolve(process.cwd(), "runtime/evidence/stage3_regression_guard.md");
const STAGE_ID = "stage_3_governance";

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

interface Stage3Evaluation {
  commandOk: boolean;
  checkpoint31: boolean;
  checkpoint32: boolean;
  checkpoint33Ready: boolean;
  checkpoint34Ready: boolean;
  checkpoint35Ready: boolean;
  rawOutput: string;
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
 * Implements `stripUtf8Bom` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function stripUtf8Bom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

/**
 * Implements `runStage3Validation` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runStage3Validation(): Promise<Stage3Evaluation> {
  const result = await runCommand("npm run test:stage3");
  const output = result.output;

  const checkpoint31 =
    result.ok &&
    includesAllPatterns(output, [
      "MasterGovernor rejects when yes votes are below threshold",
      "MasterGovernor approves when yes votes meet threshold",
      "MasterGovernor approves when all 7 governors approve"
    ]);

  const checkpoint32 =
    result.ok &&
    includesAllPatterns(output, [
      "dissent votes are persisted with reason and confidence when council rejects"
    ]);

  const checkpoint33Ready =
    result.ok &&
    includesAllPatterns(output, [
      "runCouncilVote applies timeout fallback vote",
      "runCouncilVote applies malformed-vote fallback",
      "runCouncilVote fails safe when expected governor is missing"
    ]);

  const checkpoint34Ready =
    result.ok &&
    includesAllPatterns(output, [
      "override requests route through escalation council with traceable vote metadata"
    ]);

  const checkpoint35Ready =
    result.ok &&
    includesAllPatterns(output, [
      "runCouncilVote preserves approvals when all expected governors respond safely",
      "MasterGovernor rejects when yes votes are below threshold"
    ]);

  return {
    commandOk: result.ok,
    checkpoint31,
    checkpoint32,
    checkpoint33Ready,
    checkpoint34Ready,
    checkpoint35Ready,
    rawOutput: output
  };
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
  const totalCheckpoints = ledger.stages.reduce((sum, stage) => sum + stage.checkpoints.length, 0);
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
 * Implements `updateStageThree` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function updateStageThree(stage: StageLedger, evaluation: Stage3Evaluation): void {
  const now = new Date().toISOString();
  const isManualCheckpoint = (id: string): boolean => id === "3.3" || id === "3.4" || id === "3.5";
  const isAlreadyReviewerApproved = stage.status === "awarded" && stage.review.decision === "approved";
  const checkpointMap: Record<string, { passed: boolean; note: string }> = {
    "3.1": {
      passed: evaluation.checkpoint31,
      note: evaluation.checkpoint31
        ? "6/7 boundary tests passed for 5/7 reject, 6/7 approve, and 7/7 approve."
        : "Boundary test evidence incomplete."
    },
    "3.2": {
      passed: evaluation.checkpoint32,
      note: evaluation.checkpoint32
        ? "Dissent persistence test passed with reason/confidence assertions."
        : "Dissent auditability evidence incomplete."
    },
    "3.3": {
      passed: false,
      note: evaluation.checkpoint33Ready
        ? "Degraded-governor evidence is present (runtime/evidence/stage3_degraded_notes.md); awaiting manual reviewer sign-off."
        : "Degraded-governor evidence incomplete; add timeout/malformed/missing-governor coverage."
    },
    "3.4": {
      passed: false,
      note: evaluation.checkpoint34Ready
        ? "Override trace evidence is present (runtime/evidence/stage3_override_trace.md); awaiting manual reviewer sign-off."
        : "Override-trace evidence incomplete."
    },
    "3.5": {
      passed: false,
      note: evaluation.checkpoint35Ready
        ? "Governance regression-guard evidence is present (runtime/evidence/stage3_regression_guard.md); awaiting manual reviewer sign-off."
        : "Regression-guard evidence incomplete."
    }
  };

  for (const checkpoint of stage.checkpoints) {
    const record = checkpointMap[checkpoint.id];
    if (!record) {
      continue;
    }
    if (isAlreadyReviewerApproved && isManualCheckpoint(checkpoint.id) && checkpoint.status === "passed") {
      applyCheckpointResult(checkpoint, true, checkpoint.lastNote, now);
      continue;
    }
    applyCheckpointResult(checkpoint, record.passed, record.note, now);
  }

  const allPassed = stage.checkpoints.every((checkpoint) => checkpoint.status === "passed");
  if (isAlreadyReviewerApproved && allPassed) {
    stage.lastCheckedAt = now;
    stage.lastPassed = true;
    return;
  }

  stage.lastCheckedAt = now;
  stage.lastPassed = allPassed;
  stage.status = allPassed ? "ready_for_review" : "pending";
  stage.lastNote = allPassed
    ? "All Stage 3 checkpoints passed. Awaiting final reviewer sign-off."
    : "Stage 3 in progress. Automated checkpoints updated; manual checkpoints still require reviewer evidence.";

  stage.review.signOffRequired = true;
  stage.review.decision = "pending";
  stage.review.signOffRequestedAt = allPassed ? now : null;
  stage.review.signOffRequestedBy = allPassed ? "codex" : null;
  stage.review.signedOffAt = null;
  stage.review.signedOffBy = null;
  stage.review.signOffNotes = allPassed
    ? "Stage 3 evidence prepared. Awaiting final reviewer decision."
    : "Stage 3 evidence updated. Manual checkpoint review still pending.";
}

/**
 * Implements `renderBoundaryMatrix` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderBoundaryMatrix(generatedAt: string): string {
  return [
    "# Stage 3 Boundary Matrix",
    "",
    `- Generated At: ${generatedAt}`,
    "",
    "| Boundary Case | Expected Outcome | Covered Test |",
    "| --- | --- | --- |",
    "| 5/7 approvals | reject | `MasterGovernor rejects when yes votes are below threshold` |",
    "| 6/7 approvals | approve | `MasterGovernor approves when yes votes meet threshold` |",
    "| 7/7 approvals | approve | `MasterGovernor approves when all 7 governors approve` |",
    ""
  ].join("\n");
}

/**
 * Implements `renderDegradedNotes` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderDegradedNotes(generatedAt: string): string {
  return [
    "# Stage 3 Degraded Governor Notes",
    "",
    `- Generated At: ${generatedAt}`,
    "",
    "## Objective",
    "Validate governance failure scenarios fail safe with explicit negative votes.",
    "",
    "## Scenarios",
    "1. Governor timeout fallback.",
    "2. Governor malformed vote payload fallback.",
    "3. Missing governor in expected council set forces fail-safe decision.",
    "",
    "## Covered Tests",
    "1. `runCouncilVote applies timeout fallback vote`",
    "2. `runCouncilVote applies malformed-vote fallback`",
    "3. `runCouncilVote fails safe when expected governor is missing`",
    ""
  ].join("\n");
}

/**
 * Implements `renderOverrideTrace` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderOverrideTrace(generatedAt: string): string {
  return [
    "# Stage 3 Override Trace Notes",
    "",
    `- Generated At: ${generatedAt}`,
    "",
    "## Objective",
    "Verify override-like self-modification requests cannot bypass escalation council voting.",
    "",
    "## Covered Tests",
    "1. `override requests route through escalation council with traceable vote metadata`",
    "2. `dissent votes are persisted with reason and confidence when council rejects`",
    "",
    "## Assertions",
    "1. Self-modify action runs in escalation path.",
    "2. Council decision metadata is present (threshold, votes, dissent).",
    "3. Dissent entries include reason and confidence fields.",
    ""
  ].join("\n");
}

/**
 * Implements `renderRegressionGuard` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderRegressionGuard(generatedAt: string): string {
  return [
    "# Stage 3 Governance Regression Guard",
    "",
    `- Generated At: ${generatedAt}`,
    "",
    "## Required Command",
    "1. `npm run test:stage3`",
    "",
    "## Guard Intent",
    "Ensure governance boundary and degraded-mode tests run together before approving governor logic changes.",
    "",
    "## Included Suites",
    "1. `src/governors/masterGovernor.test.ts`",
    "2. `src/governors/voteGate.test.ts`",
    "3. `src/core/stage3Governance.test.ts`",
    ""
  ].join("\n");
}

/**
 * Implements `renderEvidenceReport` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderEvidenceReport(evaluation: Stage3Evaluation, generatedAt: string): string {
  return [
    "# Stage 3 Evidence Report",
    "",
    `- Generated At: ${generatedAt}`,
    `- Command: \`npm run test:stage3\``,
    `- Command Status: ${evaluation.commandOk ? "PASS" : "FAIL"}`,
    "",
    "## Automated Checkpoint Summary",
    "",
    `- 3.1 6/7 Boundary Correctness: ${evaluation.checkpoint31 ? "PASS" : "FAIL"}`,
    `- 3.2 Dissent Auditability: ${evaluation.checkpoint32 ? "PASS" : "FAIL"}`,
    "",
    "## Manual-Evidence Readiness Signals",
    "",
    `- 3.3 Governor-Failure Handling evidence present: ${evaluation.checkpoint33Ready ? "YES" : "NO"}`,
    `- 3.4 Override Integrity evidence present: ${evaluation.checkpoint34Ready ? "YES" : "NO"}`,
    `- 3.5 Governance Regression Guard evidence present: ${evaluation.checkpoint35Ready ? "YES" : "NO"}`,
    "",
    "## Test Procedures (Objective, Setup, Steps, Assertions)",
    "",
    "1. Boundary correctness suite (`MasterGovernor ... threshold`)",
    "- Objective: verify 5/7, 6/7, and 7/7 outcomes match policy.",
    "- Setup: deterministic `MasterGovernor(6)` vote arrays.",
    "- Steps: evaluate boundary vote distributions.",
    "- Assertions: 5 yes rejects; 6 yes approves; 7 yes approves.",
    "",
    "2. Dissent auditability suite (`dissent votes are persisted ...`)",
    "- Objective: ensure dissent is recorded with reason and confidence.",
    "- Setup: orchestrator run with self-modification request that council rejects.",
    "- Steps: execute task through planner/governors and inspect decision trace.",
    "- Assertions: dissent entries exist and include reason/confidence fields.",
    "",
    "3. Degraded-mode suite (`runCouncilVote ... fallback`)",
    "- Objective: fail safe on timeout, malformed vote, and missing governor.",
    "- Setup: custom governor stubs and expected-council list.",
    "- Steps: invoke `runCouncilVote` with degraded scenarios.",
    "- Assertions: degraded cases produce explicit blocking votes and do not silently approve.",
    "",
    "## Artifact Files",
    "",
    `1. \`${path.relative(process.cwd(), BOUNDARY_MATRIX_PATH)}\``,
    `2. \`${path.relative(process.cwd(), DEGRADED_NOTES_PATH)}\``,
    `3. \`${path.relative(process.cwd(), OVERRIDE_TRACE_PATH)}\``,
    `4. \`${path.relative(process.cwd(), REGRESSION_GUARD_PATH)}\``,
    "",
    "## Raw Test Output",
    "",
    "```text",
    evaluation.rawOutput.trim(),
    "```",
    ""
  ].join("\n");
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

  const evaluation = await runStage3Validation();
  updateStageThree(stage, evaluation);
  recomputeScore(ledger);

  const generatedAt = new Date().toISOString();
  await writeFile(SCOREBOARD_PATH, JSON.stringify(ledger, null, 2), "utf8");
  await mkdir(path.dirname(EVIDENCE_REPORT_PATH), { recursive: true });
  await writeFile(EVIDENCE_REPORT_PATH, renderEvidenceReport(evaluation, generatedAt), "utf8");
  await writeFile(BOUNDARY_MATRIX_PATH, renderBoundaryMatrix(generatedAt), "utf8");
  await writeFile(DEGRADED_NOTES_PATH, renderDegradedNotes(generatedAt), "utf8");
  await writeFile(OVERRIDE_TRACE_PATH, renderOverrideTrace(generatedAt), "utf8");
  await writeFile(REGRESSION_GUARD_PATH, renderRegressionGuard(generatedAt), "utf8");

  console.log(`Stage 3 checkpoint 3.1: ${evaluation.checkpoint31 ? "PASS" : "FAIL"}`);
  console.log(`Stage 3 checkpoint 3.2: ${evaluation.checkpoint32 ? "PASS" : "FAIL"}`);
  console.log(`Stage 3 manual readiness 3.3: ${evaluation.checkpoint33Ready ? "READY" : "NOT_READY"}`);
  console.log(`Stage 3 manual readiness 3.4: ${evaluation.checkpoint34Ready ? "READY" : "NOT_READY"}`);
  console.log(`Stage 3 manual readiness 3.5: ${evaluation.checkpoint35Ready ? "READY" : "NOT_READY"}`);
  console.log(`Stage ledger updated: ${SCOREBOARD_PATH}`);
  console.log(`Evidence report: ${EVIDENCE_REPORT_PATH}`);
}

void main();
