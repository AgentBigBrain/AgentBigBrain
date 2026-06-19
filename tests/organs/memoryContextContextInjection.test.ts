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
    "contact.riley.name: Riley",
    "contact.riley.email: riley@example.com",
    "contact.riley.phone: 555-1234"
  ].join("\n"));

  assert.equal(result.redactedFieldCount, 2);
  assert.match(result.sanitizedContext, /contact\.riley\.name: Riley/);
  assert.match(result.sanitizedContext, /contact\.riley\.email: \[REDACTED\]/);
  assert.match(result.sanitizedContext, /contact\.riley\.phone: \[REDACTED\]/);
});

test("buildInjectedContextPacket includes broker metadata and context block", () => {
  const packet = buildInjectedContextPacket(
    buildTask("who is Riley?"),
    ["relationship"],
    {
      profile: 0,
      relationship: 3,
      workflow: 0,
      system_policy: 0,
      unknown: 0
    },
    "profile_context_relevant",
    "contact.riley.name: Riley"
  );

  assert.match(packet, /\[AgentFriendMemoryBroker\]/);
  assert.match(packet, /retrievalMode=keyword_only/);
  assert.match(packet, /sourceAuthority=unknown/);
  assert.match(packet, /plannerAuthority=none/);
  assert.match(packet, /currentTruthAuthority=false/);
  assert.match(packet, /domainBoundaryDecision=inject_profile_context/);
  assert.match(packet, /\[AgentFriendProfileContext\]/);
  assert.match(packet, /contact\.riley\.name: Riley/);
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
  assert.match(packet, /plannerAuthority=none/);
  assert.match(packet, /currentTruthAuthority=false/);
  assert.match(packet, /\[AgentFriendProfileContext\]\nsuppressed=true/);
});

test("buildInjectedContextPacket can expose route-approved semantic retrieval authority", () => {
  const packet = buildInjectedContextPacket(
    buildTask("who is Riley?"),
    ["relationship"],
    {
      profile: 0,
      relationship: 3,
      workflow: 0,
      system_policy: 0,
      unknown: 0
    },
    "profile_context_relevant",
    "Temporal memory context (bounded):\nCurrent State:\n- Riley is tied to Lantern Studio.",
    "",
    "",
    {
      retrievalMode: "semantic_entity_match",
      sourceAuthority: "semantic_model",
      plannerAuthority: "route_approved",
      currentTruthAuthority: true
    }
  );

  assert.match(packet, /retrievalMode=semantic_entity_match/);
  assert.match(packet, /sourceAuthority=semantic_model/);
  assert.match(packet, /plannerAuthority=route_approved/);
  assert.match(packet, /currentTruthAuthority=true/);
});

test("countRetrievedProfileFacts ignores headers and counts fact lines only", () => {
  const context = [
    "[AgentFriendProfileContext]",
    "contact.riley.name: Riley",
    "contact.riley.work_association: Lantern Studio",
    ""
  ].join("\n");

  assert.equal(countRetrievedProfileFacts(context), 2);
});

test("sanitizeEpisodeContextForModelEgress redacts sensitive episode lines deterministically", () => {
  const result = sanitizeEpisodeContextForModelEgress([
    "- situation: Riley follow-up | status=unresolved | summary=Riley's phone number is 555-1234."
  ].join("\n"));

  assert.equal(result.redactedFieldCount, 1);
  assert.match(result.sanitizedContext, /\[REDACTED\]/);
});

test("buildInjectedContextPacket appends bounded episode context when provided", () => {
  const packet = buildInjectedContextPacket(
    buildTask("How is Riley doing after the fall?"),
    ["relationship"],
    {
      profile: 0,
      relationship: 3,
      workflow: 0,
      system_policy: 0,
      unknown: 0
    },
    "profile_context_relevant",
    "contact.riley.name: Riley",
    "- situation: Riley fell down | status=unresolved | observedAt=2026-03-08T10:00:00.000Z | summary=Riley fell down a few weeks ago and the outcome was unresolved."
  );

  assert.match(packet, /\[AgentFriendEpisodeContext\]/);
  assert.match(packet, /Riley fell down/);
});

test("countRetrievedEpisodeSummaries counts rendered situation lines only", () => {
  const context = [
    "- situation: Riley fell down | status=unresolved | summary=Still waiting on the outcome.",
    "- situation: Tax filing issue | status=outcome_unknown | summary=No final update yet."
  ].join("\n");

  assert.equal(countRetrievedEpisodeSummaries(context), 2);
});
