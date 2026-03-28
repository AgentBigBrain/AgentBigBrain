/**
 * @fileoverview Stages oversized shell commands into temp scripts so execution avoids platform argv limits.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildShellSpawnSpec } from "../../core/shellRuntimeProfile";
import type { ShellRuntimeProfileV1 } from "../../core/types";

export interface StagedShellCommand {
  spawnSpec: ReturnType<typeof buildShellSpawnSpec>;
  cleanup: (() => Promise<void>) | null;
}

interface StagedShellScript {
  scriptPath: string;
  cleanup: () => Promise<void>;
}

/**
 * Builds the effective shell spawn spec, staging oversized commands through a temp script file
 * when inline invocation would exceed deterministic shell limits.
 *
 * **Why it exists:**
 * Windows can reject oversized inline shell arguments with `ENAMETOOLONG` before execution. This
 * preserves bounded shell execution without depending on platform command-line length.
 *
 * **What it talks to:**
 * - Uses `buildShellSpawnSpec` from `../../core/shellRuntimeProfile`.
 * - Uses `mkdtemp`, `rm`, and `writeFile` from `node:fs/promises`.
 * - Uses `os` and `path` from Node core.
 *
 * @param profile - Effective shell profile selected for execution.
 * @param command - Normalized shell command text.
 * @param cwd - Resolved working directory for the shell action.
 * @param timeoutMs - Resolved timeout for the shell action.
 * @param envKeyNames - Effective environment key names exposed to the shell.
 * @returns Spawn spec plus optional cleanup callback.
 */
export async function buildEffectiveShellSpawnSpec(
  profile: ShellRuntimeProfileV1,
  command: string,
  cwd: string,
  timeoutMs: number,
  envKeyNames: readonly string[]
): Promise<StagedShellCommand> {
  if (command.length <= profile.commandMaxChars) {
    return {
      spawnSpec: buildShellSpawnSpec({
        profile,
        command,
        cwd,
        timeoutMs,
        envKeyNames
      }),
      cleanup: null
    };
  }

  const stagedScript = await stageShellCommandScript(profile.shellKind, command);
  return {
    spawnSpec: {
      executable: profile.executable,
      args: buildStagedShellArgs(profile.shellKind, profile.wrapperArgs, stagedScript.scriptPath),
      cwd,
      timeoutMs,
      envMode: profile.envPolicy.mode,
      envKeyNames: [...envKeyNames]
    },
    cleanup: stagedScript.cleanup
  };
}

/**
 * Stages a shell command into a temp script file for long-command execution.
 *
 * **Why it exists:**
 * Keeps long-command fallback isolated and cleanup-friendly so callers do not need to manage temp
 * script lifecycle manually.
 *
 * **What it talks to:**
 * - Uses `mkdtemp`, `rm`, and `writeFile` from `node:fs/promises`.
 * - Uses `os` and `path` from Node core.
 *
 * @param shellKind - Stable identifier used to reference an entity or record.
 * @param command - Raw shell command requested by the planner/runtime.
 * @returns Promise resolving to staged script metadata.
 */
async function stageShellCommandScript(
  shellKind: ShellRuntimeProfileV1["shellKind"],
  command: string
): Promise<StagedShellScript> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-shell-command-"));
  const scriptPath = path.join(tempDir, `command${resolveShellScriptExtension(shellKind)}`);
  await writeFile(scriptPath, command, "utf8");
  return {
    scriptPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

/**
 * Builds wrapper args for a staged shell script execution.
 *
 * **Why it exists:**
 * Long-command script staging needs stable invocation semantics per shell kind instead of reusing
 * inline `-Command` or `-lc` wrappers verbatim.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param shellKind - Stable identifier used to reference an entity or record.
 * @param wrapperArgs - Ordered collection produced by this step.
 * @param scriptPath - Filesystem location used by this operation.
 * @returns Ordered collection produced by this step.
 */
function buildStagedShellArgs(
  shellKind: ShellRuntimeProfileV1["shellKind"],
  wrapperArgs: readonly string[],
  scriptPath: string
): readonly string[] {
  switch (shellKind) {
    case "powershell":
    case "pwsh": {
      const baseArgs = wrapperArgs.filter((entry) => entry.toLowerCase() !== "-command");
      return [...baseArgs, "-File", scriptPath];
    }
    case "cmd":
      return ["/d", "/c", scriptPath];
    case "bash":
    case "zsh":
      return [scriptPath];
    case "wsl_bash":
      return [...wrapperArgs, scriptPath];
    default:
      return [...wrapperArgs, scriptPath];
  }
}

/**
 * Resolves the script-file extension used for staged long shell commands.
 *
 * **Why it exists:**
 * Each shell family expects predictable file extensions for script execution on the target host.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param shellKind - Stable identifier used to reference an entity or record.
 * @returns Resulting string value.
 */
function resolveShellScriptExtension(shellKind: ShellRuntimeProfileV1["shellKind"]): string {
  switch (shellKind) {
    case "powershell":
    case "pwsh":
      return ".ps1";
    case "cmd":
      return ".cmd";
    case "bash":
    case "zsh":
    case "wsl_bash":
      return ".sh";
    default:
      return ".txt";
  }
}
