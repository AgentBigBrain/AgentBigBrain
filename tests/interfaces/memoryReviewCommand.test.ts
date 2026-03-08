/**
 * @fileoverview Tests bounded private `/memory` command handling.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import type { ConversationIngressDependencies } from "../../src/interfaces/conversationRuntime/contracts";
import { handleMemoryReviewCommand } from "../../src/interfaces/conversationRuntime/memoryReviewCommand";
import type {
  ConversationInboundMessage,
  ConversationMemoryReviewRecord
} from "../../src/interfaces/conversationRuntime/managerContracts";
import type { ConversationSession } from "../../src/interfaces/sessionStore";

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
    config: {
      allowAutonomousViaInterface: true,
      maxProposalInputChars: 500,
      maxConversationTurns: 20,
      maxContextTurnsForExecution: 8,
      staleRunningJobRecoveryMs: 60_000,
      maxRecentJobs: 20
    },
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
    episodeId: "episode_billy_fall",
    title: "Billy fell down",
    summary: "Billy fell down a few weeks ago and the outcome was unresolved.",
    status: "unresolved",
    lastMentionedAt: "2026-03-07T10:00:00.000Z",
    resolvedAt: null,
    confidence: 0.92,
    sensitive: false,
    ...overrides
  };
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
  let capturedRequest: Parameters<NonNullable<ConversationIngressDependencies["reviewConversationMemory"]>>[0] | null =
    null;

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

  assert.ok(capturedRequest);
  assert.equal(capturedRequest?.maxEpisodes, 5);
  assert.match(reply, /^Remembered situations:/);
  assert.match(reply, /Billy fell down \(episode_billy_fall\)/);
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
});

test("handleMemoryReviewCommand routes resolve/wrong/forget mutations", async () => {
  const calls: string[] = [];

  const resolveReply = await handleMemoryReviewCommand(
    buildSession(),
    buildMessage("/memory resolve episode_billy_fall Billy recovered"),
    buildDependencies({
      resolveConversationMemoryEpisode: async (request) => {
        calls.push(`resolve:${request.episodeId}:${request.note}`);
        return buildEpisode({
          status: "resolved",
          resolvedAt: request.nowIso
        });
      }
    }),
    "resolve episode_billy_fall Billy recovered"
  );

  const wrongReply = await handleMemoryReviewCommand(
    buildSession(),
    buildMessage("/memory wrong episode_billy_fall Wrong Billy"),
    buildDependencies({
      markConversationMemoryEpisodeWrong: async (request) => {
        calls.push(`wrong:${request.episodeId}:${request.note}`);
        return buildEpisode({
          status: "no_longer_relevant"
        });
      }
    }),
    "wrong episode_billy_fall Wrong Billy"
  );

  const forgetReply = await handleMemoryReviewCommand(
    buildSession(),
    buildMessage("/memory forget episode_billy_fall"),
    buildDependencies({
      forgetConversationMemoryEpisode: async (request) => {
        calls.push(`forget:${request.episodeId}`);
        return buildEpisode();
      }
    }),
    "forget episode_billy_fall"
  );

  assert.deepEqual(calls, [
    "resolve:episode_billy_fall:Billy recovered",
    "wrong:episode_billy_fall:Wrong Billy",
    "forget:episode_billy_fall"
  ]);
  assert.equal(resolveReply, 'Marked "Billy fell down" as resolved.');
  assert.equal(wrongReply, 'Marked "Billy fell down" as no longer relevant.');
  assert.equal(forgetReply, 'Forgot "Billy fell down".');
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
    buildMessage("/memory resolve episode_billy_fall"),
    buildDependencies(),
    "resolve episode_billy_fall"
  );

  assert.equal(listReply, "Memory review is unavailable in this runtime.");
  assert.equal(mutationReply, "Memory review is unavailable in this runtime.");
});
