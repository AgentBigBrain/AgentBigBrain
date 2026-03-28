/**
 * @fileoverview Tests bounded parsing of interpreted media context before profile-memory ingestion.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseProfileMediaIngestInput } from "../../src/core/profileMemoryRuntime/profileMemoryMediaIngest";

test("parseProfileMediaIngestInput strips attached media context from direct text and captures fragments", () => {
  const parsed = parseProfileMediaIngestInput([
    "Please fix this before lunch.",
    "",
    "Attached media context:",
    "- Voice note transcript: My name is Benny and Owen fell down last week.",
    "- image summary: The screenshot shows Owen falling near the stairs. OCR text: Owen fell down near the stairs"
  ].join("\n"));

  assert.equal(parsed.directUserText, "Please fix this before lunch.");
  assert.deepEqual(parsed.transcriptFragments, [
    "My name is Benny and Owen fell down last week."
  ]);
  assert.deepEqual(parsed.summaryFragments, [
    "The screenshot shows Owen falling near the stairs."
  ]);
  assert.deepEqual(parsed.ocrFragments, [
    "Owen fell down near the stairs"
  ]);
  assert.deepEqual(parsed.allNarrativeFragments, [
    "Please fix this before lunch.",
    "My name is Benny and Owen fell down last week.",
    "The screenshot shows Owen falling near the stairs.",
    "Owen fell down near the stairs"
  ]);
});

test("parseProfileMediaIngestInput suppresses generic media-only prompts and still accepts transcript-only input", () => {
  const suppressed = parseProfileMediaIngestInput(
    "Please review the attached image and respond based on what it shows."
  );
  assert.equal(suppressed.directUserText, "");
  assert.deepEqual(suppressed.allNarrativeFragments, []);

  const transcriptOnly = parseProfileMediaIngestInput(
    "Voice note transcript: My favorite editor is Helix and my name is Benny."
  );
  assert.equal(transcriptOnly.directUserText, "");
  assert.deepEqual(transcriptOnly.transcriptFragments, [
    "My favorite editor is Helix and my name is Benny."
  ]);
  assert.deepEqual(transcriptOnly.allNarrativeFragments, [
    "My favorite editor is Helix and my name is Benny."
  ]);
});
