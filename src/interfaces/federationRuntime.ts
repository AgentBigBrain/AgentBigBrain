/**
 * @fileoverview Starts the federated HTTP runtime and routes accepted inbound delegated tasks through the governed orchestrator path.
 */

import { buildDefaultBrain } from "../core/buildBrain";
import { BrainOrchestrator } from "../core/orchestrator";
import {
  FederatedAgentContract,
  FederatedDelegationDecision,
  FederatedDelegationGateway
} from "../core/federatedDelegation";
import { ensureEnvLoaded } from "../core/envLoader";
import { FederatedHttpServer } from "./federatedServer";

/**
 * Configuration used to start federation server runtime in production mode.
 */
export interface FederationRuntimeConfig {
  enabled: true;
  port: number;
  host: string;
  maxBodyBytes: number;
  resultTtlMs: number;
  evictionIntervalMs: number;
  resultStorePath: string | undefined;
  contracts: FederatedAgentContract[];
}

/**
 * Lightweight lifecycle handle for started federation runtime server.
 */
export interface FederationRuntimeHandle {
  /**
   * Reads runtime address if server is currently active.
   *
   * @returns Bound host/port pair or `null` when server is stopped.
   */
  getAddress(): { host: string; port: number } | null;

  /**
   * Stops runtime server and drains accepted-task callbacks.
   *
   * @returns Resolves when shutdown is complete.
   */
  stop(): Promise<void>;
}

/**
 * Optional dependency injection surface for federation runtime startup.
 */
export interface FederationRuntimeDependencies {
  brain?: BrainOrchestrator;
}

/**
 * Parses boolean and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for boolean so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns `true` when this check passes.
 */
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

/**
 * Parses bounded integer and validates expected structure.
 *
 * **Why it exists:**
 * Federation runtime env parsing should fail closed for malformed or out-of-range bounds.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @param min - Lower bound for accepted values.
 * @param max - Upper bound for accepted values.
 * @param envName - Name of environment key for deterministic error output.
 * @returns Parsed integer value.
 */
function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  envName: string
): number {
  const raw = value?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${envName} must be an integer between ${min} and ${max}.`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${envName} must be between ${min} and ${max} (inclusive).`);
  }
  return parsed;
}

/**
 * Parses federation contract list from env JSON and validates expected structure.
 *
 * **Why it exists:**
 * Contracts are security-critical and must be validated deterministically before server startup.
 *
 * **What it talks to:**
 * - Uses `FederatedAgentContract` typing.
 * - Uses local hash-format validation helper logic.
 *
 * @param rawJson - JSON string containing contract array.
 * @returns Validated contract list.
 */
function parseContractsJson(rawJson: string | undefined): FederatedAgentContract[] {
  const payload = rawJson?.trim();
  if (!payload) {
    throw new Error(
      "BRAIN_FEDERATION_CONTRACTS_JSON is required when federation runtime is enabled."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("BRAIN_FEDERATION_CONTRACTS_JSON must be valid JSON.");
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("BRAIN_FEDERATION_CONTRACTS_JSON must be a non-empty JSON array.");
  }

  const normalizedContracts: FederatedAgentContract[] = [];
  const seenAgents = new Set<string>();
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("Each federation contract must be an object.");
    }

    const contract = candidate as Partial<FederatedAgentContract>;
    const externalAgentId = (contract.externalAgentId ?? "").trim();
    const sharedSecretHash = (contract.sharedSecretHash ?? "").trim().toLowerCase();
    const maxQuotedCostUsd = Number(contract.maxQuotedCostUsd);

    if (!externalAgentId) {
      throw new Error("Each federation contract requires non-empty externalAgentId.");
    }
    if (seenAgents.has(externalAgentId)) {
      throw new Error(`Duplicate federation contract for externalAgentId "${externalAgentId}".`);
    }
    if (!/^[a-f0-9]{64}$/.test(sharedSecretHash)) {
      throw new Error(
        `Contract "${externalAgentId}" has invalid sharedSecretHash; expected 64-char hex SHA-256.`
      );
    }
    if (!Number.isFinite(maxQuotedCostUsd) || maxQuotedCostUsd < 0) {
      throw new Error(`Contract "${externalAgentId}" requires non-negative maxQuotedCostUsd.`);
    }

    seenAgents.add(externalAgentId);
    normalizedContracts.push({
      externalAgentId,
      sharedSecretHash,
      maxQuotedCostUsd
    });
  }

  return normalizedContracts;
}

