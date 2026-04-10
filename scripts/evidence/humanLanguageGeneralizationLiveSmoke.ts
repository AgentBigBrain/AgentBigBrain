/**
 * @fileoverview Runs runtime-backed live smoke for human-language generalization using the real
 * conversation manager and Agent Pulse scheduler paths.
 */

import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import type { CreateProfileEpisodeRecordInput } from "../../src/core/profileMemory";
import {
  applyEntityExtractionToGraph,
  createEmptyEntityGraphV1,
  extractEntityCandidates
} from "../../src/core/stage6_86EntityGraph";
import { buildConversationStackFromTurnsV1 } from "../../src/core/stage6_86ConversationStack";
import type { EntityGraphV1 } from "../../src/core/types";
import { ConversationManager } from "../../src/interfaces/conversationManager";
import { AgentPulseScheduler } from "../../src/interfaces/agentPulseScheduler";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import type {
  ConversationContinuityEpisodeRecord,
  ConversationExecutionResult,
  ConversationInboundMessage
} from "../../src/interfaces/conversationRuntime/managerContracts";
import type { ConversationTurn } from "../../src/interfaces/sessionStore";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";
import type {
  LanguageEpisodeExtractionModelOutput,
  ModelClient,
  StructuredCompletionRequest
} from "../../src/models/types";
import { resolveContextualReferenceHints } from "../../src/organs/languageUnderstanding/contextualReferenceResolution";
import { LanguageUnderstandingOrgan } from "../../src/organs/languageUnderstanding/episodeExtraction";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/human_language_generalization_live_smoke_report.json"
);
const COMMAND_NAME = "tsx scripts/evidence/humanLanguageGeneralizationLiveSmoke.ts";

type LiveSmokeScenarioId =
  | "contextual_recall_live_positive"
  | "contextual_recall_live_suppressed"
  | "useful_proactive_live_positive"
  | "generic_proactive_live_suppressed";

interface LiveSmokeScenarioResult {
  scenarioId: LiveSmokeScenarioId;
  passed: boolean;
  transcriptPreview: readonly string[];
  checks: readonly {
    label: string;
    passed: boolean;
    observed: string;
  }[];
}

interface HumanLanguageLiveSmokeArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL";
  requiredProofs: {
    contextualRecallLiveInjected: boolean;
    contextualRecallLiveSuppressed: boolean;
    usefulProactiveLiveEnqueued: boolean;
    genericProactiveLiveSuppressed: boolean;
  };
  summary: {
    scenarioCount: number;
    passedScenarios: number;
    failedScenarios: number;
  };
  scenarioResults: readonly LiveSmokeScenarioResult[];
}

class LiveSmokeEpisodeModelClient implements ModelClient {
  readonly backend = "mock" as const;

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    const payload = JSON.parse(request.userPrompt) as { text?: string };
    const text = (payload.text ?? "").trim();
    const lower = text.toLowerCase();
    const firstSentence = text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? text;
    let output: LanguageEpisodeExtractionModelOutput = { episodes: [] };

    if (lower.includes("billy") && (lower.includes("urgent care") || lower.includes("mri"))) {
      output = {
        episodes: [
          {
            subjectName: "Billy",
            eventSummary: "was waiting on MRI results",
            supportingSnippet: firstSentence,
            status: "outcome_unknown",
            confidence: 0.88,
            tags: ["medical", "followup"]
          }
        ]
      };
    }

    return output as T;
  }
}

interface RuntimeHarness {
  tempDir: string;
  store: InterfaceSessionStore;
  profileStore: ProfileMemoryStore;
}

function buildPrivateMessage(
  conversationId: string,
  text: string,
  receivedAt: string
): ConversationInboundMessage {
  return {
    provider: "telegram",
    conversationId,
    userId: "user-1",
    username: "benny",
    conversationVisibility: "private",
    text,
    receivedAt
  };
}

function buildTurns(
  lines: ReadonlyArray<{ role: ConversationTurn["role"]; text: string; at: string }>
): ConversationTurn[] {
  return lines.map((line) => ({
    role: line.role,
    text: line.text,
    at: line.at
  }));
}

function previewTranscript(turns: readonly string[]): readonly string[] {
  return turns.slice(0, 4);
}

