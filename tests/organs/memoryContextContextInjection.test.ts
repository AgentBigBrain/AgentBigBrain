/**
 * @fileoverview Focused tests for memory-context sanitization and packet rendering helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TaskRequest } from "../../src/core/types";
import {
  buildInjectedContextPacket,
  buildSuppressedContextPacket,
  countRetrievedProfileFacts,
  sanitizeProfileContextForModelEgress
} from "../../src/organs/memoryContext/contextInjection";

function buildTask(userInput: string): TaskRequest {
  return {
    id: "task_memory_context_packet",
    goal: "Provide safe and helpful assistance.",
    userInput,
    createdAt: new Date().toISOString()
  };
}

test("sanitizeProfileContextForModelEgress redacts sensitive lines deterministically", () => {
  const result = sanitizeProfileContextForModelEgress([
    "contact.billy.name: Billy",
    "contact.billy.email: billy@example.com",
    "contact.billy.phone: 555-1234"
  ].join("\n"));

  assert.equal(result.redactedFieldCount, 2);
  assert.match(result.sanitizedContext, /contact\.billy\.name: Billy/);
  assert.match(result.sanitizedContext, /contact\.billy\.email: \[REDACTED\]/);
  assert.match(result.sanitizedContext, /contact\.billy\.phone: \[REDACTED\]/);
});

test("buildInjectedContextPacket includes broker metadata and context block", () => {
  const packet = buildInjectedContextPacket(
    buildTask("who is Billy?"),
    ["relationship"],
    {
      profile: 0,
      relationship: 3,
      workflow: 0,
      system_policy: 0,
      unknown: 0
    },
    "profile_context_relevant",
    "contact.billy.name: Billy"
  );

  assert.match(packet, /\[AgentFriendMemoryBroker\]/);
  assert.match(packet, /domainBoundaryDecision=inject_profile_context/);
  assert.match(packet, /\[AgentFriendProfileContext\]/);
  assert.match(packet, /contact\.billy\.name: Billy/);
});

test("buildSuppressedContextPacket marks suppression and omits raw profile facts", () => {
  const packet = buildSuppressedContextPacket(
    buildTask("deploy the repo"),
    ["workflow"],
    {
      profile: 0,
      relationship: 0,
      workflow: 3,
      system_policy: 0,
      unknown: 0
    },
    "non_profile_dominant_request"
  );

  assert.match(packet, /domainBoundaryDecision=suppress_profile_context/);
  assert.match(packet, /\[AgentFriendProfileContext\]\nsuppressed=true/);
});

test("countRetrievedProfileFacts ignores headers and counts fact lines only", () => {
  const context = [
    "[AgentFriendProfileContext]",
    "contact.billy.name: Billy",
    "contact.billy.work_association: Flare Web Design",
    ""
  ].join("\n");

  assert.equal(countRetrievedProfileFacts(context), 2);
});
