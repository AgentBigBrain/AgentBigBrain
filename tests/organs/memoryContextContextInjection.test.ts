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
import {
  countRetrievedEpisodeSummaries,
  sanitizeEpisodeContextForModelEgress
} from "../../src/organs/memoryContext/episodeContextInjection";

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

test("sanitizeEpisodeContextForModelEgress redacts sensitive episode lines deterministically", () => {
  const result = sanitizeEpisodeContextForModelEgress([
    "- situation: Billy follow-up | status=unresolved | summary=Billy's phone number is 555-1234."
  ].join("\n"));

  assert.equal(result.redactedFieldCount, 1);
  assert.match(result.sanitizedContext, /\[REDACTED\]/);
});

test("buildInjectedContextPacket appends bounded episode context when provided", () => {
  const packet = buildInjectedContextPacket(
    buildTask("How is Billy doing after the fall?"),
    ["relationship"],
    {
      profile: 0,
      relationship: 3,
      workflow: 0,
      system_policy: 0,
      unknown: 0
    },
    "profile_context_relevant",
    "contact.billy.name: Billy",
    "- situation: Billy fell down | status=unresolved | observedAt=2026-03-08T10:00:00.000Z | summary=Billy fell down a few weeks ago and the outcome was unresolved."
  );

  assert.match(packet, /\[AgentFriendEpisodeContext\]/);
  assert.match(packet, /Billy fell down/);
});

test("countRetrievedEpisodeSummaries counts rendered situation lines only", () => {
  const context = [
    "- situation: Billy fell down | status=unresolved | summary=Still waiting on the outcome.",
    "- situation: Tax filing issue | status=outcome_unknown | summary=No final update yet."
  ].join("\n");

  assert.equal(countRetrievedEpisodeSummaries(context), 2);
});
