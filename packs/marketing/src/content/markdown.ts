/**
 * A guide's Markdown, as the HTML fragment the site serves (docs/marketing-plan.md §4.5, §11.4).
 * Copied from Plenary Labs' article renderer and renamed; nothing is shared.
 *
 * A small subset, written here rather than pulled in, because a guide needs little and every
 * construct it allows is one more way for a page to look wrong:
 *
 * - `## Heading`, `### Heading` and `#### Heading`, each given an `id` so a section can be linked
 *   to. `# Heading` is the page's own `<h1>`, which is the guide's title; the checks refuse it in
 *   the body (./checks.ts) rather than this file quietly demoting it.
 * - Paragraphs, separated by a blank line. A single line break is a space, as in every Markdown.
 * - Lists: lines starting `- ` or `* ` (bulleted) or `1. ` (numbered). One level.
 * - `> ` quotations, `---` rules and fenced code blocks.
 * - Inline: `**strong**`, `*emphasis*` or `_emphasis_`, `` `code` `` and `[words](address)`.
 *   A backslash before a punctuation mark writes the mark itself.
 *
 * There is no raw HTML: a `<` in the body is a less-than sign. The output then passes the
 * allow-list sanitiser (./html.ts), so a link to anywhere but `https:`, `mailto:` or a path on the
 * site loses its tag and keeps its words. Two walls, because this HTML is served to the whole
 * internet from the client's own domain.
 *
 * Pure and dependency-free.
 */

import { escapeHtml, sanitizeHtml } from "./html";

export interface Rendered {
  /** The guide's body, sanitised: the bytes the site will serve. */
  readonly html: string;
  /** What the sanitiser took out, in words an operator reads (e.g. "unsafe link"). */
  readonly removed: readonly string[];
  /** The `##`–`####` headings, in order, for the editor's outline and the checks. */
  readonly headings: readonly { level: number; text: string; id: string }[];
  /** Every link's address as written, for the checks. */
  readonly links: readonly string[];
  /** Lines that open with a single `#`: a second `<h1>`, which publishing refuses. */
  readonly topHeadings: number;
}

/** Ids the guide page uses for itself, which a heading must not take. */
const RESERVED = new Set(["main", "top", "waitlist", "content", "guide"]);

/** The `id` for a heading: its words, lowercased and hyphenated. Repeats get `-2`, `-3`. */
export function headingId(text: string, taken: Map<string, number>): string {
  const words =
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "section";
  const base = RESERVED.has(words) ? `${words}-section` : words;
  const seen = taken.get(base) ?? 0;
  taken.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen + 1}`;
}

const ESCAPABLE = "\\`*_{}[]()#+-.!>~|";

