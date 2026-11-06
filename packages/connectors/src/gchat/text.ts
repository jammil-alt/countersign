// What an agent posts to Google Chat is plain text. Chat reads a few things inside angle brackets
// as markup: `<users/123>` and `<users/all>` mention people (everyone, for `all`), and `<url|label>`
// is a link whose label can hide where it goes. Model text never mentions anyone: every
// `<…/…>` without a scheme is dropped, a labelled link is written out as `label (url)`, and control
// characters other than line breaks and tabs go. The pass repeats until nothing changes, so
// pieces left around a dropped mention can't join into a new one. Scanned by index, no regexes.

import { parseUrl } from "../http";

/** Chat's limit is 4,096 characters per message; ours leaves room. */
export const GCHAT_TEXT_MAX = 4000;
/** How far after `<` we look for its `>`. */
const MAX_MARKUP = 512;
const SCHEMES = new Set(["https:", "http:", "mailto:"]);

/** Whether Chat would read this as a link target: a URL with one of the schemes, no spaces. */
function isLink(s: string): boolean {
  const t = s.trim();
  if (t.length === 0 || t.indexOf(" ") >= 0) return false;
  const u = parseUrl(t);
  return u !== null && SCHEMES.has(u.protocol);
}

/** What `<inner>` becomes: null keeps it as it was written (not markup). */
function markup(inner: string): string | null {
  const bar = inner.indexOf("|");
  const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
  if (isLink(target)) {
    const label = bar < 0 ? "" : inner.slice(bar + 1).trim();
    return label && label !== target ? `${label} (${target})` : target;
  }
  // `users/123`, `users/all`, `users/app`, any resource name: a mention. Dropped.
  if (!target.includes(":") && target.includes("/")) return "";
  // Any other `<target|label>` is written out too, so no label hides where it points.
  if (bar >= 0) {
    const label = inner.slice(bar + 1).trim();
    return label ? `${label} (${target})` : target;
  }
  return null;
}

function onePass(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i] as string;
    if (ch === "<") {
      let close = -1;
      const limit = Math.min(s.length, i + 1 + MAX_MARKUP);
      for (let k = i + 1; k < limit; k++) {
        const c = s[k];
        if (c === "<") break;
        if (c === ">") {
          close = k;
          break;
        }
      }
      if (close > 0) {
        const replaced = markup(s.slice(i + 1, close));
        if (replaced !== null) {
          out += replaced;
          i = close + 1;
          continue;
        }
      }
    }
    const code = s.charCodeAt(i);
    if ((code < 0x20 && ch !== "\n" && ch !== "\t") || code === 0x7f) {
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Model text as Chat should post it: no mentions, links written out, no control characters. */
export function plainChatText(text: string): string {
  let s = text.slice(0, GCHAT_TEXT_MAX * 2);
  for (let pass = 0; pass < 8; pass++) {
    const next = onePass(s);
    if (next === s) return s.trim();
    s = next;
  }
  // Still changing after 8 passes: a crafted text. No angle bracket survives it.
  let flat = "";
  for (const ch of s) flat += ch === "<" ? "‹" : ch === ">" ? "›" : ch;
  return flat.trim();
}
