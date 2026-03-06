/**
 * @fileoverview Runs a real-shell managed-process smoke covering start, readiness, browser verification, and stop.
 */

import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createBrainConfigFromEnv } from "../../src/core/config";
import { ensureEnvLoaded } from "../../src/core/envLoader";
import { evaluateHardConstraints } from "../../src/core/hardConstraints";
import {
  ConstraintEvaluationContext,
  ConstraintViolation,
  ExecutorExecutionOutcome,
  PlannedAction
} from "../../src/core/types";
import { ToolExecutorOrgan } from "../../src/organs/executor";

interface EnvSnapshot {
  [key: string]: string | undefined;
}

interface StepArtifact {
  id: string;
  actionType: PlannedAction["type"];
  violations: readonly ConstraintViolation[];
  outcomeStatus: ExecutorExecutionOutcome["status"] | "not_executed";
  output: string;
  failureCode: string | null;
  executionMetadata: Record<string, unknown> | null;
  pass: boolean;
}

interface ManagedProcessLiveSmokeArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL";
  runtime: {
    runtimeMode: string;
    allowFullAccess: boolean;
    realShellEnabled: boolean;
    shellKind: string;
  };
  browserVerificationMode: "verified" | "runtime_unavailable" | "failed";
  steps: readonly StepArtifact[];
  summary: {
    totalSteps: number;
    passedSteps: number;
    failedStepIds: readonly string[];
  };
  passCriteria: {
    lifecyclePass: boolean;
    readinessPass: boolean;
    browserPass: boolean;
    truthfulBrowserFallbackPass: boolean;
    overallPass: boolean;
  };
}

const COMMAND_NAME = "npm run test:runtime:managed_process_live_smoke";
const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/managed_process_live_smoke_report.json"
);
const TASK_ID = "managed_process_live_smoke_task";
const PROCESS_READY_RETRY_ATTEMPTS = 20;
const PROCESS_READY_RETRY_DELAY_MS = 250;

/**
 * Applies temporary environment overrides for this smoke process.
 *
 * @param overrides - Deterministic env overrides required for the smoke.
 * @returns Previous values used for later restoration.
 */
function applyEnvOverrides(overrides: Readonly<Record<string, string>>): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const [key, value] of Object.entries(overrides)) {
    snapshot[key] = process.env[key];
    process.env[key] = value;
  }
  return snapshot;
}

/**
 * Restores environment variables captured before temporary overrides.
 *
 * @param snapshot - Previous env state returned by `applyEnvOverrides`.
 */
function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

/**
 * Reserves one loopback TCP port for the managed-process smoke.
 *
 * @returns Promise resolving to a currently available loopback port.
 */
async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve a numeric loopback port.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

/**
 * Delays execution for a bounded number of milliseconds.
 *
 * @param delayMs - Delay duration in milliseconds.
 * @returns Promise resolving after the requested delay.
 */
async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Builds one minimal governance proposal wrapper for hard-constraint evaluation.
 *
 * @param action - Planned action to evaluate before execution.
 * @returns Proposal wrapper accepted by `evaluateHardConstraints`.
 */
function buildProposal(action: PlannedAction) {
  return {
    id: `proposal_${action.id}`,
    taskId: TASK_ID,
    requestedBy: "managed-process-live-smoke",
    rationale: "Managed-process live smoke validation.",
    action,
    touchesImmutable: false
  };
}

/**
 * Extracts one string metadata field from executor metadata.
 *
 * @param metadata - Execution metadata bag returned by the executor.
 * @param key - Metadata key to read.
 * @returns Trimmed string value or `null`.
 */
