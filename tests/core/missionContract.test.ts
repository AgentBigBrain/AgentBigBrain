/**
 * @fileoverview Guards mission-contract evidence requirements for live-run browser flows.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildMissionCompletionContract } from "../../src/core/autonomy/missionContract";

test("buildMissionCompletionContract does not require browser verification just to open a localhost preview and leave it open", () => {
  const contract = buildMissionCompletionContract(
    "Handle this end to end: reuse the existing Sample City React workspace on my desktop. " +
    "Start its local preview server on http://127.0.0.1:4173/, open that running localhost preview in the browser for me, and leave it open."
  );

  assert.equal(contract.executionStyle, true);
  assert.equal(contract.requireReadinessProof, true);
  assert.equal(contract.requireBrowserProof, false);
  assert.equal(contract.requireBrowserOpenProof, true);
});

test("buildMissionCompletionContract treats run-and-leave-open landing-page goals as live browser-open missions even without explicit localhost wording", () => {
  const contract = buildMissionCompletionContract(
    'I want you to create a nextjs landing page, with 4 sections called "Detroit City" and there should be a footer and header, a gritty feeling design, and you need to do this end to end and put it on my desktop, then leave it open in the browser so i can review it. This means you have to run it and leave it open.'
  );

  assert.equal(contract.executionStyle, true);
  assert.equal(contract.requireReadinessProof, true);
  assert.equal(contract.requireBrowserProof, false);
  assert.equal(contract.requireBrowserOpenProof, true);
  assert.equal(contract.requireProcessStopProof, false);
});

test("buildMissionCompletionContract still requires browser verification for explicit UI verification goals", () => {
  const contract = buildMissionCompletionContract(
    "Create a React app, run it locally on localhost:4173, and verify the homepage UI in the browser before you finish."
  );

  assert.equal(contract.executionStyle, true);
  assert.equal(contract.requireReadinessProof, true);
  assert.equal(contract.requireBrowserProof, true);
  assert.equal(contract.requireBrowserOpenProof, false);
});

test("buildMissionCompletionContract captures quoted and unquoted explicit target paths", () => {
  const contract = buildMissionCompletionContract(
    `Create the app in "C:\\Users\\example\\Desktop\\Sample City" and also verify /home/example/tmp/demo-preview before you finish.`
  );

  assert.deepEqual(contract.targetPathHints, [
    "c:\\users\\example\\desktop\\sample city",
    "\\home\\example\\tmp\\demo-preview"
  ]);
});
