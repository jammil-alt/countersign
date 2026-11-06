// Exports (docs/plan.md §1.35 "Exports"): the client data export (start, the job, the list and its
// link), the accountant export and the client's audit log. Checks who may ask, that each export is
// a valid ZIP or CSV, that nothing forbidden is in it (secrets, agent bundles, instructions and
// prompts, cost, operator-only rows, test runs, another client's data), the size cap, that each is
// audited, and the 30 days after retirement.

import {
  agent,
  agentVersion,
  auditEvent,
  connection,
  document,
  externalAction,
  inboxItem,
  memoryNote,
  message,
  run,
  stepRun,
  TENANT_TABLES,
  tenant,
  tenantChange,
  tenantKey,
  thread,
  toolCall,
  transaction,
  vendor,
} from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { purgeRetiredFiles } from "./compliance/retention";
import { runClientExport } from "./exports/client-data";
import { documentPath } from "./exports/csv";
import { MemoryExportJobs } from "./exports/instances";
import { bufferedExportStorage, readManifest } from "./exports/store";
import { csvRecords, readZip, text } from "./exports/zip.test-helper";

const SECRET = "sk-live-SECRET-sentinel-7f3a";
const PROMPT = "PROMPT-sentinel: change records only when asked";
const MEMORY = "MEMORY-sentinel";
const OPERATOR_NOTE = "OPERATOR-NOTE-sentinel";
const OPERATOR_ITEM = "OPERATOR-ITEM-sentinel";
const MODEL_TEXT = "MODEL-OUTPUT-sentinel";
const B_VENDOR = "B-VENDOR-sentinel";
const B_FILE = "%PDF-B-sentinel";
const COST = "7.6543";

const jobs = new MemoryExportJobs();
const h = await createApiHarness({ exports: jobs });
afterAll(() => h?.close());

