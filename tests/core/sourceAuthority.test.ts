/**
 * @fileoverview Tests for shared source-authority vocabulary and normalization.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeSourceAuthority,
  SOURCE_AUTHORITY_VALUES
} from "../../src/core/sourceAuthority";

test("source authority vocabulary includes semantic-runtime authority classes", () => {
  assert.ok(SOURCE_AUTHORITY_VALUES.includes("active_clarification"));
  assert.ok(SOURCE_AUTHORITY_VALUES.includes("stale_runtime_context"));
  assert.ok(SOURCE_AUTHORITY_VALUES.includes("workflow_learning"));
  assert.ok(SOURCE_AUTHORITY_VALUES.includes("compatibility_repair"));
  assert.ok(SOURCE_AUTHORITY_VALUES.includes("strict_schema"));
});

test("normalizeSourceAuthority preserves compatibility repair but still gates legacy compatibility", () => {
  assert.equal(
    normalizeSourceAuthority("compatibility_repair"),
    "compatibility_repair"
  );
  assert.equal(
    normalizeSourceAuthority("legacy_compatibility"),
    "unknown"
  );
  assert.equal(
    normalizeSourceAuthority("legacy_compatibility", { allowLegacyCompatibility: true }),
    "legacy_compatibility"
  );
});
