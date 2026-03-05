/**
 * @fileoverview Emits deterministic evidence for unified pulse lexical classification across conversation-manager telemetry and intent-interpreter paths.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConversationInboundMessage, ConversationManager } from "../../src/interfaces/conversationManager";
import { InterfaceSessionStore, ConversationClassifierEvent } from "../../src/interfaces/sessionStore";
import { ModelClient, StructuredCompletionRequest } from "../../src/models/types";
import {
  buildNoneIntent,
  IntentInterpreterOrgan,
  InterpretedConversationIntent
} from "../../src/organs/intentInterpreter";
import {
  classifyPulseLexicalCommand,
  createPulseLexicalRuleContext
} from "../../src/organs/pulseLexicalClassifier";

interface PulseLexicalClassifierSample {
  input: string;
  result: ReturnType<typeof classifyPulseLexicalCommand>;
}

interface IntentInterpreterSample {
  input: string;
  result: InterpretedConversationIntent;
}

interface PulseLexicalEvidenceArtifact {
  schemaVersion: 1;
  generatedAt: string;
  rulepackVersion: string;
  overrideFingerprint: string | null;
  classifierSamples: PulseLexicalClassifierSample[];
  intentInterpreterSamples: IntentInterpreterSample[];
  sessionTelemetrySamples: ConversationClassifierEvent[];
}

const EVIDENCE_OUTPUT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/pulse_lexical_classification_sample.json"
);

class StubIntentModelClient implements ModelClient {
  readonly backend = "mock" as const;

  /**
 * Implements `completeJson` behavior within class StubIntentModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(_request: StructuredCompletionRequest): Promise<T> {
    return {
      intentType: "pulse_control",
      mode: "off",
      confidence: 0.92,
      rationale: "Nuanced wording interpreted as disabling check-ins."
    } as T;
  }
}

/**
 * Implements `buildMessage` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildMessage(text: string, receivedAt: string): ConversationInboundMessage {
  return {
    provider: "telegram",
    conversationId: "chat-evidence",
    userId: "user-evidence",
    username: "agentowner",
    conversationVisibility: "private",
    text,
    receivedAt
  };
}

/**
 * Implements `collectSessionTelemetrySamples` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function collectSessionTelemetrySamples(
  interpreter: IntentInterpreterOrgan
): Promise<ConversationClassifierEvent[]> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-lexical-evidence-"));
  const sessionsPath = path.join(tempDir, "sessions.json");
  const store = new InterfaceSessionStore(sessionsPath);
  const ruleContext = createPulseLexicalRuleContext(null);
  const manager = new ConversationManager(
    store,
    {
      pulseLexicalOverridePath: null
    },
    {
      interpretConversationIntent: async (input, recentTurns, pulseRuleContext) =>
        interpreter.interpretConversationIntent(input, "small-fast-model", {
          recentTurns,
          pulseRuleContext: pulseRuleContext ?? ruleContext
        })
    }
  );
  const nowIso = new Date().toISOString();

  try {
    await manager.handleMessage(
      buildMessage("turn off notifications for now", nowIso),
      async (input) => ({ summary: input }),
      async () => { }
    );
    await manager.handleMessage(
      buildMessage("turn on and turn off pulse reminders", nowIso),
      async () => ({ summary: "conflict handled as regular chat input" }),
      async () => { }
    );
    await manager.handleMessage(
      buildMessage("Could you chill with those for now?", nowIso),
      async (input) => ({ summary: input }),
      async () => { }
    );

    const session = await store.getSession("telegram:chat-evidence:user-evidence");
    return (session?.classifierEvents ?? []).filter((event) => event.classifier === "pulse_lexical");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Implements `buildArtifact` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function buildArtifact(): Promise<PulseLexicalEvidenceArtifact> {
  const ruleContext = createPulseLexicalRuleContext(null);
  const interpreter = new IntentInterpreterOrgan(new StubIntentModelClient());
  const sampleInputs = [
    "turn off notifications for now",
    "turn on and turn off pulse reminders",
    "Could you chill with those for now?"
  ];

  const classifierSamples: PulseLexicalClassifierSample[] = sampleInputs.map((input) => ({
    input,
    result: classifyPulseLexicalCommand(input, ruleContext)
  }));

  const intentInterpreterSamples: IntentInterpreterSample[] = [];
  for (const input of sampleInputs) {
    const result = await interpreter.interpretConversationIntent(input, "small-fast-model", {
      recentTurns: [],
      pulseRuleContext: ruleContext
    });
    intentInterpreterSamples.push({
      input,
      result
    });
  }

  const sessionTelemetrySamples = await collectSessionTelemetrySamples(interpreter);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rulepackVersion: ruleContext.rulepackVersion,
    overrideFingerprint: ruleContext.overrideFingerprint,
    classifierSamples,
    intentInterpreterSamples,
    sessionTelemetrySamples
  };
}

/**
 * Implements `runPulseLexicalClassificationEvidence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runPulseLexicalClassificationEvidence(): Promise<void> {
  const artifact = await buildArtifact();
  await mkdir(path.dirname(EVIDENCE_OUTPUT_PATH), { recursive: true });
  await writeFile(EVIDENCE_OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`Pulse lexical classification artifact: ${EVIDENCE_OUTPUT_PATH}`);
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  await runPulseLexicalClassificationEvidence();
}

if (require.main === module) {
  void main();
}

