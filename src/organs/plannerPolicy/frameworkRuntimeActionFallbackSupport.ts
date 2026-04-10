import { existsSync, readFileSync } from "node:fs";
import type { ShellKindV1 } from "../../core/runtimeTypes/taskPlanningTypes";

import {
  extractRequestedFrameworkFolderName,
  toFrameworkPackageSafeSlug
} from "./frameworkBuildActionHeuristics";
import { getPathModuleForPathValue } from "./frameworkPathSupport";
import { requiresFrameworkAppScaffoldAction } from "./liveVerificationPolicy";

export type FrameworkFallbackKind = "vite_react" | "next_js";

export interface FrameworkLoopbackTarget {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

const TRACKED_WORKSPACE_ROOT_PATTERN =
  /(?:^|\n)-\s+(?:Root path|Workspace root):\s+([^\r\n]+)\s*$/im;
const TRACKED_PREVIEW_URL_PATTERN =
  /(?:^|\n)-\s+Preview URL:\s+(?!none\b)([^\r\n]+)\s*$/im;
const TRACKED_PREVIEW_PROCESS_LEASE_PATTERN =
  /(?:^|\n)-\s+Preview process lease:\s+(?!none\b)([^\r\n]+)\s*$/im;
const LOOPBACK_URL_PATTERN =
  /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{2,5}))?/i;
const LOOPBACK_PORT_PATTERN = /\bport\s+(\d{2,5})\b/i;
const LOOPBACK_HOST_PATTERN = /\bhost\s+(127\.0\.0\.1|localhost|::1)\b/i;
const FRAMEWORK_PREVIEW_FOLLOW_UP_PATTERN =
  /\b(?:pull\s+up|ready\s+to\s+view|preview\s+server|localhost\s+run|keep\b[\s\S]{0,40}\bpreview\s+server\s+running)\b|\b(?:start|launch|serve|preview|run)\b[\s\S]{0,120}\b(?:localhost|127\.0\.0\.1|::1|loopback|preview|server|host|port)\b/i;
const FRAMEWORK_BROWSER_OPEN_FOLLOW_UP_PATTERN =
  /\b(?:open|reopen|show|bring\s+(?:up|back)|pull\s+up)\b[\s\S]{0,120}\b(?:browser|tab|window|preview|landing\s+page|homepage|page|site|app|it)\b/i;
const NEGATED_BROWSER_OPEN_FOLLOW_UP_PATTERN =
  /\bdo\s+not\s+(?:pop\s+the\s+)?browser\s+open\b|\bdo\s+not\s+open\b[\s\S]{0,80}\b(?:browser|tab|window|page|site|preview|it)\b/i;
const FRAMEWORK_CONTENT_BUILD_PATTERN =
  /\b(?:turn\s+that|make|build|finish|complete|implement)\b[\s\S]{0,120}\b(?:landing\s+page|homepage|page|site|app|workspace|project)\b/i;

/** Parses a tracked preview URL into a reusable loopback target when it stays on localhost. */
export function resolveTrackedPreviewLoopbackTarget(
  previewUrl: string | null
): FrameworkLoopbackTarget | null {
  if (!previewUrl) {
    return null;
  }
  try {
    const parsedUrl = new URL(previewUrl);
    const supportedHost =
      parsedUrl.hostname === "127.0.0.1" ||
      parsedUrl.hostname === "localhost" ||
      parsedUrl.hostname === "[::1]" ||
      parsedUrl.hostname === "::1";
    if ((parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") || !supportedHost) {
      return null;
    }
    const normalizedHost = parsedUrl.hostname === "[::1]" ? "::1" : parsedUrl.hostname;
    return {
      host: normalizedHost,
      port: Number(parsedUrl.port),
      url: `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname || "/"}`
    };
  } catch {
    return null;
  }
}

/** Normalizes an explicitly requested loopback port or falls back to the framework default. */
function normalizeLoopbackPort(rawPort: string | null, fallbackPort: number): number {
  const parsedPort = Number(rawPort);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    return fallbackPort;
  }
  return parsedPort;
}

/** Resolves the canonical loopback target for one deterministic framework live-run request. */
export function resolveFrameworkLoopbackTarget(
  kind: FrameworkFallbackKind,
  activeRequest: string
): FrameworkLoopbackTarget {
  const defaultPort = kind === "next_js" ? 3000 : 4173;
  const explicitPort =
    activeRequest.match(LOOPBACK_URL_PATTERN)?.[1] ??
    activeRequest.match(LOOPBACK_PORT_PATTERN)?.[1] ??
    null;
  const explicitHost = activeRequest.match(LOOPBACK_HOST_PATTERN)?.[1] ?? "127.0.0.1";
  const normalizedHost = explicitHost === "::1" ? "[::1]" : explicitHost;
  const port = normalizeLoopbackPort(explicitPort, defaultPort);
  return {
    host: explicitHost,
    port,
    url: `http://${normalizedHost}:${port}`
  };
}

