// What each run was about, kept as it happens (docs/plan.md §1.188), through apps/api: which step
// rows the client's timeline shows, the executor's step log keeping a finished step's subjects,
// the run's subject read from what it kept first (only the client's rows on the portal), and the
// backfill of the last 90 days, which picks each run once.

import { createHash } from "node:crypto";
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import {
  agent,
  agentVersion,
  document,
  externalAction,
  run,
  runSubject,
  stepRun,
  vendor,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiHarness, testBundle } from "./api.test-helper";
import type { Platform } from "./platform";
import { dbStepLog } from "./runs/ports";
import { runSubjects } from "./runs/subject";
import {
  backfillClientRunSubjects,
  clientShowsNode,
  RUN_SUBJECT_BACKFILL_MINUTE,
  runSubjectBackfillTick,
  subjectTools,
} from "./runs/subject-log";

const h = await createApiHarness();
afterAll(() => h?.close());

const workflow = testBundle("Bill clerk").workflows[0]?.workflow;

describe("the step rows the client's timeline shows", () => {
  it("are its visible steps, never a check's row or a step it doesn't know", () => {
    const shows = clientShowsNode(workflow);
    expect(shows("update")).toBe(true);
    expect(shows("confirm")).toBe(true);
    expect(shows("internal")).toBe(false);
    expect(shows("update:confer:1")).toBe(false);
    expect(shows("nobody")).toBe(false);
    expect(clientShowsNode(undefined)("update")).toBe(false);
  });
});

