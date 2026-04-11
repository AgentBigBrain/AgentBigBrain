/**
 * @fileoverview Bounded read-only inspection for likely untracked local preview-holder processes.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as http from "node:http";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { promoteExactNonPreviewTargetPathCandidate } from "./untrackedPreviewCandidateRecoverySelectors";

export type RuntimeInspectionCandidateConfidence = "high" | "medium" | "low";

export type RuntimeInspectionUntrackedHolderKind =
  | "preview_server"
  | "editor_workspace"
  | "shell_workspace"
  | "sync_client"
  | "unknown_local_process";

export type RuntimeInspectionRecommendedNextAction =
  | "stop_exact_tracked_holders"
  | "clarify_before_exact_non_preview_shutdown"
  | "clarify_before_likely_non_preview_shutdown"
  | "clarify_before_untracked_shutdown"
  | "manual_non_preview_holder_cleanup"
  | "manual_orphaned_browser_cleanup"
  | "collect_more_evidence";

export interface UntrackedHolderCandidate {
  pid: number;
  port: number | null;
  processName: string | null;
  commandLine: string | null;
  confidence: RuntimeInspectionCandidateConfidence;
  reason: string;
  holderKind: RuntimeInspectionUntrackedHolderKind;
}

export interface SystemPreviewCandidateInspectionRequest {
  targetPath: string | null;
  rootPath: string | null;
  previewUrl: string | null;
  trackedPids: readonly number[];
}

interface WindowsProcessInspectionRecord {
  pid: number;
  port: number | null;
  processName: string | null;
  commandLine: string | null;
  confidence: RuntimeInspectionCandidateConfidence;
  reason: string;
}

const WINDOWS_INSPECTION_TIMEOUT_MS = 5_000;
const MIN_BASENAME_MATCH_LENGTH = 6;
const LOOPBACK_PROBE_TIMEOUT_MS = 800;
const LOOPBACK_PREVIEW_PROCESS_PATTERN =
  /\b(?:http\.server|vite|live-server|http-server|webpack|next(?:\s+dev)?|serve)\b/i;
const LOOPBACK_PREVIEW_PROCESS_NAME_PATTERN = /^(?:python|pythonw|node)(?:\.exe)?$/i;
const LOOPBACK_PREVIEW_COMMANDLINE_MATCHER =
  "http\\.server|vite|live-server|http-server|webpack|next(?:\\s+dev)?|serve";
const EDITOR_WORKSPACE_PROCESS_NAME_PATTERN =
  /^(?:code|cursor|windsurf|devenv|idea64|idea|webstorm64|webstorm|rider64|rider|clion64|clion|pycharm64|pycharm|notepad\+\+)(?:\.exe)?$/i;
const EDITOR_WORKSPACE_COMMANDLINE_PATTERN =
  /\b(?:code(?:\.exe)?|cursor(?:\.exe)?|windsurf(?:\.exe)?|devenv(?:\.exe)?|idea64(?:\.exe)?|webstorm64(?:\.exe)?|rider64(?:\.exe)?|clion64(?:\.exe)?|pycharm64(?:\.exe)?|notepad\+\+)\b/i;
const SHELL_WORKSPACE_PROCESS_NAME_PATTERN =
  /^(?:explorer|powershell|pwsh|cmd|bash|wt|windowsterminal|conhost)(?:\.exe)?$/i;
const SHELL_WORKSPACE_COMMANDLINE_PATTERN =
  /\b(?:explorer(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd(?:\.exe)?|bash(?:\.exe)?|wt(?:\.exe)?|windowsterminal|conhost(?:\.exe)?)\b/i;
const SYNC_PROCESS_NAME_PATTERN =
  /^(?:onedrive|dropbox|googledrivefs|box|synologydriveclient|synologydrive|adobecollabsync|creativecloud)(?:\.exe)?$/i;
const SYNC_COMMANDLINE_PATTERN =
  /\b(?:onedrive|dropbox|googledrivefs|box|synologydriveclient|synologydrive|adobecollabsync|creative\s+cloud|creativecloud)\b/i;

/**
 * Renders a PowerShell array literal for tracked pid exclusions.
 *
 * @param trackedPids - Exact tracked process ids already owned by the runtime.
 * @returns PowerShell array literal safe to embed directly in a script.
 */
