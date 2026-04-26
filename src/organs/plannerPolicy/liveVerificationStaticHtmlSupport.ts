/**
 * @fileoverview Static HTML live-verification lexical support helpers.
 */

const STATIC_HTML_SERVER_OR_BROWSER_PROOF_PATTERN =
  /\b(?:localhost|127\.0\.0\.1|::1|loopback|server|serve|port|readiness|verify|proof|screenshot|playwright|visual(?:ly)?\s+confirm)\b/i;

/**
 * Returns whether a static HTML request asks for server-style or visual proof.
 *
 * **Why it exists:**
 * Plain file previews should not be upgraded to managed server verification unless the user asks
 * for server/browser proof beyond opening the static file.
 *
 * **What it talks to:**
 * - Uses local lexical policy only.
 *
 * @param activeRequest - Normalized current request text.
 * @returns `true` when server or visual proof cues are present.
 */
export function requestsStaticHtmlServerOrBrowserProof(activeRequest: string): boolean {
  return STATIC_HTML_SERVER_OR_BROWSER_PROOF_PATTERN.test(activeRequest);
}
