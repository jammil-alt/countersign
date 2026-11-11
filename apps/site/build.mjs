#!/usr/bin/env node
// @ts-check
// Builds the public site (mezonas.com) into dist/: each page in src/pages is wrapped in
// src/layout.html, and the design system's CSS, fonts and logos are copied next to it.
//
// DECISION: plain HTML and CSS with this one dependency-free script, rather than a framework or
// a bundler. The script shares the header, call to action and footer, renders the marketing
// pages' diagrams and demos from src/content (`{{component name}}`, src/components.mjs), inlines
// icons and marks placeholders. In the browser, src/site.js only switches the demos between the
// states already in the page: it fetches nothing, stores nothing and sends nothing. Measuring is
// separate and off unless the build is given its address (below).
//
// Measuring (docs/marketing-plan.md §4.3; docs/plan.md §1.72, the "Site:" rows) is off unless
// the build is given the collector's address (MEZONAS_MEASURE_URL). Off, the output is byte for
// byte what it was before measuring existed: the `data-track` names in the sources are taken out
// and nothing is added. On, every page but /no-measure carries src/measure.js inline,
// /no-measure is built, and the footer links to it.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderComponents } from "./src/components.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "src");

/** The design system's folder, found through its package exports (a dev dependency). */
const designSystem = dirname(
  createRequire(import.meta.url).resolve("@countersign/design-system/tokens.css"),
);

export const ORIGIN = "https://mezonas.com";

/** `data-track` names: lower case, digits and hyphens (the Marketing pack's `TRACK_NAME`). */
export const TRACK_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TRACK_ATTR = / data-track="([^"]*)"/g;

/**
 * The privacy policy must describe measuring before the site measures (docs/marketing-plan.md
 * §10): while it still says this, or does not link /no-measure, a measuring build is refused.
 */
export const NO_ANALYTICS = "This website uses no analytics";

/**
 * The collector's address from the build's environment: empty or unset is off. Anything else
 * must be an https address with no query, fragment or login (http only for a local collector),
 * or the build fails rather than quietly measuring nothing.
 */
export function measureUrlOf(/** @type {string | null | undefined} */ value) {
  const text = (value ?? "").trim();
  if (text === "") return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("MEZONAS_MEASURE_URL is not an address");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("MEZONAS_MEASURE_URL must be an https address");
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error("MEZONAS_MEASURE_URL must have no query, fragment or login");
  }
  return url.toString();
}

/** src/measure.js as an inline script, without its header comment, sending to `url`. */
export function measureScript(/** @type {string} */ url) {
  const code = readFileSync(join(src, "measure.js"), "utf8")
    .replace(/^\/\*[\s\S]*?\*\/\n/, "")
    .trim();
  if (!code.includes("__MEASURE_URL__")) throw new Error("measure.js has no __MEASURE_URL__");
  // `<` escaped so nothing in the address can close the script element.
  const literal = JSON.stringify(url).replace(/</g, "\\u003c");
  return `<script>\n${code.replace("__MEASURE_URL__", () => literal)}\n</script>`;
}

/** Bracketed text a person must still fill in, e.g. "[Legal entity name]". */
const PLACEHOLDER = /\[[A-Za-z][^\]<>\n]*\]/g;

/**
 * @typedef {{ name: string, path: string, file: string, title: string, description: string,
 *   legal: boolean, html: string, placeholders: string[], tracks: string[] }} Page
 * @typedef {{ measureUrl?: string | null | undefined, requirePolicy?: boolean }} BuildOptions
 */

/** Reads `key: value` lines from the page's leading HTML comment. */
function frontMatter(/** @type {string} */ text) {
  const m = /^<!--\n([\s\S]*?)\n-->\n/.exec(text);
  if (!m?.[1]) throw new Error("a page must start with its front matter in an HTML comment");
  /** @type {Record<string, string>} */
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Wraps placeholders found in text (never inside a tag) so they are easy to see and find. */
function markPlaceholders(/** @type {string} */ html) {
  /** @type {string[]} */
  const found = [];
  const out = html
    .split(/(<[^>]+>)/)
    .map((part) =>
      part.startsWith("<")
        ? part
        : part.replace(PLACEHOLDER, (p) => {
            found.push(p);
            return `<span class="placeholder">${p}</span>`;
          }),
    )
    .join("");
  return { html: out, found };
}

/** `{{icon mz-name}}` becomes the icon's SVG, inline so it takes `currentColor`. */
function inlineIcons(/** @type {string} */ html) {
  return html.replace(/\{\{icon (mz-[a-z-]+)\}\}/g, (_, name) =>
    readFileSync(join(designSystem, "assets/Icons", `${name}.svg`), "utf8")
      .trim()
      .replace("<svg ", '<svg class="icon" focusable="false" '),
  );
}

function copyDir(/** @type {string} */ from, /** @type {string} */ to, /** @type {RegExp} */ keep) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (keep.test(name)) copyFileSync(join(from, name), join(to, name));
  }
}

/**
 * Builds the site into `outDir` and returns its pages. `measureUrl` turns measuring on (checked
 * by `measureUrlOf`); `requirePolicy: false` lets a test build it before the policy says so.
 * @param {BuildOptions} [options]
 */
