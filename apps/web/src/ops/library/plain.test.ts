import { describe, expect, it } from "vitest";
import { TOOL_LINES, TOOL_TITLES, toolLine, toolName } from "./plain";

describe("plain words for tools", () => {
  it("titles are short, in sentence case, without ids", () => {
    for (const [id, title] of Object.entries(TOOL_TITLES)) {
      expect(title.length, id).toBeLessThanOrEqual(40);
      expect(title.charAt(0), id).toBe(title.charAt(0).toUpperCase());
      expect(title, id).not.toMatch(/[_`]|\w\.\w/);
      expect(title.endsWith("."), id).toBe(false);
    }
  });

  it("rewritten lines are one short sentence", () => {
    for (const [id, line] of Object.entries(TOOL_LINES)) {
      expect(line.length, id).toBeLessThanOrEqual(120);
      expect(line.endsWith("."), id).toBe(true);
      expect(line, id).not.toMatch(/`/);
    }
  });

  it("names a tool by its title, else its id in words", () => {
    expect(toolName("qbo.deposit.create")).toBe("Book a deposit");
    expect(toolName("qbo.bill.create")).toBe("Create a bill");
    expect(toolName("acme.widget.list")).toBe("List widget");
  });

  it("gives a rewritten line, else the description's headline", () => {
    expect(toolLine({ id: "docs.read", description: "A document. `as: quote` reads." })).toBe(
      TOOL_LINES["docs.read"],
    );
    expect(
      toolLine({ id: "acme.widget.list", description: "List widgets (all of them): name, id." }),
    ).toBe("List widgets: name, id.");
  });
});
