// Made-up data for Try it (docs/plan.md §1.186, rebuilt for the step model 2026-11-26): JSON for a
// trigger that carries values, and a PDF document kept in the Sandbox for one that carries a
// document. Scripted model answers only.
import { document, tenant } from "@countersign/db";
import { DEFAULT_MODELS, FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR, testBundle, v5Workflow } from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

type Json = Record<string, unknown>;
const j = (v: unknown) => v as Json;

describe.skipIf(!h)("made-up data for Try it", () => {
  const H = h as NonNullable<typeof h>;
  let templateId = "";

  beforeAll(async () => {
    await H.t.db
      .update(tenant)
      .set({ settings: { connectors_offered: ["testkit"], sandbox: true } })
      .where(eq(tenant.id, H.B.tenantId));
    const created = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "made-up-clerk",
      bundle: testBundle(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    templateId = j(j(created.json).agent).id as string;
  });

  const make = (body: unknown) =>
    H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/test-data`, body);
  const lastAsk = () => {
    const req = model.requests.at(-1);
    return {
      system: JSON.stringify(req?.system ?? ""),
      user: String(req?.messages[0]?.content ?? ""),
    };
  };

  it("makes up the trigger's data as JSON from its shape and what the steps read", async () => {
    const wf = v5Workflow([], {
      triggers: [
        {
          id: "t1",
          on: {
            type: "manual",
            input: {
              type: "object",
              properties: { vendor: { type: "string" }, total: { type: "string" } },
              required: ["vendor", "total"],
            },
          },
        },
      ],
    });
    model.push({
      toolUse: {
        name: "make_test_data",
        input: { data: { vendor: "Hartwell Supply", total: "640.40" } },
      },
    });
    const res = await make({ workflow: wf, name: "Bills", notes: "a $640 lumber bill" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({
      trigger: { vendor: "Hartwell Supply", total: "640.40" },
      missing: false,
      document: null,
    });
    expect(model.requests.at(-1)?.model).toBe(DEFAULT_MODELS.assist);
    const { system, user } = lastAsk();
    expect(system).toContain("You make up test data for a back-office workflow");
    expect(user).toContain('"vendor"');
    expect(user).toContain("<notes>\na $640 lumber bill\n</notes>");
  });

  it("makes up a document for a document trigger, as a PDF kept quietly in the Sandbox", async () => {
    const wf = v5Workflow([], {
      triggers: [{ id: "t1", on: { type: "event", event: "document.received" } }],
    });
    model.push({
      toolUse: {
        name: "make_test_document",
        input: {
          kind: "Receipt",
          from: { name: "Hartwell Supply", address: "12 Mill Road, Springfield" },
          number: "1042",
          date: "2026-11-20",
          currency: "USD",
          lines: [
            { description: "2x4 stud, 8 ft", quantity: 40, unitPrice: "4.25", amount: "170.00" },
            { description: "Deck screws, 5 lb", quantity: 2, unitPrice: "24.50", amount: "49.00" },
          ],
          subtotal: "219.00",
          tax: "17.52",
          total: "236.52",
          paid: "Visa ending 4242",
        },
      },
    });
    const res = await make({ workflow: wf, name: "Receipts" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const out = j(res.json);
    const made = j(out.document);
    expect(made.clientId).toBe(H.B.tenantId);
    expect(made.filename).toBe("receipt-hartwell-supply-1042.pdf");
    expect(j(out.trigger)).toMatchObject({
      documentId: made.id,
      mimeType: "application/pdf",
      filename: "receipt-hartwell-supply-1042.pdf",
    });
    expect(lastAsk().system).toContain("You make up a business document");
    // Stored in the Sandbox as a PDF, marked made up.
    const [row] = await H.t.db
      .select()
      .from(document)
      .where(eq(document.id, made.id as string));
    expect(row?.tenantId).toBe(H.B.tenantId);
    expect(row?.mimeType).toBe("application/pdf");
    expect(row?.meta).toMatchObject({ via: "try", madeUp: true });
    const stored = await H.objects.get(row?.storageKey as string);
    expect(new TextDecoder().decode(stored?.bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("refuses a made-up document for a client's own agent, and a workflow that doesn't read", async () => {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "made-up-client",
      bundle: testBundle("Client clerk"),
    });
    const agentId = j(j(created.json).agent).id as string;
    const wf = v5Workflow([], {
      triggers: [{ id: "t1", on: { type: "event", event: "document.received" } }],
    });
    const before = model.requests.length;
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/test-data`, {
      workflow: wf,
    });
    expect(res.status).toBe(422);
    expect(j(j(res.json).error).code).toBe("sandbox_only");
    const bad = await make({ workflow: { steps: "no" } });
    expect(bad.status).toBe(422);
    expect(model.requests.length).toBe(before);
  });
});
