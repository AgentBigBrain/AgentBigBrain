/**
 * @fileoverview Resolves the Codex CLI path and executes bounded Codex CLI commands.
 */

import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir } from "node:fs/promises";

import type { CodexCliInvocationResult } from "./contracts";
import { buildCodexProfileEnvironment } from "./profileState";

export interface RunCodexCliOptions {
  env?: NodeJS.ProcessEnv;
  stdinText?: string;
  timeoutMs?: number;
  cwd?: string;
  signal?: AbortSignal;
}

/**
 * Resolves the preferred home directory used for Codex state and binary lookup.
 *
 * @param env - Environment source for optional overrides.
 * @param platform - Runtime platform used for platform-specific env resolution.
 * @returns Absolute home directory path.
 */
function resolveCodexHomeDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string {
  const userProfile = env.USERPROFILE?.trim();
  const home = env.HOME?.trim();
  if (platform === "win32") {
    return userProfile || home || os.homedir();
  }
  return home || userProfile || os.homedir();
}

/**
 * Returns `true` when the candidate path points to an accessible executable file.
 *
 * @param candidatePath - Absolute path being checked.
 * @returns `true` when the file exists and is executable enough for the current host.
 */
function isExecutableCandidate(candidatePath: string): boolean {
  try {
    accessSync(candidatePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the preferred Codex CLI binary path for the current host.
 *
 * @param env - Environment source for optional overrides.
 * @returns Absolute CLI path when a sandbox-bin binary exists, otherwise `codex`.
 */
export function resolveCodexCliPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveCodexCliPathForPlatform(env, process.platform);
}

/**
 * Resolves the preferred Codex CLI binary path for a specific platform.
 *
 * @param env - Environment source for optional overrides.
 * @param platform - Platform used to select the preferred binary name.
 * @returns Absolute CLI path when a sandbox-bin binary exists, otherwise `codex`.
 */
export function resolveCodexCliPathForPlatform(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const configured = env.CODEX_CLI_PATH?.trim();
  if (configured) {
    return configured;
  }

  const home = resolveCodexHomeDir(env, platform);
  const candidate = platform === "win32"
    ? path.join(home, ".codex", ".sandbox-bin", "codex.exe")
    : path.join(home, ".codex", ".sandbox-bin", "codex");
  if (isExecutableCandidate(candidate)) {
    return candidate;
  }
  return "codex";
}

/**
 * Ensures the repo-owned Codex profile directories exist before invoking the Codex CLI.
 *
 * @param env - Effective child-process environment for the Codex invocation.
 */
export async function ensureCodexProfileDirectories(
  env: NodeJS.ProcessEnv
): Promise<void> {
  const authStateDir = env.CODEX_AUTH_STATE_DIR?.trim();
  const codexHome = env.CODEX_HOME?.trim();
  if (authStateDir) {
    await mkdir(authStateDir, { recursive: true });
  }
  if (codexHome) {
    await mkdir(codexHome, { recursive: true });
  }
}

/**
 * Executes one bounded Codex CLI command and returns captured stdio.
 *
 * @param args - CLI arguments to execute.
 * @param options - Runtime options including env, timeout, and optional stdin.
 * @returns Exit code plus captured stdout/stderr.
 */
export async function runCodexCliCommand(
  args: readonly string[],
  options: RunCodexCliOptions = {}
): Promise<CodexCliInvocationResult> {
  const env = buildCodexProfileEnvironment(options.env ?? process.env);
  await ensureCodexProfileDirectories(env);
  const cliPath = resolveCodexCliPath(env);
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 120_000);

  return await new Promise<CodexCliInvocationResult>((resolve, reject) => {
    const child = spawn(cliPath, [...args], {
      cwd: options.cwd,
      env,
      stdio: "pipe"
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = setTimeout(() => {
      timeoutHandle = null;
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error(`Codex CLI timed out after ${timeoutMs}ms.`));
      }
    }, timeoutMs);

    const cleanup = (): void => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    const rejectOnce = (error: Error): void => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    if (options.signal) {
      if (options.signal.aborted) {
        child.kill();
        rejectOnce(new Error("Codex CLI execution aborted."));
        return;
      }
      options.signal.addEventListener("abort", () => {
        child.kill();
        rejectOnce(new Error("Codex CLI execution aborted."));
      }, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      rejectOnce(new Error(`Failed to launch Codex CLI: ${error.message}`));
    });

    child.on("close", (code) => {
      cleanup();
      if (!settled) {
        settled = true;
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr
        });
      }
    });

    if (options.stdinText) {
      child.stdin.write(options.stdinText);
    }
    child.stdin.end();
  });
}