export function buildTrackedPidArrayLiteral(trackedPids: readonly number[]): string {
  return trackedPids.length > 0 ? `@(${trackedPids.join(", ")})` : "@()";
}

/**
 * Normalizes one filesystem path into a stable comparison form.
 *
 * @param value - Candidate filesystem path.
 * @returns Normalized comparison path, or `null` when absent.
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
 * Resolves one loopback preview URL into a deterministic local port when present.
 *
 * @param previewUrl - Candidate preview URL.
 * @returns Loopback port, or `null` when the URL is missing or not loopback-local.
 */
function tryResolveLoopbackPort(previewUrl: string | null): number | null {
  if (!previewUrl) {
    return null;
  }
  try {
    const parsedUrl = new URL(previewUrl);
    const normalizedHost = parsedUrl.hostname.trim().toLowerCase();
    if (
      normalizedHost !== "127.0.0.1" &&
      normalizedHost !== "localhost" &&
      normalizedHost !== "::1"
    ) {
      return null;
    }
    if (parsedUrl.port.trim().length === 0) {
      return parsedUrl.protocol === "https:" ? 443 : 80;
    }
    const port = Number.parseInt(parsedUrl.port, 10);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Builds one bounded PowerShell script for read-only preview-holder inspection on Windows.
 *
 * @param request - Structured inspection request.
 * @param loopbackPort - Parsed preview port when available.
 * @returns PowerShell script text.
 */
function buildWindowsInspectionScript(
  request: SystemPreviewCandidateInspectionRequest,
  loopbackPort: number | null
): string {
  const normalizedRootPath = normalizeComparablePath(request.rootPath);
  const normalizedTargetPath = normalizeComparablePath(request.targetPath);
  const exactPathNeedle = normalizedRootPath ?? normalizedTargetPath ?? "";
  const basenameNeedle = exactPathNeedle
    ? path.basename(exactPathNeedle).trim().toLowerCase()
    : "";
  const basenameSearchNeedle =
    basenameNeedle.length >= MIN_BASENAME_MATCH_LENGTH ? basenameNeedle : "";
  const trackedPidArrayLiteral = buildTrackedPidArrayLiteral(request.trackedPids);

  return `
$tracked = ${trackedPidArrayLiteral}
$results = @()
$seen = @{}
$port = ${loopbackPort ?? "$null"}
$exactPathNeedle = ${JSON.stringify(exactPathNeedle)}
$basenameNeedle = ${JSON.stringify(basenameSearchNeedle)}
function Get-CommandLineForProcess($processId) {
  try {
    $procRecord = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$processId) -ErrorAction Stop
    if ($procRecord -and $procRecord.CommandLine) {
      return [string]$procRecord.CommandLine
    }
  } catch {}
  return $null
}
if ($port -ne $null) {
  try {
    $listening = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique
  } catch {
    $listening = @()
  }
  foreach ($processId in $listening) {
    if ($tracked -contains [int]$processId) { continue }
    if ($seen.ContainsKey([string]$processId)) { continue }
    try {
      $proc = Get-Process -Id $processId -ErrorAction Stop
      $name = if ($proc.ProcessName) { [string]$proc.ProcessName } else { $null }
    } catch {
      $name = $null
    }
    $commandLine = Get-CommandLineForProcess $processId
    $results += [pscustomobject]@{
        pid = [int]$processId
        port = [int]$port
        processName = $name
        commandLine = $commandLine
        confidence = "high"
        reason = "listening_on_preview_port"
    }
    $seen[[string]$processId] = $true
  }
}
$includeLoopbackListeners = ${loopbackPort === null ? "$true" : "$false"}
if ($includeLoopbackListeners) {
  try {
    $listeners = Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1', '::') } |
      Select-Object OwningProcess, LocalPort -Unique
  } catch {
    $listeners = @()
  }
  foreach ($listener in $listeners) {
    if ($null -eq $listener.OwningProcess -or $null -eq $listener.LocalPort) { continue }
    $processId = [int]$listener.OwningProcess
    if ($tracked -contains $processId) { continue }
    if ($seen.ContainsKey([string]$processId)) { continue }
    try {
      $proc = Get-Process -Id $processId -ErrorAction Stop
      $name = if ($proc.ProcessName) { [string]$proc.ProcessName } else { $null }
    } catch {
      $name = $null
    }
    $commandLine = Get-CommandLineForProcess $processId
    $normalizedName = if ($name) { $name.ToLowerInvariant() } else { "" }
    $normalizedCommand = if ($commandLine) { $commandLine.ToLowerInvariant() } else { "" }
    $looksLikePreview =
      $normalizedName -eq 'python' -or
      $normalizedName -eq 'python.exe' -or
      $normalizedName -eq 'pythonw' -or
      $normalizedName -eq 'pythonw.exe' -or
      $normalizedName -eq 'node' -or
      $normalizedName -eq 'node.exe'
    if ($normalizedCommand -and -not ($normalizedCommand -match '${LOOPBACK_PREVIEW_COMMANDLINE_MATCHER}')) {
      $looksLikePreview = $false
    }
    if (-not $looksLikePreview) { continue }
    $results += [pscustomobject]@{
      pid = $processId
      port = [int]$listener.LocalPort
      processName = $name
      commandLine = $commandLine
      confidence = "low"
      reason = "listening_loopback_preview_candidate"
    }
    $seen[[string]$processId] = $true
  }
}
if (($exactPathNeedle -or $basenameNeedle) -and $results.Count -eq 0) {
  try {
    $processes = Get-CimInstance Win32_Process -ErrorAction Stop
  } catch {
    $processes = @()
  }
  foreach ($proc in $processes) {
    if ($null -eq $proc.ProcessId) { continue }
    $processId = [int]$proc.ProcessId
    if ($tracked -contains $processId) { continue }
    if ($seen.ContainsKey([string]$processId)) { continue }
    $commandLine = if ($proc.CommandLine) { [string]$proc.CommandLine } else { "" }
    if (-not $commandLine) { continue }
    $normalizedCommand = $commandLine.ToLowerInvariant()
    if ($exactPathNeedle -and $normalizedCommand.Contains($exactPathNeedle)) {
      $results += [pscustomobject]@{
        pid = $processId
        port = $null
        processName = if ($proc.Name) { [string]$proc.Name } else { $null }
        commandLine = [string]$proc.CommandLine
        confidence = "medium"
        reason = "command_line_matches_target_path"
      }
      $seen[[string]$processId] = $true
      continue
    }
    if ($basenameNeedle -and $normalizedCommand.Contains($basenameNeedle)) {
      $results += [pscustomobject]@{
        pid = $processId
        port = $null
        processName = if ($proc.Name) { [string]$proc.Name } else { $null }
        commandLine = [string]$proc.CommandLine
        confidence = "low"
        reason = "command_line_mentions_target_name"
      }
      $seen[[string]$processId] = $true
    }
  }
}
$results | ConvertTo-Json -Compress
`.trim();
}

/**
 * Parses JSON-emitted candidate inspection results into stable records.
 *
 * @param stdout - JSON output from the local inspection script.
 * @returns Parsed and validated candidate records.
 */
function parseCandidateArray(stdout: string): WindowsProcessInspectionRecord[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return [];
      }
      const record = candidate as Partial<WindowsProcessInspectionRecord>;
      if (typeof record.pid !== "number" || !Number.isInteger(record.pid)) {
        return [];
      }
      const port =
        typeof record.port === "number" && Number.isInteger(record.port) && record.port > 0
          ? record.port
          : null;
      const confidence: RuntimeInspectionCandidateConfidence =
        record.confidence === "high" ||
        record.confidence === "medium" ||
        record.confidence === "low"
          ? record.confidence
          : "low";
      return [
        {
          pid: record.pid,
          port,
          processName:
            typeof record.processName === "string" && record.processName.trim().length > 0
              ? record.processName
              : null,
          commandLine:
            typeof record.commandLine === "string" && record.commandLine.trim().length > 0
              ? record.commandLine
              : null,
          confidence,
          reason:
            typeof record.reason === "string" && record.reason.trim().length > 0
              ? record.reason
              : "candidate_process_match"
        }
      ];
    });
  } catch {
    return [];
  }
}

