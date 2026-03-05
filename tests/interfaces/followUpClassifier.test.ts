/**
 * @fileoverview Tests deterministic follow-up and proposal-reply classification behavior with bounded override loading.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  classifyFollowUp,
  classifyProposalReply,
  classifyShortUtterance,
  createFollowUpRuleContext
} from "../../src/interfaces/followUpClassifier";

/**
 * Implements `noOpLog` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function noOpLog(_message: string): void {
  // Intentionally blank for deterministic test output.
}

test("classifyShortUtterance detects short approve signals", () => {
  const context = createFollowUpRuleContext(null, noOpLog, noOpLog);
  const result = classifyShortUtterance("approve", context);

  assert.equal(result.isShortFollowUp, true);
  assert.equal(result.category, "APPROVE");
  assert.equal(result.matchedRuleId, "follow_up_v1_short_approve_signal");
  assert.equal(result.rulepackVersion, "FollowUpRulepackV1");
});

test("classifyShortUtterance fails closed on conflicting approve and deny signals", () => {
  const context = createFollowUpRuleContext(null, noOpLog, noOpLog);
  const result = classifyShortUtterance("approve no", context);

  assert.equal(result.isShortFollowUp, false);
  assert.equal(result.category, "UNCLEAR");
  assert.equal(result.matchedRuleId, "follow_up_v1_conflicting_approve_and_deny");
});

test("classifyFollowUp treats short context-linked replies as deterministic acknowledgements", () => {
  const context = createFollowUpRuleContext(null, noOpLog, noOpLog);
  const result = classifyFollowUp("plain text", {
    hasPriorAssistantQuestion: true,
    ruleContext: context
  });

  assert.equal(result.isShortFollowUp, true);
  assert.equal(result.category, "ACK");
  assert.equal(result.confidenceTier, "MED");
  assert.equal(result.matchedRuleId, "follow_up_v1_contextual_short_reply");
});

test("classifyFollowUp keeps conflicting approve and deny signals fail-closed with context", () => {
  const context = createFollowUpRuleContext(null, noOpLog, noOpLog);
  const result = classifyFollowUp("approve no", {
    hasPriorAssistantQuestion: true,
    ruleContext: context
  });

  assert.equal(result.isShortFollowUp, false);
  assert.equal(result.category, "UNCLEAR");
  assert.equal(result.matchedRuleId, "follow_up_v1_conflicting_approve_and_deny");
});

test("classifyProposalReply maps adjust lead tokens into adjustment intent", () => {
  const context = createFollowUpRuleContext(null, noOpLog, noOpLog);
  const result = classifyProposalReply("adjust move this to weekly", {
    hasActiveProposal: true,
    ruleContext: context
  });

  assert.equal(result.intent, "ADJUST");
  assert.equal(result.adjustmentText, "move this to weekly");
  assert.equal(result.matchedRuleId, "proposal_reply_v1_adjust_lead_token");
});

test("classifyProposalReply maps short deny signals to cancel intent", () => {
  const context = createFollowUpRuleContext(null, noOpLog, noOpLog);
  const result = classifyProposalReply("cancel", {
    hasActiveProposal: true,
    ruleContext: context
  });

  assert.equal(result.intent, "CANCEL");
  assert.equal(result.category, "DENY");
  assert.equal(result.matchedRuleId, "proposal_reply_v1_short_cancel");
});

test("createFollowUpRuleContext loads bounded override aliases from json file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-followup-override-"));
  const overridePath = path.join(tempDir, "followup_override.json");
  const overridePayload = {
    schemaVersion: 1,
    localeTag: "en",
    aliases: {
      approve: ["sounds good"],
      deny: ["not now"],
      adjustLead: ["tune"]
    }
  };

  try {
    await writeFile(overridePath, JSON.stringify(overridePayload, null, 2), "utf8");
    const context = createFollowUpRuleContext(overridePath, noOpLog, noOpLog);
    const approveResult = classifyShortUtterance("sounds good", context);
    const denyResult = classifyShortUtterance("not now", context);
    const adjustResult = classifyProposalReply("tune this plan for evenings", {
      hasActiveProposal: true,
      ruleContext: context
    });

    assert.equal(context.overrideSourcePath, path.resolve(process.cwd(), overridePath));
    assert.ok(context.overrideFingerprint);
    assert.equal(approveResult.category, "APPROVE");
    assert.equal(denyResult.category, "DENY");
    assert.equal(adjustResult.intent, "ADJUST");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
