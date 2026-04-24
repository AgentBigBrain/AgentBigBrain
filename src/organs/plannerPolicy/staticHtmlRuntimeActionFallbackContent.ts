import { resolveFrameworkLandingPageTheme } from "./frameworkRuntimeActionFallbackThemeSupport";

/**
 * Escapes html.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Builds placeholder image url.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param label - Input consumed by this helper.
 * @param background - Input consumed by this helper.
 * @param foreground - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function buildPlaceholderImageUrl(label: string, background: string, foreground: string): string {
  return `https://placehold.co/1200x800/${background.replace("#", "")}/${foreground.replace("#", "")}?text=${encodeURIComponent(label)}`;
}

/**
 * Builds static html sections html.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `resolveFrameworkLandingPageTheme` (import `resolveFrameworkLandingPageTheme`) from `./frameworkRuntimeActionFallbackThemeSupport`.
 * @param activeRequest - Input consumed by this helper.
 * @param appTitle - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function buildStaticHtmlSectionsHtml(activeRequest: string, appTitle: string): string {
  const theme = resolveFrameworkLandingPageTheme(activeRequest, appTitle);
  return theme.sections
    .map((section, index) => {
      const imageLabel = `${appTitle} ${section.title}`;
      const imageUrl = buildPlaceholderImageUrl(imageLabel, theme.surfaceStrong, theme.ink);
      const sectionLabel = String(index + 1).padStart(2, "0");
      if (theme.layoutVariant === "rail") {
        return [
          `<article id="section-${index + 1}" class="rail-panel">`,
          "  <div class=\"rail-marker\">",
          `    <span class="section-label">${sectionLabel}</span>`,
          `    <strong>${escapeHtml(section.title)}</strong>`,
          "  </div>",
          "  <div class=\"rail-copy\">",
          `    <h2>${escapeHtml(section.title)}</h2>`,
          `    <p>${escapeHtml(section.text)}</p>`,
          `    <div class="section-visual"><img src="${imageUrl}" alt="${escapeHtml(section.title)} placeholder image" loading="lazy" /></div>`,
          "  </div>",
          "</article>"
        ].join("\n");
      }
      if (theme.layoutVariant === "bands") {
        return [
          `<article id="section-${index + 1}" class="story-band ${index % 2 === 0 ? "story-band-left" : "story-band-right"}">`,
          "  <div class=\"story-band-meta\">",
          `    <span class="section-label">${sectionLabel}</span>`,
          `    <strong>${escapeHtml(section.title)}</strong>`,
          "  </div>",
          "  <div class=\"story-band-copy\">",
          `    <h2>${escapeHtml(section.title)}</h2>`,
          `    <p>${escapeHtml(section.text)}</p>`,
          `    <div class="section-visual"><img src="${imageUrl}" alt="${escapeHtml(section.title)} placeholder image" loading="lazy" /></div>`,
          "  </div>",
          "</article>"
        ].join("\n");
      }
      return [
        `<article id="section-${index + 1}" class="story-panel">`,
        `  <p class="section-label">${sectionLabel}</p>`,
        `  <h2>${escapeHtml(section.title)}</h2>`,
        `  <p>${escapeHtml(section.text)}</p>`,
        `  <div class="section-visual"><img src="${imageUrl}" alt="${escapeHtml(section.title)} placeholder image" loading="lazy" /></div>`,
        "</article>"
      ].join("\n");
    })
    .join("\n");
}

/**
 * Builds static html section container.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `resolveFrameworkLandingPageTheme` (import `resolveFrameworkLandingPageTheme`) from `./frameworkRuntimeActionFallbackThemeSupport`.
 * @param activeRequest - Input consumed by this helper.
 * @param appTitle - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function buildStaticHtmlSectionContainer(activeRequest: string, appTitle: string): string {
  const theme = resolveFrameworkLandingPageTheme(activeRequest, appTitle);
  const sectionsHtml = buildStaticHtmlSectionsHtml(activeRequest, appTitle);
  if (theme.layoutVariant === "rail") {
    return [
      "<section class=\"story-rail\">",
      "  <div class=\"story-rail-line\" aria-hidden=\"true\"></div>",
      sectionsHtml,
      "</section>"
    ].join("\n");
  }
  if (theme.layoutVariant === "bands") {
    return ["<section class=\"story-bands\">", sectionsHtml, "</section>"].join("\n");
  }
  return ["<section class=\"story-grid\">", sectionsHtml, "</section>"].join("\n");
}

/**
 * Builds static html content.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `resolveFrameworkLandingPageTheme` (import `resolveFrameworkLandingPageTheme`) from `./frameworkRuntimeActionFallbackThemeSupport`.
 * @param activeRequest - Input consumed by this helper.
 * @param appTitle - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function buildStaticHtmlContent(activeRequest: string, appTitle: string): string {
  const theme = resolveFrameworkLandingPageTheme(activeRequest, appTitle);
  const heroImageUrl = buildPlaceholderImageUrl(`${appTitle} Hero`, theme.accent, theme.surface);
  const footerMenuItems = theme.sections
    .slice(0, 4)
    .map((section, index) => `<li><a href="#section-${index + 1}">${escapeHtml(section.title)}</a></li>`)
    .concat("<li><a href=\"#footer\">Contact</a></li>")
    .join("");

  return [
    "<!DOCTYPE html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\" />",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    `  <title>${escapeHtml(appTitle)}</title>`,
    `  <meta name="description" content="${escapeHtml(theme.heroBody)}" />`,
    "  <style>",
    "    :root {",
    `      --page-bg: ${theme.pageBackground};`,
    `      --surface: ${theme.surface};`,
    `      --surface-strong: ${theme.surfaceStrong};`,
    `      --ink: ${theme.ink};`,
    `      --muted: ${theme.muted};`,
    `      --line: ${theme.line};`,
    `      --accent: ${theme.accent};`,
    `      --accent-soft: ${theme.accentSoft};`,
    `      --shadow: ${theme.shadow};`,
    `      --shell-width: ${theme.shellWidth};`,
    `      --hero-gap: ${theme.heroGap};`,
    `      --story-gap: ${theme.storyGap};`,
    `      --panel-padding: ${theme.panelPadding};`,
    `      --panel-min-height: ${theme.panelMinHeight};`,
    `      --display-font: ${theme.displayFont};`,
    `      --body-font: ${theme.bodyFont};`,
    `      --ui-font: ${theme.uiFont};`,
    `      --background-flare: ${theme.backgroundFlare};`,
    "    }",
    "    * { box-sizing: border-box; }",
    "    html { scroll-behavior: smooth; background: var(--background-flare), var(--page-bg); }",
    "    body { margin: 0; min-height: 100vh; font-family: var(--body-font); color: var(--ink); background: transparent; }",
    "    img { display: block; width: 100%; height: auto; }",
    "    a { color: inherit; text-decoration: none; }",
    "    .page-shell { width: min(var(--shell-width), calc(100% - 32px)); margin: 0 auto; padding: 28px 0 40px; }",
    "    .top-nav, .page-footer { backdrop-filter: blur(12px); background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow); }",
    "    .top-nav { display: flex; justify-content: space-between; align-items: center; gap: 18px; border-radius: 999px; padding: 18px 24px; position: sticky; top: 18px; z-index: 10; }",
    "    .brand-mark, .section-label, .nav-links, .primary-action, .secondary-action, .footer-menu { font-family: var(--ui-font); }",
    "    .brand-mark { font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }",
    "    .nav-links { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 14px; color: var(--muted); font-size: 0.92rem; }",
    "    .hero-section { display: grid; grid-template-columns: 1.08fr 0.92fr; gap: var(--hero-gap); align-items: center; padding: 56px 12px 34px; }",
    "    .hero-copy h1, .story-panel h2, .rail-copy h2, .story-band-copy h2 { margin: 0; }",
    "    .hero-copy h1 { font-family: var(--display-font); font-size: clamp(3.1rem, 8vw, 5.8rem); line-height: 0.96; }",
    "    .eyebrow, .section-label { letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }",
    "    .hero-body, .story-panel p, .rail-copy p, .story-band-copy p { color: var(--muted); line-height: 1.7; }",
    "    .hero-actions { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 28px; }",
    "    .primary-action, .secondary-action { border-radius: 999px; padding: 14px 18px; }",
    "    .primary-action { background: var(--ink); color: white; }",
    "    .secondary-action { background: var(--surface-strong); border: 1px solid var(--line); }",
    "    .hero-visual { display: flex; justify-content: center; }",
    "    .hero-visual-media { width: min(460px, 100%); border-radius: 34px; overflow: hidden; background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow); }",
    "    .hero-visual-caption { padding: 14px 16px; display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-family: var(--ui-font); font-size: 0.88rem; }",
    "    .story-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--story-gap); margin-top: 10px; }",
    "    .story-panel { border-radius: 28px; padding: var(--panel-padding); min-height: var(--panel-min-height); background: var(--surface-strong); backdrop-filter: blur(12px); border: 1px solid var(--line); box-shadow: var(--shadow); }",
    "    .story-panel h2 { font-size: clamp(1.4rem, 2.2vw, 2rem); margin: 0 0 10px; }",
    "    .story-rail { position: relative; display: grid; gap: var(--story-gap); margin-top: 14px; padding-left: clamp(16px, 4vw, 42px); }",
    "    .story-rail-line { position: absolute; top: 0; bottom: 0; left: clamp(2px, 1vw, 16px); width: 2px; background: linear-gradient(180deg, transparent, var(--accent), transparent); opacity: 0.72; }",
    "    .rail-panel { position: relative; display: grid; grid-template-columns: minmax(110px, 0.38fr) minmax(0, 1fr); gap: 22px; border-radius: 30px; padding: var(--panel-padding); background: var(--surface-strong); backdrop-filter: blur(12px); border: 1px solid var(--line); box-shadow: var(--shadow); }",
    "    .rail-panel::before { content: \"\"; position: absolute; left: calc(clamp(2px, 1vw, 16px) * -1); top: 36px; width: 14px; height: 14px; border-radius: 999px; background: var(--accent); box-shadow: 0 0 24px var(--accent-soft); }",
    "    .rail-marker { display: grid; gap: 10px; align-content: start; color: var(--muted); font-family: var(--ui-font); letter-spacing: 0.06em; text-transform: uppercase; }",
    "    .rail-marker strong { color: var(--ink); font-size: 0.92rem; line-height: 1.4; }",
    "    .rail-copy h2 { margin: 0 0 10px; font-size: clamp(1.55rem, 2.5vw, 2.5rem); }",
    "    .story-bands { display: grid; gap: var(--story-gap); margin-top: 16px; }",
    "    .story-band { display: grid; grid-template-columns: minmax(160px, 0.42fr) minmax(0, 1fr); gap: 26px; align-items: stretch; border-radius: 32px; padding: var(--panel-padding); background: var(--surface-strong); backdrop-filter: blur(12px); border: 1px solid var(--line); box-shadow: var(--shadow); }",
    "    .story-band-right { grid-template-columns: minmax(0, 1fr) minmax(160px, 0.42fr); }",
    "    .story-band-left .story-band-meta { order: 0; }",
    "    .story-band-right .story-band-meta { order: 1; text-align: right; }",
    "    .story-band-right .story-band-copy { order: 0; }",
    "    .story-band-meta { display: grid; gap: 10px; align-content: start; padding: 10px 0; color: var(--muted); font-family: var(--ui-font); letter-spacing: 0.08em; text-transform: uppercase; }",
    "    .story-band-meta strong { color: var(--ink); font-size: 0.92rem; line-height: 1.5; }",
    "    .story-band-copy h2 { margin: 0 0 12px; font-size: clamp(1.7rem, 3vw, 2.8rem); }",
    "    .section-visual { margin-top: 18px; overflow: hidden; border-radius: 24px; border: 1px solid var(--line); box-shadow: var(--shadow); }",
    "    .section-visual img { aspect-ratio: 16 / 10; object-fit: cover; }",
    "    .page-footer { margin-top: 22px; padding: 24px; border-radius: 24px; display: grid; gap: 18px; color: var(--muted); }",
    "    .footer-row { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; flex-wrap: wrap; }",
    "    .footer-menu { list-style: none; display: flex; flex-wrap: wrap; gap: 16px; padding: 0; margin: 0; }",
    "    .footer-menu a { color: var(--ink); }",
    "    @media (max-width: 860px) { .hero-section, .story-grid, .story-band, .story-band-right, .rail-panel { grid-template-columns: 1fr; } .top-nav { border-radius: 28px; } .top-nav, .nav-links, .hero-actions { flex-direction: column; align-items: flex-start; } .story-band-right .story-band-meta, .story-band-right .story-band-copy { order: initial; text-align: left; } }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main class=\"page-shell\">",
    "    <nav class=\"top-nav\">",
    `      <div class="brand-mark">${escapeHtml(appTitle)}</div>`,
    "      <div class=\"nav-links\">",
    ...theme.sections.map((section, index) => `        <a href="#section-${index + 1}">${escapeHtml(section.title)}</a>`),
    "      </div>",
    "    </nav>",
    "    <section class=\"hero-section\">",
    "      <div class=\"hero-copy\">",
    `        <p class="eyebrow">${escapeHtml(theme.eyebrow)}</p>`,
    `        <h1>${escapeHtml(appTitle)}</h1>`,
    `        <p class="hero-body">${escapeHtml(theme.heroBody)}</p>`,
    "        <div class=\"hero-actions\">",
    `          <a class="primary-action" href="#section-1">${escapeHtml(theme.primaryCta)}</a>`,
    `          <a class="secondary-action" href="#footer">${escapeHtml(theme.secondaryCta)}</a>`,
    "        </div>",
    "      </div>",
    "      <div class=\"hero-visual\">",
    "        <div class=\"hero-visual-media\">",
    `          <img src="${heroImageUrl}" alt="${escapeHtml(appTitle)} hero placeholder image" />`,
    "          <div class=\"hero-visual-caption\">",
    `            <span>${escapeHtml(theme.footerTagline)}</span>`,
    "            <span>Placeholder concept image</span>",
    "          </div>",
    "        </div>",
    "      </div>",
    "    </section>",
    buildStaticHtmlSectionContainer(activeRequest, appTitle),
    "    <footer id=\"footer\" class=\"page-footer\">",
    "      <div class=\"footer-row\">",
    `        <strong>${escapeHtml(appTitle)}</strong>`,
    `        <span>${escapeHtml(theme.footerTagline)}</span>`,
    "      </div>",
    "      <div class=\"footer-row\">",
    `        <span>${escapeHtml(theme.primaryCta)} with a polished static page, sticky header, and clear menu structure.</span>`,
    `        <ul class="footer-menu">${footerMenuItems}</ul>`,
    "      </div>",
    "    </footer>",
    "  </main>",
    "</body>",
    "</html>"
  ].join("\n");
}
