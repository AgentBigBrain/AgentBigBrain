/**
 * @fileoverview Emits deterministic evidence for the governed skills/workflow maturity loop.
 */

import { writeFile } from "node:fs/promises";

import type { ConversationInboundMediaEnvelope } from "../../src/interfaces/mediaRuntime/contracts";
import type { ConversationInboundMessage } from "../../src/interfaces/conversationRuntime/managerContracts";
import {
  ensureSkillsWorkflowEvidenceDirectory,
  runConversationManagerMessage,
  runSkillLifecycleEvidence,
  runWorkflowEvidence,
  SKILLS_AND_WORKFLOW_MATURITY_ARTIFACT_PATH,
  SKILLS_AND_WORKFLOW_MATURITY_EVIDENCE_COMMAND,
  withSkillsWorkflowHarness
} from "./skillsAndWorkflowMaturitySupport";

interface EvidenceCheck {
  label: string;
  passed: boolean;
  observed: string;
}

interface SkillsWorkflowEvidenceArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL";
  requiredProofs: {
    skillManifestWritten: boolean;
    skillVerificationTrustedForReuse: boolean;
    skillReuseSucceeded: boolean;
    workflowObservationRichlyCaptured: boolean;
    workflowBridgePreferredSkill: boolean;
    workflowBridgeSkillSuggestion: boolean;
    workflowInspectionVisible: boolean;
    textSkillDiscoveryWorks: boolean;
    naturalSkillDiscoveryWorks: boolean;
    voiceSkillDiscoveryWorks: boolean;
  };
  checks: readonly EvidenceCheck[];
}

function buildConversationMessage(
  text: string,
  receivedAt: string,
  media?: ConversationInboundMediaEnvelope | null
): ConversationInboundMessage {
  return {
    provider: "telegram",
    conversationId: "skills-workflow-evidence",
    userId: "user-1",
    username: "benny",
    conversationVisibility: "private",
    text,
    media,
    receivedAt
  };
}

function buildVoiceSkillsEnvelope(): ConversationInboundMediaEnvelope {
  return {
    attachments: [
      {
        kind: "voice",
        provider: "telegram",
        fileId: "voice-skills-proof",
        fileUniqueId: "voice-skills-proof-uniq",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 2048,
        caption: null,
        durationSeconds: 4,
        width: null,
        height: null,
        interpretation: {
          summary: "Voice note asking for the current skills inventory.",
          transcript:
            "BigBrain, command skills and then tell me which reusable tools you already trust for planner failure work because I do not want to rediscover the same fix again.",
          ocrText: null,
          confidence: 0.97,
          provenance: "transcription",
          source: "fixture_catalog",
          entityHints: []
        }
      }
    ]
  };
}

