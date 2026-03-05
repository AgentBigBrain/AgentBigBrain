/**
 * @fileoverview Tests nuanced conversational intent interpretation for pulse-control commands.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ModelClient, StructuredCompletionRequest } from "../../src/models/types";
import {
  buildNoneIntent,
  IntentInterpreterOrgan,
  InterpretedConversationIntent
} from "../../src/organs/intentInterpreter";
import { createPulseLexicalRuleContext } from "../../src/organs/pulseLexicalClassifier";

class StubModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private completionCalls = 0;

  /**
 * Initializes class StubModelClient dependencies and runtime state.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  constructor(private readonly output: InterpretedConversationIntent) { }

  /**
 * Implements `completeJson` behavior within class StubModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  async completeJson<T>(_request: StructuredCompletionRequest): Promise<T> {
    this.completionCalls += 1;
    if (this.output.intentType !== "pulse_control") {
      return {
        intentType: "none",
        mode: null,
        confidence: this.output.confidence,
        rationale: this.output.rationale
      } as T;
    }

    return {
      intentType: "pulse_control",
      mode: this.output.pulseMode,
      confidence: this.output.confidence,
      rationale: this.output.rationale
    } as T;
  }

  /**
 * Implements `getCompletionCalls` behavior within class StubModelClient.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
  getCompletionCalls(): number {
    return this.completionCalls;
  }
}

test("intent interpreter resolves deterministic pulse-off language without model dependency", async () => {
  const client = new StubModelClient(buildNoneIntent("unused"));
  const interpreter = new IntentInterpreterOrgan(client);

  const interpreted = await interpreter.interpretConversationIntent(
    "Please turn off these reminders for now.",
    "small-fast-model"
  );

  assert.equal(interpreted.intentType, "pulse_control");
  assert.equal(interpreted.pulseMode, "off");
  assert.equal(interpreted.source, "deterministic");
  assert.ok(interpreted.confidence >= 0.9);
  assert.equal(interpreted.lexicalClassification?.rulepackVersion, "PulseLexicalRulepackV1");
  assert.equal(interpreted.lexicalClassification?.matchedRuleId, "pulse_lexical_v1_pattern_off");
  assert.equal(client.getCompletionCalls(), 0);
});

test("intent interpreter can use model fallback for nuanced pulse language", async () => {
  const client = new StubModelClient({
    intentType: "pulse_control",
    pulseMode: "off",
    confidence: 0.91,
    rationale: "Nuanced request implies disabling reminders.",
    source: "model"
  });
  const interpreter = new IntentInterpreterOrgan(client);

  const interpreted = await interpreter.interpretConversationIntent(
    "Could you chill with those for now?",
    "small-fast-model",
    {
      recentTurns: [
        { role: "user", text: "BigBrain /pulse on" },
        { role: "assistant", text: "Agent Pulse is now ON for this conversation." }
      ]
    }
  );

  assert.equal(interpreted.intentType, "pulse_control");
  assert.equal(interpreted.pulseMode, "off");
  assert.equal(interpreted.source, "model");
  assert.ok(interpreted.confidence >= 0.9);
  assert.equal(interpreted.lexicalClassification?.matchedRuleId, "pulse_lexical_v1_no_pulse_signal");
  assert.equal(client.getCompletionCalls(), 1);
});

test("intent interpreter skips model call for over-budget input length", async () => {
  const client = new StubModelClient({
    intentType: "pulse_control",
    pulseMode: "off",
    confidence: 0.95,
    rationale: "unused",
    source: "model"
  });
  const interpreter = new IntentInterpreterOrgan(client);

  const interpreted = await interpreter.interpretConversationIntent(
    "x".repeat(321),
    "small-fast-model"
  );

  assert.equal(interpreted.intentType, "none");
  assert.equal(interpreted.source, "fallback");
  assert.equal(client.getCompletionCalls(), 0);
});

test("intent interpreter fails closed on conflicting lexical ON and OFF signals without model fallback", async () => {
  const client = new StubModelClient({
    intentType: "pulse_control",
    pulseMode: "on",
    confidence: 0.99,
    rationale: "unused",
    source: "model"
  });
  const interpreter = new IntentInterpreterOrgan(client);

  const interpreted = await interpreter.interpretConversationIntent(
    "turn on and turn off pulse reminders",
    "small-fast-model"
  );

  assert.equal(interpreted.intentType, "none");
  assert.equal(interpreted.source, "deterministic");
  assert.equal(interpreted.lexicalClassification?.conflict, true);
  assert.equal(interpreted.lexicalClassification?.matchedRuleId, "pulse_lexical_v1_conflicting_on_and_off");
  assert.equal(client.getCompletionCalls(), 0);
});

test("intent interpreter honors tightening-only pulse lexical override by disabling off intent", async () => {
  const client = new StubModelClient({
    intentType: "pulse_control",
    pulseMode: "on",
    confidence: 0.99,
    rationale: "unused",
    source: "model"
  });
  const interpreter = new IntentInterpreterOrgan(client);
  const pulseRuleContext = createPulseLexicalRuleContext(null);

  const overriddenContext = {
    ...pulseRuleContext,
    disabledIntents: new Set(["off"] as const)
  };

  const interpreted = await interpreter.interpretConversationIntent(
    "turn off pulse",
    "small-fast-model",
    { pulseRuleContext: overriddenContext }
  );

  assert.equal(interpreted.intentType, "none");
  assert.equal(interpreted.source, "deterministic");
  assert.equal(interpreted.lexicalClassification?.matchedRuleId, "pulse_lexical_v1_disabled_intent_off");
  assert.equal(interpreted.lexicalClassification?.conflict, true);
  assert.equal(client.getCompletionCalls(), 0);
});
