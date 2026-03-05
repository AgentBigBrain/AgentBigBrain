/**
 * @fileoverview Emits deterministic evidence for contextual follow-up lexical cue classification and scheduler state metadata persistence.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentPulseScheduler } from "../../src/interfaces/agentPulseScheduler";
import { classifyContextualFollowupLexicalCue } from "../../src/interfaces/contextualFollowupLexicalClassifier";
import { AgentPulseEvaluationResult } from "../../src/core/profileMemoryStore";
import { ConversationSession, InterfaceSessionStore } from "../../src/interfaces/sessionStore";

interface ContextualLexicalEvidenceArtifact {
  schemaVersion: 1;
  generatedAt: string;
  rulepackVersion: string;
  rulepackFingerprint: string;
  classifierSamples: Array<{
    input: string;
    classification: ReturnType<typeof classifyContextualFollowupLexicalCue>;
  }>;
  schedulerMetadataSample: ConversationSession["agentPulse"]["lastContextualLexicalEvidence"] | null;
}

const EVIDENCE_OUTPUT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/agent_pulse_contextual_lexical_sample.json"
);

/**
 * Implements `buildPulseEvaluation` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildPulseEvaluation(
  overrides: Partial<AgentPulseEvaluationResult>
): AgentPulseEvaluationResult {
  return {
    decision: {
      allowed: true,
      decisionCode: "ALLOWED",
      suppressedBy: [],
      nextEligibleAtIso: null
    },
    staleFactCount: 0,
    unresolvedCommitmentCount: 0,
    unresolvedCommitmentTopics: [],
    relationship: {
      role: "unknown",
      roleFactId: null
    },
    contextDrift: {
      detected: false,
      domains: [],
      requiresRevalidation: false
    },
    ...overrides
  };
}

/**
 * Implements `buildSession` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildSession(conversationId: string): ConversationSession {
  const nowIso = new Date().toISOString();
  return {
    conversationId,
    userId: "user-evidence",
    username: "agentowner",
    conversationVisibility: "private",
    updatedAt: nowIso,
    activeProposal: null,
    runningJobId: null,
    queuedJobs: [],
    recentJobs: [],
    conversationTurns: [
      {
        role: "user",
        text: "remind me later about alpha beta gamma issue",
        at: new Date(Date.now() - 3 * 60 * 1000).toISOString()
      },
      {
        role: "assistant",
        text: "Acknowledged.",
        at: new Date(Date.now() - 2 * 60 * 1000).toISOString()
      },
      {
        role: "user",
        text: "thanks",
        at: new Date(Date.now() - 60 * 1000).toISOString()
      }
    ],
    classifierEvents: [],
    agentPulse: {
      optIn: true,
      mode: "private",
      routeStrategy: "last_private_used",
      lastPulseSentAt: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      lastDecisionCode: "NOT_EVALUATED",
      lastEvaluatedAt: null,
      lastContextualLexicalEvidence: null
    }
  };
}

/**
 * Implements `collectSchedulerMetadataSample` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function collectSchedulerMetadataSample(): Promise<
  ConversationSession["agentPulse"]["lastContextualLexicalEvidence"] | null
> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-contextual-lexical-evidence-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const session = buildSession("telegram:contextual-evidence:user-evidence");
  await store.setSession(session);

  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () => buildPulseEvaluation({}),
        enqueueSystemJob: async () => true,
        updatePulseState: async (conversationKey, update) => {
          const current = await store.getSession(conversationKey);
          if (!current) {
            return;
          }
          current.agentPulse = {
            ...current.agentPulse,
            ...update
          };
          current.updatedAt = update.updatedAt ?? current.updatedAt;
          await store.setSession(current);
        }
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["contextual_followup"]
      }
    );
    await scheduler.runTickOnce();
    const updated = await store.getSession(session.conversationId);
    return updated?.agentPulse.lastContextualLexicalEvidence ?? null;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Implements `buildArtifact` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function buildArtifact(): Promise<ContextualLexicalEvidenceArtifact> {
  const classifierSamples = [
    "remind me later about alpha beta gamma issue",
    "follow up on tax filing but do not follow up with reminders",
    "I prefer to keep this note for now."
  ].map((input) => ({
    input,
    classification: classifyContextualFollowupLexicalCue(input)
  }));
  const schedulerMetadataSample = await collectSchedulerMetadataSample();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rulepackVersion: classifierSamples[0]?.classification.rulepackVersion ?? "unknown",
    rulepackFingerprint: classifierSamples[0]?.classification.rulepackFingerprint ?? "unknown",
    classifierSamples,
    schedulerMetadataSample
  };
}

/**
 * Implements `runAgentPulseContextualLexicalEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runAgentPulseContextualLexicalEvidence(): Promise<void> {
  const artifact = await buildArtifact();
  await mkdir(path.dirname(EVIDENCE_OUTPUT_PATH), { recursive: true });
  await writeFile(EVIDENCE_OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`Agent Pulse contextual lexical artifact: ${EVIDENCE_OUTPUT_PATH}`);
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  await runAgentPulseContextualLexicalEvidence();
}

if (require.main === module) {
  void main();
}
