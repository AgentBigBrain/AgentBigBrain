/**
 * @fileoverview Executes approved actions against local tooling and simulated high-risk handlers.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BrainConfig } from "../core/config";
import { hashSha256 } from "../core/cryptoUtils";
import {
  buildShellSpawnSpec,
  computeShellProfileFingerprint,
  computeShellSpawnSpecFingerprint,
  resolveShellEnvironment
} from "../core/shellRuntimeProfile";
import {
  NetworkWriteActionParams,
  PlannedAction,
  RespondActionParams,
  ShellCommandActionParams
} from "../core/types";
const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const SHELL_OUTPUT_CAPTURE_MAX_BYTES = 64 * 1024;

/**
 * Resolves workspace path from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of workspace path by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param inputPath - Filesystem location used by this operation.
 * @returns Resulting string value.
 */
function resolveWorkspacePath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  return path.resolve(process.cwd(), inputPath);
}

/**
 * Evaluates safe skill name and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the safe skill name policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param skillName - Value for skill name.
 * @returns `true` when this check passes.
 */
function isSafeSkillName(skillName: string): boolean {
  return SKILL_NAME_PATTERN.test(skillName);
}

/**
 * Normalizes optional string into a stable shape for `executor` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for optional string so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `string | null` result.
 */
function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface CappedTextBuffer {
  text: string;
  bytes: number;
  truncated: boolean;
}

interface ShellExecutionTelemetry {
  shellProfileFingerprint: string;
  shellSpawnSpecFingerprint: string;
  shellKind: string;
  shellExecutable: string;
  shellTimeoutMs: number;
  shellEnvMode: string;
  shellEnvKeyCount: number;
  shellEnvRedactedKeyCount: number;
  shellExitCode: number | null;
  shellSignal: string | null;
  shellTimedOut: boolean;
  shellStdoutDigest: string;
  shellStderrDigest: string;
  shellStdoutBytes: number;
  shellStderrBytes: number;
  shellStdoutTruncated: boolean;
  shellStderrTruncated: boolean;
}

/**
 * Evaluates path within prefix and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the path within prefix policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param targetPath - Filesystem location used by this operation.
 * @param prefix - Value for prefix.
 * @returns `true` when this check passes.
 */
function isPathWithinPrefix(targetPath: string, prefix: string): boolean {
  const normalizedTarget = path.resolve(process.cwd(), targetPath).toLowerCase();
  const normalizedPrefix = path.resolve(process.cwd(), prefix).toLowerCase();
  return (
    normalizedTarget === normalizedPrefix ||
    normalizedTarget.startsWith(`${normalizedPrefix}${path.sep}`) ||
    normalizedTarget.startsWith(`${normalizedPrefix}/`) ||
    normalizedTarget.startsWith(`${normalizedPrefix}\\`)
  );
}

/**
 * Persists chunk to buffer with deterministic state semantics.
 *
 * **Why it exists:**
 * Centralizes chunk to buffer mutations for auditability and replay.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param buffer - Value for buffer.
 * @param chunk - Value for chunk.
 * @returns Computed `CappedTextBuffer` result.
 */
function appendChunkToBuffer(buffer: CappedTextBuffer, chunk: Buffer): CappedTextBuffer {
  if (chunk.length === 0) {
    return buffer;
  }

  if (buffer.truncated || buffer.bytes >= SHELL_OUTPUT_CAPTURE_MAX_BYTES) {
    return {
      ...buffer,
      truncated: true
    };
  }

  const remaining = SHELL_OUTPUT_CAPTURE_MAX_BYTES - buffer.bytes;
  const slice = chunk.subarray(0, remaining);
  return {
    text: buffer.text + slice.toString("utf8"),
    bytes: buffer.bytes + slice.length,
    truncated: buffer.truncated || chunk.length > remaining
  };
}

