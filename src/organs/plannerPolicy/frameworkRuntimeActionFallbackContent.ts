/**
 * @fileoverview Deterministic framework landing-page source generators used by planner fallback.
 */
function escapeJavaScriptSingleQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

type FrameworkLandingPageTheme = {
  readonly eyebrow: string;
  readonly heroBody: string;
  readonly primaryCta: string;
  readonly secondaryCta: string;
  readonly overviewHeading: string;
  readonly overviewBody: string;
  readonly reliabilityHeading: string;
  readonly reliabilityBody: string;
  readonly launchHeading: string;
  readonly launchBody: string;
  readonly footerTagline: string;
  readonly visualClassName: string;
  readonly visualMarkup: string[];
  readonly sections: ReadonlyArray<{ readonly title: string; readonly text: string }>;
};

/**
 * Serializes deterministic landing-page section definitions into inline source lines.
 *
 * @param sections - Ordered section titles and body copy for the fallback page.
 * @returns JavaScript source lines for the exported `sections` constant.
 */
function buildThemeSections(
  sections: ReadonlyArray<{ readonly title: string; readonly text: string }>
): string[] {
  return [
    `const sections = [`,
    ...sections.flatMap((section, index) => {
      const titleLine =
        `  { title: '${escapeJavaScriptSingleQuoted(section.title)}', ` +
        `text: '${escapeJavaScriptSingleQuoted(section.text)}' }`;
      return index === sections.length - 1 ? [titleLine] : [`${titleLine},`];
    }),
    `];`
  ];
}

/**
 * Resolves a bounded deterministic landing-page theme from the active request text.
 *
 * @param currentUserRequest - Planner-facing request that triggered fallback generation.
 * @returns Theme copy and hero visual metadata scoped to the request.
 */
function resolveFrameworkLandingPageTheme(currentUserRequest: string): FrameworkLandingPageTheme {
  const normalized = currentUserRequest.toLowerCase();
  if (/\bdrone\b|\baerial\b|\buav\b|\bflight\b/.test(normalized)) {
    return {
      eyebrow: "Single-page landing experience",
      heroBody:
        "A calm, polished landing page with a flying drone hero, a grounded story arc, and a clean path toward action.",
      primaryCta: "See the launch plan",
      secondaryCta: "Explore the sections",
      overviewHeading: "A calmer story for a faster product",
      overviewBody:
        "This page is designed to feel composed and modern while still making the product feel capable. The sections below keep the narrative simple and useful.",
      reliabilityHeading: "Designed to feel steady, even when the product is moving fast",
      reliabilityBody:
        "Clear spacing, controlled typography, and a measured palette keep the page human and credible while the drone visual adds motion at the center.",
      launchHeading: "Ready to leave open for review",
      launchBody:
        "The page is built as a single-screen narrative with navigation, five sections, and a footer so it can be reviewed live in the browser.",
      footerTagline: "Calm launch flow for modern drone products",
      visualClassName: "drone-stage",
      visualMarkup: [
        `          <div className="drone-stage">`,
        `            <div className="drone-ring drone-ring-one" />`,
        `            <div className="drone-ring drone-ring-two" />`,
        `            <div className="drone-body">`,
        `              <span className="drone-core" />`,
        `              <span className="drone-arm drone-arm-one" />`,
        `              <span className="drone-arm drone-arm-two" />`,
        `              <span className="drone-arm drone-arm-three" />`,
        `              <span className="drone-arm drone-arm-four" />`,
        `            </div>`,
        `          </div>`
      ],
      sections: [
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
      ]
    };
  }

  return {
    eyebrow: "Single-page landing experience",
    heroBody:
      "A polished, modern landing page with a strong hero moment, a grounded story arc, and a clean path toward action.",
    primaryCta: "See the overview",
    secondaryCta: "Explore the sections",
    overviewHeading: "A calmer story for a clearer product",
    overviewBody:
      "This page is designed to feel composed and modern while still making the offer feel capable. The sections below keep the narrative simple and useful.",
    reliabilityHeading: "Designed to feel steady, even when the product is moving fast",
    reliabilityBody:
      "Clear spacing, controlled typography, and a measured palette keep the page human and credible while the hero visual adds motion at the center.",
    launchHeading: "Ready to leave open for review",
    launchBody:
      "The page is built as a single-screen narrative with navigation, five sections, and a footer so it can be reviewed live in the browser.",
    footerTagline: "Calm launch flow for modern products",
    visualClassName: "hero-orb-stage",
    visualMarkup: [
      `          <div className="hero-orb-stage">`,
      `            <div className="hero-orb hero-orb-back" />`,
      `            <div className="hero-orb hero-orb-mid" />`,
      `            <div className="hero-orb hero-orb-front" />`,
      `            <div className="hero-card">`,
      `              <span className="hero-card-label">Featured flow</span>`,
      `              <strong>Polished first impression</strong>`,
      `            </div>`,
      `          </div>`
    ],
    sections: [
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
    ]
  };
}

