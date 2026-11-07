// Test-run payloads and the Sandbox's uploads (docs/plan.md §1.16 "Test-run payloads"): the operator
// uploads documents to the Sandbox client from the back office as the portal does (403 not_sandbox
// in a real client); a byte-identical file again is the same document, read once, with no event;
// a client's recent events of one type, newest first, labelled, only that client's and never a
// test run's.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_USER_HEADER } from "@countersign/auth";
import { docExtraction, document, event, membership, tenant } from "@countersign/db";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const FIXTURES = resolve(DEFAULT_FIXTURE_DIR, "..");
const NORTHLINE = readFileSync(resolve(FIXTURES, "invoices", "northline-20418.pdf"));
const EXPECTED = JSON.parse(
  readFileSync(resolve(FIXTURES, "invoices", "northline-20418.expected.json"), "utf8"),
);

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("test-run payloads and Sandbox uploads", () => {
  const H = h as ApiHarness;
  let sandbox = "";
  let documentId = "";
  const pending: Promise<unknown>[] = [];
  const settle = async () => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };

  async function upload(email: string | null, clientId: string, files: File[]) {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    const res = await H.app.request(
      `/api/ops/clients/${clientId}/uploads`,
      { method: "POST", headers: email ? { [DEV_USER_HEADER]: email } : {}, body: form },
      H.env,
      {
        waitUntil: (p: Promise<unknown>) => void pending.push(p),
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );
    return { status: res.status, json: j(await res.json()) };
  }
  const northline = (name = "northline-20418.pdf") =>
    new File([NORTHLINE], name, { type: "application/pdf" });
  const recent = (email: string, clientId: string, type: string, limit?: number) =>
    H.call(
      email,
      "GET",
      `/api/ops/clients/${clientId}/events?type=${encodeURIComponent(type)}${limit ? `&limit=${limit}` : ""}`,
    );
  const eventsOf = (tenantId: string) =>
    H.t.db.select().from(event).where(eq(event.tenantId, tenantId));

  beforeAll(async () => {
    const [row] = await H.t.db
      .insert(tenant)
      .values({ name: "Sandbox", settings: { sandbox: true, connectors_offered: ["testkit"] } })
      .returning();
    if (!row) throw new Error("no sandbox");
    sandbox = row.id;
    await H.t.db
      .insert(membership)
      .values({ tenantId: sandbox, userId: H.operator, role: "operator" });
  });

  it("uploads to the Sandbox from the back office as the portal does, and reads the document", async () => {
    const res = await upload(OPERATOR, sandbox, [northline()]);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.results).toHaveLength(1);
    expect(res.json.results[0]).toMatchObject({ kind: "document", created: true, error: null });
    documentId = res.json.results[0].document.id;
    await settle();
    const [doc] = await H.t.db.select().from(document).where(eq(document.id, documentId));
    expect(doc).toMatchObject({ tenantId: sandbox, source: "upload", status: "extracted" });
    expect(doc?.meta).toEqual({ uploadedBy: H.operator });
    expect((await eventsOf(sandbox)).map((e) => e.type).sort()).toEqual([
      "document.extracted",
      "document.received",
    ]);
    // The back office's documents page knows it is the Sandbox, and lists the document.
    const list = await H.call(OPERATOR, "GET", `/api/ops/clients/${sandbox}/documents`);
    expect(j(list.json)).toMatchObject({ sandbox: true, documents: [{ id: documentId }] });
    const real = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/documents`);
    expect(j(real.json).sandbox).toBe(false);
  });

  it("stores a byte-identical file once: the same document, not read again, no event", async () => {
    const before = {
      events: (await eventsOf(sandbox)).length,
      extractions: (
        await H.t.db.select().from(docExtraction).where(eq(docExtraction.tenantId, sandbox))
      ).length,
    };
    const res = await upload(OPERATOR, sandbox, [northline("same-bytes-new-name.pdf")]);
    expect(res.status).toBe(200);
    expect(res.json.results[0]).toMatchObject({ kind: "document", created: false });
    expect(res.json.results[0].document.id).toBe(documentId);
    await settle();
    expect((await eventsOf(sandbox)).length).toBe(before.events);
    expect(
      (await H.t.db.select().from(docExtraction).where(eq(docExtraction.tenantId, sandbox))).length,
    ).toBe(before.extractions);
    expect(await H.t.db.$count(document, and(eq(document.tenantId, sandbox)))).toBe(1);
  });

  it("refuses uploads to a real client (403 not_sandbox), to client roles and to no session", async () => {
    const real = await upload(OPERATOR, H.A.tenantId, [northline()]);
    expect(real.status).toBe(403);
    expect(real.json.error.code).toBe("not_sandbox");
    // A client the operator does not serve is not found.
    expect((await upload(OPERATOR, H.C.tenantId, [northline()])).status).toBe(404);
    expect((await upload(OTHER_OPERATOR, sandbox, [northline()])).status).toBe(404);
    for (const who of [admin("a"), user("a")]) {
      expect((await upload(who, sandbox, [northline()])).status, who).toBe(403);
      expect((await upload(who, H.A.tenantId, [northline()])).status, who).toBe(403);
    }
    expect((await upload(null, sandbox, [northline()])).status).toBe(401);
    // Nothing reached client A.
    expect(await H.t.db.$count(document, eq(document.tenantId, H.A.tenantId))).toBe(0);
  });

  it("lists the client's recent events of a type with the document's name, vendor and total", async () => {
    const res = await recent(OPERATOR, sandbox, "document.extracted");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const events = j(res.json).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "document.extracted",
      label: "northline-20418.pdf",
      vendorName: EXPECTED.header.vendorName,
      total: { currency: "USD" },
      payload: { documentId, lineCount: EXPECTED.lines.length, totalsValid: true },
    });
    expect(Number(events[0].total.amount)).toBe(Number(EXPECTED.total));
    const received = j((await recent(OPERATOR, sandbox, "document.received")).json).events;
    expect(received.map((e: { label: string }) => e.label)).toEqual(["northline-20418.pdf"]);
    expect(j((await recent(OPERATOR, sandbox, "transaction.created")).json).events).toEqual([]);
  });

  it("answers only the client asked about, newest first, and never a test run's events", async () => {
    // Client A has events of its own; the Sandbox's list never shows them, nor A's the Sandbox's.
    await H.t.db.insert(event).values({
      tenantId: H.A.tenantId,
      type: "document.extracted",
      payload: {
        documentId: crypto.randomUUID(),
        extractionId: crypto.randomUUID(),
        lineCount: 1,
        totalsValid: false,
      },
    });
    const inA = j((await recent(OPERATOR, H.A.tenantId, "document.extracted")).json).events;
    expect(inA).toHaveLength(1);
    expect(inA[0].payload.documentId).not.toBe(documentId);
    const inSandbox = j((await recent(OPERATOR, sandbox, "document.extracted")).json).events;
    expect(inSandbox.map((e: { payload: { documentId: string } }) => e.payload.documentId)).toEqual(
      [documentId],
    );

    // A test run in the Sandbox emits nothing, and an event that names a test run is left out.
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "payload-clerk",
      bundle: testBundle(),
    });
    expect(tpl.status, JSON.stringify(tpl.json)).toBe(200);
    const before = (await eventsOf(sandbox)).length;
    const started = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${j(tpl.json).agent.id}/versions/${j(tpl.json).version.id}/test-run`,
      { workflow: "fix-record" },
    );
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    const testRunId = j(started.json).runId as string;
    expect((await eventsOf(sandbox)).length).toBe(before);
    const resolved = (runId: string | null, minutesAgo: number) => ({
      tenantId: sandbox,
      type: "inbox.resolved",
      payload: {
        inboxItemId: crypto.randomUUID(),
        kind: "approval",
        runId,
        approved: true,
        resolvedBy: null,
      },
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
    });
    await H.t.db.insert(event).values([resolved(testRunId, 1), resolved(null, 2)]);
    const live = j((await recent(OPERATOR, sandbox, "inbox.resolved")).json).events;
    expect(live).toHaveLength(1);
    expect(live[0].payload.runId).toBeNull();
    expect(live[0].label).toBe("kind: approval · approved: true");

    // Newest first, ten by default, more on request.
    await H.t.db.insert(event).values(
      Array.from({ length: 12 }, (_, i) => ({
        tenantId: sandbox,
        type: "schedule.tick",
        payload: { scheduledAt: new Date(Date.UTC(2026, 10, 1, i)).toISOString() },
        createdAt: new Date(Date.UTC(2026, 10, 1, i)),
      })),
    );
    const ticks = j((await recent(OPERATOR, sandbox, "schedule.tick")).json).events;
    expect(ticks).toHaveLength(10);
    expect(ticks[0].payload.scheduledAt).toBe("2026-11-01T11:00:00.000Z");
    expect(ticks[9].payload.scheduledAt).toBe("2026-11-01T02:00:00.000Z");
    expect(ticks[0].label).toBe("scheduledAt: 2026-11-01T11:00:00.000Z");
    expect(j((await recent(OPERATOR, sandbox, "schedule.tick", 50)).json).events).toHaveLength(12);
  });

  it("refuses the events of a client not served, and to client roles", async () => {
    expect((await recent(OPERATOR, H.C.tenantId, "document.extracted")).status).toBe(404);
    expect((await recent(OTHER_OPERATOR, sandbox, "document.extracted")).status).toBe(404);
    for (const who of [admin("a"), user("a")]) {
      expect((await recent(who, H.A.tenantId, "document.extracted")).status, who).toBe(403);
    }
    expect((await H.call(OPERATOR, "GET", `/api/ops/clients/${sandbox}/events`)).status).toBe(400);
  });
});
