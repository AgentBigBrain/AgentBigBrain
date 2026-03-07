/**
 * @fileoverview Generates the AI architecture index from machine-readable change-surface and file-classification artifacts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface AiChangeSurface {
  id: string;
  title: string;
  phase_target: string;
  refactor_wave: "current" | "future";
  summary: string;
  current_surface_files: string[];
  contract_files: string[];
  planned_target_files: string[];
  verification_files: string[];
  doc_files: string[];
  validation_commands: string[];
}

export interface AiChangeSurfaceCatalog {
  schema_version: number;
  description: string;
  surfaces: AiChangeSurface[];
}

export interface ThinEntrypointClassification {
  path: string;
  target_paths: string[];
  phase: number;
  reason: string;
}

export interface MoveOrSplitClassification {
  path: string;
  target_paths: string[];
  phase: number;
  reason: string;
}

export interface FileClassificationMap {
  schema_version: number;
  source_root: string;
  source_file_count: number;
  bucket_semantics: {
    stays_in_place: string;
    becomes_thin_entrypoint: string;
    moves_or_splits: string;
    explicitly_out_of_scope: string;
  };
  entries: {
    stays_in_place: string[];
    explicitly_out_of_scope: string[];
    becomes_thin_entrypoint: ThinEntrypointClassification[];
    moves_or_splits: MoveOrSplitClassification[];
  };
}

export interface ClassificationCounts {
  becomes_thin_entrypoint: number;
  moves_or_splits: number;
  stays_in_place: number;
  explicitly_out_of_scope: number;
}

const CHANGE_SURFACES_RELATIVE_PATH = "docs/ai/change-surfaces.json";
const FILE_CLASSIFICATION_RELATIVE_PATH = "docs/ai/file-classification-map.json";
const ARCHITECTURE_INDEX_RELATIVE_PATH = "docs/ai/architecture-index.md";

/**
 * Normalizes line endings to a deterministic newline format.
 *
 * **Why it exists:**
 * Keeps generated artifact comparisons stable across Windows and non-Windows environments.
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
 * Reads and parses a JSON artifact from disk.
 *
 * **Why it exists:**
 * Centralizes JSON loading so the generator and sync checks consume artifacts the same way.
 *
 * **What it talks to:**
 * - Uses `readFileSync` (import `readFileSync`) from `node:fs`.
 *
 * @param filePath - Absolute path to the JSON file.
 * @returns Parsed JSON value typed to the caller's expectation.
 */
function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

/**
 * Loads the AI change-surface catalog for the current repository root.
 *
 * **Why it exists:**
 * Gives all AI-maintainability tooling one authoritative way to resolve the machine-readable
 * surface catalog.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 * - Uses local constants/helpers within this module.
 *
 * @param rootDir - Repository root used to resolve artifact paths.
 * @returns Parsed AI change-surface catalog.
 */
export function loadAiChangeSurfaces(rootDir: string): AiChangeSurfaceCatalog {
  return readJsonFile<AiChangeSurfaceCatalog>(path.join(rootDir, CHANGE_SURFACES_RELATIVE_PATH));
}

/**
 * Loads the file-classification map for the current repository root.
 *
 * **Why it exists:**
 * Keeps all maintainability tooling aligned on the same file inventory and bucket semantics.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 * - Uses local constants/helpers within this module.
 *
 * @param rootDir - Repository root used to resolve artifact paths.
 * @returns Parsed file-classification map.
 */
export function loadFileClassificationMap(rootDir: string): FileClassificationMap {
  return readJsonFile<FileClassificationMap>(path.join(rootDir, FILE_CLASSIFICATION_RELATIVE_PATH));
}

/**
 * Computes stable bucket counts from the file-classification map.
 *
 * **Why it exists:**
 * Keeps coverage summaries deterministic and prevents each renderer from recomputing counts ad hoc.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param map - File-classification artifact used for counting buckets.
 * @returns Deterministic counts for each classification bucket.
 */
export function computeClassificationCounts(map: FileClassificationMap): ClassificationCounts {
  return {
    becomes_thin_entrypoint: map.entries.becomes_thin_entrypoint.length,
    moves_or_splits: map.entries.moves_or_splits.length,
    stays_in_place: map.entries.stays_in_place.length,
    explicitly_out_of_scope: map.entries.explicitly_out_of_scope.length
  };
}

/**
 * Renders a sorted bullet list for Markdown output.
 *
 * **Why it exists:**
 * Prevents duplicated list-formatting logic and keeps generated sections ordered consistently.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param items - Values that should become Markdown bullets.
 * @param emptyLabel - Fallback text used when the list is empty.
 * @returns Markdown list text for the supplied values.
 */
