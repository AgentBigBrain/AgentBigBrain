/**
 * @fileoverview Tests interface session store persistence behavior for conversational proposal state.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ConversationSession,
  InterfaceSessionStore,
  appendPulseEmission,
  AgentPulseSessionState,
  computeUserStyleFingerprint,
  resolveUserLocalTime,
  detectTimezoneFromMessage,
  ConversationTurn
} from "../../src/interfaces/sessionStore";
import type { PulseEmissionRecordV1 } from "../../src/core/stage6_86PulseCandidates";
import { buildConversationSessionFixture } from "../helpers/conversationFixtures";

/**
 * Implements `buildSessionFixture` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildSessionFixture(overrides: Partial<ConversationSession> = {}): ConversationSession {
  const now = new Date().toISOString();
  return buildConversationSessionFixture(
    {
      updatedAt: now,
      activeProposal: {
        id: "proposal-1",
        originalInput: "watch email",
        currentInput: "watch email",
        createdAt: now,
        updatedAt: now,
        status: "pending"
      },
      conversationTurns: [
        {
          role: "user",
          text: "hello",
          at: now
        }
      ],
      classifierEvents: [
        {
          classifier: "follow_up",
          input: "plain text",
          at: now,
          isShortFollowUp: true,
          category: "ACK",
          confidenceTier: "MED",
          matchedRuleId: "follow_up_v1_contextual_short_reply",
          rulepackVersion: "FollowUpRulepackV1",
          intent: null
        }
      ],
      agentPulse: {
        ...buildConversationSessionFixture().agentPulse,
        optIn: true,
        lastPulseSentAt: now,
        lastPulseReason: "STALE_FACT_REVALIDATION",
        lastPulseTargetConversationId: "telegram:chat-1:user-1",
        lastDecisionCode: "ALLOWED",
        lastEvaluatedAt: now
      },
      ...overrides
    },
    {
      conversationId: "chat-1",
      receivedAt: now
    }
  );
}

test("session store persists and reloads conversation session state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-session-store-"));
  const sessionsPath = path.join(tempDir, "sessions.json");
  const session = buildSessionFixture();

  try {
    const store = new InterfaceSessionStore(sessionsPath);
    await store.setSession(session);

    const reloaded = new InterfaceSessionStore(sessionsPath);
    const loadedSession = await reloaded.getSession("telegram:chat-1:user-1");
    assert.ok(loadedSession);
    assert.equal(loadedSession?.activeProposal?.id, "proposal-1");
    assert.equal(loadedSession?.conversationTurns.length, 1);
    assert.equal(loadedSession?.classifierEvents?.length, 1);
    assert.equal(loadedSession?.agentPulse.optIn, true);
    assert.equal(loadedSession?.domainContext.conversationId, "telegram:chat-1:user-1");
    assert.equal(loadedSession?.domainContext.dominantLane, "unknown");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("session store migrates legacy conversation sessions to schema-versioned conversation stack state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-session-store-stack-migration-"));
  const sessionsPath = path.join(tempDir, "sessions.json");
  const now = new Date().toISOString();

  try {
    await writeFile(
      sessionsPath,
      JSON.stringify({
        conversations: {
          "telegram:chat-1:user-1": {
            conversationId: "telegram:chat-1:user-1",
            userId: "user-1",
            username: "agentowner",
            conversationVisibility: "private",
            updatedAt: now,
            activeProposal: null,
            runningJobId: null,
            queuedJobs: [],
            recentJobs: [],
            conversationTurns: [
              {
                role: "user",
                text: "Let's discuss sprint backlog priorities.",
                at: now
              },
              {
                role: "assistant",
                text: "Sprint backlog thread is active.",
                at: now
              }
            ],
            agentPulse: {
              optIn: false,
              mode: "private",
              routeStrategy: "last_private_used",
              lastPulseSentAt: null,
              lastPulseReason: null,
              lastPulseTargetConversationId: null,
              lastDecisionCode: "NOT_EVALUATED",
              lastEvaluatedAt: null
            }
          }
        }
      }),
      "utf8"
    );

    const store = new InterfaceSessionStore(sessionsPath);
    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.equal(session?.sessionSchemaVersion, "v2");
    assert.ok(session?.conversationStack);
    assert.equal(session?.conversationStack?.schemaVersion, "v1");
    assert.ok((session?.conversationStack?.threads.length ?? 0) >= 1);
    assert.ok(session?.conversationStack?.activeThreadKey);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("session store normalizes pulse lexical classifier telemetry events", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-session-store-pulse-classifier-"));
  const sessionsPath = path.join(tempDir, "sessions.json");
  const now = new Date().toISOString();

  try {
    await writeFile(
      sessionsPath,
      JSON.stringify({
        conversations: {
          "telegram:chat-1:user-1": {
            conversationId: "telegram:chat-1:user-1",
            userId: "user-1",
            username: "agentowner",
            conversationVisibility: "private",
            updatedAt: now,
            activeProposal: null,
            runningJobId: null,
            queuedJobs: [],
            recentJobs: [],
            conversationTurns: [],
            classifierEvents: [
              {
                classifier: "pulse_lexical",
                input: "turn on and turn off pulse reminders",
                at: now,
                isShortFollowUp: false,
                category: "UNCLEAR",
                confidenceTier: "LOW",
                matchedRuleId: "pulse_lexical_v1_conflicting_on_and_off",
                rulepackVersion: "PulseLexicalRulepackV1",
                intent: null,
                conflict: true
              }
            ],
            agentPulse: {
              optIn: false,
              mode: "private",
              routeStrategy: "last_private_used",
              lastPulseSentAt: null,
              lastPulseReason: null,
              lastPulseTargetConversationId: null,
              lastDecisionCode: "NOT_EVALUATED",
              lastEvaluatedAt: null
            }
          }
        }
      }),
      "utf8"
    );

    const store = new InterfaceSessionStore(sessionsPath);
    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    const pulseEvent = session?.classifierEvents?.find((event) => event.classifier === "pulse_lexical");
    assert.ok(pulseEvent);
    assert.equal(pulseEvent?.rulepackVersion, "PulseLexicalRulepackV1");
    assert.equal(pulseEvent?.matchedRuleId, "pulse_lexical_v1_conflicting_on_and_off");
    assert.equal(pulseEvent?.confidenceTier, "LOW");
    assert.equal(pulseEvent?.conflict, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("session store normalizes contextual lexical evidence on agent pulse state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-session-store-contextual-lexical-"));
  const sessionsPath = path.join(tempDir, "sessions.json");
  const now = new Date().toISOString();

  try {
    await writeFile(
      sessionsPath,
      JSON.stringify({
        conversations: {
          "telegram:chat-1:user-1": {
            conversationId: "telegram:chat-1:user-1",
            userId: "user-1",
            username: "agentowner",
            conversationVisibility: "private",
            updatedAt: now,
            activeProposal: null,
            runningJobId: null,
            queuedJobs: [],
            recentJobs: [],
            conversationTurns: [],
            classifierEvents: [],
            agentPulse: {
              optIn: true,
              mode: "private",
              routeStrategy: "last_private_used",
              lastPulseSentAt: null,
              lastPulseReason: "contextual_followup",
              lastPulseTargetConversationId: null,
              lastDecisionCode: "NO_CONTEXTUAL_LINKAGE",
              lastEvaluatedAt: now,
              lastContextualLexicalEvidence: {
                matchedRuleId: "contextual_followup_lexical_v1_cue_with_candidate_tokens",
                rulepackVersion: "ContextualFollowupLexicalRulepackV1",
                rulepackFingerprint: "abc123",
                confidenceTier: "MED",
                confidence: 0.712345,
                conflict: false,
                candidateTokens: ["Alpha", "beta", "beta", "  "],
                evaluatedAt: now
              }
            }
          }
        }
      }),
      "utf8"
    );

    const store = new InterfaceSessionStore(sessionsPath);
    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    const lexicalEvidence = session?.agentPulse.lastContextualLexicalEvidence;
    assert.ok(lexicalEvidence);
    assert.equal(
      lexicalEvidence?.matchedRuleId,
      "contextual_followup_lexical_v1_cue_with_candidate_tokens"
    );
    assert.equal(lexicalEvidence?.confidence, 0.7123);
    assert.deepEqual(lexicalEvidence?.candidateTokens, ["alpha", "beta"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("session store recovers from malformed state file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-session-store-bad-"));
  const sessionsPath = path.join(tempDir, "sessions.json");

  try {
    await writeFile(sessionsPath, "{not-valid-json", "utf8");
    const store = new InterfaceSessionStore(sessionsPath);
    const loadedSession = await store.getSession("telegram:chat-1:user-1");
    assert.equal(loadedSession, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("session store lists sessions and applies default agent pulse state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-session-store-list-"));
  const sessionsPath = path.join(tempDir, "sessions.json");

  try {
    const store = new InterfaceSessionStore(sessionsPath);
    const now = new Date().toISOString();
    await store.setSession(
      buildConversationSessionFixture(
        {
          updatedAt: now,
          agentPulse: {
            ...buildConversationSessionFixture().agentPulse,
            optIn: false
          }
        },
        {
          conversationId: "chat-1",
          receivedAt: now
        }
      )
    );

    await writeFile(
      sessionsPath,
      JSON.stringify({
        conversations: {
          "discord:chan-1:user-2": {
            conversationId: "discord:chan-1:user-2",
            userId: "user-2",
            username: "agentowner2",
            updatedAt: now,
            conversationVisibility: "public",
            activeProposal: null,
            runningJobId: null,
            queuedJobs: [],
            recentJobs: [],
            conversationTurns: []
          }
        }
      }),
      "utf8"
    );

    const reloaded = new InterfaceSessionStore(sessionsPath);
    const sessions = await reloaded.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].conversationId, "discord:chan-1:user-2");
    assert.equal(sessions[0].agentPulse.optIn, false);
    assert.equal(sessions[0].agentPulse.mode, "private");
    assert.equal(sessions[0].agentPulse.lastDecisionCode, "NOT_EVALUATED");
    assert.equal(sessions[0].conversationVisibility, "public");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("session store sqlite backend persists and reloads with json parity export", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-session-store-sqlite-"));
  const sessionsPath = path.join(tempDir, "sessions.json");
  const sqlitePath = path.join(tempDir, "ledgers.sqlite");
  const session = buildSessionFixture({
    conversationId: "discord:channel-7:user-9",
    userId: "user-9",
    username: "agentowner3"
  });

  try {
    const store = new InterfaceSessionStore(sessionsPath, {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: true
    });
    await store.setSession(session);

    const reloaded = new InterfaceSessionStore(sessionsPath, {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: true
    });
    const loaded = await reloaded.getSession(session.conversationId);
    assert.ok(loaded);
    assert.equal(loaded?.userId, "user-9");
    assert.equal(loaded?.activeProposal?.status, "pending");

    const jsonSnapshot = JSON.parse(await readFile(sessionsPath, "utf8")) as {
      conversations?: Record<string, ConversationSession>;
    };
    assert.ok(jsonSnapshot.conversations);
    assert.equal(jsonSnapshot.conversations?.[session.conversationId]?.username, "agentowner3");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("session store sqlite backend bootstraps from legacy json snapshot", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-session-store-sqlite-bootstrap-"));
  const sessionsPath = path.join(tempDir, "sessions.json");
  const sqlitePath = path.join(tempDir, "ledgers.sqlite");
  const legacySession = buildSessionFixture({
    conversationId: "telegram:legacy-chat:user-legacy",
    userId: "user-legacy",
    username: "legacyowner"
  });

  try {
    await writeFile(
      sessionsPath,
      JSON.stringify({
        conversations: {
          [legacySession.conversationId]: legacySession
        }
      }),
      "utf8"
    );

    const sqliteStore = new InterfaceSessionStore(sessionsPath, {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: false
    });

    const sessions = await sqliteStore.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].conversationId, legacySession.conversationId);

    const reloaded = new InterfaceSessionStore(sessionsPath, {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: false
    });
    const loaded = await reloaded.getSession(legacySession.conversationId);
    assert.ok(loaded);
    assert.equal(loaded?.username, "legacyowner");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("recentEmissions defaults to empty array on new session", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-session-emissions-"));
  try {
    const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
    const session = buildSessionFixture({ conversationId: "test-conv-1" });
    await store.setSession(session);
    const loaded = await store.getSession("test-conv-1");
    assert.ok(loaded);
    assert.ok(Array.isArray(loaded.agentPulse.recentEmissions));
    assert.equal(loaded.agentPulse.recentEmissions!.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("appendPulseEmission caps at 10 entries", () => {
  const state: AgentPulseSessionState = {
    optIn: true,
    mode: "private",
    routeStrategy: "last_private_used",
    lastPulseSentAt: null,
    lastPulseReason: null,
    lastPulseTargetConversationId: null,
    lastDecisionCode: "NOT_EVALUATED",
    lastEvaluatedAt: null,
    recentEmissions: []
  };

  for (let i = 0; i < 15; i++) {
    const record: PulseEmissionRecordV1 = {
      emittedAt: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
      reasonCode: "OPEN_LOOP_RESUME",
      candidateEntityRefs: [`entity-${i}`]
    };
    appendPulseEmission(state, record);
  }

  assert.equal(state.recentEmissions!.length, 10);
  assert.equal(state.recentEmissions![0].candidateEntityRefs[0], "entity-5");
  assert.equal(state.recentEmissions![9].candidateEntityRefs[0], "entity-14");
});

test("computeUserStyleFingerprint returns casual for short informal messages", () => {
  const turns: ConversationTurn[] = [
    { role: "user", text: "hey whats up", at: "2026-01-01T00:00:00.000Z" },
    { role: "user", text: "lol yeah", at: "2026-01-01T00:01:00.000Z" },
    { role: "user", text: "cool thx", at: "2026-01-01T00:02:00.000Z" },
    { role: "user", text: "yo btw", at: "2026-01-01T00:03:00.000Z" },
    { role: "user", text: "nah im good", at: "2026-01-01T00:04:00.000Z" }
  ];
  const fingerprint = computeUserStyleFingerprint(turns);
  assert.ok(fingerprint.includes("short messages"), `expected 'short messages' in '${fingerprint}'`);
  assert.ok(fingerprint.includes("casual"), `expected 'casual' in '${fingerprint}'`);
});

test("computeUserStyleFingerprint returns formal for long structured messages", () => {
  const turns: ConversationTurn[] = [
    { role: "user", text: "I would like to request a comprehensive analysis of the current project architecture including dependency graphs, module boundaries, and inter-service communication patterns across all deployed environments.", at: "2026-01-01T00:00:00.000Z" },
    { role: "user", text: "Please ensure that the documentation is thoroughly updated to accurately reflect all recent changes in the governance module structure, including the new safety constraint additions and their integration points.", at: "2026-01-01T00:01:00.000Z" },
    { role: "user", text: "Could you provide a comprehensive and detailed summary of the testing coverage metrics across the full stage-6 checkpoint validation suite, including boundary-layer and runtime-path evidence categorization?", at: "2026-01-01T00:02:00.000Z" }
  ];
  const fingerprint = computeUserStyleFingerprint(turns);
  assert.ok(fingerprint.includes("detailed messages"), `expected 'detailed messages' in '${fingerprint}'`);
  assert.ok(fingerprint.includes("formal"), `expected 'formal' in '${fingerprint}'`);
});

test("computeUserStyleFingerprint returns unknown style for empty turns", () => {
  assert.equal(computeUserStyleFingerprint([]), "unknown style");
});

test("resolveUserLocalTime with valid IANA string returns formatted time", () => {
  const result = resolveUserLocalTime("America/New_York", "2026-06-15T14:30:00.000Z");
  assert.ok(result.formatted.length > 0, "formatted should not be empty");
  assert.ok(result.dayOfWeek.length > 0, "dayOfWeek should not be empty");
  assert.ok(typeof result.hour === "number", "hour should be a number");
  assert.ok(result.hour >= 0 && result.hour < 24, "hour should be 0-23");
});

test("resolveUserLocalTime with undefined falls back to system clock", () => {
  const result = resolveUserLocalTime(undefined, "2026-06-15T14:30:00.000Z");
  assert.ok(result.formatted.length > 0, "formatted should not be empty");
  assert.ok(result.dayOfWeek.length > 0, "dayOfWeek should not be empty");
});

test("resolveUserLocalTime with invalid IANA falls back to system clock", () => {
  const result = resolveUserLocalTime("Not/A/Timezone", "2026-06-15T14:30:00.000Z");
  assert.ok(result.formatted.length > 0);
});

test("detectTimezoneFromMessage detects EST mention", () => {
  assert.equal(detectTimezoneFromMessage("I'm in EST"), "America/New_York");
});

test("detectTimezoneFromMessage detects bare PST abbreviation", () => {
  assert.equal(detectTimezoneFromMessage("my timezone is PST"), "America/Los_Angeles");
});

test("detectTimezoneFromMessage detects city name", () => {
  assert.equal(detectTimezoneFromMessage("I am in Tokyo right now"), "Asia/Tokyo");
});

test("detectTimezoneFromMessage returns null for unrelated text", () => {
  assert.equal(detectTimezoneFromMessage("Tell me about the project"), null);
});

test("detectTimezoneFromMessage detects I'm in Pacific", () => {
  assert.equal(detectTimezoneFromMessage("I'm in Pacific time"), "America/Los_Angeles");
});

test("normalizeRecentEmissions preserves responseOutcome and generatedSnippet", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-session-emission-fields-"));
  try {
    const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
    const session = buildSessionFixture({
      conversationId: "test-conv-emission-fields",
      agentPulse: {
        optIn: true,
        mode: "private",
        routeStrategy: "last_private_used",
        lastPulseSentAt: null,
        lastPulseReason: null,
        lastPulseTargetConversationId: null,
        lastDecisionCode: "NOT_EVALUATED",
        lastEvaluatedAt: null,
        recentEmissions: [
          {
            emittedAt: "2026-01-01T00:00:00.000Z",
            reasonCode: "OPEN_LOOP_RESUME",
            candidateEntityRefs: ["entity-1"],
            responseOutcome: "engaged",
            generatedSnippet: "Hey, how's the project going?"
          }
        ]
      }
    });
    await store.setSession(session);

    const loaded = await store.getSession("test-conv-emission-fields");
    assert.ok(loaded);
    const emissions = loaded!.agentPulse.recentEmissions!;
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].responseOutcome, "engaged");
    assert.equal(emissions[0].generatedSnippet, "Hey, how's the project going?");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("userTimezone and userStyleFingerprint persist through session store", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-session-tz-style-"));
  try {
    const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
    const session = buildSessionFixture({
      conversationId: "test-conv-tz-style",
      agentPulse: {
        optIn: true,
        mode: "private",
        routeStrategy: "last_private_used",
        lastPulseSentAt: null,
        lastPulseReason: null,
        lastPulseTargetConversationId: null,
        lastDecisionCode: "NOT_EVALUATED",
        lastEvaluatedAt: null,
        recentEmissions: [],
        userTimezone: "America/New_York",
        userStyleFingerprint: "casual, short messages"
      }
    });
    await store.setSession(session);

    const loaded = await store.getSession("test-conv-tz-style");
    assert.ok(loaded);
    assert.equal(loaded!.agentPulse.userTimezone, "America/New_York");
    assert.equal(loaded!.agentPulse.userStyleFingerprint, "casual, short messages");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