/** Checks whether a tracked workspace already has the build artifacts required for live reuse. */
export function hasFrameworkBuildArtifacts(
  kind: FrameworkFallbackKind,
  workspaceRoot: string
): boolean {
  const pathModule = getPathModuleForPathValue(workspaceRoot);
  return kind === "next_js"
    ? existsSync(pathModule.join(workspaceRoot, ".next", "BUILD_ID"))
    : existsSync(pathModule.join(workspaceRoot, "dist", "index.html"));
}

/** Detects a natural-language follow-up that asks to start or warm the tracked preview. */
export function isFrameworkPreviewFollowUp(activeRequest: string): boolean {
  return (
    FRAMEWORK_PREVIEW_FOLLOW_UP_PATTERN.test(activeRequest) &&
    !FRAMEWORK_CONTENT_BUILD_PATTERN.test(activeRequest)
  );
}

/** Detects a natural-language follow-up that asks to open the tracked framework page in browser. */
export function isFrameworkBrowserOpenFollowUp(activeRequest: string): boolean {
  return (
    FRAMEWORK_BROWSER_OPEN_FOLLOW_UP_PATTERN.test(activeRequest) &&
    !NEGATED_BROWSER_OPEN_FOLLOW_UP_PATTERN.test(activeRequest) &&
    !FRAMEWORK_CONTENT_BUILD_PATTERN.test(activeRequest)
  );
}

/** Escapes one string for single-quoted PowerShell literals. */
function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

/** Escapes one string for single-quoted POSIX shell literals. */
function escapePosixSingleQuoted(value: string): string {
  return value.replace(/'/g, "'\"'\"'");
}

/** Extracts the tracked workspace root from wrapped conversation execution input when present. */
export function extractTrackedWorkspaceRoot(requestContext: string): string | null {
  const rawRoot =
    requestContext.match(TRACKED_WORKSPACE_ROOT_PATTERN)?.[1]?.trim() ?? null;
  return rawRoot && rawRoot.length > 0 ? rawRoot : null;
}

/** Extracts the tracked preview URL from wrapped conversation execution input when present. */
export function extractTrackedPreviewUrl(requestContext: string): string | null {
  const rawPreviewUrl =
    requestContext.match(TRACKED_PREVIEW_URL_PATTERN)?.[1]?.trim() ?? null;
  return rawPreviewUrl && rawPreviewUrl.length > 0 ? rawPreviewUrl : null;
}

/** Extracts the tracked preview lease id from wrapped conversation execution input when present. */
export function extractTrackedPreviewProcessLeaseId(requestContext: string): string | null {
  const rawPreviewProcessLeaseId =
    requestContext.match(TRACKED_PREVIEW_PROCESS_LEASE_PATTERN)?.[1]?.trim() ?? null;
  return rawPreviewProcessLeaseId && rawPreviewProcessLeaseId.length > 0
    ? rawPreviewProcessLeaseId
    : null;
}

/** Infers the framework kind from one existing workspace when the request no longer repeats it. */
function inferFrameworkKindFromWorkspace(
  workspaceRoot: string
): FrameworkFallbackKind | null {
  const pathModule = getPathModuleForPathValue(workspaceRoot);
  if (
    existsSync(pathModule.join(workspaceRoot, "next-env.d.ts")) ||
    existsSync(pathModule.join(workspaceRoot, "next.config.js")) ||
    existsSync(pathModule.join(workspaceRoot, "next.config.mjs")) ||
    existsSync(pathModule.join(workspaceRoot, "app")) ||
    existsSync(pathModule.join(workspaceRoot, "src", "app"))
  ) {
    return "next_js";
  }
  if (
    existsSync(pathModule.join(workspaceRoot, "vite.config.ts")) ||
    existsSync(pathModule.join(workspaceRoot, "vite.config.js")) ||
    existsSync(pathModule.join(workspaceRoot, "src", "main.tsx")) ||
    existsSync(pathModule.join(workspaceRoot, "src", "main.jsx"))
  ) {
    return "vite_react";
  }
  const packageJsonPath = pathModule.join(workspaceRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    return null;
  }
  try {
    const packageJsonText = readFileSync(packageJsonPath, "utf8");
    if (/"next"\s*:/i.test(packageJsonText)) {
      return "next_js";
    }
    if (/"vite"\s*:/i.test(packageJsonText) || /"react"\s*:/i.test(packageJsonText)) {
      return "vite_react";
    }
  } catch {
    return null;
  }
  return null;
}

