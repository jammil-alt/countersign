// The still frame (docs/audit-plan.md 1.1): index.html's #root and the React twin that replaces it
// are the same frame, so nothing moves when React mounts; and index.html needs no script for it.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import html from "../../index.html?raw";
import { StillFrame } from "./StillFrame";

/** The frame's elements and classes only: no comments, image sources, words or spacing. */
function shape(markup: string): string {
  const doc = new DOMParser().parseFromString(markup, "text/html");
  const walk = (el: Element): string => {
    const attrs = [...el.attributes]
      .filter((a) => a.name !== "src")
      .map((a) => `${a.name}=${a.value}`)
      .sort()
      .join(" ");
    return `<${el.tagName.toLowerCase()} ${attrs}>${[...el.children].map(walk).join("")}</>`;
  };
  const root = doc.body.firstElementChild;
  if (!root) throw new Error("no frame");
  return walk(root);
}

describe("the still frame", () => {
  const root = html.match(/<div id="root">([\s\S]*?)<\/div>\s*<script/)?.[1] ?? "";

  it("sits in index.html's #root, with the same shape React draws", () => {
    expect(root).toContain('data-testid="still-frame"');
    expect(shape(root.replace(/<!--[\s\S]*?-->/g, "").trim())).toBe(
      shape(renderToStaticMarkup(<StillFrame />)),
    );
  });

  it("needs no script: index.html has no inline script and no inline handler", () => {
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag).toMatch(/\ssrc=/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toContain("<style");
  });

  it("has a status for screen readers and hides its shapes from them", () => {
    expect(root).toContain('role="status"');
    expect(root.match(/aria-hidden="true"/g)).toHaveLength(2);
  });
});
