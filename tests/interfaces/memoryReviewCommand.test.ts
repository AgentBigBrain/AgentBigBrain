/**
 * @fileoverview Tests bounded private `/memory` command handling.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import type { ConversationIngressDependencies } from "../../src/interfaces/conversationRuntime/contracts";
import { handleMemoryReviewCommand } from "../../src/interfaces/conversationRuntime/memoryReviewCommand";
import type {
  ConversationMemoryFactReviewResult,
  ConversationInboundMessage,
  ConversationMemoryReviewRequest,
  ConversationMemoryReviewRecord
} from "../../src/interfaces/conversationRuntime/managerContracts";
import type { ConversationSession } from "../../src/interfaces/sessionStore";
import { buildConversationIngressConfig } from "../helpers/conversationFixtures";

function buildSession(
  overrides: Partial<ConversationSession> = {}
): ConversationSession {
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-1",
      userId: "user-1",
      username: "owner",
      conversationVisibility: "private",
      receivedAt: "2026-03-08T12:00:00.000Z"
    }),
    ...overrides
  };
}

function buildMessage(
  text: string,
  visibility: ConversationInboundMessage["conversationVisibility"] = "private"
): ConversationInboundMessage {
  return {
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "owner",
    conversationVisibility: visibility,
    text,
    receivedAt: "2026-03-08T12:00:05.000Z"
  };
}

function buildDependencies(
  overrides: Partial<ConversationIngressDependencies> = {}
): ConversationIngressDependencies {
  return {
    store: {
      getSession: async () => null,
      setSession: async () => undefined
    },
    config: buildConversationIngressConfig({
      maxProposalInputChars: 500
    }),
    followUpRuleContext: {} as ConversationIngressDependencies["followUpRuleContext"],
    pulseLexicalRuleContext: {} as ConversationIngressDependencies["pulseLexicalRuleContext"],
    intentInterpreterConfidenceThreshold: 0.85,
    isWorkerActive: () => false,
    clearAckTimer: () => undefined,
    setWorkerBinding: () => undefined,
    startWorkerIfNeeded: async () => undefined,
    enqueueJob: () => ({
      reply: "queued",
      shouldStartWorker: true
    }),
    buildAutonomousExecutionInput: (goal) => goal,
    ...overrides
  };
}

function buildEpisode(
  overrides: Partial<ConversationMemoryReviewRecord> = {}
): ConversationMemoryReviewRecord {
  return {
    episodeId: "episode_owen_fall",
    title: "Owen fell down",
    summary: "Owen fell down a few weeks ago and the outcome was unresolved.",
    status: "unresolved",
    lastMentionedAt: "2026-03-07T10:00:00.000Z",
    resolvedAt: null,
    confidence: 0.92,
    sensitive: false,
    ...overrides
  };
}

function buildFactReviewResult(): ConversationMemoryFactReviewResult {
  return Object.assign(
    [
      {
        factId: "fact_preferred_name",
        key: "identity.preferred_name",
        value: "Avery",
        status: "confirmed",
        confidence: 0.98,
        sensitive: false,
        observedAt: "2026-04-03T18:20:00.000Z",
        lastUpdatedAt: "2026-04-03T18:20:00.000Z",
        decisionRecord: {
          family: "identity.preferred_name",
          evidenceClass: "user_explicit_fact",
          governanceAction: "allow_current_state",
          governanceReason: "explicit_user_fact",
          disposition: "selected_current_state",
          answerModeFallback: "report_current_state",
          candidateRefs: ["fact_preferred_name"],
          evidenceRefs: ["fact_preferred_name"]
        }
      }
    ],
    {
      hiddenDecisionRecords: [
        {
          family: "contact.entity_hint",
          evidenceClass: "user_hint_or_context",
          governanceAction: "support_only_legacy",
          governanceReason: "contact_entity_hint_requires_corroboration",
          disposition: "needs_corroboration",
          answerModeFallback: "report_insufficient_evidence",
          candidateRefs: ["candidate_hint_1"],
          evidenceRefs: ["hint_1"]
        }
      ],
      asOfObservedTime: "2026-04-03T18:20:00.000Z",
      asOfValidTime: undefined
    }
  ) as ConversationMemoryFactReviewResult;
}

test("handleMemoryReviewCommand blocks non-private usage", async () => {
  const reply = await handleMemoryReviewCommand(
    buildSession(),
    buildMessage("/memory", "public"),
    buildDependencies(),
    ""
  );

  assert.equal(reply, "The /memory command is only available in private conversations.");
});

test("handleMemoryReviewCommand renders bounded remembered situations", async () => {
  let capturedRequest: ConversationMemoryReviewRequest | null = null;

  const reply = await handleMemoryReviewCommand(
    buildSession(),
    buildMessage("/memory"),
    buildDependencies({
      reviewConversationMemory: async (request) => {
        capturedRequest = request;
        return [buildEpisode()];
      }
    }),
    ""
  );

  if (capturedRequest === null) {
    assert.fail("Expected memory review request to be captured.");
  }
  const request = capturedRequest as ConversationMemoryReviewRequest;
  assert.equal(request.maxEpisodes, 5);
  assert.match(reply, /^Remembered situations:/);
  assert.match(reply, /Owen fell down \(episode_owen_fall\)/);
  assert.match(reply, /\/memory resolve <episode-id>/);
});

test("handleMemoryReviewCommand renders help and usage deterministically", async () => {
  const reply = await handleMemoryReviewCommand(
    buildSession(),
    buildMessage("/memory help"),
    buildDependencies(),
    "help"
  );

  assert.match(reply, /^Usage: \/memory \[list\]/);
  assert.match(reply, /private-only/i);
  assert.match(reply, /\/memory fact <query>/);
});

test("handleMemoryReviewCommand routes resolve/wrong/forget mutations", async () => {
  const calls: string[] = [];

  const resolveReply = await handleMemoryReviewCommand(
    buildSession(),
    buildMessage("/memory resolve episode_owen_fall Owen recovered"),
    buildDependencies({
      resolveConversationMemoryEpisode: async (request) => {
        calls.push(`resolve:${request.episodeId}:${request.note}`);
        return buildEpisode({
          status: "resolved",
          resolvedAt: request.nowIso
        });
      }
    }),
    "resolve episode_owen_fall Owen recovered"
  );

  const wrongReply = await handleMemoryReviewCommand(
    buildSession(),
    buildMessage("/memory wrong episode_owen_fall Wrong Owen"),
    buildDependencies({
      markConversationMemoryEpisodeWrong: async (request) => {
        calls.push(`wrong:${request.episodeId}:${request.note}`);
        return buildEpisode({
          status: "no_longer_relevant"
        });
      }
    }),
    "wrong episode_owen_fall Wrong Owen"
  );

  const forgetReply = await handleMemoryReviewCommand(
    buildSession(),
    buildMessage("/memory forget episode_owen_fall"),
    buildDependencies({
      forgetConversationMemoryEpisode: async (request) => {
        calls.push(`forget:${request.episodeId}`);
        return buildEpisode();
      }
    }),
    "forget episode_owen_fall"
  );

  assert.deepEqual(calls, [
    "resolve:episode_owen_fall:Owen recovered",
    "wrong:episode_owen_fall:Wrong Owen",
    "forget:episode_owen_fall"
  ]);
  assert.equal(resolveReply, 'Marked "Owen fell down" as resolved.');
  assert.equal(wrongReply, 'Marked "Owen fell down" as no longer relevant.');
  assert.equal(forgetReply, 'Forgot "Owen fell down".');
});

test("handleMemoryReviewCommand renders bounded remembered facts through the private command path", async () => {
  const reply = await handleMemoryReviewCommand(
    buildSession(),
    buildMessage("/memory fact Avery"),
    buildDependencies({
      reviewConversationMemoryFacts: async (request) => {
        assert.equal(request.reviewTaskId, "memory_fact_review_2026_03_08T12_00_05_000Z");
        assert.equal(request.query, "Avery");
        assert.equal(request.maxFacts, 5);
        return buildFactReviewResult();
      }
    }),
    "fact Avery"
  );

  assert.match(reply, /^Remembered facts:/);
  assert.match(reply, /Current State:/);
  assert.match(reply, /identity\.preferred_name: Avery \(fact_preferred_name\)/);
  assert.match(reply, /Historical Context:\n- none/);
  assert.match(reply, /Ambiguity Notes:/);
  assert.match(reply, /held back until it has stronger corroboration/i);
  assert.match(reply, /\/memory fact correct <fact-id> <replacement value>/);
  assert.doesNotMatch(reply, /candidate_hint_1/);
  assert.doesNotMatch(reply, /hint_1/);
});

test("handleMemoryReviewCommand routes fact correction and forget mutations", async () => {
  const calls: string[] = [];

  const correctReply = await handleMemoryReviewCommand(
    buildSession(),
    buildMessage("/memory fact correct fact_preferred_name Ava"),
    buildDependencies({
      correctConversationMemoryFact: async (request) => {
        calls.push(`correct:${request.factId}:${request.replacementValue}`);
        return {
          factId: request.factId,
          key: "identity.preferred_name",
          value: request.replacementValue,
          status: "confirmed",
          confidence: 0.98,
          sensitive: false,
          observedAt: "2026-04-03T18:20:00.000Z",
          lastUpdatedAt: request.nowIso
        };
      }
    }),
    "fact correct fact_preferred_name Ava"
  );

  const forgetReply = await handleMemoryReviewCommand(
    buildSession(),
    buildMessage("/memory fact forget fact_preferred_name"),
    buildDependencies({
      forgetConversationMemoryFact: async (request) => {
        calls.push(`forget:${request.factId}`);
        return {
          factId: request.factId,
          key: "identity.preferred_name",
          value: "[redacted]",
          status: "superseded",
          confidence: 0.98,
          sensitive: false,
          observedAt: "2026-04-03T18:20:00.000Z",
          lastUpdatedAt: request.nowIso
        };
      }
    }),
    "fact forget fact_preferred_name"
  );

  assert.deepEqual(calls, [
    "correct:fact_preferred_name:Ava",
    "forget:fact_preferred_name"
  ]);
  assert.equal(correctReply, 'Updated remembered fact "identity.preferred_name" to "Ava".');
  assert.equal(forgetReply, 'Forgot remembered fact "identity.preferred_name".');
});

test("handleMemoryReviewCommand fails closed when runtime review support is unavailable", async () => {
  const listReply = await handleMemoryReviewCommand(
    buildSession(),
    buildMessage("/memory"),
    buildDependencies(),
    ""
  );
  const mutationReply = await handleMemoryReviewCommand(
    buildSession(),
    buildMessage("/memory resolve episode_owen_fall"),
    buildDependencies(),
    "resolve episode_owen_fall"
  );
  const factReply = await handleMemoryReviewCommand(
    buildSession(),
    buildMessage("/memory fact Avery"),
    buildDependencies(),
    "fact Avery"
  );

  assert.equal(listReply, "Memory review is unavailable in this runtime.");
  assert.equal(mutationReply, "Memory review is unavailable in this runtime.");
  assert.equal(factReply, "Memory review is unavailable in this runtime.");
});
