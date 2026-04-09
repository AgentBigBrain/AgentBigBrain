/**
 * @fileoverview Verifies Telegram gateway notifier wiring for native draft streaming and safe fallback modes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProfileMemoryQueryDecisionRecord } from "../../src/core/profileMemory";
import { TelegramAdapter } from "../../src/interfaces/telegramAdapter";
import type { ConversationOutboundDeliveryTrace } from "../../src/interfaces/conversationRuntime/managerContracts";
import {
  TelegramGateway,
  type TelegramOutboundDeliveryObservation
} from "../../src/interfaces/telegramGateway";
import { TelegramInterfaceConfig } from "../../src/interfaces/runtimeConfig";
import { buildTelegramInterfaceConfigFixture } from "../helpers/conversationFixtures";

interface TelegramGatewayTestHarness {
  createConversationNotifier(
    chatId: string,
    options: { nativeDraftStreamingAllowed: boolean },
    baseTrace?: {
      sessionKey?: string | null;
      inboundEventId?: string | null;
      inboundReceivedAt?: string | null;
    }
  ): {
    capabilities: {
      supportsEdit: boolean;
      supportsNativeStreaming: boolean;
    };
    send: (
      message: string,
      trace?: ConversationOutboundDeliveryTrace
    ) => Promise<{ ok: boolean; messageId: string | null; errorCode: string | null }>;
    stream?: (
      message: string,
      trace?: ConversationOutboundDeliveryTrace
    ) => Promise<{ ok: boolean; messageId: string | null; errorCode: string | null }>;
    edit?: (
      messageId: string,
      message: string,
      trace?: ConversationOutboundDeliveryTrace
    ) => Promise<{ ok: boolean; messageId: string | null; errorCode: string | null }>;
  };
}

/**
 * Implements `buildTelegramConfig` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildTelegramConfig(nativeDraftStreaming: boolean): TelegramInterfaceConfig {
  return buildTelegramInterfaceConfigFixture({
    streamingTransportMode: nativeDraftStreaming ? "native_draft" : "edit",
    nativeDraftStreaming
  });
}

/**
 * Implements `buildGateway` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildGateway(
  nativeDraftStreaming: boolean,
  onOutboundDelivery?: (event: TelegramOutboundDeliveryObservation) => void | Promise<void>
): TelegramGateway {
  return new TelegramGateway(
    {} as TelegramAdapter,
    buildTelegramConfig(nativeDraftStreaming),
    onOutboundDelivery ? { onOutboundDelivery } : {}
  );
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

test("telegram gateway notifier keeps edit transport when native draft streaming is disabled", () => {
  const gateway = buildGateway(false);
  const notifier = (gateway as unknown as TelegramGatewayTestHarness).createConversationNotifier(
    "12345",
    { nativeDraftStreamingAllowed: true }
  );

  assert.equal(notifier.capabilities.supportsEdit, true);
  assert.equal(notifier.capabilities.supportsNativeStreaming, false);
  assert.equal(typeof notifier.edit, "function");
  assert.equal(notifier.stream, undefined);
});

test("telegram gateway notifier keeps edit transport when native draft streaming is disallowed", () => {
  const gateway = buildGateway(true);
  const notifier = (gateway as unknown as TelegramGatewayTestHarness).createConversationNotifier(
    "12345",
    { nativeDraftStreamingAllowed: false }
  );

  assert.equal(notifier.capabilities.supportsEdit, true);
  assert.equal(notifier.capabilities.supportsNativeStreaming, false);
  assert.equal(typeof notifier.edit, "function");
  assert.equal(notifier.stream, undefined);
});

test("telegram gateway notifier uses sendMessageDraft transport when native draft streaming is enabled", async () => {
  const gateway = buildGateway(true);
  const notifier = (gateway as unknown as TelegramGatewayTestHarness).createConversationNotifier(
    "12345",
    { nativeDraftStreamingAllowed: true }
  );

  assert.equal(notifier.capabilities.supportsEdit, false);
  assert.equal(notifier.capabilities.supportsNativeStreaming, true);
  assert.equal(notifier.edit, undefined);
  assert.equal(typeof notifier.stream, "function");

  let capturedUrl = "";
  let capturedBody: { chat_id?: number; draft_id?: number; text?: string } | null = null;
  await withMockFetch(
    (async (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true })
      } as Response;
    }) as typeof fetch,
    async () => {
      const result = await notifier.stream!("Still working...");
      assert.equal(result.ok, true);
      assert.equal(result.messageId, null);
      assert.equal(result.errorCode, null);
    }
  );

  assert.match(capturedUrl, /\/bottelegram-token\/sendMessageDraft$/);
  if (capturedBody === null) {
    assert.fail("Expected Telegram draft request body to be captured.");
  }
  const body = capturedBody as { chat_id?: number; draft_id?: number; text?: string };
  assert.equal(body.chat_id, 12345);
  assert.equal(body.draft_id, 1);
  assert.equal(body.text, "Still working...");
});

test("telegram gateway outbound observer records successful send and edit deliveries", async () => {
  const observed: TelegramOutboundDeliveryObservation[] = [];
  const gateway = buildGateway(false, async (event) => {
    observed.push(event);
  });
  const notifier = (gateway as unknown as TelegramGatewayTestHarness).createConversationNotifier(
    "12345",
    { nativeDraftStreamingAllowed: true }
  );

  await withMockFetch(
    (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: {
          message_id: 88
        }
      })
    })) as unknown as typeof fetch,
    async () => {
      await notifier.send("hello there");
      await notifier.edit?.("88", "updated status");
    }
  );

  assert.deepEqual(
    observed.map((event) => ({
      kind: event.kind,
      sequence: event.sequence,
      source: event.source,
      chatId: event.chatId,
      text: event.text,
      messageId: event.messageId ?? null
    })),
    [
      {
        kind: "send",
        sequence: 1,
        source: null,
        chatId: "12345",
        text: "hello there",
        messageId: "88"
      },
      {
        kind: "edit",
        sequence: 2,
        source: null,
        chatId: "12345",
        text: "updated status",
        messageId: "88"
      }
    ]
  );
});

test("telegram gateway outbound observer records successful native draft deliveries", async () => {
  const observed: TelegramOutboundDeliveryObservation[] = [];
  const gateway = buildGateway(true, async (event) => {
    observed.push(event);
  });
  const notifier = (gateway as unknown as TelegramGatewayTestHarness).createConversationNotifier(
    "12345",
    { nativeDraftStreamingAllowed: true }
  );

  await withMockFetch(
    (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true })
    })) as unknown as typeof fetch,
    async () => {
      await notifier.stream?.("Still working...");
    }
  );

  assert.deepEqual(
    observed.map((event) => ({
      kind: event.kind,
      sequence: event.sequence,
      source: event.source,
      chatId: event.chatId,
      text: event.text,
      draftId: event.draftId ?? null
    })),
    [
      {
        kind: "draft",
        sequence: 1,
        source: null,
        chatId: "12345",
        text: "Still working...",
        draftId: 1
      }
    ]
  );
});

test("telegram gateway outbound observer failures do not perturb successful delivery", async () => {
  const gateway = buildGateway(false, async () => {
    throw new Error("observer boom");
  });
  const notifier = (gateway as unknown as TelegramGatewayTestHarness).createConversationNotifier(
    "12345",
    { nativeDraftStreamingAllowed: true }
  );

  await withMockFetch(
    (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: {
          message_id: 91
        }
      })
    })) as unknown as typeof fetch,
    async () => {
      const result = await notifier.send("hello despite observer failure");
      assert.deepEqual(result, {
        ok: true,
        messageId: "91",
        errorCode: null
      });
    }
  );
});

test("telegram gateway outbound observer merges base and per-send trace metadata", async () => {
  const observed: TelegramOutboundDeliveryObservation[] = [];
  const gateway = buildGateway(false, async (event) => {
    observed.push(event);
  });
  const notifier = (gateway as unknown as TelegramGatewayTestHarness).createConversationNotifier(
    "12345",
    { nativeDraftStreamingAllowed: true },
    {
      sessionKey: "telegram:12345:user-1",
      inboundEventId: "update-1",
      inboundReceivedAt: "2026-03-20T20:00:00.000Z"
    }
  );

  await withMockFetch(
    (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: {
          message_id: 92
        }
      })
    })) as unknown as typeof fetch,
    async () => {
      await notifier.send("final reply", {
        source: "worker_final",
        jobId: "job-1",
        jobCreatedAt: "2026-03-20T19:59:00.000Z"
      });
    }
  );

  assert.deepEqual(observed, [
    {
      kind: "send",
      chatId: "12345",
      text: "final reply",
      at: observed[0]!.at,
      sequence: 1,
      source: "worker_final",
      sessionKey: "telegram:12345:user-1",
      jobId: "job-1",
      jobCreatedAt: "2026-03-20T19:59:00.000Z",
      inboundEventId: "update-1",
      inboundReceivedAt: "2026-03-20T20:00:00.000Z",
      messageId: "92",
      draftId: undefined
    }
  ]);
});

test("telegram gateway wires bounded fact-review contracts into conversation manager", async () => {
  const captured = {
    review: null as null | readonly unknown[],
    correct: null as null | readonly unknown[],
    forget: null as null | readonly unknown[]
  };
  const gateway = new TelegramGateway(
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
    } as unknown as TelegramAdapter,
    buildTelegramConfig(false)
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
