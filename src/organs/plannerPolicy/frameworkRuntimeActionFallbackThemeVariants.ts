import type { FrameworkLandingPageLayoutVariant } from "./frameworkRuntimeActionFallbackLayoutSupport";
import type {
  FrameworkLandingPageSection,
  FrameworkLandingPageTheme
} from "./frameworkRuntimeActionFallbackThemeSupport";

const NO_SUPPLEMENTAL_STYLES: readonly string[] = [];

/** Fits one bounded fallback section list to the exact requested count. */
function fitThemeSections(
  baseSections: readonly FrameworkLandingPageSection[],
  requestedCount: number
): readonly FrameworkLandingPageSection[] {
  if (baseSections.length === requestedCount) {
    return baseSections;
  }
  if (baseSections.length > requestedCount) {
    return baseSections.slice(0, requestedCount);
  }
  const sections = [...baseSections];
  while (sections.length < requestedCount) {
    const nextIndex = sections.length + 1;
    sections.push({
      title: `Section ${nextIndex}`,
      text: "A bounded fallback section that keeps the landing-page story cohesive."
    });
  }
  return sections;
}

/** Builds the bounded drone-themed fallback palette and section copy. */
export function buildDroneLandingPageTheme(
  requestedSectionCount: number
): FrameworkLandingPageTheme {
  return {
    eyebrow: "Single-page landing experience",
    heroBody:
      "A calm, polished landing page with a flying drone hero, a grounded story arc, and a clean path toward action.",
    primaryCta: "See the launch plan",
    secondaryCta: "Explore the sections",
    footerTagline: "Calm launch flow for modern drone products",
    layoutVariant: "grid",
    visualVariant: "drone",
    visualMarkup: [
      "          <div className=\"drone-stage\">",
      "            <div className=\"drone-ring drone-ring-one\" />",
      "            <div className=\"drone-ring drone-ring-two\" />",
      "            <div className=\"drone-body\">",
      "              <span className=\"drone-core\" />",
      "              <span className=\"drone-arm drone-arm-one\" />",
      "              <span className=\"drone-arm drone-arm-two\" />",
      "              <span className=\"drone-arm drone-arm-three\" />",
      "              <span className=\"drone-arm drone-arm-four\" />",
      "            </div>",
      "          </div>"
    ],
    supplementalStyles: NO_SUPPLEMENTAL_STYLES,
    sections: fitThemeSections(
      [
        {
          title: "Guided setup",
          text: "A calm structure that explains the product without rushing the reader."
        },
        {
          title: "Quiet confidence",
          text: "Soft visual rhythm, clear copy, and a hero that feels stable instead of noisy."
        },
        {
          title: "Flight planning",
          text: "A simple feature story that makes the path from interest to action feel obvious."
        },
        {
          title: "Trusted delivery",
          text: "A reassurance section for reliability, support, and predictable rollout."
        },
        {
          title: "Ready to launch",
          text: "A low-pressure closing section with one clear call to action."
        }
      ],
      requestedSectionCount
    ),
    pageBackground: "#eef3ea",
    surface: "rgba(255, 255, 255, 0.78)",
    surfaceStrong: "rgba(255, 255, 255, 0.92)",
    ink: "#183129",
    muted: "#557168",
    line: "rgba(24, 49, 41, 0.12)",
    accent: "#4f8f7a",
    accentSoft: "rgba(79, 143, 122, 0.18)",
    shadow: "0 24px 60px rgba(39, 65, 57, 0.14)",
    backgroundFlare:
      "radial-gradient(circle at top, rgba(130, 178, 158, 0.22), transparent 40%)",
    shellWidth: "1120px",
    heroGap: "28px",
    storyGap: "18px",
    panelPadding: "26px",
    panelMinHeight: "0px",
    displayFont: "Georgia, \"Times New Roman\", serif",
    bodyFont: "Georgia, \"Times New Roman\", serif",
    uiFont: "Arial, sans-serif"
  };
}

