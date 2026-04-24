/**
 * @fileoverview Opens the projected Obsidian dashboard or a specific mirrored note by exact path URI.
 */

import { spawn } from "node:child_process";

import { ensureEnvLoaded } from "../core/envLoader";
import { createProjectionRuntimeConfigFromEnv } from "../core/projections/config";
import {
  buildObsidianDashboardPath,
  buildObsidianOpenPathUri
} from "../core/projections/targets/obsidianOpenHelpers";

interface ParsedOpenArgs {
  targetPath: string | null;
}

export interface OpenObsidianProjectionResult {
  openedPath: string;
  uri: string;
}

/**
 * Parses the optional target-path argument for the open command.
 *
 * **Why it exists:**
 * The operator helper only needs one small CLI surface, and parsing it once keeps the open logic
 * focused on URI generation instead of raw `process.argv` handling.
 *
 * **What it talks to:**
 * - Uses local normalization rules within this module.
 *
 * @param rawArgs - Raw CLI arguments after the script name.
 * @returns Parsed open-command arguments.
 */
function parseOpenArgs(rawArgs: readonly string[]): ParsedOpenArgs {
  const targetPath = rawArgs.find((value) => value.trim().length > 0) ?? null;
  return {
    targetPath
  };
}

/**
 * Builds the platform-specific spawn command used to open an Obsidian URI.
 *
 * **Why it exists:**
 * The helper must work on Windows, macOS, and Linux, and isolating the launch command keeps that
 * platform branching out of the higher-level open helper.
 *
 * **What it talks to:**
 * - Uses local platform rules within this module.
 *
 * @param uri - Exact `obsidian://open?path=...` URI to launch.
 * @param platform - Target platform, defaulting to the current process platform.
 * @returns Executable plus args needed to open the URI.
 */
export function buildObsidianOpenCommand(
  uri: string,
  platform: NodeJS.Platform = process.platform
): { command: string; args: readonly string[] } {
  if (platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "start", "", uri]
    };
  }
  if (platform === "darwin") {
    return {
      command: "open",
      args: [uri]
    };
  }
  return {
    command: "xdg-open",
    args: [uri]
  };
}

/**
 * Opens the Obsidian dashboard or a specific mirrored note through an exact-path URI.
 *
 * **Why it exists:**
 * Operators should be able to jump directly from runtime tooling into the mirror without fuzzy
 * filename lookup or manual vault navigation.
 *
 * **What it talks to:**
 * - Uses projection config helpers from `../core/projections/config`.
 * - Uses Obsidian URI helpers from `../core/projections/targets/obsidianOpenHelpers`.
 * - Uses `spawn` (import `spawn`) from `node:child_process`.
 *
 * @param targetPath - Optional absolute note path to open instead of the dashboard.
 * @param env - Environment map carrying projection configuration.
 * @returns Opened path plus the exact Obsidian URI used.
 */
export async function openObsidianProjection(
  targetPath: string | null = null,
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenObsidianProjectionResult> {
  const projectionConfig = createProjectionRuntimeConfigFromEnv(env);
  if (!projectionConfig.obsidian.enabled) {
    throw new Error(
      "Obsidian projection is not enabled. Set BRAIN_PROJECTION_SINKS to include obsidian and configure BRAIN_OBSIDIAN_VAULT_PATH."
    );
  }

  const openedPath = targetPath ?? buildObsidianDashboardPath(
    projectionConfig.obsidian.vaultPath,
    projectionConfig.obsidian.rootDirectoryName
  );
  const uri = buildObsidianOpenPathUri(openedPath);
  const command = buildObsidianOpenCommand(uri);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, [...command.args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

  return {
    openedPath,
    uri
  };
}

/**
 * Runs the Obsidian open helper from the terminal entrypoint.
 *
 * **Why it exists:**
 * Repo tooling needs a thin CLI wrapper so operators can open the mirror without retyping the URI
 * logic or dashboard path resolution by hand.
 *
 * **What it talks to:**
 * - Uses `openObsidianProjection(...)` and `parseOpenArgs(...)` in this module.
 *
 * @returns Promise resolving after the open command has been launched.
 */
async function main(): Promise<void> {
  ensureEnvLoaded();
  const args = parseOpenArgs(process.argv.slice(2));
  const result = await openObsidianProjection(args.targetPath, process.env);
  console.log(`Opened Obsidian projection: ${result.openedPath}`);
}

if (require.main === module) {
  void main();
}
