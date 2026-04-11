import type { FrameworkLandingPageLayoutVariant } from "./frameworkRuntimeActionFallbackLayoutSupport";
import type { FrameworkLandingPageTheme } from "./frameworkRuntimeActionFallbackThemeSupport";

/**
 * Builds the marquee-sign Detroit variant keyed off the stable request seed.
 *
 * @param requestedSectionCount - Exact bounded section count requested by the user.
 * @param expansiveLayoutRequested - Whether the user asked for extra spacing/breathing room.
 * @param layoutVariant - Stable layout family resolved from the request seed.
 * @returns Deterministic theme metadata for the marquee Detroit family.
 */
export function buildMarqueeCityLandingPageTheme(
  requestedSectionCount: number,
  expansiveLayoutRequested: boolean,
  layoutVariant: FrameworkLandingPageLayoutVariant
): FrameworkLandingPageTheme {
  const sections = [
    {
      title: "Marquee arrival",
      text: "The opening section feels louder and more theatrical, using stronger contrast and longer sightlines so the first impression reads like a destination instead of a placeholder."
    },
    {
      title: "After-hours signal",
      text: "Brighter accent work and wider composition shifts give the middle of the page a different cadence from the brick-and-steel variants."
    },
    {
      title: "Pavement reflections",
      text: "Cards and bands feel wetter, brighter, and more graphic, making the layout read like lit storefronts rather than warehouse blocks."
    },
    {
      title: "Neon close",
      text: "The footer lands like a final sign pass on the block, keeping the page assertive through the last action instead of fading out quietly."
    }
  ].slice(0, requestedSectionCount);

  while (sections.length < requestedSectionCount) {
    const nextIndex = sections.length + 1;
    sections.push({
      title: `Section ${nextIndex}`,
      text: "A bounded fallback section that keeps the landing-page story cohesive."
    });
  }

  return {
    eyebrow: "Neon-rimmed city landing page",
    heroBody:
      "A louder, still gritty Detroit landing page with late-night marquee energy, deeper color contrast, and layout pacing that feels assembled from lit signs, wet pavement, and stacked facades.",
    primaryCta: "Trace the marquee route",
    secondaryCta: "Scan every section",
    footerTagline: "Night-sign launch flow for city-grade products",
    layoutVariant,
    visualVariant: "city",
    visualMarkup: [
      "          <div className=\"city-stage city-stage-marquee\">",
      "            <div className=\"city-haze\" />",
      "            <div className=\"city-grid city-grid-back\" />",
      "            <div className=\"city-grid city-grid-front\" />",
      "            <div className=\"city-marquee city-marquee-one\" />",
      "            <div className=\"city-marquee city-marquee-two\" />",
      "            <div className=\"city-signal city-signal-one\" />",
      "            <div className=\"city-signal city-signal-two\" />",
      "            <div className=\"city-rail city-rail-marquee\" />",
      "          </div>"
    ],
    supplementalStyles: [
      ".city-stage-marquee { background: linear-gradient(180deg, rgba(12,18,28,0.96), rgba(21,9,16,0.98)); border: 1px solid rgba(120,213,255,0.18); }",
      ".city-stage-marquee .city-haze { background: radial-gradient(circle at 50% 22%, rgba(120,213,255,0.22), transparent 36%), radial-gradient(circle at 62% 58%, rgba(255,94,113,0.16), transparent 28%); }",
      ".city-stage-marquee .city-grid { background-size: 26px 26px; }",
      ".city-marquee { position: absolute; left: 12%; right: 12%; height: 48px; border: 1px solid rgba(120,213,255,0.26); background: linear-gradient(90deg, rgba(120,213,255,0.12), rgba(255,94,113,0.2)); box-shadow: 0 0 30px rgba(120,213,255,0.16); }",
      ".city-marquee-one { top: 18%; transform: rotate(-4deg); }",
      ".city-marquee-two { top: 36%; transform: rotate(3deg); }",
      ".city-signal { position: absolute; width: 14px; height: 72px; border-radius: 999px; background: linear-gradient(180deg, rgba(120,213,255,0.94), rgba(255,94,113,0.56)); box-shadow: 0 0 26px rgba(120,213,255,0.42); }",
      ".city-signal-one { left: 18%; bottom: 18%; }",
      ".city-signal-two { right: 20%; bottom: 24%; }",
      ".city-rail-marquee { background: linear-gradient(90deg, rgba(120,213,255,0.22), rgba(255,94,113,0.88), rgba(120,213,255,0.22)); }"
    ],
    sections,
    pageBackground: "#090d15",
    surface: "rgba(16, 21, 32, 0.82)",
    surfaceStrong: "rgba(24, 30, 44, 0.96)",
    ink: "#f1e6d7",
    muted: "#b9adc0",
    line: "rgba(120, 213, 255, 0.16)",
    accent: "#78d5ff",
    accentSoft: "rgba(120, 213, 255, 0.18)",
    shadow: "0 34px 82px rgba(0, 0, 0, 0.46)",
    backgroundFlare:
      "radial-gradient(circle at top, rgba(120, 213, 255, 0.14), transparent 38%), radial-gradient(circle at 78% 18%, rgba(255, 94, 113, 0.1), transparent 28%)",
    shellWidth: expansiveLayoutRequested ? "1240px" : "1140px",
    heroGap: expansiveLayoutRequested ? "40px" : "32px",
    storyGap: expansiveLayoutRequested ? "28px" : "20px",
    panelPadding: expansiveLayoutRequested ? "36px" : "28px",
    panelMinHeight: expansiveLayoutRequested ? "240px" : "0px",
    displayFont: "\"Arial Black\", Impact, sans-serif",
    bodyFont: "\"Trebuchet MS\", Arial, sans-serif",
    uiFont: "\"Arial Black\", Arial, sans-serif"
  };
}
