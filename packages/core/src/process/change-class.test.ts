// v0.17 O8 (ARCHITECTURE §10.15): a drafted change's class, by code.

import { describe, expect, it } from "vitest";
import { classifyChange } from "./change-class";

const bundle = (steps: unknown[], definition: Record<string, unknown> = {}) => ({
  definition: {
    permissions: { mode: "suggest_only" },
    extraTools: ["qbo.bill.query"],
    ...definition,
  },
  workflows: [{ slug: "bills-in", workflow: { schemaVersion: 4, steps } }],
});

const read = { id: "read", kind: "skill", skill: "docs.read" };
const write = {
  id: "bill",
  kind: "write",
  tool: "qbo.bill.create",
  checks: { approval: { required: "required" } },
};

describe("classifyChange", () => {
  it("is none when nothing changed, and process for a change that loosens nothing", () => {
    expect(classifyChange(bundle([read, write]), bundle([read, write])).class).toBe("none");
    const later = bundle([{ ...read, input: { note: "trim the vendor name" } }, write]);
    expect(classifyChange(bundle([read, write]), later)).toEqual({
      class: "process",
      reasons: ["changes the process without loosening anything"],
    });
    // A new read step and a tighter approval are process changes too.
    const more = bundle([read, { id: "check", kind: "skill", skill: "docs.check" }, write]);
    expect(classifyChange(bundle([read, write]), more).class).toBe("process");
  });

  it("is never for a loosened approval, a removed check, a new write or new tools", () => {
    const loosened = bundle([
      read,
      { ...write, checks: { approval: { required: "not_required" } } },
    ]);
    expect(classifyChange(bundle([read, write]), loosened).reasons).toContain(
      `makes "bill"'s approval not required`,
    );
    const unchecked = bundle([read, { ...write, checks: {} }]);
    expect(classifyChange(bundle([read, write]), unchecked).class).toBe("never");
    const newWrite = bundle([
      read,
      write,
      { id: "pay", kind: "write", tool: "qbo.payment.create" },
    ]);
    expect(classifyChange(bundle([read, write]), newWrite).reasons).toContain(
      'adds a write step "pay"',
    );
    const tools = bundle([read, write], { extraTools: ["qbo.bill.query", "qbo.payment.create"] });
    expect(classifyChange(bundle([read, write]), tools).reasons).toContain(
      "adds the tool qbo.payment.create",
    );
    const mode = bundle([read, write], { permissions: { mode: "act" } });
    expect(classifyChange(bundle([read, write]), mode).class).toBe("never");
  });
});