/** The Workflow's step, as the export job takes it. */
const asStep = (fake: FakeWorkflowStep) => ({
  do: <T>(name: string, fn: () => Promise<T>) => fake.do(name, fn) as Promise<T>,
});

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!h)("exports", () => {
  const harness = h as NonNullable<typeof h>;
  const call = harness.call.bind(harness);
  const db = harness.t.db;
  const { A, B, C } = harness;
  const seeded = {
    docA: "",
    actionA: "",
    runA: "",
    testRunA: "",
    bIds: [] as string[],
  };

  /** A request whose body is bytes (a ZIP or CSV), not JSON. */
  async function download(
    email: string | null,
    path: string,
    headers: Record<string, string> = {},
  ) {
    const res = await harness.app.request(
      path,
      { headers: { ...(email ? { "x-countersign-dev-user": email } : {}), ...headers } },
      harness.env,
    );
    return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
  }

  /** Everything forbidden that the seed planted, and every id of client B. */
  function expectClean(content: string) {
    for (const needle of [
      SECRET,
      PROMPT,
      "Change records only when asked",
      MEMORY,
      OPERATOR_NOTE,
      OPERATOR_ITEM,
      MODEL_TEXT,
      COST,
      B_VENDOR,
      B_FILE,
      seeded.testRunA,
      '"accessToken"',
      '"instructions"',
      '"credentials"',
      '"bundle"',
      '"prompt"',
      '"costUsd"',
      "wrappedKey",
    ]) {
      expect(content, needle).not.toContain(needle);
    }
    for (const id of seeded.bIds) expect(content, `client B id ${id}`).not.toContain(id);
  }

  beforeAll(async () => {
    // ── Client A: its records, plus everything that must stay out of its export ──
    await db
      .update(connection)
      .set({
        status: "connected",
        externalAccountId: "acct-a",
        credentialsEncrypted: { v: 2, ct: SECRET },
        config: { apiKey: SECRET },
      })
      .where(eq(connection.id, A.connectionId));
    await db.insert(tenantKey).values({
      tenantId: A.tenantId,
      wrappedKey: { v: 1, alg: "A256GCM", kid: "0000000000000000", iv: "aXY=", ct: SECRET },
    } as never);
    const bundle = testBundle();
    bundle.definition.instructions = PROMPT;
    const [ag] = await db
      .insert(agent)
      .values({
        tenantId: A.tenantId,
        kind: "client",
        slug: "records-clerk",
        name: "Records clerk",
        serviceName: "Record keeping",
        runStatus: "active",
      })
      .returning();
    const [av] = await db
      .insert(agentVersion)
      .values({
        tenantId: A.tenantId,
        agentId: ag?.id as string,
        version: 3,
        bundle,
        bundleHash: "h",
        status: "live",
        authorType: "operator",
      })
      .returning();
    const agentId = ag?.id as string;
    const versionId = av?.id as string;
    const [v] = await db
      .insert(vendor)
      .values({ tenantId: A.tenantId, name: "Acme Lumber", normalizedName: "acme lumber" })
      .returning();
    const txns = await db
      .insert(transaction)
      .values(
        [1, 2, 3].map((n) => ({
          tenantId: A.tenantId,
          kind: "bill" as const,
          connector: "testkit",
          vendorId: v?.id ?? null,
          txnDate: day(0),
          total: `${n}00.0000`,
          currency: "USD",
          externalId: `bill-${n}`,
          memo: n === 1 ? "=SUM(A1:A9)" : null,
        })),
      )
      .returning();
    const pdf = new TextEncoder().encode("%PDF-1.4 client A invoice");
    const key = `tenants/${A.tenantId.toLowerCase()}/content/aa/${"a".repeat(64)}`;
    await harness.objects.put(key, pdf, { contentType: "application/pdf" });
    const [d] = await db
      .insert(document)
      .values({
        tenantId: A.tenantId,
        transactionId: txns[0]?.id ?? null,
        source: "upload",
        storageKey: key,
        mimeType: "application/pdf",
        filename: "Invoice 1001.pdf",
        sizeBytes: pdf.length,
        sha256: "a".repeat(64),
      })
      .returning();
    seeded.docA = d?.id as string;
    const now = new Date();
    const [r] = await db
      .insert(run)
      .values({
        tenantId: A.tenantId,
        agentId,
        agentVersionId: versionId,
        workflowSlug: "fix-record",
        mode: "live",
        status: "succeeded",
        trigger: { type: "manual" },
        costUsd: COST,
        startedAt: now,
        finishedAt: now,
      })
      .returning();
    seeded.runA = r?.id as string;
    const [testRun] = await db
      .insert(run)
      .values({
        tenantId: A.tenantId,
        agentId,
        agentVersionId: versionId,
        workflowSlug: "fix-record",
        mode: "test",
        status: "succeeded",
      })
      .returning();
    seeded.testRunA = testRun?.id as string;
    const steps = await db
      .insert(stepRun)
      .values([
        {
          tenantId: A.tenantId,
          runId: seeded.runA,
          nodeId: "update",
          nodeType: "action",
          agentVersionId: versionId,
          input: { instructions: PROMPT },
          output: { sources: [seeded.docA], text: MODEL_TEXT },
          summary: "Corrected the record",
          status: "succeeded",
          costUsd: COST,
        },
        {
          tenantId: A.tenantId,
          runId: seeded.runA,
          nodeId: "internal",
          nodeType: "notify",
          summary: OPERATOR_NOTE,
          status: "succeeded",
        },
      ])
      .returning();
    const [ea] = await db
      .insert(externalAction)
      .values({
        tenantId: A.tenantId,
        connectionId: A.connectionId,
        tool: "testkit.record.update",
        runId: seeded.runA,
        stepRunId: steps[0]?.id ?? null,
        agentVersionId: versionId,
        input: {
          id: "r1",
          amount: "12.00",
          currency: "USD",
          transactionId: txns[0]?.id,
          accessToken: SECRET,
          instructions: PROMPT,
        },
        before: { id: "r1", amount: "10.00" },
        result: { ok: true },
        idempotencyKey: `${seeded.runA}:update:0`,
        status: "done",
        approvedBy: A.admin,
        approvedAt: now,
        executedAt: now,
      })
      .returning();
    seeded.actionA = ea?.id as string;
    await db.insert(toolCall).values({
      tenantId: A.tenantId,
      stepRunId: steps[0]?.id as string,
      tool: "testkit.record.update",
      input: { prompt: PROMPT },
      status: "succeeded",
    });
    await db.insert(memoryNote).values({ tenantId: A.tenantId, agentId, note: MEMORY });
    const [th] = await db
      .insert(thread)
      .values({ tenantId: A.tenantId, title: "Record keeping" })
      .returning();
    await db.insert(message).values([
      {
        tenantId: A.tenantId,
        threadId: th?.id as string,
        senderType: "agent",
        body: { text: "Your record is fixed." },
        audience: "client",
      },
      {
        tenantId: A.tenantId,
        threadId: th?.id as string,
        senderType: "agent",
        body: { text: OPERATOR_NOTE },
        audience: "operator",
      },
    ]);
    await db.insert(inboxItem).values([
      {
        tenantId: A.tenantId,
        kind: "approval",
        runId: seeded.runA,
        title: "Is the record right now?",
        status: "resolved",
        resolution: { approved: true },
        resolvedBy: A.admin,
        resolvedAt: now,
      },
      {
        tenantId: A.tenantId,
        kind: "review",
        title: OPERATOR_ITEM,
        assigneeRole: "operator",
      },
    ]);
    await db.insert(auditEvent).values([
      { tenantId: null, actorKind: "user", action: "NULL-TENANT-sentinel", outcome: "ok" },
      { tenantId: B.tenantId, actorKind: "user", action: "B-AUDIT-sentinel", outcome: "ok" },
    ]);

    // ── Client B: a vendor, a transaction and a document that must never reach A's exports ──
    const [bv] = await db
      .insert(vendor)
      .values({ tenantId: B.tenantId, name: B_VENDOR, normalizedName: "b vendor sentinel" })
      .returning();
    await db.insert(transaction).values({
      tenantId: B.tenantId,
      kind: "bill",
      connector: "testkit",
      vendorId: bv?.id ?? null,
      total: "999.0000",
      externalId: "b-1",
    });
    const bKey = `tenants/${B.tenantId.toLowerCase()}/content/bb/${"b".repeat(64)}`;
    await harness.objects.put(bKey, new TextEncoder().encode(B_FILE));
    await db.insert(document).values({
      tenantId: B.tenantId,
      source: "upload",
      storageKey: bKey,
      mimeType: "application/pdf",
      filename: "b.pdf",
      sizeBytes: B_FILE.length,
      sha256: "b".repeat(64),
    });
    // Every id of client B, in every table that has one.
    for (const table of TENANT_TABLES) {
      try {
        const rows = await db.execute<{ id: string }>(
          sql`select id::text as id from ${sql.identifier(table)} where tenant_id = ${B.tenantId}`,
        );
        for (const row of rows) seeded.bIds.push(row.id);
      } catch {
        // No id column (membership, usage_daily…).
      }
    }
    seeded.bIds.push(B.tenantId, B.admin, B.user);
  });

  describe("who may ask", () => {
    const exportsOf = (id: string) => `/api/ops/clients/${id}/exports`;
    const period = `from=${day(-1)}&to=${day(1)}`;

    it("refuses the back office's exports to client people and to clients not served", async () => {
      for (const who of [admin("a"), user("a")]) {
        expect((await call(who, "GET", exportsOf(A.tenantId))).status, who).toBe(403);
        expect((await call(who, "POST", exportsOf(A.tenantId), {})).status, who).toBe(403);
        const res = await download(who, `${exportsOf(A.tenantId)}/accountant?${period}`);
        expect(res.res.status, who).toBe(403);
      }
      // Client C is served by another operator; client A is not served by OTHER_OPERATOR.
      expect((await call(OPERATOR, "GET", exportsOf(C.tenantId))).status).toBe(404);
      expect((await call(OPERATOR, "POST", exportsOf(C.tenantId), {})).status).toBe(404);
      expect((await call(OTHER_OPERATOR, "GET", exportsOf(A.tenantId))).status).toBe(404);
      const other = await download(OTHER_OPERATOR, `${exportsOf(A.tenantId)}/accountant?${period}`);
      expect(other.res.status).toBe(404);
      expect(
        (await download(null, `${exportsOf(A.tenantId)}/accountant?${period}`)).res.status,
      ).toBe(401);
    });

    it("gives the accountant and audit exports to the client admin only", async () => {
      for (const path of [`/api/exports/accountant?${period}`, `/api/exports/audit?${period}`]) {
        expect((await download(user("a"), path)).res.status, path).toBe(403);
        expect((await download(null, path)).res.status, path).toBe(401);
        // The operator acting as the client is refused: the portal's export is the client's.
        const asClient = await download(OPERATOR, path, {
          "x-countersign-client": A.tenantId,
        });
        expect(asClient.res.status, path).toBe(403);
        expect((await download(admin("a"), path)).res.status, path).toBe(200);
      }
    });

    it("checks the period", async () => {
      for (const q of [
        `from=${day(1)}&to=${day(-1)}`,
        `from=${day(-400)}&to=${day(0)}`,
        "from=yesterday&to=today",
        `from=${day(0)}`,
      ]) {
        expect((await download(admin("a"), `/api/exports/accountant?${q}`)).res.status, q).toBe(
          400,
        );
      }
    });
  });

  describe("the client data export", () => {
    let zip: Map<string, Uint8Array>;

    it("starts once, runs as a job, and lists a ready export with a short-lived link", async () => {
      const started = await call(OPERATOR, "POST", `/api/ops/clients/${A.tenantId}/exports`, {
        reason: "Asked for by the client",
      });
      expect(started.status).toBe(200);
      const view = started.json as { id: string; status: string; download: unknown };
      expect(view).toMatchObject({ status: "running", download: null });
      expect(jobs.started).toEqual([{ tenantId: A.tenantId, exportId: view.id }]);
      const again = await call(OPERATOR, "POST", `/api/ops/clients/${A.tenantId}/exports`, {});
      expect(again.status).toBe(409);
      expect((again.json as { error: { code: string } }).error.code).toBe("export_running");

      // The Workflow's steps, inline; two rows per page so tables span several pages.
      const step = new FakeWorkflowStep();
      const deps = {
        db: harness.db,
        storage: bufferedExportStorage(harness.objects),
        now: () => new Date(),
        pageRows: 2,
      };
      const done = await runClientExport(deps, jobs.started[0] as never, asStep(step));
      expect(step.results.has("transactions.csv page 1")).toBe(true);
      // Resuming replays the finished steps: the same archive, nothing written twice.
      expect(await runClientExport(deps, jobs.started[0] as never, asStep(step))).toEqual(done);

      const list = await call(OPERATOR, "GET", `/api/ops/clients/${A.tenantId}/exports`);
      expect(list.status).toBe(200);
      const [ready] = (
        list.json as {
          exports: {
            status: string;
            files: number;
            sizeBytes: number;
            download: { url: string; filename: string; expiresAt: string } | null;
          }[];
        }
      ).exports;
      expect(ready).toMatchObject({ status: "ready", files: done.files, sizeBytes: done.size });
      expect(ready?.download?.filename).toMatch(/^mezonas-export-client-a-\d{4}-\d{2}-\d{2}\.zip$/);
      expect(Date.parse(ready?.download?.expiresAt ?? "") - Date.now()).toBeLessThanOrEqual(
        300_000,
      );
      // The link is the Worker's signed file link; it streams the ZIP as an attachment.
      const link = new URL(ready?.download?.url ?? "");
      const got = await download(null, link.pathname);
      expect(got.res.status).toBe(200);
      expect(got.res.headers.get("content-type")).toBe("application/zip");
      expect(got.res.headers.get("content-disposition")).toMatch(/^attachment;/);
      zip = readZip(got.bytes);
      expect(got.bytes.length).toBe(done.size);
      // The job's working pieces are gone once the ZIP is whole.
      const left = await harness.objects.list({
        prefix: `tenants/${A.tenantId.toLowerCase()}/exports/${view.id}/parts/`,
      });
      expect(left.objects).toEqual([]);
    });

    it("holds every record table, the documents and a README", () => {
      const names = [...zip.keys()];
      expect(names[0]).toBe("README.txt");
      for (const file of [
        "transactions.csv",
        "transaction_lines.csv",
        "vendors.csv",
        "items.csv",
        "organizations.csv",
        "contacts.csv",
        "documents.csv",
        "runs.csv",
        "steps.csv",
        "external_actions.csv",
        "inbox_items.csv",
        "approvals.csv",
        "messages.csv",
        "knowledge.csv",
        "account_changes.csv",
        "connections.csv",
      ]) {
        expect(names, file).toContain(file);
      }
      const docPath = documentPath({ id: seeded.docA, filename: "Invoice 1001.pdf" });
      expect(text(zip.get(docPath))).toBe("%PDF-1.4 client A invoice");

      const transactions = csvRecords(text(zip.get("transactions.csv")));
      expect(transactions.map((t) => t.total).sort()).toEqual(["100.0000", "200.0000", "300.0000"]);
      expect(transactions.every((t) => t.currency === "USD")).toBe(true);
      expect(transactions.find((t) => t.id_in_source === "bill-1")?.memo).toBe("'=SUM(A1:A9)");
      expect(csvRecords(text(zip.get("documents.csv")))[0]?.file).toBe(docPath);

      const [action] = csvRecords(text(zip.get("external_actions.csv")));
      expect(action).toMatchObject({
        id: seeded.actionA,
        status: "done",
        approved_by: admin("a"),
      });
      expect(JSON.parse(action?.before ?? "null")).toEqual({ id: "r1", amount: "10.00" });
      expect(JSON.parse(action?.change ?? "null")).toMatchObject({ amount: "12.00" });

      const runs = csvRecords(text(zip.get("runs.csv")));
      expect(runs.map((r) => r.id)).toEqual([seeded.runA]);
      expect(runs[0]).toMatchObject({ service: "Record keeping", agent_version: "3" });
      // The timeline's visible step, by its client label; the hidden one stays out.
      expect(csvRecords(text(zip.get("steps.csv"))).map((s) => s.step)).toEqual([
        "Corrected the record",
      ]);
      expect(csvRecords(text(zip.get("approvals.csv")))[0]).toMatchObject({
        decision: "approved",
        decided_by: admin("a"),
      });
      expect(csvRecords(text(zip.get("messages.csv"))).map((m) => m.text)).toEqual([
        "Your record is fixed.",
      ]);
      expect(csvRecords(text(zip.get("connections.csv")))[0]).toMatchObject({
        system: "testkit",
        account: "acct-a",
      });
      expect(text(zip.get("README.txt"))).toContain("transactions.csv (3 rows)");
    });

    it("never holds secrets, bundles, instructions, prompts, cost, operator-only rows or another client's data", () => {
      expect(
        [...zip.keys()].filter((n) => /bundle|skill|memory|tool_call|key|grant|billing/.test(n)),
      ).toEqual([]);
      for (const [name, bytes] of zip) expectClean(`${name}\n${text(bytes)}`);
    });

    it("is logged in the client's change log and the audit log", async () => {
      const changes = await db
        .select()
        .from(tenantChange)
        .where(eq(tenantChange.tenantId, A.tenantId));
      expect(changes.map((c) => c.change)).toContainEqual(
        expect.objectContaining({ setting: "export" }),
      );
      const audit = await db
        .select({ action: auditEvent.action, actorKind: auditEvent.actorKind })
        .from(auditEvent)
        .where(eq(auditEvent.tenantId, A.tenantId));
      for (const action of [
        "POST /api/ops/clients/:id/exports",
        "export.client_data.start",
        "export.client_data.ready",
      ]) {
        expect(
          audit.map((a) => a.action),
          action,
        ).toContain(action);
      }
    });
  });

  describe("the accountant export", () => {
    const period = `from=${day(-1)}&to=${day(1)}`;

    it("lists each change with its tool, before and after, who signed it, its run and documents", async () => {
      const got = await download(admin("a"), `/api/exports/accountant?${period}`);
      expect(got.res.status).toBe(200);
      expect(got.res.headers.get("content-disposition")).toMatch(
        /^attachment; filename="mezonas-accountant-/,
      );
      const files = readZip(got.bytes);
      const docPath = documentPath({ id: seeded.docA, filename: "Invoice 1001.pdf" });
      expect([...files.keys()]).toEqual(["README.txt", "changes.csv", "runs.csv", docPath]);
      const [change] = csvRecords(text(files.get("changes.csv")));
      expect(change).toMatchObject({
        status: "done",
        system: "Testkit",
        account: "acct-a",
        tool: "testkit.record.update",
        amount: "12.00",
        currency: "USD",
        signed_by: admin("a"),
        run_id: seeded.runA,
        service: "Record keeping",
        agent_version: "3",
        documents: docPath,
        change_id: seeded.actionA,
      });
      expect(JSON.parse(change?.before ?? "null")).toEqual({ id: "r1", amount: "10.00" });
      expect(csvRecords(text(files.get("runs.csv")))).toEqual([
        expect.objectContaining({ run_id: seeded.runA, changes: "1" }),
      ]);
      for (const [name, bytes] of files) expectClean(`${name}\n${text(bytes)}`);

      // The back office's export of the same client is the same.
      const ops = await download(
        OPERATOR,
        `/api/ops/clients/${A.tenantId}/exports/accountant?${period}`,
      );
      expect(ops.res.status).toBe(200);
      expect(text(readZip(ops.bytes).get("changes.csv"))).toBe(text(files.get("changes.csv")));
    });

    it("answers one CSV with format=csv, and leaves out changes outside the period", async () => {
      const csv = await download(admin("a"), `/api/exports/accountant?${period}&format=csv`);
      expect(csv.res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(csvRecords(text(csv.bytes))).toHaveLength(1);
      const before = await download(
        admin("a"),
        `/api/exports/accountant?from=${day(-30)}&to=${day(-2)}&format=csv`,
      );
      expect(csvRecords(text(before.bytes))).toEqual([]);
    });

    it("refuses documents too large for one download, and audits each export", async () => {
      await db
        .update(document)
        .set({ sizeBytes: 200 * 1024 * 1024 })
        .where(eq(document.id, seeded.docA));
      try {
        const big = await download(admin("a"), `/api/exports/accountant?${period}`);
        expect(big.res.status).toBe(413);
        expect(JSON.parse(text(big.bytes)).error.code).toBe("too_large");
        // The changes alone still come.
        const csv = await download(admin("a"), `/api/exports/accountant?${period}&format=csv`);
        expect(csv.res.status).toBe(200);
      } finally {
        await db.update(document).set({ sizeBytes: 25 }).where(eq(document.id, seeded.docA));
      }
      const rows = await db
        .select({ target: auditEvent.target })
        .from(auditEvent)
        .where(
          and(eq(auditEvent.tenantId, A.tenantId), eq(auditEvent.action, "export.accountant")),
        );
      expect(rows.map((r) => r.target)).toContainEqual(
        expect.objectContaining({ from: day(-1), to: day(1), format: "csv", changes: "1" }),
      );
    });
  });

  describe("the audit export", () => {
    it("holds the client's own audit rows only", async () => {
      const got = await download(admin("a"), `/api/exports/audit?from=${day(-1)}&to=${day(1)}`);
      expect(got.res.status).toBe(200);
      const rows = csvRecords(text(got.bytes));
      expect(rows.length).toBeGreaterThan(0);
      const actions = rows.map((r) => r.action);
      expect(actions).toContain("export.accountant");
      expect(actions).not.toContain("NULL-TENANT-sentinel");
      expect(actions).not.toContain("B-AUDIT-sentinel");
      // Rows without a client (sign-ins, cross-client lists) are the operator's.
      const ids = new Set(rows.map((r) => r.id));
      const nullRows = await db
        .select({ id: auditEvent.id })
        .from(auditEvent)
        .where(sql`${auditEvent.tenantId} is null`);
      for (const r of nullRows) expect(ids.has(r.id)).toBe(false);
      expectClean(text(got.bytes));
    });
  });

  describe("after retirement", () => {
    const setRetired = (days: number) =>
      db
        .update(tenant)
        .set({ retiredAt: new Date(Date.now() - days * 86_400_000) })
        .where(eq(tenant.id, B.tenantId));

    it("exports a retired client within its 30 days, and refuses after", async () => {
      await setRetired(10);
      const list = await call(OPERATOR, "GET", `/api/ops/clients/${B.tenantId}/exports`);
      expect(list.json).toMatchObject({
        retiredAt: expect.any(String),
        exportableUntil: expect.any(String),
      });
      const started = await call(OPERATOR, "POST", `/api/ops/clients/${B.tenantId}/exports`, {});
      expect(started.status).toBe(200);
      await setRetired(31);
      const late = await call(OPERATOR, "POST", `/api/ops/clients/${B.tenantId}/exports`, {});
      expect(late.status).toBe(409);
      expect((late.json as { error: { code: string } }).error.code).toBe("export_window_closed");
    });

    it("holds off the 30-day file deletion while an export is being built", async () => {
      // B's export (started above) is still running: its files stay.
      const now = new Date();
      expect(await purgeRetiredFiles(harness.db, harness.objects, now)).toEqual([]);
      const prefix = `tenants/${B.tenantId.toLowerCase()}/`;
      expect((await harness.objects.list({ prefix })).objects.length).toBeGreaterThan(0);
      // Once it is built, the sweep deletes everything, the export with it.
      const params = jobs.started.find((p) => p.tenantId === B.tenantId);
      expect(params).toBeDefined();
      await runClientExport(
        { db: harness.db, storage: bufferedExportStorage(harness.objects), now: () => now },
        params as never,
        asStep(new FakeWorkflowStep()),
      );
      expect(
        (await readManifest(harness.objects, B.tenantId, params?.exportId as string))?.status,
      ).toBe("ready");
      expect(await purgeRetiredFiles(harness.db, harness.objects, now)).toEqual([
        { tenantId: B.tenantId, files: expect.any(Number) },
      ]);
      expect((await harness.objects.list({ prefix })).objects).toEqual([]);
      const gone = await call(OPERATOR, "POST", `/api/ops/clients/${B.tenantId}/exports`, {});
      expect(gone.status).toBe(409);
    });
  });
});
