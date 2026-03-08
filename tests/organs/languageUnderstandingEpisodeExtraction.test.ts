/**
 * @fileoverview Tests bounded model-assisted episode extraction for richer human situations.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { LanguageUnderstandingOrgan } from "../../src/organs/languageUnderstanding/episodeExtraction";
import type { ModelClient, StructuredCompletionRequest } from "../../src/models/types";

class StubLanguageEpisodeModelClient implements ModelClient {
  readonly backend = "mock" as const;

  recordedRequest: StructuredCompletionRequest | null = null;

  constructor(
    private readonly output:
      | {
          episodes: Array<{
            subjectName: string;
            eventSummary: string;
            supportingSnippet: string;
            status: "unresolved" | "partially_resolved" | "resolved" | "outcome_unknown" | "no_longer_relevant";
            confidence: number;
            tags: string[];
          }>;
        }
      | Error
  ) {}

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    this.recordedRequest = request;
    if (this.output instanceof Error) {
      throw this.output;
    }
    return this.output as T;
  }
}

test("LanguageUnderstandingOrgan normalizes bounded model-assisted episode candidates", async () => {
  const organ = new LanguageUnderstandingOrgan(
    new StubLanguageEpisodeModelClient({
      episodes: [
        {
          subjectName: "Billy",
          eventSummary: "had a medical situation",
          supportingSnippet:
            "Billy had this scare at the hospital a few weeks ago and we still do not know what the doctors found.",
          status: "unresolved",
          confidence: 0.88,
          tags: ["medical", "followup"]
        }
      ]
    })
  );

  const candidates = await organ.extractEpisodeCandidates({
    text: [
      "Billy had this scare at the hospital a few weeks ago.",
      "We still do not know what the doctors found."
    ].join(" "),
    sourceTaskId: "task_language_episode_extract_1",
    observedAt: "2026-03-08T16:00:00.000Z"
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.title, "Billy had a medical situation");
  assert.equal(candidates[0]?.sourceKind, "assistant_inference");
  assert.equal(candidates[0]?.status, "unresolved");
  assert.equal(candidates[0]?.sensitive, false);
  assert.deepEqual(candidates[0]?.entityRefs, ["contact.billy"]);
  assert.match(
    organ["modelClient"] instanceof StubLanguageEpisodeModelClient
      ? organ["modelClient"].recordedRequest?.systemPrompt ?? ""
      : "",
    /at most two concrete human situations/i
  );
});

test("LanguageUnderstandingOrgan fails closed when the model errors", async () => {
  const organ = new LanguageUnderstandingOrgan(
    new StubLanguageEpisodeModelClient(new Error("forced language failure"))
  );

  const candidates = await organ.extractEpisodeCandidates({
    text: "Billy had a rough breakup recently and I never told you whether things calmed down.",
    sourceTaskId: "task_language_episode_extract_2",
    observedAt: "2026-03-08T16:10:00.000Z"
  });

  assert.deepEqual(candidates, []);
});
