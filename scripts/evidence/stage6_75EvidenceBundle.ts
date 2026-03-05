/**
 * @fileoverview Runs Stage 6.75 checkpoint 6.75.H evidence-bundle export validation and emits deterministic artifact/redaction summary report.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_75_evidence_bundle_report.json"
);

const REQUIRED_ARTIFACTS = [
  "runtime/evidence/stage6_75_quarantine_report.json",
  "runtime/evidence/stage6_75_mission_replay_report.json",
  "runtime/evidence/stage6_75_build_pipeline_report.json",
  "runtime/evidence/stage6_75_connector_report.json",
  "runtime/evidence/stage6_75_consistency_report.json",
  "runtime/evidence/stage6_75_diff_approval_report.json",
  "runtime/evidence/stage6_75_secret_egress_report.json",
  "runtime/evidence/stage6_75_rollback_report.json"
] as const;

interface Stage675CheckpointHArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.75.H";
  bundle: {
    requiredArtifactCount: number;
    foundArtifactCount: number;
    missingArtifacts: readonly string[];
    bundleHash: string;
  };
  redactionReport: {
    redactionCount: number;
    redactionTypes: readonly string[];
  };
  passCriteria: {
    artifactCompletenessPass: boolean;
    redactionSummaryPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Implements `sha256Hex` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function sha256Hex(value: string): string {
  return require("node:crypto").createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Implements `runStage675CheckpointH` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage675CheckpointH(): Promise<Stage675CheckpointHArtifact> {
  const foundArtifacts: string[] = [];
  const missingArtifacts: string[] = [];
  let redactionCount = 0;
  const redactionTypes = new Set<string>();
  const sensitivePatterns: readonly { type: string; pattern: RegExp }[] = [
    {
      type: "bearer_token",
      pattern: /Bearer\s+[A-Za-z0-9._-]{8,}/g
    },
    {
      type: "api_key",
      pattern: /(api[_-]?key|token|secret)\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}/gi
    }
  ];

  for (const relativeArtifactPath of REQUIRED_ARTIFACTS) {
    const absolutePath = path.resolve(process.cwd(), relativeArtifactPath);
    try {
      const content = await readFile(absolutePath, "utf8");
      foundArtifacts.push(relativeArtifactPath);
      for (const { type, pattern } of sensitivePatterns) {
        const matches = content.match(pattern) ?? [];
        if (matches.length > 0) {
          redactionCount += matches.length;
          redactionTypes.add(type);
        }
      }
    } catch {
      missingArtifacts.push(relativeArtifactPath);
    }
  }

  const bundleHash = sha256Hex(JSON.stringify(foundArtifacts.sort((left, right) => left.localeCompare(right))));
  const artifactCompletenessPass = missingArtifacts.length === 0;
  const redactionSummaryPass = redactionCount === 0;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_75:evidence_bundle",
    checkpointId: "6.75.H",
    bundle: {
      requiredArtifactCount: REQUIRED_ARTIFACTS.length,
      foundArtifactCount: foundArtifacts.length,
      missingArtifacts,
      bundleHash
    },
    redactionReport: {
      redactionCount,
      redactionTypes: [...redactionTypes].sort((left, right) => left.localeCompare(right))
    },
    passCriteria: {
      artifactCompletenessPass,
      redactionSummaryPass,
      overallPass: artifactCompletenessPass && redactionSummaryPass
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage675CheckpointH();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.75 checkpoint 6.75.H artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
