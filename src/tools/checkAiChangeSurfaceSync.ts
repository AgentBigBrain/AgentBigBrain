/**
 * @fileoverview Verifies that AI maintainability artifacts stay synchronized with their generated and referenced sources.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  AiChangeSurfaceCatalog,
  loadAiChangeSurfaces,
  loadFileClassificationMap,
  renderAiArchitectureIndex
} from "./exportAiArchitectureIndex";

export interface AiChangeSurfaceSyncDiagnostics {
  duplicateSurfaceIds: string[];
  missingReferencedPaths: string[];
  architectureIndexMatches: boolean;
}

const ARCHITECTURE_INDEX_RELATIVE_PATH = "docs/ai/architecture-index.md";

/**
 * Normalizes line endings so sync checks behave the same across platforms.
 *
 * **Why it exists:**
 * Prevents Windows newline style from creating false-positive sync failures.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Text content that may contain mixed newline styles.
 * @returns Text normalized to `\n` line endings.
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Collects the current-repo paths that must already exist for the change-surface catalog.
 *
 * **Why it exists:**
 * Separates "must exist now" references from planned target files that intentionally do not exist
 * yet.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param catalog - Change-surface catalog whose current references should be validated.
 * @returns Sorted unique relative paths that should exist now.
 */
function collectReferencedPaths(catalog: AiChangeSurfaceCatalog): string[] {
  const references = new Set<string>();

  for (const surface of catalog.surfaces) {
    for (const reference of [
      ...surface.current_surface_files,
      ...surface.contract_files,
      ...surface.verification_files,
      ...surface.doc_files
    ]) {
      references.add(reference);
    }
  }

  return [...references].sort((left, right) => left.localeCompare(right));
}

/**
 * Finds duplicate surface identifiers in the machine-readable catalog.
 *
 * **Why it exists:**
 * Enforces stable surface IDs so downstream tooling has one unambiguous key per change surface.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param catalog - Change-surface catalog under validation.
 * @returns Sorted list of duplicate surface IDs.
 */
function findDuplicateSurfaceIds(catalog: AiChangeSurfaceCatalog): string[] {
  const counts = new Map<string, number>();
  for (const surface of catalog.surfaces) {
    counts.set(surface.id, (counts.get(surface.id) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Finds referenced paths that are missing from the repository.
 *
 * **Why it exists:**
 * Keeps the change-surface map honest by failing when it points at files that do not exist.
 *
 * **What it talks to:**
 * - Uses `existsSync` (import `existsSync`) from `node:fs`.
 * - Uses `path` (import `default`) from `node:path`.
 * - Uses local constants/helpers within this module.
 *
 * @param rootDir - Repository root used to resolve relative paths.
 * @param references - Relative paths that should already exist.
 * @returns Sorted list of missing relative paths.
 */
function findMissingReferencedPaths(rootDir: string, references: readonly string[]): string[] {
  return references.filter((reference) => !existsSync(path.join(rootDir, reference)));
}

/**
 * Computes sync diagnostics for the AI maintainability artifacts.
 *
 * **Why it exists:**
 * Centralizes sync logic so tests, the CLI check, and future tooling report the same failures.
 *
 * **What it talks to:**
 * - Uses `readFileSync` (import `readFileSync`) from `node:fs`.
 * - Uses `path` (import `default`) from `node:path`.
 * - Uses `loadAiChangeSurfaces` (import `loadAiChangeSurfaces`) from `./exportAiArchitectureIndex`.
 * - Uses `loadFileClassificationMap` (import `loadFileClassificationMap`) from `./exportAiArchitectureIndex`.
 * - Uses `renderAiArchitectureIndex` (import `renderAiArchitectureIndex`) from `./exportAiArchitectureIndex`.
 *
 * @param rootDir - Repository root used to resolve AI artifact paths.
 * @returns Diagnostics describing whether the artifacts are in sync.
 */
export function computeAiChangeSurfaceSyncDiagnostics(rootDir: string): AiChangeSurfaceSyncDiagnostics {
  const catalog = loadAiChangeSurfaces(rootDir);
  const map = loadFileClassificationMap(rootDir);
  const expectedIndex = renderAiArchitectureIndex(catalog, map);
  const actualIndex = normalizeLineEndings(
    readFileSync(path.join(rootDir, ARCHITECTURE_INDEX_RELATIVE_PATH), "utf8")
  );

  return {
    duplicateSurfaceIds: findDuplicateSurfaceIds(catalog),
    missingReferencedPaths: findMissingReferencedPaths(rootDir, collectReferencedPaths(catalog)),
    architectureIndexMatches: actualIndex === expectedIndex
  };
}

/**
 * Fails closed when the AI change-surface artifacts are out of sync.
 *
 * **Why it exists:**
 * Provides one strict contract for CI, tests, and local checks instead of spreading sync policy
 * across callers.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param rootDir - Repository root used to resolve AI artifact paths.
 */
export function assertAiChangeSurfaceSync(rootDir: string): void {
  const diagnostics = computeAiChangeSurfaceSyncDiagnostics(rootDir);
  const failures: string[] = [];

  if (diagnostics.duplicateSurfaceIds.length > 0) {
    failures.push(
      [
        "Duplicate AI change-surface IDs found:",
        ...diagnostics.duplicateSurfaceIds.map((surfaceId) => `- ${surfaceId}`)
      ].join("\n")
    );
  }

  if (diagnostics.missingReferencedPaths.length > 0) {
    failures.push(
      [
        "Missing AI change-surface references:",
        ...diagnostics.missingReferencedPaths.map((reference) => `- ${reference}`)
      ].join("\n")
    );
  }

  if (!diagnostics.architectureIndexMatches) {
    failures.push(
      [
        "docs/ai/architecture-index.md is out of sync with the JSON source artifacts.",
        "Run `tsx src/tools/exportAiArchitectureIndex.ts` to regenerate it."
      ].join("\n")
    );
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n\n"));
  }
}

/**
 * Runs the change-surface sync check entrypoint.
 *
 * **Why it exists:**
 * Makes the sync contract runnable from the command line without duplicating diagnostic logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @returns Nothing. Success or failure is reported through process output and exit code.
 */
function main(): void {
  try {
    assertAiChangeSurfaceSync(process.cwd());
    console.log("AI change-surface sync check passed.");
  } catch (error) {
    console.error("AI change-surface sync check failed:");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
