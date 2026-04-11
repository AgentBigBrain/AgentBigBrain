/**
 * @fileoverview Stops exact local server processes tied to matching user-owned folders.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { readdir } from "node:fs/promises";

import {
  ExecutorExecutionOutcome,
  FolderRuntimeProcessSelectorMode,
  StopFolderRuntimeProcessesActionParams
} from "../../core/types";
import {
  buildExecutionOutcome,
  buildFolderRuntimeProcessSweepMetadata,
  LiveRunExecutorContext,
  normalizeOptionalString
} from "./contracts";

interface FolderRuntimeProcessCandidate {
  pid: number;
  port: number | null;
  processName: string | null;
  folder: string;
}

const WINDOWS_SWEEP_TIMEOUT_MS = 8_000;
const SUPPORTED_SELECTOR_MODES = new Set<FolderRuntimeProcessSelectorMode>([
  "starts_with",
  "contains"
]);
const SELECTOR_TERM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{1,80}$/;

/**
 * Escapes one string for safe single-quoted PowerShell interpolation.
 *
 * @param value - Raw string value.
 * @returns Escaped PowerShell-safe string.
 */
function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Normalizes one filesystem path into a stable comparison form.
 *
 * @param value - Candidate filesystem path.
 * @returns Normalized path, or `null` when absent.
 */
function normalizeComparablePath(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = path.normalize(trimmed).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Validates and normalizes selector mode from planner params.
 *
 * @param value - Raw selector mode.
 * @returns Typed selector mode, or `null` when invalid.
 */
function resolveSelectorMode(value: unknown): FolderRuntimeProcessSelectorMode | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase() as FolderRuntimeProcessSelectorMode;
  return SUPPORTED_SELECTOR_MODES.has(normalized) ? normalized : null;
}

/**
 * Validates one selector term so the action stays bounded to simple folder-name matching.
 *
 * @param value - Raw selector term.
 * @returns Normalized selector term, or `null` when invalid.
 */
function resolveSelectorTerm(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!SELECTOR_TERM_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

/**
 * Returns whether one folder name matches the requested selector.
 *
 * @param folderName - Local folder name.
 * @param selectorMode - Bounded selector mode.
 * @param selectorTerm - Case-insensitive selector term.
 * @returns `true` when the folder matches.
 */
function folderNameMatchesSelector(
  folderName: string,
  selectorMode: FolderRuntimeProcessSelectorMode,
  selectorTerm: string
): boolean {
  const normalizedFolderName = folderName.toLowerCase();
  const normalizedSelector = selectorTerm.toLowerCase();
  return selectorMode === "starts_with"
    ? normalizedFolderName.startsWith(normalizedSelector)
    : normalizedFolderName.includes(normalizedSelector);
}

/**
 * Lists matching folders under the requested user-owned root.
 *
 * @param rootPath - Absolute root path to inspect.
 * @param selectorMode - Bounded selector mode.
 * @param selectorTerm - Case-insensitive selector term.
 * @returns Matching absolute folder paths in deterministic order.
 */
async function listMatchingFolders(
  rootPath: string,
  selectorMode: FolderRuntimeProcessSelectorMode,
  selectorTerm: string
): Promise<readonly string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((entryName) => folderNameMatchesSelector(entryName, selectorMode, selectorTerm))
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }))
    .map((entryName) => path.join(rootPath, entryName));
}

/**
 * Builds one bounded read-only PowerShell script that finds listening local dev-server processes
 * tied to the provided folder set.
 *
 * @param folders - Exact absolute folder paths selected by the runtime.
 * @returns PowerShell script text.
 */
function buildFolderRuntimeProcessInspectionScript(
  folders: readonly string[]
): string {
  const folderArrayLiteral =
    folders.length > 0
      ? `@(${folders.map((folder) => `'${escapePowerShellSingleQuoted(folder)}'`).join(",")})`
      : "@()";
  return [
    `$folders=${folderArrayLiteral}`,
    "if($folders.Count -eq 0){@() | ConvertTo-Json -Compress; exit 0}",
    "try{$listeners=@{};Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object{$_.LocalAddress -in @('127.0.0.1','0.0.0.0','::1','::')}|ForEach-Object{$listeners[[int]$_.OwningProcess]=[int]$_.LocalPort}}catch{throw 'Unable to inspect local listening processes.'}",
    "$rx='(?i)(next|vite|react-scripts|npm(?:\\.cmd)?\\s+run\\s+dev|pnpm(?:\\.cmd)?\\s+dev|yarn(?:\\.cmd)?\\s+dev|http\\.server|serve)'",
    "$hits=@()",
    "foreach($process in (Get-CimInstance Win32_Process | Where-Object{$_.CommandLine})) {",
    "  $processPid=[int]$process.ProcessId",
    "  if(-not $listeners.ContainsKey($processPid)){continue}",
    "  $commandLine=[string]$process.CommandLine",
    "  if($commandLine -notmatch $rx){continue}",
    "  $normalizedCommand=$commandLine.ToLowerInvariant()",
    "  $folder=$folders | Where-Object { $normalizedCommand.Contains($_.ToLowerInvariant()) } | Select-Object -First 1",
    "  if(-not $folder){continue}",
    "  $hits += [pscustomobject]@{ pid=$processPid; port=$listeners[$processPid]; processName=[string]$process.Name; folder=[string]$folder }",
    "}",
    "$hits | Sort-Object folder, pid | ConvertTo-Json -Compress"
  ].join("\n");
}

