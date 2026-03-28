/**
 * @fileoverview Tests deterministic trust-render lexical classification with structured decision/evidence output and tightening-only overrides.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyTrustRenderDecision,
  createTrustLexicalRuleContext,
  isSimulatedOutput
} from "../../src/interfaces/trustLexicalClassifier";

test("classifyTrustRenderDecision returns RENDER_APPROVED for non-claim text with clean execution state", () => {
  const context = createTrustLexicalRuleContext(null);
  const result = classifyTrustRenderDecision(
    {
      text: "Here is the analysis plan and next step.",
      hasApprovedRealShellExecution: false,
      hasApprovedRealNonRespondExecution: false,
      hasBlockedUnmatchedAction: false,
      hasApprovedSimulatedShellExecution: false,
      hasApprovedSimulatedNonRespondExecution: false
    },
    context
  );

  assert.equal(result.decision, "RENDER_APPROVED");
  assert.equal(result.evidence.matchedRuleId, "trust_lexical_v1_no_claim");
  assert.equal(result.evidence.rulepackVersion, "TrustLexicalRulepackV1");
});

test("classifyTrustRenderDecision returns RENDER_UNCERTAIN for browser-execution claim without shell execution", () => {
  const context = createTrustLexicalRuleContext(null);
  const result = classifyTrustRenderDecision(
    {
      text: "I opened your browser and navigated to example.com.",
      hasApprovedRealShellExecution: false,
      hasApprovedRealNonRespondExecution: false,
      hasBlockedUnmatchedAction: false,
      hasApprovedSimulatedShellExecution: false,
      hasApprovedSimulatedNonRespondExecution: false
    },
    context
  );

  assert.equal(result.decision, "RENDER_UNCERTAIN");
  assert.equal(
    result.evidence.matchedRuleId,
    "trust_lexical_v1_browser_claim_without_shell_execution"
  );
  assert.equal(result.evidence.conflict, false);
});

test("classifyTrustRenderDecision returns RENDER_SIMULATED for browser claim when only simulated shell execution exists", () => {
  const context = createTrustLexicalRuleContext(null);
  const result = classifyTrustRenderDecision(
    {
      text: "I launched your browser for that.",
      hasApprovedRealShellExecution: false,
      hasApprovedRealNonRespondExecution: false,
      hasBlockedUnmatchedAction: false,
      hasApprovedSimulatedShellExecution: true,
      hasApprovedSimulatedNonRespondExecution: false
    },
    context
  );

  assert.equal(result.decision, "RENDER_SIMULATED");
  assert.equal(
    result.evidence.matchedRuleId,
    "trust_lexical_v1_browser_claim_simulated_shell_execution"
  );
  assert.equal(result.evidence.conflict, false);
});

test("classifyTrustRenderDecision returns RENDER_BLOCKED for no-claim text with blocked unmatched actions", () => {
  const context = createTrustLexicalRuleContext(null);
  const result = classifyTrustRenderDecision(
    {
      text: "Working on it.",
      hasApprovedRealShellExecution: false,
      hasApprovedRealNonRespondExecution: false,
      hasBlockedUnmatchedAction: true,
      hasApprovedSimulatedShellExecution: false,
      hasApprovedSimulatedNonRespondExecution: false
    },
    context
  );

  assert.equal(result.decision, "RENDER_BLOCKED");
  assert.equal(result.evidence.matchedRuleId, "trust_lexical_v1_blocked_unmatched_action");
});

test("classifyTrustRenderDecision fails closed with conflict evidence on mixed browser/side-effect claim support", () => {
  const context = createTrustLexicalRuleContext(null);
  const result = classifyTrustRenderDecision(
    {
      text: "I opened your browser and the actions that have already run were finalized.",
      hasApprovedRealShellExecution: true,
      hasApprovedRealNonRespondExecution: false,
      hasBlockedUnmatchedAction: false,
      hasApprovedSimulatedShellExecution: false,
      hasApprovedSimulatedNonRespondExecution: false
    },
    context
  );

  assert.equal(result.decision, "RENDER_UNCERTAIN");
  assert.equal(result.evidence.matchedRuleId, "trust_lexical_v1_conflicting_claim_requirements");
  assert.equal(result.evidence.conflict, true);
});

test("createTrustLexicalRuleContext applies tightening-only additive override patterns and changes fingerprint", () => {
  const baseline = createTrustLexicalRuleContext(null);
  const tightened = createTrustLexicalRuleContext({
    schemaVersion: 1,
    additionalSideEffectCompletionClaimPatterns: ["\\bmission\\s+already\\s+completed\\b"]
  });

  const classification = classifyTrustRenderDecision(
    {
      text: "Mission already completed.",
      hasApprovedRealShellExecution: false,
      hasApprovedRealNonRespondExecution: false,
      hasBlockedUnmatchedAction: false,
      hasApprovedSimulatedShellExecution: false,
      hasApprovedSimulatedNonRespondExecution: false
    },
    tightened
  );

  assert.notEqual(tightened.rulepackFingerprint, baseline.rulepackFingerprint);
  assert.equal(classification.decision, "RENDER_UNCERTAIN");
  assert.equal(
    classification.evidence.matchedRuleId,
    "trust_lexical_v1_side_effect_claim_without_execution"
  );
});

test("isSimulatedOutput does not treat real workspace or package names containing preview as simulated", () => {
  const context = createTrustLexicalRuleContext(null);

  assert.equal(
    isSimulatedOutput(
      "Write success: C:\\temp\\drone-react-preview\\src\\App.jsx",
      context
    ),
    false
  );
  assert.equal(
    isSimulatedOutput(
      "Shell success:\n> drone-react-preview@0.0.0 build\n> vite build",
      context
    ),
    false
  );
  assert.equal(
    isSimulatedOutput(
      "This run stayed in preview mode only because real shell execution was disabled by policy.",
      context
    ),
    true
  );
});
