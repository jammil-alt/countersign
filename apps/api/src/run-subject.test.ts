// What a run is about (core RunSubject) on both sides, over a throwaway database: the invoice that
// started it, else its first change to a tool, else what started it; the names of the records its
// steps cite; and a step that reads by its state ("Update the record" while it waits, the client
// label once done), even for lines stored with the done label while they waited.

import { createHash } from "node:crypto";
import { createQboConnector } from "@countersign/connectors";
import { FAKE_QBO_CLIENT, fakeQbo } from "@countersign/connectors/testing";
import { FORBIDDEN_PORTAL_FIELD } from "@countersign/core";
import {
  agent,
  agentVersion,
  docExtraction,
  document,
  externalAction,
  run,
  stepRun,
  vendor,
} from "@countersign/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";
import { summaryAfterLabel } from "./routes/portal";
import { runSubjects, triggerDocumentId } from "./runs/subject";

// QuickBooks registered (never called): its tools' displays name a change.
const qbo = fakeQbo();
const h = await createApiHarness({
  connectors: () => [
    createQboConnector({ ...FAKE_QBO_CLIENT, environment: "sandbox", fetch: qbo.fetch }),
  ],
});
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

describe("a step's stored line after its label", () => {
  it("drops the label the timeline already shows, whichever tense it was in", () => {
    const labels = ["Itemized the bill", "Itemize the bill"];
    expect(summaryAfterLabel("Itemized the bill: waiting for approval", labels)).toBe(
      "Waiting for approval",
    );
    expect(summaryAfterLabel("Itemize the bill: not approved", labels)).toBe("Not approved");
    expect(summaryAfterLabel("Itemized the bill into 6 lines", labels)).toBe(
      "Itemized the bill into 6 lines",
    );
    expect(summaryAfterLabel(null, labels)).toBeNull();
  });

  it("finds the document a run's trigger names", () => {
    const id = "00000000-0000-4000-8000-000000000d01";
    expect(triggerDocumentId({ type: "event", payload: { documentId: id } })).toBe(id);
    expect(triggerDocumentId({ type: "manual" })).toBeNull();
    expect(triggerDocumentId({ payload: { documentId: "not-an-id" } })).toBeNull();
  });
});

