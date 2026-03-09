/**
 * @fileoverview Tests OpenAI transport-selection and model-profile resolution rules.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseOpenAICompatibilityStrict,
  parseOpenAITransportMode,
  resolveOpenAIModelProfile,
  resolveOpenAITransportSelection
} from "../../src/models/openai/modelProfiles";

test("parseOpenAITransportMode accepts canonical env values", () => {
  assert.equal(parseOpenAITransportMode(undefined), "auto");
  assert.equal(parseOpenAITransportMode("responses"), "responses");
  assert.equal(parseOpenAITransportMode("chat_completions"), "chat_completions");
});

test("resolveOpenAITransportSelection prefers responses for gpt-5 family in auto mode", () => {
  const selection = resolveOpenAITransportSelection("gpt-5", "auto", false);
  assert.equal(selection.transport, "responses");
  assert.equal(selection.profile.id, "gpt-5-family");
  assert.equal(selection.profile.supportsTemperature, false);
});

test("resolveOpenAITransportSelection prefers chat completions for gpt-4.1 family in auto mode", () => {
  const selection = resolveOpenAITransportSelection("gpt-4.1-mini", "auto", false);
  assert.equal(selection.transport, "chat_completions");
  assert.equal(selection.profile.id, "gpt-4.1-family");
  assert.equal(selection.profile.supportsTemperature, true);
});

test("resolveOpenAITransportSelection keeps gpt-4.1-nano on the gpt-4.1 profile", () => {
  const selection = resolveOpenAITransportSelection("gpt-4.1-nano", "auto", false);
  assert.equal(selection.transport, "chat_completions");
  assert.equal(selection.profile.id, "gpt-4.1-family");
});

test("resolveOpenAITransportSelection keeps gpt-5.1 on the gpt-5 profile", () => {
  const selection = resolveOpenAITransportSelection("gpt-5.1", "auto", false);
  assert.equal(selection.transport, "responses");
  assert.equal(selection.profile.id, "gpt-5-family");
});

test("resolveOpenAITransportSelection keeps gpt-5.2 on the gpt-5 profile", () => {
  const selection = resolveOpenAITransportSelection("gpt-5.2", "auto", false);
  assert.equal(selection.transport, "responses");
  assert.equal(selection.profile.id, "gpt-5-family");
});

test("resolveOpenAITransportSelection keeps gpt-5.3-codex on the gpt-5 profile", () => {
  const selection = resolveOpenAITransportSelection("gpt-5.3-codex", "auto", false);
  assert.equal(selection.transport, "responses");
  assert.equal(selection.profile.id, "gpt-5-family");
});

test("resolveOpenAIModelProfile treats unknown provider ids as unknown profiles", () => {
  const profile = resolveOpenAIModelProfile("custom-provider-model");
  assert.equal(profile.known, false);
  assert.equal(profile.id, "unknown-model-family");
});

test("resolveOpenAITransportSelection fails closed on unknown models in strict mode", () => {
  assert.throws(
    () => resolveOpenAITransportSelection("custom-provider-model", "auto", true),
    /not in the compatibility registry/i
  );
});

test("parseOpenAICompatibilityStrict recognizes truthy env values", () => {
  assert.equal(parseOpenAICompatibilityStrict("true"), true);
  assert.equal(parseOpenAICompatibilityStrict("1"), true);
  assert.equal(parseOpenAICompatibilityStrict("false"), false);
});
