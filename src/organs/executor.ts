/**
 * @fileoverview Executes approved actions against local tooling and simulated high-risk handlers.
 */

import { ChildProcess, ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { stripTypeScriptTypes } from "node:module";
import * as net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BrainConfig } from "../core/config";
import { hashSha256 } from "../core/cryptoUtils";
import { DEFAULT_RUNTIME_ENTROPY_SOURCE } from "../core/runtimeEntropy";
import { createAbortError, isAbortError, throwIfAborted } from "../core/runtimeAbort";
import {
  buildShellSpawnSpec,
  computeShellProfileFingerprint,
  computeShellSpawnSpecFingerprint,
  resolveShellEnvironment
} from "../core/shellRuntimeProfile";
import {
  CheckProcessActionParams,
  ConstraintViolationCode,
  ExecutorExecutionOutcome,
  ExecutorExecutionStatus,
  ManagedProcessLifecycleCode,
  NetworkWriteActionParams,
  PlannedAction,
  ProbeHttpActionParams,
  ProbePortActionParams,
  RespondActionParams,
  RuntimeTraceDetailValue,
  ShellCommandActionParams,
  StartProcessActionParams,
  StopProcessActionParams,
  VerifyBrowserActionParams
} from "../core/types";
import {
  ManagedProcessRegistry,
  ManagedProcessSnapshot
} from "./managedProcessRegistry";
import { BrowserVerifier, PlaywrightBrowserVerifier } from "./browserVerifier";
const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PRIMARY_SKILL_EXTENSION = ".js";
const COMPATIBILITY_SKILL_EXTENSION = ".ts";
const SHELL_OUTPUT_CAPTURE_MAX_BYTES = 64 * 1024;
const READ_FILE_OUTPUT_MAX_CHARS = 4000;
const MANAGED_PROCESS_START_TIMEOUT_MS = 1_000;
const MANAGED_PROCESS_STOP_TIMEOUT_MS = 2_000;
const PROCESS_TREE_TERMINATION_TIMEOUT_MS = 2_000;
const MANAGED_PROCESS_PORT_PRECHECK_TIMEOUT_MS = 250;
const READINESS_PROBE_TIMEOUT_MS_DEFAULT = 2_000;
const BROWSER_VERIFY_TIMEOUT_MS_DEFAULT = 10_000;

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

/**
 * Builds managed-process metadata for trace, receipts, and user-facing evidence checks.
 *
 * **Why it exists:**
 * Keeps managed-process result metadata stable across start/check/stop actions so downstream code
 * can reason about process lifecycle without parsing free-form output text.
 *
 * **What it talks to:**
 * - Uses `ManagedProcessSnapshot` (import `ManagedProcessSnapshot`) from `./managedProcessRegistry`.
 * - Uses `ManagedProcessLifecycleCode` (import `ManagedProcessLifecycleCode`) from `../core/types`.
 *
 * @param snapshot - Managed-process snapshot to serialize.
 * @param lifecycleCode - Optional lifecycle code override for the current action result.
 * @returns Metadata bag safe for runtime trace persistence.
 */
function buildManagedProcessExecutionMetadata(
  snapshot: ManagedProcessSnapshot,
  lifecycleCode: ManagedProcessLifecycleCode = snapshot.statusCode
): Record<string, RuntimeTraceDetailValue> {
  return {
    managedProcess: true,
    processLeaseId: snapshot.leaseId,
    processTaskId: snapshot.taskId,
    processPid: snapshot.pid,
    processLifecycleStatus: lifecycleCode,
    processCommandFingerprint: snapshot.commandFingerprint,
    processCwd: snapshot.cwd,
    processShellExecutable: snapshot.shellExecutable,
    processShellKind: snapshot.shellKind,
    processStartedAt: snapshot.startedAt,
    processExitCode: snapshot.exitCode,
    processSignal: snapshot.signal,
    processStopRequested: snapshot.stopRequested
  };
}

/**
 * Builds managed-process start-failure metadata for deterministic recovery routing.
 *
 * **Why it exists:**
 * Startup preflight failures can still be actionable for the autonomous loop, so this helper keeps
 * typed port-conflict details machine-readable instead of forcing later recovery logic to scrape
 * free-form output text.
 *
 * **What it talks to:**
 * - Uses `RuntimeTraceDetailValue` (import `RuntimeTraceDetailValue`) from `../core/types`.
 *
 * @param details - Structured start-failure details for this outcome.
 * @returns Metadata bag safe for runtime trace persistence.
 */
function buildManagedProcessStartFailureExecutionMetadata(details: {
  commandFingerprint: string;
  cwd: string;
  shellExecutable: string;
  shellKind: string;
  failureKind: "PORT_IN_USE";
  requestedHost: string;
  requestedPort: number;
  requestedUrl: string;
  suggestedPort: number | null;
}): Record<string, RuntimeTraceDetailValue> {
  return {
    managedProcess: true,
    processLifecycleStatus: "PROCESS_START_FAILED",
    processCommandFingerprint: details.commandFingerprint,
    processCwd: details.cwd,
    processShellExecutable: details.shellExecutable,
    processShellKind: details.shellKind,
    processStartupFailureKind: details.failureKind,
    processRequestedHost: details.requestedHost,
    processRequestedPort: details.requestedPort,
    processRequestedUrl: details.requestedUrl,
    processSuggestedHost: details.suggestedPort !== null ? "localhost" : null,
    processSuggestedPort: details.suggestedPort,
    processSuggestedUrl:
      details.suggestedPort !== null ? `http://localhost:${details.suggestedPort}` : null
  };
}

