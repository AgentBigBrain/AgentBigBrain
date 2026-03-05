/**
 * @fileoverview Runs Stage 5 interface validation, updates checkpoint evidence, and writes reviewer artifacts.
 */

import { exec as execCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCallback);
const SCOREBOARD_PATH = path.resolve(process.cwd(), "runtime/reward_score.json");
const EVIDENCE_REPORT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage5_evidence.md");
const AUTH_ALLOWLIST_PATH = path.resolve(process.cwd(), "runtime/evidence/stage5_auth_allowlist.md");
const ABUSE_NOTES_PATH = path.resolve(process.cwd(), "runtime/evidence/stage5_abuse_controls.md");
const GOVERNANCE_TRACE_PATH = path.resolve(process.cwd(), "runtime/evidence/stage5_governance_trace.md");
const STAGE_ID = "stage_5_interfaces";

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

interface Stage5Evaluation {
  commandOk: boolean;
  checkpoint51: boolean;
  checkpoint52: boolean;
  checkpoint53Ready: boolean;
  checkpoint54Ready: boolean;
  checkpoint55Ready: boolean;
  checkpoint56Ready: boolean;
  conversationFlowCovered: boolean;
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
 * Implements `runStage5Validation` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runStage5Validation(): Promise<Stage5Evaluation> {
  const result = await runCommand("npm run test:stage5");
  const output = result.output;

  const checkpoint51 =
    result.ok &&
    includesAllPatterns(output, [
      "telegram adapter rejects unauthorized token requests",
      "discord adapter rejects unauthorized token requests"
    ]);
  const checkpoint52 =
    result.ok &&
    includesAllPatterns(output, [
      "telegram adapter enforces username, user, and chat allowlist",
      "discord adapter enforces username allowlist",
      "runtime config selects telegram provider when configured",
      "runtime config selects discord provider when configured",
      "runtime config requires at least one allowlisted username"
    ]);
  const checkpoint53Ready =
    result.ok &&
    includesAllPatterns(output, [
      "telegram adapter applies rate-limit controls for burst traffic",
      "discord adapter applies rate-limit controls for burst traffic"
    ]);
  const checkpoint54Ready =
    result.ok &&
    includesAllPatterns(output, [
      "telegram adapter rejects duplicate update replay attempts",
      "discord adapter rejects duplicate message replay attempts"
    ]);
  const checkpoint55Ready =
    result.ok &&
    includesAllPatterns(output, [
      "telegram adapter routes accepted events through orchestrator governance path",
      "discord adapter routes accepted events through orchestrator governance path"
    ]);
  const checkpoint56Ready =
    result.ok &&
    includesAllPatterns(output, [
      "conversation manager keeps session responsive with job queue status and heartbeat while work is active"
    ]);
  const conversationFlowCovered =
    result.ok &&
    includesAllPatterns(output, [
      "conversation manager supports propose -> ask -> adjust -> approve flow",
      "conversation manager keeps session responsive with job queue status and heartbeat while work is active"
    ]);

  return {
    commandOk: result.ok,
    checkpoint51,
    checkpoint52,
    checkpoint53Ready,
    checkpoint54Ready,
    checkpoint55Ready,
    checkpoint56Ready,
    conversationFlowCovered,
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
 * Implements `updateStageFive` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function updateStageFive(stage: StageLedger, evaluation: Stage5Evaluation): void {
  const now = new Date().toISOString();
  const isAlreadyReviewerApproved = stage.status === "awarded" && stage.review.decision === "approved";

  if (isAlreadyReviewerApproved) {
    stage.lastCheckedAt = now;
    stage.lastPassed = true;
    stage.lastNote = "Awarded and approved by final reviewer.";
    for (const checkpoint of stage.checkpoints) {
      checkpoint.lastCheckedAt = now;
      checkpoint.lastPassed = true;
      checkpoint.status = "passed";
      checkpoint.lastNote = "Checkpoint validated and approved by final reviewer.";
    }
    return;
  }

  const checkpointMap: Record<string, { passed: boolean; note: string }> = {
    "5.1": {
      passed: evaluation.checkpoint51,
      note: evaluation.checkpoint51
        ? "Authentication hardening tests passed for invalid token rejection on Telegram and Discord adapters."
        : "Authentication hardening evidence incomplete."
    },
    "5.2": {
      passed: evaluation.checkpoint52,
      note: evaluation.checkpoint52
        ? "Allowlist and provider-selection tests passed for denied non-allowlisted usernames and required runtime provider/username config."
        : "Allowlist enforcement evidence incomplete."
    },
    "5.3": {
      passed: false,
      note: evaluation.checkpoint53Ready
        ? "Rate-limit abuse-control evidence is present (runtime/evidence/stage5_abuse_controls.md); awaiting manual reviewer sign-off."
        : "Rate-limit evidence incomplete."
    },
    "5.4": {
      passed: false,
      note: evaluation.checkpoint54Ready
        ? "Replay/duplicate-handling evidence is present (runtime/evidence/stage5_abuse_controls.md); awaiting manual reviewer sign-off."
        : "Replay/duplicate evidence incomplete."
    },
    "5.5": {
      passed: false,
      note: evaluation.checkpoint55Ready
        ? "Adapter-governance trace evidence is present (runtime/evidence/stage5_governance_trace.md); awaiting manual reviewer sign-off."
        : "Governance-path consistency evidence incomplete."
    },
    "5.6": {
      passed: false,
      note: evaluation.checkpoint56Ready
        ? "In-task conversation continuity evidence is present (ack + queue + status + heartbeat tests); awaiting manual reviewer sign-off."
        : "In-task conversation continuity evidence is pending implementation and validation."
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
    ? "All Stage 5 checkpoints passed. Awaiting final reviewer sign-off."
    : "Stage 5 in progress. Automated checkpoints updated; manual checkpoints still require reviewer evidence.";

  stage.review.signOffRequired = true;
  stage.review.decision = "pending";
  stage.review.signOffRequestedAt = allPassed ? now : null;
  stage.review.signOffRequestedBy = allPassed ? "codex" : null;
  stage.review.signedOffAt = null;
  stage.review.signedOffBy = null;
  stage.review.signOffNotes = allPassed
    ? "Stage 5 evidence prepared. Awaiting final reviewer decision."
    : "Stage 5 evidence updated. Manual checkpoint review still pending.";
}

/**
 * Implements `renderAuthAllowlistNotes` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderAuthAllowlistNotes(generatedAt: string): string {
  return [
    "# Stage 5 Auth and Allowlist Notes",
    "",
    `- Generated At: ${generatedAt}`,
    "",
    "## Covered Tests",
    "1. `telegram adapter rejects unauthorized token requests`",
    "2. `discord adapter rejects unauthorized token requests`",
    "3. `telegram adapter enforces username, user, and chat allowlist`",
    "4. `discord adapter enforces username allowlist`",
    "5. `runtime config selects telegram provider when configured`",
    "6. `runtime config selects discord provider when configured`",
    "7. `runtime config requires at least one allowlisted username`",
    "",
    "## Objective",
    "Verify invalid auth tokens and non-allowlisted identities are blocked before orchestration.",
    ""
  ].join("\n");
}

/**
 * Implements `renderAbuseNotes` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderAbuseNotes(generatedAt: string): string {
  return [
    "# Stage 5 Abuse Controls Notes",
    "",
    `- Generated At: ${generatedAt}`,
    "",
    "## Covered Tests",
    "1. `telegram adapter applies rate-limit controls for burst traffic`",
    "2. `discord adapter applies rate-limit controls for burst traffic`",
    "3. `telegram adapter rejects duplicate update replay attempts`",
    "4. `discord adapter rejects duplicate message replay attempts`",
    "",
    "## Objective",
    "Confirm burst traffic is throttled and replayed events do not produce duplicate execution.",
    ""
  ].join("\n");
}

/**
 * Implements `renderGovernanceTraceNotes` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderGovernanceTraceNotes(generatedAt: string): string {
  return [
    "# Stage 5 Governance Trace Notes",
    "",
    `- Generated At: ${generatedAt}`,
    "",
    "## Covered Tests",
    "1. `telegram adapter routes accepted events through orchestrator governance path`",
    "2. `discord adapter routes accepted events through orchestrator governance path`",
    "",
    "## Trace Assertion",
    "A high-risk delete request enters through the adapter and is blocked by hard constraints in orchestrator path.",
    ""
  ].join("\n");
}

/**
 * Implements `renderEvidenceReport` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderEvidenceReport(evaluation: Stage5Evaluation, generatedAt: string): string {
  return [
    "# Stage 5 Evidence Report",
    "",
    `- Generated At: ${generatedAt}`,
    `- Command: \`npm run test:stage5\``,
    `- Command Status: ${evaluation.commandOk ? "PASS" : "FAIL"}`,
    "",
    "## Automated Checkpoint Summary",
    "",
    `- 5.1 Adapter Authentication Hardening: ${evaluation.checkpoint51 ? "PASS" : "FAIL"}`,
    `- 5.2 Allowlist Enforcement: ${evaluation.checkpoint52 ? "PASS" : "FAIL"}`,
    "",
    "## Manual-Evidence Readiness Signals",
    "",
    `- 5.3 Rate Limit and Abuse Controls evidence present: ${evaluation.checkpoint53Ready ? "YES" : "NO"}`,
    `- 5.4 Replay and Duplicate Handling evidence present: ${evaluation.checkpoint54Ready ? "YES" : "NO"}`,
    `- 5.5 Governance Path Consistency evidence present: ${evaluation.checkpoint55Ready ? "YES" : "NO"}`,
    `- 5.6 In-Task Conversation Continuity evidence present: ${evaluation.checkpoint56Ready ? "YES" : "NO"}`,
    `- Supplemental: conversational approval flow coverage present: ${evaluation.conversationFlowCovered ? "YES" : "NO"}`,
    "",
    "## Test Procedures (Objective, Setup, Steps, Assertions)",
    "",
    "1. Authentication hardening tests (`telegram adapter rejects unauthorized token requests`, `discord adapter rejects unauthorized token requests`)",
    "- Objective: ensure invalid adapter secret/token cannot invoke orchestration on either provider.",
    "- Setup: real adapter harnesses with required token configured for Telegram and Discord.",
    "- Steps: submit inbound messages with incorrect auth token for each provider.",
    "- Assertions: each adapter returns `UNAUTHORIZED`; no orchestration execution result is returned.",
    "",
    "2. Allowlist and provider-selection tests (`telegram adapter enforces username, user, and chat allowlist`, `discord adapter enforces username allowlist`, `runtime config ...`)",
    "- Objective: ensure only configured users can trigger tasks and runtime requires explicit provider + username allowlist.",
    "- Setup: adapter allowlist configured for specific usernames/IDs/channels and runtime config parser seeded with env cases.",
    "- Steps: submit non-allowlisted identities; parse runtime env for telegram/discord and missing allowlist edge case.",
    "- Assertions: adapters return `ALLOWLIST_DENIED`; runtime config accepts only valid providers and rejects missing usernames.",
    "",
    "3. Abuse-control tests (`telegram/discord adapter applies rate-limit controls ...`, `telegram/discord adapter rejects duplicate ...`)",
    "- Objective: block burst and replay traffic from generating repeated executions on both providers.",
    "- Setup: deterministic adapter window (`maxEventsPerWindow=2`) and replay cache enabled in each adapter harness.",
    "- Steps: send three rapid unique events, then replay a previously accepted event identifier for each provider.",
    "- Assertions: third burst event returns `RATE_LIMITED`; replayed event returns `DUPLICATE_EVENT`.",
    "",
    "4. Governance consistency tests (`telegram adapter routes ...`, `discord adapter routes ...`)",
    "- Objective: verify adapter-originated risky requests still traverse hard constraints/governance path for both providers.",
    "- Setup: real `BrainOrchestrator` with default constraints and governors through each adapter harness.",
    "- Steps: send a delete-outside-sandbox request through each adapter message path.",
    "- Assertions: event is accepted by adapter path, but task action is blocked with `DELETE_OUTSIDE_SANDBOX`.",
    "",
    "5. Conversational continuity tests (`conversation manager supports propose -> ask -> adjust -> approve flow`, `conversation manager keeps session responsive with job queue status and heartbeat while work is active`)",
    "- Objective: verify users can refine a draft before approval and continue interacting while active work runs.",
    "- Setup: real conversation manager and session store with local runtime-backed session persistence.",
    "- Steps: create draft (`/propose`), ask follow-up question, adjust, approve; then start long-running work, enqueue follow-up, and query `/status` during active execution.",
    "- Assertions: draft remains pending during Q&A, approval enqueues execution, active work emits heartbeat/progress notifications, follow-up requests are queued, and status reflects running/queued state.",
    "",
    "## Artifact Files",
    "",
    `1. \`${path.relative(process.cwd(), AUTH_ALLOWLIST_PATH)}\``,
    `2. \`${path.relative(process.cwd(), ABUSE_NOTES_PATH)}\``,
    `3. \`${path.relative(process.cwd(), GOVERNANCE_TRACE_PATH)}\``,
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

  const evaluation = await runStage5Validation();
  updateStageFive(stage, evaluation);
  recomputeScore(ledger);

  const generatedAt = new Date().toISOString();
  await writeFile(SCOREBOARD_PATH, JSON.stringify(ledger, null, 2), "utf8");
  await mkdir(path.dirname(EVIDENCE_REPORT_PATH), { recursive: true });
  await writeFile(EVIDENCE_REPORT_PATH, renderEvidenceReport(evaluation, generatedAt), "utf8");
  await writeFile(AUTH_ALLOWLIST_PATH, renderAuthAllowlistNotes(generatedAt), "utf8");
  await writeFile(ABUSE_NOTES_PATH, renderAbuseNotes(generatedAt), "utf8");
  await writeFile(GOVERNANCE_TRACE_PATH, renderGovernanceTraceNotes(generatedAt), "utf8");

  console.log(`Stage 5 checkpoint 5.1: ${evaluation.checkpoint51 ? "PASS" : "FAIL"}`);
  console.log(`Stage 5 checkpoint 5.2: ${evaluation.checkpoint52 ? "PASS" : "FAIL"}`);
  console.log(`Stage 5 manual readiness 5.3: ${evaluation.checkpoint53Ready ? "READY" : "NOT_READY"}`);
  console.log(`Stage 5 manual readiness 5.4: ${evaluation.checkpoint54Ready ? "READY" : "NOT_READY"}`);
  console.log(`Stage 5 manual readiness 5.5: ${evaluation.checkpoint55Ready ? "READY" : "NOT_READY"}`);
  console.log(`Stage 5 manual readiness 5.6: ${evaluation.checkpoint56Ready ? "READY" : "NOT_READY"}`);
  console.log(`Stage ledger updated: ${SCOREBOARD_PATH}`);
  console.log(`Evidence report: ${EVIDENCE_REPORT_PATH}`);
}

void main();
