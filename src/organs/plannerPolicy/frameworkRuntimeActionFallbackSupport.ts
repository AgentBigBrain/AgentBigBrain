import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
  requestedFolderName: string
): string {
  const safeSlug = toFrameworkPackageSafeSlug(
    extractRequestedFrameworkFolderName(requestedFolderName) ?? requestedFolderName
  );
  const scaffoldCommand =
    kind === "next_js"
      ? [
          `npx create-next-app@latest '${escapePowerShellSingleQuoted(safeSlug)}'`,
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
      : `npx create-vite@latest --template react-ts --no-interactive '${escapePowerShellSingleQuoted(safeSlug)}'`;
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
