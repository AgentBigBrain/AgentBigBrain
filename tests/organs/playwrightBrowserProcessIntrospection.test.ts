import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findNewPlaywrightAutomationBrowserPid,
  isPlaywrightAutomationBrowserProcess,
  type PlaywrightBrowserProcessSnapshot
} from "../../src/organs/liveRun/playwrightBrowserProcessIntrospection";

function buildSnapshot(
  overrides: Partial<PlaywrightBrowserProcessSnapshot>
): PlaywrightBrowserProcessSnapshot {
  return {
    pid: 1000,
    executablePath:
      "C:\\Users\\testuser\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe",
    commandLine:
      "C:\\Users\\testuser\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe --user-data-dir=C:\\Users\\testuser\\AppData\\Local\\Temp\\playwright_chromiumdev_profile-demo --no-startup-window",
    creationDate: "20260315215841.000000-240",
    mainWindowTitle: "Drone Smoke - Google Chrome for Testing",
    ...overrides
  };
}

test("isPlaywrightAutomationBrowserProcess accepts top-level Playwright Chrome for Testing processes", () => {
  assert.equal(isPlaywrightAutomationBrowserProcess(buildSnapshot({})), true);
});

test("isPlaywrightAutomationBrowserProcess rejects Playwright child processes", () => {
  assert.equal(
    isPlaywrightAutomationBrowserProcess(
      buildSnapshot({
        commandLine: `${buildSnapshot({}).commandLine} --type=renderer`
      })
    ),
    false
  );
});

test("isPlaywrightAutomationBrowserProcess rejects user-installed browser processes", () => {
  assert.equal(
    isPlaywrightAutomationBrowserProcess(
      buildSnapshot({
        executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      })
    ),
    false
  );
});

test("findNewPlaywrightAutomationBrowserPid picks the newest new browser pid", () => {
  const before = [
    buildSnapshot({
      pid: 1000,
      creationDate: "20260315215841.000000-240"
    })
  ];
  const after = [
    ...before,
    buildSnapshot({
      pid: 2000,
      creationDate: "20260315215941.000000-240"
    }),
    buildSnapshot({
      pid: 3000,
      creationDate: "20260315220041.000000-240"
    })
  ];

  assert.equal(findNewPlaywrightAutomationBrowserPid(before, after), 3000);
});