/**
 * Creates an empty capped text buffer value with deterministic defaults.
 *
 * **Why it exists:**
 * Provides a single default shape for capped text buffer so callers do not diverge on initialization.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @returns Computed `CappedTextBuffer` result.
 */
function emptyCappedTextBuffer(): CappedTextBuffer {
  return {
    text: "",
    bytes: 0,
    truncated: false
  };
}

/**
 * Resolves respond message from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of respond message by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `RespondActionParams` (import `RespondActionParams`) from `../core/types`.
 *
 * @param params - Structured input object for this operation.
 * @returns Computed `string | null` result.
 */
function resolveRespondMessage(params: RespondActionParams): string | null {
  return normalizeOptionalString(params.message) ?? normalizeOptionalString(params.text);
}

/**
 * Selects callable skill export from candidate options.
 *
 * **Why it exists:**
 * Keeps candidate selection logic for callable skill export centralized so outcomes stay consistent.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param moduleNamespace - Value for module namespace.
 * @param preferredExportName - Value for preferred export name.
 * @returns Computed `((input: string) => unknown | Promise<unknown>) | null` result.
 */
function pickCallableSkillExport(
  moduleNamespace: Record<string, unknown>,
  preferredExportName?: string
): ((input: string) => unknown | Promise<unknown>) | null {
  if (preferredExportName) {
    const preferred = moduleNamespace[preferredExportName];
    if (typeof preferred === "function") {
      return preferred as (input: string) => unknown | Promise<unknown>;
    }
  }

  const candidateOrder = [
    moduleNamespace.default,
    moduleNamespace.generatedSkill,
    moduleNamespace.run
  ];
  for (const candidate of candidateOrder) {
    if (typeof candidate === "function") {
      return candidate as (input: string) => unknown | Promise<unknown>;
    }
  }

  for (const exported of Object.values(moduleNamespace)) {
    if (typeof exported === "function") {
      return exported as (input: string) => unknown | Promise<unknown>;
    }
  }

  return null;
}

/**
 * Converts values into skill output summary form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for skill output summary deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param output - Result object inspected or transformed in this step.
 * @returns Resulting string value.
 */
