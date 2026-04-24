/**
 * @fileoverview Parses projection runtime configuration for Obsidian and other external mirror sinks.
 */

import path from "node:path";

import type { ProjectionMode } from "./contracts";

export interface ObsidianProjectionTargetConfig {
  enabled: boolean;
  vaultPath: string;
  rootDirectoryName: string;
  mirrorAssets: boolean;
}

export interface JsonMirrorTargetConfig {
  enabled: boolean;
  outputPath: string;
}

export interface ProjectionRuntimeConfig {
  enabled: boolean;
  realtime: boolean;
  mode: ProjectionMode;
  sinkIds: readonly string[];
  obsidian: ObsidianProjectionTargetConfig;
  jsonMirror: JsonMirrorTargetConfig;
}

/**
 * Parses the projection runtime mode from env text.
 *
 * **Why it exists:**
 * Redaction behavior affects filenames, asset copying, and note rendering, so the mode must be
 * resolved once at startup instead of being guessed by each sink independently.
 *
 * **What it talks to:**
 * - Uses local normalization rules within this module.
 *
 * @param value - Raw environment variable value.
 * @returns Canonical projection mode.
 */
function parseProjectionMode(value: string | undefined): ProjectionMode {
  return value?.trim().toLowerCase() === "operator_full"
    ? "operator_full"
    : "review_safe";
}

/**
 * Parses a comma-separated sink-id list from env text.
 *
 * **Why it exists:**
 * Projection targets need a deterministic enablement surface so the runtime can swap sinks without
 * introducing target-specific environment parsing throughout the core boot path.
 *
 * **What it talks to:**
 * - Uses local normalization rules within this module.
 *
 * @param value - Raw environment variable value.
 * @returns Ordered unique sink ids.
 */
function parseProjectionSinkIds(value: string | undefined): readonly string[] {
  if (!value || value.trim().length === 0) {
    return [];
  }
  return [...new Set(
    value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
  )];
}

/**
 * Parses a permissive boolean flag from env text.
 *
 * **Why it exists:**
 * Runtime feature flags appear in several textual forms, and projection enablement should not
 * depend on one exact spelling when operators set environment variables.
 *
 * **What it talks to:**
 * - Uses local normalization rules within this module.
 *
 * @param value - Raw environment variable value.
 * @returns `true` when the value is one accepted enabled literal.
 */
function parseEnabledFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Builds the canonical projection runtime config from environment variables.
 *
 * **Why it exists:**
 * The shared runtime needs one central parser for sink enablement, mirror mode, and Obsidian path
 * ownership so later projection code can depend on typed config instead of raw env strings.
 *
 * **What it talks to:**
 * - Uses `path.resolve` (import `default`) from `node:path`.
 * - Uses local env parsing helpers within this module.
 *
 * @param env - Environment source used for projection config resolution.
 * @returns Canonical projection runtime config.
 */
export function createProjectionRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ProjectionRuntimeConfig {
  const sinkIds = parseProjectionSinkIds(env.BRAIN_PROJECTION_SINKS);
  const obsidianEnabled = sinkIds.includes("obsidian") && typeof env.BRAIN_OBSIDIAN_VAULT_PATH === "string";
  const jsonMirrorEnabled = sinkIds.includes("json");

  return {
    enabled: sinkIds.length > 0,
    realtime: parseEnabledFlag(env.BRAIN_PROJECTION_REALTIME ?? "true"),
    mode: parseProjectionMode(env.BRAIN_PROJECTION_MODE),
    sinkIds,
    obsidian: {
      enabled: obsidianEnabled,
      vaultPath: path.resolve(env.BRAIN_OBSIDIAN_VAULT_PATH?.trim() || path.resolve(process.cwd(), "runtime/obsidian_vault")),
      rootDirectoryName: env.BRAIN_OBSIDIAN_ROOT_DIR?.trim() || "AgentBigBrain",
      mirrorAssets: parseEnabledFlag(env.BRAIN_OBSIDIAN_MIRROR_ASSETS ?? "true")
    },
    jsonMirror: {
      enabled: jsonMirrorEnabled,
      outputPath: path.resolve(env.BRAIN_JSON_MIRROR_PATH?.trim() || path.resolve(process.cwd(), "runtime/projections/json_mirror.json"))
    }
  };
}
