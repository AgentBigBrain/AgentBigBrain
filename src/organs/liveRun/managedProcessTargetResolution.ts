/**
 * @fileoverview Resolves trusted loopback targets for generic managed-process start commands.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { ManagedProcessLoopbackTargetHint, inferManagedProcessLoopbackTarget } from "./contracts";

const PACKAGE_JSON_FILENAME = "package.json";
const VITE_CONFIG_FILENAMES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs"
] as const;

interface PackageJsonScripts {
  scripts?: Record<string, unknown>;
}

type WorkspaceServerMode = "dev" | "preview";

/**
 * Determines whether one file exists and is readable.
 *
 * @param candidatePath - Filesystem path to inspect.
 * @returns `true` when the path is readable.
 */
async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await readFile(candidatePath, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads package scripts from one workspace root when available.
 *
 * @param cwd - Workspace root to inspect.
 * @returns Parsed package scripts, or `null` when unavailable.
 */
async function readPackageJsonScripts(cwd: string): Promise<Record<string, string> | null> {
  const packageJsonPath = path.join(cwd, PACKAGE_JSON_FILENAME);
  try {
    const packageJsonText = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(packageJsonText) as PackageJsonScripts;
    if (!parsed.scripts || typeof parsed.scripts !== "object") {
      return null;
    }
    const scripts = Object.fromEntries(
      Object.entries(parsed.scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
    return Object.keys(scripts).length > 0 ? scripts : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the workspace-native server mode from a trusted start command.
 *
 * @param command - Managed-process command text.
 * @returns `dev`, `preview`, or `null` when the command is not one supported workspace-native server form.
 */
function resolveWorkspaceServerMode(command: string): WorkspaceServerMode | null {
  const normalized = command.trim().toLowerCase();
  if (
    /\b(?:npm|pnpm|bun)\s+run\s+dev\b/.test(normalized) ||
    /\byarn\s+dev\b/.test(normalized) ||
    /\bvite\s+dev\b/.test(normalized)
  ) {
    return "dev";
  }
  if (
    /\b(?:npm|pnpm|bun)\s+run\s+preview\b/.test(normalized) ||
    /\byarn\s+preview\b/.test(normalized) ||
    /\bvite\s+preview\b/.test(normalized)
  ) {
    return "preview";
  }
  return null;
}

/**
 * Resolves one invoked package script name from a trusted start command.
 *
 * @param command - Managed-process command text.
 * @returns Invoked script name, or `null`.
 */
function resolveInvokedPackageScriptName(command: string): string | null {
  const normalized = command.trim().toLowerCase();
  const npmLikeMatch = normalized.match(/\b(?:npm|pnpm|bun)\s+run\s+([a-z0-9:_-]+)\b/);
  if (npmLikeMatch?.[1]) {
    return npmLikeMatch[1];
  }
  const yarnMatch = normalized.match(/\byarn\s+([a-z0-9:_-]+)\b/);
  if (yarnMatch?.[1] && yarnMatch[1] !== "run") {
    return yarnMatch[1];
  }
  return null;
}

/**
 * Extracts one loopback host from trusted Vite config text.
 *
 * @param configText - Raw Vite config file text.
 * @param mode - Workspace server mode to inspect.
 * @returns Loopback host when explicit and safe, `localhost` when implicit, otherwise `null`.
 */
function extractViteLoopbackHost(
  configText: string,
  mode: WorkspaceServerMode
): string | null {
  const sectionName = mode === "dev" ? "server" : "preview";
  const modeBlockMatch = configText.match(
    new RegExp(`${sectionName}\\s*:\\s*\\{([\\s\\S]*?)\\}`, "i")
  );
  const modeBlock = modeBlockMatch?.[1] ?? "";
  const hostMatch = modeBlock.match(
    /\bhost\s*:\s*(?:"(localhost|127\.0\.0\.1|::1)"|'(localhost|127\.0\.0\.1|::1)')/i
  );
  const explicitHost = hostMatch?.[1] ?? hostMatch?.[2] ?? null;
  if (explicitHost) {
    return explicitHost.toLowerCase();
  }
  if (/\bhost\s*:\s*true\b/i.test(modeBlock)) {
    return null;
  }
  return "localhost";
}

/**
 * Extracts one loopback port from trusted Vite config text.
 *
 * @param configText - Raw Vite config file text.
 * @param mode - Workspace server mode to inspect.
 * @returns Explicit port when present, otherwise `null`.
 */
function extractViteLoopbackPort(
  configText: string,
  mode: WorkspaceServerMode
): number | null {
  const sectionName = mode === "dev" ? "server" : "preview";
  const modeBlockMatch = configText.match(
    new RegExp(`${sectionName}\\s*:\\s*\\{([\\s\\S]*?)\\}`, "i")
  );
  const modeBlock = modeBlockMatch?.[1] ?? "";
  const portMatch = modeBlock.match(/\bport\s*:\s*(\d{2,5})\b/i);
  if (!portMatch?.[1]) {
    return null;
  }
  const port = Number.parseInt(portMatch[1], 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  return port;
}

/**
 * Builds a canonical loopback target hint.
 *
 * @param host - Loopback host.
 * @param port - Loopback port.
 * @returns Canonical loopback target hint.
 */
function buildLoopbackTarget(host: string, port: number): ManagedProcessLoopbackTargetHint {
  return {
    host,
    port,
    url: `http://${host === "::1" ? "[::1]" : host}:${port}`
  };
}

/**
 * Resolves a trusted loopback target for generic workspace-native start commands.
 *
 * **Why it exists:**
 * `start_process` can legitimately use generic commands such as `npm run dev`. When the workspace
 * config pins a concrete localhost port, the runtime should preserve that typed target instead of
 * letting later live-proof steps drift to planner defaults.
 *
 * @param command - Managed-process command text.
 * @param cwd - Workspace root for config inspection.
 * @returns Trusted loopback target hint, or `null` when none can be derived safely.
 */
export async function resolveManagedProcessLoopbackTarget(
  command: string,
  cwd: string
): Promise<ManagedProcessLoopbackTargetHint | null> {
  const explicitTarget = inferManagedProcessLoopbackTarget(command);
  if (explicitTarget) {
    return explicitTarget;
  }

  const scripts = await readPackageJsonScripts(cwd);
  const invokedScriptName = resolveInvokedPackageScriptName(command);
  const invokedScriptBody =
    invokedScriptName && scripts ? scripts[invokedScriptName] ?? null : null;
  if (typeof invokedScriptBody === "string") {
    const scriptTarget = inferManagedProcessLoopbackTarget(invokedScriptBody);
    if (scriptTarget) {
      return scriptTarget;
    }
  }

  const workspaceServerMode = resolveWorkspaceServerMode(command);
  if (!workspaceServerMode) {
    return null;
  }

  for (const viteConfigFilename of VITE_CONFIG_FILENAMES) {
    const viteConfigPath = path.join(cwd, viteConfigFilename);
    if (!(await pathExists(viteConfigPath))) {
      continue;
    }
    try {
      const viteConfigText = await readFile(viteConfigPath, "utf8");
      const port = extractViteLoopbackPort(viteConfigText, workspaceServerMode);
      const host = extractViteLoopbackHost(viteConfigText, workspaceServerMode);
      if (port === null || host === null) {
        continue;
      }
      return buildLoopbackTarget(host, port);
    } catch {
      continue;
    }
  }

  return null;
}
