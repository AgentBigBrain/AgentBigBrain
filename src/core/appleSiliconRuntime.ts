/**
 * @fileoverview Detects Apple Silicon or Rosetta runtime mismatches that break native Node add-ons.
 */

import { spawnSync } from "node:child_process";

export interface AppleSiliconNodeMismatch {
  platform: "darwin";
  nodeArch: "x64";
  machineArch: "arm64";
}

/**
 * Detects whether a Darwin runtime is using x64 Node on Apple Silicon hardware.
 *
 * **Why it exists:**
 * Keeps Rosetta mismatch detection deterministic and reusable so startup warnings stay
 * consistent across setup scripts and runtime initialization.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param platform - Platform string to evaluate.
 * @param nodeArch - Active Node architecture for the running process.
 * @param machineArch - Underlying machine architecture if known.
 * @returns Structured mismatch details when Apple Silicon hardware is paired with x64 Node.
 */
export function detectAppleSiliconNodeMismatchFromValues(
  platform: NodeJS.Platform,
  nodeArch: string,
  machineArch: string | null
): AppleSiliconNodeMismatch | null {
  if (platform !== "darwin" || nodeArch !== "x64" || machineArch !== "arm64") {
    return null;
  }
  return {
    platform,
    nodeArch: "x64",
    machineArch: "arm64"
  };
}

/**
 * Reads the host machine architecture for the current process.
 *
 * **Why it exists:**
 * Separates shell probing from mismatch evaluation so the main decision logic can stay pure and testable.
 *
 * **What it talks to:**
 * - Uses `spawnSync` (import `spawnSync`) from `node:child_process`.
 * - Uses local constants/helpers within this module.
 *
 * @returns The trimmed machine architecture string, or `null` if probing fails.
 */
export function readCurrentMachineArchitecture(): string | null {
  const result = spawnSync("uname", ["-m"], {
    encoding: "utf8"
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const machineArch = result.stdout.trim();
  return machineArch.length > 0 ? machineArch : null;
}

/**
 * Detects the live Apple Silicon or Rosetta mismatch for the current Node process.
 *
 * **Why it exists:**
 * Gives runtime code a single authoritative probe for native add-on mismatch warnings.
 *
 * **What it talks to:**
 * - Uses `detectAppleSiliconNodeMismatchFromValues` from this module.
 * - Uses `readCurrentMachineArchitecture` from this module.
 *
 * @returns Structured mismatch details when the current process is running x64 Node on Apple Silicon hardware.
 */
export function detectCurrentAppleSiliconNodeMismatch(): AppleSiliconNodeMismatch | null {
  return detectAppleSiliconNodeMismatchFromValues(
    process.platform,
    process.arch,
    readCurrentMachineArchitecture()
  );
}

/**
 * Builds a stable user-facing explanation for Apple Silicon or Rosetta mismatch failures.
 *
 * **Why it exists:**
 * Centralizes the remediation text so setup and runtime surfaces do not drift or give conflicting advice.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param dependencyName - Native dependency affected by the mismatch.
 * @returns Human-readable remediation guidance.
 */
export function buildAppleSiliconNodeMismatchMessage(dependencyName: string): string {
  return (
    `Apple Silicon machine detected, but Node is running as darwin/x64 under Rosetta. ` +
    `${dependencyName} resolves native bindings by Node architecture, so this process will look for darwin/x64 binaries. ` +
    `Use a native arm64 Node install on the M-series Mac, remove node_modules, run npm install again from that arm64 shell, ` +
    `or temporarily set BRAIN_ENABLE_EMBEDDINGS=false to run without local embeddings.`
  );
}
