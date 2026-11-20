// A model's answer reaching the materials pack's record tools (PLATFORM_QA AI-5, AI-6). Both tools
// are `internal` (no gate) and may be offered to the model of an agent-mode skill (`extraTools`),
// so their input can be model output. What they record must still hold the hard rules
// (invariant 7) and must not pass a model's words off as a person's decision (invariants 9, 10).

import { agent, inboxItem, run, withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLine } from "../catalog/keys";
import { catalogItem, itemAlias, itemMatch } from "../schema";
import { SPLIT_TOOLS } from "../split";
import { insertShop, type ShopFixture } from "../testing.test-helper";
import { type PackTool, packToolContext } from "../tools";
import { VENDOR_TOOLS } from "./tools";

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

  const ctx = (runId: string | null = null) =>
    packToolContext({
      tenantId: A.tenantId,
      agentVersionId: A.agentVersionId,
      runId,
      mode: "live",
      db: t.db,
    });

  const matchesOf = (docLineId: string) =>
    withTenant(t.db, A.tenantId, (tx) =>
      tx
        .select({
          decision: itemMatch.decision,
          catalogItemId: itemMatch.catalogItemId,
          method: itemMatch.method,
          decidedByUserId: itemMatch.decidedByUserId,
        })
        .from(itemMatch)
        .where(and(eq(itemMatch.tenantId, A.tenantId), eq(itemMatch.docLineId, docLineId))),
    );

  /** A run of the agent with a person step resolved by `by` with `answer`. */
  async function answeredRun(by: string, answer: unknown): Promise<string> {
    const [a] = await t.db.select().from(agent).where(eq(agent.tenantId, A.tenantId));
    const [r] = await t.db
      .insert(run)
      .values({
        tenantId: A.tenantId,
        agentId: a?.id as string,
        agentVersionId: A.agentVersionId,
        workflowSlug: "vendor-lines",
      })
      .returning();
    await t.db.insert(inboxItem).values({
      tenantId: A.tenantId,
      kind: "request",
      runId: r?.id as string,
      title: "1 invoice line needs you",
      status: "resolved",
      resolution: { approved: true, answer, by },
      resolvedBy: by,
      resolvedAt: new Date(),
    });
    return r?.id as string;
  }

  it("(PLATFORM_QA AI-5) matches.record never records a match the hard rules veto (a 1/2in line to a 3/4in item)", async () => {
    const line = 'BALTIC BIRCH PLYWOOD 1/2" 5X5 BB/BB';
    const [docLineId] = await A.invoice(vendorId, [
      { description: line, qty: "10", uom: "EA", unitPrice: "40.00" },
    ]);
    const parsed = parseLine(line);
    const record = tool(SPLIT_TOOLS, "materials.matches.record");
    // A model's answer wired (or called) straight into the record step, with no Check matches in
    // between: "matched", sure, nothing vetoed.
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
    const rows = await matchesOf(docLineId ?? "");
    const aliases = await withTenant(t.db, A.tenantId, (tx) =>
      tx
        .select({ id: itemAlias.id })
        .from(itemAlias)
        .where(and(eq(itemAlias.tenantId, A.tenantId), eq(itemAlias.catalogItemId, threeQuarter))),
    );
    // The thickness differs (1/2 vs 3/4), so the match is vetoed: no "matched" row to the 3/4in
    // item and no alias that would match the 1/2in wording to it from now on.
    expect({
      rows: rows.map((r) => ({ decision: r.decision, catalogItemId: r.catalogItemId })),
      aliases: aliases.length,
    }).toEqual({
      rows: [{ decision: "unsure", catalogItemId: null }],
      aliases: 0,
    });
  });

  it("(PLATFORM_QA AI-5) vendor_items.register never registers a match the hard rules veto", async () => {
    const line = 'BALTIC BIRCH PLYWOOD 1/2" 5X5 BB/BB';
    const { documentId, lineIds } = await A.invoiceDoc(vendorId, [
      { description: line, qty: "3", uom: "EA", unitPrice: "40.00" },
    ]);
    const parsed = parseLine(line);
    const register = tool(VENDOR_TOOLS, "materials.vendor_items.register");
    const out = (await register.run(
      register.input.parse({
        documentId,
        vendorId,
        lines: [
          {
            docLineId: lineIds[0],
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
      }),
      ctx(),
    )) as { needsPersonCount: number; vendorItemIds: string[] };
    expect(out).toMatchObject({ needsPersonCount: 1, vendorItemIds: [] });
    expect((await matchesOf(lineIds[0] ?? "")).map((r) => r.decision)).toEqual(["unsure"]);
  });

  it("(PLATFORM_QA AI-6) vendor_items.register doesn't record a model's answer as a person's decision", async () => {
    const { documentId, lineIds } = await A.invoiceDoc(vendorId, [
      {
        description: 'BALTIC BIRCH PLYWOOD 3/4" 5X5 BB/BB',
        qty: "4",
        uom: "EA",
        unitPrice: "61.00",
      },
    ]);
    const register = tool(VENDOR_TOOLS, "materials.vendor_items.register");
    const answers = [{ lineNo: 1, catalogItemId: threeQuarter }];
    // An agent's model call (no person step answered anything in this run): it names the client
    // admin as the one who decided.
    const input = register.input.parse({ documentId, vendorId, answers, decidedBy: A.userId });
    const outcome = await register.run(input, ctx()).then(
      () => "recorded",
      (e: Error) => `refused: ${e.message}`,
    );
    // A run whose person step the admin answered, but with another line: still not theirs.
    const other = await answeredRun(A.userId, { lines: [{ lineNo: 2, newItem: true }] });
    const otherOutcome = await register.run(input, ctx(other)).then(
      () => "recorded",
      (e: Error) => `refused: ${e.message}`,
    );
    expect({
      outcome,
      otherOutcome,
      humanRows: (await matchesOf(lineIds[0] ?? "")).filter((r) => r.method === "human"),
    }).toEqual({
      outcome: expect.stringMatching(/^refused: .*person/),
      otherOutcome: expect.stringMatching(/^refused: /),
      humanRows: [],
    });
  });

  it("(PLATFORM_QA AI-6) vendor_items.register records the answer a person gave in this run as theirs", async () => {
    const { documentId, lineIds } = await A.invoiceDoc(vendorId, [
      {
        description: 'BALTIC BIRCH PLYWOOD 3/4" 5X5 BB/BB',
        qty: "2",
        uom: "EA",
        unitPrice: "62.00",
      },
    ]);
    const register = tool(VENDOR_TOOLS, "materials.vendor_items.register");
    const answers = [{ lineNo: 1, catalogItemId: threeQuarter }];
    const runId = await answeredRun(A.userId, { lines: answers });
    await register.run(
      register.input.parse({ documentId, vendorId, answers, decidedBy: A.userId }),
      ctx(runId),
    );
    expect(await matchesOf(lineIds[0] ?? "")).toEqual([
      {
        decision: "matched",
        catalogItemId: threeQuarter,
        method: "human",
        decidedByUserId: A.userId,
      },
    ]);
  });
});
