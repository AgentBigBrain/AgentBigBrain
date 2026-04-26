/**
 * @fileoverview Tests Stage 6.5 advanced-autonomy runtime foundations for federated delegation, satellite controls, distiller ledgers, receipt chains, and judgment learning.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  deriveJudgmentPatternFromTaskRun,
  DistillerMergeLedgerStore,
  ExecutionReceiptStore,
  FederatedDelegationGateway,
  JudgmentPatternStore,
  SatelliteCloneCoordinator,
  SatelliteIsolationBroker
} from "../../src/core/advancedAutonomyRuntime";
import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { makeId } from "../../src/core/ids";
import { BrainOrchestrator } from "../../src/core/orchestrator";
import { PersonalityStore } from "../../src/core/personalityStore";
import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";
import { StateStore } from "../../src/core/stateStore";
import { GovernanceMemoryStore } from "../../src/core/governanceMemory";
import { createDefaultGovernors } from "../../src/governors/defaultGovernors";
import { MasterGovernor } from "../../src/governors/masterGovernor";
import { MockModelClient } from "../../src/models/mockModelClient";
import { ToolExecutorOrgan } from "../../src/organs/executor";
import { PlannerOrgan } from "../../src/organs/planner";
import { ReflectionOrgan } from "../../src/organs/reflection";

/**
 * Implements `sleep` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Implements `removeTempDirWithRetry` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function removeTempDirWithRetry(tempDir: string): Promise<void> {
  await sleep(100);
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await rm(tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!["ENOTEMPTY", "EPERM", "EBUSY", "ENOENT"].includes(code)) {
        throw error;
      }
      await sleep(attempt * 25);
    }
  }
  await rm(tempDir, { recursive: true, force: true });
}

/**
 * Implements `withTempCwd` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withTempCwd(callback: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage6-5-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    await callback(tempDir);
  } finally {
    process.chdir(previousCwd);
    await removeTempDirWithRetry(tempDir);
  }
}

/**
 * Implements `withAdvancedAutonomyTestBrain` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withAdvancedAutonomyTestBrain(
  callback: (brain: BrainOrchestrator, tempDir: string) => Promise<void>
): Promise<void> {
  await withTempCwd(async (tempDir) => {
    const modelClient = new MockModelClient();
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "runtime/semantic_memory.json"));
    const brain = new BrainOrchestrator(
      DEFAULT_BRAIN_CONFIG,
      new PlannerOrgan(modelClient, memoryStore),
      new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG),
      createDefaultGovernors(),
      new MasterGovernor(DEFAULT_BRAIN_CONFIG.governance.supermajorityThreshold),
      new StateStore(path.join(tempDir, "runtime/state.json")),
      modelClient,
      new ReflectionOrgan(memoryStore, modelClient),
      new PersonalityStore(path.join(tempDir, "runtime/personality_profile.json")),
      new GovernanceMemoryStore(path.join(tempDir, "runtime/governance_memory.json")),
      new ProfileMemoryStore(path.join(tempDir, "runtime/profile_memory.secure.json"), Buffer.alloc(32, 19), 90)
    );

    await callback(brain, tempDir);
  });
}

/**
 * Implements `stage65GovernedFederatedDelegationRoutesThroughOrchestratorPath` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function stage65GovernedFederatedDelegationRoutesThroughOrchestratorPath(): Promise<void> {
  await withAdvancedAutonomyTestBrain(async (brain) => {
    const sharedSecret = "stage6_5_secret_token";
    const gateway = new FederatedDelegationGateway([
      {
        externalAgentId: "partner-agent-alpha",
        sharedSecretHash: await import("node:crypto").then(({ createHash }) =>
          createHash("sha256").update(sharedSecret).digest("hex")
        ),
        maxQuotedCostUsd: 0.8
      }
    ]);

    const decision = gateway.routeInboundRequest(
      {
      quoteId: "quote_001",
      quotedCostUsd: 0.22,
      goal: "Create a delegated skill under normal governance path.",
      userInput:
        "Create markdown skill stage6_5_federated_gate with instructions: Record delegation proof steps.",
      requestedAt: "2026-02-26T00:00:00.000Z"
      },
      "partner-agent-alpha",
      sharedSecret
    );

    assert.equal(decision.accepted, true);
    assert.ok(decision.taskRequest);
    const runResult = await brain.runTask(decision.taskRequest!);

    const createSkillResult = runResult.actionResults.find(
      (result) => result.action.type === "create_skill"
    );
    assert.ok(createSkillResult);
    assert.ok(createSkillResult!.votes.length > 0);
    assert.match(runResult.task.goal, /FederatedContract partner-agent-alpha:quote_001/i);
  });
}

/**
 * Implements `stage65ControlledSatelliteCloningEnforcesLimitsNamingPersonaAndGovernedMergeAttribution` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function stage65ControlledSatelliteCloningEnforcesLimitsNamingPersonaAndGovernedMergeAttribution(): void {
  const coordinator = new SatelliteCloneCoordinator({
    maxClonesPerTask: 2,
    maxDepth: 1,
    maxBudgetUsd: 5
  });

  const spawnDecision = coordinator.spawnSatellites({
    rootTaskId: "task_6_5_clone",
    requestedCloneCount: 2,
    requestedDepth: 1,
    requestedBudgetUsd: 4,
    existingCloneCount: 0,
    role: "researcher"
  });

  assert.equal(spawnDecision.allowed, true);
  assert.equal(spawnDecision.clones.length, 2);
  assert.equal(spawnDecision.clones[0].cloneId, "atlas-1001");
  assert.equal(spawnDecision.clones[1].cloneId, "milkyway-1002");
  assert.equal(spawnDecision.clones[0].personaOverlay.role, "researcher");

  const blockedDecision = coordinator.spawnSatellites({
    rootTaskId: "task_6_5_clone",
    requestedCloneCount: 1,
    requestedDepth: 2,
    requestedBudgetUsd: 7,
    existingCloneCount: 2,
    role: "critic"
  });
  assert.equal(blockedDecision.allowed, false);
  assert.ok(blockedDecision.blockedBy.includes("CLONE_LIMIT_REACHED"));
  assert.ok(blockedDecision.blockedBy.includes("CLONE_DEPTH_EXCEEDED"));
  assert.ok(blockedDecision.blockedBy.includes("CLONE_BUDGET_EXCEEDED"));

  const rejectedMerge = coordinator.evaluateMergeDecision({
    clone: spawnDecision.clones[0],
    governanceApproved: false,
    rejectingGovernorIds: ["security", "ethics"],
    lessonText: "Rejected lesson for guarded merge.",
    reason: "Governors denied merge due policy risk."
  });
  assert.equal(rejectedMerge.merged, false);
  assert.equal(rejectedMerge.committedByAgentId, null);
  assert.ok(rejectedMerge.blockedBy.includes("security"));

  const approvedMerge = coordinator.evaluateMergeDecision({
    clone: spawnDecision.clones[1],
    governanceApproved: true,
    rejectingGovernorIds: [],
    lessonText: "Approved lesson for deterministic merge.",
    reason: ""
  });
  assert.equal(approvedMerge.merged, true);
  assert.equal(approvedMerge.committedByAgentId, spawnDecision.clones[1].cloneId);
}

/**
 * Implements `stage65DistillerMergeRejectionLedgerPersistsDeterministicEntries` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function stage65DistillerMergeRejectionLedgerPersistsDeterministicEntries(): Promise<void> {
  await withTempCwd(async (tempDir) => {
    const store = new DistillerMergeLedgerStore(
      path.join(tempDir, "runtime/distiller_rejection_ledger.json")
    );

    await store.appendDecision({
      cloneId: "atlas-1001",
      lessonText: "Accepted merge candidate",
      merged: true,
      rejectingGovernorIds: [],
      reason: "Merge approved by governance.",
      decidedAt: "2026-02-26T01:00:00.000Z"
    });

    await store.appendDecision({
      cloneId: "milkyway-1002",
      lessonText: "Rejected merge candidate",
      merged: false,
      rejectingGovernorIds: ["security", "compliance"],
      reason: "Rejected due risky side effects.",
      decidedAt: "2026-02-26T01:05:00.000Z"
    });

    const ledger = await store.load();
    assert.equal(ledger.entries.length, 2);

    const rejected = ledger.entries.find((entry) => entry.merged === false);
    assert.ok(rejected);
    assert.equal(rejected!.cloneId, "milkyway-1002");
    assert.ok(rejected!.rejectingGovernorIds.includes("security"));
    assert.match(rejected!.lessonFingerprint, /^[a-f0-9]{64}$/i);
  });
}
/**
 * Implements `stage65SatelliteIsolationDeniesDirectChannelAndAllowsBrokerRelay` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function stage65SatelliteIsolationDeniesDirectChannelAndAllowsBrokerRelay(): void {
  const broker = new SatelliteIsolationBroker();

  const denied = broker.routeMessage({
    fromAgentId: "atlas-1001",
    toAgentId: "milkyway-1002",
    payload: "direct ping",
    channel: "direct"
  });
  assert.equal(denied.allowed, false);
  assert.ok(denied.blockedBy.includes("DIRECT_SATELLITE_CHANNEL_DENIED"));

  const relayed = broker.routeMessage({
    fromAgentId: "atlas-1001",
    toAgentId: "milkyway-1002",
    payload: "broker this through orchestrator",
    channel: "brokered"
  });
  assert.equal(relayed.allowed, true);
  assert.equal(relayed.route, "orchestrator_task_request");
  assert.ok(relayed.relayTaskRequest);
}

/**
 * Implements `stage65ExecutionReceiptChainBuildsTamperEvidentHashesAndDetectsMismatches` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function stage65ExecutionReceiptChainBuildsTamperEvidentHashesAndDetectsMismatches(): Promise<void> {
  await withAdvancedAutonomyTestBrain(async (brain, tempDir) => {
    const receiptPath = path.join(tempDir, "runtime/execution_receipts_sqlite.json");
    const store = new ExecutionReceiptStore(receiptPath);

    const runOne = await brain.runTask({
      id: makeId("task"),
      goal: "Run first safe action for receipt chain.",
      userInput: "Say hello in one line.",
      createdAt: new Date().toISOString()
    });

    const runTwo = await brain.runTask({
      id: makeId("task"),
      goal: "Run second safe action for receipt chain.",
      userInput: "Say hello in one line.",
      createdAt: new Date().toISOString()
    });

    for (const runResult of [runOne, runTwo]) {
      for (const actionResult of runResult.actionResults) {
        if (!actionResult.approved) {
          continue;
        }
        await store.appendApprovedActionReceipt({
          taskId: runResult.task.id,
          planTaskId: runResult.plan.taskId,
          proposalId: null,
          actionResult
        });
      }
    }

    const validCheck = await store.verifyChain();
    assert.equal(validCheck.valid, true);

    const rawDocument = await readFile(receiptPath, "utf8");
    const tampered = JSON.parse(rawDocument) as {
      receipts: Array<Record<string, unknown>>;
    };
    tampered.receipts[0].receiptHash = "tampered-hash";
    await writeFile(receiptPath, JSON.stringify(tampered, null, 2), "utf8");

    const invalidCheck = await store.verifyChain();
    assert.equal(invalidCheck.valid, false);
    assert.ok(invalidCheck.mismatchIndices.includes(0));
  });
}

/**
 * Implements `stage65DistillerMergeLedgerSqliteBackendMaintainsParityAndBootstrap` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function stage65DistillerMergeLedgerSqliteBackendMaintainsParityAndBootstrap(): Promise<void> {
  await withTempCwd(async (tempDir) => {
    const jsonPath = path.join(tempDir, "runtime/distiller_rejection_ledger.json");
    const sqlitePath = path.join(tempDir, "runtime/ledgers.sqlite");

    const bootstrapSource = new DistillerMergeLedgerStore(jsonPath);
    await bootstrapSource.appendDecision({
      cloneId: "atlas-1000",
      lessonText: "Bootstrap entry from legacy json ledger.",
      merged: true,
      rejectingGovernorIds: [],
      reason: "legacy bootstrap source",
      decidedAt: "2026-02-26T00:55:00.000Z"
    });

    const sqliteStore = new DistillerMergeLedgerStore(jsonPath, {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: true
    });
    const bootstrapped = await sqliteStore.load();
    assert.equal(bootstrapped.entries.length, 1);
    assert.equal(bootstrapped.entries[0].cloneId, "atlas-1000");

    await sqliteStore.appendDecision({
      cloneId: "milkyway-1003",
      lessonText: "Sqlite entry after bootstrap",
      merged: false,
      rejectingGovernorIds: ["security"],
      reason: "sqlite append",
      decidedAt: "2026-02-26T01:10:00.000Z"
    });

    const reloaded = new DistillerMergeLedgerStore(jsonPath, {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: true
    });
    const loaded = await reloaded.load();
    assert.equal(loaded.entries.length, 2);
    assert.ok(loaded.entries.some((entry) => entry.cloneId === "milkyway-1003"));

    const exportedRaw = await readFile(jsonPath, "utf8");
    const exported = JSON.parse(exportedRaw) as { entries: unknown[] };
    assert.equal(exported.entries.length, 2);
  });
}

/**
 * Implements `stage65ExecutionReceiptSqliteBackendMaintainsChainParityAndJsonExport` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function stage65ExecutionReceiptSqliteBackendMaintainsChainParityAndJsonExport(): Promise<void> {
  await withAdvancedAutonomyTestBrain(async (brain, tempDir) => {
    const receiptPath = path.join(tempDir, "runtime/execution_receipts_sqlite.json");
    const sqlitePath = path.join(tempDir, "runtime/ledgers.sqlite");
    const store = new ExecutionReceiptStore(receiptPath, {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: true
    });

    const runResult = await brain.runTask({
      id: makeId("task"),
      goal: "Emit sqlite-backed execution receipt for parity validation.",
      userInput: "Say hello in one line.",
      createdAt: new Date().toISOString()
    });
    const approvedAction = runResult.actionResults.find((result) => result.approved);
    assert.ok(approvedAction);

    await store.appendApprovedActionReceipt({
      taskId: runResult.task.id,
      planTaskId: runResult.plan.taskId,
      proposalId: null,
      actionResult: approvedAction!
    });

    const reloadedStore = new ExecutionReceiptStore(receiptPath, {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: true
    });
    const loaded = await reloadedStore.load();
    assert.equal(loaded.receipts.length, 1);
    assert.equal(loaded.receipts[0].actionId, approvedAction!.action.id);

    const verification = await reloadedStore.verifyChain();
    assert.equal(verification.valid, true);

    const exportedRaw = await readFile(receiptPath, "utf8");
    const exported = JSON.parse(exportedRaw) as { receipts: unknown[] };
    assert.equal(exported.receipts.length, 1);
  });
}

/**
 * Implements `stage65JudgmentPatternLearningCalibratesConfidenceFromObjectiveHumanAndDelayedSignals` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function stage65JudgmentPatternLearningCalibratesConfidenceFromObjectiveHumanAndDelayedSignals(): Promise<void> {
  await withAdvancedAutonomyTestBrain(async (brain, tempDir) => {
    const store = new JudgmentPatternStore(path.join(tempDir, "runtime/judgment_patterns.json"));

    const runResult = await brain.runTask({
      id: makeId("task"),
      goal: "Collect a governed decision trace for judgment learning.",
      userInput: "Say hello in one line.",
      createdAt: new Date().toISOString()
    });

    const patternInput = deriveJudgmentPatternFromTaskRun(runResult, "balanced");
    const pattern = await store.recordPattern(patternInput);
    assert.equal(pattern.confidence, 0.5);

    const afterObjective = await store.applyOutcomeSignal(pattern.id, "objective", 1);
    assert.ok(afterObjective.newConfidence > afterObjective.previousConfidence);

    const afterHuman = await store.applyOutcomeSignal(pattern.id, "human_feedback", -0.4);
    assert.ok(afterHuman.newConfidence < afterObjective.newConfidence);

    const afterDelayed = await store.applyOutcomeSignal(pattern.id, "delayed", 0.6);
    assert.ok(afterDelayed.newConfidence > afterHuman.newConfidence);

    const superseded = await store.supersedePattern(pattern.id);
    assert.equal(superseded.status, "superseded");
    assert.ok(superseded.supersededAt);
  });
}

/**
 * Implements `stage65JudgmentPatternSqliteBackendMaintainsParityAndBootstrap` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function stage65JudgmentPatternSqliteBackendMaintainsParityAndBootstrap(): Promise<void> {
  await withAdvancedAutonomyTestBrain(async (brain, tempDir) => {
    const jsonPath = path.join(tempDir, "runtime/judgment_patterns_sqlite.json");
    const sqlitePath = path.join(tempDir, "runtime/ledgers.sqlite");

    const jsonStore = new JudgmentPatternStore(jsonPath);
    const bootstrapPattern = await jsonStore.recordPattern({
      sourceTaskId: "bootstrap-task",
      context: "legacy context",
      options: "legacy options",
      choice: "legacy choice",
      rationale: "legacy rationale",
      riskPosture: "balanced"
    });
    assert.equal(bootstrapPattern.sourceTaskId, "bootstrap-task");

    const sqliteStore = new JudgmentPatternStore(jsonPath, {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: true
    });
    const bootstrapped = await sqliteStore.load();
    assert.equal(bootstrapped.patterns.length, 1);
    assert.equal(bootstrapped.patterns[0].sourceTaskId, "bootstrap-task");

    const runResult = await brain.runTask({
      id: makeId("task"),
      goal: "Record sqlite judgment pattern and calibrate it.",
      userInput: "Say hello in one line.",
      createdAt: new Date().toISOString()
    });
    const patternInput = deriveJudgmentPatternFromTaskRun(runResult, "balanced");
    const sqlitePattern = await sqliteStore.recordPattern(patternInput);
    const calibration = await sqliteStore.applyOutcomeSignal(sqlitePattern.id, "objective", 1);
    assert.ok(calibration.newConfidence > calibration.previousConfidence);

    const reloaded = new JudgmentPatternStore(jsonPath, {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: true
    });
    const loaded = await reloaded.load();
    assert.equal(loaded.patterns.length, 2);
    assert.ok(loaded.patterns.some((pattern) => pattern.id === sqlitePattern.id));

    const exportedRaw = await readFile(jsonPath, "utf8");
    const exported = JSON.parse(exportedRaw) as { patterns: unknown[] };
    assert.equal(exported.patterns.length, 2);
  });
}

test(
  "stage 6.5 governed federated delegation routes authenticated inbound requests through orchestrator governance path",
  stage65GovernedFederatedDelegationRoutesThroughOrchestratorPath
);
test(
  "stage 6.5 controlled satellite cloning enforces deterministic limits naming persona overlays and governed merge attribution",
  stage65ControlledSatelliteCloningEnforcesLimitsNamingPersonaAndGovernedMergeAttribution
);
test(
  "stage 6.5 governed distiller merge and rejection ledger persists deterministic merge denied records",
  stage65DistillerMergeRejectionLedgerPersistsDeterministicEntries
);
test(
  "stage 6.5 distiller merge sqlite backend preserves parity export and legacy bootstrap",
  stage65DistillerMergeLedgerSqliteBackendMaintainsParityAndBootstrap
);
test(
  "stage 6.5 satellite isolation denies direct satellite channels and allows orchestrator brokered relay path",
  stage65SatelliteIsolationDeniesDirectChannelAndAllowsBrokerRelay
);
test(
  "stage 6.5 tamper evident execution receipt chain links approved actions and detects deterministic mismatch",
  stage65ExecutionReceiptChainBuildsTamperEvidentHashesAndDetectsMismatches
);
test(
  "stage 6.5 execution receipt sqlite backend preserves receipt-chain behavior and json export parity",
  stage65ExecutionReceiptSqliteBackendMaintainsChainParityAndJsonExport
);
test(
  "stage 6.5 judgment pattern learning calibrates confidence from objective human and delayed outcomes with supersession",
  stage65JudgmentPatternLearningCalibratesConfidenceFromObjectiveHumanAndDelayedSignals
);
test(
  "stage 6.5 judgment sqlite backend preserves parity export and legacy bootstrap",
  stage65JudgmentPatternSqliteBackendMaintainsParityAndBootstrap
);