/** Builds the black-and-yellow Detroit foundry variant for explicit palette requests. */
export function buildFoundryLandingPageTheme(
  requestedSectionCount: number,
  expansiveLayoutRequested: boolean
): FrameworkLandingPageTheme {
  return {
    eyebrow: "Black-and-gold city landing page",
    heroBody:
      "A heavier Detroit landing page with soot-dark surfaces, signal-yellow highlights, wider breathing room, and section spacing that feels deliberate instead of cramped.",
    primaryCta: "Scan the night blocks",
    secondaryCta: "Walk the full layout",
    footerTagline: "Black-gold city rhythm with room to breathe",
    layoutVariant: expansiveLayoutRequested ? "rail" : "grid",
    visualVariant: "foundry",
    visualMarkup: [
      "          <div className=\"foundry-stage\">",
      "            <div className=\"foundry-glow\" />",
      "            <div className=\"foundry-grid\" />",
      "            <div className=\"foundry-beam foundry-beam-one\" />",
      "            <div className=\"foundry-beam foundry-beam-two\" />",
      "            <div className=\"foundry-block foundry-block-one\" />",
      "            <div className=\"foundry-block foundry-block-two\" />",
      "            <div className=\"foundry-block foundry-block-three\" />",
      "            <div className=\"foundry-spark foundry-spark-one\" />",
      "            <div className=\"foundry-spark foundry-spark-two\" />",
      "          </div>"
    ],
    supplementalStyles: NO_SUPPLEMENTAL_STYLES,
    sections: fitThemeSections(
      [
        {
          title: "Signal-yellow arrival",
          text: "The opening section lands with dark contrast, heavy letterforms, and more space between elements so the page feels intentional from the first fold."
        },
        {
          title: "Shift-change cadence",
          text: "Wide section rhythm and disciplined copy blocks give the layout a calmer, more deliberate pulse even while the palette stays aggressive."
        },
        {
          title: "Steel-line proof",
          text: "Mid-page panels frame features like illuminated street markers, with stronger separation between cards so each section reads as its own moment."
        },
        {
          title: "Last-call footer",
          text: "The footer closes like a marked loading dock: visible, grounded, and unmistakably part of the same black-and-gold system."
        }
      ],
      requestedSectionCount
    ),
    pageBackground: "#090909",
    surface: "rgba(18, 18, 18, 0.9)",
    surfaceStrong: "rgba(24, 24, 24, 0.98)",
    ink: "#f6d94a",
    muted: "#d8c57a",
    line: "rgba(246, 217, 74, 0.18)",
    accent: "#f6d94a",
    accentSoft: "rgba(246, 217, 74, 0.16)",
    shadow: "0 34px 80px rgba(0, 0, 0, 0.5)",
    backgroundFlare:
      "radial-gradient(circle at top, rgba(246, 217, 74, 0.18), transparent 38%)",
    shellWidth: expansiveLayoutRequested ? "1240px" : "1160px",
    heroGap: expansiveLayoutRequested ? "40px" : "30px",
    storyGap: expansiveLayoutRequested ? "28px" : "20px",
    panelPadding: expansiveLayoutRequested ? "36px" : "30px",
    panelMinHeight: expansiveLayoutRequested ? "280px" : "220px",
    displayFont: "Impact, Haettenschweiler, \"Arial Narrow Bold\", sans-serif",
    bodyFont: "\"Palatino Linotype\", Georgia, serif",
    uiFont: "\"Arial Black\", Arial, sans-serif"
  };
}

