/**
 * @fileoverview Tests planner skill-action extraction and fallback normalization directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCreateSkillFallbackCode,
  extractCreateSkillNameFromRequest,
  normalizeRequiredCreateSkillParams,
  normalizeRequiredRunSkillParams
} from "../../src/organs/plannerPolicy/skillActionNormalization";

test("normalizeRequiredCreateSkillParams backfills skill name and deterministic fallback code", () => {
  const request = 'Create a skill called smoke_skill to validate browser-proof runs.';
  const normalized = normalizeRequiredCreateSkillParams(
    [
      {
        id: "action_create_skill",
        type: "create_skill",
        description: "create the skill",
        params: {},
        estimatedCostUsd: 0.08
      }
    ],
    request,
    "create_skill"
  );

  assert.equal(extractCreateSkillNameFromRequest(request), "smoke_skill");
  assert.equal(normalized[0]?.params.name, "smoke_skill");
  assert.match(String(normalized[0]?.params.code ?? ""), /export function smoke_skill/i);
});

test("normalizeRequiredRunSkillParams backfills the run-skill name from explicit user intent", () => {
  const normalized = normalizeRequiredRunSkillParams(
    [
      {
        id: "action_run_skill",
        type: "run_skill",
        description: "run the workflow skill",
        params: {},
        estimatedCostUsd: 0.05
      }
    ],
    'Run skill "workflow_skill" and summarize the results.',
    "run_skill"
  );

  assert.equal(normalized[0]?.params.name, "workflow_skill");
});

test("buildCreateSkillFallbackCode produces callable exported scaffold code", () => {
  const code = buildCreateSkillFallbackCode("smoke_skill");

  assert.match(code, /export interface smoke_skillResult/i);
  assert.match(code, /export function smoke_skill\(input: string\)/i);
});
