import { describe, expect, it } from "vitest";
import { describeElement } from "./describe";

function html(markup: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = markup;
  document.body.append(div);
  return div;
}

describe("describeElement", () => {
  it("names the nearest control, its label and its test id", () => {
    const root = html(`<button data-testid="inbox-approve"><span id="x">Approve</span></button>`);
    expect(describeElement(root.querySelector("#x"))).toBe('button "Approve" [inbox-approve]');
  });

  it("uses aria-label and never a field's value", () => {
    const root = html(
      `<label>Amount <input id="a" value="1234.56 secret" /></label><a aria-label="Runs" href="/runs">R</a>`,
    );
    const field = describeElement(root.querySelector("#a"));
    expect(field).toContain("field");
    expect(field).not.toContain("secret");
    expect(describeElement(root.querySelector("a"))).toBe('link "Runs"');
  });

  it("is short, and null for nothing", () => {
    const root = html(`<p>${"word ".repeat(200)}</p>`);
    expect((describeElement(root.querySelector("p")) ?? "").length).toBeLessThanOrEqual(300);
    expect(describeElement(null)).toBeNull();
  });
});
