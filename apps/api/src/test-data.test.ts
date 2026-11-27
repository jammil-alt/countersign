// Made-up data for Try it (docs/plan.md §1.186, rebuilt for the step model 2026-11-26): JSON for a
// trigger that carries values, and a PDF document kept in the Sandbox for one that carries a
// document. Scripted model answers only.

import { dbInboundPort, templateTestCopy } from "@countersign/agents";
import { DEV_USER_HEADER } from "@countersign/auth";
import { contact, document, rawRecord, run, tenant, vendor as vendorTable } from "@countersign/db";
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
  let templateVersionId = "";

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
    templateVersionId = j(j(created.json).version).id as string;
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

  it("makes up a whole email for a message trigger, its attachments as PDFs, all in the Sandbox", async () => {
    const wf = v5Workflow([], {
      triggers: [
        {
          id: "t1",
          on: { type: "message", channels: ["email"], from: { relationships: ["employee"] } },
        },
      ],
    });
    model.push({
      toolUse: {
        name: "make_test_message",
        input: {
          from: { name: "Priya Shah", email: "priya@example.com" },
          subject: "Receipts from the site visit",
          text: "Hi, two receipts from Tuesday attached. Thanks, Priya",
          attachments: [
            {
              kind: "Receipt",
              from: { name: "Hartwell Supply" },
              number: "1042",
              date: "2026-11-20",
              lines: [{ description: "Screws", amount: "49.00" }],
              total: "49.00",
            },
            {
              kind: "Receipt",
              from: { name: "Corner Cafe" },
              date: "2026-11-20",
              lines: [{ description: "Lunch", amount: "18.50" }],
              total: "18.50",
            },
          ],
        },
      },
    });
    const res = await make({ workflow: wf, name: "Receipts", notes: "two receipts" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const out = j(res.json);
    const msg = j(out.message);
    expect(msg.subject).toBe("Receipts from the site visit");
    const attached = msg.attachments as Json[];
    expect(attached.map((a) => a.filename)).toEqual([
      "receipt-hartwell-supply-1042.pdf",
      "receipt-corner-cafe.pdf",
    ]);
    const trigger = j(out.trigger);
    expect(trigger).toMatchObject({ channel: "email", contactId: null });
    expect(trigger.documents).toEqual(attached.map((a) => a.id));
    // The email is stored as an inbound one, so the first step reads its words.
    const [rec] = await H.t.db
      .select()
      .from(rawRecord)
      .where(eq(rawRecord.id, trigger.rawRecordId as string));
    expect(rec?.tenantId).toBe(H.B.tenantId);
    expect(rec?.entityType).toBe("InboundMessage");
    expect(rec?.payload).toMatchObject({
      subject: "Receipts from the site visit",
      text: "Hi, two receipts from Tuesday attached. Thanks, Priya",
      documents: trigger.documents,
      madeUp: true,
    });
  });

  // Staging, 2026-11-27: a step that asks the sender back had nobody to ask.
  it("sends the email from one of the Sandbox's people the trigger takes, as that contact", async () => {
    const [dana] = await H.t.db
      .insert(contact)
      .values({
        tenantId: H.B.tenantId,
        name: "Dana Whitfield",
        email: "dana@ridgeline.example.com",
        relationship: "employee",
        source: "manual",
      })
      .returning({ id: contact.id });
    const wf = v5Workflow([], {
      triggers: [
        {
          id: "t1",
          on: { type: "message", channels: ["email"], from: { relationships: ["employee"] } },
        },
      ],
    });
    model.push({
      toolUse: {
        name: "make_test_message",
        input: {
          from: { name: "Dana Whitfield", email: "Dana@Ridgeline.example.com" },
          subject: "Lumber",
          text: "Lumber for the Hall job, company card.",
          attachments: [],
        },
      },
    });
    const res = await make({ workflow: wf, name: "Receipts" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(lastAsk().user).toContain("Dana Whitfield (dana@ridgeline.example.com)");
    const trigger = j(j(res.json).trigger);
    expect(trigger.contactId).toBe(dana?.id);
    const [rec] = await H.t.db
      .select()
      .from(rawRecord)
      .where(eq(rawRecord.id, trigger.rawRecordId as string));
    expect(rec?.payload).toMatchObject({ contactId: dana?.id });
  });

  // Try it's From (2026-11-27): the person picked, by email or by text.
  it("writes the message from the contact Try it picked, as a text when it comes by phone", async () => {
    const [sam] = await H.t.db
      .insert(contact)
      .values({
        tenantId: H.B.tenantId,
        name: "Sam Ortiz",
        phone: "+15550104477",
        relationship: "employee",
        source: "manual",
      })
      .returning({ id: contact.id });
    const wf = v5Workflow([], {
      triggers: [
        {
          id: "t1",
          on: {
            type: "message",
            channels: ["email", "sms"],
            from: { relationships: ["employee"] },
          },
        },
      ],
    });
    model.push({
      toolUse: {
        name: "make_test_message",
        input: {
          from: { name: "Someone Else", email: "someone@example.com" },
          subject: "Fuel",
          text: "Fuel for the truck, $62.",
          attachments: [],
        },
      },
    });
    const res = await make({ workflow: wf, name: "Receipts", fromContactId: sam?.id });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(lastAsk().user).toContain("a text from Sam Ortiz (+15550104477)");
    const out = j(res.json);
    expect(j(out.trigger)).toMatchObject({ channel: "sms", contactId: sam?.id });
    expect(j(out.message)).toMatchObject({
      from: "Sam Ortiz <+15550104477>",
      text: "Fuel for the truck, $62.",
      contactId: sam?.id,
      channel: "sms",
    });
    const [rec] = await H.t.db
      .select()
      .from(rawRecord)
      .where(eq(rawRecord.id, j(out.trigger).rawRecordId as string));
    expect(rec?.payload).toMatchObject({
      channel: "sms",
      from: "+15550104477",
      contactId: sam?.id,
      subject: null,
    });
    // An email asked of someone with no email address is refused before the model is asked.
    const before = model.requests.length;
    const noEmail = await make({ workflow: wf, fromContactId: sam?.id, channel: "email" });
    expect(noEmail.status).toBe(422);
    expect(j(j(noEmail.json).error).code).toBe("no_address");
    // Someone who isn't the Sandbox's is refused.
    const [other] = await H.t.db
      .insert(contact)
      .values({ tenantId: H.A.tenantId, name: "Ann", email: "ann@a.example", source: "manual" })
      .returning({ id: contact.id });
    const notOurs = await make({ workflow: wf, fromContactId: other?.id });
    expect(notOurs.status).toBe(422);
    expect(j(j(notOurs.json).error).code).toBe("invalid_contact");
    expect(model.requests.length).toBe(before);
  });

  it("makes up an email for a Sandbox agent, kept with the agent", async () => {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.B.tenantId}/agents`, {
      slug: "made-up-sandbox",
      bundle: testBundle("Sandbox clerk"),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const agentId = j(j(created.json).agent).id as string;
    const wf = v5Workflow([], {
      triggers: [
        {
          id: "t1",
          on: { type: "message", channels: ["email"], from: { relationships: ["employee"] } },
        },
      ],
    });
    model.push({
      toolUse: {
        name: "make_test_message",
        input: {
          from: { name: "Priya Shah", email: "priya@example.com" },
          subject: "Fuel",
          text: "Fuel for the site truck",
          attachments: [],
        },
      },
    });
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/test-data`, {
      workflow: wf,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const [rec] = await H.t.db
      .select()
      .from(rawRecord)
      .where(eq(rawRecord.id, j(j(res.json).trigger).rawRecordId as string));
    expect(rec?.tenantId).toBe(H.B.tenantId);
    expect(rec?.payload).toMatchObject({ agentId, channel: "email", madeUp: true });
  });

  it("lets the template's test copy, which its test runs run, read the made-up email", async () => {
    const wf = v5Workflow([], {
      triggers: [
        {
          id: "t1",
          on: { type: "message", channels: ["email"], from: { relationships: ["employee"] } },
        },
      ],
    });
    model.push({
      toolUse: {
        name: "make_test_message",
        input: {
          from: { name: "Priya Shah", email: "priya@example.com" },
          subject: "Fuel",
          text: "Fuel for the site truck",
          attachments: [],
        },
      },
    });
    const res = await make({ workflow: wf, name: "Receipts" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const trigger = j(j(res.json).trigger);
    const copy = await templateTestCopy(H.t.db as never, {
      tenantId: H.B.tenantId,
      templateVersionId,
    });
    const runFor = async (agentId: string, agentVersionId: string) => {
      const [r] = await H.t.db
        .insert(run)
        .values({
          tenantId: H.B.tenantId,
          agentId,
          agentVersionId,
          workflowSlug: "main",
          mode: "test",
          status: "running",
          trigger: { type: "manual", payload: trigger },
        })
        .returning({ id: run.id });
      return r?.id as string;
    };
    const copyRun = await runFor(copy.agent.id, copy.version.id);
    const read = await dbInboundPort(H.db).get(H.B.tenantId, {
      runId: copyRun,
      agentId: copy.agent.id,
    });
    expect(read).toMatchObject({ channel: "email", subject: "Fuel" });
    expect(read?.text).toBe("Fuel for the site truck");
  });

  it("writes the email around files uploaded for the try, attaching them as they are", async () => {
    const wf = v5Workflow([], {
      triggers: [
        {
          id: "t1",
          on: { type: "message", channels: ["email"], from: { relationships: ["employee"] } },
        },
      ],
    });
    const form = new FormData();
    form.append(
      "files",
      new File([new TextEncoder().encode("%PDF-1.4\n%test\n")], "my-receipt.pdf", {
        type: "application/pdf",
      }),
    );
    const res0 = await H.app.request(
      `/api/ops/clients/${H.B.tenantId}/uploads?for=try`,
      { method: "POST", headers: { [DEV_USER_HEADER]: OPERATOR }, body: form },
      H.env,
      {
        waitUntil: () => {},
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );
    const up = { status: res0.status, json: await res0.json() };
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    const docId = j(j((j(up.json).results as Json[])[0]).document).id as string;
    model.push({
      toolUse: {
        name: "make_test_message",
        input: {
          from: { name: "Priya Shah", email: "priya@example.com" },
          subject: "My receipt",
          text: "Receipt attached.",
          attachments: [],
        },
      },
    });
    const res = await make({ workflow: wf, attach: [docId] });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json).trigger).toMatchObject({ documents: [docId] });
    expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain("my-receipt.pdf");
    // A file that isn't the Sandbox's is refused.
    const bad = await make({ workflow: wf, attach: ["00000000-0000-4000-8000-000000000999"] });
    expect(bad.status).toBe(422);
  });

  it("gives the model the Sandbox's own records and the cases picked", async () => {
    await H.t.db
      .insert(vendorTable)
      .values({
        tenantId: H.B.tenantId,
        name: "Hartwell Supply",
        normalizedName: "hartwell supply",
        ext: { domains: ["hartwell.example"] },
      })
      .onConflictDoNothing();
    const wf = v5Workflow([], {
      triggers: [{ id: "t1", on: { type: "event", event: "document.received" } }],
    });
    model.push({
      toolUse: {
        name: "make_test_document",
        input: {
          kind: "Invoice",
          from: { name: "Hartwel Supply Co" },
          date: "2026-11-20",
          lines: [{ description: "Studs", amount: "10.00" }],
          total: "10.00",
        },
      },
    });
    const res = await make({ workflow: wf, variations: ["near_vendor", "totals_off"] });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const { user } = lastAsk();
    expect(user).toContain("<records>");
    expect(user).toContain("Hartwell Supply");
    expect(user).toContain("hartwell.example");
    expect(user).toContain("close to one the Sandbox has");
    expect(user).toContain("don't add up");
    // An unknown case is refused before the model is asked.
    const bad = await make({ workflow: wf, variations: ["no_such_case"] });
    expect(bad.status).toBe(400);
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
