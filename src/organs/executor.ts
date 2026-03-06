/**
 * @fileoverview Executes approved actions against local tooling and simulated high-risk handlers.
 */

import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BrainConfig } from "../core/config";
import { hashSha256 } from "../core/cryptoUtils";
import { DEFAULT_RUNTIME_ENTROPY_SOURCE } from "../core/runtimeEntropy";
import {
  buildShellSpawnSpec,
  computeShellProfileFingerprint,
  computeShellSpawnSpecFingerprint,
  resolveShellEnvironment
} from "../core/shellRuntimeProfile";
import {
  ConstraintViolationCode,
  ExecutorExecutionOutcome,
  ExecutorExecutionStatus,
  NetworkWriteActionParams,
  PlannedAction,
  RespondActionParams,
  RuntimeTraceDetailValue,
  ShellCommandActionParams
} from "../core/types";
const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PRIMARY_SKILL_EXTENSION = ".js";
const COMPATIBILITY_SKILL_EXTENSION = ".ts";
const SHELL_OUTPUT_CAPTURE_MAX_BYTES = 64 * 1024;
const READ_FILE_OUTPUT_MAX_CHARS = 4000;

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

interface SkillArtifactPaths {
  skillsRoot: string;
  primaryPath: string;
  compatibilityPath: string;
}

interface ResolvedSkillArtifact {
  path: string;
  extension: ".js" | ".ts";
}

interface TypeScriptTranspiler {
  transpileModule: (
    sourceCode: string,
    options: {
      compilerOptions: {
        module: number;
        target: number;
      };
    }
  ) => { outputText: string };
  ModuleKind?: {
    ESNext: number;
  };
  ScriptTarget?: {
    ES2020: number;
  };
}

let cachedTypeScriptTranspiler: TypeScriptTranspiler | "unavailable" | null = null;

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
 * Resolves skill artifact paths from available runtime context.
 *
 * **Why it exists:**
 * Centralizes deterministic primary/fallback skill artifact naming so create/run surfaces stay aligned.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param skillName - Value for skill name.
 * @returns Computed `SkillArtifactPaths` result.
 */
function resolveSkillArtifactPaths(skillName: string): SkillArtifactPaths {
  const skillsRoot = path.resolve(resolveWorkspacePath("runtime/skills"));
  return {
    skillsRoot,
    primaryPath: path.resolve(path.join(skillsRoot, `${skillName}${PRIMARY_SKILL_EXTENSION}`)),
    compatibilityPath: path.resolve(
      path.join(skillsRoot, `${skillName}${COMPATIBILITY_SKILL_EXTENSION}`)
    )
  };
}

/**
 * Evaluates skill artifact path and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Prevents runtime writes/loads from escaping the skills root through path traversal patterns.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param artifactPath - Filesystem location used by this operation.
 * @param skillsRoot - Filesystem location used by this operation.
 * @returns `true` when this check passes.
 */
function isSkillArtifactPathWithinRoot(artifactPath: string, skillsRoot: string): boolean {
  const normalizedArtifact = path.resolve(artifactPath).toLowerCase();
  const normalizedRoot = path.resolve(skillsRoot).toLowerCase();
  return (
    normalizedArtifact === normalizedRoot ||
    normalizedArtifact.startsWith(`${normalizedRoot}${path.sep}`) ||
    normalizedArtifact.startsWith(`${normalizedRoot}/`) ||
    normalizedArtifact.startsWith(`${normalizedRoot}\\`)
  );
}

/**
 * Evaluates file exists and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps file-existence checks explicit so skill artifact fallback behavior is easy to audit and test.
 *
 * **What it talks to:**
 * - Uses `access` (import `access`) from `node:fs/promises`.
 *
 * @param targetPath - Filesystem location used by this operation.
 * @returns Promise resolving to `true` when this check passes.
 */
async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves existing skill artifact from available runtime context.
 *
 * **Why it exists:**
 * Implements deterministic `.js` primary with `.ts` compatibility fallback for migration safety.
 *
 * **What it talks to:**
 * - Uses `fileExists` in this module.
 *
 * @param paths - Structured skill artifact paths.
 * @returns Promise resolving to resolved artifact metadata or `null` when missing.
 */
