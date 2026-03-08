/**
 * @fileoverview Runs Stage 6.86 checkpoint evidence commands, validates artifact readiness, and emits reviewer-ready evidence summaries.
 */

import { exec as execCallback } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { TEST_REVIEWER_HANDLE } from "../../tests/support/windowsPathFixtures";

const exec = promisify(execCallback);

const STAGE_ID = "stage_6_86_dynamic_relationship_memory_and_threaded_pulse";
const PACKAGE_JSON_PATH = path.resolve(process.cwd(), "package.json");
const SCOREBOARD_PATH = path.resolve(process.cwd(), "runtime/reward_score.json");
const EVIDENCE_REPORT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_86_evidence.md");
const MANUAL_READINESS_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_86_manual_readiness.md"
);
const LIVE_REVIEW_CHECKLIST_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_86_live_review_checklist.md"
);
const LIVE_SMOKE_SCRIPT = "test:stage6_86:live_smoke";
const LIVE_SMOKE_ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_86_live_smoke_report.json"
);
const ADVANCED_LIVE_SMOKE_SCRIPT = "test:stage6_86:advanced_live_smoke";
const ADVANCED_LIVE_SMOKE_ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_86_advanced_live_smoke_report.json"
);

interface CommandResult {
  scriptName: string;
  command: string;
  ok: boolean;
  output: string;
}

interface PackageJsonScripts {
  scripts?: Record<string, string>;
}

type CheckpointId =
  | "6.86.A"
  | "6.86.B"
  | "6.86.C"
  | "6.86.D"
  | "6.86.E"
  | "6.86.F"
  | "6.86.G"
  | "6.86.H";

interface CheckpointDefinition {
  id: CheckpointId;
  scriptName: string;
  artifactPath: string;
}

interface CheckpointEvaluation {
  id: CheckpointId;
  scriptName: string;
  commandResult: CommandResult;
  artifactPath: string;
  artifactExists: boolean;
  artifactPass: boolean;
  ready: boolean;
}

interface Stage686EvidenceResult {
  generatedAt: string;
  command: string;
  checkpoints: readonly CheckpointEvaluation[];
  liveSmoke: CommandResult;
  liveSmokeArtifactExists: boolean;
  liveSmokeArtifactPass: boolean;
  advancedLiveSmoke: CommandResult;
  advancedLiveSmokeArtifactExists: boolean;
  advancedLiveSmokeArtifactPass: boolean;
  stageSuite: CommandResult;
  claimAudit: CommandResult;
  readinessComplete: boolean;
}

const CHECKPOINTS: readonly CheckpointDefinition[] = [
  {
    id: "6.86.A",
    scriptName: "test:stage6_86:entities",
    artifactPath: path.resolve(process.cwd(), "runtime/evidence/stage6_86_entities_report.json")
  },
  {
    id: "6.86.B",
    scriptName: "test:stage6_86:entity_graph",
    artifactPath: path.resolve(process.cwd(), "runtime/evidence/stage6_86_entity_graph_report.json")
  },
  {
    id: "6.86.C",
    scriptName: "test:stage6_86:conversation_stack",
    artifactPath: path.resolve(process.cwd(), "runtime/evidence/stage6_86_conversation_stack_report.json")
  },
  {
    id: "6.86.D",
    scriptName: "test:stage6_86:open_loops",
    artifactPath: path.resolve(process.cwd(), "runtime/evidence/stage6_86_open_loops_report.json")
  },
  {
    id: "6.86.E",
    scriptName: "test:stage6_86:pulse_candidates",
    artifactPath: path.resolve(process.cwd(), "runtime/evidence/stage6_86_pulse_candidates_report.json")
  },
  {
    id: "6.86.F",
    scriptName: "test:stage6_86:bridge",
    artifactPath: path.resolve(process.cwd(), "runtime/evidence/stage6_86_bridge_report.json")
  },
  {
    id: "6.86.G",
    scriptName: "test:stage6_86:memory_governance",
    artifactPath: path.resolve(process.cwd(), "runtime/evidence/stage6_86_memory_governance_report.json")
  },
  {
    id: "6.86.H",
    scriptName: "test:stage6_86:ux",
    artifactPath: path.resolve(process.cwd(), "runtime/evidence/stage6_86_ux_report.json")
  }
] as const;

