/**
 * @fileoverview Runs a runtime-backed live smoke for skills/workflow maturity using the real
 * registry, workflow store, planner-learning context, and conversation manager.
 */

import { writeFile } from "node:fs/promises";

import type { ConversationInboundMediaEnvelope } from "../../src/interfaces/mediaRuntime/contracts";
import type { ConversationInboundMessage } from "../../src/interfaces/conversationRuntime/managerContracts";
import {
  ensureSkillsWorkflowEvidenceDirectory,
  matchesSkillDiscoveryReply,
  runConversationManagerMessage,
  runSkillLifecycleEvidence,
  runWorkflowEvidence,
  SKILLS_AND_WORKFLOW_MATURITY_LIVE_SMOKE_ARTIFACT_PATH,
  SKILLS_AND_WORKFLOW_MATURITY_LIVE_SMOKE_COMMAND,
  withSkillsWorkflowHarness
} from "./skillsAndWorkflowMaturitySupport";

interface LiveSmokeCheck {
  label: string;
  passed: boolean;
  observed: string;
}

interface LiveSmokeScenarioResult {
  scenarioId: string;
  passed: boolean;
  checks: readonly LiveSmokeCheck[];
}

interface SkillsWorkflowLiveSmokeArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL";
  requiredProofs: {
    createVerifyReuseLoop: boolean;
    preferredVerifiedSkillReuse: boolean;
    skillSuggestionFromRepeatedWorkflow: boolean;
    unifiedTextVoiceDiscovery: boolean;
  };
  summary: {
    scenarioCount: number;
    passedScenarios: number;
    failedScenarios: number;
  };
  scenarioResults: readonly LiveSmokeScenarioResult[];
}

