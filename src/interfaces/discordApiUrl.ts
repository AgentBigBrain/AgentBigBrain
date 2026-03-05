/**
 * @fileoverview Builds canonical Discord REST API URLs so gateway calls do not drop the `/api/v10` prefix.
 */

export function buildDiscordApiUrl(apiBaseUrl: string, endpointPath: string): URL {
  const normalizedBase = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const normalizedEndpoint = endpointPath.replace(/^\/+/, "");
  return new URL(normalizedEndpoint, normalizedBase);
}

