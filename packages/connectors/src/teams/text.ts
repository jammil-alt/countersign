// What an agent posts to Teams is plain text. The message is sent with `textFormat: "plain"`, and
// because Teams may still read Markdown and a little HTML (NOTES.md), the text is also made safe
// to read either way: a `<` that could open a tag (`<at>`, `<a href>`, `<img>`) becomes `‹`, so no
// tag, mention or image survives; a Markdown link or image `[label](url)` is written out as
// `label (url)`, so no label hides where it goes and no image loads; reference-style links are
// broken (`][` and `]:` get a space); bidirectional overrides and control characters other than
// line breaks and tabs go. Mentions in Teams need an entity we never send, so text alone can't
// mention anyone. The pass repeats until nothing changes, so pieces can't join into new markup.

/** Teams takes far more (about 28 KB); ours matches the other chat connectors. */
export const TEAMS_TEXT_MAX = 4000;
/** How far after `[label]` we look for its `(url)` end. */
const MAX_TARGET = 1000;

/** Bidi controls that can make a URL read as something else. */
function isBidiControl(code: number): boolean {
  return (
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x200e ||
    code === 0x200f
  );
}

/** Whether `<` followed by this could start a tag, a comment or an autolink. */
function opensTag(next: string | undefined): boolean {
  if (!next) return false;
  return (
    (next >= "a" && next <= "z") ||
    (next >= "A" && next <= "Z") ||
    next === "/" ||
    next === "!" ||
    next === "?"
  );
}

/** At `s[i] === "["` (or `![`): the `[label](target)` there, or null. */
function linkAt(s: string, open: number): { label: string; target: string; end: number } | null {
  const close = s.indexOf("]", open + 1);
  if (close < 0 || close - open > MAX_TARGET || s[close + 1] !== "(") return null;
  const label = s.slice(open + 1, close);
  if (label.includes("[")) return null;
  let depth = 0;
  for (let k = close + 2; k < Math.min(s.length, close + 2 + MAX_TARGET); k++) {
    const c = s[k];
    if (c === "\n") return null;
    if (c === "(") depth += 1;
    if (c === ")") {
      if (depth === 0) return { label, target: s.slice(close + 2, k).trim(), end: k + 1 };
      depth -= 1;
    }
  }
  return null;
}

function onePass(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i] as string;
    const code = s.charCodeAt(i);
    if ((code < 0x20 && ch !== "\n" && ch !== "\t") || code === 0x7f || isBidiControl(code)) {
      i += 1;
      continue;
    }
    if (ch === "<" && opensTag(s[i + 1])) {
      out += "‹";
      i += 1;
      continue;
    }
    if (ch === "[" || (ch === "!" && s[i + 1] === "[")) {
      const open = ch === "!" ? i + 1 : i;
      const link = linkAt(s, open);
      if (link) {
        const label = link.label.trim();
        out += label && label !== link.target ? `${label} (${link.target})` : link.target;
        i = link.end;
        continue;
      }
    }
    if (ch === "]" && (s[i + 1] === "[" || s[i + 1] === ":")) {
      out += "] ";
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Model text as Teams should post it: no tags, mentions, hidden links or images; plain words. */
export function plainTeamsText(text: string): string {
  let s = text.slice(0, TEAMS_TEXT_MAX * 2).replace(/\r\n?/g, "\n");
  for (let pass = 0; pass < 8; pass++) {
    const next = onePass(s);
    if (next === s) return s.trim().slice(0, TEAMS_TEXT_MAX);
    s = next;
  }
  // Still changing after 8 passes: a crafted text. No bracket or angle bracket survives it.
  let flat = "";
  for (const ch of s) {
    flat += ch === "<" ? "‹" : ch === ">" ? "›" : ch === "[" ? "(" : ch === "]" ? ")" : ch;
  }
  return flat.trim().slice(0, TEAMS_TEXT_MAX);
}