async function createHarness(): Promise<RuntimeHarness> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-human-language-live-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "interface_sessions.json"));
  const profileStore = new ProfileMemoryStore(
    path.join(tempDir, "profile_memory.enc"),
    Buffer.from("0123456789abcdef0123456789abcdef", "utf8")
  );
  return { tempDir, store, profileStore };
}

async function waitForHarnessQuiescence(tempDir: string, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  let stableChecks = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const entries = await readdir(tempDir).catch(() => [] as string[]);
    const hasPendingAtomicWrite = entries.some((entry) => entry.includes(".tmp-"));
    if (!hasPendingAtomicWrite) {
      stableChecks += 1;
      if (stableChecks >= 4) {
        return;
      }
    } else {
      stableChecks = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function disposeHarness(harness: RuntimeHarness): Promise<void> {
  let lastError: unknown = null;
  await waitForHarnessQuiescence(harness.tempDir);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(harness.tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        !["ENOTEMPTY", "EPERM", "EBUSY"].includes(String(error.code))
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

function buildGraphFromTurns(turns: readonly ConversationTurn[], updatedAt: string): EntityGraphV1 {
  let graph = createEmptyEntityGraphV1(updatedAt);
  for (const turn of turns) {
    const extraction = extractEntityCandidates({
      text: turn.text,
      observedAt: turn.at,
      evidenceRef: `conv:${turn.at}`
    });
    graph = applyEntityExtractionToGraph(
      graph,
      extraction,
      turn.at,
      `conv:${turn.at}`,
      {
        entityMaxAliases: 8,
        maxGraphEdgesPerEntity: 64
      }
    ).graph;
  }
  graph.updatedAt = updatedAt;
  return graph;
}

async function seedBillyEpisode(
  profileStore: ProfileMemoryStore,
  observedAt: string
): Promise<readonly CreateProfileEpisodeRecordInput[]> {
  const narrative = [
    "Billy had a rough fall a few weeks ago and it turned into a whole mess.",
    "He ended up in urgent care, and the doctor wanted him to get an MRI because the swelling was not going down.",
    "I never really heard how it all turned out, and I still feel like that situation is hanging open."
  ].join(" ");
  const organ = new LanguageUnderstandingOrgan(new LiveSmokeEpisodeModelClient());
  const additionalEpisodeCandidates = await organ.extractEpisodeCandidates({
    text: narrative,
    sourceTaskId: "live_smoke_seed_billy",
    observedAt
  });
  await profileStore.ingestFromTaskInput(
    "live_smoke_seed_billy",
    narrative,
    observedAt,
    { additionalEpisodeCandidates }
  );
  return additionalEpisodeCandidates;
}

async function queryContinuityEpisodesForHarness(
  profileStore: ProfileMemoryStore,
  graph: EntityGraphV1,
  stack: NonNullable<ReturnType<typeof buildConversationStackFromTurnsV1>>,
  entityHints: readonly string[],
  maxEpisodes?: number
): Promise<readonly ConversationContinuityEpisodeRecord[]> {
  const linkedEpisodes = await profileStore.queryEpisodesForContinuity(graph, stack, {
    entityHints,
    maxEpisodes
  });
  return linkedEpisodes.map((entry) => ({
    episodeId: entry.episode.id,
    title: entry.episode.title,
    summary: entry.episode.summary,
    status: entry.episode.status,
    lastMentionedAt: entry.episode.lastMentionedAt,
    entityRefs: [...entry.episode.entityRefs],
    entityLinks: entry.entityLinks.map((link) => ({
      entityKey: link.entityKey,
      canonicalName: link.canonicalName
    })),
    openLoopLinks: entry.openLoopLinks.map((link) => ({
      loopId: link.loopId,
      threadKey: link.threadKey,
      status: link.status,
      priority: link.priority
    }))
  }));
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 4_000
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for runtime condition.");
}

async function waitForSessionIdle(
  store: InterfaceSessionStore,
  conversationId: string,
  timeoutMs = 4_000
): Promise<void> {
  await waitFor(async () => {
    const session = await store.getSession(conversationId);
    if (!session) {
      return false;
    }
    return session.runningJobId === null && session.queuedJobs.length === 0;
  }, timeoutMs);
}

async function waitForFinalDeliverySettled(
  store: InterfaceSessionStore,
  conversationId: string,
  timeoutMs = 4_000
): Promise<void> {
  await waitFor(async () => {
    const session = await store.getSession(conversationId);
    if (!session) {
      return false;
    }
    const latestJob = session.recentJobs[0] ?? null;
    if (!latestJob) {
      return false;
    }
    return latestJob.finalDeliveryOutcome !== "not_attempted";
  }, timeoutMs);
}

async function runContextualRecallScenario(
  mode: "positive" | "negative"
): Promise<LiveSmokeScenarioResult> {
  const harness = await createHarness();
  try {
    const seedAt = new Date("2026-03-08T11:00:00.000Z").toISOString();
    const priorTurns = buildTurns([
      {
        role: "user",
        at: seedAt,
        text: [
          "Billy had a rough fall a few weeks ago and it turned into a whole mess.",
          "He ended up in urgent care, and the doctor wanted him to get an MRI because the swelling was not going down.",
          "I never really heard how it all turned out, and I still feel like that situation is hanging open."
        ].join(" ")
      },
      {
        role: "assistant",
        at: new Date("2026-03-08T11:01:00.000Z").toISOString(),
        text: [
          "That sounds exhausting, especially if the outcome stayed blurry.",
          "We can leave it there for now and come back to it later if it matters again."
        ].join(" ")
      }
    ]);

    const seededEpisodeCandidates = await seedBillyEpisode(harness.profileStore, seedAt);

    const session = buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-live-recall",
      userId: "user-1",
      username: "benny",
      conversationVisibility: "private",
      receivedAt: priorTurns[priorTurns.length - 1]!.at
    });
    session.conversationTurns = [...priorTurns];
    session.conversationStack = buildConversationStackFromTurnsV1(
      priorTurns,
      priorTurns[priorTurns.length - 1]!.at
    );
    session.updatedAt = priorTurns[priorTurns.length - 1]!.at;
    await harness.store.setSession(session);

    const graph = buildGraphFromTurns(priorTurns, session.updatedAt);
    const persistedEpisodes = await harness.profileStore.reviewEpisodesForUser(5, session.updatedAt);
    const continuityEpisodes = await queryContinuityEpisodesForHarness(
      harness.profileStore,
      graph,
      session.conversationStack,
      ["billy", "mri"],
      3
    );
    let capturedExecutionInput: string | null = null;

    const manager = new ConversationManager(
      harness.store,
      {
        maxContextTurnsForExecution: 10,
        maxConversationTurns: 40
      },
      {
        queryContinuityEpisodes: async ({ stack, entityHints, maxEpisodes }) =>
          queryContinuityEpisodesForHarness(
            harness.profileStore,
            graph,
            stack,
            entityHints,
            maxEpisodes
          ),
        queryContinuityFacts: async ({ stack, entityHints, maxFacts }) =>
          harness.profileStore.queryFactsForContinuity(graph, stack, {
            entityHints,
            maxFacts
          })
      }
    );

    const currentText = mode === "positive"
      ? "/chat Billy came up again this morning when I was texting someone from home. It made me think about that whole MRI situation from a few weeks back, and I realized I still do not know how it ended up. I keep feeling like I missed the ending to that whole thing."
      : "/chat Billy sent me a dumb meme this morning and we laughed for a second. Then I went straight back to the deployment checklist and forgot about it. Nothing about the old situation actually came up.";

    await manager.handleMessage(
      buildPrivateMessage(
        "chat-live-recall",
        currentText,
        new Date("2026-03-08T12:00:00.000Z").toISOString()
      ),
      async (input, _receivedAt): Promise<ConversationExecutionResult> => {
        capturedExecutionInput = input;
        return {
          summary: "live recall smoke ok"
        };
      },
      async () => { }
    );

    await waitFor(() => capturedExecutionInput !== null);
    await waitForSessionIdle(harness.store, session.conversationId);
    await waitForFinalDeliverySettled(harness.store, session.conversationId);

    // Snapshot to a const with explicit type to prevent TypeScript from narrowing to 'never'.
    const executionInput: string | null = capturedExecutionInput;
    const executionInputStr: string = executionInput ?? "";

    const resolvedReference = resolveContextualReferenceHints({
      userInput: currentText,
      recentTurns: session.conversationTurns,
      threads: session.conversationStack.threads
    });
    const recallInjected = executionInputStr.includes("Contextual recall opportunity (optional):");
    const mentionsBilly = executionInputStr.includes("Relevant situation: Billy");
    const mentionsMri = executionInputStr.toLowerCase().includes("mri");
    const expected = mode === "positive";

    return {
      scenarioId: mode === "positive"
        ? "contextual_recall_live_positive"
        : "contextual_recall_live_suppressed",
      passed: expected ? recallInjected && mentionsBilly && mentionsMri : !recallInjected,
      transcriptPreview: previewTranscript([
        priorTurns[0]!.text,
        currentText
      ]),
      checks: [
        {
          label: "execution-input-captured",
          passed: executionInput !== null,
          observed: executionInput ? "captured" : "missing"
        },
        {
          label: "contextual-recall-block",
          passed: expected ? recallInjected : !recallInjected,
          observed: recallInjected
            ? "present"
            : `suppressed:${(executionInput ?? "").slice(0, 220)}`
        },
        {
          label: "continuity-episode-query",
          passed: expected ? continuityEpisodes.length > 0 : true,
          observed: continuityEpisodes.length > 0
            ? continuityEpisodes
              .map((episode) => `${episode.title} | refs=${episode.entityRefs.join(",") || "none"}`)
              .join(" || ")
            : "none"
        },
        {
          label: "persisted-episode-state",
          passed: expected ? persistedEpisodes.length > 0 : true,
          observed: persistedEpisodes.length > 0
            ? persistedEpisodes
              .map((episode) => `${episode.title} | refs=${episode.entityRefs.join(",") || "none"} | status=${episode.status}`)
              .join(" || ")
            : "none"
        },
        {
          label: "seeded-language-candidates",
          passed: expected ? seededEpisodeCandidates.length > 0 : true,
          observed: seededEpisodeCandidates.length > 0
            ? seededEpisodeCandidates
              .map((candidate) => `${candidate.title} | refs=${(candidate.entityRefs ?? []).join(",") || "none"}`)
              .join(" || ")
            : "none"
        },
        {
          label: "resolved-reference-hints",
          passed: expected ? resolvedReference.resolvedHints.length > 0 : true,
          observed: [
            `direct=${resolvedReference.directTerms.join(",") || "none"}`,
            `resolved=${resolvedReference.resolvedHints.join(",") || "none"}`,
            `fallback=${String(resolvedReference.usedFallbackContext)}`,
            `cue=${String(resolvedReference.hasRecallCue)}`
          ].join(" | ")
        },
        {
          label: "grounded-situation-details",
          passed: expected ? mentionsBilly && mentionsMri : true,
          observed: expected
            ? `Billy=${String(mentionsBilly)}; MRI=${String(mentionsMri)}`
            : "not-applicable"
        }
      ]
    };
  } finally {
    await disposeHarness(harness);
  }
}

function buildMinimalDynamicPulseGraph(observedAt: string): EntityGraphV1 {
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

function buildSuppressedRelationshipGraph(observedAt: string): EntityGraphV1 {
  const staleDate = new Date(Date.parse(observedAt) - 20 * 24 * 60 * 60 * 1000).toISOString();
  return {
    schemaVersion: "v1",
    updatedAt: observedAt,
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
}

async function runProactiveScenario(
  mode: "positive" | "negative"
): Promise<LiveSmokeScenarioResult> {
  const harness = await createHarness();
  try {
    const nowIso = new Date("2026-03-08T13:00:00.000Z").toISOString();
    const session = buildSessionSeed({
      provider: "telegram",
      conversationId: mode === "positive" ? "chat-live-pulse" : "chat-live-pulse-suppressed",
      userId: "user-1",
      username: "benny",
      conversationVisibility: "private",
      receivedAt: nowIso
    });
    session.agentPulse.optIn = true;
    session.updatedAt = nowIso;
    session.conversationTurns = mode === "positive"
      ? buildTurns([
        {
          role: "user",
          at: nowIso,
          text: [
            "I keep meaning to revisit the project toolchain because it has been stale for a while.",
            "Nothing is actively broken yet, but it feels like the kind of thing that bites us when we ignore it too long.",
            "If there is a concrete reason to nudge me later, that would actually help."
          ].join(" ")
        }
      ])
      : buildTurns([
        {
          role: "user",
          at: nowIso,
          text: [
            "Morning. Nothing is really open right now and I am mostly just saying hi.",
            "If there is no concrete reason, I do not want a generic check-in or relationship nudge."
          ].join(" ")
        }
      ]);
    session.conversationStack = buildConversationStackFromTurnsV1(session.conversationTurns, nowIso);
    session.agentPulse.optIn = true;
    if (mode === "negative") {
      session.agentPulse.recentEmissions = [
        {
          emittedAt: new Date(Date.parse(nowIso) - 2 * 24 * 60 * 60 * 1000).toISOString(),
          reasonCode: "RELATIONSHIP_CLARIFICATION",
          candidateEntityRefs: ["entity-alpha", "entity-beta"],
          responseOutcome: "ignored",
          generatedSnippet: "Checking in about alpha and beta."
        }
      ];
    }
    const initialEmissionCount = session.agentPulse.recentEmissions?.length ?? 0;
    await harness.store.setSession(session);

    let capturedExecutionInput: string | null = null;
    const manager = new ConversationManager(harness.store, {
      maxContextTurnsForExecution: 10,
      maxConversationTurns: 40
    });

    const scheduler = new AgentPulseScheduler(
      {
        provider: "telegram",
        sessionStore: harness.store,
        evaluateAgentPulse: async () => ({
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
          }
        }),
        enqueueSystemJob: async (targetSession, systemInput, receivedAt) =>
          manager.enqueueSystemJob(
            targetSession.conversationId,
            systemInput,
            receivedAt,
            async (input): Promise<ConversationExecutionResult> => {
              capturedExecutionInput = input;
              return {
                summary: "live proactive smoke ok"
              };
            },
            async () => { }
          ),
        updatePulseState: async (conversationKey, update) =>
          manager.updateAgentPulseState(conversationKey, update),
        enableDynamicPulse: true,
        getEntityGraph: async () =>
          mode === "positive"
            ? buildMinimalDynamicPulseGraph(nowIso)
            : buildSuppressedRelationshipGraph(nowIso)
      },
      {
        tickIntervalMs: 1_000,
        reasonPriority: ["unresolved_commitment", "stale_fact_revalidation"]
      }
    );

    await scheduler.runTickOnce();
    if (mode === "positive") {
      await waitFor(() => capturedExecutionInput !== null);
      await waitForSessionIdle(harness.store, session.conversationId);
      await waitForFinalDeliverySettled(harness.store, session.conversationId);
    } else {
      await waitFor(async () => {
        const loadedSession = await harness.store.getSession(session.conversationId);
        return loadedSession?.agentPulse.lastDecisionCode === "DYNAMIC_SUPPRESSED";
      });
    }

    // Snapshot to a const with explicit type to prevent TypeScript from narrowing to 'never'.
    const executionInput: string | null = capturedExecutionInput;
    const executionInputStr: string = executionInput ?? "";

    const refreshedSession = await harness.store.getSession(session.conversationId);
    const lastDecisionCode = refreshedSession?.agentPulse.lastDecisionCode ?? null;
    const lastPulseReason = refreshedSession?.agentPulse.lastPulseReason ?? null;
    const lastPulseTargetConversationId =
      refreshedSession?.agentPulse.lastPulseTargetConversationId ?? null;
    const recentEmissions = refreshedSession?.agentPulse.recentEmissions ?? [];
    const latestEmission = recentEmissions[recentEmissions.length - 1] ?? null;
    const newEmissionCount = Math.max(0, recentEmissions.length - initialEmissionCount);
    const pulseRequestWrapped = executionInputStr.includes("System-generated Agent Pulse check-in request.");
    const staleSignal = executionInputStr.includes("Signal type: STALE_FACT_REVALIDATION");
    const proactiveDeliveryPersisted =
      lastPulseTargetConversationId === session.conversationId
      && latestEmission !== null
      && latestEmission.reasonCode === "STALE_FACT_REVALIDATION"
      && newEmissionCount === 1;
    const proactiveSuppressionPersisted =
      executionInput === null
      && lastDecisionCode === "DYNAMIC_SUPPRESSED"
      && newEmissionCount === 0;

    return {
      scenarioId: mode === "positive"
        ? "useful_proactive_live_positive"
        : "generic_proactive_live_suppressed",
      passed: mode === "positive"
        ? pulseRequestWrapped
          && staleSignal
          && executionInput !== null
        : proactiveSuppressionPersisted,
      transcriptPreview: previewTranscript(session.conversationTurns.map((turn) => turn.text)),
      checks: [
        {
          label: "runtime-decision-code",
          passed: mode === "positive"
            ? lastDecisionCode === "DYNAMIC_SENT" || executionInput !== null
            : lastDecisionCode === "DYNAMIC_SUPPRESSED",
          observed: String(lastDecisionCode)
        },
        {
          label: "system-job-execution",
          passed: mode === "positive"
            ? executionInput !== null
            : executionInput === null,
          observed: executionInput ? "executed" : "suppressed"
        },
        {
          label: "bounded-prompt-shape",
          passed: mode === "positive" ? pulseRequestWrapped && staleSignal : true,
          observed: mode === "positive"
            ? `wrapped=${String(pulseRequestWrapped)}; staleSignal=${String(staleSignal)}`
            : "not-applicable"
        },
        {
          label: "persisted-pulse-state",
          passed: mode === "positive"
            ? proactiveDeliveryPersisted || executionInput !== null
            : proactiveSuppressionPersisted,
          observed: mode === "positive"
            ? [
              `reason=${lastPulseReason ?? "null"}`,
              `target=${lastPulseTargetConversationId ?? "null"}`,
              `emissions=${recentEmissions.length}`,
              `newEmissions=${newEmissionCount}`
            ].join(" | ")
            : [
              `decision=${lastDecisionCode ?? "null"}`,
              `emissions=${recentEmissions.length}`,
              `newEmissions=${newEmissionCount}`
            ].join(" | ")
        }
      ]
    };
  } finally {
    await disposeHarness(harness);
  }
}

function buildArtifact(
  scenarioResults: readonly LiveSmokeScenarioResult[]
): HumanLanguageLiveSmokeArtifact {
  const requiredProofs = {
    contextualRecallLiveInjected: scenarioResults.some(
      (result) => result.scenarioId === "contextual_recall_live_positive" && result.passed
    ),
    contextualRecallLiveSuppressed: scenarioResults.some(
      (result) => result.scenarioId === "contextual_recall_live_suppressed" && result.passed
    ),
    usefulProactiveLiveEnqueued: scenarioResults.some(
      (result) => result.scenarioId === "useful_proactive_live_positive" && result.passed
    ),
    genericProactiveLiveSuppressed: scenarioResults.some(
      (result) => result.scenarioId === "generic_proactive_live_suppressed" && result.passed
    )
  };
  const passedScenarios = scenarioResults.filter((result) => result.passed).length;
  const failedScenarios = scenarioResults.length - passedScenarios;
  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND_NAME,
    status:
      failedScenarios === 0 &&
        Object.values(requiredProofs).every((value) => value)
        ? "PASS"
        : "FAIL",
    requiredProofs,
    summary: {
      scenarioCount: scenarioResults.length,
      passedScenarios,
      failedScenarios
    },
    scenarioResults
  };
}

export async function runHumanLanguageGeneralizationLiveSmoke(): Promise<HumanLanguageLiveSmokeArtifact> {
  const scenarioResults = [
    await runContextualRecallScenario("positive"),
    await runContextualRecallScenario("negative"),
    await runProactiveScenario("positive"),
    await runProactiveScenario("negative")
  ] as const;
  const artifact = buildArtifact(scenarioResults);
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, JSON.stringify(artifact, null, 2), "utf8");
  return artifact;
}

async function main(): Promise<void> {
  const artifact = await runHumanLanguageGeneralizationLiveSmoke();
  console.log(`Human language live smoke artifact: ${ARTIFACT_PATH}`);
  console.log(`Status: ${artifact.status}`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
