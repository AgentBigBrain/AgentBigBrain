/**
 * @fileoverview Verifies that the AI-first file-classification map fully covers the current TypeScript source inventory under `src/`.
 */

import { readdirSync } from "node:fs";
import path from "node:path";

import {
  FileClassificationMap,
  loadFileClassificationMap
} from "./exportAiArchitectureIndex";

export interface FileClassificationCoverageDiagnostics {
  sourceCount: number;
  classifiedCount: number;
  duplicatePaths: string[];
  missingPaths: string[];
  extraPaths: string[];
  invalidThinEntrypoints: string[];
  invalidMoveOrSplitEntries: string[];
}

/**
 * Collects all current TypeScript source files under `src/`.
 *
 * **Why it exists:**
 * Gives the coverage check one deterministic inventory of the live source tree instead of relying
 * on shell-specific globbing.
 *
 * **What it talks to:**
 * - Uses `readdirSync` (import `readdirSync`) from `node:fs`.
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param currentDir - Directory being scanned recursively.
 * @param rootDir - Repository root used to emit normalized relative paths.
 * @returns Sorted relative TypeScript source paths with forward slashes.
 */
function collectSourceTypeScriptFiles(currentDir: string, rootDir: string): string[] {
  const discovered: string[] = [];

  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      discovered.push(...collectSourceTypeScriptFiles(absolutePath, rootDir));
      continue;
    }

    if (!absolutePath.endsWith(".ts")) {
      continue;
    }

    discovered.push(path.relative(rootDir, absolutePath).replace(/\\/g, "/"));
  }

  return discovered.sort((left, right) => left.localeCompare(right));
}

/**
 * Flattens all classified source-file paths from the map.
 *
 * **Why it exists:**
 * Keeps bucket flattening centralized so duplicate, missing, and extra-path checks stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param map - File-classification artifact under validation.
 * @returns Flattened list of all classified source-file paths.
 */
function collectClassifiedPaths(map: FileClassificationMap): string[] {
  return [
    ...map.entries.becomes_thin_entrypoint.map((entry) => entry.path),
    ...map.entries.moves_or_splits.map((entry) => entry.path),
    ...map.entries.stays_in_place,
    ...map.entries.explicitly_out_of_scope
  ];
}

/**
 * Finds duplicate paths within the classified inventory.
 *
 * **Why it exists:**
 * Fails closed when one source file is assigned to multiple buckets, which would make the map
 * ambiguous for later migration work.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param classifiedPaths - Flattened classified paths from the file-classification map.
 * @returns Sorted duplicate source-file paths.
 */
