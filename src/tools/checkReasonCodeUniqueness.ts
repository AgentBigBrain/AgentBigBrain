/**
 * @fileoverview Ensures exported reason-code constants remain unique across the runtime source tree.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface ReasonCodeOccurrence {
  filePath: string;
  constantName: string;
  value: string;
}

export interface DuplicateReasonCodeValue {
  value: string;
  occurrences: ReasonCodeOccurrence[];
}

export interface ReasonCodeUniquenessDiagnostics {
  scannedOccurrenceCount: number;
  duplicateValues: DuplicateReasonCodeValue[];
}

const EXPORTED_REASON_CODE_PATTERN =
  /export const\s+([A-Z0-9_]*REASON_CODE[A-Z0-9_]*)\s*=\s*(?:"([^"]+)"|'([^']+)')/gms;

/**
 * Computes reason-code uniqueness diagnostics from already-read source files.
 *
 * **Why it exists:**
 * Tests should be able to validate duplicate detection without building a full fake repository on
 * disk, and the CLI check should share that same evaluation logic.
 *
 * **What it talks to:**
 * - Uses local duplicate-detection helpers within this module.
 *
 * @param fileEntries - Relative path and source-text pairs to scan.
 * @returns Diagnostics describing duplicate exported reason-code values.
 */
export function computeReasonCodeUniquenessDiagnosticsFromEntries(
  fileEntries: readonly { filePath: string; contents: string }[]
): ReasonCodeUniquenessDiagnostics {
  const occurrences: ReasonCodeOccurrence[] = [];

  for (const entry of fileEntries) {
    for (const match of entry.contents.matchAll(EXPORTED_REASON_CODE_PATTERN)) {
      occurrences.push({
        filePath: entry.filePath,
        constantName: match[1],
        value: match[2] ?? match[3] ?? ""
      });
    }
  }

  return {
    scannedOccurrenceCount: occurrences.length,
    duplicateValues: findDuplicateReasonCodeValues(occurrences)
  };
}

/**
 * Computes reason-code uniqueness diagnostics for the repository rooted at `rootDir`.
 *
 * **Why it exists:**
 * Gives CI and local checks one stable contract for exported reason-code uniqueness instead of
 * relying on manual review to notice collisions.
 *
 * **What it talks to:**
 * - Uses `readFileSync` from `node:fs`.
 * - Uses local source-file discovery helpers within this module.
 *
 * @param rootDir - Repository root used to resolve source files.
 * @param relativeFilePaths - Optional file list override for focused tests.
 * @returns Diagnostics describing duplicate exported reason-code values.
 */
export function computeReasonCodeUniquenessDiagnostics(
  rootDir: string,
  relativeFilePaths?: readonly string[]
): ReasonCodeUniquenessDiagnostics {
  const files = relativeFilePaths ?? collectTypeScriptRelativePaths(path.join(rootDir, "src"), rootDir);
  const fileEntries = files.map((relativePath) => ({
    filePath: relativePath,
    contents: readFileSync(path.join(rootDir, relativePath), "utf8")
  }));
  return computeReasonCodeUniquenessDiagnosticsFromEntries(fileEntries);
}

/**
 * Fails closed when exported reason-code constants collide on the same value.
 *
 * **Why it exists:**
 * Duplicate reason codes undermine machine-readable diagnostics and make humanization mappings
 * ambiguous. This check keeps the reason-code namespace deterministic.
 *
 * **What it talks to:**
 * - Uses local diagnostics helpers within this module.
 *
 * @param rootDir - Repository root used to resolve source files.
 * @param relativeFilePaths - Optional file list override for focused tests.
 */
export function assertReasonCodeUniqueness(
  rootDir: string,
  relativeFilePaths?: readonly string[]
): void {
  const diagnostics = computeReasonCodeUniquenessDiagnostics(rootDir, relativeFilePaths);
  if (diagnostics.duplicateValues.length === 0) {
    return;
  }

  const lines = ["Duplicate exported reason-code values detected:"];
  for (const duplicate of diagnostics.duplicateValues) {
    lines.push(`- ${duplicate.value}`);
    for (const occurrence of duplicate.occurrences) {
      lines.push(`  - ${occurrence.constantName} @ ${occurrence.filePath}`);
    }
  }
  throw new Error(lines.join("\n"));
}

/**
 * Runs the reason-code uniqueness check entrypoint.
 *
 * **Why it exists:**
 * Makes the uniqueness contract runnable from package scripts and CI without duplicating
 * assertion logic.
 *
 * **What it talks to:**
 * - Uses `assertReasonCodeUniqueness` from this module.
 *
 * @returns Nothing. Success or failure is reported through process output and exit code.
 */
function main(): void {
  try {
    assertReasonCodeUniqueness(process.cwd());
    console.log("Reason-code uniqueness check passed.");
  } catch (error) {
    console.error("Reason-code uniqueness check failed:");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/**
 * Collects relative TypeScript file paths from the repository `src/` tree.
 *
 * **Why it exists:**
 * Keeps source discovery deterministic for reason-code scans and test overrides.
 *
 * **What it talks to:**
 * - Uses local directory traversal helpers within this module.
 *
 * @param srcRoot - Absolute `src/` root directory to scan.
 * @param rootDir - Repository root used for relative-path normalization.
 * @returns Sorted relative TypeScript file paths.
 */
function collectTypeScriptRelativePaths(srcRoot: string, rootDir: string): string[] {
  return walkDirectory(srcRoot)
    .map((absolutePath) => path.relative(rootDir, absolutePath).replace(/\\/g, "/"))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Recursively walks a directory and returns all `.ts` file paths.
 *
 * **Why it exists:**
 * Centralizes filesystem traversal so reason-code scans behave consistently.
 *
 * **What it talks to:**
 * - Uses `readdirSync` and `statSync` from `node:fs`.
 *
 * @param directoryPath - Absolute directory path to walk.
 * @returns Absolute `.ts` file paths discovered under the directory.
 */
function walkDirectory(directoryPath: string): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(directoryPath)) {
    const absolutePath = path.join(directoryPath, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      collected.push(...walkDirectory(absolutePath));
      continue;
    }
    if (absolutePath.endsWith(".ts")) {
      collected.push(absolutePath);
    }
  }
  return collected;
}

/**
 * Groups reason-code occurrences by value and returns only duplicates.
 *
 * **Why it exists:**
 * Duplicate detection should stay deterministic and reusable between tests and the CLI check.
 *
 * **What it talks to:**
 * - Uses local collection helpers within this module.
 *
 * @param occurrences - Reason-code occurrences collected from source files.
 * @returns Sorted duplicate-value entries with their occurrences.
 */
function findDuplicateReasonCodeValues(
  occurrences: readonly ReasonCodeOccurrence[]
): DuplicateReasonCodeValue[] {
  const grouped = new Map<string, ReasonCodeOccurrence[]>();

  for (const occurrence of occurrences) {
    const existing = grouped.get(occurrence.value);
    if (existing) {
      existing.push(occurrence);
      continue;
    }
    grouped.set(occurrence.value, [occurrence]);
  }

  return [...grouped.entries()]
    .filter(([, groupedOccurrences]) => groupedOccurrences.length > 1)
    .map(([value, groupedOccurrences]) => ({
      value,
      occurrences: groupedOccurrences.sort((left, right) =>
        `${left.filePath}:${left.constantName}`.localeCompare(`${right.filePath}:${right.constantName}`)
      )
    }))
    .sort((left, right) => left.value.localeCompare(right.value));
}

if (require.main === module) {
  main();
}
