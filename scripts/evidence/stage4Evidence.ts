/**
 * @fileoverview Runs Stage 4 model-integration validation, updates checkpoint evidence, and writes reviewer artifacts.
 */

import { exec as execCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCallback);
const SCOREBOARD_PATH = path.resolve(process.cwd(), "runtime/reward_score.json");
const EVIDENCE_REPORT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage4_evidence.md");
const PROVIDER_CONTRACT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage4_provider_contract.md");
const ROUTING_MATRIX_PATH = path.resolve(process.cwd(), "runtime/evidence/stage4_routing_matrix.md");
const BUDGET_DEADLINE_PATH = path.resolve(process.cwd(), "runtime/evidence/stage4_budget_deadline_notes.md");
const LIVE_SMOKE_PATH = path.resolve(process.cwd(), "runtime/evidence/stage4_live_smoke.md");
const STAGE_ID = "stage_4_model_integration";

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

interface Stage4Evaluation {
  commandOk: boolean;
  checkpoint41: boolean;
  checkpoint42: boolean;
  checkpoint43: boolean;
  checkpoint44Ready: boolean;
  checkpoint45Ready: boolean;
  rawOutput: string;
  liveSmokeStatus: "PASS" | "FAIL" | "NOT_RUN";
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
 * Implements `readLiveSmokeStatus` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function readLiveSmokeStatus(): Promise<"PASS" | "FAIL" | "NOT_RUN"> {
  try {
    const content = await readFile(LIVE_SMOKE_PATH, "utf8");
    if (content.includes("Status: PASS")) {
      return "PASS";
    }
    if (content.includes("Status: FAIL")) {
      return "FAIL";
    }
    return "NOT_RUN";
  } catch {
    return "NOT_RUN";
  }
}

/**
 * Implements `runStage4Validation` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runStage4Validation(): Promise<Stage4Evaluation> {
  const result = await runCommand("npm run test:stage4");
  const output = result.output;
  const liveSmokeStatus = await readLiveSmokeStatus();

  const checkpoint41 =
    result.ok &&
    includesAllPatterns(output, [
      "OpenAIModelClient parses direct JSON content",
      "OpenAIModelClient extracts JSON object from wrapped text",
      "OpenAIModelClient throws when response is missing content",
      "OpenAIModelClient throws when no JSON object is present"
    ]);

  const checkpoint42 =
    result.ok &&
    includesAllPatterns(output, [
      "createModelClientFromEnv throws when openai key is missing",
      "OpenAIModelClient propagates provider error message on non-ok status",
      "orchestrator fails the task when planner model call fails"
    ]);

  const checkpoint43 =
    result.ok &&
    includesAllPatterns(output, [
      "orchestrator uses configured planner and governor routing models in runtime path"
    ]);

  const checkpoint44Ready =
    result.ok &&
    includesAllPatterns(output, [
      "blocks actions that exceed cost limits",
      "OpenAIModelClient times out when provider exceeds configured deadline"
    ]);

  return {
    commandOk: result.ok,
    checkpoint41,
    checkpoint42,
    checkpoint43,
    checkpoint44Ready,
    checkpoint45Ready: liveSmokeStatus === "PASS",
    rawOutput: output,
    liveSmokeStatus
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
 * Implements `updateStageFour` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function updateStageFour(stage: StageLedger, evaluation: Stage4Evaluation): void {
  const now = new Date().toISOString();
  const isManualCheckpoint = (id: string): boolean => id === "4.4" || id === "4.5";
  const isAlreadyReviewerApproved = stage.status === "awarded" && stage.review.decision === "approved";

  const checkpointMap: Record<string, { passed: boolean; note: string }> = {
    "4.1": {
      passed: evaluation.checkpoint41,
      note: evaluation.checkpoint41
        ? "Provider contract parsing and validation tests passed for OpenAI response variants."
        : "Provider contract evidence incomplete."
    },
    "4.2": {
      passed: evaluation.checkpoint42,
      note: evaluation.checkpoint42
        ? "Fail-safe handling tests passed for provider errors and strict planner failure semantics."
        : "Fail-safe handling evidence incomplete."
    },
    "4.3": {
      passed: evaluation.checkpoint43,
      note: evaluation.checkpoint43
        ? "Routing-discipline runtime-path test passed for planner/governor model assignments."
        : "Routing-discipline evidence incomplete."
    },
    "4.4": {
      passed: false,
      note: evaluation.checkpoint44Ready
        ? "Budget/deadline evidence is present (runtime/evidence/stage4_budget_deadline_notes.md); awaiting manual reviewer sign-off."
        : "Budget/deadline evidence incomplete."
    },
    "4.5": {
      passed: false,
      note: evaluation.checkpoint45Ready
        ? "Live smoke evidence indicates PASS (runtime/evidence/stage4_live_smoke.md); awaiting manual reviewer sign-off."
        : "Live smoke evidence is not PASS. Run npm run test:stage4:live with guarded OpenAI config."
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
    ? "All Stage 4 checkpoints passed. Awaiting final reviewer sign-off."
    : "Stage 4 in progress. Automated checkpoints updated; manual checkpoints still require reviewer evidence.";

  stage.review.signOffRequired = true;
  stage.review.decision = "pending";
  stage.review.signOffRequestedAt = allPassed ? now : null;
  stage.review.signOffRequestedBy = allPassed ? "codex" : null;
  stage.review.signedOffAt = null;
  stage.review.signedOffBy = null;
  stage.review.signOffNotes = allPassed
    ? "Stage 4 evidence prepared. Awaiting final reviewer decision."
    : "Stage 4 evidence updated. Manual checkpoint review still pending.";
}

/**
 * Implements `renderProviderContractNotes` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderProviderContractNotes(generatedAt: string): string {
  return [
    "# Stage 4 Provider Contract Notes",
    "",
    `- Generated At: ${generatedAt}`,
    "",
    "## Covered Tests",
    "1. `OpenAIModelClient parses direct JSON content`",
    "2. `OpenAIModelClient extracts JSON object from wrapped text`",
    "3. `OpenAIModelClient throws when response is missing content`",
    "4. `OpenAIModelClient throws when no JSON object is present`",
    "5. `OpenAIModelClient propagates provider error message on non-ok status`",
    "",
    "## Objective",
    "Validate OpenAI adapter parsing, schema handling, and provider-error propagation behavior.",
    ""
  ].join("\n");
}

/**
 * Implements `renderRoutingMatrix` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderRoutingMatrix(generatedAt: string): string {
  return [
    "# Stage 4 Routing Matrix",
    "",
    `- Generated At: ${generatedAt}`,
    "",
    "| Runtime Role | Expected Model Source | Covered Test |",
    "| --- | --- | --- |",
    "| planner (planner schema) | `DEFAULT_BRAIN_CONFIG.routing.planner.primary` | `orchestrator uses configured planner and governor routing models in runtime path` |",
    "| governor (governor schema) | `DEFAULT_BRAIN_CONFIG.governorRouting[*].primary` fallback `DEFAULT_BRAIN_CONFIG.routing.governor.primary` | `orchestrator uses configured planner and governor routing models in runtime path` |",
    "| reflection | planner model selection for reflection pass | `orchestrator uses configured planner and governor routing models in runtime path` |",
    ""
  ].join("\n");
}

/**
 * Implements `renderBudgetDeadlineNotes` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderBudgetDeadlineNotes(generatedAt: string): string {
  return [
    "# Stage 4 Budget and Deadline Notes",
    "",
    `- Generated At: ${generatedAt}`,
    "",
    "## Covered Evidence",
    "1. Cost budget guard: `blocks actions that exceed cost limits`.",
    "2. Provider deadline guard: `OpenAIModelClient times out when provider exceeds configured deadline`.",
    "",
    "## Objective",
    "Demonstrate cost and deadline controls remain enforced during model-integration work.",
    "",
    "## Manual Review Scope",
    "Reviewer should confirm operational budget/deadline policy values match deployment expectations before checkpoint 4.4 approval.",
    ""
  ].join("\n");
}

/**
 * Implements `renderEvidenceReport` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderEvidenceReport(evaluation: Stage4Evaluation, generatedAt: string): string {
  return [
    "# Stage 4 Evidence Report",
    "",
    `- Generated At: ${generatedAt}`,
    `- Command: \`npm run test:stage4\``,
    `- Command Status: ${evaluation.commandOk ? "PASS" : "FAIL"}`,
    `- Live Smoke Status: ${evaluation.liveSmokeStatus}`,
    "",
    "## Automated Checkpoint Summary",
    "",
    `- 4.1 Provider Contract Reliability: ${evaluation.checkpoint41 ? "PASS" : "FAIL"}`,
    `- 4.2 Fail-Safe Handling: ${evaluation.checkpoint42 ? "PASS" : "FAIL"}`,
    `- 4.3 Routing Discipline: ${evaluation.checkpoint43 ? "PASS" : "FAIL"}`,
    "",
    "## Manual-Evidence Readiness Signals",
    "",
    `- 4.4 Budget and Deadline evidence present: ${evaluation.checkpoint44Ready ? "YES" : "NO"}`,
    `- 4.5 Live smoke is PASS: ${evaluation.checkpoint45Ready ? "YES" : "NO"}`,
    "",
    "## Test Procedures (Objective, Setup, Steps, Assertions)",
    "",
    "1. Provider contract suite (`OpenAIModelClient ...`)",
    "- Objective: validate response parsing and error contract handling for provider output shapes.",
    "- Setup: mock fetch responses for valid JSON, wrapped JSON, missing content, non-JSON, and non-ok responses.",
    "- Steps: call `OpenAIModelClient.completeJson` with structured request fixture per scenario.",
    "- Assertions: valid payloads parse; invalid payloads/errors throw deterministic messages.",
    "",
    "2. Fail-safe handling suite (`createModelClientFromEnv ...`, `orchestrator fails ...`)",
    "- Objective: ensure provider/planner failures fail closed instead of executing deterministic fallback plans.",
    "- Setup: environment backend-selection tests plus injected planner failure model client.",
    "- Steps: request openai without key, simulate provider failure, run orchestrator task with planner schema failure.",
    "- Assertions: openai backend without key fails fast; planner model failure causes task rejection (no heuristic plan fallback).",
    "",
    "3. Routing discipline suite (`orchestrator uses configured planner and governor routing models ...`)",
    "- Objective: verify runtime code path uses expected role-model assignments.",
    "- Setup: instrumented model client logs schema/model pairs while executing full orchestrator run.",
    "- Steps: execute governance-relevant task and inspect recorded model calls.",
    "- Assertions: planner schema uses planner model; governor schema uses configured governor-routing models; reflection call is present.",
    "",
    "4. Budget/deadline evidence suite (`blocks actions ...`, `OpenAIModelClient times out ...`)",
    "- Objective: show cost guard and provider deadline guard remain enforced.",
    "- Setup: hard-constraint budget test plus timed-out provider mock call.",
    "- Steps: run Stage 4 suite and inspect budget/deadline test cases.",
    "- Assertions: over-budget actions are blocked; provider call exceeding timeout is rejected deterministically.",
    "",
    "## Artifact Files",
    "",
    `1. \`${path.relative(process.cwd(), PROVIDER_CONTRACT_PATH)}\``,
    `2. \`${path.relative(process.cwd(), ROUTING_MATRIX_PATH)}\``,
    `3. \`${path.relative(process.cwd(), BUDGET_DEADLINE_PATH)}\``,
    `4. \`${path.relative(process.cwd(), LIVE_SMOKE_PATH)}\` (optional/manual)`,
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

  const evaluation = await runStage4Validation();
  updateStageFour(stage, evaluation);
  recomputeScore(ledger);

  const generatedAt = new Date().toISOString();
  await writeFile(SCOREBOARD_PATH, JSON.stringify(ledger, null, 2), "utf8");
  await mkdir(path.dirname(EVIDENCE_REPORT_PATH), { recursive: true });
  await writeFile(EVIDENCE_REPORT_PATH, renderEvidenceReport(evaluation, generatedAt), "utf8");
  await writeFile(PROVIDER_CONTRACT_PATH, renderProviderContractNotes(generatedAt), "utf8");
  await writeFile(ROUTING_MATRIX_PATH, renderRoutingMatrix(generatedAt), "utf8");
  await writeFile(BUDGET_DEADLINE_PATH, renderBudgetDeadlineNotes(generatedAt), "utf8");

  console.log(`Stage 4 checkpoint 4.1: ${evaluation.checkpoint41 ? "PASS" : "FAIL"}`);
  console.log(`Stage 4 checkpoint 4.2: ${evaluation.checkpoint42 ? "PASS" : "FAIL"}`);
  console.log(`Stage 4 checkpoint 4.3: ${evaluation.checkpoint43 ? "PASS" : "FAIL"}`);
  console.log(`Stage 4 manual readiness 4.4: ${evaluation.checkpoint44Ready ? "READY" : "NOT_READY"}`);
  console.log(`Stage 4 live smoke status 4.5: ${evaluation.liveSmokeStatus}`);
  console.log(`Stage ledger updated: ${SCOREBOARD_PATH}`);
  console.log(`Evidence report: ${EVIDENCE_REPORT_PATH}`);
}

void main();