function toSkillOutputSummary(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  if (output && typeof output === "object" && "summary" in output && typeof output.summary === "string") {
    return output.summary;
  }

  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

export class ToolExecutorOrgan {
  private readonly shellExecutionTelemetryByActionId = new Map<string, ShellExecutionTelemetry>();

  /**
   * Initializes `ToolExecutorOrgan` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses `BrainConfig` (import `BrainConfig`) from `../core/config`.
   * - Uses `spawn` (import `spawn`) from `node:child_process`.
   *
   * @param config - Configuration or policy settings applied here.
   * @param shellSpawn - Value for shell spawn.
   */
  constructor(
    private readonly config: BrainConfig,
    private readonly shellSpawn: typeof spawn = spawn
  ) { }

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
   * Isolates the input runtime step so higher-level orchestration stays readable.
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
   * @returns Promise resolving to string.
   */
  async execute(action: PlannedAction): Promise<string> {
    switch (action.type) {
      case "respond": {
        const message = resolveRespondMessage(action.params);
        if (message && message.trim()) {
          return message.trim();
        }
        return "Response action approved.";
      }

      case "read_file": {
        const targetPath = normalizeOptionalString(action.params.path);
        if (!targetPath) {
          return "Read skipped: missing path.";
        }
        try {
          const content = await readFile(resolveWorkspacePath(targetPath), "utf8");
          return `Read success (${content.length} chars).`;
        } catch (error) {
          return `Read failed: ${(error as Error).message}`;
        }
      }

      case "write_file": {
        const targetPath = normalizeOptionalString(action.params.path);
        if (!targetPath) {
          return "Write skipped: missing path.";
        }
        if (typeof action.params.content !== "string") {
          return "Write blocked: missing params.content – planner must supply the file content string.";
        }
        if (action.params.content.length === 0) {
          return "Write blocked: params.content is empty – planner must supply non-empty file content.";
        }
        const outputPath = resolveWorkspacePath(targetPath);
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, action.params.content, "utf8");
        return `Write success: ${targetPath} (${action.params.content.length} chars)`;
      }

      case "delete_file": {
        const targetPath = normalizeOptionalString(action.params.path);
        if (!targetPath) {
          return "Delete skipped: missing path.";
        }
        try {
          await rm(resolveWorkspacePath(targetPath), { force: true });
          return `Delete success: ${targetPath}`;
        } catch (error) {
          return `Delete failed: ${(error as Error).message}`;
        }
      }

      case "list_directory": {
        const targetPath = normalizeOptionalString(action.params.path);
        if (!targetPath) {
          return "List directory skipped: missing path.";
        }
        try {
          const files = await readdir(resolveWorkspacePath(targetPath));
          return `Directory contents:\n${files.join("\n")}`;
        } catch (error) {
          return `List directory failed: ${(error as Error).message}`;
        }
      }

      case "create_skill": {
        const skillName = normalizeOptionalString(action.params.name);
        const code = normalizeOptionalString(action.params.code);
        if (!skillName || !code) {
          return "Create skill skipped: missing name or code.";
        }
        if (!isSafeSkillName(skillName)) {
          return "Create skill blocked: invalid skill name format.";
        }
        try {
          const skillsDir = path.resolve(resolveWorkspacePath("runtime/skills"));
          await mkdir(skillsDir, { recursive: true });
          const skillPath = path.resolve(path.join(skillsDir, `${skillName}.ts`));
          if (!skillPath.startsWith(skillsDir)) {
            return "Create skill blocked: skill path escaped skills directory.";
          }
          await writeFile(skillPath, code, "utf8");
          return `Skill created successfully: ${skillName}.ts`;
        } catch (error) {
          return `Create skill failed: ${(error as Error).message}`;
        }
      }

      case "run_skill": {
        const skillName = normalizeOptionalString(action.params.name);
        if (!skillName) {
          return "Run skill skipped: missing skill name.";
        }
        if (!isSafeSkillName(skillName)) {
          return "Run skill blocked: invalid skill name format.";
        }

        const exportName = normalizeOptionalString(action.params.exportName) ?? undefined;
        const input =
          normalizeOptionalString(action.params.input) ??
          normalizeOptionalString(action.params.text) ??
          "";
        const skillPath = path.resolve(resolveWorkspacePath(`runtime/skills/${skillName}.ts`));
        const skillsRoot = path.resolve(resolveWorkspacePath("runtime/skills"));
        if (!skillPath.startsWith(skillsRoot)) {
          return "Run skill blocked: skill path escaped skills directory.";
        }

        try {
          const moduleUrl = `${pathToFileURL(skillPath).href}?cacheBust=${Date.now()}`;
          const moduleNamespace = (await import(moduleUrl)) as Record<string, unknown>;
          const callable = pickCallableSkillExport(moduleNamespace, exportName);
          if (!callable) {
            return `Run skill failed: no callable export found in ${skillName}.ts`;
          }

          const result = await callable(input);
          return `Run skill success: ${skillName} -> ${toSkillOutputSummary(result)}`;
        } catch (error) {
          return `Run skill failed: ${(error as Error).message}`;
        }
      }

      case "network_write":
        if (!this.config.permissions.allowRealNetworkWrite) {
          return "Network write simulated (real network write disabled by policy).";
        }
        return this.executeRealNetworkWrite(action.params);

      case "self_modify":
        return "Self-modification simulated (requires governance workflow).";

      case "shell_command":
        if (!this.config.permissions.allowRealShellExecution) {
          return "Shell execution simulated (real shell execution disabled by policy).";
        }
        return this.executeRealShellCommand(action.id, action.params);

      case "memory_mutation": {
        return "Memory mutation blocked: Stage 6.86 actions must execute through TaskRunner runtime action engine.";
      }

      case "pulse_emit": {
        return "Pulse emit blocked: Stage 6.86 actions must execute through TaskRunner runtime action engine.";
      }

      default:
        return "No execution handler found.";
    }
  }

  /**
   * Executes real shell command as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the real shell command runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses `hashSha256` (import `hashSha256`) from `../core/cryptoUtils`.
   * - Uses `buildShellSpawnSpec` (import `buildShellSpawnSpec`) from `../core/shellRuntimeProfile`.
   * - Uses `computeShellProfileFingerprint` (import `computeShellProfileFingerprint`) from `../core/shellRuntimeProfile`.
   * - Uses `computeShellSpawnSpecFingerprint` (import `computeShellSpawnSpecFingerprint`) from `../core/shellRuntimeProfile`.
   * - Uses `resolveShellEnvironment` (import `resolveShellEnvironment`) from `../core/shellRuntimeProfile`.
   * - Uses `ShellCommandActionParams` (import `ShellCommandActionParams`) from `../core/types`.
   *
   * @param actionId - Stable identifier used to reference an entity or record.
   * @param params - Structured input object for this operation.
   * @returns Promise resolving to string.
   */
  private async executeRealShellCommand(
    actionId: string,
    params: ShellCommandActionParams
  ): Promise<string> {
    const command = normalizeOptionalString(params.command);
    if (!command) {
      return "Shell execution skipped: missing command.";
    }

    const resolvedCwd = this.resolveShellCommandCwd(params);
    if (!resolvedCwd) {
      return "Shell execution blocked: requested cwd is outside sandbox policy.";
    }

    const timeoutMs = this.resolveShellCommandTimeoutMs(params);
    const shellEnvironment = resolveShellEnvironment(this.config.shellRuntime.profile, process.env);
    const spawnSpec = buildShellSpawnSpec({
      profile: this.config.shellRuntime.profile,
      command,
      cwd: resolvedCwd,
      timeoutMs,
      envKeyNames: shellEnvironment.envKeyNames
    });
    const shellProfileFingerprint = computeShellProfileFingerprint(this.config.shellRuntime.profile);
    const shellSpawnSpecFingerprint = computeShellSpawnSpecFingerprint(spawnSpec);

    try {
      const result = await this.runShellProcess(spawnSpec, shellEnvironment.env);
      this.shellExecutionTelemetryByActionId.set(actionId, {
        shellProfileFingerprint,
        shellSpawnSpecFingerprint,
        shellKind: this.config.shellRuntime.profile.shellKind,
        shellExecutable: spawnSpec.executable,
        shellTimeoutMs: spawnSpec.timeoutMs,
        shellEnvMode: this.config.shellRuntime.profile.envPolicy.mode,
        shellEnvKeyCount: shellEnvironment.envKeyNames.length,
        shellEnvRedactedKeyCount: shellEnvironment.redactedEnvKeyNames.length,
        shellExitCode: result.exitCode,
        shellSignal: result.signal,
        shellTimedOut: result.timedOut,
        shellStdoutDigest: hashSha256(result.stdout.text),
        shellStderrDigest: hashSha256(result.stderr.text),
        shellStdoutBytes: result.stdout.bytes,
        shellStderrBytes: result.stderr.bytes,
        shellStdoutTruncated: result.stdout.truncated,
        shellStderrTruncated: result.stderr.truncated
      });

      if (result.timedOut) {
        return `Shell failed: command timed out after ${spawnSpec.timeoutMs}ms.`;
      }

      const combinedOutput = [result.stdout.text, result.stderr.text]
        .filter((value) => value.trim().length > 0)
        .join("\n")
        .trim();
      if ((result.exitCode ?? 0) !== 0) {
        if (combinedOutput.length > 0) {
          return `Shell failed (exit code ${result.exitCode ?? "unknown"}):\n${combinedOutput}`;
        }
        return `Shell failed (exit code ${result.exitCode ?? "unknown"}).`;
      }
      return combinedOutput.length > 0
        ? `Shell success:\n${combinedOutput}`
        : "Shell success: command returned no output.";
    } catch (error) {
      return `Shell failed: ${(error as Error).message}`;
    }
  }

  /**
   * Resolves shell command timeout ms from available runtime context.
   *
   * **Why it exists:**
   * Prevents divergent selection of shell command timeout ms by keeping rules in one function.
   *
   * **What it talks to:**
   * - Uses `ShellCommandActionParams` (import `ShellCommandActionParams`) from `../core/types`.
   *
   * @param params - Structured input object for this operation.
   * @returns Computed numeric value.
   */
  private resolveShellCommandTimeoutMs(params: ShellCommandActionParams): number {
    if (typeof params.timeoutMs !== "number" || !Number.isInteger(params.timeoutMs)) {
      return this.config.shellRuntime.profile.timeoutMsDefault;
    }
    if (
      params.timeoutMs < this.config.shellRuntime.timeoutBoundsMs.min ||
      params.timeoutMs > this.config.shellRuntime.timeoutBoundsMs.max
    ) {
      return this.config.shellRuntime.profile.timeoutMsDefault;
    }
    return params.timeoutMs;
  }

  /**
   * Resolves shell command cwd from available runtime context.
   *
   * **Why it exists:**
   * Prevents divergent selection of shell command cwd by keeping rules in one function.
   *
   * **What it talks to:**
   * - Uses `ShellCommandActionParams` (import `ShellCommandActionParams`) from `../core/types`.
   *
   * @param params - Structured input object for this operation.
   * @returns Computed `string | null` result.
   */
  private resolveShellCommandCwd(params: ShellCommandActionParams): string | null {
    const requestedCwd =
      normalizeOptionalString(params.cwd) ?? normalizeOptionalString(params.workdir);
    const cwd = requestedCwd ? resolveWorkspacePath(requestedCwd) : process.cwd();
    if (
      this.config.shellRuntime.profile.cwdPolicy.denyOutsideSandbox &&
      !isPathWithinPrefix(cwd, this.config.dna.sandboxPathPrefix)
    ) {
      return null;
    }
    return cwd;
  }

  /**
   * Executes shell process as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the shell process runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses `buildShellSpawnSpec` (import `buildShellSpawnSpec`) from `../core/shellRuntimeProfile`.
   *
   * @param spawnSpec - Value for spawn spec.
   * @param env - Value for env.
   * @returns Promise resolving to {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdout: CappedTextBuffer;
    stderr: CappedTextBuffer;
  }.
   */
  private async runShellProcess(
    spawnSpec: ReturnType<typeof buildShellSpawnSpec>,
    env: NodeJS.ProcessEnv
  ): Promise<{
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdout: CappedTextBuffer;
    stderr: CappedTextBuffer;
  }> {
    return new Promise((resolve, reject) => {
      const child = this.shellSpawn(spawnSpec.executable, [...spawnSpec.args], {
        cwd: spawnSpec.cwd,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdoutBuffer = emptyCappedTextBuffer();
      let stderrBuffer = emptyCappedTextBuffer();
      let timedOut = false;

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, spawnSpec.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer = appendChunkToBuffer(stdoutBuffer, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuffer = appendChunkToBuffer(stderrBuffer, chunk);
      });
      child.once("error", (error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeoutHandle);
        resolve({
          exitCode: code,
          signal,
          timedOut,
          stdout: stdoutBuffer,
          stderr: stderrBuffer
        });
      });
    });
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
   * @returns Promise resolving to string.
   */
  private async executeRealNetworkWrite(params: NetworkWriteActionParams): Promise<string> {
    const endpoint = normalizeOptionalString(params.endpoint) ?? normalizeOptionalString(params.url);
    if (!endpoint) {
      return "Network write skipped: missing endpoint.";
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
      return `Network write response: ${response.status} ${response.statusText}`;
    } catch (error) {
      return `Network write failed: ${(error as Error).message}`;
    }
  }
}
