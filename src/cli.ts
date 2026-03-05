#!/usr/bin/env node

/**
 * @fileoverview Legacy CLI shim that forwards to the canonical `src/index.ts` runtime entrypoint.
 */

import { runCliFromArgv } from "./index";

/**
 * Runs the legacy CLI shim with forwarded argv.
 *
 * **Why it exists:**
 * Gives tests and legacy entrypoints one explicit forwarding surface.
 *
 * **What it talks to:**
 * - `runCliFromArgv` in `src/index.ts`.
 *
 * @param rawArgs - CLI args excluding node/script paths.
 * @returns Process exit code from canonical CLI runtime.
 */
export async function runLegacyCliFromArgv(rawArgs: readonly string[]): Promise<number> {
  return runCliFromArgv(rawArgs);
}

/**
 * Executes the legacy CLI shim process.
 *
 * **Why it exists:**
 * Preserves backward compatibility for existing `dist/cli.js` invocations while keeping
 * `src/index.ts` as the authoritative CLI contract.
 *
 * **What it talks to:**
 * - `runLegacyCliFromArgv`.
 */
async function main(): Promise<void> {
  process.exitCode = await runLegacyCliFromArgv(process.argv.slice(2));
}

if (require.main === module) {
  void main();
}
