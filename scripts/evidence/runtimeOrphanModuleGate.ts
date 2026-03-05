/**
 * @fileoverview Enforces runtime-plan orphan-module gate by flagging `src/` modules referenced only by tests/evidence tooling unless explicitly deferred.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const PLAN_PATH = path.resolve(
  process.cwd(),
  "docs/maintenance/runtime_wiring_execution_plan.md"
);
const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/runtime_orphan_gate_report.json"
);
const COMMAND_NAME = "npm run test:runtime:orphan_gate";

const PRODUCTION_ENTRYPOINTS = new Set([
  "src/index.ts",
  "src/cli.ts",
  "src/interfaces/interfaceRuntime.ts",
  "src/interfaces/federationRuntime.ts"
]);

type GateMode = "baseline" | "touched";

interface OrphanModuleRecord {
  modulePath: string;
  productionReferenceCount: number;
  toolingReferenceCount: number;
  entrypoint: boolean;
  explicitDefer: boolean;
  status: "deferred" | "unresolved";
  productionRefExamples: readonly string[];
  toolingRefExamples: readonly string[];
}

interface RuntimeOrphanGateArtifact {
  generatedAt: string;
  command: string;
  mode: GateMode;
  scannedModules: number;
  explicitDeferRecords: readonly string[];
  orphanedModules: readonly OrphanModuleRecord[];
  unresolvedModules: readonly string[];
  passCriteria: {
    unresolvedModuleCount: number;
    overallPass: boolean;
  };
}

/**
 * Collects TypeScript files recursively under a directory.
 *
 * **Why it exists:**
 * The orphan gate needs a deterministic local file inventory without shell glob dependency.
 *
 * **What it talks to:**
 * - Node filesystem directory/stat APIs.
 *
 * @param rootDir - Directory root to recurse.
 * @returns Absolute TypeScript file paths.
 */
async function collectTsFiles(rootDir: string): Promise<string[]> {
  const output: string[] = [];
  const entries = await readdir(rootDir);
  for (const entry of entries) {
    const absolutePath = path.resolve(rootDir, entry);
    const fileStat = await stat(absolutePath);
    if (fileStat.isDirectory()) {
      output.push(...(await collectTsFiles(absolutePath)));
      continue;
    }
    if (absolutePath.endsWith(".ts")) {
      output.push(absolutePath);
    }
  }
  return output;
}

/**
 * Converts absolute filesystem paths into repository-relative POSIX style paths.
 *
 * **Why it exists:**
 * Artifact stability and defer-record matching rely on normalized path shape across platforms.
 *
 * **What it talks to:**
 * - Uses `path.relative` and separator normalization.
 *
 * @param absolutePath - Absolute path to normalize.
 * @returns Relative normalized path string.
 */
function toRepoRelativePath(absolutePath: string): string {
  return path.relative(process.cwd(), absolutePath).replace(/\\/g, "/");
}

/**
 * Evaluates whether a path belongs to `src/` runtime subject scope.
 *
 * **Why it exists:**
 * The gate targets runtime modules under `src/` and excludes `src/tools/` script surfaces.
 *
 * **What it talks to:**
 * - Local path-prefix checks only.
 *
 * @param repoRelativePath - Repo-relative file path.
 * @returns `true` when this file is a gate subject.
 */
function isSubjectRuntimeModule(repoRelativePath: string): boolean {
  return (
    repoRelativePath.startsWith("src/") &&
    !repoRelativePath.startsWith("src/tools/") &&
    repoRelativePath.endsWith(".ts")
  );
}

/**
 * Evaluates whether a file is a production-source importer for gate purposes.
 *
 * **Why it exists:**
 * Production references should come from runtime `src/` modules, not tests/evidence tooling.
 *
 * **What it talks to:**
 * - Local path-prefix checks only.
 *
 * @param repoRelativePath - Repo-relative file path.
 * @returns `true` when this file counts as a production importer.
 */
function isProductionImporter(repoRelativePath: string): boolean {
  return (
    repoRelativePath.startsWith("src/") &&
    !repoRelativePath.startsWith("src/tools/") &&
    repoRelativePath.endsWith(".ts")
  );
}

/**
 * Evaluates whether a file is a tooling importer for gate purposes.
 *
 * **Why it exists:**
 * Tooling references (tests/scripts/evidence/tools) should not count as production wiring.
 *
 * **What it talks to:**
 * - Local path-prefix checks only.
 *
 * @param repoRelativePath - Repo-relative file path.
 * @returns `true` when this file counts as tooling importer.
 */
function isToolingImporter(repoRelativePath: string): boolean {
  return (
    repoRelativePath.startsWith("tests/") ||
    repoRelativePath.startsWith("scripts/") ||
    repoRelativePath.startsWith("src/tools/")
  );
}

