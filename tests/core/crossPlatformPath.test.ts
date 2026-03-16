import assert from "node:assert/strict";
import test from "node:test";

import {
  basenameCrossPlatformPath,
  dirnameCrossPlatformPath,
  extnameCrossPlatformPath,
  localFileUrlToAbsolutePath,
  normalizeCrossPlatformPath
} from "../../src/core/crossPlatformPath";

test("cross-platform path helpers preserve Windows-style fixture paths on any host", () => {
  const windowsFilePath = "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-2\\index.html";

  assert.equal(
    normalizeCrossPlatformPath(windowsFilePath),
    "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-2\\index.html"
  );
  assert.equal(
    dirnameCrossPlatformPath(windowsFilePath),
    "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-2"
  );
  assert.equal(basenameCrossPlatformPath(windowsFilePath), "index.html");
  assert.equal(extnameCrossPlatformPath(windowsFilePath), ".html");
});

test("cross-platform path helpers recover mixed-separator Desktop paths without host drift", () => {
  const mixedPath = "/tmp/agentbigbrain/Desktop\\drone-folder";

  assert.equal(
    normalizeCrossPlatformPath(mixedPath),
    "/tmp/agentbigbrain/Desktop/drone-folder"
  );
  assert.equal(dirnameCrossPlatformPath(mixedPath), "/tmp/agentbigbrain/Desktop");
  assert.equal(basenameCrossPlatformPath(mixedPath), "drone-folder");
});

test("localFileUrlToAbsolutePath converts Windows file URLs into Windows paths on any host", () => {
  assert.equal(
    localFileUrlToAbsolutePath("file:///C:/Users/testuser/Desktop/drone-company/index.html"),
    "C:\\Users\\testuser\\Desktop\\drone-company\\index.html"
  );
});
