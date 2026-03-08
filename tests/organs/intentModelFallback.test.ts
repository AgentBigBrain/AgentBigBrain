/**
 * @fileoverview Tests bounded model-fallback helpers for nuanced pulse intent interpretation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ModelClient, StructuredCompletionRequest } from "../../src/models/types";
import { interpretModelAssistedIntent } from "../../src/organs/intentRuntime/intentModelFallback";
import { PulseLexicalClassification } from "../../src/organs/intentRuntime/contracts";

class StubIntentModelClient implements ModelClient {
  readonly backend = "mock" as const;

  recordedRequest: StructuredCompletionRequest | null = null;

  constructor(
    private readonly output:
      | {
          intentType: "pulse_control" | "none";
          mode: "on" | "off" | "private" | "public" | "status" | null;
          confidence: number;
          rationale: string;
        }
      | Error
  ) {}

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    this.recordedRequest = request;
    if (this.output instanceof Error) {
      throw this.output;
    }
    return this.output as T;
  }
}

const lexicalClassification: PulseLexicalClassification = {
  category: "NON_COMMAND",
  commandIntent: null,
  confidenceTier: "LOW",
  matchedRuleId: "pulse_lexical_v1_no_pulse_signal",
  rulepackVersion: "PulseLexicalRulepackV1",
  conflict: false
};

test("interpretModelAssistedIntent uses bounded context hint and returns pulse intent", async () => {
  const modelClient = new StubIntentModelClient({
    intentType: "pulse_control",
    mode: "off",
    confidence: 0.91,
    rationale: "Nuanced request implies disabling reminders."
  });

  const interpreted = await interpretModelAssistedIntent(
    modelClient,
    "Could you chill with those for now?",
    "small-fast-model",
    {
      recentTurns: [
        { role: "user", text: "BigBrain /pulse on" },
        { role: "assistant", text: "Agent Pulse is now ON for this conversation." }
      ]
    },
    lexicalClassification
  );

  assert.equal(interpreted.intentType, "pulse_control");
  assert.equal(interpreted.pulseMode, "off");
  assert.equal(interpreted.source, "model");
  assert.match(modelClient.recordedRequest?.userPrompt ?? "", /BigBrain \/pulse on/);
});

test("interpretModelAssistedIntent fails closed when the model errors", async () => {
  const interpreted = await interpretModelAssistedIntent(
    new StubIntentModelClient(new Error("forced intent failure")),
    "Could you chill with those for now?",
    "small-fast-model",
    {},
    lexicalClassification
  );

  assert.equal(interpreted.intentType, "none");
  assert.equal(interpreted.source, "fallback");
  assert.match(interpreted.rationale, /forced intent failure/);
});