/**
 * Builds readiness-probe metadata for trace, receipts, and completion evidence checks.
 *
 * **Why it exists:**
 * Keeps port/http probe outputs machine-readable so autonomous completion and user-facing status
 * rendering can reason about ready/not-ready state without parsing free-form text.
 *
 * **What it talks to:**
 * - Uses `ManagedProcessLifecycleCode` (import `ManagedProcessLifecycleCode`) from `../core/types`.
 * - Uses `RuntimeTraceDetailValue` (import `RuntimeTraceDetailValue`) from `../core/types`.
 *
 * @param details - Structured readiness probe details for this outcome.
 * @returns Metadata bag safe for runtime trace persistence.
 */
function buildReadinessProbeExecutionMetadata(details: {
  probeKind: "port" | "http";
  ready: boolean;
  lifecycleCode: ManagedProcessLifecycleCode;
  host?: string;
  port?: number;
  url?: string;
  timeoutMs: number;
  expectedStatus?: number | null;
  observedStatus?: number | null;
}): Record<string, RuntimeTraceDetailValue> {
  return {
    readinessProbe: true,
    probeKind: details.probeKind,
    probeReady: details.ready,
    processLifecycleStatus: details.lifecycleCode,
    probeHost: details.host ?? null,
    probePort: details.port ?? null,
    probeUrl: details.url ?? null,
    probeTimeoutMs: details.timeoutMs,
    probeExpectedStatus: details.expectedStatus ?? null,
    probeObservedStatus: details.observedStatus ?? null
  };
}

/**
 * Builds browser-verification metadata for trace, receipts, and mission-evidence checks.
 *
 * **Why it exists:**
 * Keeps browser verification outputs machine-readable so user-facing summaries and autonomous
 * mission gates can reason about verified UI/browser proof without parsing free-form text.
 *
 * **What it talks to:**
 * - Uses `ManagedProcessLifecycleCode` (import `ManagedProcessLifecycleCode`) from `../core/types`.
 * - Uses `RuntimeTraceDetailValue` (import `RuntimeTraceDetailValue`) from `../core/types`.
 *
 * @param details - Structured browser verification details for this outcome.
 * @returns Metadata bag safe for runtime trace persistence.
 */
function buildBrowserVerificationExecutionMetadata(details: {
  url: string;
  passed: boolean;
  observedTitle: string | null;
  observedTextSample: string | null;
  matchedTitle: boolean | null;
  matchedText: boolean | null;
  expectedTitle: string | null;
  expectedText: string | null;
  timeoutMs: number;
  lifecycleCode?: ManagedProcessLifecycleCode;
}): Record<string, RuntimeTraceDetailValue> {
  return {
    browserVerification: true,
    browserVerifyPassed: details.passed,
    browserVerifyUrl: details.url,
    browserVerifyObservedTitle: details.observedTitle,
    browserVerifyObservedTextSample: details.observedTextSample,
    browserVerifyMatchedTitle: details.matchedTitle,
    browserVerifyMatchedText: details.matchedText,
    browserVerifyExpectedTitle: details.expectedTitle,
    browserVerifyExpectedText: details.expectedText,
    browserVerifyTimeoutMs: details.timeoutMs,
    processLifecycleStatus: details.lifecycleCode ?? null
  };
}

/**
 * Evaluates whether one hostname belongs to the loopback-only browser verification allowlist.
 *
 * **Why it exists:**
 * Provides a second fail-closed local-only check in the executor for direct `executeWithOutcome`
 * callers that do not go through hard constraints first.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param hostname - Hostname extracted from a browser verification URL.
 * @returns `true` when the hostname is a permitted loopback target.
 */
function isLoopbackBrowserVerificationHost(hostname: string): boolean {
  const normalizedHostname = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1"
  );
}

interface ManagedProcessLoopbackTargetHint {
  host: string;
  port: number;
  url: string;
}

/**
 * Parses one probable loopback-local port from a managed-process command string.
 *
 * **Why it exists:**
 * `start_process` preflight can only detect deterministic local port conflicts when the runtime
 * can recover the intended loopback port from trusted command params, so this helper centralizes
 * the bounded parsing rules.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param command - Shell/process command text emitted by the planner.
 * @returns Loopback-local target hint, or `null` when no supported port pattern is present.
 */