async function resolveExistingSkillArtifact(
  paths: SkillArtifactPaths
): Promise<ResolvedSkillArtifact | null> {
  if (await fileExists(paths.primaryPath)) {
    return {
      path: paths.primaryPath,
      extension: PRIMARY_SKILL_EXTENSION
    };
  }
  if (await fileExists(paths.compatibilityPath)) {
    return {
      path: paths.compatibilityPath,
      extension: COMPATIBILITY_SKILL_EXTENSION
    };
  }
  return null;
}

/**
 * Resolves optional TypeScript transpiler from available runtime context.
 *
 * **Why it exists:**
 * Prefers stable `typescript.transpileModule` output when package is present, while allowing a
 * deterministic built-in fallback when it is absent.
 *
 * **What it talks to:**
 * - Uses dynamic import of optional `typescript` package.
 *
 * @returns Promise resolving to transpiler module or `null` when unavailable.
 */
async function loadTypeScriptTranspiler(): Promise<TypeScriptTranspiler | null> {
  if (cachedTypeScriptTranspiler === "unavailable") {
    return null;
  }
  if (cachedTypeScriptTranspiler) {
    return cachedTypeScriptTranspiler;
  }

  try {
    const importedModule = (await import("typescript")) as {
      default?: TypeScriptTranspiler;
      transpileModule?: TypeScriptTranspiler["transpileModule"];
      ModuleKind?: TypeScriptTranspiler["ModuleKind"];
      ScriptTarget?: TypeScriptTranspiler["ScriptTarget"];
    };
    const candidate = (importedModule.default ?? importedModule) as TypeScriptTranspiler;
    if (typeof candidate.transpileModule === "function") {
      cachedTypeScriptTranspiler = candidate;
      return candidate;
    }
  } catch {
    // Fall through to built-in stripTypeScriptTypes fallback.
  }

  cachedTypeScriptTranspiler = "unavailable";
  return null;
}

/**
 * Compiles skill source into JavaScript for deterministic runtime loading.
 *
 * **Why it exists:**
 * Ensures create-skill writes a Node-loadable primary artifact without requiring tsx loader wiring.
 *
 * **What it talks to:**
 * - Uses optional `typescript` transpile path when available.
 * - Uses `stripTypeScriptTypes` (import `stripTypeScriptTypes`) from `node:module` as fallback.
 *
 * @param sourceCode - Value for source code.
 * @returns Promise resolving to resulting JavaScript source.
 */
async function compileSkillSourceToJavaScript(sourceCode: string): Promise<string> {
  const transpiler = await loadTypeScriptTranspiler();
  if (transpiler) {
    const moduleKindEsNext = transpiler.ModuleKind?.ESNext ?? 99;
    const scriptTargetEs2020 = transpiler.ScriptTarget?.ES2020 ?? 7;
    return transpiler.transpileModule(sourceCode, {
      compilerOptions: {
        module: moduleKindEsNext,
        target: scriptTargetEs2020
      }
    }).outputText;
  }

  return stripTypeScriptTypes(sourceCode, { mode: "transform" });
}

/**
 * Builds import URL from available runtime context.
 *
 * **Why it exists:**
 * Keeps dynamic module import URL construction centralized for deterministic cache-busting and source attribution.
 *
 * **What it talks to:**
 * - Uses `pathToFileURL` (import `pathToFileURL`) from `node:url`.
 *
 * @param artifactPath - Filesystem location used by this operation.
 * @returns Resulting string value.
 */
function buildFileImportUrl(artifactPath: string): string {
  const cacheBust = DEFAULT_RUNTIME_ENTROPY_SOURCE.nowMs();
  return `${pathToFileURL(artifactPath).href}?cacheBust=${cacheBust}`;
}

/**
 * Loads module namespace from available runtime context.
 *
 * **Why it exists:**
 * Preserves true ESM dynamic import semantics in compiled CommonJS builds where TypeScript would
 * otherwise rewrite `import(...)` to `require(...)` and break `file://`/`data:` loading paths.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param specifier - Module specifier consumed by runtime dynamic import.
 * @returns Promise resolving to loaded module namespace.
 */
async function importModuleNamespaceAtRuntime(specifier: string): Promise<Record<string, unknown>> {
  const runtimeDynamicImport = new Function(
    "moduleSpecifier",
    "return import(moduleSpecifier);"
  ) as (moduleSpecifier: string) => Promise<unknown>;
  return (await runtimeDynamicImport(specifier)) as Record<string, unknown>;
}

