/**
 * @fileoverview Runs Stage 5.5 runtime-path validation, updates automated checkpoint evidence, and writes reviewer artifacts.
 */

import { exec as execCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCallback);
const SCOREBOARD_PATH = path.resolve(process.cwd(), "runtime/reward_score.json");
const EVIDENCE_REPORT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage5_5_evidence.md");
const READINESS_PATH = path.resolve(process.cwd(), "runtime/evidence/stage5_5_manual_readiness.md");
const STAGE_ID = "stage_5_5_agent_friend";

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

interface Stage55Evaluation {
  commandOk: boolean;
  checkpoint551: boolean;
  checkpoint555: boolean;
  checkpoint556: boolean;
  checkpoint552Ready: boolean;
  checkpoint553PolicyReady: boolean;
  checkpoint553DeliveryReady: boolean;
  checkpoint553ContextualReady: boolean;
  checkpoint553Ready: boolean;
  checkpoint554Ready: boolean;
  checkpoint557Ready: boolean;
  checkpoint558FoundationReady: boolean;
  checkpoint558ContextualReady: boolean;
  checkpoint558DomainBoundaryReady: boolean;
  checkpoint558Ready: boolean;
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
 * Implements `runStage55Validation` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runStage55Validation(): Promise<Stage55Evaluation> {
  const result = await runCommand("npm run test:stage5_5");
  const output = result.output;

  const checkpoint551 =
    result.ok &&
    includesAllPatterns(output, [
      "blocks communication actions with non-agent declared identity",
      "blocks communication actions that declare a human speaker role",
      "allows communication actions that explicitly keep agent identity"
    ]);
  const checkpoint555 =
    result.ok &&
    includesAllPatterns(output, [
      "orchestrator redacts sensitive profile fields before planner model egress"
    ]);
  const checkpoint556 =
    result.ok &&
    includesAllPatterns(output, [
      "orchestrator degrades gracefully when encrypted profile memory cannot be decrypted"
    ]);
  const checkpoint552Ready =
    result.ok &&
    includesAllPatterns(output, [
      "upsert supersedes older active fact for same key with new value",
      "markStaleFactsAsUncertain downgrades stale confirmed facts"
    ]);
  const checkpoint553PolicyReady =
    result.ok &&
    includesAllPatterns(output, [
      "evaluateAgentPulse allows stale-fact revalidation when stale facts exist",
      "evaluateAgentPulse blocks stale-fact reason when no stale facts exist",
      "evaluateAgentPulse applies unresolved-commitment signal and deterministic rate limit",
      "evaluateAgentPulse blocks check-ins during quiet hours unless overridden"
    ]);
  const checkpoint553DeliveryReady =
    result.ok &&
    includesAllPatterns(output, [
      "agent pulse scheduler skips sessions when not opted in",
      "agent pulse scheduler enqueues proactive job and updates pulse state when allowed",
      "agent pulse scheduler records suppression decision when no reason is allowed",
      "conversation manager supports pulse opt-in command flow",
      "conversation manager can enqueue system jobs for proactive pulse flow"
    ]);
  const checkpoint553ContextualReady =
    result.ok &&
    includesAllPatterns(output, [
      "contextual follow-up nudge",
      "topic linkage confidence",
      "contextual-follow-up cooldown"
    ]);
  const checkpoint553Ready =
    checkpoint553PolicyReady && checkpoint553DeliveryReady && checkpoint553ContextualReady;
  const checkpoint554Ready =
    result.ok &&
    includesAllPatterns(output, [
      "profile memory persists encrypted content and omits plaintext values at rest",
      "readFacts hides sensitive fields unless explicit approval is present"
    ]);
  const checkpoint557Ready =
    result.ok &&
    includesAllPatterns(output, [
      "agent pulse scheduler suppresses private mode when no private route exists",
      "agent pulse scheduler routes private mode to most recent private session for same user",
      "conversation manager supports pulse opt-in command flow"
    ]);
  const checkpoint558FoundationReady =
    result.ok &&
    includesAllPatterns(output, [
      "relationship-aware temporal nudging",
      "role taxonomy",
      "context drift"
    ]);
  const checkpoint558ContextualReady =
    result.ok &&
    includesAllPatterns(output, [
      "relationship-aware contextual follow-up",
      "side-thread linkage",
      "revalidation-required follow-up"
    ]);
  const checkpoint558DomainBoundaryReady =
    result.ok &&
    includesAllPatterns(output, [
      "memory broker suppresses profile context for workflow-dominant requests"
    ]);
  const checkpoint558Ready =
    checkpoint558FoundationReady &&
    checkpoint558ContextualReady &&
    checkpoint558DomainBoundaryReady;

  return {
    commandOk: result.ok,
    checkpoint551,
    checkpoint555,
    checkpoint556,
    checkpoint552Ready,
    checkpoint553PolicyReady,
    checkpoint553DeliveryReady,
    checkpoint553ContextualReady,
    checkpoint553Ready,
    checkpoint554Ready,
    checkpoint557Ready,
    checkpoint558FoundationReady,
    checkpoint558ContextualReady,
    checkpoint558DomainBoundaryReady,
    checkpoint558Ready,
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
 * Implements `updateStage55` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function updateStage55(stage: StageLedger, evaluation: Stage55Evaluation): void {
  const now = new Date().toISOString();
  const manualCheckpointIds = new Set(["5.5.2", "5.5.3", "5.5.4", "5.5.7", "5.5.8"]);
  const isManualCheckpoint = (id: string): boolean =>
    manualCheckpointIds.has(id);
  const isAlreadyReviewerApproved = stage.status === "awarded" && stage.review.decision === "approved";
  const manualReadinessComplete =
    evaluation.checkpoint552Ready &&
    evaluation.checkpoint553Ready &&
    evaluation.checkpoint554Ready &&
    evaluation.checkpoint557Ready &&
    evaluation.checkpoint558Ready;
  const checkpointMap: Record<string, { passed: boolean; note: string }> = {
    "5.5.1": {
      passed: evaluation.checkpoint551,
      note: evaluation.checkpoint551
        ? "Identity-continuity hard-constraint tests passed: non-agent/human-claim communication is blocked while explicit agent identity is allowed."
        : "Identity-continuity automated evidence incomplete."
    },
    "5.5.2": {
      passed: false,
      note: evaluation.checkpoint552Ready
        ? "Temporal freshness evidence is present in runtime-path tests; awaiting manual reviewer sign-off."
        : "Temporal freshness evidence incomplete."
    },
    "5.5.3": {
      passed: false,
      note: evaluation.checkpoint553Ready
        ? "Agent Pulse governance evidence is present (policy + delivery + contextual-followup behavior); awaiting manual reviewer sign-off."
        : "Agent Pulse checkpoint not review-ready: contextual-followup nudge behavior/tests are incomplete."
    },
    "5.5.4": {
      passed: false,
      note: evaluation.checkpoint554Ready
        ? "Encrypted profile-storage and deterministic access-control evidence is present; awaiting manual reviewer sign-off."
        : "Profile-storage/access-control evidence incomplete."
    },
    "5.5.5": {
      passed: evaluation.checkpoint555,
      note: evaluation.checkpoint555
        ? "Model-egress privacy guard test passed: sensitive profile fields are redacted before planner model calls."
        : "Model-egress guard automated evidence incomplete."
    },
    "5.5.6": {
      passed: evaluation.checkpoint556,
      note: evaluation.checkpoint556
        ? "Graceful profile-memory degradation test passed: `degraded_unavailable` mode preserves governed core-task execution."
        : "Graceful degradation automated evidence incomplete."
    },
    "5.5.7": {
      passed: false,
      note: evaluation.checkpoint557Ready
        ? "Proactive channel privacy-routing evidence is present (private/public mode handling + NO_PRIVATE_ROUTE suppression); awaiting manual reviewer sign-off."
        : "Proactive channel privacy-routing evidence incomplete."
    },
    "5.5.8": {
      passed: false,
      note: evaluation.checkpoint558Ready
        ? "Relationship-aware temporal nudging evidence is present; awaiting manual reviewer sign-off."
        : "Relationship-aware temporal nudging checkpoint not review-ready: role/context-drift, contextual follow-up, and domain-boundary separation evidence must all be present."
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
  const manualCheckpointTotal = manualCheckpointIds.size;
  const hasPartialManualSignOff =
    manualPassedCount > 0 && manualPassedCount < manualCheckpointTotal;
  if (isAlreadyReviewerApproved && allPassed) {
    stage.lastCheckedAt = now;
    stage.lastPassed = true;
    return;
  }

  stage.lastCheckedAt = now;
  stage.lastPassed = allPassed;
  stage.status = allPassed ? "ready_for_review" : "pending";
  stage.lastNote = allPassed
    ? "All Stage 5.5 checkpoints passed. Awaiting final reviewer sign-off."
    : hasPartialManualSignOff
      ? `Stage 5.5 partial manual sign-off recorded (${manualPassedCount}/${manualCheckpointTotal} manual checkpoints approved); awaiting remaining manual approvals.`
    : manualReadinessComplete
      ? "Stage 5.5 evidence-ready for manual reviewer sign-off; checkpoints remain pending until reviewer approval."
      : "Stage 5.5 development in progress. Relationship/contextual/domain-boundary checkpoints must be implemented and re-evidenced before review readiness.";

  stage.review.signOffRequired = true;
  stage.review.decision = "pending";
  stage.review.signOffRequestedAt = allPassed || manualReadinessComplete ? now : null;
  stage.review.signOffRequestedBy = allPassed || manualReadinessComplete ? "codex" : null;
  stage.review.signedOffAt = null;
  stage.review.signedOffBy = null;
  stage.review.signOffNotes = allPassed
    ? "Stage 5.5 evidence prepared. Awaiting final reviewer decision."
    : hasPartialManualSignOff
      ? `Partial manual sign-off recorded (${manualPassedCount}/${manualCheckpointTotal} manual checkpoints approved). Awaiting remaining manual checkpoint decisions and final stage-level reviewer sign-off.`
    : manualReadinessComplete
      ? "Stage 5.5 manual checkpoint evidence is ready. Awaiting reviewer sign-off."
      : "Stage 5.5 not yet review-ready: finish relationship/contextual/domain-boundary development and rerun evidence.";
}

/**
 * Implements `renderManualReadiness` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderManualReadiness(evaluation: Stage55Evaluation, generatedAt: string): string {
  return [
    "# Stage 5.5 Manual Checkpoint Readiness",
    "",
    `- Generated At: ${generatedAt}`,
    "",
    `- 5.5.2 Temporal Profile Freshness evidence present: ${evaluation.checkpoint552Ready ? "YES" : "NO"}`,
    `- 5.5.3 Proactive Check-In Governance policy evidence present: ${evaluation.checkpoint553PolicyReady ? "YES" : "NO"}`,
    `- 5.5.3 Proactive Check-In Governance delivery evidence present: ${evaluation.checkpoint553DeliveryReady ? "YES" : "NO"}`,
    `- 5.5.3 Proactive Check-In Governance contextual-followup evidence present: ${evaluation.checkpoint553ContextualReady ? "YES" : "NO"}`,
    `- 5.5.3 Proactive Check-In Governance overall readiness: ${evaluation.checkpoint553Ready ? "YES" : "NO"}`,
    `- 5.5.4 Privacy-Preserving Profile Storage evidence present: ${evaluation.checkpoint554Ready ? "YES" : "NO"}`,
    `- 5.5.7 Proactive Channel Privacy Routing evidence present: ${evaluation.checkpoint557Ready ? "YES" : "NO"}`,
    `- 5.5.8 Relationship-Aware Temporal Nudging foundation evidence present: ${evaluation.checkpoint558FoundationReady ? "YES" : "NO"}`,
    `- 5.5.8 Relationship-Aware Temporal Nudging contextual-followup evidence present: ${evaluation.checkpoint558ContextualReady ? "YES" : "NO"}`,
    `- 5.5.8 Relationship-Aware Temporal Nudging domain-boundary evidence present: ${evaluation.checkpoint558DomainBoundaryReady ? "YES" : "NO"}`,
    `- 5.5.8 Relationship-Aware Temporal Nudging overall readiness: ${evaluation.checkpoint558Ready ? "YES" : "NO"}`,
    "",
    "These remain manual-signoff checkpoints in the reviewer-gated reward policy.",
    ""
  ].join("\n");
}

/**
 * Implements `renderEvidenceReport` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderEvidenceReport(evaluation: Stage55Evaluation, generatedAt: string): string {
  const relationshipNudgingProcedure = evaluation.checkpoint558Ready
    ? [
      "9. Relationship-aware temporal nudging evidence",
      "- Objective: verify proactive nudges use relationship role taxonomy plus temporal context-drift handling.",
      "- Setup: real runtime-path tests in `src/core/profileMemoryStore.test.ts`, `src/interfaces/agentPulseScheduler.test.ts`, and `src/organs/memoryBroker.test.ts`.",
      "- Steps: execute tests covering role-taxonomy suppression (`acquaintance`), context-drift revalidation (`job/team/location/contact` drift), updated decisions after relationship-role changes, and workflow-dominant domain-boundary suppression in memory broker routing.",
      "- Assertions: relationship role is classified from profile memory, context drift is detected deterministically, socially distant unresolved-commitment nudges are suppressed, allowed nudges include revalidation directives in scheduler prompts, contextual side-thread follow-ups obey linkage-confidence + cooldown controls, and profile context is suppressed when non-profile workflow/system requests dominate."
    ]
    : [
      "9. Relationship-aware temporal nudging evidence",
      "- Objective: verify proactive nudges use relationship role taxonomy plus temporal context-drift handling.",
      "- Setup: Stage checkpoint `5.5.8` currently lacks one or more runtime-path signatures for role/context-drift handling, contextual side-thread follow-up behavior, or memory-broker domain-boundary suppression in `npm run test:stage5_5` output.",
      "- Steps: add/execute runtime-path tests and live traces for role classification, drift detection, nudge suppression/revalidation, contextual-follow-up linkage-confidence/cooldown enforcement, and workflow/system-dominant profile-context suppression.",
      "- Assertions: until those runtime-path signatures appear, checkpoint `5.5.8` remains not ready for manual sign-off."
    ];

  return [
    "# Stage 5.5 Evidence Report",
    "",
    `- Generated At: ${generatedAt}`,
    "- Command: `npm run test:stage5_5`",
    `- Command Status: ${evaluation.commandOk ? "PASS" : "FAIL"}`,
    "",
    "## Automated Checkpoint Summary",
    "",
    `- 5.5.1 Agent Identity Continuity: ${evaluation.checkpoint551 ? "PASS" : "FAIL"}`,
    `- 5.5.5 Model Egress Privacy Guard: ${evaluation.checkpoint555 ? "PASS" : "FAIL"}`,
    `- 5.5.6 Graceful Profile-Memory Degradation: ${evaluation.checkpoint556 ? "PASS" : "FAIL"}`,
    "",
    "## Manual-Evidence Readiness Signals",
    "",
    `- 5.5.2 Temporal Profile Freshness evidence present: ${evaluation.checkpoint552Ready ? "YES" : "NO"}`,
    `- 5.5.3 Proactive Check-In Governance policy evidence present: ${evaluation.checkpoint553PolicyReady ? "YES" : "NO"}`,
    `- 5.5.3 Proactive Check-In Governance delivery evidence present: ${evaluation.checkpoint553DeliveryReady ? "YES" : "NO"}`,
    `- 5.5.3 Proactive Check-In Governance contextual-followup evidence present: ${evaluation.checkpoint553ContextualReady ? "YES" : "NO"}`,
    `- 5.5.3 Proactive Check-In Governance overall readiness: ${evaluation.checkpoint553Ready ? "YES" : "NO"}`,
    `- 5.5.4 Privacy-Preserving Profile Storage evidence present: ${evaluation.checkpoint554Ready ? "YES" : "NO"}`,
    `- 5.5.7 Proactive Channel Privacy Routing evidence present: ${evaluation.checkpoint557Ready ? "YES" : "NO"}`,
    `- 5.5.8 Relationship-Aware Temporal Nudging foundation evidence present: ${evaluation.checkpoint558FoundationReady ? "YES" : "NO"}`,
    `- 5.5.8 Relationship-Aware Temporal Nudging contextual-followup evidence present: ${evaluation.checkpoint558ContextualReady ? "YES" : "NO"}`,
    `- 5.5.8 Relationship-Aware Temporal Nudging domain-boundary evidence present: ${evaluation.checkpoint558DomainBoundaryReady ? "YES" : "NO"}`,
    `- 5.5.8 Relationship-Aware Temporal Nudging overall readiness: ${evaluation.checkpoint558Ready ? "YES" : "NO"}`,
    "",
    "## Test Procedures (Objective, Setup, Steps, Assertions)",
    "",
    "1. Agent identity continuity tests (`blocks communication actions with non-agent declared identity`, `blocks communication actions that declare a human speaker role`, `allows communication actions that explicitly keep agent identity`)",
    "- Objective: ensure Agent Friend messaging remains explicitly agentic and cannot impersonate human identity.",
    "- Setup: real hard-constraint runtime-path tests in `src/core/hardConstraints.test.ts`.",
    "- Steps: evaluate communication actions with non-agent identity fields, human speaker-role claims, and valid explicit agent identity.",
    "- Assertions: non-agent/human claims are blocked; explicit agent identity path is allowed.",
    "",
    "2. Temporal freshness tests (`upsert supersedes older active fact ...`, `markStaleFactsAsUncertain ...`)",
    "- Objective: prove profile memory avoids stale-truth lock-in and supports supersession lifecycle.",
    "- Setup: real profile-memory state transitions in `src/core/profileMemory.test.ts`.",
    "- Steps: insert conflicting facts for same key; run stale downgrade evaluation with synthetic time progression.",
    "- Assertions: old fact becomes superseded; stale confirmed facts become uncertain deterministically.",
    "",
    "3. Proactive check-in governance policy tests (`evaluateAgentPulse ...` cases)",
    "- Objective: validate reason-coded Agent Pulse suppression/allow rules on real encrypted profile-memory state.",
    "- Setup: `ProfileMemoryStore` with encrypted storage plus deterministic Agent Pulse policy inputs.",
    "- Steps: run stale-fact, unresolved-commitment, quiet-hours, and min-interval scenarios through `evaluateAgentPulse`.",
    "- Assertions: policy returns expected decision codes (`ALLOWED`, `NO_STALE_FACTS`, `QUIET_HOURS`, `RATE_LIMIT`) and expected stale/unresolved counters.",
    "",
    "4. Proactive check-in delivery scheduler tests (`agent pulse scheduler ...`, `conversation manager ... pulse ...`)",
    "- Objective: prove proactive check-ins are delivered through real session queue pathways with opt-in gating and suppression behavior.",
    "- Setup: real `AgentPulseScheduler` + `ConversationManager` + `InterfaceSessionStore` production code paths.",
    "- Steps: execute scheduler ticks for opt-out skip, allowed enqueue/update, suppressed decision capture, and provider-prefix filtering; verify `/pulse on|off|status` plus system-job enqueue path.",
    "- Assertions: scheduler enqueues only eligible sessions, updates pulse state deterministically, and conversation queue executes proactive system jobs with assistant output.",
    "",
    "5. Privacy-preserving storage tests (`profile memory persists encrypted content ...`, `readFacts hides sensitive fields ...`)",
    "- Objective: verify sensitive profile memory remains encrypted at rest and access-controlled.",
    "- Setup: encrypted `ProfileMemoryStore` with deterministic test key and local temp storage.",
    "- Steps: ingest sensitive + non-sensitive facts; inspect on-disk file; query `readFacts` with and without explicit approval metadata.",
    "- Assertions: plaintext sensitive values never appear on disk; sensitive facts are hidden without valid approval and returned only with explicit approval.",
    "",
    "6. Model egress privacy guard test (`orchestrator redacts sensitive profile fields before planner model egress`)",
    "- Objective: ensure sensitive profile context is redacted before planner payload reaches model boundary.",
    "- Setup: real orchestrator runtime path with injected profile context containing email/phone plus non-sensitive field.",
    "- Steps: run task through orchestrator and capture planner user payload from model client.",
    "- Assertions: sensitive lines are redacted, raw sensitive values are absent, non-sensitive fields remain, and egress-redaction metadata is present.",
    "",
    "7. Graceful degradation test (`orchestrator degrades gracefully when encrypted profile memory cannot be decrypted`)",
    "- Objective: confirm profile-memory failures do not break core governed execution.",
    "- Setup: seed encrypted profile with key A, run orchestrator with key B against same file.",
    "- Steps: execute normal request through orchestrator with unreadable profile store.",
    "- Assertions: run still completes through governed path, summary includes `degraded_unavailable`, and Agent Friend context enrichment is omitted.",
    "",
    "8. Proactive channel privacy-routing tests (`agent pulse scheduler suppresses private mode ...`, `agent pulse scheduler routes private mode ...`)",
    "- Objective: ensure proactive check-ins do not leak into public channels when private routing is configured.",
    "- Setup: real `AgentPulseScheduler` + session visibility metadata + real conversation pulse-mode command handling in `ConversationManager`.",
    "- Steps: run a no-private-route scenario under private mode, then run mixed private/public sessions with deterministic latest-private target selection.",
    "- Assertions: missing private route produces `NO_PRIVATE_ROUTE` suppression with no enqueue; mixed routes enqueue only to the most recently used private session.",
    "",
    ...relationshipNudgingProcedure,
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

  const evaluation = await runStage55Validation();
  updateStage55(stage, evaluation);
  recomputeScore(ledger);

  const generatedAt = new Date().toISOString();
  await writeFile(SCOREBOARD_PATH, JSON.stringify(ledger, null, 2), "utf8");
  await mkdir(path.dirname(EVIDENCE_REPORT_PATH), { recursive: true });
  await writeFile(EVIDENCE_REPORT_PATH, renderEvidenceReport(evaluation, generatedAt), "utf8");
  await writeFile(READINESS_PATH, renderManualReadiness(evaluation, generatedAt), "utf8");

  console.log(`Stage 5.5 checkpoint 5.5.1: ${evaluation.checkpoint551 ? "PASS" : "FAIL"}`);
  console.log(`Stage 5.5 checkpoint 5.5.5: ${evaluation.checkpoint555 ? "PASS" : "FAIL"}`);
  console.log(`Stage 5.5 checkpoint 5.5.6: ${evaluation.checkpoint556 ? "PASS" : "FAIL"}`);
  console.log(`Stage 5.5 manual readiness 5.5.2: ${evaluation.checkpoint552Ready ? "READY" : "NOT_READY"}`);
  console.log(
    `Stage 5.5 manual readiness 5.5.3: ${evaluation.checkpoint553Ready ? "READY" : "NOT_READY"} ` +
    `(policy=${evaluation.checkpoint553PolicyReady ? "YES" : "NO"}, delivery=${evaluation.checkpoint553DeliveryReady ? "YES" : "NO"}, contextual=${evaluation.checkpoint553ContextualReady ? "YES" : "NO"})`
  );
  console.log(`Stage 5.5 manual readiness 5.5.4: ${evaluation.checkpoint554Ready ? "READY" : "NOT_READY"}`);
  console.log(`Stage 5.5 manual readiness 5.5.7: ${evaluation.checkpoint557Ready ? "READY" : "NOT_READY"}`);
  console.log(
    `Stage 5.5 manual readiness 5.5.8: ${evaluation.checkpoint558Ready ? "READY" : "NOT_READY"} ` +
    `(foundation=${evaluation.checkpoint558FoundationReady ? "YES" : "NO"}, contextual=${evaluation.checkpoint558ContextualReady ? "YES" : "NO"}, domainBoundary=${evaluation.checkpoint558DomainBoundaryReady ? "YES" : "NO"})`
  );
  console.log(`Stage ledger updated: ${SCOREBOARD_PATH}`);
  console.log(`Evidence report: ${EVIDENCE_REPORT_PATH}`);
}

void main();
