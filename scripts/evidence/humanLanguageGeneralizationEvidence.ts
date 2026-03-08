/**
 * @fileoverview Validates the human-language generalization scenario inventory and emits a
 * scenario-driven evidence report.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ConversationSession } from "../../src/interfaces/sessionStore";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import { resolveContextualRecallCandidate } from "../../src/interfaces/conversationRuntime/contextualRecall";
import type { QueryConversationContinuityEpisodes } from "../../src/interfaces/conversationRuntime/managerContracts";
import { shouldSuppressRelationshipClarificationPulse } from "../../src/interfaces/proactiveRuntime/followupQualification";
import { calculateRelationshipClarificationUtilityScore } from "../../src/interfaces/proactiveRuntime/userValueScoring";
import type {
  ConversationStackV1,
  EntityGraphV1,
  PulseCandidateV1
} from "../../src/core/types";
import type { ModelClient, StructuredCompletionRequest } from "../../src/models/types";
import { LanguageUnderstandingOrgan } from "../../src/organs/languageUnderstanding/episodeExtraction";
import { resolveContextualReferenceHints } from "../../src/organs/languageUnderstanding/contextualReferenceResolution";
import type {
  MemorySynthesisEpisodeRecord,
  MemorySynthesisFactRecord
} from "../../src/organs/memorySynthesis/contracts";
import { buildRecallSynthesis } from "../../src/organs/memorySynthesis/recallSynthesis";

type ScenarioCategory =
  | "episode_understanding"
  | "contextual_recall"
  | "cross_memory_synthesis"
  | "proactive_utility";

type ScenarioPolarity = "positive" | "negative";
type TranscriptSpeaker = "user" | "assistant";

interface ScenarioQualities {
  topicDrift?: boolean;
  resumedSituation?: boolean;
  vagueCallback?: boolean;
  mixedPracticalRelational?: boolean;
  shortMessageEdgeCase?: boolean;
}

interface TranscriptTurn {
  speaker: TranscriptSpeaker;
  text: string;
}

interface HumanLanguageScenario {
  id: string;
  category: ScenarioCategory;
  polarity: ScenarioPolarity;
  title: string;
  summary: string;
  expectedBehavior: readonly string[];
  qualities: ScenarioQualities;
  transcript: readonly TranscriptTurn[];
}

interface HumanLanguageScenarioInventory {
  schemaVersion: number;
  scenarios: readonly HumanLanguageScenario[];
}

interface ScenarioDiagnostic {
  scenarioId: string;
  message: string;
}

interface ScenarioInventoryDiagnostics {
  errors: readonly ScenarioDiagnostic[];
  warnings: readonly ScenarioDiagnostic[];
  summary: {
    scenarioCount: number;
    categoryCounts: Record<ScenarioCategory, number>;
    polarityCounts: Record<ScenarioPolarity, number>;
    transcriptTurnCount: number;
  };
}

interface ScenarioBehaviorResult {
  behavior: string;
  passed: boolean;
  note: string;
}

interface HumanLanguageScenarioResult {
  scenarioId: string;
  category: ScenarioCategory;
  polarity: ScenarioPolarity;
  title: string;
  passed: boolean;
  transcriptPreview: readonly string[];
  observed: readonly ScenarioBehaviorResult[];
}

interface HumanLanguageEvidenceArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL";
  summary: ScenarioInventoryDiagnostics["summary"] & {
    passedScenarios: number;
    failedScenarios: number;
  };
  requiredProofs: {
    richerEpisodeExtractionSuccess: boolean;
    contextualRecallSuccess: boolean;
    suppressedWeakSynthesis: boolean;
    suppressedGenericProactiveNudge: boolean;
    allowedUsefulProactiveNudge: boolean;
  };
  errors: readonly ScenarioDiagnostic[];
  warnings: readonly ScenarioDiagnostic[];
  scenarioResults: readonly HumanLanguageScenarioResult[];
}

interface LanguageEpisodeModelOutput {
  episodes: Array<{
    subjectName: string;
    eventSummary: string;
    supportingSnippet: string;
    status: "unresolved" | "partially_resolved" | "resolved" | "outcome_unknown" | "no_longer_relevant";
    confidence: number;
    tags: string[];
  }>;
}

const WORKSPACE_ROOT = process.cwd();
const SCENARIO_FIXTURE_PATH = path.resolve(
  WORKSPACE_ROOT,
  "tests/fixtures/humanLanguageGeneralizationScenarios.json"
);
const ARTIFACT_PATH = path.resolve(
  WORKSPACE_ROOT,
  "runtime/evidence/human_language_generalization_report.json"
);
const COMMAND_NAME = "tsx scripts/evidence/humanLanguageGeneralizationEvidence.ts";
const CATEGORY_ORDER: readonly ScenarioCategory[] = [
  "episode_understanding",
  "contextual_recall",
  "cross_memory_synthesis",
  "proactive_utility"
];
const POLARITY_ORDER: readonly ScenarioPolarity[] = ["positive", "negative"];

class ScenarioLanguageEpisodeModelClient implements ModelClient {
  readonly backend = "mock" as const;

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    const payload = JSON.parse(request.userPrompt) as { text?: string };
    const text = (payload.text ?? "").trim();
    const lowerText = text.toLowerCase();
    const firstSentence = text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? text;

    let output: LanguageEpisodeModelOutput = { episodes: [] };
    if (
      lowerText.includes("billy")
      && (lowerText.includes("urgent care") || lowerText.includes("slipped") || lowerText.includes("mri"))
    ) {
      output = {
        episodes: [
          {
            subjectName: "Billy",
            eventSummary: lowerText.includes("mri") ? "was waiting on MRI results" : "had a fall",
            supportingSnippet: firstSentence,
            status: "unresolved",
            confidence: 0.86,
            tags: lowerText.includes("mri")
              ? ["medical", "followup"]
              : ["injury", "followup"]
          }
        ]
      };
    } else if (
      lowerText.includes("mom")
      && (lowerText.includes("hospital") || lowerText.includes("breathing"))
    ) {
      output = {
        episodes: [
          {
            subjectName: "Mom",
            eventSummary: "had a medical situation",
            supportingSnippet: firstSentence,
            status: "outcome_unknown",
            confidence: 0.81,
            tags: ["medical", "followup"]
          }
        ]
      };
    }

    return output as T;
  }
}

function countSentences(text: string): number {
  return text
    .split(/[.!?]+(?:\s+|$)/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0).length;
}

function createEmptyCategoryCounts(): Record<ScenarioCategory, number> {
  return {
    episode_understanding: 0,
    contextual_recall: 0,
    cross_memory_synthesis: 0,
    proactive_utility: 0
  };
}

function createEmptyPolarityCounts(): Record<ScenarioPolarity, number> {
  return {
    positive: 0,
    negative: 0
  };
}

export async function loadHumanLanguageScenarioInventory(
  fixturePath: string = SCENARIO_FIXTURE_PATH
): Promise<HumanLanguageScenarioInventory> {
  const raw = await readFile(fixturePath, "utf8");
  return JSON.parse(raw) as HumanLanguageScenarioInventory;
}

export function computeHumanLanguageScenarioDiagnostics(
  inventory: HumanLanguageScenarioInventory
): ScenarioInventoryDiagnostics {
  const errors: ScenarioDiagnostic[] = [];
  const warnings: ScenarioDiagnostic[] = [];
  const categoryCounts = createEmptyCategoryCounts();
  const polarityCounts = createEmptyPolarityCounts();
  const seenIds = new Set<string>();

  if (inventory.schemaVersion !== 1) {
    errors.push({
      scenarioId: "inventory",
      message: `Unsupported schemaVersion ${inventory.schemaVersion}; expected 1.`
    });
  }

  if (!Array.isArray(inventory.scenarios) || inventory.scenarios.length === 0) {
    errors.push({
      scenarioId: "inventory",
      message: "Scenario inventory must include at least one scenario."
    });
  }

  for (const scenario of inventory.scenarios) {
    if (seenIds.has(scenario.id)) {
      errors.push({
        scenarioId: scenario.id,
        message: "Scenario ids must be unique."
      });
    }
    seenIds.add(scenario.id);

    if (!CATEGORY_ORDER.includes(scenario.category)) {
      errors.push({
        scenarioId: scenario.id,
        message: `Unsupported category '${scenario.category}'.`
      });
      continue;
    }
    if (!POLARITY_ORDER.includes(scenario.polarity)) {
      errors.push({
        scenarioId: scenario.id,
        message: `Unsupported polarity '${scenario.polarity}'.`
      });
      continue;
    }

    categoryCounts[scenario.category] += 1;
    polarityCounts[scenario.polarity] += 1;

    if (scenario.title.trim().length === 0 || scenario.summary.trim().length === 0) {
      errors.push({
        scenarioId: scenario.id,
        message: "Scenario title and summary must be non-empty."
      });
    }

    if (!Array.isArray(scenario.expectedBehavior) || scenario.expectedBehavior.length === 0) {
      errors.push({
        scenarioId: scenario.id,
        message: "Scenario expectedBehavior must include at least one outcome tag."
      });
    }

    if (!Array.isArray(scenario.transcript) || scenario.transcript.length < 2) {
      errors.push({
        scenarioId: scenario.id,
        message: "Scenario transcript must include at least two turns."
      });
      continue;
    }

    const userTurns = scenario.transcript.filter((turn) => turn.speaker === "user");
    if (userTurns.length === 0) {
      errors.push({
        scenarioId: scenario.id,
        message: "Scenario transcript must include at least one user turn."
      });
    }

    for (const [index, turn] of scenario.transcript.entries()) {
      if (turn.text.trim().length === 0) {
        errors.push({
          scenarioId: scenario.id,
          message: `Transcript turn ${index + 1} must not be empty.`
        });
        continue;
      }
      if (turn.speaker === "user" && scenario.qualities.shortMessageEdgeCase !== true) {
        const sentenceCount = countSentences(turn.text);
        if (sentenceCount < 2 || sentenceCount > 4) {
          errors.push({
            scenarioId: scenario.id,
            message:
              `User turn ${index + 1} must be 2 to 4 sentences long for human-like evidence; ` +
              `got ${sentenceCount}.`
          });
        }
      }
    }
  }

  for (const category of CATEGORY_ORDER) {
    const positives = inventory.scenarios.filter(
      (scenario) => scenario.category === category && scenario.polarity === "positive"
    );
    const negatives = inventory.scenarios.filter(
      (scenario) => scenario.category === category && scenario.polarity === "negative"
    );
    if (positives.length === 0 || negatives.length === 0) {
      errors.push({
        scenarioId: category,
        message: "Each category must include at least one positive and one negative scenario."
      });
    }
  }

  const anyTopicDrift = inventory.scenarios.some((scenario) => scenario.qualities.topicDrift === true);
  const anyResumedSituation = inventory.scenarios.some(
    (scenario) => scenario.qualities.resumedSituation === true
  );
  const anyVagueCallback = inventory.scenarios.some((scenario) => scenario.qualities.vagueCallback === true);
  const anyMixedPracticalRelational = inventory.scenarios.some(
    (scenario) => scenario.qualities.mixedPracticalRelational === true
  );

  if (!anyTopicDrift) {
    errors.push({
      scenarioId: "inventory",
      message: "Scenario inventory must include at least one topic-drift example."
    });
  }
  if (!anyResumedSituation) {
    errors.push({
      scenarioId: "inventory",
      message: "Scenario inventory must include at least one resumed-situation example."
    });
  }
  if (!anyVagueCallback) {
    errors.push({
      scenarioId: "inventory",
      message: "Scenario inventory must include at least one vague-callback example."
    });
  }
  if (!anyMixedPracticalRelational) {
    errors.push({
      scenarioId: "inventory",
      message: "Scenario inventory must include at least one mixed practical/relational example."
    });
  }

  const summary = {
    scenarioCount: inventory.scenarios.length,
    categoryCounts,
    polarityCounts,
    transcriptTurnCount: inventory.scenarios.reduce(
      (total, scenario) => total + scenario.transcript.length,
      0
    )
  };

  if (inventory.scenarios.length < 8) {
    warnings.push({
      scenarioId: "inventory",
      message: "Scenario inventory is still quite small; expand breadth before claiming broad coverage."
    });
  }

  return {
    errors,
    warnings,
    summary
  };
}

export async function assertHumanLanguageScenarioInventory(
  fixturePath: string = SCENARIO_FIXTURE_PATH
): Promise<ScenarioInventoryDiagnostics> {
  const inventory = await loadHumanLanguageScenarioInventory(fixturePath);
  const diagnostics = computeHumanLanguageScenarioDiagnostics(inventory);
  if (diagnostics.errors.length > 0) {
    const detail = diagnostics.errors
      .map((diagnostic) => `${diagnostic.scenarioId}: ${diagnostic.message}`)
      .join("\n");
    throw new Error(`Human language scenario inventory check failed.\n${detail}`);
  }
  return diagnostics;
}

function buildEvidenceSession(
  id: string,
  priorTurns: readonly TranscriptTurn[],
  stack?: ConversationStackV1
): ConversationSession {
  const latestTurnAt = "2026-03-08T12:00:00.000Z";
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: `human-language-${id}`,
      userId: "user-1",
      username: "testuser",
      conversationVisibility: "private",
      receivedAt: latestTurnAt
    }),
    updatedAt: latestTurnAt,
    conversationTurns: priorTurns.map((turn, index) => ({
      role: turn.speaker,
      text: turn.text,
      at: `2026-03-08T11:${String(index).padStart(2, "0")}:00.000Z`
    })),
    conversationStack: stack
  };
}

function buildBillyFallStack(): ConversationStackV1 {
  return {
    schemaVersion: "v1",
    updatedAt: "2026-03-08T12:00:00.000Z",
    activeThreadKey: "thread_current",
    threads: [
      {
        threadKey: "thread_current",
        topicKey: "current_topic",
        topicLabel: "Current topic",
        state: "active",
        resumeHint: "Continue the current task.",
        openLoops: [],
        lastTouchedAt: "2026-03-08T11:59:00.000Z"
      },
      {
        threadKey: "thread_billy_fall",
        topicKey: "billy_fall",
        topicLabel: "Billy Fall",
        state: "paused",
        resumeHint: "Billy fell down a few weeks ago and the situation still felt unresolved.",
        openLoops: [
          {
            loopId: "loop_billy_fall",
            threadKey: "thread_billy_fall",
            entityRefs: ["billy"],
            createdAt: "2026-02-14T15:00:00.000Z",
            lastMentionedAt: "2026-02-14T15:00:00.000Z",
            priority: 0.8,
            status: "open"
          }
        ],
        lastTouchedAt: "2026-02-14T15:00:00.000Z"
      }
    ],
    topics: [
      {
        topicKey: "current_topic",
        label: "Current topic",
        firstSeenAt: "2026-03-08T11:58:00.000Z",
        lastSeenAt: "2026-03-08T11:59:00.000Z",
        mentionCount: 2
      },
      {
        topicKey: "billy_fall",
        label: "Billy Fall",
        firstSeenAt: "2026-02-14T15:00:00.000Z",
        lastSeenAt: "2026-02-14T15:00:00.000Z",
        mentionCount: 2
      }
    ]
  };
}

function buildMomHospitalStack(): ConversationStackV1 {
  return {
    schemaVersion: "v1",
    updatedAt: "2026-03-08T12:00:00.000Z",
    activeThreadKey: "thread_current",
    threads: [
      {
        threadKey: "thread_current",
        topicKey: "paperwork_updates",
        topicLabel: "Paperwork Updates",
        state: "active",
        resumeHint: "Continue paperwork and texting updates.",
        openLoops: [],
        lastTouchedAt: "2026-03-08T11:58:00.000Z"
      },
      {
        threadKey: "thread_mom_hospital",
        topicKey: "mom_hospital",
        topicLabel: "Mom Hospital Scare",
        state: "paused",
        resumeHint: "Your mom ended up in the hospital and the whole thing never got a clean explanation.",
        openLoops: [
          {
            loopId: "loop_mom_hospital",
            threadKey: "thread_mom_hospital",
            entityRefs: ["mom"],
            createdAt: "2026-02-18T09:00:00.000Z",
            lastMentionedAt: "2026-02-18T09:00:00.000Z",
            priority: 0.9,
            status: "open"
          }
        ],
        lastTouchedAt: "2026-02-18T09:00:00.000Z"
      }
    ],
    topics: [
      {
        topicKey: "paperwork_updates",
        label: "Paperwork Updates",
        firstSeenAt: "2026-03-08T11:55:00.000Z",
        lastSeenAt: "2026-03-08T11:58:00.000Z",
        mentionCount: 2
      },
      {
        topicKey: "mom_hospital",
        label: "Mom Hospital Scare",
        firstSeenAt: "2026-02-18T09:00:00.000Z",
        lastSeenAt: "2026-02-18T09:00:00.000Z",
        mentionCount: 2
      }
    ]
  };
}

function buildBillyEntityGraph(): EntityGraphV1 {
  return {
    schemaVersion: "v1",
    updatedAt: "2026-03-08T12:00:00.000Z",
    entities: [
      {
        entityKey: "entity_billy",
        canonicalName: "Billy",
        aliases: ["Billy"],
        firstSeenAt: "2026-02-10T12:00:00.000Z",
        lastSeenAt: "2026-03-08T11:00:00.000Z",
        mentionCount: 6
      }
    ],
    edges: []
  };
}

function buildRelationshipClarificationCandidate(): PulseCandidateV1 {
  return {
    candidateId: "candidate_billy_followup",
    reasonCode: "RELATIONSHIP_CLARIFICATION",
    entityRefs: ["entity_billy"],
    evidenceRefs: [],
    threadKey: null,
    score: 0.4,
    scoreBreakdown: {
      recency: 0.2,
      frequency: 0.1,
      unresolvedImportance: 0.1
    }
  };
}

function getLastUserTurn(scenario: HumanLanguageScenario): string {
  const lastUserTurn = [...scenario.transcript].reverse().find((turn) => turn.speaker === "user");
  if (!lastUserTurn) {
    throw new Error(`Scenario ${scenario.id} has no user turns.`);
  }
  return lastUserTurn.text;
}

function buildTranscriptPreview(scenario: HumanLanguageScenario): readonly string[] {
  return scenario.transcript.map((turn) => `${turn.speaker}: ${turn.text}`);
}

function buildBillyContinuityEpisodeQuery(): QueryConversationContinuityEpisodes {
  return async ({ entityHints }) => {
    const joinedHints = entityHints.join(" ").toLowerCase();
    if (!/(fall|urgent|care|ended|resolved|situation)/.test(joinedHints)) {
      return [];
    }
    return [
      {
        episodeId: "episode_billy_fall",
        title: "Billy had a fall",
        summary: "Billy had a rough fall and the outcome never got a clean follow-up.",
        status: "unresolved",
        lastMentionedAt: "2026-02-14T15:00:00.000Z",
        entityRefs: ["Billy"],
        entityLinks: [
          {
            entityKey: "entity_billy",
            canonicalName: "Billy"
          }
        ],
        openLoopLinks: [
          {
            loopId: "loop_billy_fall",
            threadKey: "thread_billy_fall",
            status: "open",
            priority: 0.8
          }
        ]
      }
    ];
  };
}

function buildMomHospitalEpisodeQuery(): QueryConversationContinuityEpisodes {
  return async ({ entityHints }) => {
    const joinedHints = entityHints.join(" ").toLowerCase();
    if (!/(mom|hospital|breathing|whole|hear|back|revisiting)/.test(joinedHints)) {
      return [];
    }
    return [
      {
        episodeId: "episode_mom_hospital",
        title: "Mom had a hospital scare",
        summary: "Your mom had a hospital scare and the underlying explanation never felt resolved.",
        status: "outcome_unknown",
        lastMentionedAt: "2026-02-18T09:00:00.000Z",
        entityRefs: ["Mom"],
        entityLinks: [
          {
            entityKey: "entity_mom",
            canonicalName: "Mom"
          }
        ],
        openLoopLinks: [
          {
            loopId: "loop_mom_hospital",
            threadKey: "thread_mom_hospital",
            status: "open",
            priority: 0.9
          }
        ]
      }
    ];
  };
}

async function evaluateEpisodeUnderstandingScenario(
  scenario: HumanLanguageScenario
): Promise<HumanLanguageScenarioResult> {
  const organ = new LanguageUnderstandingOrgan(new ScenarioLanguageEpisodeModelClient());
  const candidates = await organ.extractEpisodeCandidates({
    text: scenario.transcript[0]?.text ?? "",
    sourceTaskId: `evidence_${scenario.id}`,
    observedAt: "2026-03-08T12:00:00.000Z"
  });

  const observed: ScenarioBehaviorResult[] = [];
  if (scenario.polarity === "positive") {
    const firstCandidate = candidates[0];
    observed.push({
      behavior: "extract_episode_candidate",
      passed: candidates.length > 0,
      note: firstCandidate
        ? `Extracted '${firstCandidate.title}' with status '${firstCandidate.status}'.`
        : "No episode candidate was extracted."
    });
    observed.push({
      behavior: "preserve_followup_relevance",
      passed: candidates.some((candidate) => candidate.tags.includes("followup")),
      note: candidates.length > 0
        ? `Observed tags: ${candidates.flatMap((candidate) => candidate.tags).join(", ")}`
        : "No candidate tags were available."
    });
  } else {
    observed.push({
      behavior: "suppress_episode_candidate",
      passed: candidates.length === 0,
      note: candidates.length === 0
        ? "No episode candidates were emitted for the vague venting case."
        : `Unexpected episode candidate count: ${candidates.length}.`
    });
  }

  return {
    scenarioId: scenario.id,
    category: scenario.category,
    polarity: scenario.polarity,
    title: scenario.title,
    passed: observed.every((entry) => entry.passed),
    transcriptPreview: buildTranscriptPreview(scenario),
    observed
  };
}

async function evaluateContextualRecallScenario(
  scenario: HumanLanguageScenario
): Promise<HumanLanguageScenarioResult> {
  const userInput = getLastUserTurn(scenario);
  const priorTurns = scenario.transcript.slice(0, -1);
  const stack = scenario.id.includes("mom_hospital")
    ? buildMomHospitalStack()
    : buildBillyFallStack();
  const queryContinuityEpisodes = scenario.id.includes("mom_hospital")
    ? buildMomHospitalEpisodeQuery()
    : buildBillyContinuityEpisodeQuery();
  const session = buildEvidenceSession(scenario.id, priorTurns, stack);
  const resolvedReference = resolveContextualReferenceHints({
    userInput,
    recentTurns: session.conversationTurns,
    threads: stack.threads
  });
  const candidate = await resolveContextualRecallCandidate(
    session,
    userInput,
    queryContinuityEpisodes
  );

  const observed: ScenarioBehaviorResult[] = [];
  if (scenario.polarity === "positive") {
    observed.push({
      behavior: "resolve_contextual_reference",
      passed: candidate !== null && resolvedReference.usedFallbackContext,
      note: candidate
        ? `Resolved hints: ${resolvedReference.resolvedHints.join(", ")}. Candidate topic: ${candidate.topicLabel}.`
        : `No recall candidate resolved. Hints: ${resolvedReference.resolvedHints.join(", ")}.`
    });
    observed.push({
      behavior: "offer_one_inline_followup",
      passed: candidate?.kind === "episode",
      note: candidate
        ? `Candidate kind '${candidate.kind}' with supporting cue '${candidate.supportingCue}'.`
        : "No bounded recall candidate was offered."
    });
  } else {
    observed.push({
      behavior: "suppress_contextual_recall",
      passed: candidate === null,
      note: candidate === null
        ? `Resolved hints stayed bounded: ${resolvedReference.resolvedHints.join(", ")}.`
        : `Unexpected recall candidate '${candidate.topicLabel}' was produced.`
    });
  }

  return {
    scenarioId: scenario.id,
    category: scenario.category,
    polarity: scenario.polarity,
    title: scenario.title,
    passed: observed.every((entry) => entry.passed),
    transcriptPreview: buildTranscriptPreview(scenario),
    observed
  };
}

function evaluateCrossMemorySynthesisScenario(
  scenario: HumanLanguageScenario
): HumanLanguageScenarioResult {
  const positiveEpisode: MemorySynthesisEpisodeRecord = {
    episodeId: "episode_billy_fall",
    title: "Billy had a fall",
    summary: "Billy had a rough fall and the outcome never got a clean follow-up.",
    status: "unresolved",
    lastMentionedAt: "2026-02-14T15:00:00.000Z",
    entityRefs: ["Billy"],
    entityLinks: [
      {
        entityKey: "entity_billy",
        canonicalName: "Billy"
      }
    ],
    openLoopLinks: [
      {
        loopId: "loop_billy_fall",
        threadKey: "thread_billy_fall",
        status: "open",
        priority: 0.8
      }
    ]
  };
  const positiveFact: MemorySynthesisFactRecord = {
    factId: "fact_billy_relationship",
    key: "contact.billy.relationship",
    value: "person the user checks on often",
    status: "active",
    observedAt: "2026-02-10T12:00:00.000Z",
    lastUpdatedAt: "2026-03-08T10:00:00.000Z",
    confidence: 0.86
  };
  const weakEpisode: MemorySynthesisEpisodeRecord = {
    episodeId: "episode_ambiguous_mix",
    title: "Mixed family situation",
    summary: "Multiple situations may have been blended together and the user is not sure who they belong to.",
    status: "resolved",
    lastMentionedAt: "2026-03-01T12:00:00.000Z",
    entityRefs: [],
    entityLinks: [],
    openLoopLinks: []
  };

  const synthesis = scenario.polarity === "positive"
    ? buildRecallSynthesis([positiveEpisode], [positiveFact])
    : buildRecallSynthesis([weakEpisode], []);

  const observed: ScenarioBehaviorResult[] = [];
  if (scenario.polarity === "positive") {
    observed.push({
      behavior: "produce_bounded_synthesis",
      passed: synthesis !== null,
      note: synthesis
        ? `Produced synthesis '${synthesis.topicLabel}' at confidence ${synthesis.confidence.toFixed(2)}.`
        : "No bounded synthesis was produced."
    });
    observed.push({
      behavior: "include_supporting_evidence",
      passed: (synthesis?.evidence.length ?? 0) >= 3,
      note: synthesis
        ? `Evidence kinds: ${synthesis.evidence.map((entry) => entry.kind).join(", ")}.`
        : "No supporting evidence was available."
    });
  } else {
    observed.push({
      behavior: "suppress_bounded_synthesis",
      passed: synthesis === null,
      note: synthesis === null
        ? "Weak/conflicting support suppressed synthesis as expected."
        : `Unexpected synthesis '${synthesis.topicLabel}' was produced.`
    });
  }

  return {
    scenarioId: scenario.id,
    category: scenario.category,
    polarity: scenario.polarity,
    title: scenario.title,
    passed: observed.every((entry) => entry.passed),
    transcriptPreview: buildTranscriptPreview(scenario),
    observed
  };
}

function evaluateProactiveUtilityScenario(
  scenario: HumanLanguageScenario
): HumanLanguageScenarioResult {
  const candidate = buildRelationshipClarificationCandidate();
  const graph = buildBillyEntityGraph();
  const recentConversationText = getLastUserTurn(scenario);
  const openLoopCount = scenario.polarity === "positive" ? 1 : 0;
  const repeatedNegativeOutcomes = scenario.polarity === "positive" ? 0 : 2;
  const utilityScore = calculateRelationshipClarificationUtilityScore({
    anchoredEntityCount: recentConversationText.toLowerCase().includes("billy") ? 1 : 0,
    openLoopCount,
    repeatedNegativeOutcomes
  });
  const suppressed = shouldSuppressRelationshipClarificationPulse({
    candidate,
    graph,
    recentConversationText,
    openLoopCount,
    repeatedNegativeOutcomes
  });

  const observed: ScenarioBehaviorResult[] = [];
  if (scenario.polarity === "positive") {
    observed.push({
      behavior: "allow_proactive_followup",
      passed: suppressed === false && utilityScore >= 0.5,
      note: `Utility score ${utilityScore.toFixed(2)} with suppression=${String(suppressed)}.`
    });
  } else {
    observed.push({
      behavior: "suppress_generic_proactive_nudge",
      passed: suppressed === true,
      note: `Utility score ${utilityScore.toFixed(2)} with suppression=${String(suppressed)}.`
    });
  }

  return {
    scenarioId: scenario.id,
    category: scenario.category,
    polarity: scenario.polarity,
    title: scenario.title,
    passed: observed.every((entry) => entry.passed),
    transcriptPreview: buildTranscriptPreview(scenario),
    observed
  };
}

async function evaluateScenario(
  scenario: HumanLanguageScenario
): Promise<HumanLanguageScenarioResult> {
  switch (scenario.category) {
    case "episode_understanding":
      return evaluateEpisodeUnderstandingScenario(scenario);
    case "contextual_recall":
      return evaluateContextualRecallScenario(scenario);
    case "cross_memory_synthesis":
      return evaluateCrossMemorySynthesisScenario(scenario);
    case "proactive_utility":
      return evaluateProactiveUtilityScenario(scenario);
    default: {
      const neverCategory: never = scenario.category;
      throw new Error(`Unsupported scenario category: ${neverCategory}`);
    }
  }
}

export async function runHumanLanguageGeneralizationEvidence(): Promise<HumanLanguageEvidenceArtifact> {
  const inventory = await loadHumanLanguageScenarioInventory();
  const diagnostics = computeHumanLanguageScenarioDiagnostics(inventory);
  const scenarioResults = diagnostics.errors.length === 0
    ? await Promise.all(inventory.scenarios.map((scenario) => evaluateScenario(scenario)))
    : [];
  const passedScenarios = scenarioResults.filter((scenario) => scenario.passed).length;
  const failedScenarios = scenarioResults.length - passedScenarios;
  const scenarioErrors = scenarioResults
    .filter((scenario) => !scenario.passed)
    .flatMap((scenario) =>
      scenario.observed
        .filter((behavior) => !behavior.passed)
        .map<ScenarioDiagnostic>((behavior) => ({
          scenarioId: scenario.scenarioId,
          message: `${behavior.behavior}: ${behavior.note}`
        }))
    );
  const requiredProofs = {
    richerEpisodeExtractionSuccess: scenarioResults.some(
      (scenario) =>
        scenario.scenarioId === "episode_understanding_billy_fall_positive"
        && scenario.passed
    ),
    contextualRecallSuccess: scenarioResults.some(
      (scenario) =>
        scenario.scenarioId === "contextual_recall_mom_hospital_positive"
        && scenario.passed
    ),
    suppressedWeakSynthesis: scenarioResults.some(
      (scenario) =>
        scenario.scenarioId === "cross_memory_synthesis_conflict_negative"
        && scenario.passed
    ),
    suppressedGenericProactiveNudge: scenarioResults.some(
      (scenario) =>
        scenario.scenarioId === "proactive_followup_generic_ping_negative"
        && scenario.passed
    ),
    allowedUsefulProactiveNudge: scenarioResults.some(
      (scenario) =>
        scenario.scenarioId === "proactive_followup_explicit_request_positive"
        && scenario.passed
    )
  };

  const artifact: HumanLanguageEvidenceArtifact = {
    generatedAt: new Date().toISOString(),
    command: COMMAND_NAME,
    status:
      diagnostics.errors.length === 0
      && scenarioErrors.length === 0
      && Object.values(requiredProofs).every(Boolean)
        ? "PASS"
        : "FAIL",
    summary: {
      ...diagnostics.summary,
      passedScenarios,
      failedScenarios
    },
    requiredProofs,
    errors: [...diagnostics.errors, ...scenarioErrors],
    warnings: diagnostics.warnings,
    scenarioResults
  };

  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

async function main(): Promise<void> {
  const artifact = await runHumanLanguageGeneralizationEvidence();
  console.log(`Human language generalization evidence status: ${artifact.status}`);
  console.log(`Artifact: ${ARTIFACT_PATH}`);
  if (artifact.status === "FAIL") {
    process.exitCode = 1;
  }
}

const MODULE_PATH = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  void main();
}