/** Resolves a deterministic framework kind from the active request and any tracked workspace. */
export function resolveFrameworkFallbackKind(
  requestContext: string,
  trackedWorkspaceRoot: string | null
): FrameworkFallbackKind | null {
  if (/\bnext\.?js\b|\bnextjs\b/i.test(requestContext)) {
    return "next_js";
  }
  if (/\breact\b|\bvite\b/i.test(requestContext)) {
    return "vite_react";
  }
  if (!requiresFrameworkAppScaffoldAction(requestContext) && !trackedWorkspaceRoot) {
    return null;
  }
  if (trackedWorkspaceRoot) {
    return inferFrameworkKindFromWorkspace(trackedWorkspaceRoot);
  }
  return null;
}

/** Builds the deterministic scaffold command for a bounded framework-app workspace creation step. */
export function buildFrameworkScaffoldCommand(
  kind: FrameworkFallbackKind,
  finalFolderPath: string,
  requestedFolderName: string,
  requestedShellKind: ShellKindV1
): string {
  const safeSlug = toFrameworkPackageSafeSlug(
    extractRequestedFrameworkFolderName(requestedFolderName) ?? requestedFolderName
  );
  const powerShellLike =
    requestedShellKind === "powershell" || requestedShellKind === "pwsh";
  const scaffoldCommand = kind === "next_js"
    ? [
        `npx create-next-app@latest '${
          powerShellLike
            ? escapePowerShellSingleQuoted(safeSlug)
            : escapePosixSingleQuoted(safeSlug)
        }'`,
        "--js",
        "--eslint",
        "--app",
        "--use-npm",
        "--yes",
        "--skip-install",
        "--no-tailwind",
        "--no-src-dir",
        "--disable-git",
        "--no-react-compiler"
      ].join(" ")
    : `npx create-vite@latest --template react-ts --no-interactive '${
        powerShellLike
          ? escapePowerShellSingleQuoted(safeSlug)
          : escapePosixSingleQuoted(safeSlug)
      }'`;
  if (powerShellLike) {
    return [
      `$final = '${escapePowerShellSingleQuoted(finalFolderPath)}'`,
      `$tempRoot = Join-Path $env:TEMP 'agentbigbrain-framework-scaffold'`,
      `$temp = Join-Path $tempRoot '${escapePowerShellSingleQuoted(safeSlug)}'`,
      "if (!(Test-Path $tempRoot)) { New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null }",
      "if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }",
      "if (Test-Path (Join-Path $final 'package.json')) { Set-Location $final; exit 0 }",
      "Set-Location $tempRoot",
      scaffoldCommand,
      "if (!(Test-Path $temp)) { if (Test-Path (Join-Path $final 'package.json')) { Set-Location $final; exit 0 }; throw ('Framework scaffold did not create expected temp workspace: ' + $temp) }",
      "if (!(Test-Path $final)) { New-Item -ItemType Directory -Path $final -Force | Out-Null }",
      "Get-ChildItem -Force $temp | ForEach-Object { Move-Item $_.FullName -Destination $final -Force }",
      "Remove-Item $temp -Recurse -Force",
      "Set-Location $final"
    ].join("; ");
  }
  return [
    `final='${escapePosixSingleQuoted(finalFolderPath)}'`,
    'temp_root="/tmp/agentbigbrain-framework-scaffold"',
    `temp=\"$temp_root/${escapePosixSingleQuoted(safeSlug)}\"`,
    "mkdir -p \"$temp_root\"",
    "rm -rf \"$temp\"",
    "if [ -f \"$final/package.json\" ]; then cd \"$final\"; exit 0; fi",
    "cd \"$temp_root\"",
    scaffoldCommand,
    "if [ ! -d \"$temp\" ]; then if [ -f \"$final/package.json\" ]; then cd \"$final\"; exit 0; fi; echo \"Framework scaffold did not create expected temp workspace: $temp\" >&2; exit 1; fi",
    "mkdir -p \"$final\"",
    "find \"$temp\" -mindepth 1 -maxdepth 1 -exec mv {} \"$final\"/ \\;",
    "rm -rf \"$temp\"",
    "cd \"$final\""
  ].join("; ");
}

/**
 * Builds the bounded workspace-readiness proof command for the active framework shell.
 *
 * @param shellKind - Requested runtime shell for the deterministic fallback lane.
 * @returns Shell command that proves package.json and node_modules exist in the workspace.
 */