/**
 * Implements `toAsciiLog` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function toAsciiLog(value: string): string {
  return value.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?");
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
 * Implements `stripUtf8Bom` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function stripUtf8Bom(value: string): string {
  return value.replace(/^\uFEFF/, "");
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
 * Implements `collectPendingEvidenceGates` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function collectPendingEvidenceGates(result: Stage686EvidenceResult): readonly string[] {
  const checkpointFailures = result.checkpoints
    .filter((checkpoint) => !checkpoint.ready)
    .map((checkpoint) => checkpoint.id);
  return [
    ...checkpointFailures,
    ...(!result.liveSmoke.ok ? ["live_smoke_command"] : []),
    ...(result.liveSmoke.ok && !result.liveSmokeArtifactExists ? ["live_smoke_artifact_missing"] : []),
    ...(result.liveSmoke.ok &&
    result.liveSmokeArtifactExists &&
    !result.liveSmokeArtifactPass
      ? ["live_smoke_artifact_fail"]
      : []),
    ...(!result.advancedLiveSmoke.ok ? ["advanced_live_smoke_command"] : []),
    ...(result.advancedLiveSmoke.ok && !result.advancedLiveSmokeArtifactExists
      ? ["advanced_live_smoke_artifact_missing"]
      : []),
    ...(result.advancedLiveSmoke.ok &&
    result.advancedLiveSmokeArtifactExists &&
    !result.advancedLiveSmokeArtifactPass
      ? ["advanced_live_smoke_artifact_fail"]
      : []),
    ...(!result.stageSuite.ok ? ["stage_suite"] : []),
    ...(!result.claimAudit.ok ? ["claim_audit"] : [])
  ];
}

/**
 * Implements `updateRewardLedgerWithStage686Evidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function updateRewardLedgerWithStage686Evidence(result: Stage686EvidenceResult): Promise<void> {
  try {
    const raw = await readFile(SCOREBOARD_PATH, "utf8");
    const ledger = JSON.parse(stripUtf8Bom(raw)) as {
      score?: {
        totalStages?: number;
        awardedStages?: number;
        stagePercent?: number;
        totalCheckpoints?: number;
        passedCheckpoints?: number;
        checkpointPercent?: number;
      };
      stages?: Array<Record<string, unknown>>;
    };
    const stages = Array.isArray(ledger.stages) ? ledger.stages : [];
    const stage = stages.find((entry) => entry.id === STAGE_ID) as
      | (Record<string, unknown> & {
          checkpoints?: Array<Record<string, unknown>>;
          review?: Record<string, unknown>;
        })
      | undefined;
    if (!stage) {
      return;
    }

    const now = new Date().toISOString();
    const byId = new Map(result.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
    const checkpoints = Array.isArray(stage.checkpoints) ? stage.checkpoints : [];
    for (const checkpoint of checkpoints) {
      const id = checkpoint.id;
      if (typeof id !== "string") {
        continue;
      }
      const evaluation = byId.get(id as CheckpointId);
      if (!evaluation) {
        continue;
      }
      checkpoint.lastCheckedAt = now;
      checkpoint.lastPassed = evaluation.ready;
      checkpoint.lastNote = evaluation.ready
        ? `Evidence verified via ${evaluation.scriptName} and ${path.basename(evaluation.artifactPath)}.`
        : `Not ready: command=${evaluation.commandResult.ok ? "pass" : "fail"}, artifact=${evaluation.artifactExists ? "present" : "missing"}, passCriteria=${evaluation.artifactPass ? "pass" : "fail"}.`;
      if (evaluation.ready) {
        checkpoint.status = "passed";
        checkpoint.passedAt = checkpoint.passedAt ?? now;
      } else {
        checkpoint.status = "pending";
        checkpoint.passedAt = null;
      }
    }

    const pendingGates = collectPendingEvidenceGates(result);
    const allReady = pendingGates.length === 0;
    stage.lastCheckedAt = now;
    stage.lastPassed = allReady;
    if (stage.status !== "awarded") {
      stage.status = allReady ? "ready_for_review" : "pending";
    }
    stage.lastNote = allReady
      ? "All Stage 6.86 checkpoint evidence commands and claim audit passed. Awaiting final reviewer sign-off."
      : `Pending evidence gates: ${pendingGates.join(", ")}.`;

    const review = (stage.review ?? {}) as Record<string, unknown>;
    if (allReady) {
      review.signOffRequired = true;
      review.signOffRequestedAt = review.signOffRequestedAt ?? now;
      review.signOffRequestedBy = review.signOffRequestedBy ?? "codex";
      if (review.decision !== "approved") {
        review.decision = "pending";
        review.signedOffAt = null;
        review.signedOffBy = null;
      }
      review.signOffNotes =
        "Stage 6.86 evidence gates passed. Awaiting final reviewer sign-off.";
    } else if (review.decision !== "approved") {
      review.signOffNotes = `Evidence gates pending: ${pendingGates.join(", ")}.`;
    }
    stage.review = review;

    const totalStages = stages.length;
    const awardedStages = stages.filter((entry) => entry.status === "awarded").length;
    const totalCheckpoints = stages.reduce((sum, entry) => {
      const stageCheckpoints = Array.isArray(entry.checkpoints)
        ? (entry.checkpoints as Array<Record<string, unknown>>).length
        : 0;
      return sum + stageCheckpoints;
    }, 0);
    const passedCheckpoints = stages.reduce((sum, entry) => {
      const stageCheckpoints = Array.isArray(entry.checkpoints)
        ? (entry.checkpoints as Array<Record<string, unknown>>).filter(
            (checkpoint) => checkpoint.status === "passed"
          ).length
        : 0;
      return sum + stageCheckpoints;
    }, 0);

    ledger.score = {
      totalStages,
      awardedStages,
      stagePercent: toPercent(awardedStages, totalStages),
      totalCheckpoints,
      passedCheckpoints,
      checkpointPercent: toPercent(passedCheckpoints, totalCheckpoints)
    };

    await writeFile(SCOREBOARD_PATH, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error(`Stage 6.86 evidence could not update reward ledger: ${toAsciiLog(String(error))}`);
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
 * Implements `extractArtifactPass` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function extractArtifactPass(filePath: string): Promise<boolean> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(stripUtf8Bom(raw)) as {
      passCriteria?: {
        overallPass?: boolean;
      };
    };
    return parsed.passCriteria?.overallPass === true;
  } catch {
    return false;
  }
}

/**
 * Implements `evaluateCheckpoint` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function evaluateCheckpoint(
  availableScripts: ReadonlySet<string>,
  definition: CheckpointDefinition
): Promise<CheckpointEvaluation> {
  const commandResult = await runKnownOrMissingScript(availableScripts, definition.scriptName);
  const exists = await artifactExists(definition.artifactPath);
  const artifactPass = exists ? await extractArtifactPass(definition.artifactPath) : false;
  return {
    id: definition.id,
    scriptName: definition.scriptName,
    commandResult,
    artifactPath: definition.artifactPath,
    artifactExists: exists,
    artifactPass,
    ready: commandResult.ok && exists && artifactPass
  };
}

/**
 * Implements `buildEvidenceReportMarkdown` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildEvidenceReportMarkdown(result: Stage686EvidenceResult): string {
  const checkpointRows = result.checkpoints
    .map((checkpoint) => {
      const readiness = checkpoint.ready ? "READY" : "NOT_READY";
      return `| ${checkpoint.id} | ${checkpoint.scriptName} | ${checkpoint.commandResult.ok ? "PASS" : "FAIL"} | ${checkpoint.artifactExists ? "YES" : "NO"} | ${checkpoint.artifactPass ? "PASS" : "FAIL"} | ${readiness} |`;
    })
    .join("\n");

  return [
    "# Stage 6.86 Evidence Report",
    "",
    `Generated at: ${result.generatedAt}`,
    "",
    "## Checkpoint Readiness",
    "| Checkpoint | Command | Command Result | Artifact Exists | Artifact PassCriteria | Readiness |",
    "| --- | --- | --- | --- | --- | --- |",
    checkpointRows,
    "",
    "## Auxiliary Gates",
    `1. Live smoke (${result.liveSmoke.scriptName}): ${result.liveSmoke.ok ? "PASS" : "FAIL"}; artifact=${result.liveSmokeArtifactExists ? "present" : "missing"}; passCriteria=${result.liveSmokeArtifactPass ? "PASS" : "FAIL"}`,
    `2. Advanced live smoke (${result.advancedLiveSmoke.scriptName}): ${result.advancedLiveSmoke.ok ? "PASS" : "FAIL"}; artifact=${result.advancedLiveSmokeArtifactExists ? "present" : "missing"}; passCriteria=${result.advancedLiveSmokeArtifactPass ? "PASS" : "FAIL"}`,
    `3. Stage suite (${result.stageSuite.scriptName}): ${result.stageSuite.ok ? "PASS" : "FAIL"}`,
    `4. Claim audit (${result.claimAudit.scriptName}): ${result.claimAudit.ok ? "PASS" : "FAIL"}`,
    "",
    "## Overall",
    `Readiness complete: ${result.readinessComplete ? "YES" : "NO"}`
  ].join("\n");
}

/**
 * Implements `buildManualReadinessMarkdown` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildManualReadinessMarkdown(result: Stage686EvidenceResult): string {
  const checkpointLines = result.checkpoints
    .map((checkpoint) => {
      const status = checkpoint.ready ? "READY" : "NOT_READY";
      return `- ${checkpoint.id}: ${status} (${checkpoint.scriptName}; artifact=${checkpoint.artifactExists ? "present" : "missing"}; passCriteria=${checkpoint.artifactPass ? "pass" : "fail"})`;
    })
    .join("\n");

  return [
    "# Stage 6.86 Manual Readiness",
    "",
    `Generated at: ${result.generatedAt}`,
    "",
    "## Checkpoint Status",
    checkpointLines,
    "",
    "## Gate Summary",
    `- Live smoke command: ${result.liveSmoke.ok ? "PASS" : "FAIL"}`,
    `- Live smoke artifact: ${result.liveSmokeArtifactExists ? "present" : "missing"}`,
    `- Live smoke passCriteria: ${result.liveSmokeArtifactPass ? "PASS" : "FAIL"}`,
    `- Advanced live smoke command: ${result.advancedLiveSmoke.ok ? "PASS" : "FAIL"}`,
    `- Advanced live smoke artifact: ${result.advancedLiveSmokeArtifactExists ? "present" : "missing"}`,
    `- Advanced live smoke passCriteria: ${result.advancedLiveSmokeArtifactPass ? "PASS" : "FAIL"}`,
    `- Stage suite: ${result.stageSuite.ok ? "PASS" : "FAIL"}`,
    `- Claim audit: ${result.claimAudit.ok ? "PASS" : "FAIL"}`,
    `- Overall readiness: ${result.readinessComplete ? "READY" : "NOT_READY"}`
  ].join("\n");
}

/**
 * Implements `buildLiveReviewChecklistMarkdown` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildLiveReviewChecklistMarkdown(result: Stage686EvidenceResult): string {
  const checkpoints = result.checkpoints
    .map((checkpoint) => `- [ ] Run \`${checkpoint.commandResult.command}\` and verify ${path.basename(checkpoint.artifactPath)} indicates \`passCriteria.overallPass=true\`.`)
    .join("\n");

  return [
    "# Stage 6.86 Live Review Checklist",
    "",
    `Generated at: ${result.generatedAt}`,
    "",
    "## Runtime Steps",
    checkpoints,
    `- [ ] Run \`npm run ${LIVE_SMOKE_SCRIPT}\` and verify ${path.basename(LIVE_SMOKE_ARTIFACT_PATH)} indicates \`passCriteria.overallPass=true\`.`,
    `- [ ] Run \`npm run ${ADVANCED_LIVE_SMOKE_SCRIPT}\` and verify ${path.basename(ADVANCED_LIVE_SMOKE_ARTIFACT_PATH)} indicates \`passCriteria.overallPass=true\`.`,
    "- [ ] Run `npm run test:stage6_86` and confirm stage target tests pass.",
    "- [ ] Run `npm run audit:claims` and confirm no claim-integrity violations.",
    "",
    "## Reviewer Decision",
    "- [ ] All checkpoints PASS with expected artifacts and typed outcomes.",
    `- [ ] Stage remains pending until final reviewer (\`${TEST_REVIEWER_HANDLE}\`) explicitly signs off.`
  ].join("\n");
}

/**
 * Implements `runStage686Evidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage686Evidence(): Promise<Stage686EvidenceResult> {
  const availableScripts = await readPackageScripts();
  const checkpoints = await Promise.all(
    CHECKPOINTS.map((checkpoint) => evaluateCheckpoint(availableScripts, checkpoint))
  );
  const liveSmoke = await runKnownOrMissingScript(availableScripts, LIVE_SMOKE_SCRIPT);
  const liveSmokeArtifactExists = await artifactExists(LIVE_SMOKE_ARTIFACT_PATH);
  const liveSmokeArtifactPass = liveSmokeArtifactExists
    ? await extractArtifactPass(LIVE_SMOKE_ARTIFACT_PATH)
    : false;
  const advancedLiveSmoke = await runKnownOrMissingScript(
    availableScripts,
    ADVANCED_LIVE_SMOKE_SCRIPT
  );
  const advancedLiveSmokeArtifactExists = await artifactExists(ADVANCED_LIVE_SMOKE_ARTIFACT_PATH);
  const advancedLiveSmokeArtifactPass = advancedLiveSmokeArtifactExists
    ? await extractArtifactPass(ADVANCED_LIVE_SMOKE_ARTIFACT_PATH)
    : false;
  const stageSuite = await runKnownOrMissingScript(availableScripts, "test:stage6_86");
  const claimAudit = await runKnownOrMissingScript(availableScripts, "audit:claims");

  const readinessComplete =
    checkpoints.every((checkpoint) => checkpoint.ready) &&
    liveSmoke.ok &&
    liveSmokeArtifactExists &&
    liveSmokeArtifactPass &&
    advancedLiveSmoke.ok &&
    advancedLiveSmokeArtifactExists &&
    advancedLiveSmokeArtifactPass &&
    stageSuite.ok &&
    claimAudit.ok;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_86:evidence",
    checkpoints,
    liveSmoke,
    liveSmokeArtifactExists,
    liveSmokeArtifactPass,
    advancedLiveSmoke,
    advancedLiveSmokeArtifactExists,
    advancedLiveSmokeArtifactPass,
    stageSuite,
    claimAudit,
    readinessComplete
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const result = await runStage686Evidence();
  await updateRewardLedgerWithStage686Evidence(result);
  await mkdir(path.dirname(EVIDENCE_REPORT_PATH), { recursive: true });

  await writeFile(EVIDENCE_REPORT_PATH, `${buildEvidenceReportMarkdown(result)}\n`, "utf8");
  await writeFile(MANUAL_READINESS_PATH, `${buildManualReadinessMarkdown(result)}\n`, "utf8");
  await writeFile(
    LIVE_REVIEW_CHECKLIST_PATH,
    `${buildLiveReviewChecklistMarkdown(result)}\n`,
    "utf8"
  );

  console.log(`Stage 6.86 evidence report: ${EVIDENCE_REPORT_PATH}`);
  console.log(`Stage 6.86 manual readiness: ${MANUAL_READINESS_PATH}`);
  console.log(`Stage 6.86 live review checklist: ${LIVE_REVIEW_CHECKLIST_PATH}`);
  console.log(`Readiness complete: ${result.readinessComplete ? "YES" : "NO"}`);

  if (!result.readinessComplete) {
    const failed = [
      ...result.checkpoints
        .filter((checkpoint) => !checkpoint.ready)
        .map((checkpoint) => `${checkpoint.id} (${checkpoint.scriptName})`),
      ...(!result.liveSmoke.ok ? [`live smoke (${result.liveSmoke.scriptName})`] : []),
      ...(result.liveSmoke.ok && !result.liveSmokeArtifactExists
        ? ["live smoke artifact missing"]
        : []),
      ...(result.liveSmoke.ok &&
      result.liveSmokeArtifactExists &&
      !result.liveSmokeArtifactPass
        ? ["live smoke passCriteria failed"]
        : []),
      ...(!result.advancedLiveSmoke.ok
        ? [`advanced live smoke (${result.advancedLiveSmoke.scriptName})`]
        : []),
      ...(result.advancedLiveSmoke.ok && !result.advancedLiveSmokeArtifactExists
        ? ["advanced live smoke artifact missing"]
        : []),
      ...(result.advancedLiveSmoke.ok &&
      result.advancedLiveSmokeArtifactExists &&
      !result.advancedLiveSmokeArtifactPass
        ? ["advanced live smoke passCriteria failed"]
        : []),
      ...(!result.stageSuite.ok ? ["stage suite"] : []),
      ...(!result.claimAudit.ok ? ["claim audit"] : [])
    ];
    console.error(`Not ready checkpoints/gates: ${failed.join(", ")}`);
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error(toAsciiLog(String(error)));
  process.exit(1);
});