function buildConversationMessage(
  text: string,
  receivedAt: string,
  media?: ConversationInboundMediaEnvelope | null
): ConversationInboundMessage {
  return {
    provider: "telegram",
    conversationId: "skills-workflow-live-smoke",
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
        fileId: "voice-skills-live-smoke",
        fileUniqueId: "voice-skills-live-smoke-uniq",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 2048,
        caption: null,
        durationSeconds: 5,
        width: null,
        height: null,
        interpretation: {
          summary: "Voice note asking for the current skill inventory.",
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

export async function runSkillsAndWorkflowMaturityLiveSmoke(): Promise<SkillsWorkflowLiveSmokeArtifact> {
  await ensureSkillsWorkflowEvidenceDirectory();
  const artifact = await withSkillsWorkflowHarness(async (context) => {
    const lifecycle = await runSkillLifecycleEvidence(context.skillRegistryStore);
    const workflow = await runWorkflowEvidence(
      context.workflowLearningStore,
      lifecycle.runOutcome,
      () => context.skillRegistryStore.listAvailableSkills()
    );

    const slashReply = await runConversationManagerMessage(
      context.conversationManager,
      buildConversationMessage("/skills", "2026-03-10T18:00:00.000Z")
    );
    const naturalReply = await runConversationManagerMessage(
      context.conversationManager,
      buildConversationMessage(
        "Before we jump back into the planner failure, tell me what reusable skills you already have available right now. I want to know which ones are safe to trust before I ask you to use one.",
        "2026-03-10T18:00:10.000Z"
      )
    );
    const voiceReply = await runConversationManagerMessage(
      context.conversationManager,
      buildConversationMessage("", "2026-03-10T18:00:20.000Z", buildVoiceSkillsEnvelope())
    );

    const scenarioResults: LiveSmokeScenarioResult[] = [
      {
        scenarioId: "create_verify_reuse",
        passed:
          lifecycle.createOutcome.status === "success" &&
          lifecycle.runOutcome.status === "success" &&
          lifecycle.createOutcome.executionMetadata?.skillTrustedForReuse === true &&
          lifecycle.runOutcome.executionMetadata?.skillTrustedForReuse === true,
        checks: [
          {
            label: "create-skill-success",
            passed: lifecycle.createOutcome.status === "success",
            observed: lifecycle.createOutcome.output
          },
          {
            label: "verification-trusted",
            passed: lifecycle.createOutcome.executionMetadata?.skillTrustedForReuse === true,
            observed: JSON.stringify(lifecycle.createOutcome.executionMetadata ?? {})
          },
          {
            label: "run-skill-reuse-success",
            passed: lifecycle.runOutcome.status === "success",
            observed: lifecycle.runOutcome.output
          }
        ]
      },
      {
        scenarioId: "workflow_bridge",
        passed:
          workflow.bridgeSummary?.preferredSkill?.name === "triage_planner_failure" &&
          (workflow.bridgeSummary?.skillSuggestions.length ?? 0) > 0,
        checks: [
          {
            label: "preferred-verified-skill",
            passed: workflow.bridgeSummary?.preferredSkill?.name === "triage_planner_failure",
            observed: workflow.bridgeSummary?.preferredSkill?.name ?? "none"
          },
          {
            label: "skill-suggestion-present",
            passed: (workflow.bridgeSummary?.skillSuggestions.length ?? 0) > 0,
            observed: workflow.bridgeSummary?.skillSuggestions
              .map((suggestion) => suggestion.suggestedSkillName)
              .join(" | ") || "none"
          }
        ]
      },
      {
        scenarioId: "skill_discovery_text_and_voice",
        passed:
          matchesSkillDiscoveryReply(slashReply, lifecycle.inventoryText) &&
          matchesSkillDiscoveryReply(naturalReply, lifecycle.inventoryText) &&
          matchesSkillDiscoveryReply(voiceReply, lifecycle.inventoryText),
        checks: [
          {
            label: "slash-discovery",
            passed: matchesSkillDiscoveryReply(slashReply, lifecycle.inventoryText),
            observed: slashReply
          },
          {
            label: "natural-discovery",
            passed: matchesSkillDiscoveryReply(naturalReply, lifecycle.inventoryText),
            observed: naturalReply
          },
          {
            label: "voice-command-discovery",
            passed: matchesSkillDiscoveryReply(voiceReply, lifecycle.inventoryText),
            observed: voiceReply
          }
        ]
      }
    ];

    const requiredProofs = {
      createVerifyReuseLoop: scenarioResults[0]?.passed === true,
      preferredVerifiedSkillReuse:
        workflow.bridgeSummary?.preferredSkill?.name === "triage_planner_failure",
      skillSuggestionFromRepeatedWorkflow:
        (workflow.bridgeSummary?.skillSuggestions.length ?? 0) > 0,
      unifiedTextVoiceDiscovery:
        scenarioResults[2]?.passed === true
    };
    const passedScenarios = scenarioResults.filter((scenario) => scenario.passed).length;
    const failedScenarios = scenarioResults.length - passedScenarios;

    return {
      generatedAt: new Date().toISOString(),
      command: SKILLS_AND_WORKFLOW_MATURITY_LIVE_SMOKE_COMMAND,
      status:
        failedScenarios === 0 && Object.values(requiredProofs).every(Boolean)
          ? "PASS"
          : "FAIL",
      requiredProofs,
      summary: {
        scenarioCount: scenarioResults.length,
        passedScenarios,
        failedScenarios
      },
      scenarioResults
    } satisfies SkillsWorkflowLiveSmokeArtifact;
  });

  await writeFile(
    SKILLS_AND_WORKFLOW_MATURITY_LIVE_SMOKE_ARTIFACT_PATH,
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8"
  );
  return artifact;
}

async function main(): Promise<void> {
  const artifact = await runSkillsAndWorkflowMaturityLiveSmoke();
  console.log(
    `Skills/workflow maturity live smoke artifact: ${SKILLS_AND_WORKFLOW_MATURITY_LIVE_SMOKE_ARTIFACT_PATH}`
  );
  console.log(`Status: ${artifact.status}`);
  if (artifact.status === "FAIL") {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
