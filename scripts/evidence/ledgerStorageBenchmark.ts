/**
 * @fileoverview Runs deterministic JSON-vs-SQLite concurrent ledger stress benchmarking for Stage 6.5 Workstream B evidence.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  DistillerMergeLedgerStore,
  ExecutionReceiptStore,
  JudgmentPatternStore
} from "../../src/core/advancedAutonomyRuntime";
import { LedgerBackend } from "../../src/core/config";
import { GovernanceMemoryStore } from "../../src/core/governanceMemory";
import { PlannedAction } from "../../src/core/types";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";

const OUTPUT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_5_ledger_storage_benchmark.json"
);
const TRACE_AUDIT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_5_trace_latency_audit.json"
);
const BENCH_ROOT = path.resolve(
  process.cwd(),
  "runtime/evidence/.bench_stage6_5_ledger_storage"
);
const SQLITE_FILE = "benchmark_ledgers.sqlite";
const WORKERS_PER_STORE = 4;
const WRITES_PER_STORE = 80;
const READ_INTERVAL = 4;

const PASS_THRESHOLDS = {
  minWritesPerStore: WRITES_PER_STORE,
  minReadsPerStore: Math.floor(WRITES_PER_STORE / READ_INTERVAL),
  maxWriteP95Ms: 1000,
  maxReadP95Ms: 1000
} as const;

interface LatencySummary {
  count: number;
  minMs: number | null;
  maxMs: number | null;
  averageMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

interface StoreBenchmarkResult {
  writes: number;
  reads: number;
  writeLatency: LatencySummary;
  readLatency: LatencySummary;
  errors: readonly string[];
}

interface ScenarioBenchmarkResult {
  backend: LedgerBackend;
  durationMs: number;
  stores: {
    governanceMemory: StoreBenchmarkResult;
    executionReceipts: StoreBenchmarkResult;
    distillerLedger: StoreBenchmarkResult;
    judgmentPatterns: StoreBenchmarkResult;
    interfaceSessions: StoreBenchmarkResult;
  };
  totals: {
    writes: number;
    reads: number;
    errors: number;
  };
  passCriteria: {
    noErrors: boolean;
    writesMeetThreshold: boolean;
    readsMeetThreshold: boolean;
    writeP95WithinLimit: boolean;
    readP95WithinLimit: boolean;
    overallPass: boolean;
  };
}

interface TraceBaselineSummary {
  sourcePath: string;
  available: boolean;
  taskLatencyP50Ms: number | null;
  taskLatencyP95Ms: number | null;
}

interface BenchmarkReport {
  generatedAt: string;
  settings: {
    workersPerStore: number;
    writesPerStore: number;
    readInterval: number;
    exportJsonOnWriteDuringBenchmark: boolean;
    thresholds: typeof PASS_THRESHOLDS;
  };
  baselineTraceLatency: TraceBaselineSummary;
  scenarios: readonly ScenarioBenchmarkResult[];
  comparison: {
    sqliteMinusJsonWriteP50Ms: number | null;
    sqliteMinusJsonWriteP95Ms: number | null;
    sqliteMinusJsonReadP50Ms: number | null;
    sqliteMinusJsonReadP95Ms: number | null;
  };
  overallPass: boolean;
}

interface StoreRunnerInput {
  workers: number;
  totalWrites: number;
  readInterval: number;
  writeOperation: (writeIndex: number) => Promise<void>;
  readOperation: () => Promise<void>;
}

interface StoreRunnerResult {
  writes: number;
  reads: number;
  writeLatenciesMs: number[];
  readLatenciesMs: number[];
  errors: string[];
}

interface TraceAuditShape {
  spans?: {
    taskTotal?: {
      p50Ms?: unknown;
      p95Ms?: unknown;
    };
  };
}

/**
 * Implements `computePercentile` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function computePercentile(sortedValues: readonly number[], percentile: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const boundedPercentile = Math.min(100, Math.max(0, percentile));
  const index = Math.ceil((boundedPercentile / 100) * sortedValues.length) - 1;
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, index))];
}

/**
 * Implements `summarizeLatencies` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function summarizeLatencies(values: readonly number[]): LatencySummary {
  if (values.length === 0) {
    return {
      count: 0,
      minMs: null,
      maxMs: null,
      averageMs: null,
      p50Ms: null,
      p95Ms: null
    };
  }

  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    averageMs: Number((sum / sorted.length).toFixed(2)),
    p50Ms: computePercentile(sorted, 50),
    p95Ms: computePercentile(sorted, 95)
  };
}

/**
 * Implements `toNumberOrNull` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Implements `readTraceBaseline` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function readTraceBaseline(): Promise<TraceBaselineSummary> {
  try {
    const raw = await readFile(TRACE_AUDIT_PATH, "utf8");
    const parsed = JSON.parse(raw) as TraceAuditShape;
    return {
      sourcePath: TRACE_AUDIT_PATH,
      available: true,
      taskLatencyP50Ms: toNumberOrNull(parsed.spans?.taskTotal?.p50Ms),
      taskLatencyP95Ms: toNumberOrNull(parsed.spans?.taskTotal?.p95Ms)
    };
  } catch {
    return {
      sourcePath: TRACE_AUDIT_PATH,
      available: false,
      taskLatencyP50Ms: null,
      taskLatencyP95Ms: null
    };
  }
}

/**
 * Implements `measureOperation` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function measureOperation(operation: () => Promise<void>): Promise<number> {
  const startedAt = performance.now();
  await operation();
  return Number((performance.now() - startedAt).toFixed(3));
}

/**
 * Implements `runStoreBenchmark` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runStoreBenchmark(input: StoreRunnerInput): Promise<StoreRunnerResult> {
  const writeLatenciesMs: number[] = [];
  const readLatenciesMs: number[] = [];
  const errors: string[] = [];
  let cursor = 0;

  const workers = Array.from({ length: input.workers }).map(async () => {
    while (true) {
      const writeIndex = cursor;
      cursor += 1;
      if (writeIndex >= input.totalWrites) {
        return;
      }

      try {
        writeLatenciesMs.push(
          await measureOperation(async () => {
            await input.writeOperation(writeIndex);
          })
        );
      } catch (error) {
        errors.push(
          `write_${writeIndex}:${error instanceof Error ? error.message : String(error)}`
        );
      }

      if (writeIndex % input.readInterval === 0) {
        try {
          readLatenciesMs.push(
            await measureOperation(async () => {
              await input.readOperation();
            })
          );
        } catch (error) {
          errors.push(
            `read_${writeIndex}:${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  });

  await Promise.all(workers);
  return {
    writes: writeLatenciesMs.length,
    reads: readLatenciesMs.length,
    writeLatenciesMs,
    readLatenciesMs,
    errors
  };
}

/**
 * Implements `buildStoreBenchmarkResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildStoreBenchmarkResult(result: StoreRunnerResult): StoreBenchmarkResult {
  return {
    writes: result.writes,
    reads: result.reads,
    writeLatency: summarizeLatencies(result.writeLatenciesMs),
    readLatency: summarizeLatencies(result.readLatenciesMs),
    errors: result.errors
  };
}

/**
 * Implements `buildScenarioPassCriteria` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildScenarioPassCriteria(scenario: Omit<ScenarioBenchmarkResult, "passCriteria">): ScenarioBenchmarkResult["passCriteria"] {
  const storeResults = Object.values(scenario.stores);
  const noErrors = scenario.totals.errors === 0;
  const writesMeetThreshold = storeResults.every(
    (store) => store.writes >= PASS_THRESHOLDS.minWritesPerStore
  );
  const readsMeetThreshold = storeResults.every(
    (store) => store.reads >= PASS_THRESHOLDS.minReadsPerStore
  );
  const writeP95WithinLimit = storeResults.every((store) => {
    const p95 = store.writeLatency.p95Ms;
    return p95 !== null && p95 <= PASS_THRESHOLDS.maxWriteP95Ms;
  });
  const readP95WithinLimit = storeResults.every((store) => {
    const p95 = store.readLatency.p95Ms;
    return p95 !== null && p95 <= PASS_THRESHOLDS.maxReadP95Ms;
  });

  return {
    noErrors,
    writesMeetThreshold,
    readsMeetThreshold,
    writeP95WithinLimit,
    readP95WithinLimit,
    overallPass:
      noErrors &&
      writesMeetThreshold &&
      readsMeetThreshold &&
      writeP95WithinLimit &&
      readP95WithinLimit
  };
}

/**
 * Implements `createPlannedAction` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function createPlannedAction(writeIndex: number): PlannedAction {
  return {
    id: `bench_action_${writeIndex}`,
    type: "respond",
    description: "benchmark action",
    params: { message: `benchmark-${writeIndex}` },
    estimatedCostUsd: 0.01
  };
}

/**
 * Implements `runBackendScenario` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runBackendScenario(backend: LedgerBackend): Promise<ScenarioBenchmarkResult> {
  const scenarioRoot = path.resolve(BENCH_ROOT, backend);
  await rm(scenarioRoot, { recursive: true, force: true });
  await mkdir(scenarioRoot, { recursive: true });

  const sqlitePath = path.resolve(scenarioRoot, SQLITE_FILE);
  const storeOptions = {
    backend,
    sqlitePath,
    exportJsonOnWrite: false
  } as const;

  const governanceStore = new GovernanceMemoryStore(
    path.resolve(scenarioRoot, "governance_memory.json"),
    storeOptions
  );
  const executionReceiptStore = new ExecutionReceiptStore(
    path.resolve(scenarioRoot, "execution_receipts.json"),
    storeOptions
  );
  const distillerStore = new DistillerMergeLedgerStore(
    path.resolve(scenarioRoot, "distiller_rejection_ledger.json"),
    storeOptions
  );
  const judgmentStore = new JudgmentPatternStore(
    path.resolve(scenarioRoot, "judgment_patterns.json"),
    storeOptions
  );
  const sessionStore = new InterfaceSessionStore(
    path.resolve(scenarioRoot, "interface_sessions.json"),
    storeOptions
  );

  const startedAt = performance.now();

  const governanceBenchmark = await runStoreBenchmark({
    workers: WORKERS_PER_STORE,
    totalWrites: WRITES_PER_STORE,
    readInterval: READ_INTERVAL,
    writeOperation: async (writeIndex) => {
      await governanceStore.appendEvent({
        taskId: `bench_task_${writeIndex}`,
        proposalId: null,
        actionId: `bench_action_${writeIndex}`,
        actionType: "respond",
        mode: "fast_path",
        outcome: "approved",
        blockCategory: "none",
        blockedBy: [],
        violationCodes: [],
        yesVotes: 1,
        noVotes: 0,
        threshold: 1,
        dissentGovernorIds: []
      });
    },
    readOperation: async () => {
      await governanceStore.getReadView(25);
    }
  });

  const receiptBenchmark = await runStoreBenchmark({
    workers: WORKERS_PER_STORE,
    totalWrites: WRITES_PER_STORE,
    readInterval: READ_INTERVAL,
    writeOperation: async (writeIndex) => {
      await executionReceiptStore.appendApprovedActionReceipt({
        taskId: `bench_task_${writeIndex}`,
        planTaskId: `bench_plan_${writeIndex}`,
        proposalId: null,
        actionResult: {
          action: createPlannedAction(writeIndex),
          mode: "fast_path",
          approved: true,
          output: `ok_${writeIndex}`,
          blockedBy: [],
          violations: [],
          votes: []
        }
      });
    },
    readOperation: async () => {
      await executionReceiptStore.verifyChain();
    }
  });

  const distillerBenchmark = await runStoreBenchmark({
    workers: WORKERS_PER_STORE,
    totalWrites: WRITES_PER_STORE,
    readInterval: READ_INTERVAL,
    writeOperation: async (writeIndex) => {
      await distillerStore.appendDecision({
        cloneId: `atlas-${writeIndex}`,
        lessonText: `distiller lesson ${writeIndex}`,
        merged: writeIndex % 2 === 0,
        rejectingGovernorIds: writeIndex % 2 === 0 ? [] : ["security"],
        reason: writeIndex % 2 === 0 ? "approved" : "rejected"
      });
    },
    readOperation: async () => {
      await distillerStore.load();
    }
  });

  const patternIds: string[] = [];
  const judgmentBenchmark = await runStoreBenchmark({
    workers: WORKERS_PER_STORE,
    totalWrites: WRITES_PER_STORE,
    readInterval: READ_INTERVAL,
    writeOperation: async (writeIndex) => {
      const recorded = await judgmentStore.recordPattern({
        sourceTaskId: `bench_task_${writeIndex}`,
        context: "context",
        options: "option_a|option_b",
        choice: writeIndex % 2 === 0 ? "option_a" : "option_b",
        rationale: `rationale_${writeIndex}`,
        riskPosture: "balanced"
      });
      patternIds.push(recorded.id);
      if (writeIndex % 5 === 0) {
        await judgmentStore.applyOutcomeSignal(recorded.id, "objective", 0.8);
      }
    },
    readOperation: async () => {
      await judgmentStore.load();
    }
  });

  const sessionBenchmark = await runStoreBenchmark({
    workers: WORKERS_PER_STORE,
    totalWrites: WRITES_PER_STORE,
    readInterval: READ_INTERVAL,
    writeOperation: async (writeIndex) => {
      const now = new Date().toISOString();
      await sessionStore.setSession({
        conversationId: `bench_conversation_${writeIndex}`,
        userId: `bench_user_${writeIndex % 10}`,
        username: "benchmark",
        conversationVisibility: "private",
        updatedAt: now,
        activeProposal: null,
        runningJobId: null,
        queuedJobs: [],
        recentJobs: [],
        conversationTurns: [],
        agentPulse: {
          optIn: false,
          mode: "private",
          routeStrategy: "last_private_used",
          lastPulseSentAt: null,
          lastPulseReason: null,
          lastPulseTargetConversationId: null,
          lastDecisionCode: "NOT_EVALUATED",
          lastEvaluatedAt: null
        }
      });
    },
    readOperation: async () => {
      await sessionStore.listSessions();
    }
  });

  if (patternIds.length > 0) {
    await judgmentStore.supersedePattern(patternIds[patternIds.length - 1]);
  }

  const stores = {
    governanceMemory: buildStoreBenchmarkResult(governanceBenchmark),
    executionReceipts: buildStoreBenchmarkResult(receiptBenchmark),
    distillerLedger: buildStoreBenchmarkResult(distillerBenchmark),
    judgmentPatterns: buildStoreBenchmarkResult(judgmentBenchmark),
    interfaceSessions: buildStoreBenchmarkResult(sessionBenchmark)
  };

  const durationMs = Number((performance.now() - startedAt).toFixed(2));
  const totals = {
    writes: Object.values(stores).reduce((sum, store) => sum + store.writes, 0),
    reads: Object.values(stores).reduce((sum, store) => sum + store.reads, 0),
    errors: Object.values(stores).reduce((sum, store) => sum + store.errors.length, 0)
  };

  const scenarioWithoutCriteria: Omit<ScenarioBenchmarkResult, "passCriteria"> = {
    backend,
    durationMs,
    stores,
    totals
  };
  const passCriteria = buildScenarioPassCriteria(scenarioWithoutCriteria);

  return {
    ...scenarioWithoutCriteria,
    passCriteria
  };
}

/**
 * Implements `findScenario` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function findScenario(
  scenarios: readonly ScenarioBenchmarkResult[],
  backend: LedgerBackend
): ScenarioBenchmarkResult | null {
  return scenarios.find((scenario) => scenario.backend === backend) ?? null;
}

/**
 * Implements `buildComparison` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildComparison(scenarios: readonly ScenarioBenchmarkResult[]): BenchmarkReport["comparison"] {
  const jsonScenario = findScenario(scenarios, "json");
  const sqliteScenario = findScenario(scenarios, "sqlite");
  if (!jsonScenario || !sqliteScenario) {
    return {
      sqliteMinusJsonWriteP50Ms: null,
      sqliteMinusJsonWriteP95Ms: null,
      sqliteMinusJsonReadP50Ms: null,
      sqliteMinusJsonReadP95Ms: null
    };
  }

  const jsonWriteP50 = summarizeLatencies(
    Object.values(jsonScenario.stores)
      .map((store) => store.writeLatency.p50Ms)
      .filter((value): value is number => typeof value === "number")
  ).averageMs;
  const sqliteWriteP50 = summarizeLatencies(
    Object.values(sqliteScenario.stores)
      .map((store) => store.writeLatency.p50Ms)
      .filter((value): value is number => typeof value === "number")
  ).averageMs;
  const jsonWriteP95 = summarizeLatencies(
    Object.values(jsonScenario.stores)
      .map((store) => store.writeLatency.p95Ms)
      .filter((value): value is number => typeof value === "number")
  ).averageMs;
  const sqliteWriteP95 = summarizeLatencies(
    Object.values(sqliteScenario.stores)
      .map((store) => store.writeLatency.p95Ms)
      .filter((value): value is number => typeof value === "number")
  ).averageMs;
  const jsonReadP50 = summarizeLatencies(
    Object.values(jsonScenario.stores)
      .map((store) => store.readLatency.p50Ms)
      .filter((value): value is number => typeof value === "number")
  ).averageMs;
  const sqliteReadP50 = summarizeLatencies(
    Object.values(sqliteScenario.stores)
      .map((store) => store.readLatency.p50Ms)
      .filter((value): value is number => typeof value === "number")
  ).averageMs;
  const jsonReadP95 = summarizeLatencies(
    Object.values(jsonScenario.stores)
      .map((store) => store.readLatency.p95Ms)
      .filter((value): value is number => typeof value === "number")
  ).averageMs;
  const sqliteReadP95 = summarizeLatencies(
    Object.values(sqliteScenario.stores)
      .map((store) => store.readLatency.p95Ms)
      .filter((value): value is number => typeof value === "number")
  ).averageMs;

  const toDelta = (sqliteValue: number | null, jsonValue: number | null): number | null => {
    if (sqliteValue === null || jsonValue === null) {
      return null;
    }
    return Number((sqliteValue - jsonValue).toFixed(3));
  };

  return {
    sqliteMinusJsonWriteP50Ms: toDelta(sqliteWriteP50, jsonWriteP50),
    sqliteMinusJsonWriteP95Ms: toDelta(sqliteWriteP95, jsonWriteP95),
    sqliteMinusJsonReadP50Ms: toDelta(sqliteReadP50, jsonReadP50),
    sqliteMinusJsonReadP95Ms: toDelta(sqliteReadP95, jsonReadP95)
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const baselineTraceLatency = await readTraceBaseline();
  const scenarios = await Promise.all([
    runBackendScenario("json"),
    runBackendScenario("sqlite")
  ]);
  const comparison = buildComparison(scenarios);
  const overallPass = scenarios.every((scenario) => scenario.passCriteria.overallPass);

  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    settings: {
      workersPerStore: WORKERS_PER_STORE,
      writesPerStore: WRITES_PER_STORE,
      readInterval: READ_INTERVAL,
      exportJsonOnWriteDuringBenchmark: false,
      thresholds: PASS_THRESHOLDS
    },
    baselineTraceLatency,
    scenarios,
    comparison,
    overallPass
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log(`Ledger storage benchmark generated: ${OUTPUT_PATH}`);
  for (const scenario of report.scenarios) {
    console.log(
      `${scenario.backend.toUpperCase()} benchmark: ${scenario.passCriteria.overallPass ? "PASS" : "FAIL"} ` +
      `(writes=${scenario.totals.writes}, reads=${scenario.totals.reads}, errors=${scenario.totals.errors}, durationMs=${scenario.durationMs})`
    );
  }
  console.log(`Overall benchmark: ${report.overallPass ? "PASS" : "FAIL"}`);
}

void main();
