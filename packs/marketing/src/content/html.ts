/**
 * The sanitiser a guide's rendered HTML passes before it is checked, previewed or published
 * (docs/marketing-plan.md §4.5, §11.4). Copied from Plenary Labs' legal-page sanitiser and renamed;
 * nothing is shared.
 *
 * **It parses and rebuilds rather than stripping.** Every tag and attribute in the output was
 * written by this file from a token it recognised, and every run of text was re-escaped on the way
 * out. Nothing from the input reaches the page verbatim: the worst an unrecognised construct can do
 * is come out as text. It also closes what the input left open, because the fragment is placed
 * inside the site's own layout.
 *
 * The allow-list is what a guide needs and nothing else: headings, paragraphs, lists, tables,
 * emphasis, code, quotations and links that go somewhere we are willing to send a reader. No
 * `style`, no `class`, no images, no iframes, no event handlers, no forms, and an `id` only on a
 * heading.
 *
 * Pure and dependency-free.
 */

/** Tags that survive, with the attributes each may keep. */
const ALLOWED: Record<string, readonly string[]> = {
  // Never `h1`: the page's own heading is the guide's title.
  h2: ["id"],
  h3: ["id"],
  h4: ["id"],
  p: [],
  ul: [],
  ol: [],
  li: [],
  strong: [],
  em: [],
  b: [],
  i: [],
  u: [],
  s: [],
  sup: [],
  sub: [],
  code: [],
  pre: [],
  blockquote: [],
  a: ["href", "title"],
  br: [],
  hr: [],
  table: [],
  thead: [],
  tbody: [],
  tfoot: [],
  tr: [],
  th: ["colspan", "rowspan", "scope"],
  td: ["colspan", "rowspan"],
  caption: [],
  // Groupings that carry no meaning of their own, kept because pasted documents are full of them.
  div: [],
  span: [],
  section: [],
  dl: [],
  dt: [],
  dd: [],
  address: [],
  small: [],
  time: [],
};

/** Tags that cannot contain anything, so they are never pushed onto the stack. */
const VOID = new Set(["br", "hr"]);

/**
 * Tags whose *content* goes too, rather than being kept as text. Everything else that is not
 * allowed loses its tag and keeps its words — a `<font>` around a clause must not delete the
 * clause — but the text inside a script or a style block is code, and code read as prose is
 * nonsense on a guide.
 */
const DROP_CONTENT = new Set(["script", "style", "template", "noscript", "head", "title", "svg"]);

/**
 * Tags that close themselves when the same tag opens again. Pasted HTML omits these closers
 * constantly, and without this rule a list of twelve items nests twelve deep.
 */
const CLOSED_BY_SIBLING: Record<string, readonly string[]> = {
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  p: ["p"],
  tr: ["tr"],
  td: ["td", "th"],
  th: ["td", "th"],
  thead: ["tbody", "tfoot"],
  tbody: ["tbody", "tfoot"],
};

/** What a link may point at. */
const SAFE_SCHEME = /^(https:|mailto:)/i;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text, as text. Applied to every run of characters and every attribute value in the output. */
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * `&amp;` and `&#39;` in the input mean an ampersand and an apostrophe, and are re-escaped by
 * `escapeHtml` on the way out. Only the handful that matter, plus numeric references: an entity
 * table is not the job here, and anything unrecognised is left as the literal text it looks like.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // Not a character anybody meant to write: a control code, or out of range.
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Whether a character is one nobody types into a link: a control code, a space, or one of the
 * invisible C1 codes. Tested by code point rather than with a character class, because a regular
 * expression with control characters in it is exactly the construct a linter is right to refuse —
 * and this is clearer besides.
 */
const invisible = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x20 || (code >= 0x7f && code <= 0x9f);
};

/** A link's value with everything invisible taken out of it. */
const visibleOnly = (value: string): string =>
  [...value].filter((character) => !invisible(character)).join("");

/**
 * Whether a link is one we will send a reader to, and the spelling to write.
 *
 * `https:`, `mailto:`, a path on this site, and a fragment. **Not `http:`** — a guide
 * linking to a plaintext page is a guide whose links can be rewritten in transit — and not
 * `javascript:`, not `data:`, not anything else. Whitespace and control characters are removed
 * before the test, because a tab inside a scheme is the classic way past one, and the test itself is
 * an allow-list rather than a list of the schemes we have thought of.
 */
