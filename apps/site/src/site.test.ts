// Builds the site into a temporary folder and checks what Google's verification and the brand
// book need: every page exists, links resolve, the privacy policy carries Google's Limited Use
// sentence, the landing page links to every policy, and the copy keeps to the voice rules.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "../build.mjs";

type Page = ReturnType<typeof build>[number];

const LIMITED_USE =
  "Mezonas' use and transfer of information received from Google APIs to any other app will " +
  "adhere to the Google API Services User Data Policy, including the Limited Use requirements.";
const POLICY_URL = "https://developers.google.com/terms/api-services-user-data-policy";
const ENTITY = "Twelve Thirty-Four Consulting LLC";
/** The sentences carriers look for during A2P 10DLC review, word for word. */
const SMS_PRIVACY = [
  "No mobile information will be shared with third parties or affiliates for marketing or " +
    "promotional purposes.",
  "Text messaging originator opt-in data and consent will not be shared with any third parties.",
];
const SMS_TERMS = [
  "Message frequency varies.",
  "Message and data rates may apply.",
  "Reply STOP to opt out, HELP for help.",
  "Carriers are not liable for delayed or undelivered messages.",
];

let out: string;
let pages: Page[];

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "mezonas-site-"));
  pages = build(out, new Date("2026-11-05T12:00:00Z"));
});

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

function page(name: string): Page {
  const p = pages.find((x) => x.name === name);
  if (!p) throw new Error(`no page ${name}`);
  return p;
}

/** The text a reader sees: no tags, comments, doctype, styles or scripts. */
function visibleText(html: string): string {
  return (
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<!doctype[^>]*>/gi, " ")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      // Inline elements join the words around them; every other tag breaks the text.
      .replace(/<\/?(a|span|strong|em|b|i|code|time)(\s[^>]*)?>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Every value of `attr` in the page, e.g. every href. */
function attrs(html: string, attr: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${attr}="([^"]*)"`, "g"))].map((m) => m[1] ?? "");
}

function ids(html: string): Set<string> {
  return new Set(attrs(html, "id"));
}

/** The built file a site path is served from (Workers assets: /terms → terms.html). */
function fileFor(path: string): string | null {
  const clean = path === "/" ? "/index.html" : path;
  const direct = join(out, clean);
  if (existsSync(direct) && /\.[a-z0-9]+$/i.test(clean)) return direct;
  const html = join(out, `${clean}.html`);
  return existsSync(html) ? html : null;
}

describe("pages", () => {
  it("builds every page", () => {
    expect(pages.map((p) => p.name).sort()).toEqual([
      "404",
      "index",
      "privacy",
      "sms-terms",
      "subprocessors",
      "terms",
    ]);
    for (const p of pages) expect(existsSync(join(out, p.file))).toBe(true);
    for (const f of ["robots.txt", "sitemap.xml", "site.css", "design-system/tokens.css"]) {
      expect(existsSync(join(out, f)), f).toBe(true);
    }
  });

  it.each(["index", "terms", "privacy", "subprocessors", "sms-terms", "404"])(
    "%s has a title, description, favicon, landmarks and one h1",
    (name) => {
      const { html, title, description } = page(name);
      expect(html).toMatch(/^<!doctype html>\n<html lang="en">/);
      expect(html).toContain(`<title>${title}</title>`);
      expect(title).toMatch(/Mezonas/);
      expect(description.length).toBeGreaterThan(50);
      expect(html).toContain(`<meta name="description" content="${description}">`);
      expect(html).toContain('rel="icon" href="/design-system/logos/favicon.svg"');
      for (const tag of ["<header", "<nav", '<main id="main"', "<footer"]) {
        expect(html).toContain(tag);
      }
      expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    },
  );

  it("never skips a heading level", () => {
    for (const { name, html } of pages) {
      const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
      expect(levels[0], name).toBe(1);
      for (let i = 1; i < levels.length; i++) {
        expect((levels[i] ?? 0) - (levels[i - 1] ?? 0), `${name} heading ${i}`).toBeLessThanOrEqual(
          1,
        );
      }
    }
  });

  it("resolves every internal link, anchor and asset", () => {
    for (const { name, html } of pages) {
      const refs = [
        ...attrs(html, "href"),
        ...attrs(html, "src"),
        ...attrs(html, "srcset").map((s) => s.split(/\s+/)[0] ?? ""),
      ];
      for (const ref of refs) {
        if (/^(https?:|mailto:)/.test(ref)) continue;
        const [path = "", hash] = ref.split("#");
        const target = path === "" ? join(out, page(name).file) : fileFor(path);
        expect(target, `${name}: ${ref}`).not.toBeNull();
        if (hash && target) {
          expect(ids(readFileSync(target, "utf8")).has(hash), `${name}: ${ref}`).toBe(true);
        }
      }
    }
  });

  it("keeps every id unique on its page", () => {
    for (const { name, html } of pages) {
      const all = attrs(html, "id");
      expect(new Set(all).size, name).toBe(all.length);
    }
  });
});

