/**
 * @fileoverview Ergonomic test runner for canonical target groups with optional watch/coverage modes.
 */

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { listTestTargetIds, TEST_TARGETS } from "./testTargets";

interface ParsedRunnerArgs {
  targetId: string;
  watch: boolean;
  coverage: boolean;
  passThroughArgs: string[];
}

/**
 * Implements `parseRunnerArgs` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function parseRunnerArgs(rawArgs: readonly string[]): ParsedRunnerArgs {
  let targetId = "all";
  let watch = false;
  let coverage = false;
  let hasExplicitTarget = false;
  const passThroughArgs: string[] = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--") {
      passThroughArgs.push(...rawArgs.slice(index + 1));
      break;
    }
    if (arg === "--watch") {
      watch = true;
      continue;
    }
    if (arg === "--coverage") {
      coverage = true;
      continue;
    }
    if (!hasExplicitTarget && !arg.startsWith("--")) {
      targetId = arg;
      hasExplicitTarget = true;
      continue;
    }
    passThroughArgs.push(arg);
  }

  return {
    targetId,
    watch,
    coverage,
    passThroughArgs
  };
}

/**
 * Implements `renderTargetList` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function renderTargetList(): string {
  const lines = listTestTargetIds().map((targetId) => {
    const target = TEST_TARGETS[targetId];
    return `- ${target.id}: ${target.description}`;
  });
  return ["Available test targets:", ...lines].join("\n");
}

/**
 * Implements `prepareCoverageOutput` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function prepareCoverageOutput(coverageDir: string): Promise<void> {
  await rm(coverageDir, { recursive: true, force: true });
  await mkdir(coverageDir, { recursive: true });
}

/**
 * Implements `runTsxTests` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function runTsxTests(args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const tsxCliPath = require.resolve("tsx/cli");
    const child = spawn(process.execPath, [tsxCliPath, ...args], {
      cwd: process.cwd(),
      env,
      stdio: "inherit"
    });

    child.once("error", (error) => {
      reject(error);
    });
    child.once("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const parsed = parseRunnerArgs(process.argv.slice(2));
  if (parsed.targetId === "list") {
    console.log(renderTargetList());
    return;
  }

  const target = TEST_TARGETS[parsed.targetId];
  if (!target) {
    console.error(`Unknown test target: ${parsed.targetId}`);
    console.error(renderTargetList());
    process.exitCode = 1;
    return;
  }

  const tsxArgs: string[] = ["--test"];
  if (parsed.watch) {
    tsxArgs.push("--watch");
  }
  tsxArgs.push(...target.patterns, ...parsed.passThroughArgs);

  const env: NodeJS.ProcessEnv = {
    ...process.env
  };
  if (parsed.coverage) {
    const coverageDir = path.resolve(process.cwd(), "runtime/evidence/test_coverage");
    await prepareCoverageOutput(coverageDir);
    env.NODE_V8_COVERAGE = coverageDir;
  }

  const exitCode = await runTsxTests(tsxArgs, env);
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

void main();