/** Builds the riverfront Detroit variant keyed off the stable request seed. */
export function buildRiverfrontCityLandingPageTheme(
  requestedSectionCount: number,
  expansiveLayoutRequested: boolean,
  layoutVariant: FrameworkLandingPageLayoutVariant
): FrameworkLandingPageTheme {
  return {
    eyebrow: "Detroit-built landing page",
    heroBody:
      "A gritty, late-night landing page with deeper section pacing, shadow-heavy surfaces, and a city story that feels assembled from riverfront lights, loading docks, and concrete edges.",
    primaryCta: "Ride the night route",
    secondaryCta: "See the section map",
    footerTagline: "Late-shift launch flow for city-grade products",
    layoutVariant,
    visualVariant: "city",
    visualMarkup: [
      "          <div className=\"city-stage city-stage-riverfront\">",
      "            <div className=\"city-haze\" />",
      "            <div className=\"city-grid city-grid-back\" />",
      "            <div className=\"city-grid city-grid-front\" />",
      "            <div className=\"city-stack city-stack-one\" />",
      "            <div className=\"city-stack city-stack-two\" />",
      "            <div className=\"city-stack city-stack-three\" />",
      "            <div className=\"city-stack city-stack-four\" />",
      "            <div className=\"city-rail\" />",
      "          </div>"
    ],
    supplementalStyles: NO_SUPPLEMENTAL_STYLES,
    sections: fitThemeSections(
      [
        {
          title: "Riverfront entry",
          text: "The first section feels colder and more cinematic, with copy that frames the page like a real district instead of a generic launch screen."
        },
        {
          title: "Dockside structure",
          text: "Panels read like stacked blocks along a loading route, with stronger separation and a more deliberate reading order."
        },
        {
          title: "Midnight traffic",
          text: "The center of the page carries motion and utility together so the story feels active without losing control."
        },
        {
          title: "Concrete close",
          text: "The footer lands as a destination rather than an afterthought, keeping the industrial tone intact through the final call to action."
        }
      ],
      requestedSectionCount
    ),
    pageBackground: "#0f1013",
    surface: "rgba(22, 24, 30, 0.84)",
    surfaceStrong: "rgba(31, 34, 42, 0.96)",
    ink: "#e9dccb",
    muted: "#bfa48a",
    line: "rgba(233, 220, 203, 0.14)",
    accent: "#d79254",
    accentSoft: "rgba(215, 146, 84, 0.18)",
    shadow: "0 30px 72px rgba(0, 0, 0, 0.42)",
    backgroundFlare:
      "radial-gradient(circle at top, rgba(215, 146, 84, 0.16), transparent 42%)",
    shellWidth: expansiveLayoutRequested ? "1200px" : "1120px",
    heroGap: expansiveLayoutRequested ? "36px" : "28px",
    storyGap: expansiveLayoutRequested ? "24px" : "18px",
    panelPadding: expansiveLayoutRequested ? "34px" : "26px",
    panelMinHeight: expansiveLayoutRequested ? "240px" : "0px",
    displayFont: "Georgia, \"Times New Roman\", serif",
    bodyFont: "Georgia, \"Times New Roman\", serif",
    uiFont: "Arial, sans-serif"
  };
}

/** Builds the default gritty Detroit city variant. */
export function buildStreetDetroitLandingPageTheme(
  requestedSectionCount: number,
  expansiveLayoutRequested: boolean,
  layoutVariant: FrameworkLandingPageLayoutVariant
): FrameworkLandingPageTheme {
  return {
    eyebrow: "Detroit-built landing page",
    heroBody:
      "A gritty, high-contrast landing page with industrial rhythm, strong header and footer anchors, and a sharper story that feels built from brick, steel, and late-shift momentum.",
    primaryCta: "Review the city story",
    secondaryCta: "Jump to the sections",
    footerTagline: "Grit-first launch flow for city-grade products",
    layoutVariant,
    visualVariant: "city",
    visualMarkup: [
      "          <div className=\"city-stage\">",
      "            <div className=\"city-haze\" />",
      "            <div className=\"city-grid city-grid-back\" />",
      "            <div className=\"city-grid city-grid-front\" />",
      "            <div className=\"city-stack city-stack-one\" />",
      "            <div className=\"city-stack city-stack-two\" />",
      "            <div className=\"city-stack city-stack-three\" />",
      "            <div className=\"city-stack city-stack-four\" />",
      "            <div className=\"city-rail\" />",
      "          </div>"
    ],
    supplementalStyles: NO_SUPPLEMENTAL_STYLES,
    sections: fitThemeSections(
      [
        {
          title: "Street-level welcome",
          text: "A bold opener that feels local, direct, and built for real city traffic instead of polished startup distance."
        },
        {
          title: "Industrial craft",
          text: "Texture-heavy layout choices, tight copy blocks, and grounded detail that make the page feel made rather than templated."
        },
        {
          title: "Neighborhood pulse",
          text: "A mid-page story beat for movement, events, and local energy so the site feels active instead of static."
        },
        {
          title: "After-hours proof",
          text: "A closing section that lands with confidence, practical direction, and a footer that feels like a real destination."
        }
      ],
      requestedSectionCount
    ),
    pageBackground: "#120f0d",
    surface: "rgba(28, 21, 17, 0.84)",
    surfaceStrong: "rgba(39, 29, 24, 0.96)",
    ink: "#f2dfc8",
    muted: "#c4aa89",
    line: "rgba(242, 223, 200, 0.14)",
    accent: "#d96d31",
    accentSoft: "rgba(217, 109, 49, 0.18)",
    shadow: "0 30px 72px rgba(0, 0, 0, 0.38)",
    backgroundFlare:
      "radial-gradient(circle at top, rgba(217, 109, 49, 0.18), transparent 42%)",
    shellWidth: expansiveLayoutRequested ? "1200px" : "1120px",
    heroGap: expansiveLayoutRequested ? "36px" : "28px",
    storyGap: expansiveLayoutRequested ? "24px" : "18px",
    panelPadding: expansiveLayoutRequested ? "34px" : "26px",
    panelMinHeight: expansiveLayoutRequested ? "240px" : "0px",
    displayFont: "Georgia, \"Times New Roman\", serif",
    bodyFont: "Georgia, \"Times New Roman\", serif",
    uiFont: "Arial, sans-serif"
  };
}

