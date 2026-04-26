/**
 * @fileoverview Tests canonical mock planner-response builders.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPlannerOutput } from "../../src/models/mock/plannerResponses";

test("buildPlannerOutput does not synthesize app build workflows for generation prompts", () => {
  const output = buildPlannerOutput(
    JSON.stringify({
      userInput: "Create a React app on my Desktop, run the app, and verify the homepage UI. Execute now."
    })
  );

  assert.equal(output.actions.length, 1);
  assert.equal(output.actions[0].type, "respond");
});

test("buildPlannerOutput prefers the current user request over wrapped context", () => {
  const output = buildPlannerOutput(
    JSON.stringify({
      userInput: [
        "Recent conversation context (oldest to newest):",
        "- User: Create a React app on my Desktop and execute now.",
        "",
        "Current user request:",
        "summarize what is currently running and what is queued right now."
      ].join("\n"),
      currentUserRequest: "summarize what is currently running and what is queued right now."
    })
  );

  assert.equal(output.actions.length, 1);
  assert.equal(output.actions[0].type, "respond");
});

test("buildPlannerOutput only writes files when explicit content is provided", () => {
  const missingContentOutput = buildPlannerOutput(
    JSON.stringify({
      userInput: "Write file runtime/sandbox/generated_note.txt"
    })
  );
  assert.equal(missingContentOutput.actions.length, 1);
  assert.equal(missingContentOutput.actions[0].type, "respond");

  const explicitContentOutput = buildPlannerOutput(
    JSON.stringify({
      userInput: "Write file runtime/sandbox/generated_note.txt with content: hello"
    })
  );
  assert.equal(explicitContentOutput.actions.length, 1);
  const explicitContentAction = explicitContentOutput.actions[0];
  assert.ok(explicitContentAction);
  assert.equal(explicitContentAction.type, "write_file");
  const explicitContentParams = explicitContentAction.params;
  assert.ok(explicitContentParams);
  assert.equal(explicitContentParams.content, "hello");
});

test("buildPlannerOutput only creates skills when explicit content is provided", () => {
  const missingSkillContentOutput = buildPlannerOutput(
    JSON.stringify({
      userInput: "Create skill parser_tool for this workflow"
    })
  );
  assert.equal(missingSkillContentOutput.actions.length, 1);
  assert.equal(missingSkillContentOutput.actions[0].type, "respond");

  const markdownSkillOutput = buildPlannerOutput(
    JSON.stringify({
      userInput: "Create markdown skill parser_tool with instructions: Parse workflow notes."
    })
  );
  assert.equal(markdownSkillOutput.actions.length, 1);
  const markdownSkillAction = markdownSkillOutput.actions[0];
  assert.ok(markdownSkillAction);
  assert.equal(markdownSkillAction.type, "create_skill");
  const markdownSkillParams = markdownSkillAction.params;
  assert.ok(markdownSkillParams);
  assert.equal(markdownSkillParams.kind, "markdown_instruction");

  const executableSkillOutput = buildPlannerOutput(
    JSON.stringify({
      userInput:
        "Create skill parser_tool with code: export function parserTool(input: string): string { return input.trim(); }"
    })
  );
  assert.equal(executableSkillOutput.actions.length, 1);
  const executableSkillAction = executableSkillOutput.actions[0];
  assert.ok(executableSkillAction);
  assert.equal(executableSkillAction.type, "create_skill");
  const executableSkillParams = executableSkillAction.params;
  assert.ok(executableSkillParams);
  assert.equal(executableSkillParams.kind, "executable_module");
});

test("buildPlannerOutput uses explicit preview targets for browser and HTTP actions", () => {
  const output = buildPlannerOutput(
    JSON.stringify({
      userInput:
        "Probe http http://127.0.0.1:4173/health, verify browser http://127.0.0.1:4173/, and open browser http://127.0.0.1:4173/."
    })
  );

  const probeHttpAction = output.actions.find((action) => action.type === "probe_http");
  const verifyBrowserAction = output.actions.find((action) => action.type === "verify_browser");
  const openBrowserAction = output.actions.find((action) => action.type === "open_browser");
  const probeHttpParams = probeHttpAction?.params;
  const verifyBrowserParams = verifyBrowserAction?.params;
  const openBrowserParams = openBrowserAction?.params;
  assert.ok(probeHttpParams);
  assert.ok(verifyBrowserParams);
  assert.ok(openBrowserParams);
  assert.equal(probeHttpParams.url, "http://127.0.0.1:4173/health");
  assert.equal(verifyBrowserParams.url, "http://127.0.0.1:4173/health");
  assert.equal(openBrowserParams.url, "http://127.0.0.1:4173/health");
});

test("buildPlannerOutput does not fabricate browser targets when no URL or session exists", () => {
  const output = buildPlannerOutput(
    JSON.stringify({
      userInput: "Verify browser and open browser, then close browser."
    })
  );

  assert.equal(output.actions.length, 1);
  assert.equal(output.actions[0].type, "respond");
});

test("buildPlannerOutput prefers tracked session ids for natural close-browser follow-ups", () => {
  const output = buildPlannerOutput(
    [
      "Tracked browser sessions:",
      "- Browser window: sessionId=browser_session:sample; url=http://127.0.0.1:4173/; status=open",
      "Linked preview process: leaseId=proc_sample;",
      "Current user request:",
      "close the browser"
    ].join("\n")
  );

  const closeBrowserAction = output.actions[0];
  const stopProcessAction = output.actions[1];
  assert.ok(closeBrowserAction);
  assert.ok(stopProcessAction);
  const closeBrowserParams = closeBrowserAction?.params;
  const stopProcessParams = stopProcessAction?.params;
  assert.ok(closeBrowserParams);
  assert.ok(stopProcessParams);
  assert.equal(closeBrowserAction.type, "close_browser");
  assert.equal(closeBrowserParams.sessionId, "browser_session:sample");
  assert.equal(stopProcessAction.type, "stop_process");
  assert.equal(stopProcessParams.leaseId, "proc_sample");
});

test("buildPlannerOutput uses explicit local ports for probe_port actions", () => {
  const output = buildPlannerOutput(
    JSON.stringify({
      userInput: "Check port 4173 for readiness."
    })
  );

  assert.equal(output.actions.length, 1);
  const probePortAction = output.actions[0];
  assert.ok(probePortAction);
  const probePortParams = probePortAction?.params;
  assert.ok(probePortParams);
  assert.equal(probePortAction.type, "probe_port");
  assert.equal(probePortParams.port, 4173);
});
