/**
 * @fileoverview Emits deterministic evidence for media ingest, execution-intent clarification, and memory-safe media persistence.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import { buildSessionSeed, createFollowUpRuleContext } from "../../src/interfaces/conversationManagerHelpers";
import { routeConversationMessageInput } from "../../src/interfaces/conversationRuntime/conversationRouting";
import { buildConversationInboundUserInput } from "../../src/interfaces/mediaRuntime/mediaNormalization";
import { MediaUnderstandingOrgan } from "../../src/organs/mediaUnderstanding/mediaInterpretation";
import { LanguageUnderstandingOrgan } from "../../src/organs/languageUnderstanding/episodeExtraction";
import {
  assertMediaIngestExecutionIntentScenarioInventory,
  buildScenarioMediaEnvelope,
  computeMediaIngestExecutionIntentScenarioDiagnostics,
  createMediaFixtureCatalog,
  ensureMediaIngestEvidenceDirectory,
  loadMediaFixtureBuffers,
  loadMediaIngestExecutionIntentScenarioInventory,
  type MediaIngestExecutionIntentScenario,
  type MediaIngestExecutionIntentScenarioDiagnostics,
  type MediaIngestExecutionIntentScenarioInventory,
  MEDIA_INGEST_EXECUTION_INTENT_ARTIFACT_PATH,
  MEDIA_INGEST_EXECUTION_INTENT_EVIDENCE_COMMAND
} from "./mediaIngestExecutionIntentSupport";
import type {
  LanguageEpisodeExtractionModelOutput,
  ModelClient,
  StructuredCompletionRequest
} from "../../src/models/types";

interface ScenarioBehaviorResult {
  behavior: string;
  passed: boolean;
  observed: string;
}

interface MediaIngestExecutionIntentScenarioResult {
  scenarioId: string;
  title: string;
  passed: boolean;
  transcriptPreview: readonly string[];
  observed: readonly ScenarioBehaviorResult[];
}

interface MediaIngestExecutionIntentEvidenceArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL";
  summary: MediaIngestExecutionIntentScenarioDiagnostics["summary"] & {
    passedScenarios: number;
    failedScenarios: number;
  };
  requiredProofs: {
    imageFixNowDirectExecution: boolean;
    videoClarification: boolean;
    voiceFixNowDirectExecution: boolean;
    voiceMemoryBoundedPersistence: boolean;
  };
  errors: MediaIngestExecutionIntentScenarioDiagnostics["errors"];
  warnings: MediaIngestExecutionIntentScenarioDiagnostics["warnings"];
  scenarioResults: readonly MediaIngestExecutionIntentScenarioResult[];
}

class MediaIngestEvidenceEpisodeModelClient implements ModelClient {
  readonly backend = "mock" as const;

  /**
   * Returns deterministic structured episode candidates for evidence-only scenarios.
   *
   * @param request - Structured completion request emitted by the language-understanding organ.
   * @returns Stable bounded episode extraction output.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    const payload = JSON.parse(request.userPrompt) as { text?: string };
    const text = (payload.text ?? "").trim();
    const lower = text.toLowerCase();
    const supportingSnippet = text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? text;
    const output: LanguageEpisodeExtractionModelOutput = { episodes: [] };

    if (lower.includes("billy") && lower.includes("mri")) {
      output.episodes.push({
        subjectName: "Billy",
        eventSummary: "was waiting on MRI results",
        supportingSnippet,
        status: "outcome_unknown",
        confidence: 0.9,
        tags: ["medical", "followup"]
      });
    }

    return output as T;
  }
}

function buildTranscriptPreview(input: string): readonly string[] {
  return input
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);
}

async function withTempProfileStore<T>(
  fn: (store: ProfileMemoryStore, languageOrgan: LanguageUnderstandingOrgan) => Promise<T>
): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-media-evidence-"));
  try {
    const store = new ProfileMemoryStore(
      path.join(tempDir, "profile_memory.enc"),
      Buffer.from("0123456789abcdef0123456789abcdef", "utf8")
    );
    const languageOrgan = new LanguageUnderstandingOrgan(new MediaIngestEvidenceEpisodeModelClient());
    return await fn(store, languageOrgan);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runRoutingScenario(
  scenario: MediaIngestExecutionIntentScenario,
  canonicalInput: string,
  media: ReturnType<typeof buildScenarioMediaEnvelope>,
  receivedAt: string
): Promise<{ reply: string; shouldStartWorker: boolean; executionInput: string | null }> {
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: `evidence:${scenario.id}`,
    userId: "user-1",
    username: "benny",
    conversationVisibility: "private",
    receivedAt
  });
  let capturedExecutionInput: string | null = null;
  const result = await routeConversationMessageInput(
    session,
    canonicalInput,
    receivedAt,
    {
      followUpRuleContext: createFollowUpRuleContext(null),
      config: {
        allowAutonomousViaInterface: true,
        maxContextTurnsForExecution: 10,
        maxConversationTurns: 40
      },
      enqueueJob(_session, _input, _receivedAt, executionInput) {
        capturedExecutionInput = executionInput ?? null;
        return {
          reply: "Queued for execution.",
          shouldStartWorker: true
        };
      },
      queryContinuityEpisodes: async () => [],
      queryContinuityFacts: async () => []
    },
    media
  );
  return {
    reply: result.reply,
    shouldStartWorker: result.shouldStartWorker,
    executionInput: capturedExecutionInput
  };
}

async function runScenario(
  scenario: MediaIngestExecutionIntentScenario,
  inventory: MediaIngestExecutionIntentScenarioInventory,
  organ: MediaUnderstandingOrgan,
  fixtureBuffers: ReadonlyMap<string, Buffer>
): Promise<MediaIngestExecutionIntentScenarioResult> {
  void inventory;
  const buffer = fixtureBuffers.get(scenario.fixtureFile);
  if (!buffer) {
    return {
      scenarioId: scenario.id,
      title: scenario.title,
      passed: false,
      transcriptPreview: ["Missing fixture buffer."],
      observed: [{
        behavior: "fixture_buffer_present",
        passed: false,
        observed: `Fixture buffer for ${scenario.fixtureFile} was not loaded.`
      }]
    };
  }

  const media = buildScenarioMediaEnvelope(scenario, buffer.length);
  const [attachment] = media.attachments;
  const interpreted = await organ.interpretEnvelope(
    media,
    new Map<string, Buffer>([[attachment.fileId, buffer]])
  );
  const interpretedAttachment = interpreted?.attachments[0] ?? null;
  const interpretation = interpretedAttachment?.interpretation ?? null;
  const canonicalInput = buildConversationInboundUserInput(scenario.userText, interpreted);
  const observed: ScenarioBehaviorResult[] = [];

  observed.push({
    behavior: "interpretation_summary_matches",
    passed: interpretation?.summary === scenario.expectedInterpretation.summary,
    observed: interpretation?.summary ?? "<missing>"
  });
  observed.push({
    behavior: "interpretation_transcript_matches",
    passed: (interpretation?.transcript ?? null) === scenario.expectedInterpretation.transcript,
    observed: interpretation?.transcript ?? "<none>"
  });
  observed.push({
    behavior: "interpretation_ocr_matches",
    passed: (interpretation?.ocrText ?? null) === scenario.expectedInterpretation.ocrText,
    observed: interpretation?.ocrText ?? "<none>"
  });

  if (scenario.expectedBehavior.includes("direct_execute")) {
    const routing = await runRoutingScenario(
      scenario,
      canonicalInput,
      interpreted ?? media,
      new Date("2026-03-10T15:00:00.000Z").toISOString()
    );
    observed.push({
      behavior: "direct_execute_selected",
      passed: routing.shouldStartWorker && routing.executionInput !== null,
      observed: routing.reply
    });
    observed.push({
      behavior: "execution_input_contains_media_context",
      passed: Boolean(routing.executionInput?.includes("Inbound media context (interpreted once, bounded, no raw bytes):")),
      observed: routing.executionInput ?? "<none>"
    });
  }

  if (scenario.expectedBehavior.includes("clarify_plan_or_build")) {
    const routing = await runRoutingScenario(
      scenario,
      canonicalInput,
      interpreted ?? media,
      new Date("2026-03-10T15:05:00.000Z").toISOString()
    );
    observed.push({
      behavior: "plan_or_build_clarification",
      passed:
        !routing.shouldStartWorker &&
        routing.reply === "Do you want me to plan it first or build it now?",
      observed: routing.reply
    });
  }

  if (scenario.expectedBehavior.includes("memory_update")) {
    const memoryResult = await withTempProfileStore(async (store, languageOrgan) => {
      const additionalEpisodeCandidates = await languageOrgan.extractEpisodeCandidates({
        text: canonicalInput,
        sourceTaskId: `task_${scenario.id}`,
        observedAt: new Date("2026-03-10T15:10:00.000Z").toISOString()
      });
      await store.ingestFromTaskInput(
        `task_${scenario.id}`,
        canonicalInput,
        new Date("2026-03-10T15:10:00.000Z").toISOString(),
        { additionalEpisodeCandidates }
      );
      return store.reviewEpisodesForUser(5, new Date("2026-03-10T15:11:00.000Z").toISOString());
    });
    const billyEpisode = memoryResult.find((entry) =>
      entry.entityRefs.some((entity) => entity.toLowerCase().includes("billy")) ||
      entry.summary.toLowerCase().includes("billy") ||
      entry.title.toLowerCase().includes("billy")
    );
    const serialized = JSON.stringify(memoryResult);
    observed.push({
      behavior: "episodic_memory_updated",
      passed: Boolean(billyEpisode),
      observed: billyEpisode?.summary ?? "<missing Billy episode>"
    });
    observed.push({
      behavior: "raw_media_not_persisted",
      passed: !serialized.includes("OggS") && !serialized.includes("fixture_") && !serialized.includes("Attached media context:"),
      observed: serialized
    });
  }

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    passed: observed.every((entry) => entry.passed),
    transcriptPreview: buildTranscriptPreview(
      scenario.userText.trim() || scenario.expectedInterpretation.transcript || scenario.expectedInterpretation.summary
    ),
    observed
  };
}

export async function runMediaIngestExecutionIntentEvidence(): Promise<MediaIngestExecutionIntentEvidenceArtifact> {
  const inventory = await assertMediaIngestExecutionIntentScenarioInventory();
  const diagnostics = await computeMediaIngestExecutionIntentScenarioDiagnostics(
    await loadMediaIngestExecutionIntentScenarioInventory()
  );
  const fixtureBuffers = await loadMediaFixtureBuffers(inventory);
  const fixtureCatalog = createMediaFixtureCatalog(inventory, fixtureBuffers);
  const organ = new MediaUnderstandingOrgan(undefined, fixtureCatalog);

  const scenarioResults: MediaIngestExecutionIntentScenarioResult[] = [];
  for (const scenario of inventory.scenarios) {
    scenarioResults.push(await runScenario(scenario, inventory, organ, fixtureBuffers));
  }

  const requiredProofs = {
    imageFixNowDirectExecution: scenarioResults.some((entry) => entry.scenarioId === "image_fix_now" && entry.passed),
    videoClarification: scenarioResults.some((entry) => entry.scenarioId === "video_plan_or_build" && entry.passed),
    voiceFixNowDirectExecution: scenarioResults.some((entry) => entry.scenarioId === "voice_fix_now" && entry.passed),
    voiceMemoryBoundedPersistence: scenarioResults.some((entry) => entry.scenarioId === "voice_memory_followup" && entry.passed)
  };

  const failedScenarios = scenarioResults.filter((entry) => !entry.passed).length;
  const artifact: MediaIngestExecutionIntentEvidenceArtifact = {
    generatedAt: new Date().toISOString(),
    command: MEDIA_INGEST_EXECUTION_INTENT_EVIDENCE_COMMAND,
    status:
      diagnostics.errors.length === 0 &&
      failedScenarios === 0 &&
      Object.values(requiredProofs).every(Boolean)
        ? "PASS"
        : "FAIL",
    summary: {
      ...diagnostics.summary,
      passedScenarios: scenarioResults.length - failedScenarios,
      failedScenarios
    },
    requiredProofs,
    errors: diagnostics.errors,
    warnings: diagnostics.warnings,
    scenarioResults
  };

  await ensureMediaIngestEvidenceDirectory();
  await mkdir(path.dirname(MEDIA_INGEST_EXECUTION_INTENT_ARTIFACT_PATH), { recursive: true });
  await writeFile(
    MEDIA_INGEST_EXECUTION_INTENT_ARTIFACT_PATH,
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8"
  );
  return artifact;
}

async function main(): Promise<void> {
  const artifact = await runMediaIngestExecutionIntentEvidence();
  console.log(`Media-ingest execution-intent evidence status: ${artifact.status}`);
  console.log(`Artifact: ${MEDIA_INGEST_EXECUTION_INTENT_ARTIFACT_PATH}`);
  if (artifact.status !== "PASS") {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