export function build(outDir = join(here, "dist"), now = new Date(), options = {}) {
  const measureUrl = measureUrlOf(options.measureUrl);
  if (measureUrl && options.requirePolicy !== false) {
    const policy = readFileSync(join(src, "pages", "privacy.html"), "utf8");
    if (policy.includes(NO_ANALYTICS) || !policy.includes('href="/no-measure"')) {
      throw new Error(
        "measuring needs the privacy policy's measurement section first " +
          "(docs/marketing/privacy-measurement-draft.md)",
      );
    }
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const ds = join(outDir, "design-system");
  mkdirSync(ds, { recursive: true });
  copyFileSync(join(designSystem, "tokens.css"), join(ds, "tokens.css"));
  copyFileSync(join(designSystem, "components/bundle.css"), join(ds, "components.css"));
  copyDir(join(designSystem, "fonts"), join(ds, "fonts"), /\.(woff2|txt)$/);
  copyDir(join(designSystem, "assets/Logos"), join(ds, "logos"), /\.(svg|png)$/);
  copyFileSync(join(src, "site.css"), join(outDir, "site.css"));
  copyFileSync(join(src, "site.js"), join(outDir, "site.js"));
  copyDir(join(src, "logos"), join(outDir, "logos"), /\.(svg|png)$/);

  let layout = readFileSync(join(src, "layout.html"), "utf8");
  if (measureUrl) {
    // The footer links to /no-measure, after the text message terms.
    const sms = '<a href="/sms-terms" data-track="footer-sms-terms">Text message terms</a>\n';
    if (!layout.includes(sms)) throw new Error("layout.html: no footer link to /sms-terms");
    layout = layout.replace(
      sms,
      `${sms}          <a href="/no-measure" data-track="footer-no-measure">How we measure</a>\n`,
    );
  }
  const year = String(now.getUTCFullYear());
  /** @type {Page[]} */
  const pages = [];

  for (const file of readdirSync(join(src, "pages")).sort()) {
    if (!file.endsWith(".html")) continue;
    const name = file.replace(/\.html$/, "");
    const { meta, body } = frontMatter(readFileSync(join(src, "pages", file), "utf8"));
    if (!meta.title || !meta.description) throw new Error(`${file}: needs a title and description`);
    // `only: measure`: a page built only while measuring is on (/no-measure).
    const onlyMeasuring = meta.only === "measure";
    if (onlyMeasuring && !measureUrl) continue;
    const path = name === "index" ? "/" : `/${name}`;
    const legal = meta.legal === "true";
    const marked = markPlaceholders(inlineIcons(renderComponents(body, file)));
    const draft =
      legal && marked.found.length > 0
        ? '<div class="wrap"><p class="draft-note" role="note"><strong>Draft for legal review.' +
          "</strong> The highlighted items in brackets are still to be filled in, and the text " +
          "is not final until a lawyer has reviewed it.</p></div>"
        : "";
    const title = name === "index" ? meta.title : `${meta.title} · Mezonas`;
    let html = layout
      .replaceAll("{{title}}", title)
      .replaceAll("{{description}}", meta.description)
      .replaceAll("{{canonical}}", `${ORIGIN}${path === "/" ? "/" : path}`)
      .replaceAll("{{year}}", year)
      .replace("{{draft}}", draft)
      .replace("{{body}}", marked.html.trim());
    // The current page's links in the header and footer say so.
    html = html.replaceAll(`href="${path}"`, `href="${path}" aria-current="page"`);
    if (name === "404" || onlyMeasuring)
      html = html.replace(
        '<link rel="canonical"',
        '<meta name="robots" content="noindex">\n    <link rel="canonical"',
      );
    /** @type {string[]} */
    const tracks = [];
    if (measureUrl) {
      for (const [, track = ""] of html.matchAll(TRACK_ATTR)) {
        if (!TRACK_NAME.test(track))
          throw new Error(`${file}: data-track "${track}" is not a name`);
        if (tracks.includes(track)) throw new Error(`${file}: data-track "${track}" is used twice`);
        tracks.push(track);
      }
      // The opt-out page explains measuring; it is not measured itself.
      if (!onlyMeasuring) {
        html = html.replace("\n  </body>", `\n    ${measureScript(measureUrl)}\n  </body>`);
      }
    } else {
      html = html.replace(TRACK_ATTR, "");
    }
    writeFileSync(join(outDir, file), html);
    pages.push({
      name,
      path,
      file,
      title,
      description: meta.description,
      legal,
      html,
      placeholders: [...new Set(marked.found)],
      tracks,
    });
  }

  const listed = pages.filter((p) => p.name !== "404" && p.name !== "no-measure");
  writeFileSync(
    join(outDir, "sitemap.xml"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      listed.map((p) => `  <url><loc>${ORIGIN}${p.path}</loc></url>\n`).join("") +
      "</urlset>\n",
  );
  writeFileSync(
    join(outDir, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`,
  );
  return pages;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pages = build(undefined, undefined, { measureUrl: process.env.MEZONAS_MEASURE_URL });
  const measuring = pages.some((p) => p.name === "no-measure");
  console.log(`site: built ${pages.length} pages into dist/${measuring ? ", measuring" : ""}`);
}
