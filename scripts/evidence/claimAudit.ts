/**
 * @fileoverview Runs deterministic capability-claim audits from a manifest and emits a machine-readable report.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  auditCapabilityClaimManifest,
  parseCapabilityClaimManifest
} from "./claimAuditCore";

interface ParsedArgs {
  manifestPath: string;
  reportPath: string;
}

const DEFAULT_MANIFEST_PATH = "docs/evidence/capability_claims.json";
const DEFAULT_REPORT_PATH = "runtime/evidence/claim_audit_report.json";

/**
 * Implements `parseArgs` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function parseArgs(rawArgs: readonly string[]): ParsedArgs {
  let manifestPath = DEFAULT_MANIFEST_PATH;
  let reportPath = DEFAULT_REPORT_PATH;

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    const nextValue = rawArgs[index + 1];
    if (arg === "--manifest" && typeof nextValue === "string" && nextValue.length > 0) {
      manifestPath = nextValue;
      index += 1;
      continue;
    }
    if (arg === "--report" && typeof nextValue === "string" && nextValue.length > 0) {
      reportPath = nextValue;
      index += 1;
    }
  }

  return {
    manifestPath,
    reportPath
  };
}

/**
 * Implements `toAscii` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function toAscii(value: string): string {
  return value.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?");
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const parsedArgs = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(process.cwd(), parsedArgs.manifestPath);
  const reportPath = path.resolve(process.cwd(), parsedArgs.reportPath);

  const rawManifest = await readFile(manifestPath, "utf8");
  const manifest = parseCapabilityClaimManifest(rawManifest);

  const report = await auditCapabilityClaimManifest(manifest, manifestPath);

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Claim audit manifest: ${parsedArgs.manifestPath}`);
  console.log(`Claim audit report: ${parsedArgs.reportPath}`);
  console.log(
    `Claim audit summary: ${report.totals.passedClaims}/${report.totals.totalClaims} passed`
  );

  if (!report.overallPass) {
    console.error("Claim audit failed:");
    for (const claim of report.claims) {
      if (claim.ok) {
        continue;
      }
      console.error(`- ${claim.claimId}`);
      for (const failure of claim.failures) {
        console.error(`  - ${toAscii(failure)}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  console.log("Claim audit passed.");
}

void main();