function renderMarkdownList(items: readonly string[], emptyLabel: string): string {
  if (items.length === 0) {
    return `- ${emptyLabel}`;
  }

  return [...items]
    .sort((left, right) => left.localeCompare(right))
    .map((item) => `- \`${item}\``)
    .join("\n");
}

/**
 * Renders one change-surface section for the architecture index.
 *
 * **Why it exists:**
 * Keeps per-surface formatting local so later index changes do not require rewriting the whole
 * generator.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param surface - Machine-readable surface definition to render.
 * @returns Markdown section for one change surface.
 */
function renderSurfaceSection(surface: AiChangeSurface): string {
  return [
    `### ${surface.title} (\`${surface.id}\`)`,
    "",
    `- Phase target: \`${surface.phase_target}\``,
    `- Refactor wave: \`${surface.refactor_wave}\``,
    "",
    surface.summary,
    "",
    "Current surface files:",
    renderMarkdownList(surface.current_surface_files, "No current surface files recorded."),
    "",
    "Contract files:",
    renderMarkdownList(surface.contract_files, "No contract files recorded."),
    "",
    "Planned target files:",
    renderMarkdownList(surface.planned_target_files, "No planned target files recorded yet."),
    "",
    "Verification files:",
    renderMarkdownList(surface.verification_files, "No verification files recorded."),
    "",
    "Docs:",
    renderMarkdownList(surface.doc_files, "No docs recorded."),
    "",
    "Validation commands:",
    renderMarkdownList(surface.validation_commands, "No validation commands recorded.")
  ].join("\n");
}

/**
 * Renders the full AI architecture index from the source artifacts.
 *
 * **Why it exists:**
 * Provides one canonical Markdown renderer so generated docs and sync checks never diverge.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param catalog - Machine-readable change-surface catalog.
 * @param map - File-classification artifact used for the coverage summary.
 * @returns Fully rendered Markdown architecture index with deterministic ordering.
 */
export function renderAiArchitectureIndex(
  catalog: AiChangeSurfaceCatalog,
  map: FileClassificationMap
): string {
  const counts = computeClassificationCounts(map);
  const orderedSurfaces = [...catalog.surfaces].sort((left, right) => left.id.localeCompare(right.id));
  const sections = orderedSurfaces.map((surface) => renderSurfaceSection(surface));

  return normalizeLineEndings(
    [
      "# AgentBigBrain AI Architecture Index",
      "",
      "This file is generated from `docs/ai/change-surfaces.json` and",
      "`docs/ai/file-classification-map.json` by `src/tools/exportAiArchitectureIndex.ts`.",
      "Edit the JSON sources and regenerate this file; do not hand-edit it.",
      "",
      "## Coverage Snapshot",
      "",
      `- Total classified source files: \`${map.source_file_count}\``,
      `- \`becomes_thin_entrypoint\`: \`${counts.becomes_thin_entrypoint}\``,
      `- \`moves_or_splits\`: \`${counts.moves_or_splits}\``,
      `- \`stays_in_place\`: \`${counts.stays_in_place}\``,
      `- \`explicitly_out_of_scope\`: \`${counts.explicitly_out_of_scope}\``,
      "",
      "## Change Surfaces",
      "",
      ...sections.flatMap((section) => [section, ""])
    ].join("\n").trimEnd() + "\n"
  );
}

/**
 * Writes the generated architecture index to the repository docs folder.
 *
 * **Why it exists:**
 * Gives contributors one deterministic command for regenerating the AI architecture reference.
 *
 * **What it talks to:**
 * - Uses `writeFileSync` (import `writeFileSync`) from `node:fs`.
 * - Uses `path` (import `default`) from `node:path`.
 * - Uses local constants/helpers within this module.
 *
 * @param rootDir - Repository root used to resolve artifact paths.
 * @returns Generated Markdown content written to disk.
 */
export function writeAiArchitectureIndex(rootDir: string): string {
  const catalog = loadAiChangeSurfaces(rootDir);
  const map = loadFileClassificationMap(rootDir);
  const rendered = renderAiArchitectureIndex(catalog, map);
  const outputPath = path.join(rootDir, ARCHITECTURE_INDEX_RELATIVE_PATH);
  writeFileSync(outputPath, rendered, "utf8");
  return rendered;
}

/**
 * Runs the architecture-index export entrypoint.
 *
 * **Why it exists:**
 * Keeps the CLI execution path explicit and reusable for sync checks and tests.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @returns Nothing. Side effects are written to disk and logged to stdout.
 */
function main(): void {
  const rendered = writeAiArchitectureIndex(process.cwd());
  console.log(
    `AI architecture index updated at ${ARCHITECTURE_INDEX_RELATIVE_PATH} (${rendered.length} bytes).`
  );
}

if (require.main === module) {
  main();
}
