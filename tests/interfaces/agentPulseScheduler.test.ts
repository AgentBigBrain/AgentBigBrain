/**
 * @fileoverview Tests deterministic Agent Pulse scheduler behavior for provider filtering, opt-in gating, and proactive enqueue/update flows.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createEmptyConversationDomainContext } from "../../src/core/sessionContext";
import { AgentPulseScheduler } from "../../src/interfaces/agentPulseScheduler";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import { ConversationSession, InterfaceSessionStore } from "../../src/interfaces/sessionStore";
import { AgentPulseEvaluationResult } from "../../src/core/profileMemoryStore";
import { EntityGraphV1, ConversationStackV1 } from "../../src/core/types";

/**
 * Implements `buildSession` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildSession(
  conversationId: string,
  overrides: Partial<ConversationSession> = {}
): ConversationSession {
  const nowIso = new Date().toISOString();
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: conversationId.split(":")[1] ?? conversationId,
      userId: "user-1",
      username: "agentowner",
      conversationVisibility: "private",
      receivedAt: nowIso
    }),
    conversationId,
    updatedAt: nowIso,
    agentPulse: {
      ...buildSessionSeed({
        provider: "telegram",
        conversationId: "chat-1",
        userId: "user-1",
        username: "agentowner",
        conversationVisibility: "private",
        receivedAt: nowIso
      }).agentPulse,
      optIn: true
    },
    ...overrides
  };
}

/**
 * Implements `buildPulseEvaluation` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildPulseEvaluation(
  overrides: Partial<AgentPulseEvaluationResult>
): AgentPulseEvaluationResult {
  return {
    decision: {
      allowed: true,
      decisionCode: "ALLOWED",
      suppressedBy: [],
      nextEligibleAtIso: null
    },
    staleFactCount: 0,
    unresolvedCommitmentCount: 0,
    unresolvedCommitmentTopics: [],
    relevantEpisodes: [],
    relationship: {
      role: "unknown",
      roleFactId: null
    },
    contextDrift: {
      detected: false,
      domains: [],
      requiresRevalidation: false
    },
    ...overrides
  };
}

function buildWorkflowDomainContext(conversationId: string): ConversationSession["domainContext"] {
  return {
    ...createEmptyConversationDomainContext(conversationId),
    dominantLane: "workflow",
    continuitySignals: {
      activeWorkspace: true,
      returnHandoff: false,
      modeContinuity: true
    },
    activeSince: "2026-03-01T12:00:00.000Z",
    lastUpdatedAt: "2026-03-01T12:00:00.000Z"
  };
}

test("agent pulse scheduler skips sessions when not opted in", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-scheduler-skip-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  await store.setSession(
    buildSession("telegram:chat-1:user-1", {
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
    })
  );

  let evaluateCalls = 0;
  let enqueueCalls = 0;
  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () => {
          evaluateCalls += 1;
          return buildPulseEvaluation({
            decision: {
              allowed: true,
              decisionCode: "ALLOWED",
              suppressedBy: [],
              nextEligibleAtIso: null
            },
            staleFactCount: 1,
            unresolvedCommitmentCount: 1
          });
        },
        enqueueSystemJob: async () => {
          enqueueCalls += 1;
          return true;
        },
        updatePulseState: async () => { }
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["unresolved_commitment", "stale_fact_revalidation"]
      }
    );

    await scheduler.runTickOnce();

    assert.equal(evaluateCalls, 0);
    assert.equal(enqueueCalls, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("agent pulse scheduler enqueues proactive job and updates pulse state when allowed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-scheduler-allow-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  await store.setSession(buildSession("telegram:chat-1:user-1"));

  const queuedPrompts: string[] = [];
  const updates: Array<{ key: string; lastDecisionCode?: string; lastPulseReason?: string | null }> = [];
  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () => ({
          ...buildPulseEvaluation({
            decision: {
              allowed: true,
              decisionCode: "ALLOWED",
              suppressedBy: [],
              nextEligibleAtIso: null
            },
            staleFactCount: 2,
            unresolvedCommitmentCount: 1,
            unresolvedCommitmentTopics: ["tax filing"]
          })
        }),
        enqueueSystemJob: async (_session, systemInput) => {
          queuedPrompts.push(systemInput);
          return true;
        },
        updatePulseState: async (key, update) => {
          updates.push({
            key,
            lastDecisionCode: update.lastDecisionCode,
            lastPulseReason: update.lastPulseReason
          });
        }
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["unresolved_commitment", "stale_fact_revalidation"]
      }
    );

    await scheduler.runTickOnce();

    assert.equal(queuedPrompts.length, 1);
    assert.ok(queuedPrompts[0].includes("Agent Pulse proactive check-in request."));
    assert.ok(queuedPrompts[0].includes("Reason code: unresolved_commitment"));
    assert.ok(queuedPrompts[0].includes("Unresolved commitment topics: tax filing"));
    assert.ok(
      queuedPrompts[0].includes(
        "focus only on the listed topics and avoid unrelated recent topics"
      )
    );
    assert.equal(updates.length, 1);
    assert.equal(updates[0].key, "telegram:chat-1:user-1");
    assert.equal(updates[0].lastDecisionCode, "ALLOWED");
    assert.equal(updates[0].lastPulseReason, "unresolved_commitment");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("agent pulse scheduler relationship-aware temporal nudging includes role taxonomy and context drift revalidation directives", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-scheduler-relationship-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  await store.setSession(buildSession("telegram:chat-1:user-1"));

  const queuedPrompts: string[] = [];
  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () =>
          buildPulseEvaluation({
            decision: {
              allowed: true,
              decisionCode: "ALLOWED",
              suppressedBy: [],
              nextEligibleAtIso: null
            },
            staleFactCount: 2,
            unresolvedCommitmentCount: 1,
            relationship: {
              role: "manager",
              roleFactId: "profile_fact_manager"
            },
            contextDrift: {
              detected: true,
              domains: ["job", "team"],
              requiresRevalidation: true
            }
          }),
        enqueueSystemJob: async (_session, systemInput) => {
          queuedPrompts.push(systemInput);
          return true;
        },
        updatePulseState: async () => { }
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["unresolved_commitment"]
      }
    );

    await scheduler.runTickOnce();

    assert.equal(queuedPrompts.length, 1);
    assert.ok(queuedPrompts[0].includes("Relationship role taxonomy: manager"));
    assert.ok(
      queuedPrompts[0].includes(
        "Context drift: detected=true; domains=job, team; requiresRevalidation=true"
      )
    );
    assert.ok(
      queuedPrompts[0].includes(
        "Ask one concise revalidation question before making assumptions."
      )
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("agent pulse scheduler relationship-aware contextual follow-up includes side-thread linkage and revalidation-required follow-up directives", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-scheduler-contextual-relationship-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const nowMs = Date.now();
  await store.setSession(
    buildSession("telegram:chat-contextual:user-1", {
      conversationTurns: [
        {
          role: "user",
          text: "remind me later about alpha beta gamma issue",
          at: new Date(nowMs - 5 * 60 * 1000).toISOString()
        },
        {
          role: "assistant",
          text: "I can check back on that.",
          at: new Date(nowMs - 4 * 60 * 1000).toISOString()
        },
        {
          role: "user",
          text: "thanks, let us switch topics for now.",
          at: new Date(nowMs - 3 * 60 * 1000).toISOString()
        }
      ]
    })
  );

  const queuedPrompts: string[] = [];
  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () =>
          buildPulseEvaluation({
            decision: {
              allowed: true,
              decisionCode: "ALLOWED",
              suppressedBy: [],
              nextEligibleAtIso: null
            },
            relationship: {
              role: "friend",
              roleFactId: "profile_fact_friend"
            },
            contextDrift: {
              detected: true,
              domains: ["team"],
              requiresRevalidation: true
            }
          }),
        enqueueSystemJob: async (_session, systemInput) => {
          queuedPrompts.push(systemInput);
          return true;
        },
        updatePulseState: async () => { }
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["contextual_followup"]
      }
    );

    await scheduler.runTickOnce();

    assert.equal(queuedPrompts.length, 1);
    assert.ok(queuedPrompts[0].includes("Contextual follow-up nudge: enabled."));
    assert.ok(queuedPrompts[0].includes("Topic linkage confidence:"));
    assert.ok(queuedPrompts[0].includes("Side-thread linkage: present"));
    assert.ok(queuedPrompts[0].includes("Revalidation-required follow-up: yes"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("agent pulse scheduler persists contextual lexical metadata in state updates and keeps it out of pulse prompt text", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-scheduler-contextual-lexical-meta-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const nowMs = Date.now();
  await store.setSession(
    buildSession("telegram:chat-contextual-meta:user-1", {
      conversationTurns: [
        {
          role: "user",
          text: "remind me later about alpha beta gamma issue",
          at: new Date(nowMs - 5 * 60 * 1000).toISOString()
        },
        {
          role: "assistant",
          text: "Acknowledged.",
          at: new Date(nowMs - 4 * 60 * 1000).toISOString()
        },
        {
          role: "user",
          text: "thanks",
          at: new Date(nowMs - 3 * 60 * 1000).toISOString()
        }
      ]
    })
  );

  const queuedPrompts: string[] = [];
  const updates: Array<{
    key: string;
    evidence?: ConversationSession["agentPulse"]["lastContextualLexicalEvidence"];
  }> = [];
  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () =>
          buildPulseEvaluation({
            decision: {
              allowed: true,
              decisionCode: "ALLOWED",
              suppressedBy: [],
              nextEligibleAtIso: null
            }
          }),
        enqueueSystemJob: async (_session, systemInput) => {
          queuedPrompts.push(systemInput);
          return true;
        },
        updatePulseState: async (key, update) => {
          updates.push({
            key,
            evidence: update.lastContextualLexicalEvidence
          });
        }
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["contextual_followup"]
      }
    );

    await scheduler.runTickOnce();

    assert.equal(queuedPrompts.length, 1);
    assert.doesNotMatch(queuedPrompts[0], /contextual_followup_lexical_v1/i);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].key, "telegram:chat-contextual-meta:user-1");
    assert.equal(
      updates[0].evidence?.matchedRuleId,
      "contextual_followup_lexical_v1_cue_with_candidate_tokens"
    );
    assert.equal(updates[0].evidence?.candidateTokens.includes("alpha"), true);
    assert.equal(updates[0].evidence?.candidateTokens.includes("beta"), true);
    assert.equal(updates[0].evidence?.candidateTokens.includes("gamma"), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("agent pulse scheduler contextual follow-up nudge enforces topic linkage confidence and contextual-follow-up cooldown", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-scheduler-contextual-cooldown-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const nowMs = Date.now();
  const recentCreatedAt = new Date(nowMs - 5 * 60 * 1000).toISOString();
  const recentStartedAt = new Date(nowMs - 4 * 60 * 1000).toISOString();
  const recentCompletedAt = new Date(nowMs - 3 * 60 * 1000).toISOString();
  await store.setSession(
    buildSession("telegram:chat-contextual-cooldown:user-1", {
      conversationTurns: [
        {
          role: "user",
          text: "remind me later about alpha beta gamma issue",
          at: new Date(nowMs - 6 * 60 * 1000).toISOString()
        },
        {
          role: "assistant",
          text: "Sounds good.",
          at: new Date(nowMs - 5 * 60 * 1000).toISOString()
        },
        {
          role: "user",
          text: "we can discuss something else now",
          at: new Date(nowMs - 4.5 * 60 * 1000).toISOString()
        }
      ],
      recentJobs: [
        {
          id: "job_prev_contextual",
          input: [
            "Agent Pulse proactive check-in request.",
            "Reason code: contextual_followup",
            "Contextual topic key: alpha_beta_gamma"
          ].join("\n"),
          createdAt: recentCreatedAt,
          startedAt: recentStartedAt,
          completedAt: recentCompletedAt,
          status: "completed",
          resultSummary: "done",
          errorMessage: null,
          ackTimerGeneration: 0,
          ackEligibleAt: null,
          ackLifecycleState: "FINAL_SENT_NO_EDIT",
          ackMessageId: null,
          ackSentAt: null,
          ackEditAttemptCount: 0,
          ackLastErrorCode: null,
          finalDeliveryOutcome: "sent",
          finalDeliveryAttemptCount: 1,
          finalDeliveryLastErrorCode: null,
          finalDeliveryLastAttemptAt: recentCompletedAt
        }
      ]
    })
  );

  let enqueueCalls = 0;
  const updates: Array<{ key: string; lastDecisionCode?: string }> = [];
  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () =>
          buildPulseEvaluation({
            decision: {
              allowed: true,
              decisionCode: "ALLOWED",
              suppressedBy: [],
              nextEligibleAtIso: null
            }
          }),
        enqueueSystemJob: async () => {
          enqueueCalls += 1;
          return true;
        },
        updatePulseState: async (key, update) => {
          updates.push({
            key,
            lastDecisionCode: update.lastDecisionCode
          });
        }
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["contextual_followup"]
      }
    );

    await scheduler.runTickOnce();

    assert.equal(enqueueCalls, 0);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].key, "telegram:chat-contextual-cooldown:user-1");
    assert.equal(updates[0].lastDecisionCode, "CONTEXTUAL_TOPIC_COOLDOWN");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("agent pulse scheduler records suppression decision when no reason is allowed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-scheduler-deny-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  await store.setSession(buildSession("discord:chan-1:user-1"));

  let enqueueCalls = 0;
  const updates: Array<{ key: string; lastDecisionCode?: string }> = [];
  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "discord",
        sessionStore: store,
        evaluateAgentPulse: async () => ({
          ...buildPulseEvaluation({
            decision: {
              allowed: false,
              decisionCode: "RATE_LIMIT",
              suppressedBy: ["policy.min_interval"],
              nextEligibleAtIso: "2026-02-23T16:00:00.000Z"
            },
            staleFactCount: 1,
            unresolvedCommitmentCount: 1
          })
        }),
        enqueueSystemJob: async () => {
          enqueueCalls += 1;
          return true;
        },
        updatePulseState: async (key, update) => {
          updates.push({
            key,
            lastDecisionCode: update.lastDecisionCode
          });
        }
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["unresolved_commitment", "stale_fact_revalidation"]
      }
    );

    await scheduler.runTickOnce();

    assert.equal(enqueueCalls, 0);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].key, "discord:chan-1:user-1");
    assert.equal(updates[0].lastDecisionCode, "RATE_LIMIT");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("agent pulse scheduler suppresses stale-fact legacy pulses during workflow continuity", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-scheduler-workflow-legacy-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  await store.setSession(
    buildSession("telegram:chat-workflow-legacy:user-1", {
      domainContext: buildWorkflowDomainContext("telegram:chat-workflow-legacy:user-1")
    })
  );

  let evaluateCalls = 0;
  let enqueueCalls = 0;
  const updates: Array<{ key: string; lastDecisionCode?: string; lastPulseReason?: string | null }> = [];
  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () => {
          evaluateCalls += 1;
          return buildPulseEvaluation({});
        },
        enqueueSystemJob: async () => {
          enqueueCalls += 1;
          return true;
        },
        updatePulseState: async (key, update) => {
          updates.push({
            key,
            lastDecisionCode: update.lastDecisionCode,
            lastPulseReason: update.lastPulseReason
          });
        },
        enableDynamicPulse: false
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["stale_fact_revalidation", "unresolved_commitment"]
      }
    );

    await scheduler.runTickOnce();

    assert.equal(evaluateCalls, 1);
    assert.equal(enqueueCalls, 1);
    assert.ok(
      updates.some(
        (update) =>
          update.key === "telegram:chat-workflow-legacy:user-1" &&
          update.lastDecisionCode === "ALLOWED" &&
          update.lastPulseReason === "unresolved_commitment"
      )
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("agent pulse scheduler preserves highest-priority suppression reason", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-scheduler-priority-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  await store.setSession(buildSession("discord:chan-1:user-1"));

  const updates: Array<{
    key: string;
    lastDecisionCode?: string;
    lastPulseReason?: string | null;
  }> = [];
  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "discord",
        sessionStore: store,
        evaluateAgentPulse: async (request) => {
          if (request.reason === "unresolved_commitment") {
            return buildPulseEvaluation({
              decision: {
                allowed: false,
                decisionCode: "QUIET_HOURS",
                suppressedBy: ["policy.quiet_hours"],
                nextEligibleAtIso: null
              },
              unresolvedCommitmentCount: 1
            });
          }
          return buildPulseEvaluation({
            decision: {
              allowed: false,
              decisionCode: "NO_STALE_FACTS",
              suppressedBy: ["reason.requires_stale_fact"],
              nextEligibleAtIso: null
            },
            staleFactCount: 0,
            unresolvedCommitmentCount: 1
          });
        },
        enqueueSystemJob: async () => false,
        updatePulseState: async (key, update) => {
          updates.push({
            key,
            lastDecisionCode: update.lastDecisionCode,
            lastPulseReason: update.lastPulseReason
          });
        }
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["unresolved_commitment", "stale_fact_revalidation"]
      }
    );

    await scheduler.runTickOnce();

    assert.equal(updates.length, 1);
    assert.equal(updates[0].key, "discord:chan-1:user-1");
    assert.equal(updates[0].lastDecisionCode, "QUIET_HOURS");
    assert.equal(updates[0].lastPulseReason, "unresolved_commitment");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("agent pulse scheduler filters sessions by provider prefix", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-scheduler-provider-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  await store.setSession(buildSession("telegram:chat-1:user-1"));
  await store.setSession(buildSession("discord:chan-1:user-1"));

  const evaluatedSessionKeys: string[] = [];
  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () => ({
          ...buildPulseEvaluation({
            decision: {
              allowed: false,
              decisionCode: "DISABLED",
              suppressedBy: ["policy.disabled"],
              nextEligibleAtIso: null
            },
            staleFactCount: 0,
            unresolvedCommitmentCount: 0
          })
        }),
        enqueueSystemJob: async (session) => {
          evaluatedSessionKeys.push(session.conversationId);
          return false;
        },
        updatePulseState: async (key) => {
          evaluatedSessionKeys.push(key);
        }
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["user_requested_followup"]
      }
    );

    await scheduler.runTickOnce();

    assert.ok(evaluatedSessionKeys.every((key) => key.startsWith("telegram:")));
    assert.equal(evaluatedSessionKeys.some((key) => key.startsWith("discord:")), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("agent pulse scheduler suppresses private mode when no private route exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-scheduler-no-private-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  await store.setSession(
    buildSession("discord:chan-public:user-1", {
      conversationVisibility: "public",
      agentPulse: {
        optIn: true,
        mode: "private",
        routeStrategy: "last_private_used",
        lastPulseSentAt: null,
        lastPulseReason: null,
        lastPulseTargetConversationId: null,
        lastDecisionCode: "NOT_EVALUATED",
        lastEvaluatedAt: null
      }
    })
  );

  let enqueueCalls = 0;
  const updates: Array<{ key: string; lastDecisionCode?: string }> = [];
  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "discord",
        sessionStore: store,
        evaluateAgentPulse: async () => ({
          ...buildPulseEvaluation({
            decision: {
              allowed: true,
              decisionCode: "ALLOWED",
              suppressedBy: [],
              nextEligibleAtIso: null
            },
            staleFactCount: 1,
            unresolvedCommitmentCount: 0
          })
        }),
        enqueueSystemJob: async () => {
          enqueueCalls += 1;
          return true;
        },
        updatePulseState: async (key, update) => {
          updates.push({
            key,
            lastDecisionCode: update.lastDecisionCode
          });
        }
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["stale_fact_revalidation"]
      }
    );

    await scheduler.runTickOnce();

    assert.equal(enqueueCalls, 0);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].key, "discord:chan-public:user-1");
    assert.equal(updates[0].lastDecisionCode, "NO_PRIVATE_ROUTE");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("agent pulse scheduler routes private mode to most recent private session for same user", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-scheduler-private-target-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const older = "2026-02-23T01:00:00.000Z";
  const newer = "2026-02-23T02:00:00.000Z";
  await store.setSession(
    buildSession("telegram:public:user-1", {
      conversationVisibility: "public",
      updatedAt: newer,
      agentPulse: {
        optIn: true,
        mode: "private",
        routeStrategy: "last_private_used",
        lastPulseSentAt: null,
        lastPulseReason: null,
        lastPulseTargetConversationId: null,
        lastDecisionCode: "NOT_EVALUATED",
        lastEvaluatedAt: null
      }
    })
  );
  await store.setSession(
    buildSession("telegram:private-old:user-1", {
      conversationVisibility: "private",
      updatedAt: older
    })
  );
  await store.setSession(
    buildSession("telegram:private-new:user-1", {
      conversationVisibility: "private",
      updatedAt: newer
    })
  );

  const enqueueTargets: string[] = [];
  const updates: Array<{ key: string; target?: string | null }> = [];
  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () => ({
          ...buildPulseEvaluation({
            decision: {
              allowed: true,
              decisionCode: "ALLOWED",
              suppressedBy: [],
              nextEligibleAtIso: null
            },
            staleFactCount: 1,
            unresolvedCommitmentCount: 1
          })
        }),
        enqueueSystemJob: async (session) => {
          enqueueTargets.push(session.conversationId);
          return true;
        },
        updatePulseState: async (key, update) => {
          updates.push({
            key,
            target: update.lastPulseTargetConversationId
          });
        }
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["unresolved_commitment"]
      }
    );

    await scheduler.runTickOnce();

    assert.equal(enqueueTargets.length, 1);
    assert.equal(enqueueTargets[0], "telegram:private-new:user-1");
    assert.ok(updates.every((item) => item.target === "telegram:private-new:user-1"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

/** Builds a minimal entity graph with one stale confirmed edge for dynamic pulse tests. */
function buildMinimalEntityGraph(observedAt: string): EntityGraphV1 {
  const staleDate = new Date(Date.parse(observedAt) - 100 * 24 * 60 * 60 * 1000).toISOString();
  return {
    schemaVersion: "v1",
    updatedAt: observedAt,
    entities: [
      {
        entityKey: "entity-toolchain",
        entityType: "thing",
        canonicalName: "Toolchain",
        disambiguator: null,
        firstSeenAt: staleDate,
        lastSeenAt: staleDate,
        salience: 0.9,
        aliases: [],
        evidenceRefs: ["conv:thread-1"]
      },
      {
        entityKey: "entity-project",
        entityType: "concept",
        canonicalName: "Project X",
        disambiguator: null,
        firstSeenAt: staleDate,
        lastSeenAt: staleDate,
        salience: 0.8,
        aliases: [],
        evidenceRefs: ["conv:thread-1"]
      }
    ],
    edges: [
      {
        edgeKey: "entity-toolchain->entity-project",
        sourceEntityKey: "entity-toolchain",
        targetEntityKey: "entity-project",
        relationType: "project_related",
        status: "confirmed",
        coMentionCount: 5,
        strength: 0.8,
        firstObservedAt: staleDate,
        lastObservedAt: staleDate,
        evidenceRefs: ["conv:thread-1"]
      }
    ]
  };
}

