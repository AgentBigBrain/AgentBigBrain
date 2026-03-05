/**
 * @fileoverview Generates deterministic governor drift/disagreement telemetry from governance memory events.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildGovernorDriftAudit,
  GovernorDriftAuditOptions
} from "../../src/core/governorDriftAudit";
import { GovernanceMemoryEvent } from "../../src/core/types";

interface CliOptions extends GovernorDriftAuditOptions {
  inputPath: string;
  outputPath: string;
}

interface GovernanceMemoryFile {
  events?: GovernanceMemoryEvent[];
}

/**
 * Implements `stripUtf8Bom` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function stripUtf8Bom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

/**
 * Implements `parseIntegerFlag` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function parseIntegerFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.floor(parsed);
}

/**
 * Implements `parseNumberFlag` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function parseNumberFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Implements `parseArgs` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function parseArgs(argv: readonly string[]): CliOptions {
  const defaults: CliOptions = {
    inputPath: path.resolve(process.cwd(), "runtime/governance_memory.json"),
    outputPath: path.resolve(
      process.cwd(),
      "runtime/evidence/stage6_5_governor_drift_audit.json"
    )
  };

  const options: CliOptions = { ...defaults };
  for (const arg of argv) {
    if (arg.startsWith("--input=")) {
      options.inputPath = path.resolve(process.cwd(), arg.slice("--input=".length));
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.outputPath = path.resolve(process.cwd(), arg.slice("--output=".length));
      continue;
    }
    if (arg.startsWith("--window=")) {
      options.windowSize = parseIntegerFlag(arg.slice("--window=".length));
      continue;
    }
    if (arg.startsWith("--trend-window=")) {
      options.trendWindowSize = parseIntegerFlag(arg.slice("--trend-window=".length));
      continue;
    }
    if (arg.startsWith("--drift-threshold=")) {
      options.driftThreshold = parseNumberFlag(arg.slice("--drift-threshold=".length));
      continue;
    }
    if (arg.startsWith("--min-trend-samples=")) {
      options.minTrendSamples = parseIntegerFlag(arg.slice("--min-trend-samples=".length));
    }
  }

  return options;
}

/**
 * Implements `readGovernanceEvents` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function readGovernanceEvents(inputPath: string): Promise<GovernanceMemoryEvent[]> {
  const raw = await readFile(inputPath, "utf8");
  const parsed = JSON.parse(stripUtf8Bom(raw)) as GovernanceMemoryFile;
  if (!Array.isArray(parsed.events)) {
    return [];
  }
  return parsed.events;
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const events = await readGovernanceEvents(options.inputPath);
  const report = buildGovernorDriftAudit(events, options);

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, JSON.stringify(report, null, 2), "utf8");

  console.log(`Governor drift audit generated: ${options.outputPath}`);
  console.log(`Source events: ${report.sourceEventCount}`);
  console.log(`Vote events analyzed: ${report.voteEventCount}`);
  console.log(`Disagreement rate: ${report.disagreementRate}`);
  console.log(
    `Flagged governors: ${report.flaggedGovernors.length > 0 ? report.flaggedGovernors.join(", ") : "none"}`
  );
}

void main();

