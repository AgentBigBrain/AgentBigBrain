import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWorkspaceArtifactCandidatePaths
} from "../../src/interfaces/conversationRuntime/workspaceArtifactDiscovery";

test("buildWorkspaceArtifactCandidatePaths preserves Windows path semantics for workspace discovery", () => {
  const rootPath = "C:\\Users\\testuser\\Desktop\\Detroit City Two";
  const candidatePaths = buildWorkspaceArtifactCandidatePaths(rootPath);

  assert.equal(candidatePaths[0], `${rootPath}\\app\\page.tsx`);
  assert.ok(candidatePaths.includes(`${rootPath}\\app\\page.js`));
  assert.ok(candidatePaths.includes(`${rootPath}\\app\\globals.css`));
  assert.ok(candidatePaths.every((candidatePath) => candidatePath.includes("\\")));
});

test("buildWorkspaceArtifactCandidatePaths preserves POSIX path semantics for workspace discovery", () => {
  const rootPath = "/tmp/detroit-city-two";
  const candidatePaths = buildWorkspaceArtifactCandidatePaths(rootPath);

  assert.equal(candidatePaths[0], `${rootPath}/app/page.tsx`);
  assert.ok(candidatePaths.includes(`${rootPath}/pages/index.js`));
  assert.ok(candidatePaths.includes(`${rootPath}/src/index.css`));
  assert.ok(candidatePaths.every((candidatePath) => !candidatePath.includes("\\")));
});
