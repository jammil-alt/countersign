// What a client reads as an inbox item's title (QA round 1): never a tool's description written
// for the agent, never a tool id. The step lookup (a run's own version) is covered through the
// Table and the Desk in notify.test.ts.
import type { Tx } from "@countersign/db";
import { describe, expect, it } from "vitest";
import { clientTitles } from "./change-display";
import type { Platform } from "./platform";

const tools = new Map([
  [
    "qbo.bill.update_lines",
    {
      spec: {
        display: {
          description: {
            en: "Replace the bill's lines with the items on the vendor's invoice. The total stays the same.",
            es: "Cambia las líneas de la factura por los artículos de la factura del proveedor. El total no cambia.",
          },
        },
      },
    },
  ],
]);
const platform = { tools } as unknown as Pick<Platform, "tools">;
// No item here needs a run's version: a query would fail the test.
const tx = new Proxy({}, { get: () => () => Promise.reject(new Error("no query expected")) });

const base = { tenantId: "t", runId: null };

describe("clientTitles", () => {
  it("titles a change by its tool's line for people, in the reader's language", async () => {
    const items = [
      {
        ...base,
        id: "old",
        kind: "external_action",
        title:
          "Itemize a QuickBooks bill: replace lines (usually its one account line) with the invoice's item lines. (qbo.bill.update_lines)",
        payload: { tool: "qbo.bill.update_lines", stepId: "itemize" },
      },
      {
        ...base,
        id: "other",
        kind: "external_action",
        title: "Update a thing (acme.thing.update)",
        payload: { tool: "acme.thing.update" },
      },
      { ...base, id: "question", kind: "request", title: "Which bill is it?", payload: {} },
    ];
    const en = await clientTitles(tx as unknown as Tx, items, platform);
    expect(en.get("old")).toBe(
      "Replace the bill's lines with the items on the vendor's invoice. The total stays the same.",
    );
    // No display and no step to read: the title without its tool id.
    expect(en.get("other")).toBe("Update a thing");
    expect(en.get("question")).toBe("Which bill is it?");
    const es = await clientTitles(tx as unknown as Tx, items, platform, "es");
    expect(es.get("old")).toMatch(/^Cambia las líneas/);
  });
});
