// AI robustness (lens 3): a model's answer reaching the materials pack's record tools. Both tools
// are `internal` (no gate) and are offered to the model of any agent-mode skill of an agent that
// lists them in `extraTools` (run-agent.ts: an agent-mode skill keeps all of them), so their input
// can be model output. What they record must still hold the hard rules (invariant 7) and must not
// pass a model's words off as a person's decision (invariants 9 and 10).

import { withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import {
  catalogItem,
  itemAlias,
  itemMatch,
  type PackTool,
  packToolContext,
  parseLine,
  SPLIT_TOOLS,
  VENDOR_TOOLS,
} from "@countersign/pack-materials";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertShop, type ShopFixture } from "../../../../packs/materials/src/testing.test-helper";

for (const level of ["warn", "error"] as const)
  vi.spyOn(console, level).mockImplementation(() => {});

const online = await databaseAvailable();

function tool(list: readonly PackTool[], id: string): PackTool {
  const t = list.find((x) => x.spec.id === id);
  if (!t) throw new Error(`no tool ${id}`);
  return t;
}

describe.skipIf(!online)("materials record tools fed by a model", () => {
  let t: TestDatabase;
  let A: ShopFixture;
  let vendorId = "";
  let threeQuarter = "";

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertShop(t.db, "Millwork A");
    vendorId = await A.vendor("Northline Panel Supply");
    const text = 'BALTIC BIRCH PLYWOOD 3/4" 5X5 BB/BB';
    const p = parseLine(text);
    const [row] = await t.db
      .insert(catalogItem)
      .values({
        tenantId: A.tenantId,
        category: p.category,
        canonicalName: text,
        attributes: p.attributes,
        standardUom: p.standardUom,
      })
      .returning();
    threeQuarter = row?.id ?? "";
  });
  afterAll(async () => {
    await t?.drop();
  });

  const ctx = () =>
    packToolContext({
      tenantId: A.tenantId,
      agentVersionId: A.agentVersionId,
      runId: null,
      mode: "live",
      db: t.db,
    });

  it("AI-5: matches.record never records a match the hard rules veto (a 1/2in line to a 3/4in item)", async () => {
    const line = 'BALTIC BIRCH PLYWOOD 1/2" 5X5 BB/BB';
    const [docLineId] = await A.invoice(vendorId, [
      { description: line, qty: "10", uom: "EA", unitPrice: "40.00" },
    ]);
    const parsed = parseLine(line);
    const record = tool(SPLIT_TOOLS, "materials.matches.record");
    // What a model's answer looks like when it is wired (or called) straight into the record step,
    // with no Check matches in between: "matched", sure, nothing vetoed.
    const input = record.input.parse({
      vendorId,
      lines: [
        {
          docLineId,
          lineNo: 1,
          decision: "matched",
          catalogItemId: threeQuarter,
          confidence: 0.99,
          method: "llm",
          hingeAttribute: null,
          needsReview: false,
          vetoed: null,
          category: parsed.category,
          attributes: parsed.attributes,
          candidates: [],
        },
      ],
    });
    await record.run(input, ctx());
    const rows = await withTenant(t.db, A.tenantId, (tx) =>
      tx
        .select({ decision: itemMatch.decision, catalogItemId: itemMatch.catalogItemId })
        .from(itemMatch)
        .where(and(eq(itemMatch.tenantId, A.tenantId), eq(itemMatch.docLineId, docLineId ?? ""))),
    );
    const aliases = await withTenant(t.db, A.tenantId, (tx) =>
      tx
        .select({ id: itemAlias.id })
        .from(itemAlias)
        .where(and(eq(itemAlias.tenantId, A.tenantId), eq(itemAlias.catalogItemId, threeQuarter))),
    );
    // Expected: the thickness differs (1/2 vs 3/4), so the match is vetoed: no "matched" row to
    // the 3/4in item and no alias that would match the 1/2in wording to it from now on.
    expect({ rows, aliases: aliases.length }).toEqual({
      rows: [{ decision: "unsure", catalogItemId: null }],
      aliases: 0,
    });
  });

  it("AI-6: vendor_items.register doesn't record a model's answer as a person's decision", async () => {
    const { documentId, lineIds } = await A.invoiceDoc(vendorId, [
      {
        description: 'BALTIC BIRCH PLYWOOD 3/4" 5X5 BB/BB',
        qty: "4",
        uom: "EA",
        unitPrice: "61.00",
      },
    ]);
    const register = tool(VENDOR_TOOLS, "materials.vendor_items.register");
    // An agent's model call (no person step answered anything in this run): it names the client
    // admin as the one who decided.
    const input = register.input.parse({
      documentId,
      vendorId,
      answers: [{ lineNo: 1, catalogItemId: threeQuarter }],
      decidedBy: A.userId,
    });
    const outcome = await register.run(input, ctx()).then(
      () => "recorded",
      (e: Error) => `refused: ${e.message}`,
    );
    const rows = await withTenant(t.db, A.tenantId, (tx) =>
      tx
        .select({
          method: itemMatch.method,
          confidence: itemMatch.confidence,
          decidedByUserId: itemMatch.decidedByUserId,
          agentVersionId: itemMatch.agentVersionId,
        })
        .from(itemMatch)
        .where(and(eq(itemMatch.tenantId, A.tenantId), eq(itemMatch.docLineId, lineIds[0] ?? ""))),
    );
    // Expected: refused, or recorded as the agent's (agent_version_id), never as method "human"
    // decided by a person who saw nothing.
    expect({ outcome, humanRows: rows.filter((r) => r.method === "human") }).toMatchObject({
      humanRows: [],
    });
  });
});
