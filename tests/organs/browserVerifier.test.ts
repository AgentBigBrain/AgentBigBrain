/**
 * @fileoverview Tests optional Playwright module-shape normalization for browser verification.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeBrowserVerificationLaunchMode,
  PlaywrightBrowserVerifier,
  resolvePlaywrightChromiumFromModuleNamespace
} from "../../src/organs/browserVerifier";

test("resolvePlaywrightChromiumFromModuleNamespace accepts top-level chromium export", () => {
  const chromium = {
    launch: async () => ({
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => undefined,
          title: async () => "",
          textContent: async () => "",
          close: async () => undefined
        }),
        close: async () => undefined
      }),
      close: async () => undefined
    })
  };

  const resolved = resolvePlaywrightChromiumFromModuleNamespace({ chromium });
  assert.equal(resolved, chromium);
});

test("resolvePlaywrightChromiumFromModuleNamespace accepts default-wrapped chromium export", () => {
  const chromium = {
    launch: async () => ({
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => undefined,
          title: async () => "",
          textContent: async () => "",
          close: async () => undefined
        }),
        close: async () => undefined
      }),
      close: async () => undefined
    })
  };

  const resolved = resolvePlaywrightChromiumFromModuleNamespace({
    default: { chromium }
  });
  assert.equal(resolved, chromium);
});

test("resolvePlaywrightChromiumFromModuleNamespace accepts module.exports-wrapped chromium export", () => {
  const chromium = {
    launch: async () => ({
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => undefined,
          title: async () => "",
          textContent: async () => "",
          close: async () => undefined
        }),
        close: async () => undefined
      }),
      close: async () => undefined
    })
  };

  const resolved = resolvePlaywrightChromiumFromModuleNamespace({
    "module.exports": { chromium }
  });
  assert.equal(resolved, chromium);
});

test("resolvePlaywrightChromiumFromModuleNamespace accepts nested default module.exports chromium export", () => {
  const chromium = {
    launch: async () => ({
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => undefined,
          title: async () => "",
          textContent: async () => "",
          close: async () => undefined
        }),
        close: async () => undefined
      }),
      close: async () => undefined
    })
  };

  const resolved = resolvePlaywrightChromiumFromModuleNamespace({
    default: {
      "module.exports": { chromium }
    }
  });
  assert.equal(resolved, chromium);
});

test("resolvePlaywrightChromiumFromModuleNamespace returns null when chromium export is absent", () => {
  const resolved = resolvePlaywrightChromiumFromModuleNamespace({
    default: {
      firefox: {}
    }
  });
  assert.equal(resolved, null);
});

test("describeBrowserVerificationLaunchMode distinguishes headless and visible sessions", () => {
  assert.equal(
    describeBrowserVerificationLaunchMode(true),
    "a local headless Chromium session"
  );
  assert.equal(
    describeBrowserVerificationLaunchMode(false),
    "a local visible Chromium window"
  );
});

test("PlaywrightBrowserVerifier honors visible-window override", async () => {
  let launchedHeadless: boolean | null = null;
  const chromium = {
    launch: async ({ headless }: { headless: boolean }) => {
      launchedHeadless = headless;
      return {
        newContext: async () => ({
          newPage: async () => ({
            goto: async () => undefined,
            title: async () => "Playwright Proof Smoke Test",
            textContent: async () => "Browser proof works",
            close: async () => undefined
          }),
          close: async () => undefined
        }),
        close: async () => undefined
      };
    }
  };
  const verifier = new PlaywrightBrowserVerifier({
    headless: false,
    chromiumLoader: async () => ({
      chromium,
      sourceModule: "playwright"
    })
  });

  const result = await verifier.verify({
    url: "http://127.0.0.1:3000/",
    expectedTitle: "Playwright Proof",
    expectedText: "Browser proof works",
    timeoutMs: 2000
  });

  assert.equal(launchedHeadless, false);
  assert.equal(result.status, "verified");
  assert.match(result.detail, /local visible Chromium window/i);
});
