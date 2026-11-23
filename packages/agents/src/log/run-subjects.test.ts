// What each run was about, kept as it happens (docs/plan.md §1.188), against a real database as
// cs_worker: the document that started a run, and when a step finishes the records its output
// cites, what its tools' outputs name by their `about`, and each change it made. Kept once however
// often the step finishes, shown to the client only for a live run's visible step, and never
// another client's.

import { aboutOf, RunSubjectKind, RunSubjectRole, type ToolSpec } from "@countersign/core";
import {
  agent,
  document,
  externalAction,
  RUN_SUBJECT_KINDS,
  RUN_SUBJECT_ROLES,
  rawRecord,
  runSubject,
  stepRun,
  toolCall,
  transaction,
  vendor,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTemplate, fork, publish, updateOperational } from "../registry/agents";
import { docsRecordPurchase } from "../tools/docs";
import { type Client, createHarness, type Harness, makeBundle } from "./harness.test-helper";
import { createRun } from "./run-log";
import { keepSubjects, triggerSubjectIds, writeStepSubjectsTx } from "./run-subjects";

const harness = await createHarness();
afterAll(() => harness?.close());

const ABOUT_TOOL = "test.request.create";
const WRITE_TOOL = "test.bill.create";
const MONEY_TOOL = "test.quote.price";
const SPECS: Record<string, ToolSpec> = {
  [ABOUT_TOOL]: {
    id: ABOUT_TOOL,
    description: "Opens a request",
    input: {},
    output: {},
    sideEffect: "internal",
    verb: "create",
    source: "test",
    about: [
      { kind: "record", id: "request.id", label: "request.title", number: "request.ref" },
      { kind: "vendor", id: "vendorId" },
    ],
  },
  [WRITE_TOOL]: {
    id: WRITE_TOOL,
    description: "Creates a bill",
    input: {},
    output: {},
    sideEffect: "external",
    verb: "create",
    source: "testkit",
    connector: "testkit",
    entity: "bill",
    amount: { path: "total", currency: "USD" },
    display: {
      name: "Test bill",
      number: "input.docNumber",
      subject: "input.vendor",
      fields: [{ after: "input.total", label: "Total", kind: "money" }],
    },
  },
};
// Overnight S3.2: a write that names who it is with.
const WITH_TOOL = "test.bill.memo";
SPECS[WITH_TOOL] = {
  id: WITH_TOOL,
  description: "Notes a bill",
  input: {},
  output: {},
  sideEffect: "external",
  verb: "update",
  source: "testkit",
  connector: "testkit",
  entity: "bill",
  counterparty: { kind: "vendor", path: "before.vendor" },
};
SPECS[MONEY_TOOL] = {
  id: MONEY_TOOL,
  description: "Prices a quote",
  input: {},
  output: {},
  sideEffect: "none",
  verb: "read",
  source: "test",
  about: [
    { kind: "record", each: "quotes", label: "name", amount: { path: "total", currency: "USD" } },
  ],
};
const tools = (id: string) => SPECS[id];

describe("what started a run, from its trigger", () => {
  const raw = "55555555-5555-4555-8555-555555555555";
  it("is a message trigger's raw record when it came in from outside", () => {
    expect(
      triggerSubjectIds({
        type: "message",
        eventType: "inbound.message",
        payload: { channel: "whatsapp", rawRecordId: raw, messageId: null, documents: [] },
      }),
    ).toEqual({ messageId: raw });
  });
  it("is never another event's raw record (a synced bill is no message)", () => {
    expect(
      triggerSubjectIds({
        type: "event",
        eventType: "record.synced",
        payload: { rawRecordId: raw },
      }),
    ).toEqual({});
  });
});

describe("Save to records' purchase", () => {
  it("names no purchase it couldn't pick, only its vendor", () => {
    const vendorId = "66666666-6666-4666-8666-666666666666";
    const named = aboutOf(docsRecordPurchase.spec, {
      status: "ambiguous",
      transactionId: null,
      vendorId,
      vendorName: "Acme Supply",
    });
    expect(named).toEqual([
      expect.objectContaining({ kind: "vendor", recordId: vendorId, label: "Acme Supply" }),
    ]);
  });
});

describe("the kinds and roles core and the table share", () => {
  it("are the same list", () => {
    expect([...RunSubjectKind.options]).toEqual([...RUN_SUBJECT_KINDS]);
    expect([...RunSubjectRole.options]).toEqual([...RUN_SUBJECT_ROLES]);
  });
});

