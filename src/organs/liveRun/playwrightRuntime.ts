/**
 * @fileoverview Shared optional Playwright runtime loading helpers for governed live-run browser flows.
 */

import type { ChildProcess } from "node:child_process";

interface BrowserVerifierChromium {
  launch(options: { headless: boolean }): Promise<BrowserVerifierBrowser>;
}

export interface BrowserVerifierPage {
  goto(
    url: string,
    options: {
      waitUntil: "domcontentloaded";
      timeout: number;
    }
  ): Promise<unknown>;
  title(): Promise<string>;
  textContent(selector: string): Promise<string | null>;
  bringToFront?(): Promise<void>;
  reload?(
    options: {
      waitUntil: "domcontentloaded";
      timeout: number;
    }
  ): Promise<unknown>;
  close?(): Promise<void>;
}

export interface BrowserVerifierContext {
  newPage(): Promise<BrowserVerifierPage>;
  close(): Promise<void>;
}

export interface BrowserVerifierBrowser {
  newContext(): Promise<BrowserVerifierContext>;
  close(): Promise<void>;
  process?(): ChildProcess;
}

interface BrowserVerifierModule {
  chromium?: BrowserVerifierChromium;
  default?: unknown;
  "module.exports"?: unknown;
}

export interface PlaywrightChromiumRuntime {
  chromium: BrowserVerifierChromium;
  sourceModule: "playwright" | "playwright-core";
}

/**
 * Normalizes one unknown value into an object-like module candidate.
 *
 * @param value - Unknown dynamic-import payload or nested export candidate.
 * @returns Module-shaped record or `null` when the value is not object-like.
 */
function asBrowserVerifierModule(value: unknown): BrowserVerifierModule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as BrowserVerifierModule;
}

/**
 * Resolves one Chromium launcher from common ESM/CommonJS optional-import shapes.
 *
 * @param moduleNamespace - Dynamic-import namespace returned by optional Playwright loading.
 * @returns Chromium launcher when found, otherwise `null`.
 */
export function resolvePlaywrightChromiumFromModuleNamespace(
  moduleNamespace: Record<string, unknown>
): BrowserVerifierChromium | null {
  const root = asBrowserVerifierModule(moduleNamespace);
  if (!root) {
    return null;
  }
  const directDefault = asBrowserVerifierModule(root.default);
  const directModuleExports = asBrowserVerifierModule(root["module.exports"]);
  const nestedDefaultModuleExports = directDefault
    ? asBrowserVerifierModule(directDefault["module.exports"])
    : null;

  for (const candidate of [
    root,
    directDefault,
    directModuleExports,
    nestedDefaultModuleExports
  ]) {
    if (candidate?.chromium) {
      return candidate.chromium;
    }
  }
  return null;
}

/**
 * Loads one module namespace with true runtime dynamic import semantics.
 *
 * @param specifier - Module specifier to resolve at runtime.
 * @returns Promise resolving to the imported module namespace.
 */
async function importModuleNamespaceAtRuntime(
  specifier: string
): Promise<Record<string, unknown>> {
  const runtimeDynamicImport = new Function(
    "moduleSpecifier",
    "return import(moduleSpecifier);"
  ) as (moduleSpecifier: string) => Promise<unknown>;
  return (await runtimeDynamicImport(specifier)) as Record<string, unknown>;
}

/**
 * Evaluates whether one error message represents a missing local Playwright runtime.
 *
 * @param message - Error message captured from dynamic import or launch/navigation flow.
 * @returns `true` when the message indicates missing Playwright runtime support.
 */
export function isPlaywrightRuntimeUnavailableMessage(message: string): boolean {
  return (
    /cannot find package ['"]playwright(?:-core)?['"]/i.test(message) ||
    /Cannot find module ['"]playwright(?:-core)?['"]/i.test(message) ||
    /Executable doesn't exist/i.test(message) ||
    /Please run the following command to download new browsers/i.test(message) ||
    /browserType\.launch:/i.test(message)
  );
}

/**
 * Loads one optional Chromium automation backend from local Playwright installs.
 *
 * @returns Promise resolving to a Chromium launcher and its source module, or `null` when missing.
 */
export async function loadPlaywrightChromium(): Promise<PlaywrightChromiumRuntime | null> {
  for (const specifier of ["playwright", "playwright-core"] as const) {
    try {
      const moduleNamespace = (await importModuleNamespaceAtRuntime(
        specifier
      )) as Record<string, unknown>;
      const chromium = resolvePlaywrightChromiumFromModuleNamespace(moduleNamespace);
      if (chromium) {
        return {
          chromium,
          sourceModule: specifier
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isPlaywrightRuntimeUnavailableMessage(message)) {
        throw error;
      }
    }
  }
  return null;
}
