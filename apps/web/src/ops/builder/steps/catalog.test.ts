import { describe, expect, it } from "vitest";
import { triggerFields, usesContextFrom } from "./catalog";

describe("what the forms read from the server", () => {
  it("offers the palette's skills by who does them, and the actions by their words", () => {
    const ctx = usesContextFrom({
      actions: [
        {
          type: "connector",
          id: "qbo",
          name: "QuickBooks Online",
          actions: [
            {
              id: "qbo.bill.create",
              label: "qbo.bill.create",
              description: "",
              kind: "change",
              input: [{ name: "vendorId", type: "text", required: true }],
              output: [],
            },
          ],
        },
      ],
      catalog: {
        automations: [],
        skills: [
          {
            ref: "docs.read-document",
            source: "builtin",
            version: null,
            kind: "ai",
            palette: true,
            definition: {
              name: "Read a document",
              description: "Reads one.",
              input: {
                type: "object",
                properties: { documentId: { type: "string" } },
                required: ["documentId"],
              },
              output: {
                type: "object",
                properties: { total: { type: "string", format: "money" } },
              },
            },
          },
          {
            ref: "old.wrapper",
            source: "builtin",
            version: null,
            palette: false,
            definition: { name: "Old" },
          },
        ],
      } as never,
    });
    expect(ctx.actions.get("qbo.bill.create")?.label).toBe("Create a bill");
    expect(ctx.skills.map((s) => [s.name, s.kind])).toEqual([["Read a document", "ai"]]);
    expect(ctx.skills[0]?.input).toEqual([{ name: "documentId", type: "text", required: true }]);
  });

  it("reads the trigger's fields from a manual start's input or an event's payload", () => {
    const events = [
      {
        type: "document.extracted",
        payload: { type: "object", properties: { documentId: { type: "string" } } },
      },
    ];
    const manual = {
      triggers: [
        {
          on: {
            type: "manual",
            input: { type: "object", properties: { note: { type: "string" } } },
          },
        },
      ],
    };
    const event = { triggers: [{ on: { type: "event", event: "document.extracted" } }] };
    expect(triggerFields(manual as never, events).map((f) => f.name)).toEqual(["note"]);
    expect(triggerFields(event as never, events).map((f) => f.name)).toEqual(["documentId"]);
    expect(triggerFields({ triggers: [] }, events)).toEqual([]);
  });
});