function findDuplicatePaths(classifiedPaths: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const classifiedPath of classifiedPaths) {
    counts.set(classifiedPath, (counts.get(classifiedPath) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([classifiedPath]) => classifiedPath)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Validates thin-entrypoint metadata for required planning fields.
 *
 * **Why it exists:**
 * Prevents the classification map from degenerating into unlabeled placeholders that do not help
 * future migration work.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param map - File-classification artifact under validation.
 * @returns Human-readable error strings for invalid thin-entrypoint records.
 */
function validateThinEntrypoints(map: FileClassificationMap): string[] {
  const failures: string[] = [];

  for (const entry of map.entries.becomes_thin_entrypoint) {
    if (entry.target_paths.length === 0) {
      failures.push(`${entry.path}: missing target_paths`);
    }
    if (entry.phase <= 0 || !Number.isInteger(entry.phase)) {
      failures.push(`${entry.path}: invalid phase`);
    }
    if (entry.reason.trim().length === 0) {
      failures.push(`${entry.path}: missing reason`);
    }
  }

  return failures.sort((left, right) => left.localeCompare(right));
}

/**
 * Validates move-or-split metadata for required planning fields.
 *
 * **Why it exists:**
 * Makes sure decomposed-file records carry enough intent to guide future refactors safely.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param map - File-classification artifact under validation.
 * @returns Human-readable error strings for invalid move-or-split records.
 */
function validateMoveOrSplitEntries(map: FileClassificationMap): string[] {
  const failures: string[] = [];

  for (const entry of map.entries.moves_or_splits) {
    if (entry.target_paths.length === 0) {
      failures.push(`${entry.path}: missing target_paths`);
    }
    if (entry.phase <= 0 || !Number.isInteger(entry.phase)) {
      failures.push(`${entry.path}: invalid phase`);
    }
    if (entry.reason.trim().length === 0) {
      failures.push(`${entry.path}: missing reason`);
    }
  }

  return failures.sort((left, right) => left.localeCompare(right));
}

/**
 * Computes classification-coverage diagnostics for the repository.
 *
 * **Why it exists:**
 * Centralizes coverage math so tests and CLI checks report the same missing, duplicate, and extra
 * paths.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 * - Uses `loadFileClassificationMap` (import `loadFileClassificationMap`) from `./exportAiArchitectureIndex`.
 * - Uses local constants/helpers within this module.
 *
 * @param rootDir - Repository root used to resolve `src/` and the classification artifact.
 * @returns Diagnostics describing whether the classification map fully covers the source tree.
 */
export function computeFileClassificationCoverageDiagnostics(
  rootDir: string
): FileClassificationCoverageDiagnostics {
  const map = loadFileClassificationMap(rootDir);
  const sourceFiles = collectSourceTypeScriptFiles(path.join(rootDir, "src"), rootDir);
  const classifiedPaths = collectClassifiedPaths(map);
  const classifiedSet = new Set(classifiedPaths);
  const sourceSet = new Set(sourceFiles);

  return {
    sourceCount: sourceFiles.length,
    classifiedCount: classifiedPaths.length,
    duplicatePaths: findDuplicatePaths(classifiedPaths),
    missingPaths: sourceFiles.filter((sourcePath) => !classifiedSet.has(sourcePath)),
    extraPaths: classifiedPaths.filter((classifiedPath) => !sourceSet.has(classifiedPath)),
    invalidThinEntrypoints: validateThinEntrypoints(map),
    invalidMoveOrSplitEntries: validateMoveOrSplitEntries(map)
  };
}

/**
 * Fails closed when the file-classification map does not fully cover the current source tree.
 *
 * **Why it exists:**
 * Gives the plan a deterministic contract: no source file can quietly fall out of the migration map.
 *
 * **What it talks to:**
 * - Uses `loadFileClassificationMap` (import `loadFileClassificationMap`) from `./exportAiArchitectureIndex`.
 * - Uses local constants/helpers within this module.
 *
 * @param rootDir - Repository root used to resolve `src/` and the classification artifact.
 */
export function assertFileClassificationCoverage(rootDir: string): void {
  const diagnostics = computeFileClassificationCoverageDiagnostics(rootDir);
  const map = loadFileClassificationMap(rootDir);
  const failures: string[] = [];

  if (map.source_file_count !== diagnostics.sourceCount) {
    failures.push(
      `source_file_count mismatch: map=${map.source_file_count} actual=${diagnostics.sourceCount}`
    );
  }

  if (diagnostics.duplicatePaths.length > 0) {
    failures.push(
      [
        "Duplicate classified source paths found:",
        ...diagnostics.duplicatePaths.map((classifiedPath) => `- ${classifiedPath}`)
      ].join("\n")
    );
  }

  if (diagnostics.missingPaths.length > 0) {
    failures.push(
      [
        "Missing classified source paths:",
        ...diagnostics.missingPaths.map((missingPath) => `- ${missingPath}`)
      ].join("\n")
    );
  }

  if (diagnostics.extraPaths.length > 0) {
    failures.push(
      [
        "Extra classified paths not present in src/:",
        ...diagnostics.extraPaths.map((extraPath) => `- ${extraPath}`)
      ].join("\n")
    );
  }

  if (diagnostics.invalidThinEntrypoints.length > 0) {
    failures.push(
      [
        "Invalid thin-entrypoint records:",
        ...diagnostics.invalidThinEntrypoints.map((failure) => `- ${failure}`)
      ].join("\n")
    );
  }

  if (diagnostics.invalidMoveOrSplitEntries.length > 0) {
    failures.push(
      [
        "Invalid move-or-split records:",
        ...diagnostics.invalidMoveOrSplitEntries.map((failure) => `- ${failure}`)
      ].join("\n")
    );
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n\n"));
  }
}

/**
 * Runs the file-classification coverage check entrypoint.
 *
 * **Why it exists:**
 * Makes the coverage contract runnable from the command line without duplicating diagnostics.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @returns Nothing. Success or failure is reported through process output and exit code.
 */
function main(): void {
  try {
    assertFileClassificationCoverage(process.cwd());
    console.log("AI file-classification coverage check passed.");
  } catch (error) {
    console.error("AI file-classification coverage check failed:");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
