/**
 * @fileoverview Shared deterministic landing-page layout markup and styles for framework fallback.
 */

export type FrameworkLandingPageLayoutVariant = "grid" | "rail" | "bands";

/**
 * Builds section markup lines for one deterministic layout family.
 *
 * @param layoutVariant - Stable layout family resolved from the request seed.
 * @returns JSX source lines rendered inside the page component.
 */
export function buildFrameworkLandingPageSectionMarkup(
  layoutVariant: FrameworkLandingPageLayoutVariant
): string[] {
  if (layoutVariant === "rail") {
    return [
      "      <section className=\"story-rail\">",
      "        <div className=\"story-rail-line\" aria-hidden=\"true\" />",
      "        {sections.map((section, index) => (",
      "          <article",
      "            id={`section-${index + 1}`}",
      "            key={section.title}",
      "            className=\"rail-panel\"",
      "          >",
      "            <div className=\"rail-marker\">",
      "              <span className=\"section-label\">{String(index + 1).padStart(2, \"0\")}</span>",
      "              <strong>{section.title}</strong>",
      "            </div>",
      "            <div className=\"rail-copy\">",
      "              <h2>{section.title}</h2>",
      "              <p>{section.text}</p>",
      "            </div>",
      "          </article>",
      "        ))}",
      "      </section>"
    ];
  }

  if (layoutVariant === "bands") {
    return [
      "      <section className=\"story-bands\">",
      "        {sections.map((section, index) => (",
      "          <article",
      "            id={`section-${index + 1}`}",
      "            key={section.title}",
      "            className={`story-band ${index % 2 === 0 ? \"story-band-left\" : \"story-band-right\"}`}",
      "          >",
      "            <div className=\"story-band-meta\">",
      "              <span className=\"section-label\">{String(index + 1).padStart(2, \"0\")}</span>",
      "              <strong>{section.title}</strong>",
      "            </div>",
      "            <div className=\"story-band-copy\">",
      "              <h2>{section.title}</h2>",
      "              <p>{section.text}</p>",
      "            </div>",
      "          </article>",
      "        ))}",
      "      </section>"
    ];
  }

  return [
    "      <section className=\"story-grid\">",
    "        {sections.map((section, index) => (",
    "          <article",
    "            id={`section-${index + 1}`}",
    "            key={section.title}",
    "            className=\"story-panel\"",
    "          >",
    "            <p className=\"section-label\">{String(index + 1).padStart(2, \"0\")}</p>",
    "            <h2>{section.title}</h2>",
    "            <p>{section.text}</p>",
    "          </article>",
    "        ))}",
    "      </section>"
  ];
}

/**
 * Builds layout-specific stylesheet lines for one deterministic landing-page family.
 *
 * @param layoutVariant - Stable layout family resolved from the request seed.
 * @returns CSS source lines appended to the framework landing-page stylesheet.
 */
export function buildFrameworkLandingPageLayoutStyles(
  layoutVariant: FrameworkLandingPageLayoutVariant
): string[] {
  if (layoutVariant === "rail") {
    return [
      ".story-rail { position: relative; display: grid; gap: var(--story-gap); margin-top: 14px; padding-left: clamp(16px, 4vw, 42px); }",
      ".story-rail-line { position: absolute; top: 0; bottom: 0; left: clamp(2px, 1vw, 16px); width: 2px; background: linear-gradient(180deg, transparent, var(--accent), transparent); opacity: 0.72; }",
      ".rail-panel { position: relative; display: grid; grid-template-columns: minmax(110px, 0.38fr) minmax(0, 1fr); gap: 22px; border-radius: 30px; padding: var(--panel-padding); background: var(--surface-strong); backdrop-filter: blur(12px); border: 1px solid var(--line); box-shadow: var(--shadow); }",
      ".rail-panel::before { content: \"\"; position: absolute; left: calc(clamp(2px, 1vw, 16px) * -1); top: 36px; width: 14px; height: 14px; border-radius: 999px; background: var(--accent); box-shadow: 0 0 24px var(--accent-soft); }",
      ".rail-marker { display: grid; gap: 10px; align-content: start; color: var(--muted); font-family: var(--ui-font); letter-spacing: 0.06em; text-transform: uppercase; }",
      ".rail-marker strong { color: var(--ink); font-size: 0.92rem; line-height: 1.4; }",
      ".rail-copy h2 { margin: 0 0 10px; font-size: clamp(1.55rem, 2.5vw, 2.5rem); }",
      ".rail-copy p { margin: 0; }",
      "@media (max-width: 860px) { .rail-panel { grid-template-columns: 1fr; } .story-rail-line { left: 8px; } .rail-panel::before { left: 2px; top: 26px; } }"
    ];
  }

  if (layoutVariant === "bands") {
    return [
      ".story-bands { display: grid; gap: var(--story-gap); margin-top: 16px; }",
      ".story-band { display: grid; grid-template-columns: minmax(160px, 0.42fr) minmax(0, 1fr); gap: 26px; align-items: stretch; border-radius: 32px; padding: var(--panel-padding); background: var(--surface-strong); backdrop-filter: blur(12px); border: 1px solid var(--line); box-shadow: var(--shadow); }",
      ".story-band-right { grid-template-columns: minmax(0, 1fr) minmax(160px, 0.42fr); }",
      ".story-band-left .story-band-meta { order: 0; }",
      ".story-band-right .story-band-meta { order: 1; text-align: right; }",
      ".story-band-right .story-band-copy { order: 0; }",
      ".story-band-meta { display: grid; gap: 10px; align-content: start; padding: 10px 0; color: var(--muted); font-family: var(--ui-font); letter-spacing: 0.08em; text-transform: uppercase; }",
      ".story-band-meta strong { color: var(--ink); font-size: 0.92rem; line-height: 1.5; }",
      ".story-band-copy h2 { margin: 0 0 12px; font-size: clamp(1.7rem, 3vw, 2.8rem); }",
      ".story-band-copy p { margin: 0; }",
      ".story-band:nth-child(odd) { transform: translateX(clamp(0px, 1vw, 12px)); }",
      ".story-band:nth-child(even) { transform: translateX(clamp(-12px, -1vw, 0px)); }",
      "@media (max-width: 860px) { .story-band, .story-band-right { grid-template-columns: 1fr; } .story-band-right .story-band-meta, .story-band-right .story-band-copy { order: initial; text-align: left; } .story-band:nth-child(odd), .story-band:nth-child(even) { transform: none; } }"
    ];
  }

  return [
    ".story-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--story-gap); margin-top: 10px; }",
    ".story-panel { border-radius: 28px; padding: var(--panel-padding); min-height: var(--panel-min-height); background: var(--surface-strong); backdrop-filter: blur(12px); border: 1px solid var(--line); box-shadow: var(--shadow); }",
    ".story-panel h2 { font-size: clamp(1.4rem, 2.2vw, 2rem); margin-bottom: 10px; }",
    "@media (max-width: 860px) { .story-grid { grid-template-columns: 1fr; } }"
  ];
}