/**
 * Classifies one untracked holder candidate into a bounded runtime-owned holder kind.
 *
 * @param processName - Candidate process executable name.
 * @param commandLine - Candidate command line when it can be recovered.
 * @param reason - Existing bounded inspection reason.
 * @returns Stable holder kind used by recovery policy and evidence rendering.
 */
function classifyUntrackedHolderKind(
  processName: string | null,
  commandLine: string | null,
  reason: string
): RuntimeInspectionUntrackedHolderKind {
  if (
    reason === "served_index_matches_target_workspace" ||
    reason === "listening_on_preview_port" ||
    reason === "listening_loopback_preview_candidate" ||
    isLikelyLoopbackPreviewCandidate(processName, commandLine)
  ) {
    return "preview_server";
  }
  if (
    processName &&
    EDITOR_WORKSPACE_PROCESS_NAME_PATTERN.test(processName)
  ) {
    return "editor_workspace";
  }
  if (
    processName &&
    SHELL_WORKSPACE_PROCESS_NAME_PATTERN.test(processName)
  ) {
    return "shell_workspace";
  }
  if (
    processName &&
    SYNC_PROCESS_NAME_PATTERN.test(processName)
  ) {
    return "sync_client";
  }
  if (commandLine && EDITOR_WORKSPACE_COMMANDLINE_PATTERN.test(commandLine)) {
    return "editor_workspace";
  }
  if (commandLine && SHELL_WORKSPACE_COMMANDLINE_PATTERN.test(commandLine)) {
    return "shell_workspace";
  }
  if (commandLine && SYNC_COMMANDLINE_PATTERN.test(commandLine)) {
    return "sync_client";
  }
  return "unknown_local_process";
}