/**
 * Parses JSON-emitted folder runtime candidates into stable records.
 *
 * @param stdout - JSON output from the local inspection script.
 * @returns Parsed candidates.
 */
function parseFolderRuntimeProcessCandidates(
  stdout: string
): readonly FolderRuntimeProcessCandidate[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records.flatMap((record) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        return [];
      }
      const candidate = record as Partial<FolderRuntimeProcessCandidate>;
      if (typeof candidate.pid !== "number" || !Number.isInteger(candidate.pid) || candidate.pid <= 0) {
        return [];
      }
      if (typeof candidate.folder !== "string" || candidate.folder.trim().length === 0) {
        return [];
      }
      return [
        {
          pid: candidate.pid,
          port:
            typeof candidate.port === "number" && Number.isInteger(candidate.port) && candidate.port > 0
              ? candidate.port
              : null,
          processName:
            typeof candidate.processName === "string" && candidate.processName.trim().length > 0
              ? candidate.processName
              : null,
          folder: candidate.folder
        }
      ];
    });
  } catch {
    return [];
  }
}

/**
 * Inspects exact local server candidates for the provided folder set.
 *
 * @param folders - Exact folders selected by the runtime.
 * @returns Matching exact local server candidates.
 */
function inspectFolderRuntimeProcessCandidates(
  folders: readonly string[]
): readonly FolderRuntimeProcessCandidate[] | null {
  if (process.platform !== "win32" || folders.length === 0) {
    return [];
  }
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", buildFolderRuntimeProcessInspectionScript(folders)],
    {
      encoding: "utf8",
      timeout: WINDOWS_SWEEP_TIMEOUT_MS,
      windowsHide: true
    }
  );
  if (result.error || result.status !== 0) {
    return null;
  }
  return parseFolderRuntimeProcessCandidates(result.stdout);
}

/**
 * Builds one concise proof line for a candidate process record.
 *
 * @param candidate - Matched process candidate.
 * @returns Human-readable proof line.
 */
function formatCandidateSummary(candidate: FolderRuntimeProcessCandidate): string {
  return [
    `pid ${candidate.pid}`,
    candidate.processName ? `(${candidate.processName})` : null,
    candidate.port !== null ? `port ${candidate.port}` : null,
    `folder ${candidate.folder}`
  ]
    .filter((segment): segment is string => Boolean(segment))
    .join(" ");
}

/**
 * Executes a bounded folder-group runtime sweep by stopping exact local server processes tied to
 * matching folders and proving whether any matched listeners remain.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param params - Structured planner params for this stop request.
 * @returns Typed executor outcome with bounded proof metadata.
 */
