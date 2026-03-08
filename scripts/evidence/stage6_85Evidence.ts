/**
 * @fileoverview Runs Stage 6.85 checkpoint readiness checks, updates stage progress notes, and emits reviewer artifacts.
 */

import { exec as execCallback } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { TEST_REVIEWER_HANDLE } from "../../tests/support/windowsPathFixtures";

const exec = promisify(execCallback);
const STAGE_ID = "stage_6_85_it_just_works_orchestration";
const SCOREBOARD_PATH = path.resolve(process.cwd(), "runtime/reward_score.json");
const PACKAGE_JSON_PATH = path.resolve(process.cwd(), "package.json");
const EVIDENCE_REPORT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_85_evidence.md");
const MANUAL_READINESS_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_85_manual_readiness.md"
);
const LIVE_REVIEW_CHECKLIST_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_85_live_review_checklist.md"
);
const LIVE_SMOKE_REPORT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_85_live_smoke_report.json"
);

type CheckpointId =
  | "6.85.A"
  | "6.85.B"
  | "6.85.C"
  | "6.85.D"
  | "6.85.E"
  | "6.85.F"
  | "6.85.G"
  | "6.85.H";

interface CommandResult {
  scriptName: string;
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

interface PackageJsonScripts {
  scripts?: Record<string, string>;
}

interface CheckpointEvidenceResult {
  id: CheckpointId;
  commandResult: CommandResult;
  artifactPaths: readonly string[];
  artifactChecks: readonly {
    path: string;
    exists: boolean;
  }[];
  ready: boolean;
}

interface AuxiliaryEvidenceResult {
  label: "stage_suite" | "claim_audit" | "live_smoke";
  commandResult: CommandResult;
  artifactPath: string | null;
  artifactExists: boolean;
  artifactReady: boolean;
  ready: boolean;
}

interface Stage685LiveSmokeReport {
  status: "PASS" | "FAIL";
  summary: {
    passCriteria: {
      overallPass: boolean;
    };
  };
}

interface Stage685Evaluation {
  checkpointResults: Record<CheckpointId, CheckpointEvidenceResult>;
  auxiliaryResults: readonly AuxiliaryEvidenceResult[];
  readinessComplete: boolean;
}

/**
 * Implements `runCommand` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runCommand(scriptName: string): Promise<CommandResult> {
  const command = `npm run ${scriptName}`;
  try {
    const { stdout, stderr } = await exec(command, { cwd: process.cwd() });
    return {
      scriptName,
      command,
      ok: true,
      output: [stdout, stderr].filter(Boolean).join("\n")
    };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    return {
      scriptName,
      command,
      ok: false,
      output: [err.stdout ?? "", err.stderr ?? "", err.message].filter(Boolean).join("\n")
    };
  }
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
 * Implements `toAsciiLog` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function toAsciiLog(value: string): string {
  return value.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?");
}

/**
 * Implements `stripUtf8Bom` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function stripUtf8Bom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

/**
 * Implements `artifactExists` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function artifactExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Implements `readPackageScripts` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function readPackageScripts(): Promise<ReadonlySet<string>> {
  try {
    const raw = await readFile(PACKAGE_JSON_PATH, "utf8");
    const parsed = JSON.parse(stripUtf8Bom(raw)) as PackageJsonScripts;
    const scripts = parsed.scripts ?? {};
    return new Set(Object.keys(scripts));
  } catch {
    return new Set();
  }
}

/**
 * Implements `runKnownOrMissingScript` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runKnownOrMissingScript(
  availableScripts: ReadonlySet<string>,
  scriptName: string
): Promise<CommandResult> {
  if (!availableScripts.has(scriptName)) {
    return {
      scriptName,
      command: `npm run ${scriptName}`,
      ok: false,
      output: `Script '${scriptName}' is not defined in package.json.`
    };
  }
  return runCommand(scriptName);
}

/**
 * Implements `evaluateCheckpoint` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function evaluateCheckpoint(
  availableScripts: ReadonlySet<string>,
  id: CheckpointId,
  scriptName: string,
  artifactPaths: readonly string[]
): Promise<CheckpointEvidenceResult> {
  const commandResult = await runKnownOrMissingScript(availableScripts, scriptName);
  const artifactChecks = await Promise.all(
    artifactPaths.map(async (artifactPath) => ({
      path: artifactPath,
      exists: await artifactExists(artifactPath)
    }))
  );
  return {
    id,
    commandResult,
    artifactPaths,
    artifactChecks,
    ready: commandResult.ok && artifactChecks.every((check) => check.exists)
  };
}

/**
 * Implements `evaluateAuxiliaryGate` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function evaluateAuxiliaryGate(
  availableScripts: ReadonlySet<string>,
  label: AuxiliaryEvidenceResult["label"],
  scriptName: string,
  artifactPath: string | null
): Promise<AuxiliaryEvidenceResult> {
  const commandResult = await runKnownOrMissingScript(availableScripts, scriptName);
  const artifactPresent = artifactPath === null ? true : await artifactExists(artifactPath);
  const artifactReady = artifactPresent;
  return {
    label,
    commandResult,
    artifactPath,
    artifactExists: artifactPresent,
    artifactReady,
    ready: commandResult.ok && artifactReady
  };
}

/**
 * Implements `isStage685LiveSmokeReport` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isStage685LiveSmokeReport(value: unknown): value is Stage685LiveSmokeReport {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<Stage685LiveSmokeReport>;
  if (record.status !== "PASS" && record.status !== "FAIL") {
    return false;
  }
  if (!record.summary || typeof record.summary !== "object") {
    return false;
  }
  const summary = record.summary as Stage685LiveSmokeReport["summary"];
  if (!summary.passCriteria || typeof summary.passCriteria !== "object") {
    return false;
  }
  return typeof summary.passCriteria.overallPass === "boolean";
}

/**
 * Implements `readStage685LiveSmokeReport` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function readStage685LiveSmokeReport(filePath: string): Promise<Stage685LiveSmokeReport | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(stripUtf8Bom(raw));
    if (!isStage685LiveSmokeReport(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Implements `evaluateLiveSmokeGate` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function evaluateLiveSmokeGate(
  availableScripts: ReadonlySet<string>
): Promise<AuxiliaryEvidenceResult> {
  const scriptName = "test:stage6_85:live_smoke";
  const commandResult = await runKnownOrMissingScript(availableScripts, scriptName);
  const artifactPresent = await artifactExists(LIVE_SMOKE_REPORT_PATH);
  const report = artifactPresent ? await readStage685LiveSmokeReport(LIVE_SMOKE_REPORT_PATH) : null;
  const artifactReady =
    artifactPresent &&
    report !== null &&
    report.status === "PASS" &&
    report.summary.passCriteria.overallPass;
  return {
    label: "live_smoke",
    commandResult,
    artifactPath: LIVE_SMOKE_REPORT_PATH,
    artifactExists: artifactPresent,
    artifactReady,
    ready: commandResult.ok && artifactReady
  };
}

/**
 * Implements `evaluateStage685` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function evaluateStage685(): Promise<Stage685Evaluation> {
  const availableScripts = await readPackageScripts();
  const checkpointResults: Record<CheckpointId, CheckpointEvidenceResult> = {
    "6.85.A": await evaluateCheckpoint(
      availableScripts,
      "6.85.A",
      "test:stage6_85:playbooks",
      [
        path.resolve(process.cwd(), "runtime/evidence/stage6_85_playbooks_report.json"),
        path.resolve(process.cwd(), "runtime/playbooks/playbook_registry.json")
      ]
    ),
    "6.85.B": await evaluateCheckpoint(
      availableScripts,
      "6.85.B",
      "test:stage6_85:mission_ux",
      [path.resolve(process.cwd(), "runtime/evidence/stage6_85_mission_ux_report.json")]
    ),
    "6.85.C": await evaluateCheckpoint(
      availableScripts,
      "6.85.C",
      "test:stage6_85:clones",
      [
        path.resolve(process.cwd(), "runtime/evidence/stage6_85_clones_report.json"),
        path.resolve(process.cwd(), "runtime/evidence/stage6_85_clones_distiller_ledger.json")
      ]
    ),
    "6.85.D": await evaluateCheckpoint(
      availableScripts,
      "6.85.D",
      "test:stage6_85:recovery",
      [
        path.resolve(process.cwd(), "runtime/evidence/stage6_85_recovery_report.json"),
        path.resolve(process.cwd(), "runtime/evidence/mission_stage6_85_recovery_postmortem.json")
      ]
    ),
    "6.85.E": await evaluateCheckpoint(
      availableScripts,
      "6.85.E",
      "test:stage6_85:quality_gates",
      [path.resolve(process.cwd(), "runtime/evidence/stage6_85_quality_gates_report.json")]
    ),
    "6.85.F": await evaluateCheckpoint(
      availableScripts,
      "6.85.F",
      "test:stage6_85:workflow_replay",
      [path.resolve(process.cwd(), "runtime/evidence/stage6_85_workflow_replay_report.json")]
    ),
    "6.85.G": await evaluateCheckpoint(
      availableScripts,
      "6.85.G",
      "test:stage6_85:latency",
      [path.resolve(process.cwd(), "runtime/evidence/stage6_85_latency_report.json")]
    ),
    "6.85.H": await evaluateCheckpoint(
      availableScripts,
      "6.85.H",
      "test:stage6_85:observability",
      [path.resolve(process.cwd(), "runtime/evidence/stage6_85_observability_report.json")]
    )
  };

  const auxiliaryResults = [
    await evaluateAuxiliaryGate(availableScripts, "stage_suite", "test:stage6_85", null),
    await evaluateLiveSmokeGate(availableScripts),
    await evaluateAuxiliaryGate(
      availableScripts,
      "claim_audit",
      "audit:claims",
      path.resolve(process.cwd(), "runtime/evidence/claim_audit_report.json")
    )
  ] as const;

  const checkpointReady = Object.values(checkpointResults).every((result) => result.ready);
  const auxiliaryReady = auxiliaryResults.every((result) => result.ready);
  return {
    checkpointResults,
    auxiliaryResults,
    readinessComplete: checkpointReady && auxiliaryReady
  };
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
 * Implements `buildCheckpointNote` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildCheckpointNote(result: CheckpointEvidenceResult): string {
  if (result.ready) {
    return `Checkpoint ${result.id} evidence command and artifact are present; awaiting manual reviewer sign-off.`;
  }

  const detail: string[] = [];
  if (!result.commandResult.ok) {
    detail.push(`command '${result.commandResult.scriptName}' did not pass`);
  }
  const missingArtifacts = result.artifactChecks
    .filter((check) => !check.exists)
    .map((check) => path.relative(process.cwd(), check.path));
  if (missingArtifacts.length > 0) {
    detail.push(`missing artifacts: ${missingArtifacts.join(", ")}`);
  }

  if (detail.length === 0) {
    return `Checkpoint ${result.id} readiness evidence is incomplete.`;
  }
  return `Checkpoint ${result.id} readiness evidence is incomplete: ${detail.join("; ")}.`;
}

/**
 * Implements `updateStage685` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function updateStage685(stage: StageLedger, evaluation: Stage685Evaluation): void {
  const now = new Date().toISOString();
  const manualCheckpointIds = new Set<CheckpointId>([
    "6.85.A",
    "6.85.B",
    "6.85.C",
    "6.85.D",
    "6.85.E",
    "6.85.F",
    "6.85.G",
    "6.85.H"
  ]);
  const isManualCheckpoint = (id: string): id is CheckpointId => manualCheckpointIds.has(id as CheckpointId);
  const isAlreadyReviewerApproved = stage.status === "awarded" && stage.review.decision === "approved";

  for (const checkpoint of stage.checkpoints) {
    if (!isManualCheckpoint(checkpoint.id)) {
      continue;
    }

    const checkpointResult = evaluation.checkpointResults[checkpoint.id];
    if (checkpoint.status === "passed") {
      applyCheckpointResult(checkpoint, true, checkpoint.lastNote, now);
      continue;
    }

    applyCheckpointResult(checkpoint, false, buildCheckpointNote(checkpointResult), now);
  }

  const allPassed = stage.checkpoints.every((checkpoint) => checkpoint.status === "passed");
  if (isAlreadyReviewerApproved && allPassed) {
    stage.lastCheckedAt = now;
    stage.lastPassed = true;
    return;
  }

  const failingCheckpointIds = Object.values(evaluation.checkpointResults)
    .filter((result) => !result.ready)
    .map((result) => result.id);
  const failingAuxiliaryGates = evaluation.auxiliaryResults
    .filter((result) => !result.ready)
    .map((result) => result.label);

  stage.lastCheckedAt = now;
  stage.lastPassed = allPassed;
  stage.status = allPassed ? "ready_for_review" : "pending";
  stage.lastNote = allPassed
    ? "All Stage 6.85 checkpoints passed. Awaiting final reviewer sign-off."
    : evaluation.readinessComplete
      ? "Stage 6.85 is evidence-ready for manual reviewer sign-off."
      : `Stage 6.85 evidence is incomplete. Pending checkpoints: ${
          failingCheckpointIds.length > 0 ? failingCheckpointIds.join(", ") : "none"
        }; pending gates: ${failingAuxiliaryGates.length > 0 ? failingAuxiliaryGates.join(", ") : "none"}.`;

  stage.review.signOffRequired = true;
  stage.review.decision = "pending";
  stage.review.signOffRequestedAt = allPassed || evaluation.readinessComplete ? now : null;
  stage.review.signOffRequestedBy = allPassed || evaluation.readinessComplete ? "codex" : null;
  stage.review.signOffNotes = allPassed
    ? "All Stage 6.85 checkpoints passed. Awaiting final reviewer decision."
    : evaluation.readinessComplete
      ? "All Stage 6.85 checkpoint evidence artifacts are present. Awaiting manual checkpoint decisions and final reviewer sign-off."
      : "Stage 6.85 evidence collection is incomplete; complete checkpoint artifacts and auxiliary gates before requesting sign-off.";
}

/**
 * Implements `formatReadiness` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function formatReadiness(value: boolean): string {
  return value ? "READY" : "NOT_READY";
}

/**
 * Implements `buildCheckpointArtifactLines` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildCheckpointArtifactLines(result: CheckpointEvidenceResult): string[] {
  return result.artifactChecks.map((check) => {
    const relativePath = path.relative(process.cwd(), check.path);
    return `- Artifact: \`${relativePath}\` -> ${check.exists ? "FOUND" : "MISSING"}`;
  });
}

/**
 * Implements `buildEvidenceReport` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildEvidenceReport(evaluation: Stage685Evaluation): string {
  const checkpointLines = Object.values(evaluation.checkpointResults).flatMap((result) => [
    `### ${result.id}`,
    `- Script: \`${result.commandResult.scriptName}\` -> ${result.commandResult.ok ? "PASS" : "FAIL"}`,
    ...buildCheckpointArtifactLines(result),
    `- Checkpoint readiness: ${formatReadiness(result.ready)}`,
    "```text",
    toAsciiLog(result.commandResult.output || "(no command output)"),
    "```"
  ]);

  const auxiliaryLines = evaluation.auxiliaryResults.flatMap((result) => {
    const artifactLine =
      result.artifactPath === null
        ? "- Artifact: (none required)"
        : `- Artifact: \`${path.relative(process.cwd(), result.artifactPath)}\` -> ${
            result.artifactExists ? "FOUND" : "MISSING"
          }`;
    const artifactReadinessLine =
      result.artifactPath === null
        ? "- Artifact readiness: not_applicable"
        : `- Artifact readiness: ${result.artifactReady ? "PASS" : "FAIL"}`;
    return [
      `### ${result.label}`,
      `- Script: \`${result.commandResult.scriptName}\` -> ${result.commandResult.ok ? "PASS" : "FAIL"}`,
      artifactLine,
      artifactReadinessLine,
      `- Gate readiness: ${formatReadiness(result.ready)}`,
      "```text",
      toAsciiLog(result.commandResult.output || "(no command output)"),
      "```"
    ];
  });

  return [
    "# Stage 6.85 Evidence Report",
    "",
    `- Stage: \`${STAGE_ID}\``,
    `- GeneratedAt: \`${new Date().toISOString()}\``,
    `- Overall readiness: ${formatReadiness(evaluation.readinessComplete)}`,
    "",
    "## Checkpoint Commands and Artifacts",
    ...checkpointLines,
    "",
    "## Auxiliary Gates",
    ...auxiliaryLines
  ].join("\n");
}

/**
 * Implements `buildManualReadinessReport` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildManualReadinessReport(evaluation: Stage685Evaluation): string {
  const checkpointStatusLines = Object.values(evaluation.checkpointResults).map((result) => {
    const artifactSummary = result.artifactChecks
      .map((check) => `${path.relative(process.cwd(), check.path)}=${check.exists ? "FOUND" : "MISSING"}`)
      .join(", ");
    return `- ${result.id}: ${formatReadiness(result.ready)} (script: ${result.commandResult.scriptName}, artifacts: ${artifactSummary})`;
  });
  const auxiliaryStatusLines = evaluation.auxiliaryResults.map((result) => {
    const artifactPart = result.artifactPath === null
      ? "no artifact requirement"
      : `artifact: ${path.relative(process.cwd(), result.artifactPath)} (${result.artifactExists ? "FOUND" : "MISSING"}, readiness=${result.artifactReady ? "PASS" : "FAIL"})`;
    return `- ${result.label}: ${formatReadiness(result.ready)} (script: ${result.commandResult.scriptName}, ${artifactPart})`;
  });

  const unresolvedItems = [
    ...Object.values(evaluation.checkpointResults)
      .filter((result) => !result.ready)
      .map((result) => `${result.id} (${result.commandResult.scriptName})`),
    ...evaluation.auxiliaryResults
      .filter((result) => !result.ready)
      .map((result) => `${result.label} (${result.commandResult.scriptName})`)
  ];

  return [
    "# Stage 6.85 Manual Readiness",
    "",
    `- Stage: \`${STAGE_ID}\``,
    `- GeneratedAt: \`${new Date().toISOString()}\``,
    `- Overall readiness: ${formatReadiness(evaluation.readinessComplete)}`,
    "",
    "## Checkpoint Readiness",
    ...checkpointStatusLines,
    "",
    "## Auxiliary Gate Readiness",
    ...auxiliaryStatusLines,
    "",
    "## Remaining Blocks",
    unresolvedItems.length === 0
      ? "- None. Stage is ready for full manual checkpoint pass/fail execution."
      : `- ${unresolvedItems.join(", ")}`
  ].join("\n");
}

/**
 * Implements `buildLiveReviewChecklist` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildLiveReviewChecklist(evaluation: Stage685Evaluation): string {
  return [
    "# Stage 6.85 Live Review Checklist",
    "",
    `- Stage: \`${STAGE_ID}\``,
    `- GeneratedAt: \`${new Date().toISOString()}\``,
    `- Reviewer: \`${TEST_REVIEWER_HANDLE}\``,
    `- Preflight readiness: \`${formatReadiness(evaluation.readinessComplete)}\``,
    "- Goal: run scenario-first manual review and confirm every checkpoint artifact before sign-off.",
    "",
    "## Automated Preflight (Already Run)",
    "1. `npm run test:stage6_85:evidence`",
    "2. `npm run test:stage6_85`",
    "3. `npm run test:stage6_85:live_smoke`",
    "4. `npm run audit:claims`",
    "",
    "## Environment Setup (Telegram Runtime)",
    "```powershell",
    "$env:BRAIN_MODEL_BACKEND=\"openai\"",
    "$env:OPENAI_API_KEY=\"<your_openai_key>\"",
    "$env:BRAIN_INTERFACE_PROVIDER=\"telegram\"",
    "$env:TELEGRAM_BOT_TOKEN=\"<your_telegram_bot_token>\"",
    "$env:BRAIN_INTERFACE_ALLOWED_USERNAMES=\"<your_telegram_username>\"",
    "$env:BRAIN_INTERFACE_REQUIRE_NAME_CALL=\"true\"",
    "$env:BRAIN_INTERFACE_NAME_ALIASES=\"BigBrain\"",
    "npm run dev:interface",
    "```",
    "",
    "## Scenario-First Prompts (Telegram)",
    "1. `BigBrain /chat Research deterministic sandboxing controls and provide distilled findings with proof refs.`",
    "2. `BigBrain /chat Build a minimal deterministic TypeScript CLI scaffold with README, runbook, and tests.`",
    "3. `BigBrain /chat Schedule 3 focus blocks next week and show exact approval diff before any write.`",
    "4. `BigBrain /chat Capture this browser workflow, compile replay steps, and block if selector drift appears.`",
    "",
    "## Checkpoint 6.85.A - Playbook System",
    "Telegram examples:",
    "1. `BigBrain /chat Build and test a deterministic TypeScript CLI scaffold, then propose a reusable playbook candidate if this workflow is repeatable.`",
    "2. `BigBrain /chat For this unfamiliar request, explain when you must fall back to normal planning instead of selecting a playbook.`",
    "Live checks:",
    "1. Run `npm run test:stage6_85:playbooks`.",
    "2. Open `runtime/evidence/stage6_85_playbooks_report.json` and `runtime/playbooks/playbook_registry.json`.",
    "3. Confirm candidate compile, registry envelope hash validation, deterministic selection, and fallback behavior are all true.",
    "4. Confirm `passCriteria.overallPass=true`.",
    "",
    "## Checkpoint 6.85.B - Mission UX Coherence",
    "Telegram examples:",
    "1. `BigBrain /chat Show what will run, what ran, and why mission is blocked or waiting for approval.`",
    "2. `BigBrain /chat Show exact approval diff and wait for step-level approval.`",
    "Live checks:",
    "1. Run `npm run test:stage6_85:mission_ux`.",
    "2. Open `runtime/evidence/stage6_85_mission_ux_report.json`.",
    "3. Confirm deterministic mission states and conservative fail-closed approval fallback (`approve_step`).",
    "4. Confirm `passCriteria.overallPass=true`.",
    "",
    "## Checkpoint 6.85.C - Clone Workflow Integration",
    "Telegram examples:",
    "1. `BigBrain /chat Generate two clone-assisted plan variants and merge only safe packets.`",
    "2. `BigBrain /chat Show why non-mergeable clone packet kinds are blocked.`",
    "Live checks:",
    "1. Run `npm run test:stage6_85:clones`.",
    "2. Open `runtime/evidence/stage6_85_clones_report.json` and `runtime/evidence/stage6_85_clones_distiller_ledger.json`.",
    "3. Confirm deterministic bounds, queue validation, packet envelope validation, and side-effect denial for clones.",
    "4. Confirm `passCriteria.overallPass=true`.",
    "",
    "## Checkpoint 6.85.D - Reliability and Recovery",
    "Telegram examples:",
    "1. `BigBrain /chat Continue the same mission safely after interruption and resume from the last durable checkpoint.`",
    "2. `BigBrain /chat Retry this blocked step repeatedly and show when retry budget is exhausted and mission stop limit is reached.`",
    "Live checks:",
    "1. Run `npm run test:stage6_85:recovery`.",
    "2. Open `runtime/evidence/stage6_85_recovery_report.json` and `runtime/evidence/mission_stage6_85_recovery_postmortem.json`.",
    "3. Confirm bounded retry behavior (`MISSION_STOP_LIMIT_REACHED`) and resume safety blocks (`STATE_STALE_REPLAN_REQUIRED`, `APPROVAL_DIFF_HASH_MISMATCH`).",
    "4. Confirm `passCriteria.overallPass=true`.",
    "",
    "## Checkpoint 6.85.E - Quality Gates and Anti-Flake",
    "Telegram examples:",
    "1. `BigBrain /chat Claim this task is complete only if deterministic proof artifacts exist; otherwise block the done claim.`",
    "2. `BigBrain /chat If execution is simulated, label it explicitly as simulated and do not present it as completed.`",
    "Live checks:",
    "1. Run `npm run test:stage6_85:quality_gates`.",
    "2. Open `runtime/evidence/stage6_85_quality_gates_report.json`.",
    "3. Confirm Definition-of-Done profiles, deterministic verification gates, and truthfulness blocks for optimistic or unlabeled simulation text.",
    "4. Confirm `passCriteria.overallPass=true`.",
    "",
    "## Checkpoint 6.85.F - Workflow Capture -> Compile -> Replay",
    "Telegram examples:",
    "1. `BigBrain /chat Capture this flow, compile replay script, and block on selector mismatch.`",
    "Live checks:",
    "1. Run `npm run test:stage6_85:workflow_replay`.",
    "2. Open `runtime/evidence/stage6_85_workflow_replay_report.json`.",
    "3. Confirm `actionFamily:computer_use` bridge parity (`actionTypeBridge=run_skill`) and typed drift block (`WORKFLOW_DRIFT_DETECTED`).",
    "4. Confirm `passCriteria.overallPass=true`.",
    "",
    "## Checkpoint 6.85.G - Performance and Latency",
    "Telegram examples:",
    "1. `BigBrain /chat Keep this mission interactive under latency budgets and tell me if any phase exceeded its budget.`",
    "2. `BigBrain /chat Reuse safe deterministic cache paths but do not add extra model calls beyond baseline behavior.`",
    "Live checks:",
    "1. Run `npm run test:stage6_85:latency`.",
    "2. Open `runtime/evidence/stage6_85_latency_report.json`.",
    "3. Confirm phase-budget pass/fail behavior, cache baseline-equivalence gate, and deterministic deny-summary shaping.",
    "4. Confirm `passCriteria.overallPass=true`.",
    "",
    "## Checkpoint 6.85.H - Operator Observability",
    "Telegram examples:",
    "1. `BigBrain /chat Show the ordered mission timeline for the last run and explain the deterministic remediation for any failure.`",
    "2. `BigBrain /chat Export a redacted evidence bundle for this Stage 6.85 review.`",
    "Live checks:",
    "1. Run `npm run test:stage6_85:observability`.",
    "2. Open `runtime/evidence/stage6_85_observability_report.json`.",
    "3. Confirm ordered mission timeline, deterministic failure remediations for workflow drift, and bounded redacted bundle profile.",
    "4. Confirm `passCriteria.overallPass=true`.",
    "",
    "## Final Gate",
    "1. Run `npm run audit:claims` and confirm `runtime/evidence/claim_audit_report.json` reports pass.",
    "2. Record explicit manual pass/fail decision for each checkpoint `6.85.A` to `6.85.H`.",
    "3. Do not mark the stage awarded until final reviewer sign-off is recorded in `runtime/reward_score.json`.",
    "",
    "## Required Artifacts",
    "1. `runtime/evidence/stage6_85_evidence.md`",
    "2. `runtime/evidence/stage6_85_manual_readiness.md`",
    "3. `runtime/evidence/stage6_85_live_review_checklist.md`",
    "4. `runtime/evidence/stage6_85_playbooks_report.json`",
    "5. `runtime/evidence/stage6_85_mission_ux_report.json`",
    "6. `runtime/evidence/stage6_85_clones_report.json`",
    "7. `runtime/evidence/stage6_85_recovery_report.json`",
    "8. `runtime/evidence/stage6_85_quality_gates_report.json`",
    "9. `runtime/evidence/stage6_85_workflow_replay_report.json`",
    "10. `runtime/evidence/stage6_85_latency_report.json`",
    "11. `runtime/evidence/stage6_85_observability_report.json`",
    "12. `runtime/evidence/stage6_85_live_smoke_report.json`",
    "13. `runtime/evidence/claim_audit_report.json`",
    "14. `runtime/reward_score.json`"
  ].join("\n");
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const ledgerRaw = await readFile(SCOREBOARD_PATH, "utf8");
  const ledger = JSON.parse(stripUtf8Bom(ledgerRaw)) as RewardLedger;
  const stage = ledger.stages.find((candidate) => candidate.id === STAGE_ID);
  if (!stage) {
    throw new Error(`Stage '${STAGE_ID}' was not found in runtime/reward_score.json.`);
  }

  const evaluation = await evaluateStage685();
  updateStage685(stage, evaluation);
  recomputeScore(ledger);

  const scoreboardJson = `${JSON.stringify(ledger, null, 2)}\n`;
  const evidenceReport = `${buildEvidenceReport(evaluation)}\n`;
  const manualReadinessReport = `${buildManualReadinessReport(evaluation)}\n`;
  const liveReviewChecklist = `${buildLiveReviewChecklist(evaluation)}\n`;

  await mkdir(path.dirname(SCOREBOARD_PATH), { recursive: true });
  await mkdir(path.dirname(EVIDENCE_REPORT_PATH), { recursive: true });
  await writeFile(SCOREBOARD_PATH, scoreboardJson, "utf8");
  await writeFile(EVIDENCE_REPORT_PATH, evidenceReport, "utf8");
  await writeFile(MANUAL_READINESS_PATH, manualReadinessReport, "utf8");
  await writeFile(LIVE_REVIEW_CHECKLIST_PATH, liveReviewChecklist, "utf8");

  console.log(`Stage 6.85 evidence readiness: ${formatReadiness(evaluation.readinessComplete)}`);
  console.log(`Stage ledger updated: ${SCOREBOARD_PATH}`);
  console.log(`Evidence report: ${EVIDENCE_REPORT_PATH}`);
  console.log(`Manual readiness: ${MANUAL_READINESS_PATH}`);
  console.log(`Live review checklist: ${LIVE_REVIEW_CHECKLIST_PATH}`);
}

void main();
