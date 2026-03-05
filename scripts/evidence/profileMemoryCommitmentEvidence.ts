/**
 * @fileoverview Emits deterministic evidence for profile-memory commitment signal classification and mutation-audit persistence.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  classifyCommitmentSignal,
  CommitmentSignalClassification,
  CommitmentSignalRulepackV1,
  createCommitmentSignalRuleContext
} from "../../src/core/commitmentSignalClassifier";
import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";

interface CommitmentSignalEvidenceSample {
  input: string;
  mode: "user_input" | "fact_value";
  result: CommitmentSignalClassification;
}

interface PersistedCommitmentAuditEvidence {
  key: string;
  value: string;
  mutationAudit: {
    matchedRuleId: string;
    rulepackVersion: string;
    confidenceTier: string;
    category: string;
    conflict: boolean;
  } | null;
}

interface ProfileCommitmentClassifierEvidenceArtifact {
  schemaVersion: 1;
  generatedAt: string;
  rulepackVersion: string;
  samples: CommitmentSignalEvidenceSample[];
  persistedMutationAudit: PersistedCommitmentAuditEvidence;
  passCriteria: {
    hasConflictFailClosedSample: boolean;
    hasPersistedMutationAuditMetadata: boolean;
  };
}

const EVIDENCE_OUTPUT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_x_profile_commitment_classifier_report.json"
);

/**
 * Implements `buildClassificationSamples` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildClassificationSamples(): CommitmentSignalEvidenceSample[] {
  const context = createCommitmentSignalRuleContext(null);
  return [
    {
      input: "my tax filing is complete",
      mode: "user_input",
      result: classifyCommitmentSignal("my tax filing is complete", {
        mode: "user_input",
        ruleContext: context
      })
    },
    {
      input: "I am all set and no longer need help",
      mode: "user_input",
      result: classifyCommitmentSignal("I am all set and no longer need help", {
        mode: "user_input",
        ruleContext: context
      })
    },
    {
      input: "my tax filing is complete but still pending",
      mode: "user_input",
      result: classifyCommitmentSignal("my tax filing is complete but still pending", {
        mode: "user_input",
        ruleContext: context
      })
    },
    {
      input: "resolved",
      mode: "fact_value",
      result: classifyCommitmentSignal("resolved", {
        mode: "fact_value",
        ruleContext: context
      })
    }
  ];
}

/**
 * Implements `capturePersistedMutationAuditEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function capturePersistedMutationAuditEvidence(): Promise<PersistedCommitmentAuditEvidence> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-commitment-evidence-"));
  const filePath = path.join(tempDir, "profile_memory.secure.json");
  const key = Buffer.alloc(32, 13);
  const store = new ProfileMemoryStore(filePath, key, 90);

  try {
    await store.ingestFromTaskInput(
      "task_profile_commitment_evidence_1",
      "my followup.tax filing is pending.",
      "2026-02-28T00:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_commitment_evidence_2",
      "my tax filing is complete",
      "2026-02-28T00:01:00.000Z"
    );

    const state = await store.load();
    const followupFact = state.facts
      .filter((fact) => fact.status !== "superseded")
      .find((fact) => fact.key === "followup.tax.filing");

    return {
      key: followupFact?.key ?? "missing",
      value: followupFact?.value ?? "missing",
      mutationAudit: followupFact?.mutationAudit
        ? {
          matchedRuleId: followupFact.mutationAudit.matchedRuleId,
          rulepackVersion: followupFact.mutationAudit.rulepackVersion,
          confidenceTier: followupFact.mutationAudit.confidenceTier,
          category: followupFact.mutationAudit.category,
          conflict: followupFact.mutationAudit.conflict
        }
        : null
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Implements `runProfileMemoryCommitmentEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runProfileMemoryCommitmentEvidence(): Promise<void> {
  const samples = buildClassificationSamples();
  const persistedMutationAudit = await capturePersistedMutationAuditEvidence();
  const artifact: ProfileCommitmentClassifierEvidenceArtifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rulepackVersion: CommitmentSignalRulepackV1.version,
    samples,
    persistedMutationAudit,
    passCriteria: {
      hasConflictFailClosedSample: samples.some(
        (sample) => sample.result.conflict && sample.result.category === "UNCLEAR"
      ),
      hasPersistedMutationAuditMetadata:
        persistedMutationAudit.mutationAudit !== null &&
        persistedMutationAudit.mutationAudit.rulepackVersion === CommitmentSignalRulepackV1.version
    }
  };

  await mkdir(path.dirname(EVIDENCE_OUTPUT_PATH), { recursive: true });
  await writeFile(EVIDENCE_OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`Profile commitment classifier artifact: ${EVIDENCE_OUTPUT_PATH}`);
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  await runProfileMemoryCommitmentEvidence();
}

if (require.main === module) {
  void main();
}