describe.skipIf(!h)("what a run is about", () => {
  const H = h as NonNullable<typeof h>;
  const db = H.t.db;
  const A = () => H.A.tenantId;
  const ids = {} as Record<
    "agent" | "version" | "byDoc" | "byChange" | "byHand" | "vendor",
    string
  >;

  beforeAll(async () => {
    const [a] = await db
      .insert(agent)
      .values({
        tenantId: A(),
        kind: "client",
        slug: "bill-clerk",
        name: "Bill clerk",
        runStatus: "active",
        stage: "live",
      })
      .returning();
    if (!a) throw new Error("no agent");
    ids.agent = a.id;
    const [v] = await db
      .insert(agentVersion)
      .values({
        tenantId: A(),
        agentId: a.id,
        version: 1,
        bundle: testBundle("Bill clerk"),
        bundleHash: "hash-subject",
        status: "live",
        authorType: "operator",
      })
      .returning();
    if (!v) throw new Error("no version");
    ids.version = v.id;

    const [d] = await db
      .insert(document)
      .values({
        tenantId: A(),
        source: "upload",
        storageKey: "tenants/a/northline-20418.pdf",
        mimeType: "application/pdf",
        filename: "northline-20418.pdf",
        sizeBytes: 10,
        sha256: createHash("sha256").update("northline-20418").digest("hex"),
      })
      .returning();
    if (!d) throw new Error("no document");
    await db.insert(docExtraction).values({
      tenantId: A(),
      documentId: d.id,
      model: "replay",
      header: { vendorName: "Northline Panel Supply", invoiceNumber: "20418" },
      currency: "USD",
      subtotal: "9742.3500",
      total: "9742.3500",
      linesSum: "9742.3500",
      totalsMatch: true,
    });

    const addRun = async (trigger: Record<string, unknown>) => {
      const [r] = await db
        .insert(run)
        .values({
          tenantId: A(),
          agentId: ids.agent,
          agentVersionId: ids.version,
          workflowSlug: "fix-record",
          mode: "live",
          status: "running",
          trigger,
          startedAt: new Date(),
        })
        .returning();
      if (!r) throw new Error("no run");
      return r.id;
    };
    ids.byDoc = await addRun({
      type: "event",
      eventType: "document.extracted",
      payload: { documentId: d.id },
    });
    ids.byChange = await addRun({ type: "manual" });
    ids.byHand = await addRun({ type: "schedule" });

    await db.insert(externalAction).values({
      tenantId: A(),
      connectionId: H.A.connectionId,
      tool: "qbo.bill.update_lines",
      runId: ids.byChange,
      idempotencyKey: `${ids.byChange}:itemize:0`,
      input: { id: "146", lines: [] },
      before: { docNumber: "20418", vendor: { id: "56", name: "Northline Panel Supply" } },
    });

    const [ven] = await db
      .insert(vendor)
      .values({
        tenantId: A(),
        name: "Northline Panel Supply",
        normalizedName: "northline panel supply",
      })
      .returning();
    if (!ven) throw new Error("no vendor");
    ids.vendor = ven.id;
    // The waiting step, stored as the executor wrote it before steps read by their state.
    await db.insert(stepRun).values({
      tenantId: A(),
      runId: ids.byChange,
      nodeId: "update",
      nodeType: "action",
      status: "waiting",
      summary: "Corrected the record: waiting for approval",
      output: { sources: [ven.id] },
      startedAt: new Date(),
    });
  });

  it("names the invoice, else the first change, else what started the run", async () => {
    const runs = await db.select().from(run);
    const subjects = await db.transaction((tx) => runSubjects(tx, [A()], runs, H.platform));
    expect(subjects.get(ids.byDoc)).toEqual({
      kind: "document",
      vendor: "Northline Panel Supply",
      number: "20418",
      filename: "northline-20418.pdf",
    });
    expect(subjects.get(ids.byChange)).toMatchObject({
      kind: "change",
      number: "20418",
      with: "Northline Panel Supply",
    });
    expect(j(subjects.get(ids.byChange)).name.en).toBe("QuickBooks bill");
    expect(subjects.get(ids.byHand)).toEqual({
      kind: "trigger",
      startedBy: "schedule",
      event: null,
    });
  });

  it("serves the subject in both lists and on both run pages", async () => {
    const portal = await H.call(admin("a"), "GET", "/api/runs");
    const byId = new Map(j(portal.json).runs.map((r: { id: string }) => [r.id, r]));
    expect(j(byId.get(ids.byDoc)).subject).toMatchObject({ kind: "document", number: "20418" });
    const ops = await H.call(OPERATOR, "GET", `/api/ops/runs?client=${A()}`);
    const opsById = new Map(j(ops.json).runs.map((r: { id: string }) => [r.id, r]));
    expect(j(opsById.get(ids.byChange)).subject).toMatchObject({ kind: "change" });

    const page = await H.call(admin("a"), "GET", `/api/runs/${ids.byChange}`);
    expect(page.status, JSON.stringify(page.json)).toBe(200);
    expect(JSON.stringify(page.json)).not.toMatch(FORBIDDEN_PORTAL_FIELD);
    const body = j(page.json);
    expect(body.run.subject).toMatchObject({ kind: "change", number: "20418" });
    // Not done yet: what it does, and the state below it without the label again.
    expect(body.steps[0]).toMatchObject({
      label: "Update the record",
      summary: "Waiting for approval",
    });
    // The receipt reads as the record's name, not "Record ·…".
    expect(body.sourceNames).toEqual({ [ids.vendor]: "Northline Panel Supply" });

    const opsPage = await H.call(OPERATOR, "GET", `/api/ops/runs/${ids.byChange}`);
    expect(j(opsPage.json).run.subject).toMatchObject({ kind: "change" });
    expect(j(opsPage.json).sourceNames).toEqual({ [ids.vendor]: "Northline Panel Supply" });
  });

  it("serves the subject in search on both sides", async () => {
    const portal = await H.call(admin("a"), "GET", "/api/search?q=Bill%20clerk");
    expect(portal.status, JSON.stringify(portal.json)).toBe(200);
    const hit = j(portal.json).runs.find((r: { id: string }) => r.id === ids.byDoc);
    expect(hit?.subject).toMatchObject({ kind: "document", vendor: "Northline Panel Supply" });
    const ops = await H.call(OPERATOR, "GET", "/api/ops/search?q=Bill%20clerk");
    expect(ops.status, JSON.stringify(ops.json)).toBe(200);
    const opsHit = j(ops.json).runs.find((r: { id: string }) => r.id === ids.byDoc);
    expect(opsHit?.subject).toMatchObject({ kind: "document", number: "20418" });
  });
});
