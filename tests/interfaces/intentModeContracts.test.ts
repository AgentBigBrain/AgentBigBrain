/**
 * @fileoverview Tests for semantic-route metadata authority contracts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildConversationSemanticRouteMetadata,
  routeSourceToAuthority,
  type ResolvedConversationIntentMode
} from "../../src/interfaces/conversationRuntime/intentModeContracts";

function buildResolution(
  matchedRuleId: string,
  overrides: Partial<ResolvedConversationIntentMode> = {}
): ResolvedConversationIntentMode {
  return {
    mode: "chat",
    confidence: "high",
    matchedRuleId,
    explanation: "test route",
    clarification: null,
    ...overrides
  };
}

test("routeSourceToAuthority keeps semantic and deterministic authority classes explicit", () => {
  assert.equal(routeSourceToAuthority("model"), "semantic_model");
  assert.equal(routeSourceToAuthority("clarification"), "active_clarification");
  assert.equal(routeSourceToAuthority("exact_command"), "exact_command");
  assert.equal(routeSourceToAuthority("deterministic_safety"), "exact_command");
  assert.equal(routeSourceToAuthority("deterministic_signal"), "lexical_fallback");
  assert.equal(routeSourceToAuthority("compatibility"), "compatibility_repair");
});

test("buildConversationSemanticRouteMetadata does not treat deterministic signals as exact commands", () => {
  const semanticRoute = buildConversationSemanticRouteMetadata(
    buildResolution("relationship_recall_signal", {
      semanticRouteId: "relationship_recall"
    })
  );

  assert.equal(semanticRoute.source, "deterministic_signal");
  assert.equal(semanticRoute.sourceAuthority, "lexical_fallback");
  assert.equal(semanticRoute.memoryIntent, "relationship_recall");
});

test("buildConversationSemanticRouteMetadata records clarification authority distinctly", () => {
  const semanticRoute = buildConversationSemanticRouteMetadata(
    buildResolution("clarification_followup", {
      clarification: {
        kind: "execution_mode",
        matchedRuleId: "clarification_followup",
        renderingIntent: "plan_or_build",
        question: "Plan or execute?",
        options: [
          { id: "plan", label: "Plan" },
          { id: "build", label: "Build" }
        ]
      }
    })
  );

  assert.equal(semanticRoute.source, "clarification");
  assert.equal(semanticRoute.sourceAuthority, "active_clarification");
});