function readMetadataString(
  metadata: Record<string, unknown> | null,
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Extracts one boolean metadata field from executor metadata.
 *
 * @param metadata - Execution metadata bag returned by the executor.
 * @param key - Metadata key to read.
 * @returns Boolean value or `null` when missing/non-boolean.
 */
function readMetadataBoolean(
  metadata: Record<string, unknown> | null,
  key: string
): boolean | null {
  const value = metadata?.[key];
  return typeof value === "boolean" ? value : null;
}

/**
 * Executes one governed smoke action after deterministic hard-constraint evaluation.
 *
 * @param executor - Real executor used for managed-process lifecycle actions.
 * @param config - Runtime config used by hard-constraint policy.
 * @param action - Planned action to execute.
 * @param context - Mutable cumulative-cost context shared across this smoke.
 * @returns Executed step artifact.
 */
async function executeSmokeAction(
  executor: ToolExecutorOrgan,
  config: ReturnType<typeof createBrainConfigFromEnv>,
  action: PlannedAction,
  context: ConstraintEvaluationContext
): Promise<StepArtifact> {
  const violations = evaluateHardConstraints(buildProposal(action), config, context);
  if (violations.length > 0) {
    return {
      id: action.id,
      actionType: action.type,
      violations,
      outcomeStatus: "not_executed",
      output: violations.map((violation) => violation.message).join(" | "),
      failureCode: violations[0]?.code ?? null,
      executionMetadata: null,
      pass: false
    };
  }

  context.cumulativeEstimatedCostUsd += action.estimatedCostUsd;
  const outcome = await executor.executeWithOutcome(action, undefined, TASK_ID);
  return {
    id: action.id,
    actionType: action.type,
    violations,
    outcomeStatus: outcome.status,
    output: outcome.output,
    failureCode: outcome.failureCode ?? null,
    executionMetadata: (outcome.executionMetadata as Record<string, unknown> | undefined) ?? null,
    pass: outcome.status === "success"
  };
}

/**
 * Re-runs one probe action until it reaches the requested ready-state or retries are exhausted.
 *
 * @param executor - Real executor used for probe actions.
 * @param config - Runtime config used by hard-constraint policy.
 * @param actionFactory - Factory returning the next probe action attempt.
 * @param desiredReady - Desired `probeReady` metadata state.
 * @param context - Mutable cumulative-cost context shared across this smoke.
 * @returns Final executed step artifact.
 */
async function waitForProbeState(
  executor: ToolExecutorOrgan,
  config: ReturnType<typeof createBrainConfigFromEnv>,
  actionFactory: (attempt: number) => PlannedAction,
  desiredReady: boolean,
  context: ConstraintEvaluationContext
): Promise<StepArtifact> {
  let latestStep: StepArtifact | null = null;
  for (let attempt = 1; attempt <= PROCESS_READY_RETRY_ATTEMPTS; attempt += 1) {
    latestStep = await executeSmokeAction(executor, config, actionFactory(attempt), context);
    const ready = readMetadataBoolean(latestStep.executionMetadata, "probeReady");
    if (ready === desiredReady) {
      return {
        ...latestStep,
        pass: desiredReady ? latestStep.outcomeStatus === "success" : latestStep.failureCode === "PROCESS_NOT_READY"
      };
    }
    if (attempt < PROCESS_READY_RETRY_ATTEMPTS) {
      await sleep(PROCESS_READY_RETRY_DELAY_MS);
    }
  }
  return latestStep ?? {
    id: "probe_unreachable",
    actionType: "probe_port",
    violations: [],
    outcomeStatus: "not_executed",
    output: "Probe retries did not execute.",
    failureCode: "ACTION_EXECUTION_FAILED",
    executionMetadata: null,
    pass: false
  };
}

/**
 * Writes a small loopback HTTP server used by the smoke to prove real managed-process readiness.
 *
 * @param workspaceRoot - Temporary workspace where the server file should be written.
 * @param port - Loopback port the server will bind to.
 * @returns Promise resolving to the written server script path.
 */
async function writeManagedProcessServer(
  workspaceRoot: string,
  port: number
): Promise<string> {
  const serverPath = path.join(workspaceRoot, "managed-process-smoke-server.cjs");
  const serverSource = [
    "const http = require('node:http');",
    `const port = ${port};`,
    "const html = `<!doctype html><html><head><title>Managed Process Smoke</title></head><body><main><h1>Managed process ready</h1><p>The loopback smoke server is running.</p></main></body></html>`;",
    "const server = http.createServer((_req, res) => {",
    "  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });",
    "  res.end(html);",
    "});",
    "const shutdown = () => {",
    "  server.close(() => process.exit(0));",
    "};",
    "process.on('SIGTERM', shutdown);",
    "process.on('SIGINT', shutdown);",
    "server.listen(port, '127.0.0.1');"
  ].join("\n");
  await writeFile(serverPath, `${serverSource}\n`, "utf8");
  return serverPath;
}

/**
 * Executes the real-shell managed-process smoke and returns one artifact payload.
 *
 * @returns Promise resolving to the completed artifact payload.
 */
async function runManagedProcessLiveSmoke(): Promise<ManagedProcessLiveSmokeArtifact> {
  ensureEnvLoaded();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-managed-process-smoke-"));
  const runtimeDir = path.join(tempRoot, "runtime");
  await mkdir(runtimeDir, { recursive: true });

  const previousEnv = applyEnvOverrides({
    BRAIN_MODEL_BACKEND: "mock",
    BRAIN_ENABLE_EMBEDDINGS: "false",
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true",
    BRAIN_ENABLE_REAL_SHELL: "true",
    BRAIN_ENABLE_REAL_NETWORK_WRITE: "false",
    BRAIN_PROFILE_MEMORY_ENABLED: "false",
    BRAIN_ENABLE_DYNAMIC_PULSE: "false",
    BRAIN_LEDGER_BACKEND: "json",
    BRAIN_TRACE_LOG_ENABLED: "false",
    BRAIN_LEDGER_SQLITE_PATH: path.join(runtimeDir, "ledgers.sqlite"),
    BRAIN_VECTOR_SQLITE_PATH: path.join(runtimeDir, "vectors.sqlite"),
    BRAIN_TRACE_LOG_PATH: path.join(runtimeDir, "runtime_trace.jsonl"),
    BRAIN_PROFILE_MEMORY_PATH: path.join(runtimeDir, "profile_memory.secure.json")
  });

  const originalCwd = process.cwd();
  process.chdir(tempRoot);
  let executor: ToolExecutorOrgan | null = null;
  let activeLeaseId: string | null = null;

  try {
    const port = await reserveLoopbackPort();
    await writeManagedProcessServer(tempRoot, port);

    const config = createBrainConfigFromEnv();
    executor = new ToolExecutorOrgan(config);
    const constraintContext: ConstraintEvaluationContext = {
      cumulativeEstimatedCostUsd: 0
    };
    const steps: StepArtifact[] = [];

    const startStep = await executeSmokeAction(
      executor,
      config,
      {
        id: "start_process_smoke",
        type: "start_process",
        description: "Start the managed-process smoke HTTP server.",
        params: {
          command: `node managed-process-smoke-server.cjs`,
          cwd: tempRoot
        },
        estimatedCostUsd: 0.28
      },
      constraintContext
    );
    startStep.pass =
      startStep.outcomeStatus === "success" &&
      readMetadataString(startStep.executionMetadata, "processLifecycleStatus") === "PROCESS_STARTED" &&
      readMetadataString(startStep.executionMetadata, "processLeaseId") !== null;
    steps.push(startStep);

    const leaseId = readMetadataString(startStep.executionMetadata, "processLeaseId");
    activeLeaseId = leaseId;
    if (!leaseId) {
      return finalizeManagedProcessArtifact(config, steps, "failed");
    }

    const runningStep = await executeSmokeAction(
      executor,
      config,
      {
        id: "check_process_running_smoke",
        type: "check_process",
        description: "Check the managed-process smoke HTTP server lease.",
        params: {
          leaseId
        },
        estimatedCostUsd: 0.04
      },
      constraintContext
    );
    runningStep.pass =
      runningStep.outcomeStatus === "success" &&
      readMetadataString(runningStep.executionMetadata, "processLifecycleStatus") === "PROCESS_STILL_RUNNING";
    steps.push(runningStep);

    const probePortReadyStep = await waitForProbeState(
      executor,
      config,
      (attempt) => ({
        id: `probe_port_ready_smoke_${attempt}`,
        type: "probe_port",
        description: "Probe loopback TCP readiness for the managed-process smoke server.",
        params: {
          host: "127.0.0.1",
          port,
          timeoutMs: 1000
        },
        estimatedCostUsd: 0.03
      }),
      true,
      constraintContext
    );
    steps.push(probePortReadyStep);

    const probeHttpReadyStep = await waitForProbeState(
      executor,
      config,
      (attempt) => ({
        id: `probe_http_ready_smoke_${attempt}`,
        type: "probe_http",
        description: "Probe loopback HTTP readiness for the managed-process smoke server.",
        params: {
          url: `http://127.0.0.1:${port}`,
          expectedStatus: 200,
          timeoutMs: 1000
        },
        estimatedCostUsd: 0.04
      }),
      true,
      constraintContext
    );
    steps.push(probeHttpReadyStep);

    const verifyBrowserStep = await executeSmokeAction(
      executor,
      config,
      {
        id: "verify_browser_smoke",
        type: "verify_browser",
        description: "Verify the managed-process smoke homepage in a browser.",
        params: {
          url: `http://127.0.0.1:${port}`,
          expectedTitle: "Managed Process Smoke",
          expectedText: "Managed process ready",
          timeoutMs: 5000
        },
        estimatedCostUsd: 0.09
      },
      constraintContext
    );
    const verifyBrowserFailureCode = verifyBrowserStep.failureCode;
    verifyBrowserStep.pass =
      (verifyBrowserStep.outcomeStatus === "success" &&
        readMetadataBoolean(verifyBrowserStep.executionMetadata, "browserVerification") === true &&
        readMetadataBoolean(verifyBrowserStep.executionMetadata, "browserVerifyPassed") === true) ||
      (verifyBrowserFailureCode === "BROWSER_VERIFY_RUNTIME_UNAVAILABLE" &&
        /Playwright/i.test(verifyBrowserStep.output));
    steps.push(verifyBrowserStep);

    const stopStep = await executeSmokeAction(
      executor,
      config,
      {
        id: "stop_process_smoke",
        type: "stop_process",
        description: "Stop the managed-process smoke HTTP server lease.",
        params: {
          leaseId
        },
        estimatedCostUsd: 0.12
      },
      constraintContext
    );
    stopStep.pass =
      stopStep.outcomeStatus === "success" &&
      readMetadataString(stopStep.executionMetadata, "processLifecycleStatus") === "PROCESS_STOPPED";
    steps.push(stopStep);
    if (stopStep.pass) {
      activeLeaseId = null;
    }

    const stoppedCheckStep = await executeSmokeAction(
      executor,
      config,
      {
        id: "check_process_stopped_smoke",
        type: "check_process",
        description: "Check that the managed-process smoke server is stopped.",
        params: {
          leaseId
        },
        estimatedCostUsd: 0.04
      },
      constraintContext
    );
    stoppedCheckStep.pass =
      stoppedCheckStep.outcomeStatus === "success" &&
      readMetadataString(stoppedCheckStep.executionMetadata, "processLifecycleStatus") === "PROCESS_STOPPED";
    steps.push(stoppedCheckStep);

    const probePortStoppedStep = await waitForProbeState(
      executor,
      config,
      (attempt) => ({
        id: `probe_port_stopped_smoke_${attempt}`,
        type: "probe_port",
        description: "Probe loopback TCP readiness after stop to verify truthful not-ready reporting.",
        params: {
          host: "127.0.0.1",
          port,
          timeoutMs: 1000
        },
        estimatedCostUsd: 0.03
      }),
      false,
      constraintContext
    );
    steps.push(probePortStoppedStep);

    const browserMode =
      verifyBrowserFailureCode === "BROWSER_VERIFY_RUNTIME_UNAVAILABLE"
        ? "runtime_unavailable"
        : verifyBrowserStep.outcomeStatus === "success"
          ? "verified"
          : "failed";
    return finalizeManagedProcessArtifact(config, steps, browserMode);
  } finally {
    process.chdir(originalCwd);
    restoreEnv(previousEnv);
    if (executor && activeLeaseId) {
      try {
        await executor.executeWithOutcome(
          {
            id: "cleanup_stop_process_smoke",
            type: "stop_process",
            description: "Best-effort cleanup for managed-process live smoke.",
            params: {
              leaseId: activeLeaseId
            },
            estimatedCostUsd: 0.12
          },
          undefined,
          TASK_ID
        );
      } catch {
        // Ignore cleanup errors here; artifact execution already captured the main signal.
      }
    }
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch {
      await sleep(500);
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

/**
 * Finalizes one managed-process live-smoke artifact from collected step results.
 *
 * @param config - Runtime config used during the smoke.
 * @param steps - Executed smoke steps.
 * @param browserVerificationMode - Browser verification outcome mode.
 * @returns Final artifact payload.
 */
function finalizeManagedProcessArtifact(
  config: ReturnType<typeof createBrainConfigFromEnv>,
  steps: readonly StepArtifact[],
  browserVerificationMode: "verified" | "runtime_unavailable" | "failed"
): ManagedProcessLiveSmokeArtifact {
  const failedStepIds = steps.filter((step) => !step.pass).map((step) => step.id);
  const lifecyclePass =
    steps.some((step) => step.id === "start_process_smoke" && step.pass) &&
    steps.some((step) => step.id === "check_process_running_smoke" && step.pass) &&
    steps.some((step) => step.id === "stop_process_smoke" && step.pass) &&
    steps.some((step) => step.id === "check_process_stopped_smoke" && step.pass);
  const readinessPass =
    steps.some((step) => step.id.startsWith("probe_port_ready_smoke_") && step.pass) &&
    steps.some((step) => step.id.startsWith("probe_http_ready_smoke_") && step.pass) &&
    steps.some((step) => step.id.startsWith("probe_port_stopped_smoke_") && step.pass);
  const browserPass = browserVerificationMode === "verified";
  const truthfulBrowserFallbackPass = browserVerificationMode === "runtime_unavailable";
  const overallPass =
    lifecyclePass &&
    readinessPass &&
    (browserPass || truthfulBrowserFallbackPass) &&
    failedStepIds.length === 0;

  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND_NAME,
    status: overallPass ? "PASS" : "FAIL",
    runtime: {
      runtimeMode: config.permissions.runtimeMode,
      allowFullAccess: config.permissions.runtimeMode === "full_access",
      realShellEnabled: config.permissions.allowRealShellExecution,
      shellKind: config.shellRuntime.profile.shellKind
    },
    browserVerificationMode,
    steps,
    summary: {
      totalSteps: steps.length,
      passedSteps: steps.filter((step) => step.pass).length,
      failedStepIds
    },
    passCriteria: {
      lifecyclePass,
      readinessPass,
      browserPass,
      truthfulBrowserFallbackPass,
      overallPass
    }
  };
}

/**
 * Writes the managed-process live-smoke artifact and exits non-zero on failure.
 */
async function main(): Promise<void> {
  const artifact = await runManagedProcessLiveSmoke();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`Managed-process live smoke status: ${artifact.status}`);
  console.log(`Artifact: ${ARTIFACT_PATH}`);
  if (!artifact.passCriteria.overallPass) {
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
