// Untrusted text stays data (CLAUDE.md invariant 9): a value placed between a prompt's tags
// (`<build>…</build>`, `<client_request>…</client_request>`) must not be able to close them and
// speak after them as the operator. Every prompt builder escapes what it puts inside a tag here.

/** An `&` that already starts a character reference (`&lt;`, `&#60;`, `&amp;`). */
const REFERENCE = /&(?=#?[A-Za-z0-9]+;)/g;

/**
 * Text for inside a prompt tag: `<` and `>` as `&lt;` and `&gt;`, so the text can't open or close
 * a tag, and an `&` that would start a reference as `&amp;`, so `&lt;` someone typed stays theirs.
 */
// DECISION: a lone `&` ("PO & invoice") stays as typed, as HTML5 reads an ambiguous ampersand: it
// can't start a tag or a reference, and the model echoes the brief and the decisions back, where
// `&amp;` would pile up turn by turn. The escaping is still reversible.
export function promptText(text: string): string {
  return text.replace(REFERENCE, "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * JSON for inside a prompt tag: `JSON.stringify`, with every `<`, `>` and `&` in it written as
 * `<`, `>` and `&`. Still JSON that parses back to the same value, so a prompt's
 * `<current_bundle>` can be read back (tests do) and the model answers with the same characters.
 */
export function promptJson(value: unknown, space?: number): string {
  return (JSON.stringify(value, null, space) ?? "null")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}
