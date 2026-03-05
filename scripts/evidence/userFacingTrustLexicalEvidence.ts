/**
 * @fileoverview Emits deterministic evidence for user-facing trust/overclaim lexical rendering decisions with rulepack fingerprinting.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  classifyTrustRenderDecision,
  createTrustLexicalRuleContext
} from "../../src/interfaces/trustLexicalClassifier";

interface TrustLexicalEvidenceSample {
  id: string;
  input: {
    text: string;
    hasApprovedRealShellExecution: boolean;
    hasApprovedRealNonRespondExecution: boolean;
    hasBlockedUnmatchedAction: boolean;
    hasApprovedSimulatedShellExecution: boolean;
    hasApprovedSimulatedNonRespondExecution: boolean;
  };
  classification: ReturnType<typeof classifyTrustRenderDecision>;
}

interface UserFacingTrustLexicalEvidenceArtifact {
  schemaVersion: 1;
  generatedAt: string;
  rulepackVersion: string;
  rulepackFingerprint: string;
  samples: TrustLexicalEvidenceSample[];
}

const EVIDENCE_OUTPUT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/user_facing_trust_lexical_sample.json"
);

/**
 * Implements `buildEvidenceSamples` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildEvidenceSamples(): TrustLexicalEvidenceSample[] {
  const context = createTrustLexicalRuleContext(null);
  const inputs: TrustLexicalEvidenceSample["input"][] = [
    {
      text: "I opened your browser and navigated to example.com.",
      hasApprovedRealShellExecution: false,
      hasApprovedRealNonRespondExecution: false,
      hasBlockedUnmatchedAction: false,
      hasApprovedSimulatedShellExecution: false,
      hasApprovedSimulatedNonRespondExecution: false
    },
    {
      text: "I opened your browser and navigated to example.com.",
      hasApprovedRealShellExecution: false,
      hasApprovedRealNonRespondExecution: false,
      hasBlockedUnmatchedAction: false,
      hasApprovedSimulatedShellExecution: true,
      hasApprovedSimulatedNonRespondExecution: false
    },
    {
      text: "Working on it.",
      hasApprovedRealShellExecution: false,
      hasApprovedRealNonRespondExecution: false,
      hasBlockedUnmatchedAction: true,
      hasApprovedSimulatedShellExecution: false,
      hasApprovedSimulatedNonRespondExecution: false
    }
  ];

  return inputs.map((input, index) => ({
    id: `trust_sample_${index + 1}`,
    input,
    classification: classifyTrustRenderDecision(input, context)
  }));
}

/**
 * Implements `buildArtifact` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildArtifact(): UserFacingTrustLexicalEvidenceArtifact {
  const context = createTrustLexicalRuleContext(null);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rulepackVersion: context.rulepackVersion,
    rulepackFingerprint: context.rulepackFingerprint,
    samples: buildEvidenceSamples()
  };
}

/**
 * Implements `runUserFacingTrustLexicalEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runUserFacingTrustLexicalEvidence(): Promise<void> {
  const artifact = buildArtifact();
  await mkdir(path.dirname(EVIDENCE_OUTPUT_PATH), { recursive: true });
  await writeFile(EVIDENCE_OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`User-facing trust lexical artifact: ${EVIDENCE_OUTPUT_PATH}`);
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  await runUserFacingTrustLexicalEvidence();
}

if (require.main === module) {
  void main();
}