describe("privacy policy", () => {
  it("contains Google's Limited Use sentence, word for word, and links the policy", () => {
    const { html } = page("privacy");
    expect(visibleText(html)).toContain(LIMITED_USE);
    expect(attrs(html, "href")).toContain(POLICY_URL);
  });

  it("names the only Gmail scope we ask for", () => {
    const text = visibleText(page("privacy").html);
    expect(text).toContain("gmail.send");
    expect(text).not.toMatch(/gmail\.(readonly|labels|compose|modify)/);
  });
});

describe("company", () => {
  it("names the legal entity on the terms and the privacy policy, and leaves no placeholder for it", () => {
    for (const name of ["terms", "privacy", "sms-terms"]) {
      expect(visibleText(page(name).html), name).toContain(ENTITY);
    }
    for (const p of pages) expect(p.html, p.name).not.toContain("[Legal entity name]");
  });
});

describe("text messages", () => {
  it("has the carriers' privacy sentences, word for word, in the privacy policy", () => {
    const text = visibleText(page("privacy").html);
    for (const sentence of SMS_PRIVACY) expect(text).toContain(sentence);
  });

  it("has the disclosures, STOP and HELP on the text message terms", () => {
    const text = visibleText(page("sms-terms").html);
    for (const sentence of [...SMS_TERMS, SMS_PRIVACY[0] ?? ""]) expect(text).toContain(sentence);
    expect(text).toMatch(/\bSTOP\b/);
    expect(text).toMatch(/\bHELP\b/);
    expect(text).toMatch(/\bSTART\b/);
  });

  it("is linked from the terms and from every page's footer", () => {
    expect(attrs(page("terms").html, "href")).toContain("/sms-terms");
    for (const p of pages) {
      const footer = p.html.slice(p.html.indexOf("<footer"));
      expect(attrs(footer, "href"), p.name).toContain("/sms-terms");
    }
  });
});

describe("landing page", () => {
  it("links to the terms, the privacy policy and the subprocessors", () => {
    const hrefs = attrs(page("index").html, "href");
    for (const p of ["/terms", "/privacy", "/subprocessors", "/sms-terms"]) {
      expect(hrefs).toContain(p);
    }
  });

  it("has a Terms and policies section and the company line in the footer", () => {
    const text = visibleText(page("index").html);
    expect(text).toContain("Terms and policies");
    expect(text).toContain(`Mezonas, a product of ${ENTITY}`);
    expect(text).toContain(`© 2026 ${ENTITY}`);
  });
});

describe("legal pages", () => {
  it.each(["terms", "privacy", "subprocessors", "sms-terms"])(
    "%s shows its date and the draft note",
    (name) => {
      const p = page(name);
      expect(p.legal).toBe(true);
      expect(visibleText(p.html)).toMatch(/Last updated [A-Z][a-z]+ \d{1,2}, \d{4}/);
      expect(p.html).toContain('<time datetime="');
      // The note stays while any placeholder does.
      expect(p.placeholders.length > 0).toBe(p.html.includes("Draft for legal review"));
    },
  );

  it("marks every placeholder and lists each one in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const all = new Set(pages.flatMap((p) => p.placeholders));
    expect(all.size).toBeGreaterThan(0);
    for (const ph of all) expect(readme, ph).toContain(ph);
    for (const p of pages) {
      // Every bracketed item in the text is wrapped so it shows highlighted.
      const unmarked = p.html.replace(/<span class="placeholder">\[[^\]]+\]<\/span>/g, "");
      expect(visibleText(unmarked), p.name).not.toMatch(/\[[A-Za-z][^\]]*\]/);
    }
  });
});

describe("voice", () => {
  it("uses no exclamation marks and no banned words", () => {
    for (const { name, html, title, description } of pages) {
      const text = `${visibleText(html)} ${title} ${description}`;
      expect(text, name).not.toContain("!");
      expect(text, name).not.toMatch(/AI-powered|revolutionary/i);
    }
  });
});
