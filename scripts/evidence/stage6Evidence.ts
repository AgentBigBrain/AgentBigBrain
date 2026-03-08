/**
 * @fileoverview Runs Stage 6 runtime-path validation, updates automated checkpoint evidence, and writes manual-review artifacts.
 */

import { exec as execCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { TEST_REVIEWER_HANDLE } from "../../tests/support/windowsPathFixtures";

const exec = promisify(execCallback);
const STAGE_ID = "stage_6_autonomy";
const SCOREBOARD_PATH = path.resolve(process.cwd(), "runtime/reward_score.json");
const EVIDENCE_REPORT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_evidence.md");
const MANUAL_READINESS_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_manual_readiness.md"
);
const LIVE_REVIEW_CHECKLIST_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_live_review_checklist.md"
);
const LIVE_SMOKE_REPORT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_live_smoke_report.json"
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

interface StageOpenAiLiveSmokeReport {
  status: "PASS" | "FAIL" | "NOT_RUN";
  passCriteria: {
    overallPass: boolean;
  };
}

interface Stage6Evaluation {
  commandOk: boolean;
  liveSmokeCommandOk: boolean;
  liveSmokeReady: boolean;
  checkpoint61: boolean;
  checkpoint62: boolean;
  checkpoint63Ready: boolean;
  checkpoint64Ready: boolean;
  checkpoint65Ready: boolean;
  checkpoint66Ready: boolean;
  checkpoint67Ready: boolean;
  checkpoint68Ready: boolean;
  checkpoint68MemoryAccessAuditReady: boolean;
  rawOutput: string;
  liveSmokeOutput: string;
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
 * Implements `isStageOpenAiLiveSmokeReport` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isStageOpenAiLiveSmokeReport(value: unknown): value is StageOpenAiLiveSmokeReport {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<StageOpenAiLiveSmokeReport>;
  return (
    (record.status === "PASS" || record.status === "FAIL" || record.status === "NOT_RUN") &&
    record.passCriteria !== null &&
    typeof record.passCriteria === "object" &&
    typeof (record.passCriteria as { overallPass?: unknown }).overallPass === "boolean"
  );
}

/**
 * Implements `readLiveSmokeReport` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function readLiveSmokeReport(): Promise<StageOpenAiLiveSmokeReport | null> {
  try {
    const raw = await readFile(LIVE_SMOKE_REPORT_PATH, "utf8");
    const parsed = JSON.parse(stripUtf8Bom(raw)) as unknown;
    if (!isStageOpenAiLiveSmokeReport(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Implements `runStage6Validation` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runStage6Validation(): Promise<Stage6Evaluation> {
  const result = await runCommand("npm run test:stage6");
  const liveSmokeResult = await runCommand("npm run test:stage6:live_smoke");
  const liveSmokeReport = await readLiveSmokeReport();
  const liveSmokeReady =
    liveSmokeResult.ok &&
    liveSmokeReport !== null &&
    liveSmokeReport.status === "PASS" &&
    liveSmokeReport.passCriteria.overallPass === true;
  const output = result.output;

  const checkpoint61 =
    result.ok &&
    includesAllPatterns(output, [
      "stage 6 structured proposal generation enforces bounded hypothesis risk and metric fields"
    ]);
  const checkpoint62 =
    result.ok &&
    includesAllPatterns(output, [
      "stage 6 sandboxed validation cycle runs in isolated mode before promotion"
    ]);
  const checkpoint63Ready =
    result.ok &&
    includesAllPatterns(output, [
      "stage 6 governed promotion control evaluates create_skill approvals through orchestrator votes"
    ]);
  const checkpoint64Ready =
    result.ok &&
    includesAllPatterns(output, [
      "stage 6 rollback drill restores previous skill snapshot after simulated regression"
    ]);
  const checkpoint65Ready =
    result.ok &&
    includesAllPatterns(output, [
      "stage 6 objective reward integrity uses approved-safe action counts from runtime results"
    ]);
  const checkpoint66Ready =
    result.ok &&
    includesAllPatterns(output, [
      "stage 6 dot-connecting memory efficacy surfaces correlated lesson links"
    ]);
  const checkpoint67Ready =
    result.ok &&
    includesAllPatterns(output, [
      "stage 6 learned skill conversational reuse demonstrates creation to later invocation trace"
    ]);
  const checkpoint68Ready =
    result.ok &&
    includesAllPatterns(output, [
      "stage 6 delegation safety harness enforces spawn threshold and hard limits"
    ]);
  const checkpoint68MemoryAccessAuditReady =
    result.ok &&
    includesAllPatterns(output, [
      "stage 6 memory access audit logging writes append-only retrieval events and blocks tampering"
    ]);

  return {
    commandOk: result.ok,
    liveSmokeCommandOk: liveSmokeResult.ok,
    liveSmokeReady,
    checkpoint61,
    checkpoint62,
    checkpoint63Ready,
    checkpoint64Ready,
    checkpoint65Ready,
    checkpoint66Ready,
    checkpoint67Ready,
    checkpoint68Ready: checkpoint68Ready && checkpoint68MemoryAccessAuditReady,
    checkpoint68MemoryAccessAuditReady,
    rawOutput: output,
    liveSmokeOutput: liveSmokeResult.output
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
 * Implements `updateStage6` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function updateStage6(stage: StageLedger, evaluation: Stage6Evaluation): void {
  const now = new Date().toISOString();
  const manualCheckpointIds = new Set(["6.3", "6.4", "6.5", "6.6", "6.7", "6.8"]);
  const isManualCheckpoint = (id: string): boolean => manualCheckpointIds.has(id);
  const isAlreadyReviewerApproved = stage.status === "awarded" && stage.review.decision === "approved";
  const manualReadinessComplete =
    evaluation.liveSmokeReady &&
    evaluation.checkpoint63Ready &&
    evaluation.checkpoint64Ready &&
    evaluation.checkpoint65Ready &&
    evaluation.checkpoint66Ready &&
    evaluation.checkpoint67Ready &&
    evaluation.checkpoint68Ready;

  const checkpointMap: Record<string, { passed: boolean; note: string }> = {
    "6.1": {
      passed: evaluation.checkpoint61,
      note: evaluation.checkpoint61
        ? "Structured proposal-policy pack evidence is present (bounded scope, risk level, measurable hypothesis/metric)."
        : "Structured proposal-policy pack automated evidence is incomplete."
    },
    "6.2": {
      passed: evaluation.checkpoint62,
      note: evaluation.checkpoint62
        ? "Sandboxed validation-cycle evidence is present (forced isolated runtime for validation commands)."
        : "Sandboxed validation-cycle automated evidence is incomplete."
    },
    "6.3": {
      passed: false,
      note: evaluation.checkpoint63Ready
        ? "Governed promotion-control runtime-path evidence is present; awaiting manual reviewer sign-off."
        : "Governed promotion-control readiness evidence is incomplete."
    },
    "6.4": {
      passed: false,
      note: evaluation.checkpoint64Ready
        ? "Rollback drill runtime evidence is present; awaiting manual reviewer sign-off."
        : "Rollback drill readiness evidence is incomplete."
    },
    "6.5": {
      passed: false,
      note: evaluation.checkpoint65Ready
        ? "Objective reward-integrity readiness evidence is present; awaiting manual reviewer sign-off."
        : "Objective reward-integrity readiness evidence is incomplete."
    },
    "6.6": {
      passed: false,
      note: evaluation.checkpoint66Ready
        ? "Dot-connecting memory-correlation readiness evidence is present; awaiting manual reviewer sign-off."
        : "Dot-connecting memory readiness evidence is incomplete."
    },
    "6.7": {
      passed: false,
      note: evaluation.checkpoint67Ready
        ? "Learned-skill conversational-reuse readiness evidence is present; awaiting manual reviewer sign-off."
        : "Learned-skill conversational-reuse readiness evidence is incomplete."
    },
    "6.8": {
      passed: false,
      note: evaluation.checkpoint68Ready
        ? "Delegation safety-harness readiness evidence (including memory-access audit logging and tamper protection) is present; awaiting manual reviewer sign-off."
        : evaluation.checkpoint68MemoryAccessAuditReady
          ? "Delegation safety-harness readiness evidence is incomplete."
          : "Delegation safety-harness readiness evidence is incomplete (missing memory-access audit/tamper-block evidence)."
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
    ? "All Stage 6 checkpoints passed. Awaiting final reviewer sign-off."
    : hasPartialManualSignOff
      ? `Stage 6 partial manual sign-off recorded (${manualPassedCount}/${manualCheckpointIds.size} manual checkpoints approved); awaiting remaining manual approvals.`
      : manualReadinessComplete
        ? "Stage 6 evidence-ready for manual reviewer sign-off."
        : evaluation.liveSmokeReady
          ? "Stage 6 in progress. Manual-checkpoint evidence is still incomplete."
          : "Stage 6 in progress. OpenAI live smoke is missing or failed.";

  stage.review.signOffRequired = true;
  stage.review.decision = "pending";
  stage.review.signOffRequestedAt = allPassed || manualReadinessComplete ? now : null;
  stage.review.signOffRequestedBy = allPassed || manualReadinessComplete ? "codex" : null;
  stage.review.signedOffAt = null;
  stage.review.signedOffBy = null;
  stage.review.signOffNotes = allPassed
    ? "Stage 6 evidence prepared. Awaiting final reviewer decision."
    : hasPartialManualSignOff
      ? `Partial manual sign-off recorded (${manualPassedCount}/${manualCheckpointIds.size} manual checkpoints approved). Awaiting remaining manual decisions and final reviewer sign-off.`
      : manualReadinessComplete
        ? "Stage 6 manual checkpoint evidence is ready. Awaiting reviewer sign-off."
        : evaluation.liveSmokeReady
          ? "Stage 6 manual checkpoint evidence remains incomplete."
          : "Stage 6 OpenAI live smoke evidence is missing or failed.";
}

/**
 * Implements `renderManualReadiness` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderManualReadiness(evaluation: Stage6Evaluation, generatedAt: string): string {
  return [
    "# Stage 6 Manual Checkpoint Readiness",
    "",
    `- Generated At: ${generatedAt}`,
    "",
    `- OpenAI live smoke readiness: ${evaluation.liveSmokeReady ? "YES" : "NO"}`,
    `  - live smoke command status: ${evaluation.liveSmokeCommandOk ? "PASS" : "FAIL"}`,
    "",
    `- 6.3 Governed Promotion Control readiness evidence present: ${evaluation.checkpoint63Ready ? "YES" : "NO"}`,
    `- 6.4 Rollback Reliability readiness evidence present: ${evaluation.checkpoint64Ready ? "YES" : "NO"}`,
    `- 6.5 Objective Reward Integrity readiness evidence present: ${evaluation.checkpoint65Ready ? "YES" : "NO"}`,
    `- 6.6 Dot-Connecting Memory Efficacy readiness evidence present: ${evaluation.checkpoint66Ready ? "YES" : "NO"}`,
    `- 6.7 Learned Skill Conversational Reuse readiness evidence present: ${evaluation.checkpoint67Ready ? "YES" : "NO"}`,
    `- 6.8 Controlled Subagent Delegation readiness evidence present: ${evaluation.checkpoint68Ready ? "YES" : "NO"}`,
    `  - 6.8 memory-access audit logging signal present: ${evaluation.checkpoint68MemoryAccessAuditReady ? "YES" : "NO"}`,
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
    "# Stage 6 Live Review Checklist",
    "",
    `- Generated At: ${generatedAt}`,
    `- Stage: \`${STAGE_ID}\``,
    `- Reviewer: \`${TEST_REVIEWER_HANDLE}\``,
    "",
    "## Automated Preflight (Already Run)",
    "",
    "1. `npm run test:stage6:evidence`",
    "2. `npm run test:stage6`",
    "3. `npm run test:stage6:live_smoke`",
    "",
    "Artifacts:",
    "1. `runtime/evidence/stage6_evidence.md`",
    "2. `runtime/evidence/stage6_manual_readiness.md`",
    "3. `runtime/evidence/stage6_live_smoke_report.json`",
    "4. `runtime/reward_score.json`",
    "",
    "## Checkpoint 6.3 - Governed Promotion Control",
    "",
    "Objective: prove promotion actions cannot bypass orchestrator hard constraints/governor voting.",
    "",
    "Live procedure:",
    "1. Run in terminal (not chat): `npm run dev -- \"Create skill stage6_live_gate for promotion control proof.\"`",
    "2. Optional interface run (for live gateway trace): `BigBrain /chat Create skill stage6_live_gate for promotion control proof.`",
    "3. Confirm action path includes governance voting and no hard-constraint bypass.",
    "4. Confirm skill file appears only when governance approves.",
    "",
    "Pass criteria:",
    "1. Promotion is blocked when policy blocks, approved only when governance approves.",
    "2. No direct write path bypasses orchestrator governance flow.",
    "",
    "## Checkpoint 6.4 - Rollback Reliability",
    "",
    "Objective: prove failed promotion drills can revert to last-known-good skill snapshot.",
    "",
    "Live procedure:",
    "1. Prepare drill snapshot with prior skill content.",
    "2. Apply promotion payload and verify new content.",
    "3. Run rollback and verify prior content is restored exactly.",
    "",
    "Pass criteria:",
    "1. Rollback restores previous content or deletes newly introduced artifact when no prior version exists.",
    "2. Drill status is persisted as `rolled_back`.",
    "",
    "## Checkpoint 6.5 - Objective Reward Integrity",
    "",
    "Objective: prove reward evidence derives from objective run outcomes (approved/blocked counts), not self-claims.",
    "",
    "Live procedure:",
    "1. Run one safe task and one blocked unsafe task.",
    "2. Inspect reward-evidence output fields tied to runtime action outcomes.",
    "",
    "Pass criteria:",
    "1. Objective pass only occurs when approved-safe actions exist and blocked count is zero.",
    "2. Reward recommendation decreases when blocked outcomes increase.",
    "",
    "## Checkpoint 6.6 - Dot-Connecting Memory Efficacy",
    "",
    "Objective: prove correlated semantic lessons are linked and retrieved for related asks.",
    "",
    "Live procedure:",
    "1. Insert related lessons with overlapping concepts into semantic memory.",
    "2. Query for related context and inspect correlation trace.",
    "",
    "Pass criteria:",
    "1. Retrieved lessons include linked relationships (`relatedLessonIds`) and non-zero linked-edge count.",
    "2. Influential concepts reflect overlap for the current ask.",
    "",
    "## Checkpoint 6.7 - Learned Skill Conversational Reuse",
    "",
    "Objective: prove a promoted skill is later reused in a conversational task without manual wiring.",
    "",
    "Live procedure:",
    "1. Create and promote a skill through governed path.",
    "2. On a later conversational task, request behavior that should reuse promoted skill.",
    "3. Capture trace proving automatic retrieval/invocation path.",
    "",
    "Pass criteria:",
    "1. Reuse occurs in a later task without direct manual mapping edits.",
    "2. Trace links creation -> promotion -> later invocation.",
    "",
    "## Checkpoint 6.8 - Controlled Subagent Delegation",
    "",
    "Objective: prove deterministic spawn policy and hard limits (count/depth/escalation) are enforced.",
    "",
    "Live procedure:",
    "1. Run delegation policy with score-above-threshold, limit-reached, depth-exceeded, and escalation-required inputs.",
    "2. Trigger memory retrievals and capture append-only memory-access audit records (`runtime/memory_access_log.json`).",
    "3. Attempt runtime write/delete tampering against the memory-access log path and capture hard-constraint blocks.",
    "4. Capture delegation decision artifacts (`shouldSpawn`, `spawnScore`, `blockedBy`, reasons).",
    "",
    "Pass criteria:",
    "1. Spawns only occur when score >= threshold and no hard-limit block exists.",
    "2. Limit/depth/escalation conditions deterministically block spawn.",
    "3. Memory-access audit records include query hash/retrieved count/redacted count/domain lanes and are append-only.",
    "4. Runtime write/delete tampering of memory-access audit log is hard-blocked.",
    "",
    "## Sign-Off Template",
    "",
    "1. `6.1`: PASS/FAIL - rationale:",
    "2. `6.2`: PASS/FAIL - rationale:",
    "3. `6.3`: PASS/FAIL - rationale:",
    "4. `6.4`: PASS/FAIL - rationale:",
    "5. `6.5`: PASS/FAIL - rationale:",
    "6. `6.6`: PASS/FAIL - rationale:",
    "7. `6.7`: PASS/FAIL - rationale:",
    "8. `6.8`: PASS/FAIL - rationale:",
    "9. Final stage decision: `approved` / `rejected`",
    `10. Signed off by: \`${TEST_REVIEWER_HANDLE}\``,
    "11. Signed off at (ISO): `<timestamp>`",
    ""
  ].join("\n");
}

/**
 * Implements `renderEvidenceReport` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderEvidenceReport(evaluation: Stage6Evaluation, generatedAt: string): string {
  return [
    "# Stage 6 Evidence Report",
    "",
    `- Generated At: ${generatedAt}`,
    "- Command: `npm run test:stage6`",
    `- Command Status: ${evaluation.commandOk ? "PASS" : "FAIL"}`,
    "- OpenAI live smoke command: `npm run test:stage6:live_smoke`",
    `- OpenAI live smoke command status: ${evaluation.liveSmokeCommandOk ? "PASS" : "FAIL"}`,
    `- OpenAI live smoke readiness: ${evaluation.liveSmokeReady ? "READY" : "NOT_READY"}`,
    "",
    "## Automated Checkpoint Summary",
    "",
    `- 6.1 Structured Proposal Generation: ${evaluation.checkpoint61 ? "PASS" : "FAIL"}`,
    `- 6.2 Sandboxed Validation Cycle: ${evaluation.checkpoint62 ? "PASS" : "FAIL"}`,
    "",
    "## Manual-Evidence Readiness Signals",
    "",
    `- 6.3 Governed Promotion Control readiness evidence present: ${evaluation.checkpoint63Ready ? "YES" : "NO"}`,
    `- 6.4 Rollback Reliability readiness evidence present: ${evaluation.checkpoint64Ready ? "YES" : "NO"}`,
    `- 6.5 Objective Reward Integrity readiness evidence present: ${evaluation.checkpoint65Ready ? "YES" : "NO"}`,
    `- 6.6 Dot-Connecting Memory Efficacy readiness evidence present: ${evaluation.checkpoint66Ready ? "YES" : "NO"}`,
    `- 6.7 Learned Skill Conversational Reuse readiness evidence present: ${evaluation.checkpoint67Ready ? "YES" : "NO"}`,
    `- 6.8 Controlled Subagent Delegation readiness evidence present: ${evaluation.checkpoint68Ready ? "YES" : "NO"}`,
    `  - 6.8 memory-access audit logging signal present: ${evaluation.checkpoint68MemoryAccessAuditReady ? "YES" : "NO"}`,
    "",
    "## OpenAI Live Smoke Output",
    "",
    "```text",
    evaluation.liveSmokeOutput.trim(),
    "```",
    "",
    "## Test Procedures (Objective, Setup, Steps, Assertions)",
    "",
    "1. Structured proposal policy pack",
    "- Objective: ensure autonomy proposals include bounded scope, explicit hypothesis, measurable metric, risk level, and rollback plan.",
    "- Setup: `createAutonomyProposalPolicyPack` + deterministic validator.",
    "- Steps: validate a complete pack and an intentionally invalid pack.",
    "- Assertions: valid pack passes; invalid pack returns deterministic violation codes.",
    "",
    "2. Sandboxed validation cycle",
    "- Objective: ensure validation commands run in isolated runtime mode with side effects disabled.",
    "- Setup: `runSandboxValidationCycle` command harness.",
    "- Steps: execute a command that echoes runtime-mode and side-effect env flags.",
    "- Assertions: output confirms `isolated`, `BRAIN_ENABLE_REAL_SHELL=false`, and `BRAIN_ENABLE_REAL_NETWORK_WRITE=false`.",
    "",
    "3. Governed promotion control runtime path",
    "- Objective: ensure create-skill promotions flow through orchestrator governance.",
    "- Setup: real `BrainOrchestrator` + planner/governor/executor stack.",
    "- Steps: run create-skill ask through orchestrator and evaluate promotion candidate decision from runtime result.",
    "- Assertions: promoted action requires approved create-skill action with votes and zero violations.",
    "",
    "4. Rollback drill",
    "- Objective: validate promotion snapshot restore behavior.",
    "- Setup: `AutonomyPromotionDrill` with deterministic snapshot path and skills root.",
    "- Steps: prepare snapshot -> apply promotion -> rollback.",
    "- Assertions: file contents revert to prior version and drill status becomes `rolled_back`.",
    "",
    "5. Objective reward evidence",
    "- Objective: tie reward evidence to objective run outcomes.",
    "- Setup: one safe approved run and one blocked unsafe run.",
    "- Steps: derive objective reward evidence for each run.",
    "- Assertions: objective pass only on safe approved run; blocked outcomes suppress objective pass.",
    "",
    "6. Dot-connecting memory trace",
    "- Objective: verify related lessons are linked/retrieved with auditable correlation trace.",
    "- Setup: semantic memory with overlapping-concept lessons.",
    "- Steps: retrieve relevant lessons and build memory-correlation trace.",
    "- Assertions: non-zero linked-edge count and influential overlap concepts are present.",
    "",
    "7. Delegation safety harness",
    "- Objective: verify deterministic delegation limits and threshold behavior.",
    "- Setup: `evaluateSubagentDelegation` with blocked and allowed signals.",
    "- Steps: evaluate limit-reached and score-qualified scenarios.",
    "- Assertions: limit-reached blocks spawn; score-qualified path allows spawn.",
    "",
    "8. Memory-access audit logging and tamper protection",
    "- Objective: verify append-only memory retrieval audit records and hard-constraint tamper protection.",
    "- Setup: trigger memory retrieval path, inspect `runtime/memory_access_log.json`, and run write/delete tamper attempts.",
    "- Steps: confirm new audit entries are appended with expected fields, then attempt runtime write/delete actions against the log path.",
    "- Assertions: audit rows include query hash/retrieved count/redacted count/domain lanes; write/delete tamper attempts are blocked.",
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

  const evaluation = await runStage6Validation();
  updateStage6(stage, evaluation);
  recomputeScore(ledger);

  const generatedAt = new Date().toISOString();
  await writeFile(SCOREBOARD_PATH, JSON.stringify(ledger, null, 2), "utf8");
  await mkdir(path.dirname(EVIDENCE_REPORT_PATH), { recursive: true });
  await writeFile(EVIDENCE_REPORT_PATH, renderEvidenceReport(evaluation, generatedAt), "utf8");
  await writeFile(MANUAL_READINESS_PATH, renderManualReadiness(evaluation, generatedAt), "utf8");
  await writeFile(LIVE_REVIEW_CHECKLIST_PATH, renderLiveReviewChecklist(generatedAt), "utf8");

  console.log(`Stage 6 checkpoint 6.1: ${evaluation.checkpoint61 ? "PASS" : "FAIL"}`);
  console.log(`Stage 6 checkpoint 6.2: ${evaluation.checkpoint62 ? "PASS" : "FAIL"}`);
  console.log(`Stage 6 OpenAI live smoke: ${evaluation.liveSmokeReady ? "READY" : "NOT_READY"}`);
  console.log(`Stage 6 OpenAI live smoke command: ${evaluation.liveSmokeCommandOk ? "PASS" : "FAIL"}`);
  console.log(`Stage 6 manual readiness 6.3: ${evaluation.checkpoint63Ready ? "READY" : "NOT_READY"}`);
  console.log(`Stage 6 manual readiness 6.4: ${evaluation.checkpoint64Ready ? "READY" : "NOT_READY"}`);
  console.log(`Stage 6 manual readiness 6.5: ${evaluation.checkpoint65Ready ? "READY" : "NOT_READY"}`);
  console.log(`Stage 6 manual readiness 6.6: ${evaluation.checkpoint66Ready ? "READY" : "NOT_READY"}`);
  console.log(`Stage 6 manual readiness 6.7: ${evaluation.checkpoint67Ready ? "READY" : "NOT_READY"}`);
  console.log(`Stage 6 manual readiness 6.8: ${evaluation.checkpoint68Ready ? "READY" : "NOT_READY"}`);
  console.log(`Stage 6 manual readiness 6.8 memory access audit signal: ${evaluation.checkpoint68MemoryAccessAuditReady ? "READY" : "NOT_READY"}`);
  console.log(`Stage ledger updated: ${SCOREBOARD_PATH}`);
  console.log(`Evidence report: ${EVIDENCE_REPORT_PATH}`);
  console.log(`Manual readiness: ${MANUAL_READINESS_PATH}`);
  console.log(`Live review checklist: ${LIVE_REVIEW_CHECKLIST_PATH}`);
}

void main();
