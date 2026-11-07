#!/usr/bin/env node
// @ts-check
// Builds the public site (mezonas.com) into dist/: each page in src/pages is wrapped in
// src/layout.html, and the design system's CSS, fonts and logos are copied next to it.
//
// DECISION: plain HTML and CSS with this one dependency-free script, rather than a framework or
// a bundler. The site is four pages of text; the script only shares the header and footer,
// inlines icons and marks placeholders. Nothing runs in the browser.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "src");

/** The design system's folder, found through its package exports (a dev dependency). */
const designSystem = dirname(
  createRequire(import.meta.url).resolve("@countersign/design-system/tokens.css"),
);

export const ORIGIN = "https://mezonas.com";

/** Bracketed text a person must still fill in, e.g. "[Legal entity name]". */
const PLACEHOLDER = /\[[A-Za-z][^\]<>\n]*\]/g;

/**
 * @typedef {{ name: string, path: string, file: string, title: string, description: string,
 *   legal: boolean, html: string, placeholders: string[] }} Page
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

/** Builds the site into `outDir` and returns its pages. */
export function build(outDir = join(here, "dist"), now = new Date()) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const ds = join(outDir, "design-system");
  mkdirSync(ds, { recursive: true });
  copyFileSync(join(designSystem, "tokens.css"), join(ds, "tokens.css"));
  copyFileSync(join(designSystem, "components/bundle.css"), join(ds, "components.css"));
  copyDir(join(designSystem, "fonts"), join(ds, "fonts"), /\.(woff2|txt)$/);
  copyDir(join(designSystem, "assets/Logos"), join(ds, "logos"), /\.(svg|png)$/);
  copyFileSync(join(src, "site.css"), join(outDir, "site.css"));

  const layout = readFileSync(join(src, "layout.html"), "utf8");
  const year = String(now.getUTCFullYear());
  /** @type {Page[]} */
  const pages = [];

  for (const file of readdirSync(join(src, "pages")).sort()) {
    if (!file.endsWith(".html")) continue;
    const name = file.replace(/\.html$/, "");
    const { meta, body } = frontMatter(readFileSync(join(src, "pages", file), "utf8"));
    if (!meta.title || !meta.description) throw new Error(`${file}: needs a title and description`);
    const path = name === "index" ? "/" : `/${name}`;
    const legal = meta.legal === "true";
    const marked = markPlaceholders(inlineIcons(body));
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
    if (name === "404")
      html = html.replace(
        '<link rel="canonical"',
        '<meta name="robots" content="noindex">\n    <link rel="canonical"',
      );
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
    });
  }

  const listed = pages.filter((p) => p.name !== "404");
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
  const pages = build();
  console.log(`site: built ${pages.length} pages into dist/`);
}