/** One run of inline Markdown as HTML. Text is escaped; links are collected for the checks. */
function inline(source: string, links: string[]): string {
  let out = "";
  let i = 0;
  const text = (s: string) => {
    out += escapeHtml(s);
  };
  while (i < source.length) {
    const ch = source[i] ?? "";
    if (ch === "\\" && i + 1 < source.length && ESCAPABLE.includes(source[i + 1] ?? "")) {
      text(source[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = source.indexOf("`", i + 1);
      if (end > i + 1) {
        out += `<code>${escapeHtml(source.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const close = findClosing(source, i, "[", "]");
      if (close > i && source[close + 1] === "(") {
        const end = findClosing(source, close + 1, "(", ")");
        if (end > close) {
          const label = source.slice(i + 1, close);
          const href = source.slice(close + 2, end).trim();
          links.push(href);
          out += `<a href="${escapeHtml(href)}">${inline(label, links)}</a>`;
          i = end + 1;
          continue;
        }
      }
    }
    if (ch === "*" && source[i + 1] === "*") {
      const end = source.indexOf("**", i + 2);
      if (end > i + 2) {
        out += `<strong>${inline(source.slice(i + 2, end), links)}</strong>`;
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      // `_` only at a word boundary, so snake_case_words stay as written.
      const opens = ch === "*" || i === 0 || /[\s(]/.test(source[i - 1] ?? "");
      const end = source.indexOf(ch, i + 1);
      const closes =
        end > i + 1 &&
        source[i + 1] !== " " &&
        (ch === "*" || end + 1 >= source.length || /[\s.,;:!?)]/.test(source[end + 1] ?? ""));
      if (opens && closes) {
        out += `<em>${inline(source.slice(i + 1, end), links)}</em>`;
        i = end + 1;
        continue;
      }
    }
    text(ch);
    i += 1;
  }
  return out;
}

/** The index of the bracket that closes the one at `from`, allowing nesting; -1 if none. */
function findClosing(source: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d{1,3}[.)]\s+(.*)$/;
const RULE = /^(?:-\s*){3,}$|^(?:\*\s*){3,}$/;
const FENCE = /^```/;

/** Render a guide's body. Never throws: the worst input comes out as escaped text. */
export function renderMarkdown(source: string): Rendered {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const links: string[] = [];
  const headings: { level: number; text: string; id: string }[] = [];
  const taken = new Map<string, number>();
  let topHeadings = 0;
  let i = 0;

  const isBlockStart = (line: string) =>
    HEADING.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    RULE.test(line) ||
    FENCE.test(line) ||
    line.startsWith(">");

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "") {
      i += 1;
      continue;
    }

    if (FENCE.test(trimmed)) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test((lines[i] ?? "").trim())) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // the closing fence, or the end
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(trimmed);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const words = heading[2] ?? "";
      i += 1;
      if (level === 1) {
        // Counted for the checks and written as a second-level heading meanwhile, so the preview
        // still shows the words where the writer put them.
        topHeadings += 1;
      }
      const tag = Math.min(Math.max(level, 2), 4);
      const plain = words.replace(/[*_`[\]]/g, "").replace(/\(([^)]*)\)/g, "");
      const id = headingId(plain, taken);
      headings.push({ level: tag, text: plain, id });
      out.push(`<h${tag} id="${id}">${inline(words, links)}</h${tag}>`);
      continue;
    }

    if (RULE.test(trimmed)) {
      out.push("<hr>");
      i += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith(">")) {
        quoted.push((lines[i] ?? "").trim().replace(/^>\s?/, ""));
        i += 1;
      }
      const inner = renderMarkdown(quoted.join("\n"));
      links.push(...inner.links);
      out.push(`<blockquote>${inner.html}</blockquote>`);
      continue;
    }

    const bullet = BULLET.test(trimmed);
    if (bullet || NUMBERED.test(trimmed)) {
      const pattern = bullet ? BULLET : NUMBERED;
      const items: string[] = [];
      while (i < lines.length) {
        const current = (lines[i] ?? "").trim();
        const item = pattern.exec(current);
        if (item) {
          items.push(item[1] ?? "");
        } else if (current !== "" && !isBlockStart(current) && items.length > 0) {
          // A wrapped line carries on the item above it.
          items[items.length - 1] += ` ${current}`;
        } else {
          break;
        }
        i += 1;
      }
      const tag = bullet ? "ul" : "ol";
      out.push(
        `<${tag}>${items.map((item) => `<li>${inline(item, links)}</li>`).join("")}</${tag}>`,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = (lines[i] ?? "").trim();
      if (current === "" || (paragraph.length > 0 && isBlockStart(current))) break;
      paragraph.push(current);
      i += 1;
    }
    out.push(`<p>${inline(paragraph.join(" "), links)}</p>`);
  }

  const sanitized = sanitizeHtml(out.join("\n"), { anchorPrefix: "" });
  return { html: sanitized.html, removed: sanitized.removed, headings, links, topHeadings };
}

/** The words of rendered HTML, for counting and for the claims lint. */
export const textOf = (html: string): string =>
  html
    // Inline tags join their words to the text around them; block tags separate.
    .replace(/<\/?(?:a|strong|em|b|i|u|s|code|sup|sub|small|span)\b[^>]*>/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