export async function executeStopFolderRuntimeProcesses(
  context: LiveRunExecutorContext,
  params: StopFolderRuntimeProcessesActionParams
): Promise<ExecutorExecutionOutcome> {
  const rootPath = normalizeOptionalString(params.rootPath);
  const selectorMode = resolveSelectorMode(params.selectorMode);
  const selectorTerm = resolveSelectorTerm(params.selectorTerm);
  if (!rootPath || !path.isAbsolute(rootPath)) {
    return buildExecutionOutcome(
      "blocked",
      "Folder runtime shutdown blocked: params.rootPath must be an absolute local path.",
      "READ_MISSING_PATH"
    );
  }
  if (!selectorMode || !selectorTerm) {
    return buildExecutionOutcome(
      "blocked",
      "Folder runtime shutdown blocked: params.selectorMode and params.selectorTerm must be present and bounded.",
      "ACTION_EXECUTION_FAILED"
    );
  }

  let matchedFolders: readonly string[];
  try {
    matchedFolders = await listMatchingFolders(rootPath, selectorMode, selectorTerm);
  } catch (error) {
    return buildExecutionOutcome(
      "failed",
      `Folder runtime shutdown failed: ${(error as Error).message}`,
      "ACTION_EXECUTION_FAILED"
    );
  }

  const metadataBase = {
    rootPath,
    selectorMode,
    selectorTerm
  } as const;

  if (matchedFolders.length === 0) {
    return buildExecutionOutcome(
      "success",
      `Checked ${rootPath}. No folders matched ${selectorMode === "starts_with" ? "the prefix" : "the selector"} "${selectorTerm}", so no server processes were stopped.`,
      undefined,
      buildFolderRuntimeProcessSweepMetadata({
        ...metadataBase,
        matchedFolders,
        initialCandidatePids: [],
        stoppedPids: [],
        remainingPids: []
      })
    );
  }

  const initialCandidates = inspectFolderRuntimeProcessCandidates(matchedFolders);
  if (initialCandidates === null) {
    return buildExecutionOutcome(
      "failed",
      `Folder runtime shutdown failed: unable to inspect local server processes for ${rootPath}.`,
      "ACTION_EXECUTION_FAILED",
      buildFolderRuntimeProcessSweepMetadata({
        ...metadataBase,
        matchedFolders,
        initialCandidatePids: [],
        stoppedPids: [],
        remainingPids: []
      })
    );
  }
  if (initialCandidates.length === 0) {
    return buildExecutionOutcome(
      "success",
      `Checked ${matchedFolders.length} matching folder${matchedFolders.length === 1 ? "" : "s"} under ${rootPath}. No exact listening local server processes tied to those folders were running.`,
      undefined,
      buildFolderRuntimeProcessSweepMetadata({
        ...metadataBase,
        matchedFolders,
        initialCandidatePids: [],
        stoppedPids: [],
        remainingPids: []
      })
    );
  }

  const uniqueCandidatePids = [...new Set(initialCandidates.map((candidate) => candidate.pid))];
  const stoppedPids: number[] = [];
  for (const pid of uniqueCandidatePids) {
    const stopped = await context.terminateProcessTreeByPid(pid);
    if (stopped) {
      stoppedPids.push(pid);
    }
  }

  if (stoppedPids.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const remainingCandidates = inspectFolderRuntimeProcessCandidates(matchedFolders);
  if (remainingCandidates === null) {
    return buildExecutionOutcome(
      "failed",
      `Folder runtime shutdown failed: stop requests were sent, but final verification could not inspect local server state for ${rootPath}.`,
      "ACTION_EXECUTION_FAILED",
      buildFolderRuntimeProcessSweepMetadata({
        ...metadataBase,
        matchedFolders,
        initialCandidatePids: uniqueCandidatePids,
        stoppedPids,
        remainingPids: []
      })
    );
  }
  const remainingPids = [...new Set(remainingCandidates.map((candidate) => candidate.pid))];
  const stoppedCandidates = initialCandidates.filter((candidate) => stoppedPids.includes(candidate.pid));

  const executionMetadata = buildFolderRuntimeProcessSweepMetadata({
    ...metadataBase,
    matchedFolders,
    initialCandidatePids: uniqueCandidatePids,
    stoppedPids,
    remainingPids
  });

  if (remainingPids.length > 0) {
    return buildExecutionOutcome(
      "failed",
      [
        `Checked ${matchedFolders.length} matching folder${matchedFolders.length === 1 ? "" : "s"} under ${rootPath}.`,
        stoppedCandidates.length > 0
          ? `Stopped ${stoppedCandidates.length} exact server process${stoppedCandidates.length === 1 ? "" : "es"}: ${stoppedCandidates.map(formatCandidateSummary).join("; ")}.`
          : "No matched server process accepted the stop request.",
        `Still listening after verification: ${remainingCandidates.map(formatCandidateSummary).join("; ")}.`
      ].join(" "),
      "ACTION_EXECUTION_FAILED",
      executionMetadata
    );
  }

  return buildExecutionOutcome(
    "success",
    [
      `Checked ${matchedFolders.length} matching folder${matchedFolders.length === 1 ? "" : "s"} under ${rootPath}.`,
      `Stopped ${stoppedCandidates.length} exact server process${stoppedCandidates.length === 1 ? "" : "es"}: ${stoppedCandidates.map(formatCandidateSummary).join("; ")}.`,
      "Verified that no matching local server processes remain listening."
    ].join(" "),
    undefined,
    executionMetadata
  );
}