export function buildFrameworkWorkspaceProofCommand(shellKind: string): string {
  if (shellKind === "powershell" || shellKind === "pwsh") {
    return (
      "$missing=@(); if (!(Test-Path '.\\package.json')) { $missing += 'package.json' }; " +
      "if (!(Test-Path '.\\node_modules')) { $missing += 'node_modules' }; " +
      "if ($missing.Count -gt 0) { throw ('Workspace not ready; missing: ' + ($missing -join ', ')) }; " +
      "Get-Item .\\package.json,.\\node_modules | Select-Object Name,FullName"
    );
  }
  return [
    "missing=\"\"",
    "[ -e './package.json' ] || missing=\"$missing package.json\"",
    "[ -e './node_modules' ] || missing=\"$missing node_modules\"",
    "if [ -n \"$missing\" ]; then echo \"Workspace not ready; missing:${missing}\" >&2; exit 1; fi",
    "printf '%s\\n' './package.json' './node_modules'"
  ].join("; ");
}

/**
 * Builds the bounded source-and-build proof command for the active framework shell.
 *
 * @param kind - Framework family being scaffolded or reused.
 * @param shellKind - Requested runtime shell for the deterministic fallback lane.
 * @returns Shell command that proves the expected framework source and build artifacts exist.
 */
export function buildFrameworkBuildProofCommand(
  kind: FrameworkFallbackKind,
  shellKind: string
): string {
  if (shellKind === "powershell" || shellKind === "pwsh") {
    return kind === "next_js"
      ? [
          "$missing=@()",
          "if (!(Test-Path '.\\package.json')) { $missing += 'package.json' }",
          "if (!(Test-Path '.\\node_modules')) { $missing += 'node_modules' }",
          "if (!(Test-Path '.\\app\\page.js') -and !(Test-Path '.\\app\\page.tsx') -and !(Test-Path '.\\src\\app\\page.js') -and !(Test-Path '.\\src\\app\\page.tsx')) { $missing += 'app/page' }",
          "if (!(Test-Path '.\\.next\\BUILD_ID')) { $missing += '.next/BUILD_ID' }",
          "if ($missing.Count -gt 0) { throw ('Landing page build proof missing: ' + ($missing -join ', ')) }",
          "Get-Item .\\package.json,.\\node_modules,.\\.next\\BUILD_ID | Select-Object Name,FullName"
        ].join("; ")
      : [
          "$missing=@()",
          "if (!(Test-Path '.\\package.json')) { $missing += 'package.json' }",
          "if (!(Test-Path '.\\node_modules')) { $missing += 'node_modules' }",
          "if (!(Test-Path '.\\src\\App.jsx') -and !(Test-Path '.\\src\\App.tsx') -and !(Test-Path '.\\src\\App.js') -and !(Test-Path '.\\src\\App.ts')) { $missing += 'src/App' }",
          "if (!(Test-Path '.\\dist\\index.html')) { $missing += 'dist/index.html' }",
          "if ($missing.Count -gt 0) { throw ('Landing page build proof missing: ' + ($missing -join ', ')) }",
          "Get-Item .\\package.json,.\\node_modules,.\\dist\\index.html | Select-Object Name,FullName"
        ].join("; ");
  }
  return kind === "next_js"
    ? [
        "missing=\"\"",
        "[ -e './package.json' ] || missing=\"$missing package.json\"",
        "[ -e './node_modules' ] || missing=\"$missing node_modules\"",
        "[ -e './app/page.js' ] || [ -e './app/page.tsx' ] || [ -e './src/app/page.js' ] || [ -e './src/app/page.tsx' ] || missing=\"$missing app/page\"",
        "[ -e './.next/BUILD_ID' ] || missing=\"$missing .next/BUILD_ID\"",
        "if [ -n \"$missing\" ]; then echo \"Landing page build proof missing:${missing}\" >&2; exit 1; fi",
        "printf '%s\\n' './package.json' './node_modules' './.next/BUILD_ID'"
      ].join("; ")
    : [
        "missing=\"\"",
        "[ -e './package.json' ] || missing=\"$missing package.json\"",
        "[ -e './node_modules' ] || missing=\"$missing node_modules\"",
        "[ -e './src/App.jsx' ] || [ -e './src/App.tsx' ] || [ -e './src/App.js' ] || [ -e './src/App.ts' ] || missing=\"$missing src/App\"",
        "[ -e './dist/index.html' ] || missing=\"$missing dist/index.html\"",
        "if [ -n \"$missing\" ]; then echo \"Landing page build proof missing:${missing}\" >&2; exit 1; fi",
        "printf '%s\\n' './package.json' './node_modules' './dist/index.html'"
      ].join("; ");
}
