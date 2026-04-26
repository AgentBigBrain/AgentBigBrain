/**
 * @fileoverview Tests planner skill-action extraction and fallback normalization directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractCreateSkillNameFromRequest,
  normalizeRequiredCreateSkillParams,
  normalizeRequiredRunSkillParams
} from "../../src/organs/plannerPolicy/skillActionNormalization";

test("normalizeRequiredCreateSkillParams backfills skill name without executable fallback code", () => {
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
  assert.equal(normalized[0]?.params.code, undefined);
});

test("normalizeRequiredCreateSkillParams preserves explicit executable skill code", () => {
  const normalized = normalizeRequiredCreateSkillParams(
    [
      {
        id: "action_create_skill",
        type: "create_skill",
        description: "create the skill",
        params: {
          name: "smoke_skill",
          kind: "executable_module",
          code: "export function smokeSkill(input: string): string { return input.trim(); }"
        },
        estimatedCostUsd: 0.08
      }
    ],
    "Create skill smoke_skill with explicit code.",
    "create_skill"
  );

  assert.match(String(normalized[0]?.params.code), /export function smokeSkill/);
});

test("normalizeRequiredCreateSkillParams preserves Markdown instruction skill content", () => {
  const normalized = normalizeRequiredCreateSkillParams(
    [
      {
        id: "action_create_skill",
        type: "create_skill",
        description: "create the skill",
        params: {
          name: "writing_skill",
          kind: "markdown_instruction",
          instructions: "Prefer concise Markdown guidance."
        },
        estimatedCostUsd: 0.08
      }
    ],
    "Create markdown skill writing_skill.",
    "create_skill"
  );

  assert.equal(normalized[0]?.params.kind, "markdown_instruction");
  assert.equal(normalized[0]?.params.instructions, "Prefer concise Markdown guidance.");
});

test("normalizeRequiredCreateSkillParams removes placeholder executable code instead of replacing it", () => {
  const normalized = normalizeRequiredCreateSkillParams(
    [
      {
        id: "action_create_skill",
        type: "create_skill",
        description: "create the skill",
        params: {
          name: "smoke_skill",
          kind: "executable_module",
          code: "// TODO: implement this skill"
        },
        estimatedCostUsd: 0.08
      }
    ],
    "Create skill smoke_skill.",
    "create_skill"
  );

  assert.equal(normalized[0]?.params.code, undefined);
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