export async function runSkillsAndWorkflowMaturityEvidence(): Promise<SkillsWorkflowEvidenceArtifact> {
  await ensureSkillsWorkflowEvidenceDirectory();
  const artifact = await withSkillsWorkflowHarness(async (context) => {
    const lifecycle = await runSkillLifecycleEvidence(context.skillRegistryStore);
    const manifest = await context.skillRegistryStore.loadManifest("triage_planner_failure");
    const workflow = await runWorkflowEvidence(
      context.workflowLearningStore,
      lifecycle.runOutcome,
      () => context.skillRegistryStore.listAvailableSkills()
    );

    const slashReply = await runConversationManagerMessage(
      context.conversationManager,
      buildConversationMessage("/skills", "2026-03-10T17:00:00.000Z")
    );
    const naturalReply = await runConversationManagerMessage(
      context.conversationManager,
      buildConversationMessage(
        "Before we jump back into the planner failure, tell me what reusable skills you already have available right now. I want to know which ones are safe to trust before I ask you to use one.",
        "2026-03-10T17:00:10.000Z"
      )
    );
    const voiceReply = await runConversationManagerMessage(
      context.conversationManager,
      buildConversationMessage("", "2026-03-10T17:00:20.000Z", buildVoiceSkillsEnvelope())
    );

    const richPattern = workflow.relevantPatterns.find(
      (pattern) =>
        Boolean(pattern.executionStyle) &&
        Boolean(pattern.actionSequenceShape) &&
        Boolean(pattern.approvalPosture) &&
        Boolean(pattern.linkedSkillName)
    );
    const requiredProofs = {
      skillManifestWritten: Boolean(manifest?.name === "triage_planner_failure"),
      skillVerificationTrustedForReuse:
        manifest?.verificationStatus === "verified" &&
        lifecycle.createOutcome.executionMetadata?.skillTrustedForReuse === true,
      skillReuseSucceeded:
        lifecycle.runOutcome.status === "success" &&
        lifecycle.runOutcome.executionMetadata?.skillTrustedForReuse === true,
      workflowObservationRichlyCaptured: Boolean(richPattern),
      workflowBridgePreferredSkill:
        workflow.bridgeSummary?.preferredSkill?.name === "triage_planner_failure",
      workflowBridgeSkillSuggestion:
        (workflow.bridgeSummary?.skillSuggestions.length ?? 0) > 0,
      workflowInspectionVisible:
        workflow.inspectionSummary.length > 0 &&
        workflow.inspectionSummary.some((entry) => entry.workflowKey.includes("planner")),
      textSkillDiscoveryWorks: slashReply === lifecycle.inventoryText,
      naturalSkillDiscoveryWorks: naturalReply === lifecycle.inventoryText,
      voiceSkillDiscoveryWorks: voiceReply === lifecycle.inventoryText
    };

    const checks: EvidenceCheck[] = [
      {
        label: "manifest-written",
        passed: requiredProofs.skillManifestWritten,
        observed: manifest
          ? `${manifest.name} | verification=${manifest.verificationStatus}`
          : "missing manifest"
      },
      {
        label: "verification-trusted-for-reuse",
        passed: requiredProofs.skillVerificationTrustedForReuse,
        observed: JSON.stringify(lifecycle.createOutcome.executionMetadata ?? {})
      },
      {
        label: "skill-reuse",
        passed: requiredProofs.skillReuseSucceeded,
        observed: JSON.stringify(lifecycle.runOutcome.executionMetadata ?? {})
      },
      {
        label: "rich-workflow-observation",
        passed: requiredProofs.workflowObservationRichlyCaptured,
        observed: richPattern
          ? `${richPattern.workflowKey} | ${richPattern.executionStyle} | ${richPattern.actionSequenceShape}`
          : "missing rich pattern"
      },
      {
        label: "workflow-bridge-preferred-skill",
        passed: requiredProofs.workflowBridgePreferredSkill,
        observed: workflow.bridgeSummary?.preferredSkill?.name ?? "none"
      },
      {
        label: "workflow-bridge-skill-suggestion",
        passed: requiredProofs.workflowBridgeSkillSuggestion,
        observed: workflow.bridgeSummary?.skillSuggestions
          .map((suggestion) => `${suggestion.workflowKey}->${suggestion.suggestedSkillName}`)
          .join(" | ") || "none"
      },
      {
        label: "workflow-inspection-visible",
        passed: requiredProofs.workflowInspectionVisible,
        observed: workflow.inspectionSummary
          .map((entry) => `${entry.workflowKey}:${entry.status}`)
          .join(" | ")
      },
      {
        label: "slash-skills-discovery",
        passed: requiredProofs.textSkillDiscoveryWorks,
        observed: slashReply
      },
      {
        label: "natural-skills-discovery",
        passed: requiredProofs.naturalSkillDiscoveryWorks,
        observed: naturalReply
      },
      {
        label: "voice-skills-discovery",
        passed: requiredProofs.voiceSkillDiscoveryWorks,
        observed: voiceReply
      }
    ];

    return {
      generatedAt: new Date().toISOString(),
      command: SKILLS_AND_WORKFLOW_MATURITY_EVIDENCE_COMMAND,
      status: Object.values(requiredProofs).every(Boolean) ? "PASS" : "FAIL",
      requiredProofs,
      checks
    } satisfies SkillsWorkflowEvidenceArtifact;
  });

  await writeFile(
    SKILLS_AND_WORKFLOW_MATURITY_ARTIFACT_PATH,
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8"
  );
  return artifact;
}

async function main(): Promise<void> {
  const artifact = await runSkillsAndWorkflowMaturityEvidence();
  console.log(`Skills/workflow maturity evidence artifact: ${SKILLS_AND_WORKFLOW_MATURITY_ARTIFACT_PATH}`);
  console.log(`Status: ${artifact.status}`);
  if (artifact.status === "FAIL") {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