describe.skipIf(!harness)("what a run was about", () => {
  const h = harness as Harness;
  let agentId = "";
  const ids = {} as Record<"doc" | "vendor" | "txn" | "request", string>;

  beforeAll(async () => {
    const tv = await h.ops(async (tx) => {
      const { agent: tpl, version } = await createTemplate(tx, {
        slug: "subjects",
        bundle: makeBundle(),
      });
      return publish(tx, { agentId: tpl.id, versionId: version.id, ctx: h.ctx });
    });
    agentId = await h.ops(async (tx) => {
      const forked = await fork(tx, {
        tenantId: h.A.tenantId,
        slug: "subjects",
        templateVersionId: tv.id,
      });
      await updateOperational(tx, {
        agentId: forked.agent.id,
        patch: { bindings: { testkit: h.A.connectionId } },
      });
      await publish(tx, { agentId: forked.agent.id, versionId: forked.version.id, ctx: h.ctx });
      await tx
        .update(agent)
        .set({ runStatus: "active", stage: "live" })
        .where(eq(agent.id, forked.agent.id));
      return forked.agent.id;
    });
    await h.client(h.A, async (tx) => {
      const [d] = await tx
        .insert(document)
        .values({
          tenantId: h.A.tenantId,
          source: "upload",
          storageKey: "k/invoice-4471.pdf",
          mimeType: "application/pdf",
          filename: "invoice-4471.pdf",
          sizeBytes: 100,
          sha256: "a".repeat(64),
        })
        .returning({ id: document.id });
      const [v] = await tx
        .insert(vendor)
        .values({ tenantId: h.A.tenantId, name: "Acme Supply", normalizedName: "acme supply" })
        .returning({ id: vendor.id });
      if (!d || !v) throw new Error("no fixtures");
      const [t] = await tx
        .insert(transaction)
        .values({
          tenantId: h.A.tenantId,
          kind: "bill",
          connector: "qbo",
          vendorId: v.id,
          total: "120.5000",
          currency: "USD",
          externalId: "bill-77",
          ext: { qbo: { docNumber: "4471" } },
        })
        .returning({ id: transaction.id });
      if (!t) throw new Error("no transaction");
      ids.doc = d.id;
      ids.vendor = v.id;
      ids.txn = t.id;
    });
    ids.request = "33333333-3333-4333-8333-333333333333";
  });

  const rowsOf = (c: Client, runId: string) =>
    h.client(c, (tx) =>
      tx
        .select()
        .from(runSubject)
        .where(and(eq(runSubject.tenantId, c.tenantId), eq(runSubject.runId, runId)))
        .orderBy(runSubject.createdAt, runSubject.id),
    );

  async function startedRun(mode: "live" | "test", trigger: Record<string, unknown> = {}) {
    const r = await h.client(h.A, (tx) =>
      createRun(tx, {
        tenantId: h.A.tenantId,
        agentId,
        workflowSlug: "check-record",
        mode,
        trigger,
      }),
    );
    const stepRunId = await h.deps().ports.log.startStepRun(h.A.tenantId, {
      runId: r.id,
      nodeId: "s1",
      nodeType: "action",
      skillRef: null,
      agentVersionId: r.agentVersionId,
      input: {},
    });
    return { runId: r.id, stepRunId };
  }

  it("keeps the document that started a run, by its file, with no step", async () => {
    const { runId } = await startedRun("live", {
      type: "event",
      eventType: "document.received",
      payload: { documentId: ids.doc },
    });
    const rows = await rowsOf(h.A, runId);
    expect(rows).toEqual([
      expect.objectContaining({
        stepRunId: null,
        kind: "document",
        role: "read",
        recordId: ids.doc,
        label: "invoice-4471.pdf",
        clientVisible: true,
      }),
    ]);
    // Another client sees none of it.
    expect(await rowsOf(h.B, runId)).toEqual([]);
  });

  it("keeps a finished step's sources, its tools' about and its changes, once", async () => {
    const { runId, stepRunId } = await startedRun("live");
    const unknown = "44444444-4444-4444-8444-444444444444";
    await h.client(h.A, async (tx) => {
      await tx
        .update(stepRun)
        .set({
          status: "succeeded",
          output: { sources: [ids.txn, ids.vendor, unknown, "R-1a2b3c", 7] },
        })
        .where(eq(stepRun.id, stepRunId));
      await tx.insert(toolCall).values([
        {
          tenantId: h.A.tenantId,
          stepRunId,
          tool: ABOUT_TOOL,
          status: "succeeded",
          output: {
            request: { id: ids.request, title: "Studs for\nlot 12", ref: "PR-1032" },
            vendorId: ids.vendor,
          },
        },
        // A call that failed names nothing.
        {
          tenantId: h.A.tenantId,
          stepRunId,
          tool: ABOUT_TOOL,
          status: "failed",
          output: { request: { id: unknown, title: "Never opened" } },
        },
      ]);
      await tx.insert(externalAction).values([
        {
          tenantId: h.A.tenantId,
          connectionId: h.A.connectionId,
          tool: WRITE_TOOL,
          runId,
          stepRunId,
          input: { docNumber: "4471", vendor: "Acme Supply", total: "99.10" },
          // The signer's edit is what was written.
          editedInput: { docNumber: "4471", vendor: "Acme Supply", total: "120.50" },
          editedBy: h.A.adminId,
          editedAt: new Date(),
          idempotencyKey: `${runId}:w1`,
          status: "done",
          result: { id: "bill-77" },
        },
        // A change still waiting changed nothing.
        {
          tenantId: h.A.tenantId,
          connectionId: h.A.connectionId,
          tool: WRITE_TOOL,
          runId,
          stepRunId,
          input: { docNumber: "9999", vendor: "Someone", total: "1" },
          idempotencyKey: `${runId}:w2`,
          status: "proposed",
        },
      ]);
    });
    const write = () =>
      h.client(h.A, (tx) =>
        writeStepSubjectsTx(tx, {
          tenantId: h.A.tenantId,
          stepRunId,
          tools,
          visible: (nodeId) => nodeId === "s1",
        }),
      );
    expect(await write()).toBe(6);
    // A step that finishes again (a retry, a wait) keeps nothing twice.
    expect(await write()).toBe(0);

    const rows = await rowsOf(h.A, runId);
    const pick = (role: string, kind: string) =>
      rows.filter((r) => r.role === role && r.kind === kind);
    expect(pick("decided", "transaction")).toEqual([
      expect.objectContaining({
        recordId: ids.txn,
        connector: "qbo",
        externalId: "bill-77",
        label: "Acme Supply",
        number: "4471",
        amount: "120.5000",
        currency: "USD",
      }),
    ]);
    expect(pick("decided", "vendor")).toEqual([
      expect.objectContaining({ recordId: ids.vendor, label: "Acme Supply" }),
    ]);
    expect(pick("decided", "record")).toEqual([
      expect.objectContaining({ recordId: unknown, label: null }),
    ]);
    expect(pick("changed", "record")).toEqual([
      expect.objectContaining({
        recordId: ids.request,
        label: "Studs for lot 12",
        number: "PR-1032",
      }),
    ]);
    // Named by id alone: its name is read from our vendor.
    expect(pick("changed", "vendor")).toEqual([
      expect.objectContaining({ recordId: ids.vendor, label: "Acme Supply" }),
    ]);
    expect(pick("changed", "transaction")).toEqual([
      expect.objectContaining({
        recordId: null,
        connector: "testkit",
        externalId: "bill-77",
        label: "Acme Supply",
        number: "4471",
        amount: "120.5000",
        currency: "USD",
      }),
    ]);
    expect(rows.every((r) => r.stepRunId === stepRunId && r.clientVisible)).toBe(true);
  });

  it("keeps who a change is with as a second subject, by its tool's id (overnight S3.2)", async () => {
    const { runId, stepRunId } = await startedRun("live");
    await h.client(h.A, async (tx) => {
      await tx.update(stepRun).set({ status: "succeeded" }).where(eq(stepRun.id, stepRunId));
      await tx.insert(externalAction).values([
        {
          tenantId: h.A.tenantId,
          connectionId: h.A.connectionId,
          tool: WITH_TOOL,
          runId,
          stepRunId,
          input: { id: "88", memo: "Released" },
          before: { id: "88", docNumber: "4472", vendor: { id: "56", name: "Acme\nSupply" } },
          idempotencyKey: `${runId}:m1`,
          status: "done",
          result: { id: "88" },
        },
        // A change whose record names no vendor keeps only itself.
        {
          tenantId: h.A.tenantId,
          connectionId: h.A.connectionId,
          tool: WITH_TOOL,
          runId,
          stepRunId,
          input: { id: "89", memo: "Released" },
          before: { id: "89", docNumber: "4473", vendor: null },
          idempotencyKey: `${runId}:m2`,
          status: "done",
          result: { id: "89" },
        },
      ]);
    });
    const write = () =>
      h.client(h.A, (tx) =>
        writeStepSubjectsTx(tx, { tenantId: h.A.tenantId, stepRunId, tools, visible: () => true }),
      );
    expect(await write()).toBe(3);
    expect(await write()).toBe(0);
    const rows = await rowsOf(h.A, runId);
    expect(rows.filter((r) => r.kind === "vendor")).toEqual([
      expect.objectContaining({
        role: "read",
        recordId: null,
        connector: "testkit",
        externalId: "56",
        label: "Acme Supply",
        stepRunId,
      }),
    ]);
    expect(rows.filter((r) => r.role === "changed").map((r) => r.externalId)).toEqual(["88", "89"]);
  });

  it("keeps a hidden step's and a test run's rows from the client", async () => {
    for (const [mode, visible] of [
      ["live", false],
      ["test", true],
    ] as const) {
      const { runId, stepRunId } = await startedRun(mode);
      await h.client(h.A, async (tx) => {
        await tx
          .update(stepRun)
          .set({ status: "succeeded", output: { sources: [ids.vendor] } })
          .where(eq(stepRun.id, stepRunId));
        await writeStepSubjectsTx(tx, {
          tenantId: h.A.tenantId,
          stepRunId,
          tools,
          visible: () => visible,
        });
      });
      const rows = await rowsOf(h.A, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.clientVisible).toBe(false);
    }
  });

  it("writes nothing for another client's step", async () => {
    const { stepRunId } = await startedRun("live");
    const n = await h.client(h.B, (tx) =>
      writeStepSubjectsTx(tx, { tenantId: h.B.tenantId, stepRunId, tools, visible: () => true }),
    );
    expect(n).toBe(0);
  });

  it("keeps an inbound message by its raw record: its tool and id, never its words", async () => {
    const raw = await h.client(h.A, async (tx) => {
      const [r] = await tx
        .insert(rawRecord)
        .values({
          tenantId: h.A.tenantId,
          connectionId: h.A.connectionId,
          connector: "testkit",
          // Read as a message by its entity, and its payload's name still stays out.
          entityType: "inbound_email",
          externalId: "wamid.1",
          payload: { Name: "Need 40 studs for lot 12" },
        })
        .returning({ id: rawRecord.id });
      if (!r) throw new Error("no raw record");
      return r.id;
    });
    const { runId } = await startedRun("live", {
      type: "message",
      eventType: "inbound.message",
      channel: "whatsapp",
      payload: { channel: "whatsapp", rawRecordId: raw, messageId: null, documents: [] },
    });
    expect(await rowsOf(h.A, runId)).toEqual([
      expect.objectContaining({
        stepRunId: null,
        kind: "message",
        role: "read",
        recordId: raw,
        connector: "testkit",
        externalId: "wamid.1",
        label: null,
        number: null,
        clientVisible: true,
      }),
    ]);
  });

  it("leaves off an amount that rounds past what numeric(14,4) holds", async () => {
    const { runId, stepRunId } = await startedRun("live");
    await h.client(h.A, async (tx) => {
      await tx
        .update(stepRun)
        .set({ status: "succeeded", output: {} })
        .where(eq(stepRun.id, stepRunId));
      await tx.insert(toolCall).values({
        tenantId: h.A.tenantId,
        stepRunId,
        tool: MONEY_TOOL,
        status: "succeeded",
        output: {
          quotes: [
            { name: "Too big", total: "9999999999.99995" },
            { name: "Fits", total: "12.345678" },
          ],
        },
      });
    });
    const n = await h.client(h.A, (tx) =>
      writeStepSubjectsTx(tx, { tenantId: h.A.tenantId, stepRunId, tools, visible: () => true }),
    );
    expect(n).toBe(2);
    const rows = await rowsOf(h.A, runId);
    expect(rows.map((r) => [r.label, r.amount, r.currency])).toEqual(
      expect.arrayContaining([
        ["Too big", null, null],
        ["Fits", "12.3457", "USD"],
      ]),
    );
  });

  it("undoes only its own savepoint when a write fails", async () => {
    const { runId } = await startedRun("live");
    const errors: unknown[] = [];
    await h.client(h.A, async (tx) => {
      const n = await keepSubjects(
        tx,
        async (sp) => {
          await sp.insert(runSubject).values({
            tenantId: h.A.tenantId,
            runId,
            kind: "vendor",
            role: "read",
            label: "kept, then undone",
          });
          throw new Error("boom");
        },
        (e) => errors.push(e),
      );
      expect(n).toBe(0);
      // The transaction goes on.
      await tx.update(stepRun).set({ summary: "still here" }).where(eq(stepRun.runId, runId));
    });
    expect(errors).toHaveLength(1);
    expect(await rowsOf(h.A, runId)).toEqual([]);
  });
});
