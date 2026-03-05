/**
 * @fileoverview Runs Stage 2 safety validation and emits detailed evidence artifacts.
 */

import { exec as execCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCallback);
const EVIDENCE_REPORT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage2_evidence.md");
const CONSTRAINT_MATRIX_PATH = path.resolve(process.cwd(), "runtime/evidence/stage2_constraint_matrix.md");
const BYPASS_NOTES_PATH = path.resolve(process.cwd(), "runtime/evidence/stage2_bypass_notes.md");

interface CommandResult {
  command: string;
  ok: boolean;
  output: string;
}

interface Stage2Evaluation {
  commandOk: boolean;
  baselineCommandOk: boolean;
  checkpoint21: boolean;
  checkpoint22: boolean;
  checkpoint26: boolean;
  checkpoint23EvidenceReady: boolean;
  checkpoint24EvidenceReady: boolean;
  checkpoint25EvidenceReady: boolean;
  checkpoint25NoRegression: boolean;
  rawOutput: string;
  baselineOutput: string;
}

const CHECKPOINT_23_TEST_NAMES = [
  "stage 2 isolated safety baseline rejects unsafe operations",
  "blocks actions that exceed cost limits",
  "blocks immutable self modification",
  "blocks delete when path is missing",
  "blocks delete outside sandbox",
  "blocks write when path is missing",
  "blocks protected path writes with case and separator variants",
  "blocks list directory when path is missing",
  "blocks list directory outside sandbox in isolated profile",
  "blocks create_skill when name is missing",
  "blocks create_skill with invalid name",
  "blocks create_skill when code is missing",
  "blocks create_skill when code size exceeds limit",
  "blocks create_skill when feature is disabled",
  "blocks shell command in isolated profile",
  "blocks shell command when command is missing",
  "blocks dangerous shell commands even in full access mode",
  "allows create_skill with valid payload",
  "allows network writes when full access policy enables them"
];

