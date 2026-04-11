/**
 * @fileoverview Deterministic framework landing-page source generators used by planner fallback.
 */

import {
  buildFrameworkLandingPageLayoutStyles,
  buildFrameworkLandingPageSectionMarkup
} from "./frameworkRuntimeActionFallbackLayoutSupport";
import {
  type FrameworkLandingPageSection,
  resolveFrameworkLandingPageTheme
} from "./frameworkRuntimeActionFallbackThemeSupport";

/**
 * Escapes one single-quoted JavaScript literal fragment.
 *
 * @param value - Raw literal content.
 * @returns Escaped single-quoted JavaScript content.
 */
function escapeJavaScriptSingleQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Serializes deterministic landing-page section definitions into inline source lines.
 *
 * @param sections - Ordered section titles and body copy for the fallback page.
 * @returns JavaScript source lines for the exported `sections` constant.
 */
function buildThemeSections(sections: readonly FrameworkLandingPageSection[]): string[] {
  return [
    "const sections = [",
    ...sections.flatMap((section, index) => {
      const titleLine =
        `  { title: '${escapeJavaScriptSingleQuoted(section.title)}', ` +
        `text: '${escapeJavaScriptSingleQuoted(section.text)}' }`;
      return index === sections.length - 1 ? [titleLine] : [`${titleLine},`];
    }),
    "];"
  ];
}

/**
 * Returns one bounded requested section count when the user named it explicitly.
 *
 * @param currentUserRequest - Planner-facing request text.
 * @returns Requested section count, clamped to the supported fallback range.
 */
/**
 * Builds deterministic content for Next.js app-router `app/layout.js`.
 *
 * @param appTitle - Human-facing app title from the request.
 * @returns Full file content.
 */
export function buildNextLayoutContent(appTitle: string): string {
  const escapedTitle = escapeJavaScriptSingleQuoted(appTitle);
  return [
    "import \"./globals.css\";",
    "",
    "export const metadata = {",
    `  title: '${escapedTitle}',`,
    `  description: '${escapedTitle} landing page'`,
    "};",
    "",
    "export default function RootLayout({ children }) {",
    "  return (",
    "    <html lang=\"en\">",
    "      <body>{children}</body>",
    "    </html>",
    "  );",
    "}"
  ].join("\n");
}

/**
 * Builds deterministic content for TypeScript Next.js app-router `app/layout.tsx`.
 *
 * @param appTitle - Human-facing app title from the request.
 * @returns Full file content.
 */
export function buildNextTypeScriptLayoutContent(appTitle: string): string {
  const escapedTitle = escapeJavaScriptSingleQuoted(appTitle);
  return [
    "import type { ReactNode } from \"react\";",
    "import \"./globals.css\";",
    "",
    "export const metadata = {",
    `  title: '${escapedTitle}',`,
    `  description: '${escapedTitle} landing page'`,
    "};",
    "",
    "export default function RootLayout({ children }: { children: ReactNode }) {",
    "  return (",
    "    <html lang=\"en\">",
    "      <body>{children}</body>",
    "    </html>",
    "  );",
    "}"
  ].join("\n");
}

/**
 * Builds deterministic content for a framework landing-page primary view file.
 *
 * @param kind - Framework scaffold kind resolved from the request.
 * @param appTitle - Human-facing app title from the request.
 * @returns Full file content.
 */
