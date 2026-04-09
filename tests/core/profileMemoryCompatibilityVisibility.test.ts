/**
 * @fileoverview Focused tests for registry-backed compatibility visibility rules.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isCompatibilityVisibleFactLike } from "../../src/core/profileMemoryRuntime/profileMemoryCompatibilityVisibility";

test("compatibility visibility keeps ordinary current-truth facts readable", () => {
  assert.equal(
    isCompatibilityVisibleFactLike({
      key: "employment.current",
      value: "Lantern Studio",
      source: "user_input_pattern.work_at"
    }),
    true
  );
});

test("compatibility visibility keeps only contact names from historical contact-support sources", () => {
  assert.equal(
    isCompatibilityVisibleFactLike({
      key: "contact.owen.name",
      value: "Owen",
      source: "user_input_pattern.direct_contact_relationship_historical"
    }),
    true
  );
  assert.equal(
    isCompatibilityVisibleFactLike({
      key: "contact.owen.relationship",
      value: "manager",
      source: "user_input_pattern.direct_contact_relationship_historical"
    }),
    false
  );
});

test("compatibility visibility keeps bounded contact context but hides malformed legacy contact-context facts", () => {
  assert.equal(
    isCompatibilityVisibleFactLike({
      key: "contact.owen.context.abc123",
      value: "Owen said the launch slipped.",
      source: "user_input_pattern.contact_context"
    }),
    true
  );
  assert.equal(
    isCompatibilityVisibleFactLike({
      key: "contact.owen.relationship",
      value: "friend",
      source: "user_input_pattern.contact_context"
    }),
    false
  );
});

test("compatibility visibility hides corroboration-free contact entity hints", () => {
  assert.equal(
    isCompatibilityVisibleFactLike({
      key: "contact.owen.name",
      value: "Owen",
      source: "user_input_pattern.contact_entity_hint"
    }),
    false
  );
});
