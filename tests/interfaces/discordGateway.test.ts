/**
 * @fileoverview Verifies Discord gateway notifier wiring for edit-capable autonomous progress delivery.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProfileMemoryQueryDecisionRecord } from "../../src/core/profileMemory";
import { DiscordAdapter } from "../../src/interfaces/discordAdapter";
import { DiscordGateway } from "../../src/interfaces/discordGateway";
import { DiscordInterfaceConfig } from "../../src/interfaces/runtimeConfig";

interface DiscordGatewayTestHarness {
  createConversationNotifier(
    channelId: string
  ): {
    capabilities: {
      supportsEdit: boolean;
      supportsNativeStreaming: boolean;
    };
    send: (message: string) => Promise<{ ok: boolean; messageId: string | null; errorCode: string | null }>;
    edit?: (messageId: string, message: string) => Promise<{ ok: boolean; messageId: string | null; errorCode: string | null }>;
  };
}

/**
 * Implements `buildDiscordConfig` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildDiscordConfig(): DiscordInterfaceConfig {
  return {
    provider: "discord",
    security: {
      sharedSecret: "secret",
      allowedUsernames: ["agentowner"],
      allowedUserIds: [],
      rateLimitWindowMs: 60_000,
      maxEventsPerWindow: 10,
      replayCacheSize: 500,
      agentPulseTickIntervalMs: 30_000,
      ackDelayMs: 800,
      showTechnicalSummary: true,
      showSafetyCodes: true,
      showCompletionPrefix: false,
      followUpOverridePath: null,
      pulseLexicalOverridePath: null,
      allowAutonomousViaInterface: false,
      enableDynamicPulse: false,
      invocation: {
        requireNameCall: false,
        aliases: ["BigBrain"]
      }
    },
    botToken: "discord-token",
    apiBaseUrl: "https://discord.com/api/v10",
    gatewayUrl: "https://discord.com/api/v10/gateway/bot",
    intents: 37377,
    allowedChannelIds: []
  };
}

/**
 * Implements `buildGateway` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildGateway(): DiscordGateway {
  return new DiscordGateway({} as DiscordAdapter, buildDiscordConfig());
}

function buildFactDecisionRecord(
  overrides: Partial<ProfileMemoryQueryDecisionRecord> = {}
): ProfileMemoryQueryDecisionRecord {
  return {
    family: "generic.profile_fact",
    evidenceClass: "user_explicit_fact",
    governanceAction: "allow_current_state",
    governanceReason: "explicit_user_fact",
    disposition: "selected_current_state",
    answerModeFallback: "report_current_state",
    candidateRefs: ["candidate_fact_1"],
    evidenceRefs: ["fact_1"],
    ...overrides
  };
}

/**
 * Implements `withMockFetch` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withMockFetch(
  mockImplementation: typeof fetch,
  callback: () => Promise<void>
): Promise<void> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = mockImplementation;
  try {
    await callback();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("discord gateway notifier includes edit function for autonomous progress consolidation", () => {
  const gateway = buildGateway();
  const notifier = (gateway as unknown as DiscordGatewayTestHarness).createConversationNotifier(
    "12345"
  );

  assert.equal(notifier.capabilities.supportsEdit, false);
  assert.equal(notifier.capabilities.supportsNativeStreaming, false);
  assert.equal(typeof notifier.send, "function");
  assert.equal(typeof notifier.edit, "function");
});

test("discord gateway notifier edit uses message patch endpoint", async () => {
  const gateway = buildGateway();
  const notifier = (gateway as unknown as DiscordGatewayTestHarness).createConversationNotifier(
    "12345"
  );

  let capturedUrl = "";
  let capturedMethod = "";
  let capturedBody: Record<string, unknown> | null = null;
  await withMockFetch(
    (async (input, init) => {
      capturedUrl = String(input);
      capturedMethod = String(init?.method ?? "GET");
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "999" })
      } as Response;
    }) as typeof fetch,
    async () => {
      const result = await notifier.edit!("999", "updated progress");
      assert.equal(result.ok, true);
      assert.equal(result.messageId, "999");
      assert.equal(result.errorCode, null);
    }
  );

  assert.equal(capturedMethod, "PATCH");
  assert.match(capturedUrl, /\/channels\/12345\/messages\/999$/);
  assert.equal(capturedBody?.["content"], "updated progress");
});

test("discord gateway wires bounded fact-review contracts into conversation manager", async () => {
  const captured = {
    review: null as null | readonly unknown[],
    correct: null as null | readonly unknown[],
    forget: null as null | readonly unknown[]
  };
  const gateway = new DiscordGateway(
    {
      reviewConversationMemoryFacts: async (...args: unknown[]) => {
        captured.review = args;
        return Object.assign(
          [
            {
              factId: "fact_owen",
              key: "contact.owen.relationship",
              value: "friend",
              status: "confirmed",
              confidence: 0.94,
              sensitive: false,
              observedAt: "2026-03-31T12:00:00.000Z",
              lastUpdatedAt: "2026-03-31T12:00:00.000Z",
              decisionRecord: buildFactDecisionRecord()
            }
          ],
          {
            hiddenDecisionRecords: [
              buildFactDecisionRecord({
                family: "contact.entity_hint",
                evidenceClass: "user_hint_or_context",
                governanceAction: "support_only_legacy",
                governanceReason: "contact_entity_hint_requires_corroboration",
                disposition: "needs_corroboration",
                answerModeFallback: "report_insufficient_evidence",
                candidateRefs: ["candidate_hint_1"],
                evidenceRefs: ["hint_1"]
              })
            ]
          }
        );
      },
      correctConversationMemoryFact: async (...args: unknown[]) => {
        captured.correct = args;
        return {
          factId: "fact_owen",
          key: "contact.owen.relationship",
          value: "coworker",
          status: "confirmed",
          confidence: 0.95,
          sensitive: false,
          observedAt: "2026-03-31T12:00:00.000Z",
          lastUpdatedAt: "2026-03-31T12:05:00.000Z"
        };
      },
      forgetConversationMemoryFact: async (...args: unknown[]) => {
        captured.forget = args;
        return {
          factId: "fact_owen",
          key: "contact.owen.relationship",
          value: "[redacted]",
          status: "superseded",
          confidence: 0.95,
          sensitive: false,
          observedAt: "2026-03-31T12:00:00.000Z",
          lastUpdatedAt: "2026-03-31T12:06:00.000Z"
        };
      }
    } as unknown as DiscordAdapter,
    buildDiscordConfig()
  );
  const manager = (gateway as unknown as {
    conversationManager: {
      reviewConversationMemoryFacts?: (
        request: {
          reviewTaskId: string;
          query: string;
          nowIso: string;
          maxFacts?: number;
        }
      ) => Promise<ReadonlyArray<{ factId: string }> & { hiddenDecisionRecords: readonly unknown[] }>;
      correctConversationMemoryFact?: (
        request: {
          factId: string;
          replacementValue: string;
          nowIso: string;
          sourceTaskId: string;
          sourceText: string;
          note?: string;
        }
      ) => Promise<{ value: string } | null>;
      forgetConversationMemoryFact?: (
        request: {
          factId: string;
          nowIso: string;
          sourceTaskId: string;
          sourceText: string;
        }
      ) => Promise<{ status: string } | null>;
    };
  }).conversationManager;

  const reviewed = await manager.reviewConversationMemoryFacts?.({
    reviewTaskId: "review_fact_1",
    query: "what do you remember about Owen?",
    nowIso: "2026-03-31T12:10:00.000Z",
    maxFacts: 4
  });
  const corrected = await manager.correctConversationMemoryFact?.({
    factId: "fact_owen",
    replacementValue: "coworker",
    nowIso: "2026-03-31T12:11:00.000Z",
    sourceTaskId: "memory_correct_1",
    sourceText: "/memory fact correct fact_owen coworker",
    note: "Use the newer wording."
  });
  const forgotten = await manager.forgetConversationMemoryFact?.({
    factId: "fact_owen",
    nowIso: "2026-03-31T12:12:00.000Z",
    sourceTaskId: "memory_forget_1",
    sourceText: "/memory fact forget fact_owen"
  });

  assert.deepEqual(captured.review, [
    "review_fact_1",
    "what do you remember about Owen?",
    "2026-03-31T12:10:00.000Z",
    4
  ]);
  assert.equal(reviewed?.[0]?.factId, "fact_owen");
  assert.equal(reviewed?.hiddenDecisionRecords.length, 1);
  assert.deepEqual(captured.correct, [
    "fact_owen",
    "coworker",
    "memory_correct_1",
    "/memory fact correct fact_owen coworker",
    "2026-03-31T12:11:00.000Z",
    "Use the newer wording."
  ]);
  assert.equal(corrected?.value, "coworker");
  assert.deepEqual(captured.forget, [
    "fact_owen",
    "memory_forget_1",
    "/memory fact forget fact_owen",
    "2026-03-31T12:12:00.000Z"
  ]);
  assert.equal(forgotten?.status, "superseded");
});