describe.skipIf(!h)("what a run was about, through the API", () => {
  const H = h as NonNullable<typeof h>;
  const owner = H.t.db;
  const A = () => H.A.tenantId;
  const ids = {} as Record<"agent" | "version" | "doc" | "vendor", string>;

  beforeAll(async () => {
    const [a] = await owner
      .insert(agent)
      .values({
        tenantId: A(),
        kind: "client",
        slug: "subject-log",
        name: "Bill clerk",
        runStatus: "active",
        stage: "live",
      })
      .returning();
    if (!a) throw new Error("no agent");
    ids.agent = a.id;
    const [v] = await owner
      .insert(agentVersion)
      .values({
        tenantId: A(),
        agentId: a.id,
        version: 1,
        bundle: testBundle("Bill clerk"),
        bundleHash: "hash-subject-log",
        status: "live",
        authorType: "operator",
      })
      .returning();
    if (!v) throw new Error("no version");
    ids.version = v.id;
    const [d] = await owner
      .insert(document)
      .values({
        tenantId: A(),
        source: "upload",
        storageKey: "tenants/a/acme-4471.pdf",
        mimeType: "application/pdf",
        filename: "acme-4471.pdf",
        sizeBytes: 10,
        sha256: createHash("sha256").update("acme-4471").digest("hex"),
      })
      .returning();
    const [ven] = await owner
      .insert(vendor)
      .values({ tenantId: A(), name: "Acme Supply", normalizedName: "acme supply" })
      .returning();
    if (!d || !ven) throw new Error("no fixtures");
    ids.doc = d.id;
    ids.vendor = ven.id;
  });

  const addRun = async (
    o: { status?: "running" | "succeeded"; trigger?: Record<string, unknown>; at?: Date } = {},
  ) => {
    const [r] = await owner
      .insert(run)
      .values({
        tenantId: A(),
        agentId: ids.agent,
        agentVersionId: ids.version,
        workflowSlug: "fix-record",
        mode: "live",
        status: o.status ?? "succeeded",
        trigger: o.trigger ?? { type: "manual" },
        startedAt: o.at ?? new Date(),
        ...(o.at ? { createdAt: o.at } : {}),
      })
      .returning();
    if (!r) throw new Error("no run");
    return r;
  };
  const addStep = async (runId: string, nodeId: string, output: Record<string, unknown>) => {
    const [s] = await owner
      .insert(stepRun)
      .values({
        tenantId: A(),
        runId,
        nodeId,
        nodeType: "action",
        status: "succeeded",
        output,
        startedAt: new Date(),
      })
      .returning();
    if (!s) throw new Error("no step");
    return s.id;
  };
  const kept = (runId: string) =>
    owner
      .select()
      .from(runSubject)
      .where(and(eq(runSubject.tenantId, A()), eq(runSubject.runId, runId)))
      .orderBy(runSubject.createdAt, runSubject.id);

  it("keeps a step's subjects when the executor's step log finishes it, not while it runs", async () => {
    const r = await addRun({ status: "running" });
    const log = dbStepLog(
      H.db,
      {
        id: r.id,
        tenantId: A(),
        agentId: ids.agent,
        agentVersionId: ids.version,
        workflowSlug: "fix-record",
        mode: "live",
      },
      { tools: subjectTools(H.platform), visible: clientShowsNode(workflow) },
    );
    const shown = await log.start({ runId: r.id, nodeId: "update", nodeType: "action" });
    await log.update(shown, { status: "running", output: { sources: [ids.vendor] } });
    expect(await kept(r.id)).toEqual([]);
    await log.update(shown, { status: "succeeded", output: { sources: [ids.vendor] } });
    const hidden = await log.start({ runId: r.id, nodeId: "internal", nodeType: "notify" });
    await log.update(hidden, { status: "succeeded", output: { sources: [ids.vendor] } });
    const rows = await kept(r.id);
    expect(rows.map((x) => [x.stepRunId, x.kind, x.role, x.label, x.clientVisible])).toEqual([
      [shown, "vendor", "decided", "Acme Supply", true],
      [hidden, "vendor", "decided", "Acme Supply", false],
    ]);
  });

  it("titles a run by what it kept, and the portal by the client's rows only", async () => {
    const r = await addRun();
    const shown = await addStep(r.id, "update", {});
    const hidden = await addStep(r.id, "internal", {});
    await owner.insert(runSubject).values([
      {
        tenantId: A(),
        runId: r.id,
        stepRunId: hidden,
        kind: "record",
        role: "changed",
        label: "Internal note",
        clientVisible: false,
      },
      {
        tenantId: A(),
        runId: r.id,
        stepRunId: shown,
        kind: "vendor",
        role: "decided",
        label: "Acme Supply",
        number: "PR-1032",
        clientVisible: true,
      },
    ]);
    // The document that started a run, kept with no step, though its trigger names none.
    const byDoc = await addRun();
    await owner.insert(runSubject).values({
      tenantId: A(),
      runId: byDoc.id,
      kind: "document",
      role: "read",
      recordId: ids.doc,
      label: "acme-4471.pdf",
      clientVisible: true,
    });
    const ops = await owner.transaction((tx) => runSubjects(tx, [A()], [r, byDoc], H.platform));
    expect(ops.get(r.id)).toEqual({
      kind: "record",
      of: "record",
      label: "Internal note",
      number: null,
    });
    expect(ops.get(byDoc.id)).toEqual({
      kind: "document",
      vendor: null,
      number: null,
      filename: "acme-4471.pdf",
    });
    const portal = await owner.transaction((tx) =>
      runSubjects(tx, [A()], [r], H.platform, { surface: "portal" }),
    );
    expect(portal.get(r.id)).toEqual({
      kind: "record",
      of: "vendor",
      label: "Acme Supply",
      number: "PR-1032",
    });
  });

  it("backfills each finished run of the last 90 days once, from its trigger, changes and sources", async () => {
    const old = await addRun({
      trigger: { type: "event", payload: { documentId: ids.doc } },
      at: new Date(Date.now() - 100 * 86_400_000),
    });
    const open = await addRun({
      status: "running",
      trigger: { type: "event", payload: { documentId: ids.doc } },
    });
    const nothing = await addRun();
    await addStep(nothing.id, "update", { sources: ["R-1a2b3c"] });
    const r = await addRun({ trigger: { type: "event", payload: { documentId: ids.doc } } });
    const step = await addStep(r.id, "update", { sources: [ids.vendor] });
    await owner.insert(externalAction).values({
      tenantId: A(),
      connectionId: H.A.connectionId,
      tool: TESTKIT_UPDATE_TOOL,
      runId: r.id,
      stepRunId: step,
      idempotencyKey: `${r.id}:update:0`,
      input: { id: "r1", amount: "12.00" },
      status: "done",
      result: { id: "r1" },
    });

    // A message from outside started this one: its raw record is the message (kept by its id
    // even when no raw record holds it any more).
    const rawId = "77777777-7777-4777-8777-777777777777";
    const inbound = await addRun({
      trigger: {
        type: "message",
        eventType: "inbound.message",
        payload: { channel: "email", rawRecordId: rawId, messageId: null, documents: [] },
      },
    });

    const looked = await backfillClientRunSubjects(H.db, H.platform, A(), { now: new Date() });
    expect(looked).toBeGreaterThanOrEqual(1);
    const rows = await kept(r.id);
    expect(rows.map((x) => [x.stepRunId === null, x.kind, x.role, x.clientVisible])).toEqual(
      expect.arrayContaining([
        [true, "document", "read", true],
        [false, "vendor", "decided", true],
        [false, expect.any(String), "changed", true],
      ]),
    );
    expect(rows.find((x) => x.role === "changed")).toMatchObject({
      connector: "testkit",
      externalId: "r1",
    });
    expect(await kept(inbound.id)).toEqual([
      expect.objectContaining({ stepRunId: null, kind: "message", recordId: rawId }),
    ]);
    expect(await kept(old.id)).toEqual([]);
    expect(await kept(open.id)).toEqual([]);
    expect(await kept(nothing.id)).toEqual([]);
    // Done once: the next pass picks nothing, and the tick runs only at its minute.
    expect(await backfillClientRunSubjects(H.db, H.platform, A(), { now: new Date() })).toBe(0);
    const at = new Date();
    at.setUTCMinutes(RUN_SUBJECT_BACKFILL_MINUTE);
    await runSubjectBackfillTick(H.db, H.platform, at);
    expect(await kept(r.id)).toHaveLength(rows.length);
  });

  // Overnight S3.2: runs kept before writes named who they were with get that row, once.
  it("backfills the counterparty of a change kept before writes named one, once", async () => {
    // The testkit write, as if it named the vendor of the record it changes.
    const named = (t: ReturnType<Platform["tools"]["get"]>) =>
      t && t.spec.id === TESTKIT_UPDATE_TOOL
        ? {
            ...t,
            spec: { ...t.spec, counterparty: { kind: "vendor" as const, path: "before.vendor" } },
          }
        : t;
    const platform = {
      tools: {
        get: (id: string) => named(H.platform.tools.get(id)),
        list: () => H.platform.tools.list().map((t) => named(t) ?? t),
      },
    } as unknown as Pick<Platform, "tools">;
    const r = await addRun();
    const step = await addStep(r.id, "update", {});
    await owner.insert(externalAction).values({
      tenantId: A(),
      connectionId: H.A.connectionId,
      tool: TESTKIT_UPDATE_TOOL,
      runId: r.id,
      stepRunId: step,
      idempotencyKey: `${r.id}:update:0`,
      input: { id: "r2", amount: "14.00" },
      before: { id: "r2", vendor: { id: "56", name: "Acme Supply" } },
      status: "done",
      result: { id: "r2" },
    });
    // Kept before the tool named its counterparty: the change only.
    await backfillClientRunSubjects(H.db, H.platform, A(), { now: new Date() });
    expect((await kept(r.id)).map((x) => x.role)).toEqual(["changed"]);
    expect(await backfillClientRunSubjects(H.db, H.platform, A(), { now: new Date() })).toBe(0);

    // Now it does: the run is picked again for the row it lacks, and only once.
    expect(await backfillClientRunSubjects(H.db, platform, A(), { now: new Date() })).toBe(1);
    expect((await kept(r.id)).map((x) => [x.kind, x.role, x.connector, x.externalId])).toEqual([
      [expect.any(String), "changed", "testkit", "r2"],
      ["vendor", "read", "testkit", "56"],
    ]);
    expect(await backfillClientRunSubjects(H.db, platform, A(), { now: new Date() })).toBe(0);
  });
});