export function safeHref(value: string): string | null {
  const trimmed = visibleOnly(decodeEntities(value));
  if (trimmed === "") return null;
  if (trimmed.startsWith("#")) return trimmed;
  // `//host` is a protocol-relative URL: a link off this site wearing a path's clothes.
  if (trimmed.startsWith("/")) return trimmed.startsWith("//") ? null : trimmed;
  return SAFE_SCHEME.test(trimmed) ? trimmed : null;
}

type Token =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "open";
      readonly name: string;
      readonly attributes: ReadonlyMap<string, string>;
      readonly selfClosing: boolean;
    }
  | { readonly kind: "close"; readonly name: string };

const NAME = "[a-z][a-z0-9:_-]*";
// The name follows the bracket immediately, with no space, because that is what a browser requires:
// `a < b > c` in a sentence is three words and not a `<b>`, and reading it as a tag would let a
// document open an element the sanitiser then has to close somewhere.
const CLOSE_TAG = new RegExp(`^</(${NAME})[^>]*>`, "i");
const OPEN_TAG = new RegExp(`^<(${NAME})((?:"[^"]*"|'[^']*'|[^>"'])*?)(/?)>`, "i");
const SWALLOW = /^<!(--[\s\S]*?--\s*>|\[CDATA\[[\s\S]*?\]\]>|[^>]*>)/;
const INSTRUCTION = /^<\?[\s\S]*?(\?>|>)/;
const ATTRIBUTE = /([a-z_:][a-z0-9_:.-]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gi;

/** The attributes of one start tag, lower-cased, the last spelling of a repeat winning. */
function parseAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of text.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? "").toLowerCase();
    const raw = match[2] ?? "";
    const quoted = raw.startsWith('"') || raw.startsWith("'");
    attributes.set(name, decodeEntities(quoted ? raw.slice(1, -1) : raw));
  }
  return attributes;
}

/**
 * The input as tokens. Anything that is not a tag, a comment or a processing instruction is text —
 * including a stray `<`, which is how a browser reads it and therefore the only safe reading.
 */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let text = "";
  const flush = () => {
    if (text !== "") tokens.push({ kind: "text", text });
    text = "";
  };

  while (index < html.length) {
    const next = html.indexOf("<", index);
    if (next === -1) {
      text += html.slice(index);
      break;
    }
    text += html.slice(index, next);
    const rest = html.slice(next);

    // A comment, a CDATA section or a doctype: gone, content and all. A conditional comment is the
    // one place where what a browser ignores and what a parser ignores differ, so none of it stays.
    const swallowed = SWALLOW.exec(rest) ?? INSTRUCTION.exec(rest);
    if (swallowed) {
      index = next + swallowed[0].length;
      continue;
    }

    const closed = CLOSE_TAG.exec(rest);
    if (closed) {
      flush();
      tokens.push({ kind: "close", name: (closed[1] ?? "").toLowerCase() });
      index = next + closed[0].length;
      continue;
    }

    const opened = OPEN_TAG.exec(rest);
    if (opened) {
      flush();
      tokens.push({
        kind: "open",
        name: (opened[1] ?? "").toLowerCase(),
        attributes: parseAttributes(opened[2] ?? ""),
        selfClosing: opened[3] === "/",
      });
      index = next + opened[0].length;
      continue;
    }

    // A `<` that begins nothing: text, as a browser would read it.
    text += "<";
    index = next + 1;
  }
  flush();
  return tokens;
}

/** A heading's anchor, prefixed so a pasted id cannot collide with the page's own furniture. */
function anchorOf(value: string, prefix: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") return null;
  // Already prefixed — this is our own output going through again, which happens every time a
  // published version is loaded back into the editor. The prefix must not accumulate.
  return slug.startsWith(prefix) ? slug : `${prefix}${slug}`;
}