/**
 * Builds federation runtime config from env for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of federation runtime config from env consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ensureEnvLoaded` (import `ensureEnvLoaded`) from `../core/envLoader`.
 *
 * @param env - Value for env.
 * @returns Computed `FederationRuntimeConfig` result.
 */
export function createFederationRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): FederationRuntimeConfig {
  if (env === process.env) {
    ensureEnvLoaded();
  }

  const enabled = parseBoolean(env.BRAIN_ENABLE_FEDERATION_RUNTIME, false);
  if (!enabled) {
    throw new Error(
      "Federation runtime is disabled. Set BRAIN_ENABLE_FEDERATION_RUNTIME=true to start server mode."
    );
  }

  const host = (env.BRAIN_FEDERATION_HOST ?? "127.0.0.1").trim();
  if (!host) {
    throw new Error("BRAIN_FEDERATION_HOST cannot be empty.");
  }

  return {
    enabled: true,
    port: parseBoundedInteger(env.BRAIN_FEDERATION_PORT, 9100, 0, 65_535, "BRAIN_FEDERATION_PORT"),
    host,
    maxBodyBytes: parseBoundedInteger(
      env.BRAIN_FEDERATION_MAX_BODY_BYTES,
      65_536,
      1_024,
      10_000_000,
      "BRAIN_FEDERATION_MAX_BODY_BYTES"
    ),
    resultTtlMs: parseBoundedInteger(
      env.BRAIN_FEDERATION_RESULT_TTL_MS,
      3_600_000,
      1_000,
      86_400_000,
      "BRAIN_FEDERATION_RESULT_TTL_MS"
    ),
    evictionIntervalMs: parseBoundedInteger(
      env.BRAIN_FEDERATION_EVICTION_INTERVAL_MS,
      60_000,
      1_000,
      3_600_000,
      "BRAIN_FEDERATION_EVICTION_INTERVAL_MS"
    ),
    resultStorePath: (env.BRAIN_FEDERATION_RESULT_STORE_PATH ?? "").trim() || undefined,
    contracts: parseContractsJson(env.BRAIN_FEDERATION_CONTRACTS_JSON)
  };
}

/**
 * Creates callback used to execute accepted federated tasks through governed orchestrator runtime.
 *
 * **Why it exists:**
 * Keeps federated accepted-task execution centralized so all runtime call sites preserve
 * orchestrator governance and deterministic result submission semantics.
 *
 * **What it talks to:**
 * - Uses `BrainOrchestrator.runTask`.
 * - Uses `FederatedDelegationDecision` typing.
 *
 * @param brain - Governed orchestrator instance.
 * @param submitResult - Result submission function bound to active federation server.
 * @returns Async callback suitable for `FederatedHttpServerOptions.onTaskAccepted`.
 */
