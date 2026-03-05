/**
 * @fileoverview Runs Stage 6.75 checkpoint 6.75.G secrets/egress validation and emits deterministic deny-path and redaction evidence artifact.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  evaluateStage675EgressPolicy,
  redactSensitiveEgressText
} from "../../src/core/stage6_75EgressPolicy";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_75_secret_egress_report.json"
);

interface Stage675CheckpointGArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.75.G";
  egress: {
    localhostBlocked: boolean;
    metadataBlocked: boolean;
    localDomainBlocked: boolean;
    publicTargetAllowed: boolean;
  };
  redaction: {
    redactionCount: number;
    redactionTypes: readonly string[];
    redactedSample: string;
  };
  passCriteria: {
    denyPathPass: boolean;
    redactionPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Implements `runStage675CheckpointG` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage675CheckpointG(): Promise<Stage675CheckpointGArtifact> {
  const localhostDecision = evaluateStage675EgressPolicy("http://localhost:3000");
  const metadataDecision = evaluateStage675EgressPolicy("http://169.254.169.254/latest/meta-data");
  const localDomainDecision = evaluateStage675EgressPolicy("https://internal.service.local/health");
  const publicDecision = evaluateStage675EgressPolicy("https://api.openai.com/v1/models");

  const redactionResult = redactSensitiveEgressText(
    "Authorization: Bearer secret_token_abc123 cookie: session=sensitive_value api_key=abcd1234EFGH5678"
  );

  const denyPathPass =
    !localhostDecision.ok &&
    !metadataDecision.ok &&
    !localDomainDecision.ok &&
    publicDecision.ok;
  const redactionPass =
    redactionResult.redactionCount >= 2 &&
    redactionResult.redactionTypes.length > 0 &&
    !/secret_token_abc123|sensitive_value|abcd1234EFGH5678/.test(redactionResult.redactedText);

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_75:secrets_egress",
    checkpointId: "6.75.G",
    egress: {
      localhostBlocked: !localhostDecision.ok,
      metadataBlocked: !metadataDecision.ok,
      localDomainBlocked: !localDomainDecision.ok,
      publicTargetAllowed: publicDecision.ok
    },
    redaction: {
      redactionCount: redactionResult.redactionCount,
      redactionTypes: redactionResult.redactionTypes,
      redactedSample: redactionResult.redactedText
    },
    passCriteria: {
      denyPathPass,
      redactionPass,
      overallPass: denyPathPass && redactionPass
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage675CheckpointG();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.75 checkpoint 6.75.G artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