/**
 * Extracts static string import specifiers from TypeScript source text.
 *
 * **Why it exists:**
 * Reachability scan must include static `import`, dynamic `import("...")`, and `require("...")`.
 *
 * **What it talks to:**
 * - Local regex extraction only.
 *
 * @param sourceText - File content to scan.
 * @returns Collected module specifiers.
 */
function extractImportSpecifiers(sourceText: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(sourceText);
    while (match) {
      specifiers.push(match[1]);
      match = pattern.exec(sourceText);
    }
  }

  return specifiers;
}

/**
 * Resolves a relative import specifier into a TypeScript module path when possible.
 *
 * **Why it exists:**
 * Gate reachability requires linking importer -> imported source module paths deterministically.
 *
 * **What it talks to:**
 * - Uses filesystem existence checks for `.ts` and `/index.ts` resolution.
 *
 * @param importerAbsolutePath - Absolute path of importer file.
 * @param specifier - Import specifier captured from source.
 * @returns Resolved absolute module path or `null` when unresolved/non-relative.
 */
function resolveImportedTsModule(
  importerAbsolutePath: string,
  specifier: string
): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const base = path.resolve(path.dirname(importerAbsolutePath), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    path.join(base, "index.ts")
  ];

  for (const candidate of candidates) {
    if (!candidate.endsWith(".ts")) {
      continue;
    }
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Parses explicit `defer_explicitly` module records from runtime wiring plan.
 *
 * **Why it exists:**
 * Orphan gate should allow modules intentionally deferred with recorded rationale in the plan.
 *
 * **What it talks to:**
 * - Reads `docs/maintenance/runtime_wiring_execution_plan.md`.
 *
 * @returns Set of repo-relative module paths marked as `defer_explicitly`.
 */
async function loadExplicitDeferredModules(): Promise<Set<string>> {
  const markdown = await readFile(PLAN_PATH, "utf8");
  const deferred = new Set<string>();
  const regex = /`(src\/[^`]+\.ts)`\s*->\s*`defer_explicitly`/g;
  let match = regex.exec(markdown);
  while (match) {
    deferred.add(match[1].trim());
    match = regex.exec(markdown);
  }
  return deferred;
}

/**
 * Reads repository changed files and returns touched `src/` runtime modules.
 *
 * **Why it exists:**
 * Ongoing gate mode should evaluate only changed runtime modules.
 *
 * **What it talks to:**
 * - Uses `git status --porcelain` output.
 *
 * @returns Set of touched repo-relative runtime module paths.
 */
function loadTouchedRuntimeModulesFromGit(): Set<string> {
  const touched = new Set<string>();
  let output = "";
  try {
    output = execSync("git status --porcelain", {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return touched;
  }

  const lines = output.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  for (const line of lines) {
    const rawPath = line.length > 3 ? line.slice(3).trim() : "";
    if (!rawPath) {
      continue;
    }
    const resolvedPath = rawPath.includes(" -> ")
      ? rawPath.split(" -> ").pop()?.trim() ?? rawPath
      : rawPath;
    const normalized = resolvedPath.replace(/\\/g, "/");
    if (isSubjectRuntimeModule(normalized)) {
      touched.add(normalized);
    }
  }

  return touched;
}

/**
 * Parses gate mode from CLI args.
 *
 * **Why it exists:**
 * Supports baseline and touched modes with deterministic defaults.
 *
 * **What it talks to:**
 * - Reads process argv only.
 *
 * @param argv - Raw CLI args.
 * @returns Selected gate mode.
 */
function parseMode(argv: readonly string[]): GateMode {
  for (const token of argv) {
    const normalized = token.trim().toLowerCase();
    if (normalized === "--mode=touched" || normalized === "touched") {
      return "touched";
    }
  }
  return "baseline";
}

/**
 * Runs orphan-module gate and returns artifact payload.
 *
 * **Why it exists:**
 * Provides one deterministic orchestration path for reachability scan and defer matching.
 *
 * **What it talks to:**
 * - Reads source files across `src/`, `tests/`, and `scripts/`.
 * - Reads deferred module list from runtime wiring plan.
 *
 * @param mode - Gate mode (`baseline` or `touched`).
 * @returns Structured orphan gate artifact.
 */
async function runOrphanGate(mode: GateMode): Promise<RuntimeOrphanGateArtifact> {
  const deferredModules = await loadExplicitDeferredModules();

  const sourceFiles = await collectTsFiles(path.resolve(process.cwd(), "src"));
  const testFiles = await collectTsFiles(path.resolve(process.cwd(), "tests"));
  const scriptFiles = await collectTsFiles(path.resolve(process.cwd(), "scripts"));
  const allScanFiles = [...sourceFiles, ...testFiles, ...scriptFiles];

  const productionRefsByModule = new Map<string, Set<string>>();
  const toolingRefsByModule = new Map<string, Set<string>>();

  for (const importerAbsolutePath of allScanFiles) {
    const importerRelativePath = toRepoRelativePath(importerAbsolutePath);
    const sourceText = await readFile(importerAbsolutePath, "utf8");
    const specifiers = extractImportSpecifiers(sourceText);

    for (const specifier of specifiers) {
      const resolved = resolveImportedTsModule(importerAbsolutePath, specifier);
      if (!resolved) {
        continue;
      }
      const targetRelativePath = toRepoRelativePath(resolved);
      if (!isSubjectRuntimeModule(targetRelativePath)) {
        continue;
      }

      if (isProductionImporter(importerRelativePath)) {
        const refs = productionRefsByModule.get(targetRelativePath) ?? new Set<string>();
        refs.add(importerRelativePath);
        productionRefsByModule.set(targetRelativePath, refs);
        continue;
      }

      if (isToolingImporter(importerRelativePath)) {
        const refs = toolingRefsByModule.get(targetRelativePath) ?? new Set<string>();
        refs.add(importerRelativePath);
        toolingRefsByModule.set(targetRelativePath, refs);
      }
    }
  }

  const subjectRuntimeModules = sourceFiles
    .map(toRepoRelativePath)
    .filter((modulePath) => isSubjectRuntimeModule(modulePath))
    .sort((left, right) => left.localeCompare(right));
  const touchedRuntimeModules =
    mode === "touched" ? loadTouchedRuntimeModulesFromGit() : new Set<string>();

  const modulesToEvaluate = subjectRuntimeModules.filter((modulePath) => {
    if (mode === "baseline") {
      return true;
    }
    return touchedRuntimeModules.has(modulePath);
  });

  const orphanedModules: OrphanModuleRecord[] = [];
  const unresolvedModules: string[] = [];

  for (const modulePath of modulesToEvaluate) {
    const productionRefs = productionRefsByModule.get(modulePath) ?? new Set<string>();
    const toolingRefs = toolingRefsByModule.get(modulePath) ?? new Set<string>();
    const entrypoint = PRODUCTION_ENTRYPOINTS.has(modulePath);
    const referencedOnlyByTooling =
      !entrypoint && productionRefs.size === 0 && toolingRefs.size > 0;

    if (!referencedOnlyByTooling) {
      continue;
    }

    const explicitDefer = deferredModules.has(modulePath);
    const status: OrphanModuleRecord["status"] = explicitDefer ? "deferred" : "unresolved";
    if (!explicitDefer) {
      unresolvedModules.push(modulePath);
    }

    orphanedModules.push({
      modulePath,
      productionReferenceCount: productionRefs.size,
      toolingReferenceCount: toolingRefs.size,
      entrypoint,
      explicitDefer,
      status,
      productionRefExamples: [...productionRefs].sort().slice(0, 5),
      toolingRefExamples: [...toolingRefs].sort().slice(0, 5)
    });
  }

  orphanedModules.sort((left, right) => left.modulePath.localeCompare(right.modulePath));
  unresolvedModules.sort((left, right) => left.localeCompare(right));

  return {
    generatedAt: new Date().toISOString(),
    command: mode === "baseline"
      ? COMMAND_NAME
      : `${COMMAND_NAME}:touched`,
    mode,
    scannedModules: modulesToEvaluate.length,
    explicitDeferRecords: [...deferredModules].sort(),
    orphanedModules,
    unresolvedModules,
    passCriteria: {
      unresolvedModuleCount: unresolvedModules.length,
      overallPass: unresolvedModules.length === 0
    }
  };
}

/**
 * Executes script entrypoint and persists gate artifact.
 *
 * **Why it exists:**
 * Keeps top-level command behavior explicit for CI/manual gate execution.
 *
 * **What it talks to:**
 * - Writes artifact to `runtime/evidence/runtime_orphan_gate_report.json`.
 */
async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const artifact = await runOrphanGate(mode);

  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, JSON.stringify(artifact, null, 2), "utf8");

  console.log(`Runtime orphan-module gate artifact: ${ARTIFACT_PATH}`);
  console.log(
    `Mode: ${artifact.mode}; unresolved modules: ${artifact.passCriteria.unresolvedModuleCount}; status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`
  );

  if (!artifact.passCriteria.overallPass) {
    for (const unresolved of artifact.unresolvedModules) {
      console.error(`- unresolved orphan module: ${unresolved}`);
    }
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