/** The attributes of one allowed tag, rebuilt. */
function attributesFor(
  name: string,
  attributes: ReadonlyMap<string, string>,
  removed: Set<string>,
  anchorPrefix: string,
): string {
  const allowed = ALLOWED[name] ?? [];
  const parts: string[] = [];
  for (const [attribute, value] of attributes) {
    if (!allowed.includes(attribute)) {
      // An event handler is worth naming on its own: an operator who pasted something with an
      // `onclick` in it should be told that, not told that a style attribute went.
      removed.add(attribute.startsWith("on") ? `${attribute} handler` : `${name} ${attribute}`);
      continue;
    }
    if (attribute === "href") {
      const href = safeHref(value);
      if (href === null) {
        removed.add("unsafe link");
        continue;
      }
      parts.push(`href="${escapeHtml(href)}"`);
      continue;
    }
    if (attribute === "colspan" || attribute === "rowspan") {
      // A span is a small positive number, or it is nothing. Tested as digits rather than handed
      // to `parseInt`, which reads "1e9" as 1 and would quietly write a span nobody asked for.
      const span = /^\d{1,3}$/.test(value.trim()) ? Number(value.trim()) : 0;
      if (span < 1 || span > 100) {
        removed.add(`${name} ${attribute}`);
        continue;
      }
      parts.push(`${attribute}="${span}"`);
      continue;
    }
    if (attribute === "id") {
      const anchor = anchorOf(value, anchorPrefix);
      if (anchor === null) {
        removed.add(`${name} id`);
        continue;
      }
      parts.push(`id="${anchor}"`);
      continue;
    }
    if (attribute === "scope") {
      const scope = value.trim().toLowerCase();
      if (scope !== "row" && scope !== "col") {
        removed.add("th scope");
        continue;
      }
      parts.push(`scope="${scope}"`);
      continue;
    }
    parts.push(`${attribute}="${escapeHtml(value)}"`);
  }
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

export interface Sanitized {
  /** The document, rebuilt. Every byte of it was written by this file. */
  readonly html: string;
  /**
   * What was taken out, as words an operator reads: `script`, `p style`, `unsafe link`. Sorted and
   * de-duplicated — the console says what kinds of thing went, not how many times each one did.
   */
  readonly removed: readonly string[];
}

/** Sanitise HTML. Never throws and never refuses: it returns what survived and says what did not. */
export function sanitizeHtml(
  input: string,
  /** What a heading's `id` starts with; a guide's renderer makes its own ids, so it passes "". */
  { anchorPrefix = "" }: { anchorPrefix?: string } = {},
): Sanitized {
  const removed = new Set<string>();
  const out: string[] = [];
  /** Open allowed tags, innermost last, so the output can be closed in order. */
  const stack: string[] = [];
  /** The dropped-content tags we are inside. While this has anything in it, nothing is written. */
  const muted: string[] = [];

  const closeTo = (name: string) => {
    const at = stack.lastIndexOf(name);
    if (at === -1) return;
    while (stack.length > at) out.push(`</${stack.pop() ?? ""}>`);
  };

  for (const token of tokenize(input)) {
    if (token.kind === "text") {
      if (muted.length > 0) continue;
      const text = decodeEntities(token.text);
      // Leading whitespace before anything has been written is not content.
      if (text.trim() === "" && out.length === 0) continue;
      out.push(escapeHtml(text));
      continue;
    }

    if (token.kind === "close") {
      if (muted.length > 0) {
        if (muted[muted.length - 1] === token.name) muted.pop();
        continue;
      }
      closeTo(token.name);
      continue;
    }

    const { name } = token;
    if (muted.length > 0) {
      // A nested copy of the same dropped tag, so its closer does not bring us out early.
      if (muted[muted.length - 1] === name && !token.selfClosing) muted.push(name);
      continue;
    }
    if (DROP_CONTENT.has(name)) {
      removed.add(name);
      if (!token.selfClosing) muted.push(name);
      continue;
    }
    if (!(name in ALLOWED)) {
      // The tag goes and the words stay: a `<font>` around a clause must not delete the clause.
      removed.add(name);
      continue;
    }

    const attributes = attributesFor(name, token.attributes, removed, anchorPrefix);

    // A link whose destination was refused — or that never had one — loses its tag and keeps its
    // words, like any other tag that is not allowed. The alternative is an `<a>` with no `href`,
    // which a stylesheet still underlines: a thing that looks like a link, is not one, and tells
    // the reader nothing about where the document meant to send them.
    if (name === "a" && !attributes.includes("href=")) {
      removed.add("link without a destination");
      continue;
    }

    // Close whatever this tag implicitly ends: a second `<li>` ends the first one.
    for (const sibling of CLOSED_BY_SIBLING[name] ?? []) closeTo(sibling);

    out.push(`<${name}${attributes}>`);
    if (!VOID.has(name) && !token.selfClosing) stack.push(name);
  }

  while (stack.length > 0) out.push(`</${stack.pop() ?? ""}>`);

  return { html: out.join("").trim(), removed: [...removed].sort() };
}

/**
 * Whether a sanitised document says anything at all, which is what publishing requires. A page of
 * empty paragraphs is not a guide.
 */
export const hasContent = (html: string): boolean =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .trim() !== "";
