import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../schemas/tool";
import { actionKind, buildActionCatalog, fieldsFromSchema, resolveMerged } from "./catalog";

const spec = (over: Partial<ToolSpec> & Pick<ToolSpec, "id">): ToolSpec =>
  ({
    description: over.id,
    input: { type: "object", properties: {} },
    output: { type: "object", properties: {} },
    sideEffect: "none",
    verb: "read",
    source: "platform",
    ...over,
  }) as ToolSpec;

describe("the action catalog", () => {
  const specs = [
    spec({ id: "qbo.vendor.query", source: "qbo" }),
    spec({
      id: "qbo.bill.create",
      source: "qbo",
      connector: "qbo",
      sideEffect: "external",
      verb: "create",
    }),
    spec({ id: "qbo.bill.update_memo", source: "qbo", connector: "qbo", sideEffect: "external" }),
    spec({ id: "gmail.send", source: "gmail", connector: "gmail", sideEffect: "external" }),
    spec({
      id: "materials.vendor_items.register",
      source: "materials",
      area: "purchasing",
      sideEffect: "internal",
    }),
    spec({ id: "docs.get" }),
    spec({ id: "health.runs" }),
    spec({ id: "comms.reach_out", sideEffect: "internal" }),
  ];
  const catalog = buildActionCatalog(specs, {
    connectors: { qbo: "QuickBooks Online", gmail: "Gmail" },
    areas: { purchasing: "Purchasing", shared: "Shared" },
  });
  const group = (id: string) => catalog.find((g) => g.id === id);

  it("puts a connector's reads and changes under the connector, our records under areas", () => {
    expect(group("qbo")?.actions.map((a) => [a.id, a.kind])).toEqual([
      ["qbo.vendor.query", "get"],
      ["qbo.bill.update_memo", "change"],
    ]);
    expect(group("purchasing")).toMatchObject({ type: "area", name: "Purchasing" });
    expect(group("purchasing")?.actions[0]?.kind).toBe("save");
    expect(group("shared")?.actions.map((a) => a.id)).toEqual(["docs.get"]);
  });

  it("offers a merged connector's action once, and its tools nowhere else", () => {
    expect(group("accounting")?.actions.map((a) => a.id)).toEqual(["accounting.bill.create"]);
    expect(group("email")?.actions).toMatchObject([{ id: "email.send", kind: "send" }]);
    expect(group("gmail")).toBeUndefined();
    expect(catalog[0]?.type).toBe("connector");
  });

  it("leaves out the engines and the platform's own", () => {
    const ids = catalog.flatMap((g) => g.actions.map((a) => a.id));
    expect(ids).not.toContain("health.runs");
    expect(ids).not.toContain("comms.reach_out");
  });

  it("runs a merged action on the client's connected tool", () => {
    expect(resolveMerged("accounting.bill.create", ["billcom"])).toBe("billcom.bill.create");
    expect(resolveMerged("accounting.bill.create", ["qbo", "billcom"])).toBe("qbo.bill.create");
    expect(resolveMerged("accounting.bill.create", [])).toBeUndefined();
  });

  it("tells a send from a change, and reads fields from a schema", () => {
    expect(actionKind({ id: "odoo.invoice.post", sideEffect: "external" })).toBe("change");
    expect(actionKind({ id: "slack.message.post", sideEffect: "external" })).toBe("send");
    expect(
      fieldsFromSchema({
        type: "object",
        required: ["lines"],
        properties: {
          lines: {
            type: "array",
            items: { type: "object", properties: { sku: { type: "string" } } },
          },
          due: { type: "string", format: "date" },
          paid: { type: ["boolean", "null"] },
        },
      }),
    ).toEqual([
      {
        name: "lines",
        type: "list",
        required: true,
        of: [{ name: "sku", type: "text", required: false }],
      },
      { name: "due", type: "date", required: false },
      { name: "paid", type: "yes_no", required: false },
    ]);
  });
});