/** Builds an empty conversation stack for dynamic pulse tests. */
function buildMinimalConversationStack(observedAt: string): ConversationStackV1 {
  return {
    schemaVersion: "v1",
    updatedAt: observedAt,
    activeThreadKey: null,
    threads: [],
    topics: []
  };
}

test("dynamic pulse path calls evaluatePulseCandidatesV1 and enqueues when enabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-dynamic-"));
  const nowIso = new Date().toISOString();
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  await store.setSession(
    buildSession("telegram:chat-1:user-1", {
      conversationStack: buildMinimalConversationStack(nowIso),
      conversationTurns: [
        { role: "user", text: "How is the project toolchain going?", at: nowIso }
      ]
    })
  );

  const enqueuedPrompts: string[] = [];
  const updates: Array<{ key: string; lastDecisionCode?: string }> = [];
  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () => buildPulseEvaluation({}),
        enqueueSystemJob: async (_session, prompt) => {
          enqueuedPrompts.push(prompt);
          return true;
        },
        updatePulseState: async (key, update) => {
          updates.push({ key, lastDecisionCode: update.lastDecisionCode });
        },
        enableDynamicPulse: true,
        getEntityGraph: async () => buildMinimalEntityGraph(nowIso)
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["unresolved_commitment", "stale_fact_revalidation"]
      }
    );

    await scheduler.runTickOnce();

    assert.equal(enqueuedPrompts.length, 1);
    assert.ok(enqueuedPrompts[0].includes("STALE_FACT_REVALIDATION"));
    assert.ok(enqueuedPrompts[0].includes("entity-toolchain"));
    assert.ok(updates.some((u) => u.lastDecisionCode === "DYNAMIC_SENT"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dynamic pulse path suppresses workflow-continuity sessions before graph evaluation", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-dynamic-workflow-suppress-"));
  const nowIso = new Date().toISOString();
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  await store.setSession(
    buildSession("telegram:chat-dynamic-workflow:user-1", {
      domainContext: buildWorkflowDomainContext("telegram:chat-dynamic-workflow:user-1"),
      conversationStack: buildMinimalConversationStack(nowIso),
      conversationTurns: [
        { role: "user", text: "Morning, anything new?", at: nowIso }
      ]
    })
  );

  let graphCalls = 0;
  let enqueueCalls = 0;
  const updates: Array<{ key: string; lastDecisionCode?: string }> = [];
  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () => buildPulseEvaluation({}),
        enqueueSystemJob: async () => {
          enqueueCalls += 1;
          return true;
        },
        updatePulseState: async (key, update) => {
          updates.push({ key, lastDecisionCode: update.lastDecisionCode });
        },
        enableDynamicPulse: true,
        getEntityGraph: async () => {
          graphCalls += 1;
          return buildMinimalEntityGraph(nowIso);
        }
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["stale_fact_revalidation"]
      }
    );

    await scheduler.runTickOnce();

    assert.equal(graphCalls, 0);
    assert.equal(enqueueCalls, 0);
    assert.ok(
      updates.some(
        (update) =>
          update.key === "telegram:chat-dynamic-workflow:user-1" &&
          update.lastDecisionCode === "SESSION_DOMAIN_SUPPRESSED"
      )
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dynamic pulse path persists recentEmissions so cooldown blocks subsequent ticks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-dyn-cooldown-"));
  const nowIso = new Date().toISOString();
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const sessionKey = "telegram:chat-cd:user-1";
  await store.setSession(
    buildSession(sessionKey, {
      conversationStack: buildMinimalConversationStack(nowIso),
      conversationTurns: [
        { role: "user", text: "How is the project toolchain going?", at: nowIso }
      ]
    })
  );

  const enqueuedPrompts: string[] = [];
  try {
    const { appendPulseEmission } = await import("../../src/interfaces/sessionStore");

    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () => buildPulseEvaluation({}),
        enqueueSystemJob: async (_session, prompt) => {
          enqueuedPrompts.push(prompt);
          return true;
        },
        updatePulseState: async (key, update) => {
          const session = await store.getSession(key);
          if (!session) return;
          if ("lastPulseSentAt" in update) {
            session.agentPulse.lastPulseSentAt = update.lastPulseSentAt ?? null;
          }
          if (update.lastDecisionCode) {
            session.agentPulse.lastDecisionCode = update.lastDecisionCode;
          }
          if ("lastEvaluatedAt" in update) {
            session.agentPulse.lastEvaluatedAt = update.lastEvaluatedAt ?? null;
          }
          if (update.newEmission) {
            appendPulseEmission(session.agentPulse, update.newEmission);
          }
          if (typeof update.updatedAt === "string") {
            session.updatedAt = update.updatedAt;
          }
          await store.setSession(session);
        },
        enableDynamicPulse: true,
        getEntityGraph: async () => buildMinimalEntityGraph(nowIso)
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["unresolved_commitment", "stale_fact_revalidation"]
      }
    );

    await scheduler.runTickOnce();
    assert.equal(enqueuedPrompts.length, 1, "first tick should emit one pulse");

    const sessionAfterFirst = await store.getSession(sessionKey);
    assert.ok(sessionAfterFirst, "session should exist after first tick");
    const emissions = sessionAfterFirst!.agentPulse.recentEmissions ?? [];
    assert.ok(emissions.length > 0, "recentEmissions should be persisted after first tick");

    await scheduler.runTickOnce();
    assert.equal(enqueuedPrompts.length, 1, "second tick should be suppressed by cooldown");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dynamic pulse path returns gracefully when getEntityGraph is undefined", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-dyn-nograph-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  await store.setSession(buildSession("telegram:chat-1:user-1"));

  let evaluateCalls = 0;
  let enqueueCalls = 0;
  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () => {
          evaluateCalls += 1;
          return buildPulseEvaluation({
            decision: {
              allowed: true,
              decisionCode: "ALLOWED",
              suppressedBy: [],
              nextEligibleAtIso: null
            },
            staleFactCount: 1
          });
        },
        enqueueSystemJob: async () => {
          enqueueCalls += 1;
          return true;
        },
        updatePulseState: async () => { },
        enableDynamicPulse: true,
        getEntityGraph: undefined
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["unresolved_commitment", "stale_fact_revalidation"]
      }
    );

    await scheduler.runTickOnce();

    assert.ok(evaluateCalls > 0, "should fall through to legacy path when getEntityGraph is undefined");
    assert.ok(enqueueCalls > 0, "should enqueue via legacy path");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dynamic pulse suppresses weak relationship clarification nudges with no concrete recent grounding", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-relationship-suppress-"));
  const nowIso = new Date().toISOString();
  const staleDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));

  await store.setSession(
    buildSession("telegram:chat-relationship:user-1", {
      conversationStack: buildMinimalConversationStack(nowIso),
      conversationTurns: [
        { role: "user", text: "Morning. Anything urgent today?", at: nowIso }
      ],
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
            emittedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
            reasonCode: "RELATIONSHIP_CLARIFICATION",
            candidateEntityRefs: ["entity-alpha", "entity-beta"],
            responseOutcome: "ignored",
            generatedSnippet: "Checking in about alpha and beta."
          }
        ]
      }
    })
  );

  let enqueueCalls = 0;
  const updates: Array<{ lastDecisionCode?: string; lastPulseTargetConversationId?: string | null }> = [];
  try {
    const graph: EntityGraphV1 = {
      schemaVersion: "v1",
      updatedAt: nowIso,
      entities: [
        {
          entityKey: "entity-alpha",
          canonicalName: "Alpha Systems",
          entityType: "org",
          disambiguator: null,
          firstSeenAt: staleDate,
          lastSeenAt: staleDate,
          salience: 1,
          aliases: [],
          evidenceRefs: ["conv:thread-1"]
        },
        {
          entityKey: "entity-beta",
          canonicalName: "Beta Program",
          entityType: "concept",
          disambiguator: null,
          firstSeenAt: staleDate,
          lastSeenAt: staleDate,
          salience: 1,
          aliases: [],
          evidenceRefs: ["conv:thread-1"]
        }
      ],
      edges: [
        {
          edgeKey: "entity-alpha->entity-beta",
          sourceEntityKey: "entity-alpha",
          targetEntityKey: "entity-beta",
          relationType: "co_mentioned",
          status: "uncertain",
          coMentionCount: 6,
          strength: 0.74,
          firstObservedAt: staleDate,
          lastObservedAt: staleDate,
          evidenceRefs: ["conv:thread-1"]
        }
      ]
    };

    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () => buildPulseEvaluation({}),
        enqueueSystemJob: async () => {
          enqueueCalls += 1;
          return true;
        },
        updatePulseState: async (_key, update) => {
          updates.push({
            lastDecisionCode: update.lastDecisionCode,
            lastPulseTargetConversationId: update.lastPulseTargetConversationId ?? null
          });
        },
        enableDynamicPulse: true,
        getEntityGraph: async () => graph
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["unresolved_commitment", "stale_fact_revalidation"]
      }
    );

    await scheduler.runTickOnce();

    assert.equal(enqueueCalls, 0);
    assert.ok(updates.some((update) => update.lastDecisionCode === "DYNAMIC_SUPPRESSED"));
    assert.ok(
      updates.some(
        (update) =>
          update.lastDecisionCode === "DYNAMIC_SUPPRESSED" &&
          update.lastPulseTargetConversationId === "telegram:chat-relationship:user-1"
      )
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dynamic pulse prompt includes naturalness context sections when enabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-naturalness-"));
  const staleDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));

  const userFirstSeenAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  await store.setSession(
    buildSession("telegram:chat-1:user-1", {
      username: "agentowner",
      conversationStack: buildMinimalConversationStack(nowIso),
      conversationTurns: [
        { role: "user", text: "hey whats up lol", at: new Date(Date.now() - 3600_000).toISOString() },
        { role: "assistant", text: "Not much, working on things.", at: new Date(Date.now() - 3500_000).toISOString() }
      ],
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
            emittedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
            reasonCode: "OPEN_LOOP_RESUME",
            candidateEntityRefs: ["entity-toolchain"],
            responseOutcome: "ignored",
            generatedSnippet: "How's the toolchain coming along?"
          }
        ],
        userTimezone: "America/New_York",
        userStyleFingerprint: "casual, short messages"
      }
    })
  );

  const enqueuedPrompts: string[] = [];
  try {
    const graph: EntityGraphV1 = {
      schemaVersion: "v1",
      updatedAt: nowIso,
      entities: [
        {
          entityKey: "entity-toolchain",
          canonicalName: "toolchain",
          entityType: "thing",
          disambiguator: null,
          firstSeenAt: userFirstSeenAt,
          lastSeenAt: staleDate,
          salience: 3,
          aliases: [],
          evidenceRefs: ["conv:thread-1"]
        },
        {
          entityKey: "entity-project",
          canonicalName: "project",
          entityType: "concept",
          disambiguator: null,
          firstSeenAt: staleDate,
          lastSeenAt: staleDate,
          salience: 0.8,
          aliases: [],
          evidenceRefs: ["conv:thread-1"]
        }
      ],
      edges: [
        {
          edgeKey: "entity-toolchain->entity-project",
          sourceEntityKey: "entity-toolchain",
          targetEntityKey: "entity-project",
          relationType: "project_related",
          status: "confirmed",
          coMentionCount: 5,
          strength: 0.8,
          firstObservedAt: staleDate,
          lastObservedAt: staleDate,
          evidenceRefs: ["conv:thread-1"]
        }
      ]
    };

    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () => buildPulseEvaluation({}),
        enqueueSystemJob: async (_session, prompt) => {
          enqueuedPrompts.push(prompt);
          return true;
        },
        updatePulseState: async () => {},
        enableDynamicPulse: true,
        getEntityGraph: async () => graph
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["stale_fact_revalidation"]
      }
    );

    await scheduler.runTickOnce();

    assert.equal(enqueuedPrompts.length, 1);
    const prompt = enqueuedPrompts[0];
    assert.ok(prompt.includes("Situation awareness"), "should include situation awareness section");
    assert.ok(prompt.includes("Time since last user message:"), "should include conversational gap");
    assert.ok(prompt.includes("User's local time:"), "should include local time");
    assert.ok(prompt.includes("working with this user for"), "should include relationship depth");
    assert.ok(prompt.includes("1 ignored"), "should include response tracking");
    assert.ok(prompt.includes("How's the toolchain coming along?"), "should include previous snippet");
    assert.ok(
      prompt.includes("short messages") && prompt.includes("casual"),
      "should include style fingerprint with casual and short messages"
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dynamic pulse evaluateUserDynamic computes relationship age from entity graph firstSeenAt", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-relage-"));
  const nowIso = new Date().toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const staleDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));

  await store.setSession(
    buildSession("telegram:chat-1:user-1", {
      username: "agentowner",
      conversationStack: buildMinimalConversationStack(nowIso),
      conversationTurns: [
        { role: "user", text: "check project status", at: nowIso }
      ]
    })
  );

  const enqueuedPrompts: string[] = [];
  try {
    const graph: EntityGraphV1 = {
      schemaVersion: "v1",
      updatedAt: nowIso,
      entities: [
        {
          entityKey: "entity-agentowner",
          canonicalName: "agentowner",
          entityType: "thing",
          disambiguator: null,
          firstSeenAt: thirtyDaysAgo,
          lastSeenAt: nowIso,
          salience: 5,
          aliases: [],
          evidenceRefs: []
        },
        {
          entityKey: "entity-toolchain",
          canonicalName: "toolchain",
          entityType: "thing",
          disambiguator: null,
          firstSeenAt: staleDate,
          lastSeenAt: staleDate,
          salience: 3,
          aliases: [],
          evidenceRefs: ["conv:thread-1"]
        },
        {
          entityKey: "entity-project",
          canonicalName: "project",
          entityType: "concept",
          disambiguator: null,
          firstSeenAt: staleDate,
          lastSeenAt: staleDate,
          salience: 0.8,
          aliases: [],
          evidenceRefs: ["conv:thread-1"]
        }
      ],
      edges: [
        {
          edgeKey: "entity-toolchain->entity-project",
          sourceEntityKey: "entity-toolchain",
          targetEntityKey: "entity-project",
          relationType: "project_related",
          status: "confirmed",
          coMentionCount: 5,
          strength: 0.8,
          firstObservedAt: staleDate,
          lastObservedAt: staleDate,
          evidenceRefs: ["conv:thread-1"]
        }
      ]
    };

    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () => buildPulseEvaluation({}),
        enqueueSystemJob: async (_session, prompt) => {
          enqueuedPrompts.push(prompt);
          return true;
        },
        updatePulseState: async () => {},
        enableDynamicPulse: true,
        getEntityGraph: async () => graph
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["stale_fact_revalidation"]
      }
    );

    await scheduler.runTickOnce();

    assert.equal(enqueuedPrompts.length, 1);
    const prompt = enqueuedPrompts[0];
    assert.ok(prompt.includes("working with this user for"), "prompt should reference relationship age");
    assert.ok(prompt.includes("30") || prompt.includes("29") || prompt.includes("31"),
      "relationship age should be approximately 30 days"
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("enableDynamicPulse=false preserves legacy evaluation behavior", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-pulse-legacy-preserve-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  await store.setSession(buildSession("telegram:chat-1:user-1"));

  let evaluateCalls = 0;
  const updates: Array<{ key: string; lastDecisionCode?: string }> = [];
  try {
    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: store,
        evaluateAgentPulse: async () => {
          evaluateCalls += 1;
          return buildPulseEvaluation({
            decision: {
              allowed: true,
              decisionCode: "ALLOWED",
              suppressedBy: [],
              nextEligibleAtIso: null
            },
            staleFactCount: 2,
            unresolvedCommitmentCount: 1
          });
        },
        enqueueSystemJob: async () => true,
        updatePulseState: async (key, update) => {
          updates.push({ key, lastDecisionCode: update.lastDecisionCode });
        },
        enableDynamicPulse: false
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["unresolved_commitment", "stale_fact_revalidation"]
      }
    );

    await scheduler.runTickOnce();

    assert.ok(evaluateCalls > 0, "legacy evaluateAgentPulse should be called");
    assert.ok(updates.some((u) => u.lastDecisionCode === "ALLOWED"));
    assert.ok(!updates.some((u) => u.lastDecisionCode === "DYNAMIC_SENT"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