/** Builds the calm generic landing-page fallback used for non-drone, non-city requests. */
export function buildDefaultLandingPageTheme(
  requestedSectionCount: number
): FrameworkLandingPageTheme {
  return {
    eyebrow: "Single-page landing experience",
    heroBody:
      "A polished, modern landing page with a strong hero moment, a grounded story arc, and a clean path toward action.",
    primaryCta: "See the overview",
    secondaryCta: "Explore the sections",
    footerTagline: "Calm launch flow for modern products",
    layoutVariant: "grid",
    visualVariant: "orb",
    visualMarkup: [
      "          <div className=\"hero-orb-stage\">",
      "            <div className=\"hero-orb hero-orb-back\" />",
      "            <div className=\"hero-orb hero-orb-mid\" />",
      "            <div className=\"hero-orb hero-orb-front\" />",
      "            <div className=\"hero-card\">",
      "              <span className=\"hero-card-label\">Featured flow</span>",
      "              <strong>Polished first impression</strong>",
      "            </div>",
      "          </div>"
    ],
    supplementalStyles: NO_SUPPLEMENTAL_STYLES,
    sections: fitThemeSections(
      [
        {
          title: "Guided setup",
          text: "A calm structure that explains the product without rushing the reader."
        },
        {
          title: "Quiet confidence",
          text: "Soft visual rhythm, clear copy, and a hero that feels stable instead of noisy."
        },
        {
          title: "Core value",
          text: "A simple feature story that makes the path from interest to action feel obvious."
        },
        {
          title: "Trusted delivery",
          text: "A reassurance section for reliability, support, and predictable rollout."
        },
        {
          title: "Ready to launch",
          text: "A low-pressure closing section with one clear call to action."
        }
      ],
      requestedSectionCount
    ),
    pageBackground: "#eef3ea",
    surface: "rgba(255, 255, 255, 0.78)",
    surfaceStrong: "rgba(255, 255, 255, 0.92)",
    ink: "#183129",
    muted: "#557168",
    line: "rgba(24, 49, 41, 0.12)",
    accent: "#4f8f7a",
    accentSoft: "rgba(79, 143, 122, 0.18)",
    shadow: "0 24px 60px rgba(39, 65, 57, 0.14)",
    backgroundFlare:
      "radial-gradient(circle at top, rgba(130, 178, 158, 0.22), transparent 40%)",
    shellWidth: "1120px",
    heroGap: "28px",
    storyGap: "18px",
    panelPadding: "26px",
    panelMinHeight: "0px",
    displayFont: "Georgia, \"Times New Roman\", serif",
    bodyFont: "Georgia, \"Times New Roman\", serif",
    uiFont: "Arial, sans-serif"
  };
}