const CHECKPOINT_24_TEST_NAMES = [
  "blocks delete traversal that escapes sandbox",
  "blocks list traversal that escapes sandbox",
  "blocks protected path writes with case and separator variants",
  "does not overblock writes that resolve outside protected prefix",
  "orchestrator blocks unsafe delete request"
];

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
 * Implements `includesAnyPattern` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function includesAnyPattern(text: string, patterns: string[]): boolean {
  const normalized = text.toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

/**
 * Implements `runStage2Validation` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runStage2Validation(): Promise<Stage2Evaluation> {
  const result = await runCommand("npm run test:stage2");
  const baselineResult = await runCommand("npm run test:stage2:baseline");
  const output = result.output;
  const baselineOutput = baselineResult.output;

  const checkpoint21 =
    result.ok &&
    includesAllPatterns(output, [
      "stage 2 isolated safety baseline rejects unsafe operations",
      "blocks shell command in isolated profile",
      "blocks protected path writes with case and separator variants",
      "blocks delete outside sandbox",
      "allows network writes when full access policy enables them"
    ]);

  const checkpoint22 =
    result.ok &&
    includesAllPatterns(output, [
      "dangerous shell pattern remains blocked even in full access mode",
      "immutable self-modification remains blocked in full access mode"
    ]);

  const checkpoint26 =
    result.ok &&
    includesAllPatterns(output, [
      "blocks create_skill with invalid name",
      "CodeReviewGovernor blocks eval()",
      "ToolExecutorOrgan blocks invalid skill name"
    ]) &&
    includesAnyPattern(output, [
      "orchestrator blocks unsafe create_skill code via code review preflight",
      "orchestrator blocks unsafe create_skill code via hard constraints or code review preflight",
      "orchestrator blocks unsafe create_skill code"
    ]);

  const checkpoint23EvidenceReady =
    result.ok && includesAllPatterns(output, CHECKPOINT_23_TEST_NAMES);
  const checkpoint24EvidenceReady =
    result.ok && includesAllPatterns(output, CHECKPOINT_24_TEST_NAMES);
  const checkpoint25EvidenceReady = includesAllPatterns(baselineOutput, [
    "Baseline cases evaluated:",
    "No safety regression:"
  ]);
  const checkpoint25NoRegression =
    baselineResult.ok &&
    includesAllPatterns(baselineOutput, [
      "No safety regression: PASS"
    ]);

  return {
    commandOk: result.ok,
    baselineCommandOk: baselineResult.ok,
    checkpoint21,
    checkpoint22,
    checkpoint26,
    checkpoint23EvidenceReady,
    checkpoint24EvidenceReady,
    checkpoint25EvidenceReady,
    checkpoint25NoRegression,
    rawOutput: output,
    baselineOutput
  };
}


/**
 * Implements `renderEvidenceReport` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderEvidenceReport(evaluation: Stage2Evaluation): string {
  const generatedAt = new Date().toISOString();
  return [
    "# Stage 2 Evidence Report",
    "",
    `- Generated At: ${generatedAt}`,
    `- Command: \`npm run test:stage2\``,
    `- Command Status: ${evaluation.commandOk ? "PASS" : "FAIL"}`,
    `- Baseline Command: \`npm run test:stage2:baseline\``,
    `- Baseline Command Status: ${evaluation.baselineCommandOk ? "PASS" : "FAIL"}`,
    "",
    "## Automated Checkpoint Summary",
    "",
    `- 2.1 Isolated Deny Matrix: ${evaluation.checkpoint21 ? "PASS" : "FAIL"}`,
    `- 2.2 Full-Access Guard Persistence: ${evaluation.checkpoint22 ? "PASS" : "FAIL"}`,
    `- 2.6 Dynamic Skill Safety Boundary: ${evaluation.checkpoint26 ? "PASS" : "FAIL"}`,
    "",
    "## Manual-Evidence Readiness Signals",
    "",
    `- 2.3 Constraint Regression Net evidence present: ${evaluation.checkpoint23EvidenceReady ? "YES" : "NO"}`,
    `- 2.4 Bypass Resistance evidence present: ${evaluation.checkpoint24EvidenceReady ? "YES" : "NO"}`,
    `- 2.5 Baseline comparison evidence present: ${evaluation.checkpoint25EvidenceReady ? "YES" : "NO"}`,
    `- 2.5 Baseline reports no regression: ${evaluation.checkpoint25NoRegression ? "YES" : "NO"}`,
    "",
    "## Test Procedures (Objective, Setup, Steps, Assertions)",
    "",
    "1. Isolated deny matrix suite (`stage 2 isolated safety baseline rejects unsafe operations`)",
    "- Objective: verify unsafe operations are blocked in isolated profile.",
    "- Setup: default `DEFAULT_BRAIN_CONFIG` (isolated mode).",
    "- Steps: evaluate hard constraints for shell/network/protected-write/delete/list/create_skill unsafe proposals.",
    "- Assertions: each proposal contains expected violation codes.",
    "",
    "2. Full-access persistence suite (`dangerous shell ...`, `immutable self-modification ...`)",
    "- Objective: prove critical protections remain active in full-access mode.",
    "- Setup: `BRAIN_RUNTIME_MODE=full_access`, `BRAIN_ALLOW_FULL_ACCESS=true`.",
    "- Steps: evaluate dangerous shell and immutable self-modify proposals.",
    "- Assertions: `SHELL_DANGEROUS_COMMAND` and `IMMUTABLE_VIOLATION` are still returned.",
    "",
    "3. Dynamic skill boundary suite (`blocks create_skill ...`, `CodeReviewGovernor ...`, `ToolExecutorOrgan ...`, `orchestrator ...`)",
    "- Objective: verify create-skill flow cannot bypass deterministic or governor safeguards.",
    "- Setup: hard-constraint, code-review governor, executor, and orchestrator test paths.",
    "- Steps: submit invalid skill names, dangerous code patterns, and unsafe create_skill planner requests.",
    "- Assertions: invalid names/path escapes/dangerous code are blocked before execution.",
    "",
    "4. Safety baseline diff suite (`npm run test:stage2:baseline`)",
    "- Objective: ensure no previously blocked unsafe behavior became allowed relative to accepted baseline.",
    "- Setup: baseline cases loaded from stage-file paths when available, otherwise script-embedded fallback baseline cases.",
    "- Steps: evaluate each baseline case against current hard constraints in isolated/full-access profiles, compare expected vs actual blocked codes.",
    "- Assertions: every expected blocked code remains present; missing expected code is a regression.",
    "",
    "## Raw Test Output",
    "",
    "```text",
    evaluation.rawOutput.trim(),
    "```",
    "",
    "## Baseline Diff Output",
    "",
    "```text",
    evaluation.baselineOutput.trim(),
    "```",
    ""
  ].join("\n");
}

/**
 * Implements `renderConstraintMatrix` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderConstraintMatrix(generatedAt: string): string {
  return [
    "# Stage 2 Constraint Coverage Matrix",
    "",
    `- Generated At: ${generatedAt}`,
    "",
    "| Constraint Rule | Test Coverage |",
    "| --- | --- |",
    "| Cost limit enforcement | `blocks actions that exceed cost limits` |",
    "| Immutable self-modification block | `blocks immutable self modification`; `detects immutable target keywords even when touchesImmutable is false` |",
    "| Delete requires path | `blocks delete when path is missing` |",
    "| Delete sandbox boundary | `blocks delete outside sandbox`; `blocks delete traversal that escapes sandbox` |",
    "| Write requires path | `blocks write when path is missing` |",
    "| Write protected-path enforcement | `blocks protected path writes with case and separator variants`; `does not overblock writes that resolve outside protected prefix` |",
    "| List requires path | `blocks list directory when path is missing` |",
    "| List sandbox boundary | `blocks list directory outside sandbox in isolated profile`; `blocks list traversal that escapes sandbox` |",
    "| Create-skill name validation | `blocks create_skill when name is missing`; `blocks create_skill with invalid name`; `ToolExecutorOrgan blocks invalid skill name` |",
    "| Create-skill code validation | `blocks create_skill when code is missing`; `blocks create_skill when code size exceeds limit` |",
    "| Create-skill feature toggle | `blocks create_skill when feature is disabled` |",
    "| Shell policy gate | `blocks shell command in isolated profile`; `blocks shell command when command is missing` |",
    "| Dangerous shell deny list | `blocks dangerous shell commands even in full access mode`; `dangerous shell pattern remains blocked even in full access mode` |",
    "| Network write policy gate | `stage 2 isolated safety baseline rejects unsafe operations`; `allows network writes when full access policy enables them` |",
    "| Dynamic skill code preflight | `CodeReviewGovernor blocks eval()`; `CodeReviewGovernor blocks imports from core/`; `CodeReviewGovernor blocks child_process access`; `orchestrator blocks unsafe create_skill code via code review preflight` |",
    ""
  ].join("\n");
}

/**
 * Implements `renderBypassNotes` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderBypassNotes(generatedAt: string): string {
  return [
    "# Stage 2 Bypass Validation Notes",
    "",
    `- Generated At: ${generatedAt}`,
    "",
    "## Objective",
    "Validate that alternate payload shapes and traversal patterns do not bypass deterministic safety constraints before execution.",
    "",
    "## Bypass Attempts Conducted",
    "1. Path traversal delete attempt: `runtime/sandbox/../../unsafe.txt`.",
    "2. Path traversal list attempt: `runtime/sandbox/../../`.",
    "3. Mixed-case and slash-variant protected write path: `MeMoRy\\\\decision_log.md`.",
    "4. Dynamic-skill dangerous code patterns (`eval`, `child_process`, core-engine imports).",
    "5. Unsafe create_skill plan path through orchestrator/governance.",
    "",
    "## Assertions",
    "1. Traversal delete and traversal list both return sandbox-boundary violations.",
    "2. Protected-path write variants return protected-path violations.",
    "3. Dangerous skill code fails code-review preflight before execution.",
    "4. Unsafe create_skill action is blocked before tool execution.",
    "",
    "## Covered Test Names",
    "1. `blocks delete traversal that escapes sandbox`",
    "2. `blocks list traversal that escapes sandbox`",
    "3. `blocks protected path writes with case and separator variants`",
    "4. `CodeReviewGovernor blocks eval()`",
    "5. `CodeReviewGovernor blocks imports from core/`",
    "6. `CodeReviewGovernor blocks child_process access`",
    "7. `orchestrator blocks unsafe create_skill code via code review preflight`",
    ""
  ].join("\n");
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const evaluation = await runStage2Validation();
  await mkdir(path.dirname(EVIDENCE_REPORT_PATH), { recursive: true });
  const generatedAt = new Date().toISOString();
  await writeFile(EVIDENCE_REPORT_PATH, renderEvidenceReport(evaluation), "utf8");
  await writeFile(CONSTRAINT_MATRIX_PATH, renderConstraintMatrix(generatedAt), "utf8");
  await writeFile(BYPASS_NOTES_PATH, renderBypassNotes(generatedAt), "utf8");

  console.log(`Stage 2 checkpoint 2.1: ${evaluation.checkpoint21 ? "PASS" : "FAIL"}`);
  console.log(`Stage 2 checkpoint 2.2: ${evaluation.checkpoint22 ? "PASS" : "FAIL"}`);
  console.log(`Stage 2 checkpoint 2.6: ${evaluation.checkpoint26 ? "PASS" : "FAIL"}`);
  console.log(`Stage 2 baseline command: ${evaluation.baselineCommandOk ? "PASS" : "FAIL"}`);
  console.log(`Stage 2 manual readiness 2.3: ${evaluation.checkpoint23EvidenceReady ? "READY" : "NOT_READY"}`);
  console.log(`Stage 2 manual readiness 2.4: ${evaluation.checkpoint24EvidenceReady ? "READY" : "NOT_READY"}`);
  console.log(`Stage 2 manual readiness 2.5: ${evaluation.checkpoint25EvidenceReady ? "READY" : "NOT_READY"}`);
  console.log(`Stage 2 baseline no-regression signal: ${evaluation.checkpoint25NoRegression ? "PASS" : "FAIL"}`);
  console.log(`Evidence report: ${EVIDENCE_REPORT_PATH}`);
  console.log(`Constraint matrix: ${CONSTRAINT_MATRIX_PATH}`);
  console.log(`Bypass notes: ${BYPASS_NOTES_PATH}`);
}

void main();
