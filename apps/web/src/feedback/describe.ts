// What was under the pin, in a few words a developer can find on the page: the nearest control or
// landmark, its accessible name and its test id, e.g. `button "Approve" [inbox-approve]`.
// Text only: no values typed into fields (they can be a client's data).

const MAX = 300;
const ROLE_OF: Record<string, string> = {
  a: "link",
  button: "button",
  select: "select",
  textarea: "text box",
  input: "field",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  img: "image",
  label: "label",
  nav: "navigation",
  table: "table",
  tr: "row",
  td: "cell",
  th: "column header",
  li: "list item",
  dialog: "dialog",
};
const INTERACTIVE =
  "a,button,select,textarea,input,[role],[data-testid],h1,h2,h3,h4,label,img,th,td,li";

function clip(text: string, n: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function nameOf(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (text.trim()) return text;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // The field's label or placeholder, never its value.
    const label = el.labels?.[0]?.textContent;
    return label || el.placeholder || el.name || "";
  }
  if (el instanceof HTMLSelectElement) return el.labels?.[0]?.textContent || el.name || "";
  if (el instanceof HTMLImageElement) return el.alt;
  return el.getAttribute("title") || el.textContent || "";
}

/** A short description of the element at a point, or null when there is nothing to name. */
export function describeElement(target: Element | null): string | null {
  if (!target) return null;
  const el = target.closest(INTERACTIVE) ?? target;
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role") ?? ROLE_OF[tag] ?? tag;
  const name = clip(nameOf(el), 80);
  const testId = el.closest("[data-testid]")?.getAttribute("data-testid");
  const parts = [role, name ? `"${name.replace(/"/g, "'")}"` : "", testId ? `[${testId}]` : ""];
  const text = parts.filter(Boolean).join(" ");
  return text ? clip(text, MAX) : null;
}
