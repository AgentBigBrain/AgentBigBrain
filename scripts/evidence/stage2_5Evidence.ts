/**
 * @fileoverview Runs Stage 2.5 runtime-path validation, updates checkpoint evidence, and emits manual-review artifacts.
 */

import { exec as execCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { TEST_REVIEWER_HANDLE } from "../../tests/support/windowsPathFixtures";

const exec = promisify(execCallback);
const STAGE_ID = "stage_2_5_user_protected_paths";
const SCOREBOARD_PATH = path.resolve(process.cwd(), "runtime/reward_score.json");
const EVIDENCE_REPORT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage2_5_evidence.md");
const MANUAL_READINESS_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage2_5_manual_readiness.md"
);
const LIVE_REVIEW_CHECKLIST_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage2_5_live_review_checklist.md"
);

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

interface Stage25Evaluation {
  commandOk: boolean;
  checkpoint251: boolean;
  checkpoint252: boolean;
  checkpoint253Ready: boolean;
  checkpoint254Ready: boolean;
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
 * Implements `runStage25Validation` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runStage25Validation(): Promise<Stage25Evaluation> {
  const result = await runCommand("npm run test:stage2_5");
  const output = result.output;

  const checkpoint251 =
    result.ok &&
    includesAllPatterns(output, [
      "stage 2.5 user protection policy surface parses deterministic owner declarations and fails closed on invalid input"
    ]);
  const checkpoint252 =
    result.ok &&
    includesAllPatterns(output, [
      "stage 2.5 runtime enforcement blocks user-protected paths for read/write/delete/list actions",
      "stage 2.5 runtime enforcement blocks path-targeting shell variants that touch user-protected paths"
    ]);
  const checkpoint253Ready =
    result.ok &&
    includesAllPatterns(output, [
      "stage 2.5 canonical path anti-bypass blocks traversal, separator/case, relative, and drive-letter variants"
    ]);
  const checkpoint254Ready =
    result.ok &&
    includesAllPatterns(output, [
      "stage 2.5 full-access parity keeps user-protected paths blocked"
    ]);

  return {
    commandOk: result.ok,
    checkpoint251,
    checkpoint252,
    checkpoint253Ready,
    checkpoint254Ready,
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
 * Implements `updateStage25` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function updateStage25(stage: StageLedger, evaluation: Stage25Evaluation): void {
  const now = new Date().toISOString();
  const manualCheckpointIds = new Set(["2.5.3", "2.5.4"]);
  const isManualCheckpoint = (id: string): boolean => manualCheckpointIds.has(id);
  const manualReadinessComplete = evaluation.checkpoint253Ready && evaluation.checkpoint254Ready;
  const isAlreadyReviewerApproved = stage.status === "awarded" && stage.review.decision === "approved";
  const checkpointMap: Record<string, { passed: boolean; note: string }> = {
    "2.5.1": {
      passed: evaluation.checkpoint251,
      note: evaluation.checkpoint251
        ? "Owner-protected path policy surface is deterministic and fail-closed under invalid declarations."
        : "Policy-surface evidence incomplete for owner-protected path configuration parsing."
    },
    "2.5.2": {
      passed: evaluation.checkpoint252,
      note: evaluation.checkpoint252
        ? "Runtime enforcement blocks user-protected paths across file actions and path-targeting shell variants."
        : "Runtime enforcement evidence incomplete for one or more protected-path action types."
    },
    "2.5.3": {
      passed: false,
      note: evaluation.checkpoint253Ready
        ? "Canonical anti-bypass evidence is present (traversal/case/separator/relative/drive-letter variants); awaiting manual reviewer sign-off."
        : "Canonical anti-bypass evidence incomplete for traversal/case/separator/relative/drive-letter variants."
    },
    "2.5.4": {
      passed: false,
      note: evaluation.checkpoint254Ready
        ? "Full-access parity evidence is present; awaiting manual reviewer sign-off."
        : "Full-access parity evidence incomplete."
    }
  };

  for (const checkpoint of stage.checkpoints) {
    const record = checkpointMap[checkpoint.id];
    if (!record) {
      continue;
    }

    if (isManualCheckpoint(checkpoint.id) && checkpoint.status === "passed") {
      applyCheckpointResult(checkpoint, true, checkpoint.lastNote || record.note, now);
      continue;
    }

    applyCheckpointResult(checkpoint, record.passed, record.note, now);
  }

  const allPassed = stage.checkpoints.every((checkpoint) => checkpoint.status === "passed");
  const manualPassedCount = stage.checkpoints.filter(
    (checkpoint) => manualCheckpointIds.has(checkpoint.id) && checkpoint.status === "passed"
  ).length;
  const hasPartialManualSignOff =
    manualPassedCount > 0 && manualPassedCount < manualCheckpointIds.size;

  if (isAlreadyReviewerApproved && allPassed) {
    stage.lastCheckedAt = now;
    stage.lastPassed = true;
    return;
  }

  stage.lastCheckedAt = now;
  stage.lastPassed = allPassed;
  stage.status = allPassed ? "ready_for_review" : "pending";
  stage.lastNote = allPassed
    ? "All Stage 2.5 checkpoints passed. Awaiting final reviewer sign-off."
    : hasPartialManualSignOff
      ? `Stage 2.5 partial manual sign-off recorded (${manualPassedCount}/${manualCheckpointIds.size} manual checkpoints approved); awaiting remaining manual approvals.`
      : manualReadinessComplete
        ? "Stage 2.5 evidence-ready for manual reviewer sign-off."
        : "Stage 2.5 in progress. Manual anti-bypass/full-access-parity evidence requires reviewer execution.";

  stage.review.signOffRequired = true;
  stage.review.decision = "pending";
  stage.review.signOffRequestedAt = allPassed || manualReadinessComplete ? now : null;
  stage.review.signOffRequestedBy = allPassed || manualReadinessComplete ? "codex" : null;
  stage.review.signedOffAt = null;
  stage.review.signedOffBy = null;
  stage.review.signOffNotes = allPassed
    ? "Stage 2.5 evidence prepared. Awaiting final reviewer decision."
    : hasPartialManualSignOff
      ? `Partial manual sign-off recorded (${manualPassedCount}/${manualCheckpointIds.size} manual checkpoints approved). Awaiting remaining decisions and final reviewer sign-off.`
      : manualReadinessComplete
        ? "Stage 2.5 manual checkpoint evidence is ready. Awaiting reviewer sign-off."
        : "Stage 2.5 manual anti-bypass/full-access-parity evidence still requires reviewer execution.";
}

/**
 * Implements `renderManualReadiness` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderManualReadiness(evaluation: Stage25Evaluation, generatedAt: string): string {
  return [
    "# Stage 2.5 Manual Checkpoint Readiness",
    "",
    `- Generated At: ${generatedAt}`,
    "",
    `- 2.5.3 Canonical Path Anti-Bypass evidence present: ${evaluation.checkpoint253Ready ? "YES" : "NO"}`,
    `- 2.5.4 Full-Access Parity evidence present: ${evaluation.checkpoint254Ready ? "YES" : "NO"}`,
    "",
    "These remain manual-signoff checkpoints in the reviewer-gated reward policy.",
    ""
  ].join("\n");
}

/**
 * Implements `renderLiveReviewChecklist` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderLiveReviewChecklist(generatedAt: string): string {
  return [
    "# Stage 2.5 Live Review Checklist",
    "",
    `- Generated At: ${generatedAt}`,
    `- Stage: \`${STAGE_ID}\``,
    `- Reviewer: \`${TEST_REVIEWER_HANDLE}\``,
    "- Goal: validate anti-bypass and full-access parity on real runtime behavior.",
    "",
    "## Automated Preflight (Already Run)",
    "",
    "1. `npm run test:stage2_5:evidence`",
    "2. `npm run test:stage2_5`",
    "",
    "Artifacts:",
    "1. `runtime/evidence/stage2_5_evidence.md`",
    "2. `runtime/evidence/stage2_5_manual_readiness.md`",
    "3. `runtime/reward_score.json`",
    "",
    "## Checkpoint 2.5.3 - Canonical Path Anti-Bypass",
    "",
    "Objective: prove traversal/case/separator/relative and drive-letter variants cannot bypass protected-path boundaries.",
    "",
    "Boundary evidence:",
    "1. `runtime/evidence/stage2_5_evidence.md` (Stage 2.5 anti-bypass runtime-path tests).",
    "",
    "Live procedure:",
    "1. Configure protected paths and start runtime:",
    "   ```powershell",
    "   $env:BRAIN_USER_PROTECTED_PATHS=\"runtime/user_protected;memory\"",
    "   npm run dev -- \"list runtime/user_protected\"",
    "   ```",
    "2. Attempt traversal variant:",
    "   ```powershell",
    "   npm run dev -- \"read runtime/sandbox/../user_protected/secret.txt\"",
    "   ```",
    "3. Attempt case/separator variant:",
    "   ```powershell",
    "   npm run dev -- \"read RuNtImE\\\\UsEr_PrOtEcTeD\\\\secret.txt\"",
    "   ```",
    "4. Attempt relative variant:",
    "   ```powershell",
    "   npm run dev -- \"read ./runtime/user_protected/secret.txt\"",
    "   ```",
    "5. On Windows, optionally verify drive-letter case variant using absolute path casing differences.",
    "",
    "Expected pass criteria:",
    "1. Protected-path operations are blocked across variant forms.",
    "2. Violation output includes protected-path block codes (no bypass execution).",
    "",
    "## Checkpoint 2.5.4 - Full-Access Parity",
    "",
    "Objective: prove user-protected paths remain blocked in `full_access` mode.",
    "",
    "Live procedure:",
    "1. Enable full access explicitly:",
    "   ```powershell",
    "   $env:BRAIN_RUNTIME_MODE=\"full_access\"",
    "   $env:BRAIN_ALLOW_FULL_ACCESS=\"true\"",
    "   $env:BRAIN_USER_PROTECTED_PATHS=\"runtime/user_protected;memory\"",
    "   ```",
    "2. Run protected read/list/delete/write ask(s):",
    "   ```powershell",
    "   npm run dev -- \"read runtime/user_protected/secret.txt\"",
    "   npm run dev -- \"list runtime/user_protected\"",
    "   ```",
    "3. Run shell path-target variant:",
    "   ```powershell",
    "   npm run dev -- \"run shell command: type runtime/user_protected/secret.txt\"",
    "   ```",
    "",
    "Expected pass criteria:",
    "1. Protected-path actions remain blocked in full access mode.",
    "2. No runtime-profile switch silently downgrades owner-protected boundaries.",
    "",
    "## Sign-Off Template",
    "",
    "1. `2.5.1`: PASS/FAIL - rationale:",
    "2. `2.5.2`: PASS/FAIL - rationale:",
    "3. `2.5.3`: PASS/FAIL - rationale:",
    "4. `2.5.4`: PASS/FAIL - rationale:",
    "5. Final stage decision: `approved` / `rejected`",
    `6. Signed off by: \`${TEST_REVIEWER_HANDLE}\``,
    "7. Signed off at (ISO): `<timestamp>`",
    ""
  ].join("\n");
}

/**
 * Implements `renderEvidenceReport` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderEvidenceReport(evaluation: Stage25Evaluation, generatedAt: string): string {
  return [
    "# Stage 2.5 Evidence Report",
    "",
    `- Generated At: ${generatedAt}`,
    "- Command: `npm run test:stage2_5`",
    `- Command Status: ${evaluation.commandOk ? "PASS" : "FAIL"}`,
    "",
    "## Automated Checkpoint Summary",
    "",
    `- 2.5.1 User Protection Policy Surface: ${evaluation.checkpoint251 ? "PASS" : "FAIL"}`,
    `- 2.5.2 Runtime Enforcement Coverage: ${evaluation.checkpoint252 ? "PASS" : "FAIL"}`,
    "",
    "## Manual-Evidence Readiness Signals",
    "",
    `- 2.5.3 Canonical Path Anti-Bypass evidence present: ${evaluation.checkpoint253Ready ? "YES" : "NO"}`,
    `- 2.5.4 Full-Access Parity evidence present: ${evaluation.checkpoint254Ready ? "YES" : "NO"}`,
    "",
    "## Test Procedures (Objective, Setup, Steps, Assertions)",
    "",
    "1. User protection policy surface",
    "- Objective: verify owner-protected-path parsing is deterministic and fail-closed on invalid entries.",
    "- Setup: `createBrainConfigFromEnv` with `BRAIN_USER_PROTECTED_PATHS`.",
    "- Steps: parse valid multi-entry declarations and invalid empty-entry declarations.",
    "- Assertions: valid paths are included; invalid declarations throw immediately.",
    "",
    "2. Runtime enforcement coverage",
    "- Objective: verify protected-path blocking across `read_file`, `write_file`, `delete_file`, `list_directory`, and shell path-targeting variants.",
    "- Setup: hard constraints with `BRAIN_USER_PROTECTED_PATHS=runtime/user_protected`.",
    "- Steps: evaluate each action proposal that touches protected paths.",
    "- Assertions: action-specific protected-path violation codes are returned deterministically.",
    "",
    "3. Canonical anti-bypass matrix",
    "- Objective: ensure traversal/case/separator/relative/drive-letter variants cannot bypass protected-path boundaries.",
    "- Setup: hard constraints + normalized path evaluation.",
    "- Steps: run protected-path proposals using traversal, mixed-case separators, relative prefixes, and optional drive-letter case variations.",
    "- Assertions: all variants return protected-path violation codes.",
    "",
    "4. Full-access parity",
    "- Objective: ensure owner-protected paths stay blocked in full-access runtime mode.",
    "- Setup: `BRAIN_RUNTIME_MODE=full_access`, `BRAIN_ALLOW_FULL_ACCESS=true`, plus user-protected paths.",
    "- Steps: run protected-path read/list/shell proposals in full-access config.",
    "- Assertions: protected-path violations remain in effect and no bypass appears.",
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

  const evaluation = await runStage25Validation();
  updateStage25(stage, evaluation);
  recomputeScore(ledger);

  const generatedAt = new Date().toISOString();
  await writeFile(SCOREBOARD_PATH, JSON.stringify(ledger, null, 2), "utf8");
  await mkdir(path.dirname(EVIDENCE_REPORT_PATH), { recursive: true });
  await writeFile(EVIDENCE_REPORT_PATH, renderEvidenceReport(evaluation, generatedAt), "utf8");
  await writeFile(MANUAL_READINESS_PATH, renderManualReadiness(evaluation, generatedAt), "utf8");
  await writeFile(
    LIVE_REVIEW_CHECKLIST_PATH,
    renderLiveReviewChecklist(generatedAt),
    "utf8"
  );

  console.log(`Stage 2.5 checkpoint 2.5.1: ${evaluation.checkpoint251 ? "PASS" : "FAIL"}`);
  console.log(`Stage 2.5 checkpoint 2.5.2: ${evaluation.checkpoint252 ? "PASS" : "FAIL"}`);
  console.log(
    `Stage 2.5 manual readiness 2.5.3: ${evaluation.checkpoint253Ready ? "READY" : "NOT_READY"}`
  );
  console.log(
    `Stage 2.5 manual readiness 2.5.4: ${evaluation.checkpoint254Ready ? "READY" : "NOT_READY"}`
  );
  console.log(`Stage ledger updated: ${SCOREBOARD_PATH}`);
  console.log(`Evidence report: ${EVIDENCE_REPORT_PATH}`);
  console.log(`Manual readiness: ${MANUAL_READINESS_PATH}`);
  console.log(`Live review checklist: ${LIVE_REVIEW_CHECKLIST_PATH}`);
}

void main();
