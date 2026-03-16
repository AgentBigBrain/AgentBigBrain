/**
 * @fileoverview Enumerates exact Playwright-owned browser processes for PID-backed cleanup.
 */

import { spawn } from "node:child_process";

export interface PlaywrightBrowserProcessSnapshot {
  pid: number;
  executablePath: string | null;
  commandLine: string | null;
  creationDate: string | null;
  mainWindowTitle: string | null;
}

const POWERSHELL_LIST_COMMAND = [
  "$titles = @{}",
  "Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object {",
  "  $titles[[int]$_.Id] = $_.MainWindowTitle",
  "}",
  "@(",
  "  Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" |",
  "    ForEach-Object {",
  "      [pscustomobject]@{",
  "        pid = [int]$_.ProcessId",
  "        executablePath = $_.ExecutablePath",
  "        commandLine = $_.CommandLine",
  "        creationDate = $_.CreationDate",
  "        mainWindowTitle = $titles[[int]$_.ProcessId]",
  "      }",
  "    }",
  ") | ConvertTo-Json -Compress"
].join("\n");

/**
 * Normalizes one Windows executable path for stable case-insensitive comparisons.
 *
 * @param value - Raw executable path or `null`.
 * @returns Lower-cased Windows-style path string.
 */
function normalizeLowerWindowsPath(value: string | null): string {
  return (value ?? "").replace(/\//g, "\\").toLowerCase();
}

/**
 * Normalizes one PowerShell JSON payload into typed browser-process snapshots.
 *
 * @param value - Parsed JSON payload returned by the Windows process listing command.
 * @returns Validated browser-process snapshots.
 */
function normalizeProcessListPayload(value: unknown): PlaywrightBrowserProcessSnapshot[] {
  if (!value) {
    return [];
  }
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const candidate = entry as Record<string, unknown>;
      const pid = Number(candidate.pid);
      if (!Number.isInteger(pid) || pid <= 0) {
        return null;
      }
      return {
        pid,
        executablePath:
          typeof candidate.executablePath === "string" ? candidate.executablePath : null,
        commandLine: typeof candidate.commandLine === "string" ? candidate.commandLine : null,
        creationDate:
          typeof candidate.creationDate === "string" ? candidate.creationDate : null,
        mainWindowTitle:
          typeof candidate.mainWindowTitle === "string" ? candidate.mainWindowTitle : null
      } satisfies PlaywrightBrowserProcessSnapshot;
    })
    .filter((entry): entry is PlaywrightBrowserProcessSnapshot => entry !== null);
}

/**
 * Sorts browser-process snapshots newest first using their Windows creation timestamp.
 *
 * @param left - Candidate browser-process snapshot.
 * @param right - Candidate browser-process snapshot.
 * @returns Negative/positive comparison result for descending sort order.
 */
function compareCreationDateDescending(
  left: PlaywrightBrowserProcessSnapshot,
  right: PlaywrightBrowserProcessSnapshot
): number {
  const leftKey = (left.creationDate ?? "").replace(/\D/g, "");
  const rightKey = (right.creationDate ?? "").replace(/\D/g, "");
  return rightKey.localeCompare(leftKey) || right.pid - left.pid;
}

/**
 * Runs one bounded local process command and captures its full textual output.
 *
 * @param executable - Program to execute.
 * @param args - Stable argument array for the local command.
 * @param timeoutMs - Timeout budget before the child is terminated.
 * @returns Exit code plus captured stdout and stderr.
 */
async function runProcessCommand(
  executable: string,
  args: readonly string[],
  timeoutMs: number
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const timeoutHandle = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Best effort only.
    }
  }, timeoutMs);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  }).finally(() => {
    clearTimeout(timeoutHandle);
  });
  return {
    exitCode,
    stdout,
    stderr
  };
}

/**
 * Returns whether one Windows process snapshot is the top-level Playwright-owned Chrome-for-Testing
 * browser process rather than one of its renderer or utility children.
 *
 * @param snapshot - Windows process snapshot captured from the local host.
 * @returns `true` when the process is an exact Playwright automation browser candidate.
 */
export function isPlaywrightAutomationBrowserProcess(
  snapshot: PlaywrightBrowserProcessSnapshot
): boolean {
  const executablePath = normalizeLowerWindowsPath(snapshot.executablePath);
  const commandLine = (snapshot.commandLine ?? "").toLowerCase();
  return (
    executablePath.includes("\\appdata\\local\\ms-playwright\\") &&
    executablePath.includes("\\chromium-") &&
    executablePath.endsWith("\\chrome.exe") &&
    !/\s--type=/.test(commandLine)
  );
}

/**
 * Lists exact Playwright-owned browser processes that can be reclaimed deterministically.
 *
 * @param timeoutMs - Bounded timeout for the Windows process inspection command.
 * @returns Playwright browser-process snapshots, newest first.
 */
export async function listPlaywrightAutomationBrowserProcesses(
  timeoutMs = 4_000
): Promise<readonly PlaywrightBrowserProcessSnapshot[]> {
  if (process.platform !== "win32") {
    return [];
  }
  const result = await runProcessCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_LIST_COMMAND],
    timeoutMs
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Playwright browser process inspection failed with ${result.exitCode ?? "unknown"}: ${result.stderr || result.stdout}`
    );
  }
  const payload = result.stdout.trim();
  if (payload.length === 0) {
    return [];
  }
  return normalizeProcessListPayload(JSON.parse(payload))
    .filter(isPlaywrightAutomationBrowserProcess)
    .sort(compareCreationDateDescending);
}

/**
 * Chooses the newest exact Playwright automation browser pid that appeared after one before/after
 * process snapshot diff.
 *
 * @param before - Process snapshots captured before a browser launch.
 * @param after - Process snapshots captured after a browser launch.
 * @returns Newly launched top-level Playwright browser pid, or `null` when none is detectable.
 */
export function findNewPlaywrightAutomationBrowserPid(
  before: readonly PlaywrightBrowserProcessSnapshot[],
  after: readonly PlaywrightBrowserProcessSnapshot[]
): number | null {
  const priorPids = new Set(before.map((snapshot) => snapshot.pid));
  const newestNewProcess = after
    .filter((snapshot) => !priorPids.has(snapshot.pid))
    .sort(compareCreationDateDescending)[0];
  return newestNewProcess?.pid ?? null;
}

/**
 * Terminates one exact Playwright automation browser tree by pid.
 *
 * @param pid - Exact top-level Playwright browser pid.
 * @param timeoutMs - Bounded timeout for the deterministic taskkill call.
 * @returns `true` when Windows reported successful termination.
 */
export async function terminatePlaywrightAutomationBrowserProcess(
  pid: number,
  timeoutMs = 4_000
): Promise<boolean> {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  const result = await runProcessCommand(
    "taskkill.exe",
    ["/PID", `${pid}`, "/T", "/F"],
    timeoutMs
  );
  return result.exitCode === 0;
}

/**
 * Reclaims every exact Playwright automation browser currently left behind on Windows.
 *
 * @param timeoutMs - Bounded timeout per deterministic taskkill call.
 * @returns Pids that were terminated successfully.
 */
export async function cleanupLingeringPlaywrightAutomationBrowsers(
  timeoutMs = 4_000
): Promise<readonly number[]> {
  const snapshots = await listPlaywrightAutomationBrowserProcesses(timeoutMs);
  const terminatedPids: number[] = [];
  for (const snapshot of snapshots) {
    if (await terminatePlaywrightAutomationBrowserProcess(snapshot.pid, timeoutMs)) {
      terminatedPids.push(snapshot.pid);
    }
  }
  return terminatedPids;
}
