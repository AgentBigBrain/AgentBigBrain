/**
 * @fileoverview Deterministic mock builders for bounded language-understanding schemas.
 */

import type { LanguageEpisodeExtractionModelOutput } from "../types";
import { asString, parseJsonObject } from "./contracts";

interface CueGroup {
  canonicalEvent: string;
  keywords: readonly string[];
  tags: readonly string[];
}

const EVENT_CUE_GROUPS: readonly CueGroup[] = [
  {
    canonicalEvent: "had a medical situation",
    keywords: ["hospital", "doctors", "doctor", "surgery", "rehab", "diagnosis", "test result", "scare"],
    tags: ["health", "medical", "followup"]
  },
  {
    canonicalEvent: "had an injury situation",
    keywords: ["fell", "fall", "hurt", "injured", "accident", "crash"],
    tags: ["injury", "followup"]
  },
  {
    canonicalEvent: "had a work situation",
    keywords: ["laid off", "fired", "job offer", "interview", "boss", "work trouble"],
    tags: ["work", "followup"]
  },
  {
    canonicalEvent: "had a relationship situation",
    keywords: ["breakup", "divorce", "argument", "fight"],
    tags: ["relationship", "followup"]
  },
  {
    canonicalEvent: "had a legal situation",
    keywords: ["court", "lawsuit", "legal", "arrest"],
    tags: ["legal", "followup"]
  }
];

const INVALID_SUBJECT_NAMES = new Set(["I", "We", "The", "My", "Our", "His", "Her", "Their"]);

/**
 * Builds deterministic episode-extraction output for the mock model backend.
 *
 * @param userPrompt - Structured prompt payload passed to the model client.
 * @returns Structured language-understanding episode output.
 */
export function buildLanguageEpisodeExtractionOutput(
  userPrompt: string
): LanguageEpisodeExtractionModelOutput {
  const input = parseJsonObject(userPrompt);
  const text = asString(input.text);
  if (!text) {
    return { episodes: [] };
  }

  const sentences = text
    .split(/[\n.!?]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 8);
  const episodes: LanguageEpisodeExtractionModelOutput["episodes"] = [];
  const seen = new Set<string>();

  for (const sentence of sentences) {
    const subjectName = extractSubjectName(sentence);
    if (!subjectName) {
      continue;
    }
    const lowered = sentence.toLowerCase();
    const cueGroup = EVENT_CUE_GROUPS.find((group) =>
      group.keywords.some((keyword) => lowered.includes(keyword))
    );
    if (!cueGroup) {
      continue;
    }
    const signature = `${subjectName.toLowerCase()}::${cueGroup.canonicalEvent}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    episodes.push({
      subjectName,
      eventSummary: cueGroup.canonicalEvent,
      supportingSnippet: sentence,
      status: deriveStatus(text),
      confidence: deriveConfidence(sentence),
      tags: [...cueGroup.tags]
    });
    if (episodes.length >= 2) {
      break;
    }
  }

  return { episodes };
}

/**
 * Extracts one likely subject name from a sentence.
 *
 * @param sentence - Sentence under inspection.
 * @returns Candidate subject name or empty string.
 */
function extractSubjectName(sentence: string): string {
  const match = /\b([A-Z][A-Za-z'-]{1,30})(?:\s+[A-Z][A-Za-z'-]{1,30})?\b/u.exec(sentence);
  if (!match) {
    return "";
  }
  const name = match[0]!.trim();
  return INVALID_SUBJECT_NAMES.has(name) ? "" : name;
}

/**
 * Derives a bounded episode-status hint from a sentence.
 *
 * @param sentence - Sentence under inspection.
 * @returns Canonical episode status.
 */
function deriveStatus(text: string): LanguageEpisodeExtractionModelOutput["episodes"][number]["status"] {
  const lowered = text.toLowerCase();
  if (
    lowered.includes("doing better") ||
    lowered.includes("fine now") ||
    lowered.includes("recovered") ||
    lowered.includes("got answers")
  ) {
    return "resolved";
  }
  if (
    lowered.includes("still waiting") ||
    lowered.includes("never told") ||
    lowered.includes("don't know") ||
    lowered.includes("do not know") ||
    lowered.includes("dont know") ||
    lowered.includes("not sure")
  ) {
    return "unresolved";
  }
  return "outcome_unknown";
}

/**
 * Derives bounded confidence for a mock episode candidate.
 *
 * @param sentence - Sentence under inspection.
 * @returns Confidence score in the `[0,1]` range.
 */
function deriveConfidence(sentence: string): number {
  const lowered = sentence.toLowerCase();
  if (lowered.includes("maybe") || lowered.includes("i think")) {
    return 0.68;
  }
  return 0.87;
}
