/**
 * @fileoverview Emits a deterministic sample artifact for follow-up and proposal-reply classification evidence.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  classifyFollowUp,
  classifyProposalReply,
  createFollowUpRuleContext
} from "../../src/interfaces/followUpClassifier";

interface FollowUpClassificationSample {
  input: string;
  hasPriorAssistantQuestion: boolean;
  result: ReturnType<typeof classifyFollowUp>;
}

interface ProposalReplyClassificationSample {
  input: string;
  hasActiveProposal: boolean;
  result: ReturnType<typeof classifyProposalReply>;
}

interface FollowUpClassifierEvidenceArtifact {
  schemaVersion: 1;
  generatedAt: string;
  rulepackVersion: string;
  overrideFingerprint: string | null;
  followUpSamples: FollowUpClassificationSample[];
  proposalReplySamples: ProposalReplyClassificationSample[];
}

const EVIDENCE_OUTPUT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/interface_followup_classification_sample.json"
);

/**
 * Implements `buildArtifact` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildArtifact(): FollowUpClassifierEvidenceArtifact {
  const ruleContext = createFollowUpRuleContext(null);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rulepackVersion: ruleContext.rulepackVersion,
    overrideFingerprint: ruleContext.overrideFingerprint,
    followUpSamples: [
      {
        input: "yes",
        hasPriorAssistantQuestion: true,
        result: classifyFollowUp("yes", {
          hasPriorAssistantQuestion: true,
          ruleContext
        })
      },
      {
        input: "plain text",
        hasPriorAssistantQuestion: true,
        result: classifyFollowUp("plain text", {
          hasPriorAssistantQuestion: true,
          ruleContext
        })
      },
      {
        input: "approve no",
        hasPriorAssistantQuestion: true,
        result: classifyFollowUp("approve no", {
          hasPriorAssistantQuestion: true,
          ruleContext
        })
      }
    ],
    proposalReplySamples: [
      {
        input: "go ahead",
        hasActiveProposal: true,
        result: classifyProposalReply("go ahead", {
          hasActiveProposal: true,
          ruleContext
        })
      },
      {
        input: "change it to weekdays only",
        hasActiveProposal: true,
        result: classifyProposalReply("change it to weekdays only", {
          hasActiveProposal: true,
          ruleContext
        })
      },
      {
        input: "cancel",
        hasActiveProposal: true,
        result: classifyProposalReply("cancel", {
          hasActiveProposal: true,
          ruleContext
        })
      }
    ]
  };
}

/**
 * Implements `runInterfaceFollowUpClassificationEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runInterfaceFollowUpClassificationEvidence(): Promise<void> {
  const artifact = buildArtifact();
  await mkdir(path.dirname(EVIDENCE_OUTPUT_PATH), { recursive: true });
  await writeFile(EVIDENCE_OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`Interface follow-up classifier artifact: ${EVIDENCE_OUTPUT_PATH}`);
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  await runInterfaceFollowUpClassificationEvidence();
}

if (require.main === module) {
  void main();
}