/**
 * Builds import URL from available runtime context.
 *
 * **Why it exists:**
 * Allows ESM loading from transformed source text independent of on-disk extension/module mode.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param javascriptSource - JavaScript source used for the data module.
 * @param sourcePath - Filesystem location used by this operation.
 * @returns Resulting string value.
 */
function buildDataModuleImportUrl(javascriptSource: string, sourcePath: string): string {
  const normalizedSourcePath = sourcePath.replace(/\\/g, "/");
  const attributedSource = `${javascriptSource}\n//# sourceURL=${normalizedSourcePath}`;
  return `data:text/javascript;base64,${Buffer.from(attributedSource, "utf8").toString("base64")}`;
}

/**
 * Evaluates module import error and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Detects extension/module-mode mismatch cases where `.js` artifact should be reloaded through data-URL ESM path.
 *
 * **What it talks to:**
 * - Uses local string-pattern checks in this module.
 *
 * @param error - Result object inspected or transformed in this step.
 * @returns `true` when this check passes.
 */
function shouldRetryJavaScriptImportViaDataUrl(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /Unexpected token 'export'/i.test(message) ||
    /Cannot use import statement outside a module/i.test(message) ||
    /module is not defined/i.test(message)
  );
}

/**
 * Resolves skill module namespace from available runtime context.
 *
 * **Why it exists:**
 * Centralizes `.js` primary / `.ts` fallback load semantics and deterministic transform-to-ESM behavior.
 *
 * **What it talks to:**
 * - Uses `buildFileImportUrl` and `buildDataModuleImportUrl` helpers in this module.
 * - Uses `compileSkillSourceToJavaScript` helper in this module.
 * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
 *
 * @param artifact - Resolved artifact metadata for skill execution.
 * @returns Promise resolving to loaded module namespace.
 */