export function buildFrameworkLandingPageContent(
  kind: "vite_react" | "next_js",
  appTitle: string,
  currentUserRequest: string
): string {
  const escapedTitle = escapeJavaScriptSingleQuoted(appTitle);
  const componentName = kind === "next_js" ? "Home" : "App";
  const theme = resolveFrameworkLandingPageTheme(currentUserRequest, appTitle);
  return [
    ...buildThemeSections(theme.sections),
    "",
    `export default function ${componentName}() {`,
    "  return (",
    "    <main className=\"page-shell\">",
    "      <nav className=\"top-nav\">",
    `        <div className="brand-mark">${escapedTitle}</div>`,
    "        <div className=\"nav-links\">",
    "          {sections.map((section, index) => (",
    "            <a key={section.title} href={`#section-${index + 1}`}>{section.title}</a>",
    "          ))}",
    "        </div>",
    "      </nav>",
    "",
    "      <section className=\"hero-section\">",
    "        <div className=\"hero-copy\">",
    `          <p className="eyebrow">${escapeJavaScriptSingleQuoted(theme.eyebrow)}</p>`,
    `          <h1>${escapedTitle}</h1>`,
    "          <p className=\"hero-body\">",
    `            ${escapeJavaScriptSingleQuoted(theme.heroBody)}`,
    "          </p>",
    "          <div className=\"hero-actions\">",
    `            <a className="primary-action" href="#section-1">${escapeJavaScriptSingleQuoted(theme.primaryCta)}</a>`,
    `            <a className="secondary-action" href="#footer">${escapeJavaScriptSingleQuoted(theme.secondaryCta)}</a>`,
    "          </div>",
    "        </div>",
    "        <div className=\"hero-visual\" aria-hidden=\"true\">",
    ...theme.visualMarkup,
    "        </div>",
    "      </section>",
    "",
    ...buildFrameworkLandingPageSectionMarkup(theme.layoutVariant),
    "",
    "      <footer id=\"footer\" className=\"page-footer\">",
    `        <span>${escapedTitle}</span>`,
    `        <span>${escapeJavaScriptSingleQuoted(theme.footerTagline)}</span>`,
    "      </footer>",
    "    </main>",
    "  );",
    "}"
  ].join("\n");
}

/**
 * Builds deterministic styling for fallback framework landing pages.
 *
 * @returns Full stylesheet content.
 */
