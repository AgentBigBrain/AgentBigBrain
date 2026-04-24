/**
 * @fileoverview Tests operator-facing Obsidian projection tools and command helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { exportObsidianProjection } from "../../src/tools/exportObsidianProjection";
import { applyObsidianReviewActions } from "../../src/tools/applyObsidianReviewActions";
import { buildObsidianOpenCommand } from "../../src/tools/openObsidianProjection";
import {
  buildObsidianDashboardPath,
  buildObsidianOpenPathUri
} from "../../src/core/projections/targets/obsidianOpenHelpers";

test("exportObsidianProjection fails closed when the obsidian sink is not enabled", async () => {
  await assert.rejects(
    () => exportObsidianProjection({}),
    /Obsidian projection is not enabled/i
  );
});

test("applyObsidianReviewActions fails closed when the obsidian sink is not enabled", async () => {
  await assert.rejects(
    () => applyObsidianReviewActions({}),
    /Obsidian projection is not enabled/i
  );
});

test("buildObsidianOpenCommand chooses the correct launcher for each supported platform", () => {
  const uri = "obsidian://open?path=C%3A%5Cvault%5CAgentBigBrain%5C00%20Dashboard.md";

  assert.deepEqual(buildObsidianOpenCommand(uri, "win32"), {
    command: "cmd",
    args: ["/c", "start", "", uri]
  });
  assert.deepEqual(buildObsidianOpenCommand(uri, "darwin"), {
    command: "open",
    args: [uri]
  });
  assert.deepEqual(buildObsidianOpenCommand(uri, "linux"), {
    command: "xdg-open",
    args: [uri]
  });
});

test("Obsidian path helpers build exact-path dashboard URIs", () => {
  const dashboardPath = buildObsidianDashboardPath(
    "C:\\vault",
    "AgentBigBrain"
  );
  const uri = buildObsidianOpenPathUri(dashboardPath);

  assert.equal(dashboardPath, "C:\\vault\\AgentBigBrain\\00 Dashboard.md");
  assert.equal(
    uri,
    "obsidian://open?path=C%3A%5Cvault%5CAgentBigBrain%5C00%20Dashboard.md"
  );
});