/**
 * Resolves the workspace `index.html` path used for content-based preview-holder matching.
 *
 * @param request - Structured inspection request.
 * @returns Local index path when it exists, otherwise `null`.
 */
function resolveWorkspaceIndexPath(
  request: SystemPreviewCandidateInspectionRequest
): string | null {
  const workspaceRoot =
    normalizeComparablePath(request.rootPath) ?? normalizeComparablePath(request.targetPath);
  if (!workspaceRoot) {
    return null;
  }
  const indexPath = path.join(workspaceRoot, "index.html");
  return existsSync(indexPath) ? indexPath : null;
}

/**
 * Computes a stable SHA-256 fingerprint for local or remotely served preview content.
 *
 * @param content - Content bytes or text to fingerprint.
 * @returns Hex-encoded SHA-256 digest.
 */
function computeSha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Returns whether one candidate process still looks like a local preview holder after command-line
 * inspection.
 *
 * @param processName - Candidate process executable name.
 * @param commandLine - Candidate process command line when it can be recovered.
 * @returns `true` when the process still looks like a bounded local preview holder.
 */
export function isLikelyLoopbackPreviewCandidate(
  processName: string | null,
  commandLine: string | null
): boolean {
  if (!processName || !LOOPBACK_PREVIEW_PROCESS_NAME_PATTERN.test(processName)) {
    return false;
  }
  if (!commandLine) {
    return true;
  }
  return LOOPBACK_PREVIEW_PROCESS_PATTERN.test(commandLine);
}

/**
 * Fetches the live `/index.html` payload fingerprint for one loopback preview candidate.
 *
 * @param port - Loopback port currently owned by the candidate process.
 * @returns Fingerprint and content length when the probe succeeded, otherwise `null`.
 */
