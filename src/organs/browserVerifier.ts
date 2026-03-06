/**
 * @fileoverview Provides optional Playwright-backed browser verification for loopback-local app and site checks.
 */

import { createAbortError, isAbortError, throwIfAborted } from "../core/runtimeAbort";

/**
 * Browser verification request passed from governed executor actions.
 */
export interface VerifyBrowserRequest {
  url: string;
  expectedTitle?: string | null;
  expectedText?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Stable browser verification status codes returned by runtime verification backends.
 */
export type BrowserVerificationStatus =
  | "verified"
  | "expectation_failed"
  | "runtime_unavailable"
  | "failed";

/**
 * Typed browser verification result returned to the executor.
 */
export interface BrowserVerificationResult {
  status: BrowserVerificationStatus;
  detail: string;
  observedTitle: string | null;
  observedTextSample: string | null;
  matchedTitle: boolean | null;
  matchedText: boolean | null;
}

interface BrowserVerifierPage {
  goto(
    url: string,
    options: {
      waitUntil: "domcontentloaded";
      timeout: number;
    }
  ): Promise<unknown>;
  title(): Promise<string>;
  textContent(selector: string): Promise<string | null>;
  close?(): Promise<void>;
}

interface BrowserVerifierContext {
  newPage(): Promise<BrowserVerifierPage>;
  close(): Promise<void>;
}

interface BrowserVerifierBrowser {
  newContext(): Promise<BrowserVerifierContext>;
  close(): Promise<void>;
}

interface BrowserVerifierChromium {
  launch(options: { headless: boolean }): Promise<BrowserVerifierBrowser>;
}

interface BrowserVerifierModule {
  chromium?: BrowserVerifierChromium;
  default?: unknown;
  "module.exports"?: unknown;
}

interface PlaywrightChromiumRuntime {
  chromium: BrowserVerifierChromium;
  sourceModule: "playwright" | "playwright-core";
}

interface PlaywrightBrowserVerifierOptions {
  headless?: boolean;
  chromiumLoader?: () => Promise<PlaywrightChromiumRuntime | null>;
}

/**
 * Normalizes one unknown value into a browser-verifier module candidate.
 *
 * **Why it exists:**
 * Optional Playwright imports can arrive through direct ESM namespace objects, `default` wrappers,
 * or CommonJS interop envelopes. This helper keeps module-shape handling centralized so browser
 * verification does not incorrectly report "runtime unavailable" when Playwright is installed.
 *
 * **What it talks to:**
 * - Uses local type narrowing only; no cross-module collaborators.
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
 * **Why it exists:**
 * `import()` can expose Playwright through top-level properties, `default`, or CommonJS interop
 * wrappers depending on the calling runtime. This keeps the optional-loader path truthful across
 * those shapes instead of treating valid local installs as missing.
 *
 * **What it talks to:**
 * - Uses `asBrowserVerifierModule` within this module.
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
 * Shared browser verification contract consumed by executor-side runtime actions.
 */
export interface BrowserVerifier {
  /**
   * Verifies one loopback page and returns a typed browser-verification result.
   *
   * **Why it exists:**
   * Keeps executor/browser integration behind one runtime contract so action handlers stay focused
   * on policy and outcome mapping instead of backend-specific automation details.
   *
   * **What it talks to:**
   * - Uses `VerifyBrowserRequest` from this module.
   * - Uses `BrowserVerificationResult` from this module.
   *
   * @param request - Structured verification request for one loopback page.
   * @returns Promise resolving to a typed verification result.
   */
  verify(request: VerifyBrowserRequest): Promise<BrowserVerificationResult>;
}

/**
 * Loads one module namespace with true runtime dynamic import semantics.
 *
 * **Why it exists:**
 * Preserves optional Playwright loading without forcing a static dependency edge or TypeScript
 * downlevel rewrite that would break runtime-only module resolution.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param specifier - Module specifier to resolve at runtime.
 * @returns Promise resolving to the imported module namespace.
 */
async function importModuleNamespaceAtRuntime(specifier: string): Promise<Record<string, unknown>> {
  const runtimeDynamicImport = new Function(
    "moduleSpecifier",
    "return import(moduleSpecifier);"
  ) as (moduleSpecifier: string) => Promise<unknown>;
  return (await runtimeDynamicImport(specifier)) as Record<string, unknown>;
}

/**
 * Returns one normalized optional substring expectation.
 *
 * **Why it exists:**
 * Keeps empty-string expectation handling deterministic so browser-verification matching does not
 * drift across title/text call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Candidate expectation value supplied by planner/executor params.
 * @returns Trimmed expectation string or `null` when the input is empty.
 */
function normalizeOptionalExpectation(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Evaluates one observed value against an optional case-insensitive substring expectation.
 *
 * **Why it exists:**
 * Keeps expectation matching deterministic so browser verification reports one stable notion of
 * "matched" across title and body text checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param observedValue - Observed text captured from the browser page.
 * @param expectedValue - Optional expected substring to match.
 * @returns `true`, `false`, or `null` when no expectation was supplied.
 */
function matchesOptionalExpectation(
  observedValue: string,
  expectedValue: string | null
): boolean | null {
  if (!expectedValue) {
    return null;
  }
  return observedValue.toLowerCase().includes(expectedValue.toLowerCase());
}

/**
 * Builds one bounded browser-text sample for receipts and user-facing summaries.
 *
 * **Why it exists:**
 * Prevents browser verification from emitting unbounded body text while still surfacing enough
 * observed content to explain expectation mismatches deterministically.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Raw text captured from the browser page body.
 * @returns Trimmed, bounded text sample or `null` when empty.
 */
function buildObservedTextSample(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > 240 ? `${normalized.slice(0, 240)}...` : normalized;
}

/**
 * Builds a success detail message for one verified browser check.
 *
 * **Why it exists:**
 * Keeps browser-verification success text deterministic so executor/user-facing renderers do not
 * need to reconstruct title/text matching details ad hoc.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param observedTitle - Title captured from the loaded page.
 * @param matchedTitle - Optional title-match result.
 * @param matchedText - Optional body-text match result.
 * @param headless - Whether Chromium launches in headless mode for this verification.
 * @returns Human-readable success detail text.
 */
function buildVerifiedDetail(
  observedTitle: string,
  matchedTitle: boolean | null,
  matchedText: boolean | null,
  headless: boolean
): string {
  const detailParts = [`observed title "${observedTitle || "(empty title)"}"`];
  if (matchedTitle !== null) {
    detailParts.push(matchedTitle ? "expected title matched" : "expected title mismatch");
  }
  if (matchedText !== null) {
    detailParts.push(matchedText ? "expected text matched" : "expected text mismatch");
  }
  return `Browser verification passed in ${describeBrowserVerificationLaunchMode(headless)}: ${detailParts.join("; ")}.`;
}

/**
 * Builds one expectation-failure detail message from observed browser state.
 *
 * **Why it exists:**
 * Keeps mismatch explanations concise and deterministic so operators see what was checked and what
 * was missing without reading raw Playwright exceptions.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param observedTitle - Title captured from the loaded page.
 * @param observedTextSample - Bounded body-text sample captured from the page.
 * @param expectedTitle - Optional expected title substring.
 * @param expectedText - Optional expected body-text substring.
 * @param matchedTitle - Optional title-match result.
 * @param matchedText - Optional text-match result.
 * @param headless - Whether Chromium launches in headless mode for this verification.
 * @returns Human-readable mismatch detail text.
 */
function buildExpectationFailureDetail(
  observedTitle: string,
  observedTextSample: string | null,
  expectedTitle: string | null,
  expectedText: string | null,
  matchedTitle: boolean | null,
  matchedText: boolean | null,
  headless: boolean
): string {
  const mismatches: string[] = [];
  if (matchedTitle === false && expectedTitle) {
    mismatches.push(`expected title containing "${expectedTitle}"`);
  }
  if (matchedText === false && expectedText) {
    mismatches.push(`expected text containing "${expectedText}"`);
  }
  const observedTextDetail = observedTextSample
    ? ` Observed body sample: "${observedTextSample}".`
    : " Observed body sample was empty.";
  return (
    `Browser verification failed in ${describeBrowserVerificationLaunchMode(headless)}: page loaded, but ${mismatches.join(" and ")} was not found. ` +
    `Observed title: "${observedTitle || "(empty title)"}".${observedTextDetail}`
  );
}

/**
 * Describes whether browser verification runs invisibly or in a visible local window.
 *
 * **Why it exists:**
 * Keeps browser-proof wording consistent across success, mismatch, and failure paths so operators
 * immediately understand whether a visible Chromium window should have appeared.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param headless - Whether Chromium launches in headless mode.
 * @returns Human-readable launch-mode description.
 */
export function describeBrowserVerificationLaunchMode(headless: boolean): string {
  return headless
    ? "a local headless Chromium session"
    : "a local visible Chromium window";
}

/**
 * Evaluates whether one error message represents a missing local Playwright runtime.
 *
 * **Why it exists:**
 * Distinguishes capability-unavailable cases from ordinary navigation/runtime failures so the
 * executor can return a typed "install or provision Playwright locally" outcome.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param message - Error message captured from dynamic import or launch/navigation flow.
 * @returns `true` when the message indicates missing Playwright runtime support.
 */
function isPlaywrightRuntimeUnavailableMessage(message: string): boolean {
  return (
    /cannot find package ['"]playwright(?:-core)?['"]/i.test(message) ||
    /Cannot find module ['"]playwright(?:-core)?['"]/i.test(message) ||
    /Executable doesn't exist/i.test(message) ||
    /Please run the following command to download new browsers/i.test(message) ||
    /browserType\.launch:/i.test(message)
  );
}

/**
 * Waits for one promise while respecting an optional abort signal.
 *
 * **Why it exists:**
 * Gives browser automation calls deterministic cancellation semantics even though Playwright APIs
 * do not consume `AbortSignal` directly.
 *
 * **What it talks to:**
 * - Uses `createAbortError` from `../core/runtimeAbort`.
 * - Uses `throwIfAborted` from `../core/runtimeAbort`.
 *
 * @param operation - Promise representing one browser automation step.
 * @param signal - Optional abort signal propagated from runtime/orchestrator surfaces.
 * @returns Promise resolving to the original operation result.
 */
async function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) {
    return operation;
  }
  return await Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => {
      const handleAbort = (): void => {
        signal.removeEventListener("abort", handleAbort);
        reject(createAbortError());
      };
      signal.addEventListener("abort", handleAbort, { once: true });
    })
  ]);
}