export function buildFrameworkLandingPageStyles(
  currentUserRequest: string,
  appTitle = ""
): string {
  const theme = resolveFrameworkLandingPageTheme(currentUserRequest, appTitle);
  return [
    ":root {",
    "  color-scheme: light;",
    `  --page-bg: ${theme.pageBackground};`,
    `  --surface: ${theme.surface};`,
    `  --surface-strong: ${theme.surfaceStrong};`,
    `  --ink: ${theme.ink};`,
    `  --muted: ${theme.muted};`,
    `  --line: ${theme.line};`,
    `  --accent: ${theme.accent};`,
    `  --accent-soft: ${theme.accentSoft};`,
    `  --shadow: ${theme.shadow};`,
    `  --shell-width: ${theme.shellWidth};`,
    `  --hero-gap: ${theme.heroGap};`,
    `  --story-gap: ${theme.storyGap};`,
    `  --panel-padding: ${theme.panelPadding};`,
    `  --panel-min-height: ${theme.panelMinHeight};`,
    `  --display-font: ${theme.displayFont};`,
    `  --body-font: ${theme.bodyFont};`,
    `  --ui-font: ${theme.uiFont};`,
    "}",
    "",
    "* { box-sizing: border-box; }",
    "",
    "html {",
    "  scroll-behavior: smooth;",
    `  background: ${theme.backgroundFlare}, var(--page-bg);`,
    "}",
    "",
    "body {",
    "  margin: 0;",
    "  min-height: 100vh;",
    "  font-family: var(--body-font);",
    "  color: var(--ink);",
    "  background: transparent;",
    "}",
    "",
    "a { color: inherit; text-decoration: none; }",
    "",
    ".page-shell { width: min(var(--shell-width), calc(100% - 32px)); margin: 0 auto; padding: 28px 0 40px; }",
    ".top-nav, .page-footer { backdrop-filter: blur(12px); background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow); }",
    ".top-nav { display: flex; justify-content: space-between; align-items: center; gap: 18px; border-radius: 999px; padding: 18px 24px; position: sticky; top: 18px; z-index: 10; }",
    ".brand-mark, .section-label, .nav-links, .primary-action, .secondary-action { font-family: var(--ui-font); }",
    ".brand-mark { font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }",
    ".nav-links { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 14px; color: var(--muted); font-size: 0.92rem; }",
    ".hero-section { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: var(--hero-gap); align-items: center; padding: 56px 12px 34px; }",
    ".hero-copy h1, .story-panel h2, .rail-copy h2, .story-band-copy h2 { margin: 0; }",
    ".hero-copy h1 { font-family: var(--display-font); font-size: clamp(3.2rem, 8vw, 5.6rem); line-height: 0.96; }",
    ".eyebrow, .section-label { letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }",
    ".hero-body, .story-panel p, .rail-copy p, .story-band-copy p { color: var(--muted); line-height: 1.7; }",
    ".hero-actions { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 28px; }",
    ".primary-action, .secondary-action { border-radius: 999px; padding: 14px 18px; }",
    ".primary-action { background: var(--ink); color: white; }",
    ".secondary-action { background: var(--surface-strong); border: 1px solid var(--line); }",
    ".hero-visual { display: flex; justify-content: center; }",
    ...(theme.visualVariant === "drone"
      ? [
          ".drone-stage { position: relative; width: min(420px, 100%); aspect-ratio: 1; border-radius: 36px; background: linear-gradient(180deg, rgba(255,255,255,0.9), rgba(220,236,227,0.68)); border: 1px solid rgba(79, 143, 122, 0.22); box-shadow: var(--shadow); overflow: hidden; }",
          ".drone-ring { position: absolute; inset: auto 0 18% 0; margin: auto; border-radius: 999px; border: 1px solid rgba(79,143,122,0.22); }",
          ".drone-ring-one { width: 72%; height: 72%; }",
          ".drone-ring-two { width: 52%; height: 52%; bottom: 28%; }",
          ".drone-body { position: absolute; inset: 0; margin: auto; width: 90px; height: 90px; animation: drift 4.8s ease-in-out infinite; }",
          ".drone-core { position: absolute; inset: 26px; display: block; border-radius: 22px; background: linear-gradient(180deg, #183129, #4f8f7a); }",
          ".drone-arm { position: absolute; display: block; width: 68px; height: 12px; background: linear-gradient(90deg, #7ab79f, #183129); border-radius: 999px; }",
          ".drone-arm-one { top: 8px; left: -18px; transform: rotate(34deg); }",
          ".drone-arm-two { top: 8px; right: -18px; transform: rotate(-34deg); }",
          ".drone-arm-three { bottom: 8px; left: -18px; transform: rotate(-34deg); }",
          ".drone-arm-four { bottom: 8px; right: -18px; transform: rotate(34deg); }"
        ]
      : theme.visualVariant === "city"
        ? [
            ".city-stage { position: relative; width: min(420px, 100%); aspect-ratio: 1; border-radius: 36px; background: linear-gradient(180deg, rgba(34,26,21,0.94), rgba(19,16,14,0.98)); border: 1px solid rgba(217,109,49,0.18); box-shadow: var(--shadow); overflow: hidden; }",
            ".city-haze { position: absolute; inset: 0; background: radial-gradient(circle at 50% 24%, rgba(217,109,49,0.28), transparent 42%); }",
            ".city-grid { position: absolute; inset: auto 0 0 0; height: 56%; background-image: linear-gradient(rgba(242,223,200,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(242,223,200,0.05) 1px, transparent 1px); background-size: 34px 34px; }",
            ".city-grid-back { opacity: 0.42; transform: skewY(-12deg) translateY(12%); }",
            ".city-grid-front { opacity: 0.16; transform: skewY(-12deg) translateY(22%); }",
            ".city-stack { position: absolute; bottom: 18%; width: 16%; background: linear-gradient(180deg, rgba(217,109,49,0.22), rgba(242,223,200,0.08)); border: 1px solid rgba(242,223,200,0.1); box-shadow: 0 18px 32px rgba(0,0,0,0.18); }",
            ".city-stack-one { left: 12%; height: 34%; }",
            ".city-stack-two { left: 32%; height: 52%; }",
            ".city-stack-three { right: 28%; height: 44%; }",
            ".city-stack-four { right: 10%; height: 62%; }",
            ".city-rail { position: absolute; left: 8%; right: 8%; bottom: 11%; height: 10px; border-radius: 999px; background: linear-gradient(90deg, rgba(242,223,200,0.18), rgba(217,109,49,0.76), rgba(242,223,200,0.18)); }"
          ]
        : theme.visualVariant === "foundry"
          ? [
              ".foundry-stage { position: relative; width: min(440px, 100%); aspect-ratio: 1; border-radius: 36px; background: linear-gradient(180deg, rgba(10,10,10,0.96), rgba(20,20,20,0.98)); border: 1px solid rgba(246,217,74,0.18); box-shadow: var(--shadow); overflow: hidden; }",
              ".foundry-glow { position: absolute; inset: 0; background: radial-gradient(circle at 50% 16%, rgba(246,217,74,0.26), transparent 34%); }",
              ".foundry-grid { position: absolute; inset: 0; background-image: linear-gradient(rgba(246,217,74,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(246,217,74,0.06) 1px, transparent 1px); background-size: 38px 38px; opacity: 0.42; }",
              ".foundry-beam { position: absolute; top: 18%; width: 56%; height: 14px; border-radius: 999px; background: linear-gradient(90deg, transparent, rgba(246,217,74,0.94), transparent); }",
              ".foundry-beam-one { left: -4%; transform: rotate(-16deg); }",
              ".foundry-beam-two { right: -6%; transform: rotate(18deg); }",
              ".foundry-block { position: absolute; bottom: 14%; width: 18%; background: linear-gradient(180deg, rgba(246,217,74,0.18), rgba(246,217,74,0.04)); border: 1px solid rgba(246,217,74,0.12); box-shadow: 0 18px 30px rgba(0,0,0,0.26); }",
              ".foundry-block-one { left: 10%; height: 48%; }",
              ".foundry-block-two { left: 36%; height: 66%; }",
              ".foundry-block-three { right: 12%; height: 54%; }",
              ".foundry-spark { position: absolute; width: 10px; height: 10px; border-radius: 999px; background: rgba(246,217,74,0.92); box-shadow: 0 0 22px rgba(246,217,74,0.6); }",
              ".foundry-spark-one { top: 30%; left: 28%; }",
              ".foundry-spark-two { top: 42%; right: 24%; }"
            ]
        : [
            ".hero-orb-stage { position: relative; width: min(420px, 100%); aspect-ratio: 1; border-radius: 36px; background: linear-gradient(180deg, rgba(255,255,255,0.9), rgba(220,236,227,0.68)); border: 1px solid rgba(79, 143, 122, 0.22); box-shadow: var(--shadow); overflow: hidden; }",
            ".hero-orb { position: absolute; inset: 0; margin: auto; border-radius: 999px; filter: blur(1px); animation: drift 5.4s ease-in-out infinite; }",
            ".hero-orb-back { width: 78%; height: 78%; background: radial-gradient(circle, rgba(79, 143, 122, 0.18), rgba(79, 143, 122, 0.02) 70%); }",
            ".hero-orb-mid { width: 50%; height: 50%; background: radial-gradient(circle, rgba(24, 49, 41, 0.18), rgba(24, 49, 41, 0.03) 72%); animation-duration: 6.2s; }",
            ".hero-orb-front { width: 22%; height: 22%; background: linear-gradient(180deg, rgba(24, 49, 41, 0.94), rgba(79, 143, 122, 0.72)); box-shadow: 0 18px 40px rgba(24, 49, 41, 0.22); }",
            ".hero-card { position: absolute; left: 50%; bottom: 12%; transform: translateX(-50%); min-width: 220px; padding: 16px 18px; border-radius: 20px; background: rgba(255,255,255,0.84); border: 1px solid rgba(24, 49, 41, 0.08); box-shadow: var(--shadow); }",
            ".hero-card-label { display: block; margin-bottom: 6px; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; font: 600 0.76rem/1 Arial, sans-serif; }",
            ".hero-card strong { display: block; font-size: 1.05rem; }"
          ]),
    ...theme.supplementalStyles,
    ...buildFrameworkLandingPageLayoutStyles(theme.layoutVariant),
    ".page-footer { margin-top: 22px; padding: 20px 24px; border-radius: 24px; display: flex; justify-content: space-between; gap: 12px; color: var(--muted); flex-wrap: wrap; }",
    "@keyframes drift { 0%, 100% { transform: translateY(0px) rotate(0deg); } 50% { transform: translateY(-12px) rotate(2deg); } }",
    "@media (max-width: 860px) { .hero-section { grid-template-columns: 1fr; } .top-nav { border-radius: 28px; } .top-nav, .nav-links, .page-footer, .hero-actions { flex-direction: column; align-items: flex-start; } }"
  ].join("\n");
}
