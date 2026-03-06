/**
 * @fileoverview Tests deterministic command-policy helpers used by ConversationManager for help/review/pulse commands.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import {
  renderConversationCommandHelpText,
  resolvePulseCommandResponse,
  resolveReviewCommandResponse
} from "../../src/interfaces/conversationCommandPolicy";
import { ConversationSession } from "../../src/interfaces/sessionStore";

/**
 * Creates a stable conversation session fixture for command-policy helper tests.
 *
 * @returns Fresh session seeded with deterministic defaults.
 */
function buildSession(): ConversationSession {
  return buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: "2026-03-03T00:00:00.000Z"
  });
}

test("renderConversationCommandHelpText includes key command guidance", () => {
  const helpText = renderConversationCommandHelpText();

  assert.match(helpText, /^Commands:/);
  assert.match(helpText, /\/help - show this guide and examples/);
  assert.match(helpText, /\/propose <task>/);
  assert.match(helpText, /\/chat <message>/);
  assert.match(helpText, /\/auto <goal>/);
  assert.match(helpText, /\/pulse <on\|off\|private\|public\|status>/);
  assert.match(helpText, /\/review <checkpoint-id>/);
  assert.match(helpText, /^Skill workflow:/m);
  assert.match(helpText, /There is no separate \/skill command/i);
  assert.match(helpText, /create skill repo_status/i);
  assert.match(helpText, /run skill repo_status/i);
  assert.match(helpText, /^Examples:/m);
  assert.match(helpText, /\/review 6\.85\.A/);
  assert.match(helpText, /Execute now using PowerShell/i);
  assert.match(helpText, /PowerShell\/cmd on Windows, Terminal\/bash\/zsh on macOS\/Linux/i);
  assert.match(helpText, /- Executed: side-effect actions actually ran/i);
  assert.match(helpText, /- Guidance only: the run produced instructions\/analysis/i);
  assert.match(helpText, /- Blocked: safety\/governance\/runtime policy denied execution/i);
  assert.match(helpText, /Autonomy note: \/auto can still complete with guidance-only output/i);
  assert.match(helpText, /If work is already running, new requests are queued/);
});

test("resolveReviewCommandResponse returns deterministic usage and unavailable messages", async () => {
  const usage = await resolveReviewCommandResponse("   ", undefined);
  assert.equal(
    usage,
    "Usage: /review <checkpoint-id>. Example: /review 6.11, /review 6.75, or /review 6.85.A"
  );

  const unavailable = await resolveReviewCommandResponse("6.85.a", undefined);
  assert.equal(unavailable, "Live review commands are unavailable in this runtime.");
});

test("resolveReviewCommandResponse renders unsupported, pass/fail, and error output deterministically", async () => {
  const unsupported = await resolveReviewCommandResponse("6.99", async () => null);
  assert.match(unsupported, /Unsupported checkpoint '6\.99'\./);
  assert.match(unsupported, /Currently supported: 6\.11, 6\.13, 6\.75, 6\.85\.A/);

  const pass = await resolveReviewCommandResponse("6.85.a", async (checkpointId) => ({
    checkpointId,
    overallPass: true,
    artifactPath: "runtime/evidence/stage6_85_playbooks_report.json",
    summaryLines: ["line 1", "line 2"]
  }));
  assert.match(pass, /Checkpoint 6\.85\.a live review: PASS/);
  assert.match(pass, /line 1/);
  assert.match(pass, /Artifact: runtime\/evidence\/stage6_85_playbooks_report\.json/);

  const failed = await resolveReviewCommandResponse("6.85.b", async () => {
    throw new Error("runner failure");
  });
  assert.equal(failed, "Review command failed for checkpoint 6.85.b: runner failure");
});

test("resolvePulseCommandResponse updates pulse mode state and returns status blocks", () => {
  const session = buildSession();

  const status = resolvePulseCommandResponse(session, "status", "2026-03-03T00:01:00.000Z");
  assert.match(status, /Agent Pulse: off/);

  session.agentPulse.lastDecisionCode = "DYNAMIC_SENT";
  session.agentPulse.lastEvaluatedAt = "2026-03-03T00:00:30.000Z";
  const onReply = resolvePulseCommandResponse(session, "on", "2026-03-03T00:02:00.000Z");
  assert.match(onReply, /Agent Pulse is now ON/);
  assert.equal(session.agentPulse.optIn, true);
  assert.equal(session.agentPulse.mode, "private");
  assert.equal(session.agentPulse.routeStrategy, "last_private_used");
  assert.equal(session.agentPulse.lastDecisionCode, "NOT_EVALUATED");

  const publicReply = resolvePulseCommandResponse(
    session,
    "public",
    "2026-03-03T00:03:00.000Z"
  );
  assert.match(publicReply, /Agent Pulse is now PUBLIC/);
  assert.equal(session.agentPulse.mode, "public");
  assert.equal(session.agentPulse.routeStrategy, "current_conversation");

  const offReply = resolvePulseCommandResponse(session, "off", "2026-03-03T00:04:00.000Z");
  assert.match(offReply, /Agent Pulse is now OFF/);
  assert.equal(session.agentPulse.optIn, false);

  const usage = resolvePulseCommandResponse(session, "invalid", "2026-03-03T00:05:00.000Z");
  assert.equal(usage, "Usage: /pulse <on|off|private|public|status>");
});