function inferManagedProcessLoopbackTarget(
  command: string
): ManagedProcessLoopbackTargetHint | null {
  const normalizedCommand = command.trim().toLowerCase();
  const patterns = [
    /\bhttp\.server\s+(\d{2,5})\b/,
    /\b--port\s+(\d{2,5})\b/,
    /\b-p\s+(\d{2,5})\b/,
    /\blocalhost:(\d{2,5})\b/,
    /\b127\.0\.0\.1:(\d{2,5})\b/
  ];
  for (const pattern of patterns) {
    const match = normalizedCommand.match(pattern);
    if (!match) {
      continue;
    }
    const port = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      continue;
    }
    return {
      host: "localhost",
      port,
      url: `http://localhost:${port}`
    };
  }
  return null;
}

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
   * - Uses `ManagedProcessRegistry` (import `ManagedProcessRegistry`) from `./managedProcessRegistry`.
   * - Uses `PlaywrightBrowserVerifier` (import `PlaywrightBrowserVerifier`) from `./browserVerifier`.
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
        return this.executeRealShellCommand(action.id, action.params, signal);

      case "start_process":
        return this.startManagedProcess(action.id, action.params, signal, taskId);

      case "check_process":
        return this.checkManagedProcess(action.params);

      case "stop_process":
        return this.stopManagedProcess(action.params);

      case "probe_port":
        return this.probePortReadiness(action.params, signal);

      case "probe_http":
        return this.probeHttpReadiness(action.params, signal);

      case "verify_browser":
        return this.verifyBrowserPage(action.params, signal);

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
   * @param signal - Optional abort signal propagated from caller/runtime surface.
   * @param taskId - Optional owning task id for runtime metadata propagation.
   * @returns Promise resolving to string.
   */
  async execute(action: PlannedAction, signal?: AbortSignal, taskId?: string): Promise<string> {
    const outcome = await this.executeWithOutcome(action, signal, taskId);
    return outcome.output;
  }

  /**
   * Starts a managed long-running process as part of this module's control flow.
   *
   * **Why it exists:**
   * Separates long-lived process startup from finite shell execution so the runtime can track
   * lease-based process state instead of forcing app/server workflows through exit-based semantics.
   *
   * **What it talks to:**
   * - Uses `hashSha256` (import `hashSha256`) from `../core/cryptoUtils`.
   * - Uses `buildShellSpawnSpec` (import `buildShellSpawnSpec`) from `../core/shellRuntimeProfile`.
   * - Uses `resolveShellEnvironment` (import `resolveShellEnvironment`) from `../core/shellRuntimeProfile`.
   * - Uses `StartProcessActionParams` (import `StartProcessActionParams`) from `../core/types`.
   * - Uses `ManagedProcessRegistry` (import `ManagedProcessRegistry`) from `./managedProcessRegistry`.
   *
   * @param actionId - Stable identifier used to reference an entity or record.
   * @param params - Structured input object for this operation.
   * @param signal - Optional abort signal propagated from caller/runtime surface.
   * @param taskId - Optional owning task id for runtime metadata propagation.
   * @returns Promise resolving to typed executor outcome.
   */
  private async startManagedProcess(
    actionId: string,
    params: StartProcessActionParams,
    signal?: AbortSignal,
    taskId?: string
  ): Promise<ExecutorExecutionOutcome> {
    throwIfAborted(signal);
    if (!this.config.permissions.allowRealShellExecution) {
      return buildExecutionOutcome(
        "blocked",
        "Process start blocked: real shell execution is disabled by policy.",
        "PROCESS_DISABLED_BY_POLICY"
      );
    }

    const command = normalizeOptionalString(params.command);
    if (!command) {
      return buildExecutionOutcome(
        "blocked",
        "Process start blocked: missing command.",
        "PROCESS_MISSING_COMMAND"
      );
    }

    const resolvedCwd = this.resolveShellCommandCwd(params);
    if (!resolvedCwd) {
      return buildExecutionOutcome(
        "blocked",
        "Process start blocked: requested cwd is outside sandbox policy.",
        "PROCESS_CWD_OUTSIDE_SANDBOX"
      );
    }

    const shellEnvironment = resolveShellEnvironment(this.config.shellRuntime.profile, process.env);
    const commandFingerprint = hashSha256(command);
    const spawnSpec = buildShellSpawnSpec({
      profile: this.config.shellRuntime.profile,
      command,
      cwd: resolvedCwd,
      timeoutMs: this.config.shellRuntime.profile.timeoutMsDefault,
      envKeyNames: shellEnvironment.envKeyNames
    });
    const loopbackTarget = inferManagedProcessLoopbackTarget(command);

    if (loopbackTarget) {
      const portAlreadyOccupied = await this.performLocalPortProbe(
        loopbackTarget.host,
        loopbackTarget.port,
        MANAGED_PROCESS_PORT_PRECHECK_TIMEOUT_MS,
        signal
      );
      if (portAlreadyOccupied) {
        const suggestedPort = await this.findAvailableLoopbackPort(signal);
        return buildExecutionOutcome(
          "failed",
          `Process start failed: ${loopbackTarget.url} was already occupied before startup.` +
            `${suggestedPort !== null ? ` Try a different free loopback port such as ${suggestedPort}.` : ""}`,
          "PROCESS_START_FAILED",
          buildManagedProcessStartFailureExecutionMetadata({
            commandFingerprint,
            cwd: spawnSpec.cwd,
            shellExecutable: spawnSpec.executable,
            shellKind: this.config.shellRuntime.profile.shellKind,
            failureKind: "PORT_IN_USE",
            requestedHost: loopbackTarget.host,
            requestedPort: loopbackTarget.port,
            requestedUrl: loopbackTarget.url,
            suggestedPort
          })
        );
      }
    }

    try {
      const child = this.shellSpawn(spawnSpec.executable, [...spawnSpec.args], {
        cwd: spawnSpec.cwd,
        detached: process.platform !== "win32",
        env: shellEnvironment.env,
        windowsHide: true,
        windowsVerbatimArguments: this.config.shellRuntime.profile.shellKind === "cmd",
        stdio: ["pipe", "pipe", "pipe"]
      });
      if (typeof child.stdout.resume === "function") {
        child.stdout.resume();
      }
      if (typeof child.stderr.resume === "function") {
        child.stderr.resume();
      }
      await this.waitForManagedProcessStart(child, signal);
      const snapshot = this.managedProcessRegistry.registerStarted({
        actionId,
        child,
        commandFingerprint,
        cwd: spawnSpec.cwd,
        shellExecutable: spawnSpec.executable,
        shellKind: this.config.shellRuntime.profile.shellKind,
        taskId
      });
      this.bindAbortCleanupForManagedProcess(snapshot.leaseId, child, signal);
      return buildExecutionOutcome(
        "success",
        `Process started: lease ${snapshot.leaseId} (pid ${snapshot.pid ?? "unknown"}).`,
        undefined,
        buildManagedProcessExecutionMetadata(snapshot, "PROCESS_STARTED")
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return buildExecutionOutcome(
        "failed",
        `Process start failed: ${(error as Error).message}`,
        "PROCESS_START_FAILED"
      );
    }
  }

  /**
   * Binds one managed-process lease to an abort signal for deterministic cleanup.
   *
   * **Why it exists:**
   * `start_process` can succeed before the surrounding task is cancelled. This helper ensures the
   * managed child is still torn down when the owning task signal aborts later, instead of leaving a
   * long-running lease alive after cancellation.
   *
   * **What it talks to:**
   * - Uses `ManagedProcessRegistry` (import `ManagedProcessRegistry`) from `./managedProcessRegistry`.
   * - Uses `terminateProcessTree` within this module.
   *
   * @param leaseId - Managed-process lease identifier to mark as stop-requested on abort.
   * @param child - Live child handle associated with the managed-process lease.
   * @param signal - Optional abort signal propagated from caller/runtime surface.
   * @returns Nothing; registers runtime cleanup side effects when a signal exists.
   */
  private bindAbortCleanupForManagedProcess(
    leaseId: string,
    child: ChildProcessWithoutNullStreams,
    signal?: AbortSignal
  ): void {
    if (!signal) {
      return;
    }

    const handleAbort = (): void => {
      this.managedProcessRegistry.markStopRequested(leaseId);
      void this.terminateProcessTree(child);
    };

    if (signal.aborted) {
      handleAbort();
      return;
    }

    signal.addEventListener("abort", handleAbort, { once: true });
    child.once("close", () => {
      signal.removeEventListener("abort", handleAbort);
    });
  }

  /**
   * Checks one managed-process lease and reports its current lifecycle status.
   *
   * **Why it exists:**
   * Gives higher-level orchestration a deterministic way to inspect long-running work without
   * relying on process exit or ad-hoc shell polling.
   *
   * **What it talks to:**
   * - Uses `CheckProcessActionParams` (import `CheckProcessActionParams`) from `../core/types`.
   * - Uses `ManagedProcessRegistry` (import `ManagedProcessRegistry`) from `./managedProcessRegistry`.
   *
   * @param params - Structured input object for this operation.
   * @returns Promise resolving to typed executor outcome.
   */
  private async checkManagedProcess(
    params: CheckProcessActionParams
  ): Promise<ExecutorExecutionOutcome> {
    const leaseId = normalizeOptionalString(params.leaseId);
    if (!leaseId) {
      return buildExecutionOutcome(
        "blocked",
        "Process check blocked: missing leaseId.",
        "PROCESS_MISSING_LEASE_ID"
      );
    }
    const snapshot = this.managedProcessRegistry.markObservedRunning(leaseId);
    if (!snapshot) {
      return buildExecutionOutcome(
        "blocked",
        `Process check blocked: unknown lease ${leaseId}.`,
        "PROCESS_LEASE_NOT_FOUND"
      );
    }

    if (snapshot.statusCode === "PROCESS_STOPPED") {
      const exitDetail =
        snapshot.exitCode !== null
          ? `exit code ${snapshot.exitCode}`
          : snapshot.signal
            ? `signal ${snapshot.signal}`
            : "unknown exit";
      return buildExecutionOutcome(
        "success",
        `Process stopped: lease ${snapshot.leaseId} (${exitDetail}).`,
        undefined,
        buildManagedProcessExecutionMetadata(snapshot, "PROCESS_STOPPED")
      );
    }

    return buildExecutionOutcome(
      "success",
      `Process still running: lease ${snapshot.leaseId} (pid ${snapshot.pid ?? "unknown"}).`,
      undefined,
      buildManagedProcessExecutionMetadata(snapshot, "PROCESS_STILL_RUNNING")
    );
  }

  /**
   * Stops one managed-process lease and waits for deterministic close confirmation.
   *
   * **Why it exists:**
   * Provides a truthful cleanup boundary for long-running work so stop requests can confirm whether
   * the runtime actually terminated the tracked child process.
   *
   * **What it talks to:**
   * - Uses `StopProcessActionParams` (import `StopProcessActionParams`) from `../core/types`.
   * - Uses `ManagedProcessRegistry` (import `ManagedProcessRegistry`) from `./managedProcessRegistry`.
   *
   * @param params - Structured input object for this operation.
   * @returns Promise resolving to typed executor outcome.
   */
  private async stopManagedProcess(
    params: StopProcessActionParams
  ): Promise<ExecutorExecutionOutcome> {
    const leaseId = normalizeOptionalString(params.leaseId);
    if (!leaseId) {
      return buildExecutionOutcome(
        "blocked",
        "Process stop blocked: missing leaseId.",
        "PROCESS_MISSING_LEASE_ID"
      );
    }

    const snapshot = this.managedProcessRegistry.markStopRequested(leaseId);
    if (!snapshot) {
      return buildExecutionOutcome(
        "blocked",
        `Process stop blocked: unknown lease ${leaseId}.`,
        "PROCESS_LEASE_NOT_FOUND"
      );
    }
    if (snapshot.statusCode === "PROCESS_STOPPED") {
      return buildExecutionOutcome(
        "success",
        `Process already stopped: lease ${snapshot.leaseId}.`,
        undefined,
        buildManagedProcessExecutionMetadata(snapshot, "PROCESS_STOPPED")
      );
    }

    const child = this.managedProcessRegistry.getChild(leaseId);
    if (!child) {
      return buildExecutionOutcome(
        "failed",
        `Process stop failed: live child handle is unavailable for lease ${leaseId}.`,
        "PROCESS_STOP_FAILED"
      );
    }

    try {
      const killAccepted = await this.terminateProcessTree(child);
      if (!killAccepted) {
        return buildExecutionOutcome(
          "failed",
          `Process stop failed: kill signal was not accepted for lease ${leaseId}.`,
          "PROCESS_STOP_FAILED"
        );
      }
      const closedSnapshot = await this.managedProcessRegistry.waitForClosed(
        leaseId,
        MANAGED_PROCESS_STOP_TIMEOUT_MS
      );
      if (!closedSnapshot) {
        return buildExecutionOutcome(
          "failed",
          `Process stop failed: lease ${leaseId} did not exit within ${MANAGED_PROCESS_STOP_TIMEOUT_MS}ms.`,
          "PROCESS_STOP_FAILED"
        );
      }
      return buildExecutionOutcome(
        "success",
        `Process stopped: lease ${closedSnapshot.leaseId}.`,
        undefined,
        buildManagedProcessExecutionMetadata(closedSnapshot, "PROCESS_STOPPED")
      );
    } catch (error) {
      return buildExecutionOutcome(
        "failed",
        `Process stop failed: ${(error as Error).message}`,
        "PROCESS_STOP_FAILED"
      );
    }
  }

  /**
   * Probes a local TCP port and reports deterministic ready/not-ready metadata.
   *
   * **Why it exists:**
   * Gives live-run flows a finite readiness check that proves a local service accepted connections
   * without pretending that a long-running process fully exited or that a browser UI was verified.
   *
   * **What it talks to:**
   * - Uses `ProbePortActionParams` (import `ProbePortActionParams`) from `../core/types`.
   * - Uses local helpers within this module.
   *
   * @param params - Structured input object for this operation.
   * @param signal - Optional abort signal propagated from caller/runtime surface.
   * @returns Promise resolving to typed executor outcome.
   */
  private async probePortReadiness(
    params: ProbePortActionParams,
    signal?: AbortSignal
  ): Promise<ExecutorExecutionOutcome> {
    throwIfAborted(signal);
    const host = normalizeOptionalString(params.host) ?? "127.0.0.1";
    if (params.port === undefined) {
      return buildExecutionOutcome(
        "blocked",
        "Port probe blocked: missing params.port.",
        "PROBE_MISSING_PORT"
      );
    }
    if (!Number.isInteger(params.port) || params.port < 1 || params.port > 65_535) {
      return buildExecutionOutcome(
        "blocked",
        "Port probe blocked: params.port must be an integer within 1..65535.",
        "PROBE_PORT_INVALID"
      );
    }

    const timeoutMs = this.resolveReadinessProbeTimeoutMs(params.timeoutMs);

    try {
      const ready = await this.performLocalPortProbe(host, params.port, timeoutMs, signal);
      if (ready) {
        return buildExecutionOutcome(
          "success",
          `Port ready: ${host}:${params.port} accepted a TCP connection.`,
          undefined,
          buildReadinessProbeExecutionMetadata({
            probeKind: "port",
            ready: true,
            lifecycleCode: "PROCESS_READY",
            host,
            port: params.port,
            timeoutMs
          })
        );
      }
      return buildExecutionOutcome(
        "failed",
        `Port not ready: ${host}:${params.port} did not accept a TCP connection within ${timeoutMs}ms.`,
        "PROCESS_NOT_READY",
        buildReadinessProbeExecutionMetadata({
          probeKind: "port",
          ready: false,
          lifecycleCode: "PROCESS_NOT_READY",
          host,
          port: params.port,
          timeoutMs
        })
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return buildExecutionOutcome(
        "failed",
        `Port probe failed: ${(error as Error).message}`,
        "ACTION_EXECUTION_FAILED"
      );
    }
  }

  /**
   * Probes one local HTTP endpoint and reports deterministic ready/not-ready metadata.
   *
   * **Why it exists:**
   * Provides a finite proof step for local app/server availability without overclaiming browser or
   * UI-level verification that the runtime still does not perform.
   *
   * **What it talks to:**
   * - Uses `ProbeHttpActionParams` (import `ProbeHttpActionParams`) from `../core/types`.
   * - Uses local helpers within this module.
   *
   * @param params - Structured input object for this operation.
   * @param signal - Optional abort signal propagated from caller/runtime surface.
   * @returns Promise resolving to typed executor outcome.
   */
  private async probeHttpReadiness(
    params: ProbeHttpActionParams,
    signal?: AbortSignal
  ): Promise<ExecutorExecutionOutcome> {
    throwIfAborted(signal);
    const urlValue = normalizeOptionalString(params.url);
    if (!urlValue) {
      return buildExecutionOutcome(
        "blocked",
        "HTTP probe blocked: missing params.url.",
        "PROBE_MISSING_URL"
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlValue);
    } catch {
      return buildExecutionOutcome(
        "blocked",
        "HTTP probe blocked: params.url must be a valid absolute URL.",
        "PROBE_URL_INVALID"
      );
    }

    const expectedStatus =
      typeof params.expectedStatus === "number" && Number.isInteger(params.expectedStatus)
        ? params.expectedStatus
        : null;
    const timeoutMs = this.resolveReadinessProbeTimeoutMs(params.timeoutMs);

    try {
      const observedStatus = await this.performLocalHttpProbe(parsedUrl, timeoutMs, signal);
      const port = this.resolveUrlPort(parsedUrl);
      if (observedStatus !== null && this.isReadyHttpStatus(observedStatus, expectedStatus)) {
        return buildExecutionOutcome(
          "success",
          expectedStatus === null
            ? `HTTP ready: ${urlValue} responded with ${observedStatus}.`
            : `HTTP ready: ${urlValue} responded with expected status ${expectedStatus}.`,
          undefined,
          buildReadinessProbeExecutionMetadata({
            probeKind: "http",
            ready: true,
            lifecycleCode: "PROCESS_READY",
            host: parsedUrl.hostname,
            port,
            url: urlValue,
            timeoutMs,
            expectedStatus,
            observedStatus
          })
        );
      }

      const failureDetail =
        observedStatus === null
          ? `no HTTP response within ${timeoutMs}ms`
          : expectedStatus === null
            ? `status ${observedStatus}`
            : `status ${observedStatus} (expected ${expectedStatus})`;
      return buildExecutionOutcome(
        "failed",
        `HTTP probe not ready: ${urlValue} returned ${failureDetail}.`,
        "PROCESS_NOT_READY",
        buildReadinessProbeExecutionMetadata({
          probeKind: "http",
          ready: false,
          lifecycleCode: "PROCESS_NOT_READY",
          host: parsedUrl.hostname,
          port,
          url: urlValue,
          timeoutMs,
          expectedStatus,
          observedStatus
        })
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return buildExecutionOutcome(
        "failed",
        `HTTP probe failed: ${(error as Error).message}`,
        "ACTION_EXECUTION_FAILED"
      );
    }
  }

  /**
   * Verifies one loopback page through the configured browser verifier backend.
   *
   * **Why it exists:**
   * Provides a truthful browser/UI proof step for local live-run workflows so the runtime can
   * verify page-level expectations instead of treating readiness probes as UI confirmation.
   *
   * **What it talks to:**
   * - Uses `VerifyBrowserActionParams` (import `VerifyBrowserActionParams`) from `../core/types`.
   * - Uses `BrowserVerifier` (import `BrowserVerifier`) from `./browserVerifier`.
   * - Uses local helpers within this module.
   *
   * @param params - Structured input object for this operation.
   * @param signal - Optional abort signal propagated from caller/runtime surface.
   * @returns Promise resolving to typed executor outcome.
   */
  private async verifyBrowserPage(
    params: VerifyBrowserActionParams,
    signal?: AbortSignal
  ): Promise<ExecutorExecutionOutcome> {
    throwIfAborted(signal);
    const url = normalizeOptionalString(params.url);
    if (!url) {
      return buildExecutionOutcome(
        "blocked",
        "Browser verification blocked: missing params.url.",
        "BROWSER_VERIFY_MISSING_URL"
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return buildExecutionOutcome(
        "blocked",
        "Browser verification blocked: params.url must be a valid absolute URL.",
        "BROWSER_VERIFY_URL_INVALID"
      );
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return buildExecutionOutcome(
        "blocked",
        "Browser verification blocked: params.url must use http or https.",
        "BROWSER_VERIFY_URL_INVALID"
      );
    }
    if (!isLoopbackBrowserVerificationHost(parsedUrl.hostname)) {
      return buildExecutionOutcome(
        "blocked",
        "Browser verification blocked: params.url must target localhost, 127.0.0.1, or ::1.",
        "BROWSER_VERIFY_URL_NOT_LOCAL"
      );
    }

    const timeoutMs = this.resolveBrowserVerificationTimeoutMs(params.timeoutMs);
    const expectedTitle = normalizeOptionalString(params.expectedTitle);
    const expectedText = normalizeOptionalString(params.expectedText);

    try {
      const verificationResult = await this.browserVerifier.verify({
        url: parsedUrl.toString(),
        expectedTitle,
        expectedText,
        timeoutMs,
        signal
      });

      const executionMetadata = buildBrowserVerificationExecutionMetadata({
        url: parsedUrl.toString(),
        passed: verificationResult.status === "verified",
        observedTitle: verificationResult.observedTitle,
        observedTextSample: verificationResult.observedTextSample,
        matchedTitle: verificationResult.matchedTitle,
        matchedText: verificationResult.matchedText,
        expectedTitle,
        expectedText,
        timeoutMs,
        lifecycleCode:
          verificationResult.status === "verified" ||
            verificationResult.status === "expectation_failed"
            ? "PROCESS_READY"
            : undefined
      });

      switch (verificationResult.status) {
        case "verified":
          return buildExecutionOutcome(
            "success",
            verificationResult.detail,
            undefined,
            executionMetadata
          );
        case "expectation_failed":
          return buildExecutionOutcome(
            "failed",
            verificationResult.detail,
            "BROWSER_VERIFY_EXPECTATION_FAILED",
            executionMetadata
          );
        case "runtime_unavailable":
          return buildExecutionOutcome(
            "failed",
            verificationResult.detail,
            "BROWSER_VERIFY_RUNTIME_UNAVAILABLE",
            executionMetadata
          );
        case "failed":
        default:
          return buildExecutionOutcome(
            "failed",
            verificationResult.detail,
            "BROWSER_VERIFY_FAILED",
            executionMetadata
          );
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return buildExecutionOutcome(
        "failed",
        `Browser verification failed: ${(error as Error).message}`,
        "BROWSER_VERIFY_FAILED"
      );
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
   * @param signal - Optional abort signal propagated from caller/runtime surface.
   * @returns Promise resolving to typed executor outcome.
   */
  private async executeRealShellCommand(
    actionId: string,
    params: ShellCommandActionParams,
    signal?: AbortSignal
  ): Promise<ExecutorExecutionOutcome> {
    throwIfAborted(signal);
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
      const result = await this.runShellProcess(
        spawnSpec,
        shellEnvironment.env,
        this.config.shellRuntime.profile.shellKind,
        signal
      );
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
      if (isAbortError(error)) {
        throw error;
      }
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
   * Resolves readiness probe timeout from available runtime context.
   *
   * **Why it exists:**
   * Keeps probe timeout selection deterministic so readiness checks stay bounded even when planner
   * payloads omit timeout metadata or provide out-of-bounds values.
   *
   * **What it talks to:**
   * - Uses `BrainConfig` (import `BrainConfig`) from `../core/config`.
   *
   * @param timeoutMs - Optional timeout candidate from planner params.
   * @returns Computed numeric value.
   */
  private resolveReadinessProbeTimeoutMs(timeoutMs: number | undefined): number {
    if (timeoutMs === undefined || !Number.isInteger(timeoutMs)) {
      return READINESS_PROBE_TIMEOUT_MS_DEFAULT;
    }
    if (
      timeoutMs < this.config.shellRuntime.timeoutBoundsMs.min ||
      timeoutMs > this.config.shellRuntime.timeoutBoundsMs.max
    ) {
      return READINESS_PROBE_TIMEOUT_MS_DEFAULT;
    }
    return timeoutMs;
  }

  /**
   * Resolves browser verification timeout from available runtime context.
   *
   * **Why it exists:**
   * Keeps browser-verification timeouts bounded and deterministic even when planner payloads omit
   * timeout metadata or direct executor callers provide invalid values.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param timeoutMs - Optional timeout candidate from planner params.
   * @returns Computed numeric value.
   */
  private resolveBrowserVerificationTimeoutMs(timeoutMs: number | undefined): number {
    if (timeoutMs === undefined || !Number.isInteger(timeoutMs)) {
      return BROWSER_VERIFY_TIMEOUT_MS_DEFAULT;
    }
    if (
      timeoutMs < this.config.shellRuntime.timeoutBoundsMs.min ||
      timeoutMs > this.config.shellRuntime.timeoutBoundsMs.max
    ) {
      return BROWSER_VERIFY_TIMEOUT_MS_DEFAULT;
    }
    return timeoutMs;
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
   * Evaluates whether one observed HTTP status satisfies ready-state expectations.
   *
   * **Why it exists:**
   * Keeps HTTP readiness semantics consistent so probe success does not depend on duplicated
   * caller-side status handling.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param observedStatus - HTTP status observed from the local probe request.
   * @param expectedStatus - Optional exact status required by the planner payload.
   * @returns `true` when the observed status proves readiness.
   */
  private isReadyHttpStatus(observedStatus: number, expectedStatus: number | null): boolean {
    if (expectedStatus !== null) {
      return observedStatus === expectedStatus;
    }
    return observedStatus >= 200 && observedStatus < 300;
  }

  /**
   * Resolves URL port from a parsed local HTTP endpoint.
   *
   * **Why it exists:**
   * Keeps trace metadata and readiness summaries consistent when the URL omits an explicit port.
   *
   * **What it talks to:**
   * - Uses `URL` global available in Node runtime.
   *
   * @param parsedUrl - Parsed local endpoint URL.
   * @returns Deterministic numeric port value.
   */
  private resolveUrlPort(parsedUrl: URL): number {
    if (parsedUrl.port.trim().length > 0) {
      return Number(parsedUrl.port);
    }
    return parsedUrl.protocol === "https:" ? 443 : 80;
  }

  /**
   * Finds one currently free loopback TCP port for deterministic recovery hints.
   *
   * **Why it exists:**
   * When a managed-process start is blocked by a pre-existing local listener, the autonomous loop
   * can recover much faster if the executor provides a concrete alternate loopback port instead of
   * forcing the model to guess one.
   *
   * **What it talks to:**
   * - Uses `net` (import `default as net`) from `node:net`.
   * - Uses `createAbortError` (import `createAbortError`) from `../core/runtimeAbort`.
   *
   * @param signal - Optional abort signal propagated from caller/runtime surface.
   * @returns Promise resolving to a free loopback port, or `null` when discovery fails.
   */
  private async findAvailableLoopbackPort(signal?: AbortSignal): Promise<number | null> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      let settled = false;

      const finalize = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        server.removeAllListeners();
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", handleAbort);
        }
        callback();
      };

      const handleAbort = (): void => {
        server.close(() => {
          finalize(() => reject(createAbortError()));
        });
      };

      if (signal) {
        signal.addEventListener("abort", handleAbort, { once: true });
      }

      server.once("error", () => {
        finalize(() => resolve(null));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port =
          address && typeof address !== "string" && Number.isInteger(address.port)
            ? address.port
            : null;
        server.close(() => {
          finalize(() => resolve(port));
        });
      });
    });
  }

  /**
   * Performs one local TCP connection attempt for readiness proof.
   *
   * **Why it exists:**
   * Encapsulates socket lifecycle and abort handling so readiness probes stay finite, cancellable,
   * and free of duplicated event-cleanup logic.
   *
   * **What it talks to:**
   * - Uses `net` (import `default as net`) from `node:net`.
   * - Uses `createAbortError` (import `createAbortError`) from `../core/runtimeAbort`.
   *
   * @param host - Loopback host to probe.
   * @param port - Local TCP port to probe.
   * @param timeoutMs - Maximum wait before declaring not-ready.
   * @param signal - Optional abort signal propagated from caller/runtime surface.
   * @returns Promise resolving to `true` when the port accepts a connection.
   */
  private async performLocalPortProbe(
    host: string,
    port: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;

      const finalize = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", handleAbort);
        }
        callback();
      };

      const handleAbort = (): void => {
        finalize(() => reject(createAbortError()));
      };

      if (signal) {
        signal.addEventListener("abort", handleAbort, { once: true });
      }

      socket.setTimeout(timeoutMs);
      socket.once("connect", () => {
        finalize(() => resolve(true));
      });
      socket.once("timeout", () => {
        finalize(() => resolve(false));
      });
      socket.once("error", () => {
        finalize(() => resolve(false));
      });
      socket.connect(port, host);
    });
  }

  /**
   * Performs one local HTTP request for readiness proof.
   *
   * **Why it exists:**
   * Encapsulates request lifecycle and abort handling so local endpoint verification stays finite
   * and deterministic across both HTTP and HTTPS loopback targets.
   *
   * **What it talks to:**
   * - Uses `http` (import `default as http`) from `node:http`.
   * - Uses `https` (import `default as https`) from `node:https`.
   * - Uses `createAbortError` (import `createAbortError`) from `../core/runtimeAbort`.
   *
   * @param parsedUrl - Parsed loopback endpoint URL.
   * @param timeoutMs - Maximum wait before declaring not-ready.
   * @param signal - Optional abort signal propagated from caller/runtime surface.
   * @returns Promise resolving to observed HTTP status code, or `null` when no ready response arrived.
   */
  private async performLocalHttpProbe(
    parsedUrl: URL,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<number | null> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const requestModule = parsedUrl.protocol === "https:" ? https : http;
      const request = requestModule.request(
        parsedUrl,
        {
          method: "GET",
          timeout: timeoutMs
        },
        (response) => {
          response.resume();
          response.once("end", () => {
            finalize(() => resolve(response.statusCode ?? null));
          });
        }
      );
      let settled = false;

      const finalize = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        request.removeAllListeners();
        request.destroy();
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", handleAbort);
        }
        callback();
      };

      const handleAbort = (): void => {
        finalize(() => reject(createAbortError()));
      };

      if (signal) {
        signal.addEventListener("abort", handleAbort, { once: true });
      }

      request.once("timeout", () => {
        finalize(() => resolve(null));
      });
      request.once("error", () => {
        finalize(() => resolve(null));
      });
      request.end();
    });
  }

  /**
   * Waits for a managed process to emit a successful spawn event.
   *
   * **Why it exists:**
   * Keeps start-process success/failure detection deterministic so the executor does not report a
   * lease until the child has actually spawned or failed.
   *
   * **What it talks to:**
   * - Uses `createAbortError` and `throwIfAborted` from `../core/runtimeAbort`.
   *
   * @param child - Live child handle returned from `spawn`.
   * @param signal - Optional abort signal propagated from caller/runtime surface.
   * @returns Promise resolving when the process successfully spawns.
   */
  private async waitForManagedProcessStart(
    child: ChildProcessWithoutNullStreams,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finalize = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", handleAbort);
        }
        callback();
      };
      const timeoutHandle = setTimeout(() => {
        finalize(() =>
          reject(
            new Error(
              `Process did not emit a spawn event within ${MANAGED_PROCESS_START_TIMEOUT_MS}ms.`
            )
          )
        );
      }, MANAGED_PROCESS_START_TIMEOUT_MS);
      const handleAbort = (): void => {
        void this.terminateProcessTree(child);
        finalize(() => reject(createAbortError()));
      };

      if (signal) {
        signal.addEventListener("abort", handleAbort, { once: true });
      }

      child.once("spawn", () => {
        finalize(() => resolve());
      });
      child.once("error", (error) => {
        finalize(() => reject(error));
      });
      child.once("close", (code, closeSignal) => {
        finalize(() =>
          reject(
            new Error(
              `Process exited before startup completed (${code ?? "no-exit-code"}${closeSignal ? `, signal ${closeSignal}` : ""}).`
            )
          )
        );
      });
    });
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
   * @param shellKind - Resolved runtime shell kind for spawn options.
   * @param signal - Optional abort signal propagated from caller/runtime surface.
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
    env: NodeJS.ProcessEnv,
    shellKind: string,
    signal?: AbortSignal
  ): Promise<{
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdout: CappedTextBuffer;
    stderr: CappedTextBuffer;
  }> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const child = this.shellSpawn(spawnSpec.executable, [...spawnSpec.args], {
        cwd: spawnSpec.cwd,
        detached: process.platform !== "win32",
        env,
        windowsHide: true,
        windowsVerbatimArguments: shellKind === "cmd",
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdoutBuffer = emptyCappedTextBuffer();
      let stderrBuffer = emptyCappedTextBuffer();
      let timedOut = false;
      let settled = false;

      const finalize = (
        callback: () => void
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", handleAbort);
        }
        callback();
      };

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        void this.terminateProcessTree(child);
      }, spawnSpec.timeoutMs);

      const handleAbort = (): void => {
        void this.terminateProcessTree(child);
        finalize(() => reject(createAbortError()));
      };
      if (signal) {
        signal.addEventListener("abort", handleAbort, { once: true });
      }

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer = appendChunkToBuffer(stdoutBuffer, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuffer = appendChunkToBuffer(stderrBuffer, chunk);
      });
      child.once("error", (error) => {
        finalize(() => reject(error));
      });
      child.once("close", (code, signal) => {
        finalize(() => resolve({
          exitCode: code,
          signal,
          timedOut,
          stdout: stdoutBuffer,
          stderr: stderrBuffer
        }));
      });
    });
  }

  /**
   * Terminates one spawned shell/process tree using platform-appropriate semantics.
   *
   * **Why it exists:**
   * Stopping only the shell wrapper is insufficient for live-run workflows on Windows because
   * descendants like `node`, `npm`, or local dev servers can survive after the parent shell exits.
   * Centralizing process-tree termination keeps stop, timeout, and abort behavior truthful without
   * hardcoding tool-specific cleanup paths.
   *
   * **What it talks to:**
   * - Uses `ChildProcessWithoutNullStreams` (import `ChildProcessWithoutNullStreams`) from `node:child_process`.
   * - Uses local shell spawn wrapper in this module for Windows `taskkill`.
   *
   * @param child - Live child handle representing the spawned shell/process root.
   * @returns Promise resolving to `true` when a termination attempt was accepted.
   */
  private async terminateProcessTree(
    child: ChildProcess | ChildProcessWithoutNullStreams
  ): Promise<boolean> {
    if (child.killed) {
      return true;
    }
    const pid = child.pid;
    if (!pid) {
      try {
        return child.kill();
      } catch {
        return false;
      }
    }

    if (process.platform === "win32") {
      try {
        await new Promise<void>((resolve, reject) => {
          const killer = this.shellSpawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore"
          });
          const timeoutHandle = setTimeout(() => {
            killer.removeAllListeners();
            reject(
              new Error(
                `taskkill did not complete within ${PROCESS_TREE_TERMINATION_TIMEOUT_MS}ms.`
              )
            );
          }, PROCESS_TREE_TERMINATION_TIMEOUT_MS);
          killer.once("error", (error) => {
            clearTimeout(timeoutHandle);
            reject(error);
          });
          killer.once("close", (code) => {
            clearTimeout(timeoutHandle);
            if (code === 0 || code === 128 || code === 255) {
              resolve();
              return;
            }
            reject(new Error(`taskkill exited with code ${code ?? "unknown"}.`));
          });
        });
        return true;
      } catch {
        try {
          return child.kill();
        } catch {
          return false;
        }
      }
    }

    try {
      process.kill(-pid, "SIGTERM");
      return true;
    } catch {
      try {
        return child.kill("SIGTERM");
      } catch {
        return false;
      }
    }
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