async function loadSkillModuleNamespace(
  artifact: ResolvedSkillArtifact
): Promise<Record<string, unknown>> {
  if (artifact.extension === PRIMARY_SKILL_EXTENSION) {
    const fileImportUrl = buildFileImportUrl(artifact.path);
    try {
      return await importModuleNamespaceAtRuntime(fileImportUrl);
    } catch (error) {
      if (!shouldRetryJavaScriptImportViaDataUrl(error)) {
        throw error;
      }
      const jsSource = await readFile(artifact.path, "utf8");
      const dataImportUrl = buildDataModuleImportUrl(jsSource, artifact.path);
      return await importModuleNamespaceAtRuntime(dataImportUrl);
    }
  }

  const tsSource = await readFile(artifact.path, "utf8");
  const transformedSource = await compileSkillSourceToJavaScript(tsSource);
  const dataImportUrl = buildDataModuleImportUrl(transformedSource, artifact.path);
  return await importModuleNamespaceAtRuntime(dataImportUrl);
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
  const defaultNamespaceCandidate =
    typeof moduleNamespace.default === "object" && moduleNamespace.default !== null
      ? (moduleNamespace.default as Record<string, unknown>)
      : null;

  if (preferredExportName) {
    const preferred = moduleNamespace[preferredExportName];
    if (typeof preferred === "function") {
      return preferred as (input: string) => unknown | Promise<unknown>;
    }
    if (defaultNamespaceCandidate) {
      const defaultPreferred = defaultNamespaceCandidate[preferredExportName];
      if (typeof defaultPreferred === "function") {
        return defaultPreferred as (input: string) => unknown | Promise<unknown>;
      }
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

  if (defaultNamespaceCandidate) {
    for (const exported of Object.values(defaultNamespaceCandidate)) {
      if (typeof exported === "function") {
        return exported as (input: string) => unknown | Promise<unknown>;
      }
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

/**
 * Builds bounded read-file success output with deterministic truncation details.
 *
 * **Why it exists:**
 * Keeps `read_file` output stable and bounded so operators get useful content without unbounded
 * payload growth in receipts/logs.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param targetPath - User-supplied file path associated with this read.
 * @param content - Full UTF-8 file content read from disk.
 * @returns Rendered success output + deterministic metadata for tracing/receipts.
 */
function buildReadFileSuccessOutput(
  targetPath: string,
  content: string
): {
  output: string;
  executionMetadata: Record<string, RuntimeTraceDetailValue>;
} {
  const totalChars = content.length;
  const truncated = totalChars > READ_FILE_OUTPUT_MAX_CHARS;
  const preview = truncated ? content.slice(0, READ_FILE_OUTPUT_MAX_CHARS) : content;
  const outputLines = [
    `Read success: ${targetPath} (${totalChars} chars${truncated ? `, truncated to ${READ_FILE_OUTPUT_MAX_CHARS}` : ""}).`,
    "Read preview:",
    preview
  ];
  if (truncated) {
    outputLines.push("[...truncated]");
  }

  return {
    output: outputLines.join("\n"),
    executionMetadata: {
      readFilePath: targetPath,
      readFileTotalChars: totalChars,
      readFileReturnedChars: preview.length,
      readFileTruncated: truncated
    }
  };
}

/**
 * Builds a typed executor outcome with deterministic defaults.
 *
 * **Why it exists:**
 * Centralizes typed outcome construction so action handlers return one stable contract.
 *
 * **What it talks to:**
 * - Uses `ExecutorExecutionOutcome` (import `ExecutorExecutionOutcome`) from `../core/types`.
 *
 * @param status - Typed executor status.
 * @param output - Human-readable execution output for logs and user-facing summaries.
 * @param failureCode - Optional typed failure/block code for fail-closed runtime mapping.
 * @param executionMetadata - Optional execution metadata bag for trace/receipt propagation.
 * @returns Typed executor outcome.
 */
function buildExecutionOutcome(
  status: ExecutorExecutionStatus,
  output: string,
  failureCode?: ConstraintViolationCode,
  executionMetadata?: Record<string, RuntimeTraceDetailValue>
): ExecutorExecutionOutcome {
  return {
    status,
    output,
    failureCode,
    executionMetadata
  };
}

/**
 * Builds simulated execution metadata for typed downstream evidence checks.
 *
 * **Why it exists:**
 * Keeps simulation tagging deterministic so autonomous completion/trust policy code can exclude
 * simulated outcomes from real side-effect evidence.
 *
 * **What it talks to:**
 * - Uses `RuntimeTraceDetailValue` (import `RuntimeTraceDetailValue`) from `../core/types`.
 *
 * @param simulationReason - Stable reason code for why execution was simulated.
 * @returns Metadata object for receipt/trace propagation.
 */
function buildSimulatedExecutionMetadata(
  simulationReason: string
): Record<string, RuntimeTraceDetailValue> {
  return {
    simulatedExecution: true,
    simulatedExecutionReason: simulationReason
  };
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
   * @returns Promise resolving to typed executor outcome.
   */
  async executeWithOutcome(action: PlannedAction): Promise<ExecutorExecutionOutcome> {
    switch (action.type) {
      case "respond": {
        const message = resolveRespondMessage(action.params);
        if (message && message.trim()) {
          return buildExecutionOutcome("success", message.trim());
        }
        return buildExecutionOutcome("success", "Response action approved.");
      }

      case "read_file": {
        const targetPath = normalizeOptionalString(action.params.path);
        if (!targetPath) {
          return buildExecutionOutcome("blocked", "Read skipped: missing path.", "READ_MISSING_PATH");
        }
        try {
          const content = await readFile(resolveWorkspacePath(targetPath), "utf8");
          const { output, executionMetadata } = buildReadFileSuccessOutput(
            targetPath,
            content
          );
          return buildExecutionOutcome("success", output, undefined, executionMetadata);
        } catch (error) {
          return buildExecutionOutcome(
            "failed",
            `Read failed: ${(error as Error).message}`,
            "ACTION_EXECUTION_FAILED"
          );
        }
      }

      case "write_file": {
        const targetPath = normalizeOptionalString(action.params.path);
        if (!targetPath) {
          return buildExecutionOutcome("blocked", "Write skipped: missing path.", "WRITE_MISSING_PATH");
        }
        if (typeof action.params.content !== "string") {
          return buildExecutionOutcome(
            "blocked",
            "Write blocked: missing params.content - planner must supply the file content string.",
            "ACTION_EXECUTION_FAILED"
          );
        }
        if (action.params.content.length === 0) {
          return buildExecutionOutcome(
            "blocked",
            "Write blocked: params.content is empty - planner must supply non-empty file content.",
            "ACTION_EXECUTION_FAILED"
          );
        }
        try {
          const outputPath = resolveWorkspacePath(targetPath);
          await mkdir(path.dirname(outputPath), { recursive: true });
          await writeFile(outputPath, action.params.content, "utf8");
          return buildExecutionOutcome(
            "success",
            `Write success: ${targetPath} (${action.params.content.length} chars)`
          );
        } catch (error) {
          return buildExecutionOutcome(
            "failed",
            `Write failed: ${(error as Error).message}`,
            "ACTION_EXECUTION_FAILED"
          );
        }
      }

      case "delete_file": {
        const targetPath = normalizeOptionalString(action.params.path);
        if (!targetPath) {
          return buildExecutionOutcome("blocked", "Delete skipped: missing path.", "DELETE_MISSING_PATH");
        }
        try {
          await rm(resolveWorkspacePath(targetPath), { force: true });
          return buildExecutionOutcome("success", `Delete success: ${targetPath}`);
        } catch (error) {
          return buildExecutionOutcome(
            "failed",
            `Delete failed: ${(error as Error).message}`,
            "ACTION_EXECUTION_FAILED"
          );
        }
      }

      case "list_directory": {
        const targetPath = normalizeOptionalString(action.params.path);
        if (!targetPath) {
          return buildExecutionOutcome(
            "blocked",
            "List directory skipped: missing path.",
            "LIST_MISSING_PATH"
          );
        }
        try {
          const files = await readdir(resolveWorkspacePath(targetPath));
          return buildExecutionOutcome("success", `Directory contents:\n${files.join("\n")}`);
        } catch (error) {
          return buildExecutionOutcome(
            "failed",
            `List directory failed: ${(error as Error).message}`,
            "ACTION_EXECUTION_FAILED"
          );
        }
      }

      case "create_skill": {
        const skillName = normalizeOptionalString(action.params.name);
        const code = normalizeOptionalString(action.params.code);
        if (!skillName) {
          return buildExecutionOutcome(
            "blocked",
            "Create skill blocked: missing name.",
            "CREATE_SKILL_MISSING_NAME"
          );
        }
        if (!code) {
          return buildExecutionOutcome(
            "blocked",
            "Create skill blocked: missing code.",
            "CREATE_SKILL_MISSING_CODE"
          );
        }
        if (!isSafeSkillName(skillName)) {
          return buildExecutionOutcome(
            "blocked",
            "Create skill blocked: invalid skill name format.",
            "CREATE_SKILL_INVALID_NAME"
          );
        }
        try {
          const artifactPaths = resolveSkillArtifactPaths(skillName);
          await mkdir(artifactPaths.skillsRoot, { recursive: true });
          if (
            !isSkillArtifactPathWithinRoot(artifactPaths.primaryPath, artifactPaths.skillsRoot) ||
            !isSkillArtifactPathWithinRoot(
              artifactPaths.compatibilityPath,
              artifactPaths.skillsRoot
            )
          ) {
            return buildExecutionOutcome(
              "blocked",
              "Create skill blocked: skill path escaped skills directory.",
              "ACTION_EXECUTION_FAILED"
            );
          }
          const javascriptCode = await compileSkillSourceToJavaScript(code);
          await writeFile(artifactPaths.primaryPath, javascriptCode, "utf8");
          await writeFile(artifactPaths.compatibilityPath, code, "utf8");
          return buildExecutionOutcome(
            "success",
            `Skill created successfully: ${skillName}.js (compat: ${skillName}.ts)`
          );
        } catch (error) {
          return buildExecutionOutcome(
            "failed",
            `Create skill failed: ${(error as Error).message}`,
            "ACTION_EXECUTION_FAILED"
          );
        }
      }

      case "run_skill": {
        const skillName = normalizeOptionalString(action.params.name);
        if (!skillName) {
          return buildExecutionOutcome(
            "blocked",
            "Run skill blocked: missing skill name.",
            "RUN_SKILL_MISSING_NAME"
          );
        }
        if (!isSafeSkillName(skillName)) {
          return buildExecutionOutcome(
            "blocked",
            "Run skill blocked: invalid skill name format.",
            "RUN_SKILL_INVALID_NAME"
          );
        }

        const exportName = normalizeOptionalString(action.params.exportName) ?? undefined;
        const input =
          normalizeOptionalString(action.params.input) ??
          normalizeOptionalString(action.params.text) ??
          "";
        const artifactPaths = resolveSkillArtifactPaths(skillName);
        if (
          !isSkillArtifactPathWithinRoot(artifactPaths.primaryPath, artifactPaths.skillsRoot) ||
          !isSkillArtifactPathWithinRoot(
            artifactPaths.compatibilityPath,
            artifactPaths.skillsRoot
          )
        ) {
          return buildExecutionOutcome(
            "blocked",
            "Run skill blocked: skill path escaped skills directory.",
            "ACTION_EXECUTION_FAILED"
          );
        }

        const resolvedArtifact = await resolveExistingSkillArtifact(artifactPaths);
        if (!resolvedArtifact) {
          return buildExecutionOutcome(
            "failed",
            `Run skill failed: no skill artifact found for ${skillName}.`,
            "RUN_SKILL_ARTIFACT_MISSING"
          );
        }

        try {
          const moduleNamespace = await loadSkillModuleNamespace(resolvedArtifact);
          const callable = pickCallableSkillExport(moduleNamespace, exportName);
          if (!callable) {
            return buildExecutionOutcome(
              "failed",
              `Run skill failed: no callable export found in ${path.basename(resolvedArtifact.path)}.`,
              "RUN_SKILL_INVALID_EXPORT"
            );
          }

          const result = await callable(input);
          return buildExecutionOutcome(
            "success",
            `Run skill success: ${skillName} -> ${toSkillOutputSummary(result)}`
          );
        } catch (error) {
          return buildExecutionOutcome(
            "failed",
            `Run skill failed: ${(error as Error).message}`,
            "RUN_SKILL_LOAD_FAILED"
          );
        }
      }

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
        return this.executeRealShellCommand(action.id, action.params);

      case "memory_mutation": {
        return buildExecutionOutcome(
          "blocked",
          "Memory mutation blocked: Stage 6.86 actions must execute through TaskRunner runtime action engine.",
          "MEMORY_MUTATION_BLOCKED"
        );
      }

      case "pulse_emit": {
        return buildExecutionOutcome(
          "blocked",
          "Pulse emit blocked: Stage 6.86 actions must execute through TaskRunner runtime action engine.",
          "PULSE_BLOCKED"
        );
      }

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
   * @returns Promise resolving to string.
   */
  async execute(action: PlannedAction): Promise<string> {
    const outcome = await this.executeWithOutcome(action);
    return outcome.output;
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
   * @returns Promise resolving to typed executor outcome.
   */
  private async executeRealShellCommand(
    actionId: string,
    params: ShellCommandActionParams
  ): Promise<ExecutorExecutionOutcome> {
    const command = normalizeOptionalString(params.command);
    if (!command) {
      return buildExecutionOutcome(
        "blocked",
        "Shell execution skipped: missing command.",
        "SHELL_MISSING_COMMAND"
      );
    }

    const resolvedCwd = this.resolveShellCommandCwd(params);
    if (!resolvedCwd) {
      return buildExecutionOutcome(
        "blocked",
        "Shell execution blocked: requested cwd is outside sandbox policy.",
        "SHELL_CWD_OUTSIDE_SANDBOX"
      );
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
        return buildExecutionOutcome(
          "failed",
          `Shell failed: command timed out after ${spawnSpec.timeoutMs}ms.`,
          "ACTION_EXECUTION_FAILED"
        );
      }

      const combinedOutput = [result.stdout.text, result.stderr.text]
        .filter((value) => value.trim().length > 0)
        .join("\n")
        .trim();
      if ((result.exitCode ?? 0) !== 0) {
        if (combinedOutput.length > 0) {
          return buildExecutionOutcome(
            "failed",
            `Shell failed (exit code ${result.exitCode ?? "unknown"}):\n${combinedOutput}`,
            "ACTION_EXECUTION_FAILED"
          );
        }
        return buildExecutionOutcome(
          "failed",
          `Shell failed (exit code ${result.exitCode ?? "unknown"}).`,
          "ACTION_EXECUTION_FAILED"
        );
      }
      return buildExecutionOutcome(
        "success",
        combinedOutput.length > 0
          ? `Shell success:\n${combinedOutput}`
          : "Shell success: command returned no output."
      );
    } catch (error) {
      return buildExecutionOutcome(
        "failed",
        `Shell failed: ${(error as Error).message}`,
        "ACTION_EXECUTION_FAILED"
      );
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