async function fetchLoopbackIndexFingerprint(
  port: number
): Promise<{
  sha256: string;
  length: number;
} | null> {
  return await new Promise((resolve) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/index.html",
        method: "GET",
        timeout: LOOPBACK_PROBE_TIMEOUT_MS
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const payload = Buffer.concat(chunks);
          resolve({
            sha256: computeSha256(payload),
            length: payload.length
          });
        });
      }
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.on("error", () => resolve(null));
    request.end();
  });
}

/**
 * Promotes untracked preview candidates into higher-confidence workspace matches when their served
 * content fingerprint exactly matches the target workspace artifact.
 *
 * @param request - Structured inspection request.
 * @param candidates - Parsed untracked candidates to refine.
 * @returns Candidates with upgraded confidence and holder-kind detail when content matches.
 */
async function enrichCandidatesWithWorkspaceArtifactMatches(
  request: SystemPreviewCandidateInspectionRequest,
  candidates: readonly UntrackedHolderCandidate[]
): Promise<readonly UntrackedHolderCandidate[]> {
  const workspaceIndexPath = resolveWorkspaceIndexPath(request);
  if (!workspaceIndexPath) {
    return candidates;
  }
  const localArtifact = readFileSync(workspaceIndexPath);
  const localArtifactHash = computeSha256(localArtifact);
  return await Promise.all(
    candidates.map(async (candidate) => {
      const looksLikePreviewProcess = isLikelyLoopbackPreviewCandidate(
        candidate.processName,
        candidate.commandLine
      );
      if (candidate.port === null || !looksLikePreviewProcess) {
        return candidate;
      }
      const remoteFingerprint = await fetchLoopbackIndexFingerprint(candidate.port);
      if (!remoteFingerprint || remoteFingerprint.sha256 !== localArtifactHash) {
        return candidate;
      }
      return {
        ...candidate,
        confidence: "high",
        reason: "served_index_matches_target_workspace",
        holderKind: "preview_server"
      };
    })
  );
}

/**
 * Inspects likely untracked preview-holder candidates using bounded local OS queries.
 *
 * @param request - Structured inspection selectors and already-tracked pid exclusions.
 * @returns Candidate processes that may still own a preview or related path.
 */
export async function inspectSystemPreviewCandidates(
  request: SystemPreviewCandidateInspectionRequest
): Promise<readonly UntrackedHolderCandidate[]> {
  if (process.platform !== "win32") {
    return [];
  }

  const loopbackPort = tryResolveLoopbackPort(request.previewUrl);
  const script = buildWindowsInspectionScript(request, loopbackPort);
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: WINDOWS_INSPECTION_TIMEOUT_MS,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    return [];
  }

  const parsedCandidates = parseCandidateArray(result.stdout)
    .filter((candidate) => !request.trackedPids.includes(candidate.pid))
    .map((candidate) => ({
      ...candidate,
      holderKind: classifyUntrackedHolderKind(
        candidate.processName,
        candidate.commandLine,
        candidate.reason
      )
    }))
    .map((candidate) => promoteExactNonPreviewTargetPathCandidate(candidate))
    .sort((left, right) => {
      const confidencePriority = { high: 0, medium: 1, low: 2 } as const;
      if (confidencePriority[left.confidence] !== confidencePriority[right.confidence]) {
        return confidencePriority[left.confidence] - confidencePriority[right.confidence];
      }
      const holderKindPriority = {
        preview_server: 0,
        editor_workspace: 1,
        shell_workspace: 2,
        sync_client: 3,
        unknown_local_process: 4
      } as const;
      if (holderKindPriority[left.holderKind] !== holderKindPriority[right.holderKind]) {
        return holderKindPriority[left.holderKind] - holderKindPriority[right.holderKind];
      }
      return left.pid - right.pid;
    });
  return await enrichCandidatesWithWorkspaceArtifactMatches(request, parsedCandidates);
}
