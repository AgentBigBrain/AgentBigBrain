/**
 * @fileoverview Executes approved actions against local tooling and simulated high-risk handlers.
 */

import { spawn } from "node:child_process";

import { BrainConfig } from "../core/config";
import { throwIfAborted } from "../core/runtimeAbort";
import { ExecutorExecutionOutcome, NetworkWriteActionParams, PlannedAction } from "../core/types";
import { ShellExecutionTelemetry } from "./executionRuntime/contracts";
import {
  buildSimulatedExecutionMetadata,
  executeFileMutationAction,
  resolveRespondMessage
} from "./executionRuntime/fileMutationExecution";
import {
  executeShellCommandAction,
  resolveShellCommandCwd,
  terminateProcessTree
} from "./executionRuntime/shellExecution";
import { executeCreateSkillAction, executeRunSkillAction } from "./executionRuntime/skillRuntime";
import { BrowserVerifier, PlaywrightBrowserVerifier } from "./liveRun/browserVerifier";
import {
  buildExecutionOutcome,
  LiveRunExecutorContext,
  normalizeOptionalString
} from "./liveRun/contracts";
import { executeBrowserVerification } from "./liveRun/browserVerificationHandler";
import { executeCheckProcess } from "./liveRun/checkProcessHandler";
import { ManagedProcessRegistry } from "./liveRun/managedProcessRegistry";
import { executeProbeHttp } from "./liveRun/probeHttpHandler";
import { executeProbePort } from "./liveRun/probePortHandler";
import { executeStartProcess } from "./liveRun/startProcessHandler";
import { executeStopProcess } from "./liveRun/stopProcessHandler";

export class ToolExecutorOrgan {
  private readonly shellExecutionTelemetryByActionId = new Map<string, ShellExecutionTelemetry>();
  private readonly managedProcessRegistry: ManagedProcessRegistry;
  private readonly browserVerifier: BrowserVerifier;

  /**
   * Initializes `ToolExecutorOrgan` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses `BrainConfig` (import `BrainConfig`) from `../core/config`.
   * - Uses `spawn` (import `spawn`) from `node:child_process`.
   * - Uses `ManagedProcessRegistry` (import `ManagedProcessRegistry`) from `./liveRun/managedProcessRegistry`.
   * - Uses `PlaywrightBrowserVerifier` (import `PlaywrightBrowserVerifier`) from `./liveRun/browserVerifier`.
   *
   * @param config - Configuration or policy settings applied here.
   * @param shellSpawn - Value for shell spawn.
   * @param managedProcessRegistry - Registry storing long-running process lifecycle state.
   * @param browserVerifier - Browser verification backend used for loopback UI proof.
   */
  constructor(
    private readonly config: BrainConfig,
    private readonly shellSpawn: typeof spawn = spawn,
    managedProcessRegistry: ManagedProcessRegistry = new ManagedProcessRegistry(),
    browserVerifier?: BrowserVerifier
  ) {
    this.managedProcessRegistry = managedProcessRegistry;
    this.browserVerifier =
      browserVerifier ??
      new PlaywrightBrowserVerifier({
        headless: config.browserVerification.headless
      });
  }

  /**
   * Builds the shared live-run handler context for extracted process or browser capability modules.
   *
   * **Why it exists:**
   * Keeps the executor as a thin dispatcher while still passing one stable dependency bag to the
   * live-run subsystem.
   *
   * **What it talks to:**
   * - Uses `LiveRunExecutorContext` from `./liveRun/contracts`.
   *
   * @returns Shared live-run execution context.
   */
  private buildLiveRunContext(): LiveRunExecutorContext {
    return {
      config: this.config,
      shellSpawn: this.shellSpawn,
      managedProcessRegistry: this.managedProcessRegistry,
      browserVerifier: this.browserVerifier,
      resolveShellCommandCwd: (params) => resolveShellCommandCwd(this.config, params),
      terminateProcessTree: (child) => terminateProcessTree(this.shellSpawn, child)
    };
  }

  /**
   * Consumes shell execution telemetry and applies deterministic state updates.
   *
   * **Why it exists:**
   * Keeps shell execution telemetry lifecycle mutation logic centralized to reduce drift in state transitions.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param actionId - Stable identifier used to reference an entity or record.
   * @returns Computed `ShellExecutionTelemetry | null` result.
   */
  consumeShellExecutionTelemetry(actionId: string): ShellExecutionTelemetry | null {
    const telemetry = this.shellExecutionTelemetryByActionId.get(actionId);
    if (!telemetry) {
      return null;
    }
    this.shellExecutionTelemetryByActionId.delete(actionId);
    return telemetry;
  }

  /**
   * Builds input for this module's runtime flow.
   *
   * **Why it exists:**
   * Keeps construction of input consistent across call sites.
   *
   * **What it talks to:**
   * - Uses `PlannedAction` (import `PlannedAction`) from `../core/types`.
   *
   * @param action - Value for action.
   * @returns Promise resolving to string | null.
   */
  async prepare(action: PlannedAction): Promise<string | null> {
    // Preparation must be side-effect-free; only lightweight message-ready paths are eligible.
    if (action.type !== "respond") {
      return null;
    }

    const message = resolveRespondMessage(action.params);
    if (message && message.trim()) {
      return message.trim();
    }
    return "Response action approved.";
  }

