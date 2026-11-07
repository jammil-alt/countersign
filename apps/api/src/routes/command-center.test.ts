// v0.12 W2-F: the command center, its feed, ⌘K search and plain-words questions (ARCHITECTURE
// §13.1, §11.6; docs/plan.md §1.49, M26) against a real database as cs_worker. The figures match a
// seeded fixture (clean runs, spend, response time, escalations by blocked time); search and
// questions stay within the portal's one client and the operator's clients served, and the
// portal's answers carry no templates, notes or costs; a question's answer that isn't a valid
// RunFilter is refused, and a portal question's cost is the client's usage under Sloan.

import { shortRunId } from "@countersign/core";
import {
  agent,
  connection,
  contact,
  docExtraction,
  document,
  externalAction,
  inboxItem,
  organization,
  run,
  stepRun,
  tenant,
  transaction,
  usageDaily,
  vendor,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "../api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

/** Keys a portal answer here may never carry, beyond the contract's (templates, notes, clients). */
const PORTAL_EXTRA = /^(template|templateId|templates|notes?|tenantId|client|clients|.*[cC]ost.*)$/;

describe.skipIf(!h)("command center, search and questions", () => {
  const H = h as ApiHarness;
  const now = new Date();
  const T0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  /** Today, and within the last minute (or today's first moment, just after midnight). */
  const recent = new Date(Math.max(T0.getTime(), now.getTime() - 60_000));
  const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000);

  const ids = {
    template: "",
    irisA: "",
    irisAv: "",
    sloanA: "",
    sloanAv: "",
    irisB: "",
    irisBv: "",
    irisC: "",
    irisCv: "",
    r1: "",
    r3: "",
    r5: "",
    r7: "",
    r8: "",
    rC: "",
  };

  async function fork(by: string, clientId: string, slug: string, serviceName: string) {
    const res = await H.call(by, "POST", `/api/ops/templates/${ids.template}/fork`, {
      clientId,
      slug,
      serviceName,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const agentId = j(res.json).agent.id as string;
    const versionId = j(res.json).version.id as string;
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", liveVersionId: versionId, stage: "live" })
      .where(eq(agent.id, agentId));
    return { agentId, versionId };
  }

  async function addRun(values: Partial<typeof run.$inferInsert> & { tenantId: string }) {
    const [r] = await H.t.db
      .insert(run)
      .values({
        agentId: ids.irisA,
        agentVersionId: ids.irisAv,
        workflowSlug: "fix-record",
        mode: "live",
        status: "succeeded",
        createdAt: recent,
        startedAt: recent,
        ...values,
      })
      .returning();
    if (!r) throw new Error("no run");
    return r.id;
  }

  async function addStep(
    runId: string,
    tenantId: string,
    values: Partial<typeof stepRun.$inferInsert>,
  ) {
    await H.t.db.insert(stepRun).values({
      tenantId,
      runId,
      nodeId: `n-${Math.random().toString(36).slice(2)}`,
      nodeType: "action",
      status: "succeeded",
      attempts: 1,
      startedAt: recent,
      finishedAt: recent,
      ...values,
    });
  }

  async function addItem(values: Partial<typeof inboxItem.$inferInsert> & { tenantId: string }) {
    const [i] = await H.t.db
      .insert(inboxItem)
      .values({ kind: "approval", title: "An item", ...values })
      .returning();
    return i?.id as string;
  }

  beforeAll(async () => {
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "iris",
      bundle: testBundle("Iris"),
    });
    ids.template = j(tpl.json).agent.id;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${ids.template}/versions/${j(tpl.json).version.id}/publish`,
    );
    ({ agentId: ids.irisA, versionId: ids.irisAv } = await fork(
      OPERATOR,
      H.A.tenantId,
      "iris",
      "Invoice intake",
    ));
    ({ agentId: ids.sloanA, versionId: ids.sloanAv } = await fork(
      OPERATOR,
      H.A.tenantId,
      "supervisor",
      "Your account",
    ));
    ({ agentId: ids.irisB, versionId: ids.irisBv } = await fork(
      OPERATOR,
      H.B.tenantId,
      "iris",
      "Bills in",
    ));
    ({ agentId: ids.irisC, versionId: ids.irisCv } = await fork(
      OTHER_OPERATOR,
      H.C.tenantId,
      "iris",
      "Invoice intake",
    ));
    const A = H.A.tenantId;
    const B = H.B.tenantId;

    // ── Runs and steps (today: r1–r4 live in A, r7 a test run, r8 live in B) ──
    ids.r1 = await addRun({ tenantId: A });
    await addStep(ids.r1, A, { costUsd: "0.0100", summary: "Read invoice 1001" });
    const r2 = await addRun({ tenantId: A });
    await addStep(r2, A, { costUsd: "0.0200", attempts: 2 });
    ids.r3 = await addRun({
      tenantId: A,
      status: "failed",
      finishedAt: recent,
      error: { reason: "QuickBooks said 401\nmore", key: "testkit.update:unauthorized" },
    });
    await addStep(ids.r3, A, { costUsd: "0.0300", status: "failed" });
    const r4 = await addRun({ tenantId: A, status: "running" });
    await addStep(r4, A, { costUsd: "0", status: "running", finishedAt: null });
    // Yesterday's failure, retried (so not an escalation).
    ids.r5 = await addRun({
      tenantId: A,
      status: "failed",
      createdAt: hoursAgo(30),
      finishedAt: hoursAgo(30),
      error: { reason: "timeout" },
    });
    await addRun({ tenantId: A, retryOf: ids.r5, createdAt: hoursAgo(29) });
    ids.r7 = await addRun({ tenantId: A, mode: "test" });
    await addStep(ids.r7, A, { costUsd: "0.0050", summary: "A test step" });
    ids.r8 = await addRun({ tenantId: B, agentId: ids.irisB, agentVersionId: ids.irisBv });
    await addStep(ids.r8, B, { costUsd: "0.0400" });
    // Client C (not served by OPERATOR): must never show.
    ids.rC = await addRun({
      tenantId: H.C.tenantId,
      agentId: ids.irisC,
      agentVersionId: ids.irisCv,
      status: "failed",
      finishedAt: recent,
    });
    await addStep(ids.rC, H.C.tenantId, { costUsd: "9.0000" });

    // A write done by r1.
    await H.t.db.insert(externalAction).values({
      tenantId: A,
      connectionId: H.A.connectionId,
      tool: "testkit.update",
      runId: ids.r1,
      idempotencyKey: `${ids.r1}:update:0`,
      status: "done",
      executedAt: recent,
    });

    // ── Items ──
    await addItem({
      tenantId: A,
      assigneeRole: "operator",
      title: "Check the vendor match",
      createdAt: hoursAgo(8),
    });
    await addItem({
      tenantId: A,
      assigneeRole: "operator",
      title: "A test run's question",
      payload: { testRun: true },
      createdAt: hoursAgo(9),
    });
    await addItem({ tenantId: A, assigneeRole: "client_admin", createdAt: hoursAgo(2) });
    await addItem({ tenantId: B, assigneeRole: "client_user", createdAt: hoursAgo(10) });
    await addItem({
      tenantId: A,
      assigneeRole: "client_admin",
      status: "resolved",
      createdAt: hoursAgo(50),
      resolvedAt: hoursAgo(26),
      resolvedBy: H.A.admin,
    });
    await addItem({
      tenantId: A,
      assigneeRole: "client_admin",
      status: "resolved",
      title: "Approve the bill",
      createdAt: hoursAgo(5),
      resolvedAt: hoursAgo(3),
      resolvedBy: H.A.admin,
    });
    await addItem({
      tenantId: B,
      assigneeRole: "client_user",
      status: "resolved",
      createdAt: hoursAgo(4),
      resolvedAt: hoursAgo(2),
      resolvedBy: H.B.user,
    });
    await addItem({
      tenantId: A,
      agentId: ids.sloanA,
      subjectType: "account_change",
      assigneeRole: "client_admin",
      title: "Add Lisa as a signer",
      createdAt: recent,
    });
    await addItem({ tenantId: H.C.tenantId, assigneeRole: "operator", createdAt: hoursAgo(20) });

    // ── Connections: A's in error and used by Iris; B's in error and unused ──
    await H.t.db
      .update(connection)
      .set({ status: "error", updatedAt: hoursAgo(1) })
      .where(eq(connection.id, H.A.connectionId));
    await H.t.db
      .update(connection)
      .set({ status: "error", updatedAt: hoursAgo(1) })
      .where(eq(connection.id, H.B.connectionId));
    await H.t.db
      .update(agent)
      .set({ bindings: { testkit: H.A.connectionId } })
      .where(eq(agent.id, ids.irisA));

    // ── Documents and readings ──
    const doc = async (tenantId: string, filename: string, sha: string) => {
      const [d] = await H.t.db
        .insert(document)
        .values({
          tenantId,
          source: "upload",
          storageKey: `k/${sha}`,
          mimeType: "application/pdf",
          filename,
          sizeBytes: 10,
          sha256: sha.repeat(64).slice(0, 64),
        })
        .returning();
      return d?.id as string;
    };
    const reading = (
      tenantId: string,
      documentId: string,
      confidence: string,
      agentVersionId: string | null,
      costUsd: string,
      vendorName = "Oakwood Lumber",
    ) =>
      H.t.db.insert(docExtraction).values({
        tenantId,
        documentId,
        model: "claude-sonnet-5-5",
        agentVersionId,
        header: { vendorName, invoiceNumber: "INV-1001" },
        subtotal: "5234.50",
        total: "5234.50",
        linesSum: "5234.50",
        totalsMatch: true,
        confidence,
        costUsd,
        createdAt: recent,
      });
    const docA = await doc(A, "oakwood-invoice-1001.pdf", "a");
    await reading(A, docA, "0.700", null, "0.0150");
    const docA2 = await doc(A, "maple-receipt.pdf", "b");
    await reading(A, docA2, "0.950", ids.irisAv, "0.0000", "Maple Supply");
    const docB = await doc(B, "b-invoice.pdf", "c");
    await reading(B, docB, "0.950", ids.irisBv, "0.0000", "Maple Supply");
    await H.t.db
      .update(tenant)
      .set({ settings: { connectors_offered: ["testkit"], ops: { lowConfidence: 0.97 } } })
      .where(eq(tenant.id, B));

    // ── Records and the directory ──
    const [oak] = await H.t.db
      .insert(vendor)
      .values({ tenantId: A, name: "Oakwood Lumber", normalizedName: "oakwood lumber" })
      .returning();
    await H.t.db.insert(transaction).values({
      tenantId: A,
      kind: "bill",
      connector: "qbo",
      vendorId: oak?.id,
      txnDate: "2026-11-02",
      total: "5234.5000",
      externalId: "b-1",
      ext: { qbo: { docNumber: "INV-1001" } },
    });
    await H.t.db
      .insert(vendor)
      .values({ tenantId: B, name: "Oakwood B", normalizedName: "oakwood b" });
    await H.t.db
      .insert(vendor)
      .values({ tenantId: H.C.tenantId, name: "Oakwood Mills", normalizedName: "oakwood mills" });
    const [org] = await H.t.db
      .insert(organization)
      .values({ tenantId: A, name: "Oakwood Lumber", kinds: ["vendor"], notes: "slow payer" })
      .returning();
    await H.t.db.insert(contact).values({
      tenantId: A,
      name: "Dana Reyes",
      email: "dana@oakwood.example.com",
      organizationId: org?.id,
      notes: "an operator's note",
    });
    await H.t.db
      .insert(contact)
      .values({ tenantId: H.C.tenantId, name: "Dana Cole", email: "dana@c.example.com" });
  });

  // ── The command center ──

  it("matches the seeded fixture", async () => {
    const res = await H.call(OPERATOR, "GET", "/api/ops/command-center");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const cc = j(res.json);
    expect(cc.agentsLive.count).toBe(3);
    expect(cc.agentsLive.clients.map((c: { agents: number }) => c.agents)).toEqual([2, 1]);
    expect(cc.runningNow).toEqual({ runs: 1, steps: 1 });
    // Today: r1–r4 in A and r8 in B are live; r1 and r8 are clean (r2 retried a step).
    expect(cc.runsToday).toEqual({ runs: 5, clean: 2, cleanShare: 0.4 });
    // Steps 0.01 + 0.02 + 0.03 + 0 + 0.005 (test) + 0.04 over 6 runs; reading 0.015.
    expect(cc.spendToday).toEqual({
      costUsd: "0.1200",
      stepsUsd: "0.1050",
      readingUsd: "0.0150",
      perRunUsd: "0.0175",
    });
    expect(cc.waitingOnClients.count).toBe(3);
    expect(Date.parse(cc.waitingOnClients.oldestSince)).toBeCloseTo(hoursAgo(10).getTime(), -3);
    // Escalations: A's operator item, r3, A's broken connection, A's background reading, B's
    // reading under its 0.97 threshold; the test run's item, r5 (retried), B's unused broken
    // connection and everything of C are not. UI cleanup (stream A): with the dev sign-in and no
    // email sender nobody was told of the clients' three open approvals, so they need us too.
    const kinds = cc.escalations.map((e: { kind: string; client: { name: string } }) => [
      e.kind,
      e.client.name,
    ]);
    expect(kinds).toHaveLength(8);
    expect(kinds[0]).toEqual(["approval", "Client B"]);
    expect(kinds[1]).toEqual(["item", "Client A"]);
    expect(kinds.slice(2).sort()).toEqual(
      [
        ["approval", "Client A"],
        ["approval", "Client A"],
        ["connection", "Client A"],
        ["failed_run", "Client A"],
        ["low_confidence", "Client A"],
        ["low_confidence", "Client B"],
      ].sort(),
    );
    expect(cc.escalations[0].wait).toMatchObject({
      on: "client_team",
      nobodyToAct: "no_email",
      emailOff: true,
      items: 1,
    });
    const failed = cc.escalations.find((e: { kind: string }) => e.kind === "failed_run");
    expect(failed).toMatchObject({
      id: ids.r3,
      title: "QuickBooks said 401",
      agent: { id: ids.irisA },
    });
    expect(cc.needUs).toEqual({ count: 8, blockedLong: 2 });
    expect(JSON.stringify(cc)).not.toContain(H.C.tenantId);

    // Low confidence, by client agent and template version (null for background reading).
    const low = cc.lowConfidence.map(
      (g: { client: { name: string }; agent: unknown; threshold: string; lowest: string }) => ({
        client: g.client.name,
        agent: g.agent ? "agent" : null,
        threshold: g.threshold,
        lowest: g.lowest,
      }),
    );
    expect(low).toEqual(
      expect.arrayContaining([
        { client: "Client A", agent: null, threshold: "0.80", lowest: "0.700" },
        { client: "Client B", agent: "agent", threshold: "0.970", lowest: "0.950" },
      ]),
    );
    const bGroup = cc.lowConfidence.find(
      (g: { client: { name: string } }) => g.client.name === "Client B",
    );
    expect(bGroup.template).toMatchObject({ id: ids.template, name: "Iris", version: 1 });

    // Health over 7 days: A has 6 live runs, 2 clean (r1 and r5's retry), answers in 24 h and 2 h.
    const health = Object.fromEntries(cc.health.map((c: { name: string }) => [c.name, c]));
    expect(health["Client A"]).toMatchObject({
      status: "bad",
      runs: 6,
      cleanShare: 0.3333,
      medianResponseHours: 13,
      openEscalations: 6,
    });
    expect(health["Client B"]).toMatchObject({
      status: "watch",
      runs: 1,
      cleanShare: 1,
      medianResponseHours: 2,
      openEscalations: 2,
    });

    // The agents table: state now, last runs (test runs too), cost over 7 days.
    const irisA = cc.agents.find((a: { id: string }) => a.id === ids.irisA);
    expect(irisA).toMatchObject({
      status: "active",
      stage: "live",
      openRuns: 1,
      cost7dUsd: "0.0650",
      template: { id: ids.template, name: "Iris" },
      client: { id: H.A.tenantId, name: "Client A" },
    });
    expect(irisA.recentRuns).toHaveLength(7);
  });

  it("narrows to one client served, and refuses one not served", async () => {
    const one = await H.call(OPERATOR, "GET", `/api/ops/command-center?client=${H.B.tenantId}`);
    expect(one.status).toBe(200);
    expect(j(one.json).runsToday).toEqual({ runs: 1, clean: 1, cleanShare: 1 });
    expect(j(one.json).escalations).toHaveLength(2);
    // A client not served is refused by the session's scope before the route runs.
    const other = await H.call(OPERATOR, "GET", `/api/ops/command-center?client=${H.C.tenantId}`);
    expect(other.status).toBe(403);
    for (const who of [admin("a"), user("a")]) {
      expect((await H.call(who, "GET", "/api/ops/command-center")).status).toBe(403);
      expect((await H.call(who, "GET", "/api/ops/feed")).status).toBe(403);
    }
  });

  it("feeds steps, writes, signatures, failures and drafts, newest first", async () => {
    const since = hoursAgo(4).toISOString();
    const res = await H.call(OPERATOR, "GET", `/api/ops/feed?since=${encodeURIComponent(since)}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const items = j(res.json).items as { kind: string; text: string; client: { name: string } }[];
    expect(items.map((i) => [i.kind, i.text]).sort()).toEqual(
      [
        ["draft", "Add Lisa as a signer"],
        ["failure", "QuickBooks said 401"],
        ["signature", "An item"],
        ["signature", "Approve the bill"],
        ["step", "Read invoice 1001"],
        ["write", "testkit.update"],
      ].sort(),
    );
    const ats = items.map((i) => (i as unknown as { at: string }).at);
    expect([...ats].sort().reverse()).toEqual(ats);
    expect(Date.parse(j(res.json).at)).toBeGreaterThan(Date.parse(since));
    const later = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/feed?since=${encodeURIComponent(j(res.json).at)}`,
    );
    expect(j(later.json).items).toEqual([]);
    const b = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/feed?client=${H.B.tenantId}&since=${encodeURIComponent(since)}`,
    );
    expect(j(b.json).items.map((i: { kind: string }) => i.kind)).toEqual(["signature"]);
  });

  // ── Search ──

  it("finds a run, a vendor, a person and a document in the portal, its own only", async () => {
    const oak = await H.call(admin("a"), "GET", "/api/search?q=oakwood");
    expect(oak.status, JSON.stringify(oak.json)).toBe(200);
    const s = j(oak.json);
    expect(s.records.map((r: { kind: string; label: string }) => [r.kind, r.label])).toEqual([
      ["transaction", "Oakwood Lumber · INV-1001"],
      ["vendor", "Oakwood Lumber"],
    ]);
    expect(s.organizations.map((o: { name: string }) => o.name)).toEqual(["Oakwood Lumber"]);
    expect(s.people.map((p: { name: string }) => p.name)).toEqual(["Dana Reyes"]);
    expect(s.documents.map((d: { filename: string }) => d.filename)).toEqual([
      "oakwood-invoice-1001.pdf",
    ]);
    expect(forbiddenKeys(s, PORTAL_EXTRA)).toEqual([]);
    expect(JSON.stringify(s)).not.toMatch(/Oakwood (B|Mills)|operator's note|slow payer/);

    // A document found by its reading's vendor, not its file name.
    const maple = j((await H.call(user("a"), "GET", "/api/search?q=maple%20supply")).json);
    expect(maple.documents).toMatchObject([
      { filename: "maple-receipt.pdf", vendor: "Maple Supply", number: "INV-1001" },
    ]);

    const amount = j((await H.call(user("a"), "GET", "/api/search?q=%245%2C234.50")).json);
    expect(amount.records).toMatchObject([{ kind: "transaction", amount: "5234.5000" }]);

    const short = j((await H.call(user("a"), "GET", `/api/search?q=${shortRunId(ids.r1)}`)).json);
    expect(short.runs).toMatchObject([{ id: ids.r1, service: { name: "Invoice intake" } }]);
    // A test run never reaches the portal, even by its id.
    const test = j((await H.call(user("a"), "GET", `/api/search?q=${shortRunId(ids.r7)}`)).json);
    expect(test.runs).toEqual([]);

    const iris = j((await H.call(user("a"), "GET", "/api/search?q=iris")).json);
    // Iris and Sloan (forked from the same template here) are A's; B's and C's Iris are not.
    expect(iris.services.map((x: { id: string }) => x.id).sort()).toEqual(
      [ids.irisA, ids.sloanA].sort(),
    );
    expect(JSON.stringify(iris)).not.toContain(ids.template);
    expect(forbiddenKeys(iris, PORTAL_EXTRA)).toEqual([]);

    const dana = j((await H.call(admin("b"), "GET", "/api/search?q=dana")).json);
    expect(dana.people).toEqual([]);
  });

  it("searches the clients served in the back office, with templates and test runs", async () => {
    const res = await H.call(OPERATOR, "GET", "/api/ops/search?q=oakwood");
    expect(res.status).toBe(200);
    const s = j(res.json);
    const vendors = s.records
      .filter((r: { kind: string }) => r.kind === "vendor")
      .map((r: { label: string; client: { name: string } }) => [r.label, r.client.name]);
    expect(vendors.sort()).toEqual([
      ["Oakwood B", "Client B"],
      ["Oakwood Lumber", "Client A"],
    ]);
    expect(JSON.stringify(s)).not.toContain("Oakwood Mills");
    const iris = j((await H.call(OPERATOR, "GET", "/api/ops/search?q=iris")).json);
    expect(iris.agents.map((a: { kind: string }) => a.kind)).toContain("template");
    expect(iris.agents.map((a: { id: string }) => a.id)).not.toContain(ids.irisC);
    const test = j((await H.call(OPERATOR, "GET", `/api/ops/search?q=${shortRunId(ids.r7)}`)).json);
    expect(test.runs).toMatchObject([{ id: ids.r7, mode: "test" }]);
    const step = j((await H.call(OPERATOR, "GET", "/api/ops/search?q=invoice%201001")).json);
    expect(step.runs.map((r: { id: string }) => r.id)).toContain(ids.r1);
    expect(
      (await H.call(OPERATOR, "GET", `/api/ops/search?q=oak&client=${H.C.tenantId}`)).status,
    ).toBe(403);
    expect((await H.call(admin("a"), "GET", "/api/ops/search?q=oak")).status).toBe(403);
  });

  // ── Plain-words questions ──

  const sloanRuns = (tenantId: string) =>
    H.t.db
      .select()
      .from(run)
      .where(and(eq(run.tenantId, tenantId), eq(run.workflowSlug, "runs.ask")));

  it("turns a portal question into the runs list's filter, at the client's cost under Sloan", async () => {
    model.push((request) => {
      const system = JSON.stringify(request.system);
      // The client's own agents only; the question stays in the user message.
      expect(system).toContain(ids.irisA);
      expect(system).not.toContain(ids.irisB);
      expect(system).not.toContain(ids.irisC);
      expect(system).not.toContain("bills Iris entered");
      expect(request.model).toBe("claude-haiku-5-5");
      return {
        toolUse: {
          name: "run_filter",
          input: { agents: [ids.irisA], changedConnector: "testkit" },
        },
        usage: { input: 1000, output: 50 },
      };
    });
    const res = await H.call(admin("a"), "POST", "/api/runs/ask", {
      text: "bills Iris entered over $5,000",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const body = j(res.json);
    expect(body).toMatchObject({
      understood: true,
      filter: { agents: [ids.irisA], changedConnector: "testkit" },
      chips: [
        { key: "agents", value: "Invoice intake" },
        { key: "changedConnector", value: expect.any(String) },
      ],
      query: { agents: ids.irisA, changedConnector: "testkit" },
    });
    expect(body.runs.map((r: { id: string }) => r.id)).toEqual([ids.r1]);
    expect(forbiddenKeys(body, PORTAL_EXTRA)).toEqual([]);
    const user = j(model.requests.at(-1)?.messages[0]).content as string;
    expect(user).toBe("<question>bills Iris entered over $5,000</question>");

    const recorded = await sloanRuns(H.A.tenantId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ agentId: ids.sloanA, mode: "test", status: "succeeded" });
    const [usage] = await H.t.db
      .select()
      .from(usageDaily)
      .where(and(eq(usageDaily.tenantId, H.A.tenantId), eq(usageDaily.agentId, ids.sloanA)));
    expect(usage?.tokensIn).toBe(1000);
    expect(Number(usage?.costUsd)).toBeGreaterThan(0);
  });

  it("refuses an answer that isn't a valid RunFilter, and still counts its cost", async () => {
    model.push({ toolUse: { name: "run_filter", input: { statuses: ["failed"], costOver: "1" } } });
    const res = await H.call(user("a"), "POST", "/api/runs/ask", {
      text: "failed runs that cost more than a dollar",
    });
    expect(res.status).toBe(200);
    expect(j(res.json)).toEqual({ understood: false, message: expect.any(String) });
    expect(await sloanRuns(H.A.tenantId)).toHaveLength(2);

    model.push({ toolUse: { name: "run_filter", input: { agents: [ids.irisB] } } });
    const other = await H.call(user("a"), "POST", "/api/runs/ask", {
      text: "what did Bills in do",
    });
    expect(j(other.json).understood).toBe(false);
  });

  it("charges nothing to a client without an account agent", async () => {
    model.push({ toolUse: { name: "run_filter", input: { statuses: ["succeeded"] } } });
    const res = await H.call(admin("b"), "POST", "/api/runs/ask", { text: "what went through" });
    expect(j(res.json)).toMatchObject({ understood: true });
    expect(j(res.json).runs.map((r: { id: string }) => r.id)).toEqual([ids.r8]);
    expect(await sloanRuns(H.B.tenantId)).toHaveLength(0);
  });

  it("answers the back office across the clients served, never others", async () => {
    model.push((request) => {
      const system = JSON.stringify(request.system);
      expect(system).toContain(ids.irisA);
      expect(system).toContain(ids.irisB);
      expect(system).not.toContain(ids.irisC);
      return {
        toolUse: { name: "run_filter", input: { clients: [H.A.tenantId], statuses: ["failed"] } },
      };
    });
    const res = await H.call(OPERATOR, "POST", "/api/ops/runs/ask", { text: "what failed at A" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const body = j(res.json);
    expect(body.understood).toBe(true);
    expect(body.runs.map((r: { id: string }) => r.id).sort()).toEqual([ids.r3, ids.r5].sort());
    expect(body.runs[0]).toHaveProperty("costUsd");
    expect(body.chips).toEqual([
      { key: "clients", value: "Client A" },
      { key: "statuses", value: "failed" },
    ]);

    model.push({ toolUse: { name: "run_filter", input: { clients: [H.C.tenantId] } } });
    const c = await H.call(OPERATOR, "POST", "/api/ops/runs/ask", { text: "what about C" });
    expect(j(c.json).understood).toBe(false);
    expect(
      (await H.call(OPERATOR, "POST", "/api/ops/runs/ask", { text: "x y z", client: H.C.tenantId }))
        .status,
    ).toBe(404);
    expect((await H.call(admin("a"), "POST", "/api/ops/runs/ask", { text: "failed" })).status).toBe(
      403,
    );
  });
});