export function createFederatedTaskAcceptedHandler(
  brain: BrainOrchestrator,
  submitResult: (taskId: string, output: string | null, error: string | null) => void
): (decision: FederatedDelegationDecision) => Promise<void> {
  return async (decision: FederatedDelegationDecision): Promise<void> => {
    if (!decision.taskRequest) {
      throw new Error("Accepted federated decision is missing taskRequest.");
    }

    const taskId = decision.taskRequest.id;
    try {
      const result = await brain.runTask(decision.taskRequest);
      submitResult(taskId, result.summary, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      submitResult(taskId, null, `Federated task execution failed: ${message}`);
    }
  };
}

/**
 * Starts federation runtime server with governed accepted-task execution callback.
 *
 * **Why it exists:**
 * Provides reusable production startup surface for federation runtime and live-smoke tooling.
 *
 * **What it talks to:**
 * - `buildDefaultBrain` when dependency injection is not provided.
 * - `FederatedDelegationGateway`.
 * - `FederatedHttpServer`.
 *
 * @param config - Runtime config for federation server startup.
 * @param dependencies - Optional dependency overrides.
 * @returns Active runtime handle with address lookup and deterministic shutdown.
 */
export async function startFederationRuntime(
  config: FederationRuntimeConfig,
  dependencies: FederationRuntimeDependencies = {}
): Promise<FederationRuntimeHandle> {
  const brain = dependencies.brain ?? buildDefaultBrain();
  const gateway = new FederatedDelegationGateway(config.contracts);
  let server: FederatedHttpServer | null = null;

  const onTaskAccepted = createFederatedTaskAcceptedHandler(
    brain,
    (taskId: string, output: string | null, error: string | null): void => {
      if (!server) {
        return;
      }
      server.submitResult(taskId, output, error);
    }
  );

  server = new FederatedHttpServer({
    port: config.port,
    host: config.host,
    maxBodyBytes: config.maxBodyBytes,
    gateway,
    onTaskAccepted,
    resultTtlMs: config.resultTtlMs,
    evictionIntervalMs: config.evictionIntervalMs,
    resultStorePath: config.resultStorePath
  });

  await server.start();

  return {
    /**
     * Reads active runtime address after startup.
     *
     * **Why it exists:**
     * Gives callers deterministic visibility into the bound host/port for client routing.
     *
     * **What it talks to:**
     * - Active `FederatedHttpServer` lifecycle instance.
     *
     * @returns Bound host/port when running, otherwise `null`.
     */
    getAddress(): { host: string; port: number } | null {
      return server?.getAddress() ?? null;
    },
    /**
     * Stops federation runtime server and waits for accepted-task callbacks to settle.
     *
     * **Why it exists:**
     * Exposes deterministic shutdown behavior to runtime callers and live-smoke tooling.
     *
     * **What it talks to:**
     * - Active `FederatedHttpServer` lifecycle instance.
     *
     * @returns Resolves when server shutdown completes.
     */
    async stop(): Promise<void> {
      if (!server) {
        return;
      }
      const activeServer = server;
      server = null;
      await activeServer.stop();
    }
  };
}

/**
 * Registers signal handlers and returns wait/detach helpers.
 *
 * **Why it exists:**
 * Federation runtime should support deterministic non-interactive shutdown behavior.
 *
 * **What it talks to:**
 * - Node process signal listeners.
 *
 * @returns Promise + cleanup pair for SIGINT/SIGTERM handling.
 */
function createShutdownSignalWaiter(): {
  waitForSignal: Promise<NodeJS.Signals>;
  detach: () => void;
} {
  let settled = false;
  let resolveSignal: (signal: NodeJS.Signals) => void = () => undefined;
  const waitForSignal = new Promise<NodeJS.Signals>((resolve) => {
    resolveSignal = resolve;
  });

  /**
   * Resolves wait promise exactly once when shutdown signal is observed.
   *
   * **Why it exists:**
   * Prevents duplicate resolution/noise when multiple termination signals are received.
   *
   * **What it talks to:**
   * - Closure state for signal waiter promise.
   *
   * @param signal - Signal observed from process runtime.
   */
  const onSignal = (signal: NodeJS.Signals): void => {
    if (settled) {
      return;
    }
    settled = true;
    resolveSignal(signal);
  };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  return {
    waitForSignal,
    detach: (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  };
}

/**
 * Runs the federation runtime until SIGINT/SIGTERM shutdown.
 *
 * **Why it exists:**
 * Provides the production process entrypoint used by `npm run dev:federation`.
 *
 * **What it talks to:**
 * - Env/config parser.
 * - Runtime server startup/shutdown helpers.
 *
 * @returns Resolves after runtime shutdown completes.
 */
export async function runFederationRuntime(): Promise<void> {
  ensureEnvLoaded();
  const config = createFederationRuntimeConfigFromEnv();
  const runtime = await startFederationRuntime(config);
  const address = runtime.getAddress();
  const signalWaiter = createShutdownSignalWaiter();

  if (!address) {
    signalWaiter.detach();
    await runtime.stop();
    throw new Error("Federation runtime started without a bound server address.");
  }

  console.log(
    `[FederationRuntime] Started on ${address.host}:${address.port} with ${config.contracts.length} contract(s).`
  );

  try {
    const signal = await signalWaiter.waitForSignal;
    console.log(`[FederationRuntime] Received ${signal}. Shutting down...`);
  } finally {
    signalWaiter.detach();
    await runtime.stop();
  }
}

/**
 * Module CLI entrypoint wrapper for federation runtime startup.
 *
 * **Why it exists:**
 * Keeps top-level `require.main` handling minimal and test-friendly.
 *
 * **What it talks to:**
 * - `runFederationRuntime`.
 *
 * @returns Resolves after federation runtime lifecycle completes.
 */
async function main(): Promise<void> {
  await runFederationRuntime();
}

if (require.main === module) {
  void main();
}