/**
 * Builds deterministic content for Next.js app-router `app/layout.js`.
 *
 * @param appTitle - Human-facing app title from the request.
 * @returns Full file content.
 */
export function buildNextLayoutContent(appTitle: string): string {
  const escapedTitle = escapeJavaScriptSingleQuoted(appTitle);
  return [
    `import "./globals.css";`,
    ``,
    `export const metadata = {`,
    `  title: '${escapedTitle}',`,
    `  description: '${escapedTitle} landing page'`,
    `};`,
    ``,
    `export default function RootLayout({ children }) {`,
    `  return (`,
    `    <html lang="en">`,
    `      <body>{children}</body>`,
    `    </html>`,
    `  );`,
    `}`
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
    `import type { ReactNode } from "react";`,
    `import "./globals.css";`,
    ``,
    `export const metadata = {`,
    `  title: '${escapedTitle}',`,
    `  description: '${escapedTitle} landing page'`,
    `};`,
    ``,
    `export default function RootLayout({ children }: { children: ReactNode }) {`,
    `  return (`,
    `    <html lang="en">`,
    `      <body>{children}</body>`,
    `    </html>`,
    `  );`,
    `}`
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
  const theme = resolveFrameworkLandingPageTheme(currentUserRequest);
  return [
    ...buildThemeSections(theme.sections),
    ``,
    `export default function ${componentName}() {`,
    `  return (`,
    `    <main className="page-shell">`,
    `      <nav className="top-nav">`,
    `        <div className="brand-mark">${escapedTitle}</div>`,
    `        <div className="nav-links">`,
    `          <a href="#story">Story</a>`,
    `          <a href="#features">Flow</a>`,
    `          <a href="#trust">Trust</a>`,
    `          <a href="#launch">Launch</a>`,
    `        </div>`,
    `      </nav>`,
    ``,
    `      <section className="hero-section">`,
    `        <div className="hero-copy">`,
    `          <p className="eyebrow">${escapeJavaScriptSingleQuoted(theme.eyebrow)}</p>`,
    `          <h1>${escapedTitle}</h1>`,
    `          <p className="hero-body">`,
    `            ${escapeJavaScriptSingleQuoted(theme.heroBody)}`,
    `          </p>`,
    `          <div className="hero-actions">`,
    `            <a className="primary-action" href="#launch">${escapeJavaScriptSingleQuoted(theme.primaryCta)}</a>`,
    `            <a className="secondary-action" href="#story">${escapeJavaScriptSingleQuoted(theme.secondaryCta)}</a>`,
    `          </div>`,
    `        </div>`,
    `        <div className="hero-visual" aria-hidden="true">`,
    ...theme.visualMarkup,
    `        </div>`,
    `      </section>`,
    ``,
    `      <section id="story" className="content-band intro-band">`,
    `        <div>`,
    `          <p className="section-label">Overview</p>`,
    `          <h2>${escapeJavaScriptSingleQuoted(theme.overviewHeading)}</h2>`,
    `        </div>`,
    `        <p>`,
    `          ${escapeJavaScriptSingleQuoted(theme.overviewBody)}`,
    `        </p>`,
    `      </section>`,
    ``,
    `      <section id="features" className="section-grid">`,
    `        {sections.map((section, index) => (`,
    `          <article key={section.title} className="feature-card">`,
    `            <p className="section-label">0{index + 1}</p>`,
    `            <h3>{section.title}</h3>`,
    `            <p>{section.text}</p>`,
    `          </article>`,
    `        ))}`,
    `      </section>`,
    ``,
    `      <section id="trust" className="content-band trust-band">`,
    `        <div>`,
    `          <p className="section-label">Reliability</p>`,
    `          <h2>${escapeJavaScriptSingleQuoted(theme.reliabilityHeading)}</h2>`,
    `        </div>`,
    `        <p>`,
    `          ${escapeJavaScriptSingleQuoted(theme.reliabilityBody)}`,
    `        </p>`,
    `      </section>`,
    ``,
    `      <section id="launch" className="content-band launch-band">`,
    `        <div>`,
    `          <p className="section-label">Launch</p>`,
    `          <h2>${escapeJavaScriptSingleQuoted(theme.launchHeading)}</h2>`,
    `        </div>`,
    `        <p>`,
    `          ${escapeJavaScriptSingleQuoted(theme.launchBody)}`,
    `        </p>`,
    `      </section>`,
    ``,
    `      <footer className="page-footer">`,
    `        <span>${escapedTitle}</span>`,
    `        <span>${escapeJavaScriptSingleQuoted(theme.footerTagline)}</span>`,
    `      </footer>`,
    `    </main>`,
    `  );`,
    `}`
  ].join("\n");
}

/**
 * Builds deterministic styling for fallback framework landing pages.
 *
 * @returns Full stylesheet content.
 */
export function buildFrameworkLandingPageStyles(currentUserRequest: string): string {
  const theme = resolveFrameworkLandingPageTheme(currentUserRequest);
  return [
    `:root {`,
    `  color-scheme: light;`,
    `  --page-bg: #eef3ea;`,
    `  --surface: rgba(255, 255, 255, 0.78);`,
    `  --surface-strong: rgba(255, 255, 255, 0.92);`,
    `  --ink: #183129;`,
    `  --muted: #557168;`,
    `  --line: rgba(24, 49, 41, 0.12);`,
    `  --accent: #4f8f7a;`,
    `  --accent-soft: rgba(79, 143, 122, 0.18);`,
    `  --shadow: 0 24px 60px rgba(39, 65, 57, 0.14);`,
    `}`,
    ``,
    `* { box-sizing: border-box; }`,
    ``,
    `html {`,
    `  scroll-behavior: smooth;`,
    `  background: radial-gradient(circle at top, rgba(130, 178, 158, 0.22), transparent 40%), var(--page-bg);`,
    `}`,
    ``,
    `body {`,
    `  margin: 0;`,
    `  min-height: 100vh;`,
    `  font-family: Georgia, "Times New Roman", serif;`,
    `  color: var(--ink);`,
    `  background: transparent;`,
    `}`,
    ``,
    `a { color: inherit; text-decoration: none; }`,
    ``,
    `.page-shell { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 40px; }`,
    `.top-nav, .content-band, .page-footer { backdrop-filter: blur(12px); background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow); }`,
    `.top-nav { display: flex; justify-content: space-between; align-items: center; gap: 18px; border-radius: 999px; padding: 18px 24px; position: sticky; top: 18px; z-index: 10; }`,
    `.brand-mark, .section-label, .nav-links, .primary-action, .secondary-action { font-family: Arial, sans-serif; }`,
    `.brand-mark { font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }`,
    `.nav-links { display: flex; gap: 18px; color: var(--muted); font-size: 0.95rem; }`,
    `.hero-section { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 28px; align-items: center; padding: 56px 12px 28px; }`,
    `.hero-copy h1, .content-band h2, .feature-card h3 { margin: 0; }`,
    `.hero-copy h1 { font-size: clamp(3.2rem, 8vw, 5.6rem); line-height: 0.96; }`,
    `.eyebrow, .section-label { letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }`,
    `.hero-body, .content-band p, .feature-card p { color: var(--muted); line-height: 1.7; }`,
    `.hero-actions { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 28px; }`,
    `.primary-action, .secondary-action { border-radius: 999px; padding: 14px 18px; }`,
    `.primary-action { background: var(--ink); color: white; }`,
    `.secondary-action { background: var(--surface-strong); border: 1px solid var(--line); }`,
    `.hero-visual { display: flex; justify-content: center; }`,
    ...(theme.visualClassName === "drone-stage"
      ? [
          `.drone-stage { position: relative; width: min(420px, 100%); aspect-ratio: 1; border-radius: 36px; background: linear-gradient(180deg, rgba(255,255,255,0.9), rgba(220,236,227,0.68)); border: 1px solid rgba(79, 143, 122, 0.22); box-shadow: var(--shadow); overflow: hidden; }`,
          `.drone-ring { position: absolute; inset: auto 0 18% 0; margin: auto; border-radius: 999px; border: 1px solid rgba(79,143,122,0.22); }`,
          `.drone-ring-one { width: 72%; height: 72%; }`,
          `.drone-ring-two { width: 52%; height: 52%; bottom: 28%; }`,
          `.drone-body { position: absolute; inset: 0; margin: auto; width: 90px; height: 90px; animation: drift 4.8s ease-in-out infinite; }`,
          `.drone-core { position: absolute; inset: 26px; display: block; border-radius: 22px; background: linear-gradient(180deg, #183129, #4f8f7a); }`,
          `.drone-arm { position: absolute; display: block; width: 68px; height: 12px; background: linear-gradient(90deg, #7ab79f, #183129); border-radius: 999px; }`,
          `.drone-arm-one { top: 8px; left: -18px; transform: rotate(34deg); }`,
          `.drone-arm-two { top: 8px; right: -18px; transform: rotate(-34deg); }`,
          `.drone-arm-three { bottom: 8px; left: -18px; transform: rotate(-34deg); }`,
          `.drone-arm-four { bottom: 8px; right: -18px; transform: rotate(34deg); }`
        ]
      : [
          `.hero-orb-stage { position: relative; width: min(420px, 100%); aspect-ratio: 1; border-radius: 36px; background: linear-gradient(180deg, rgba(255,255,255,0.9), rgba(220,236,227,0.68)); border: 1px solid rgba(79, 143, 122, 0.22); box-shadow: var(--shadow); overflow: hidden; }`,
          `.hero-orb { position: absolute; inset: 0; margin: auto; border-radius: 999px; filter: blur(1px); animation: drift 5.4s ease-in-out infinite; }`,
          `.hero-orb-back { width: 78%; height: 78%; background: radial-gradient(circle, rgba(79, 143, 122, 0.18), rgba(79, 143, 122, 0.02) 70%); }`,
          `.hero-orb-mid { width: 50%; height: 50%; background: radial-gradient(circle, rgba(24, 49, 41, 0.18), rgba(24, 49, 41, 0.03) 72%); animation-duration: 6.2s; }`,
          `.hero-orb-front { width: 22%; height: 22%; background: linear-gradient(180deg, rgba(24, 49, 41, 0.94), rgba(79, 143, 122, 0.72)); box-shadow: 0 18px 40px rgba(24, 49, 41, 0.22); }`,
          `.hero-card { position: absolute; left: 50%; bottom: 12%; transform: translateX(-50%); min-width: 220px; padding: 16px 18px; border-radius: 20px; background: rgba(255,255,255,0.84); border: 1px solid rgba(24, 49, 41, 0.08); box-shadow: var(--shadow); }`,
          `.hero-card-label { display: block; margin-bottom: 6px; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; font: 600 0.76rem/1 Arial, sans-serif; }`,
          `.hero-card strong { display: block; font-size: 1.05rem; }`
        ]),
    `.content-band { display: grid; gap: 18px; grid-template-columns: 1fr 1fr; border-radius: 28px; padding: 28px; margin-top: 22px; }`,
    `.section-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 22px; }`,
    `.feature-card { padding: 24px; border-radius: 26px; background: var(--surface-strong); border: 1px solid var(--line); box-shadow: var(--shadow); }`,
    `.page-footer { margin-top: 22px; padding: 20px 24px; border-radius: 24px; display: flex; justify-content: space-between; gap: 12px; color: var(--muted); flex-wrap: wrap; }`,
    `@keyframes drift { 0%, 100% { transform: translateY(0px) rotate(0deg); } 50% { transform: translateY(-12px) rotate(2deg); } }`,
    `@media (max-width: 860px) { .top-nav, .hero-section, .content-band, .section-grid { grid-template-columns: 1fr; } .top-nav { border-radius: 28px; } .top-nav, .nav-links, .page-footer, .hero-actions { flex-direction: column; align-items: flex-start; } }`
  ].join("\n");
}