  /**
   * Executes input as part of this module's control flow.
   *
   * **Why it exists:**
   * Returns typed runtime outcomes so upstream task orchestration can fail closed without
   * parsing free-form output prefixes.
   *
   * **What it talks to:**
   * - Uses `PlannedAction` (import `PlannedAction`) from `../core/types`.
   * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
   * - Uses `readdir` (import `readdir`) from `node:fs/promises`.
   * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
   * - Uses `rm` (import `rm`) from `node:fs/promises`.
   * - Uses `writeFile` (import `writeFile`) from `node:fs/promises`.
   * - Additional imported collaborators are also used in this function body.
   *
   * @param action - Value for action.
   * @param signal - Optional abort signal propagated from caller/runtime surface.
   * @param taskId - Optional owning task id for runtime metadata propagation.
   * @returns Promise resolving to typed executor outcome.
   */
  async executeWithOutcome(
    action: PlannedAction,
    signal?: AbortSignal,
    taskId?: string
  ): Promise<ExecutorExecutionOutcome> {
    throwIfAborted(signal);
    const basicActionOutcome = await executeFileMutationAction(action);
    if (basicActionOutcome) {
      return basicActionOutcome;
    }

    switch (action.type) {
      case "create_skill":
        return executeCreateSkillAction(action);

      case "run_skill":
        return executeRunSkillAction(action);

      case "network_write":
        if (!this.config.permissions.allowRealNetworkWrite) {
          return buildExecutionOutcome(
            "success",
            "Network write simulated (real network write disabled by policy).",
            undefined,
            buildSimulatedExecutionMetadata("NETWORK_WRITE_POLICY_DISABLED")
          );
        }
        return this.executeRealNetworkWrite(action.params);

      case "self_modify":
        return buildExecutionOutcome(
          "success",
          "Self-modification simulated (requires governance workflow).",
          undefined,
          buildSimulatedExecutionMetadata("SELF_MODIFY_GOVERNANCE_REQUIRED")
        );

      case "shell_command":
        if (!this.config.permissions.allowRealShellExecution) {
          return buildExecutionOutcome(
            "success",
            "Shell execution simulated (real shell execution disabled by policy).",
            undefined,
            buildSimulatedExecutionMetadata("SHELL_POLICY_DISABLED")
          );
        }
        {
          const result = await executeShellCommandAction(action.id, action.params, signal, {
            config: this.config,
            shellSpawn: this.shellSpawn
          });
          if (result.telemetry) {
            this.shellExecutionTelemetryByActionId.set(action.id, result.telemetry);
          }
          return result.outcome;
        }

      case "start_process":
        return executeStartProcess(
          this.buildLiveRunContext(),
          action.id,
          action.params,
          signal,
          taskId
        );

      case "check_process":
        return executeCheckProcess(this.buildLiveRunContext(), action.params);

      case "stop_process":
        return executeStopProcess(this.buildLiveRunContext(), action.params);

      case "probe_port":
        return executeProbePort(this.buildLiveRunContext(), action.params, signal);

      case "probe_http":
        return executeProbeHttp(this.buildLiveRunContext(), action.params, signal);

      case "verify_browser":
        return executeBrowserVerification(this.buildLiveRunContext(), action.params, signal);

      default:
        return buildExecutionOutcome(
          "failed",
          "No execution handler found.",
          "ACTION_EXECUTION_FAILED"
        );
    }
  }

  /**
   * Executes input as part of this module's control flow.
   *
   * **Why it exists:**
   * Preserves legacy string-only executor callers while `TaskRunner` consumes typed outcomes.
   *
   * **What it talks to:**
   * - Uses `executeWithOutcome` in this module.
   *
   * @param action - Approved planner action.
   * @param signal - Optional abort signal propagated from caller/runtime surface.
   * @param taskId - Optional owning task id for runtime metadata propagation.
   * @returns Promise resolving to string.
   */
  async execute(action: PlannedAction, signal?: AbortSignal, taskId?: string): Promise<string> {
    const outcome = await this.executeWithOutcome(action, signal, taskId);
    return outcome.output;
  }

  /**
   * Executes real network write as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the real network write runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses `NetworkWriteActionParams` (import `NetworkWriteActionParams`) from `../core/types`.
   *
   * @param params - Structured input object for this operation.
   * @returns Promise resolving to typed executor outcome.
   */
  private async executeRealNetworkWrite(
    params: NetworkWriteActionParams
  ): Promise<ExecutorExecutionOutcome> {
    const endpoint = normalizeOptionalString(params.endpoint) ?? normalizeOptionalString(params.url);
    if (!endpoint) {
      return buildExecutionOutcome(
        "blocked",
        "Network write skipped: missing endpoint.",
        "NETWORK_EGRESS_POLICY_BLOCKED"
      );
    }

    try {
      const payload = params.payload ?? {};
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      return buildExecutionOutcome(
        "success",
        `Network write response: ${response.status} ${response.statusText}`
      );
    } catch (error) {
      return buildExecutionOutcome(
        "failed",
        `Network write failed: ${(error as Error).message}`,
        "ACTION_EXECUTION_FAILED"
      );
    }
  }
}
