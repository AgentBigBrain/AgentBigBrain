/**
 * @fileoverview Deterministic framework landing-page theme resolution kept separate for module size.
 */

import type { FrameworkLandingPageLayoutVariant } from "./frameworkRuntimeActionFallbackLayoutSupport";
import { buildMarqueeCityLandingPageTheme } from "./frameworkRuntimeActionFallbackCityThemeVariants";
import {
  buildDefaultLandingPageTheme,
  buildDroneLandingPageTheme,
  buildFoundryLandingPageTheme,
  buildRiverfrontCityLandingPageTheme,
  buildStreetDetroitLandingPageTheme
} from "./frameworkRuntimeActionFallbackThemeVariants";

export interface FrameworkLandingPageSection {
  readonly title: string;
  readonly text: string;
}

export type FrameworkLandingPageTheme = {
  readonly eyebrow: string;
  readonly heroBody: string;
  readonly primaryCta: string;
  readonly secondaryCta: string;
  readonly footerTagline: string;
  readonly layoutVariant: FrameworkLandingPageLayoutVariant;
  readonly visualVariant: "orb" | "drone" | "city" | "foundry";
  readonly visualMarkup: string[];
  readonly supplementalStyles: readonly string[];
  readonly sections: readonly FrameworkLandingPageSection[];
  readonly pageBackground: string;
  readonly surface: string;
  readonly surfaceStrong: string;
  readonly ink: string;
  readonly muted: string;
  readonly line: string;
  readonly accent: string;
  readonly accentSoft: string;
  readonly shadow: string;
  readonly backgroundFlare: string;
  readonly shellWidth: string;
  readonly heroGap: string;
  readonly storyGap: string;
  readonly panelPadding: string;
  readonly panelMinHeight: string;
  readonly displayFont: string;
  readonly bodyFont: string;
  readonly uiFont: string;
};

const REQUESTED_SECTION_COUNT_PATTERN = /\b([3-6])\s+(?:main\s+)?sections?\b/i;
const DRONE_THEME_PATTERN = /\bdrone\b|\baerial\b|\buav\b|\bflight\b/i;
const CITY_THEME_PATTERN =
  /\b(?:gritty|industrial|street|urban|detroit|steel|brick|concrete|foundry|warehouse)\b/i;
const BLACK_AND_YELLOW_THEME_PATTERN =
  /\b(?:black\s*(?:and|&)\s*yellow|yellow\s*(?:and|&)\s*black|black-yellow|yellow-black)\b/i;
const EXPANSIVE_LAYOUT_PATTERN =
  /\b(?:spaced\s+out|well\s+thought\s+out|breathing\s+room|airy|roomy|expansive)\b/i;
const SERIES_VARIANT_PATTERN =
  /\b(?:city|project|landing\s+page)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i;
const NUMBER_WORD_TO_INDEX = new Map<string, number>([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10]
]);

/** Produces a stable numeric seed from request text so fallback variants remain reproducible. */
function hashThemeSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 1_000_003;
  }
  return hash;
}

/** Extracts an optional numbered-series index from the app title or request wording. */
function resolveSeriesVariantIndex(
  appTitle: string,
  currentUserRequest: string
): number | null {
  const seriesToken =
    appTitle.match(SERIES_VARIANT_PATTERN)?.[1] ??
    currentUserRequest.match(SERIES_VARIANT_PATTERN)?.[1] ??
    null;
  if (!seriesToken) {
    return null;
  }
  const normalizedSeriesToken = seriesToken.trim().toLowerCase();
  const parsedNumericToken = Number.parseInt(normalizedSeriesToken, 10);
  if (Number.isInteger(parsedNumericToken)) {
    return parsedNumericToken;
  }
  return NUMBER_WORD_TO_INDEX.get(normalizedSeriesToken) ?? null;
}

/**
 * Returns one bounded requested section count when the user named it explicitly.
 *
 * @param currentUserRequest - Planner-facing request text.
 * @returns Requested section count, clamped to the supported fallback range.
 */
function resolveRequestedSectionCount(currentUserRequest: string): number {
  const parsedCount = Number.parseInt(
    currentUserRequest.match(REQUESTED_SECTION_COUNT_PATTERN)?.[1] ?? "",
    10
  );
  if (Number.isInteger(parsedCount)) {
    return Math.min(6, Math.max(3, parsedCount));
  }
  return 4;
}

/**
 * Resolves a bounded deterministic landing-page theme from the active request text.
 *
 * @param currentUserRequest - Planner-facing request that triggered fallback generation.
 * @returns Theme copy, section set, and palette metadata scoped to the request.
 */
export function resolveFrameworkLandingPageTheme(
  currentUserRequest: string,
  appTitle = ""
): FrameworkLandingPageTheme {
  const requestedSectionCount = resolveRequestedSectionCount(currentUserRequest);
  const expansiveLayoutRequested = EXPANSIVE_LAYOUT_PATTERN.test(currentUserRequest);
  if (DRONE_THEME_PATTERN.test(currentUserRequest)) {
    return buildDroneLandingPageTheme(requestedSectionCount);
  }

  if (CITY_THEME_PATTERN.test(currentUserRequest)) {
    if (BLACK_AND_YELLOW_THEME_PATTERN.test(currentUserRequest)) {
      return buildFoundryLandingPageTheme(
        requestedSectionCount,
        expansiveLayoutRequested
      );
    }
    const seriesVariantIndex = resolveSeriesVariantIndex(appTitle, currentUserRequest);
    const citySeed = hashThemeSeed(`${appTitle}::${currentUserRequest}`);
    const layoutVariant = seriesVariantIndex !== null
      ? (["grid", "rail", "bands"] as const)[(seriesVariantIndex + 1) % 3]
      : (["grid", "rail", "bands"] as const)[
          Math.floor(citySeed / 3) % 3
        ];
    const paletteVariant = seriesVariantIndex !== null
      ? seriesVariantIndex % 3
      : citySeed % 3;
    if (paletteVariant === 1) {
      return buildRiverfrontCityLandingPageTheme(
        requestedSectionCount,
        expansiveLayoutRequested,
        layoutVariant
      );
    }
    if (paletteVariant === 2) {
      return buildMarqueeCityLandingPageTheme(
        requestedSectionCount,
        expansiveLayoutRequested,
        layoutVariant
      );
    }
    return buildStreetDetroitLandingPageTheme(
      requestedSectionCount,
      expansiveLayoutRequested,
      layoutVariant
    );
  }

  return buildDefaultLandingPageTheme(requestedSectionCount);
}