/**
 * Closes one browser automation resource when it exposes a `close()` method.
 *
 * **Why it exists:**
 * Keeps teardown deterministic across browser, context, and page resources without forcing the
 * caller to duplicate null checks and close-error suppression logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param resource - Browser automation resource that may expose an async `close()` method.
 * @returns Promise resolving when teardown work finishes.
 */
async function closeIfPossible(resource: { close?: () => Promise<void> } | null): Promise<void> {
  if (!resource || typeof resource.close !== "function") {
    return;
  }
  try {
    await resource.close();
  } catch {
    // Teardown failures are intentionally suppressed to preserve the primary verification result.
  }
}

/**
 * Loads one optional Chromium automation backend from local Playwright installs.
 *
 * **Why it exists:**
 * Keeps optional dependency loading centralized so the executor can support browser verification
 * when Playwright is installed locally without adding a hard runtime dependency to the repo.
 *
 * **What it talks to:**
 * - Uses `importModuleNamespaceAtRuntime` from this module.
 *
 * @returns Promise resolving to a Chromium launcher and its source module, or `null` when missing.
 */
async function loadPlaywrightChromium(): Promise<PlaywrightChromiumRuntime | null> {
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

/**
 * Playwright-backed local browser verifier used by governed runtime actions.
 */
export class PlaywrightBrowserVerifier implements BrowserVerifier {
  private readonly headless: boolean;
  private readonly chromiumLoader: () => Promise<PlaywrightChromiumRuntime | null>;

  /**
   * Initializes one Playwright-backed browser verifier with deterministic launch settings.
   *
   * **Why it exists:**
   * Keeps browser-verification visibility and optional loader overrides explicit so shared runtime
   * surfaces can toggle headed mode without branching into transport-specific code paths.
   *
   * **What it talks to:**
   * - Uses `loadPlaywrightChromium` within this module.
   *
   * @param options - Optional launch/runtime overrides for local browser verification.
   */
  constructor(options: PlaywrightBrowserVerifierOptions = {}) {
    this.headless = options.headless ?? true;
    this.chromiumLoader = options.chromiumLoader ?? loadPlaywrightChromium;
  }

  /**
   * Verifies one loopback page through a local Playwright Chromium session.
   *
   * **Why it exists:**
   * Gives the runtime a truthful UI/browser proof step for live app workflows without pretending
   * that port or HTTP probes alone confirm rendered page state.
   *
   * **What it talks to:**
   * - Uses `loadPlaywrightChromium` from this module.
   * - Uses `awaitWithAbort` from this module.
   * - Uses `buildObservedTextSample` from this module.
   * - Uses `buildVerifiedDetail` from this module.
   * - Uses `buildExpectationFailureDetail` from this module.
   * - Uses `closeIfPossible` from this module.
   * - Uses `throwIfAborted` from `../core/runtimeAbort`.
   *
   * @param request - Structured verification request for one loopback page.
   * @returns Promise resolving to a typed verification result.
   */
  async verify(request: VerifyBrowserRequest): Promise<BrowserVerificationResult> {
    throwIfAborted(request.signal);
    const expectedTitle = normalizeOptionalExpectation(request.expectedTitle);
    const expectedText = normalizeOptionalExpectation(request.expectedText);
    const playwrightRuntime = await this.chromiumLoader();
    if (!playwrightRuntime) {
      return {
        status: "runtime_unavailable",
        detail:
          "Browser verification is unavailable in this runtime because Playwright is not installed locally. Install playwright or playwright-core plus browser binaries to enable verify_browser.",
        observedTitle: null,
        observedTextSample: null,
        matchedTitle: null,
        matchedText: null
      };
    }

    let browser: BrowserVerifierBrowser | null = null;
    let context: BrowserVerifierContext | null = null;
    let page: BrowserVerifierPage | null = null;

    try {
      browser = await awaitWithAbort(
        playwrightRuntime.chromium.launch({ headless: this.headless }),
        request.signal
      );
      context = await awaitWithAbort(browser.newContext(), request.signal);
      page = await awaitWithAbort(context.newPage(), request.signal);
      await awaitWithAbort(
        page.goto(request.url, {
          waitUntil: "domcontentloaded",
          timeout: request.timeoutMs
        }),
        request.signal
      );
      throwIfAborted(request.signal);

      const observedTitle = (await awaitWithAbort(page.title(), request.signal)).trim();
      const observedBodyText =
        (await awaitWithAbort(page.textContent("body"), request.signal)) ?? "";
      const observedTextSample = buildObservedTextSample(observedBodyText);
      const matchedTitle = matchesOptionalExpectation(observedTitle, expectedTitle);
      const matchedText = matchesOptionalExpectation(observedBodyText, expectedText);
      const expectationsPassed =
        matchedTitle !== false &&
        matchedText !== false;

      if (!expectationsPassed) {
        return {
          status: "expectation_failed",
          detail: buildExpectationFailureDetail(
            observedTitle,
            observedTextSample,
            expectedTitle,
            expectedText,
            matchedTitle,
            matchedText,
            this.headless
          ),
          observedTitle,
          observedTextSample,
          matchedTitle,
          matchedText
        };
      }

      return {
        status: "verified",
        detail: buildVerifiedDetail(
          observedTitle,
          matchedTitle,
          matchedText,
          this.headless
        ),
        observedTitle,
        observedTextSample,
        matchedTitle,
        matchedText
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (isPlaywrightRuntimeUnavailableMessage(message)) {
        return {
          status: "runtime_unavailable",
          detail:
            "Browser verification is unavailable in this runtime because Playwright is missing browser binaries or launch support locally. Install Playwright browser binaries and retry verify_browser.",
          observedTitle: null,
          observedTextSample: null,
          matchedTitle: null,
          matchedText: null
        };
      }
      return {
        status: "failed",
        detail: `Browser verification failed in ${describeBrowserVerificationLaunchMode(this.headless)}: ${message}`,
        observedTitle: null,
        observedTextSample: null,
        matchedTitle: null,
        matchedText: null
      };
    } finally {
      await closeIfPossible(page);
      await closeIfPossible(context);
      await closeIfPossible(browser);
    }
  }
}
