// R3: from a record to its runs (docs/reporting-plan.md §3 R3, docs/plan.md §1.194), against a
// real database as cs_worker. The Runs panel's routes on both surfaces: the runs about a record,
// newest first, with what each did with it and the step's line; a change found by the client's
// tool and its id there. The portal reads only the rows its timeline shows, of its live runs, of
// one client and of a limited person's agents, and carries no cost, bundle or instructions
// (invariants 1 and 11).

import {
  agent,
  agentVersion,
  appUser,
  membership,
  run,
  runSubject,
  stepRun,
  transaction,
  vendor,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

/** Keys a portal answer here may never carry, beyond the contract's. */
const PORTAL_EXTRA =
  /^(template|templateId|templates|notes?|tenantId|client|clients|bundle|instructions?|prompts?|input|output|mode|.*[cC]ost.*|tokens.*)$/;

describe.skipIf(!h)("the runs about a record", () => {
  const H = h as ApiHarness;
  const owner = H.t.db;
  const ids = {} as Record<"agentA" | "otherA" | "acme" | "acmeB" | "bill", string>;
  /**
   * r1: read the vendor on a step the client sees, then changed its bill in QuickBooks; r2: read
   * it on a hidden step only; r3: a test run; r4: another agent's run; rB: client B's.
   */
  const runs = {} as Record<"r1" | "r2" | "r3" | "r4" | "rB", string>;
  let minute = 0;
  let steps = 0;

  async function addAgent(tenantId: string, slug: string, name: string) {
    const [a] = await owner
      .insert(agent)
      .values({
        tenantId,
        kind: "client",
        slug,
        name,
        serviceName: name,
        runStatus: "active",
        stage: "live",
      })
      .returning();
    if (!a) throw new Error("no agent");
    const [v] = await owner
      .insert(agentVersion)
      .values({
        tenantId,
        agentId: a.id,
        version: 1,
        bundle: testBundle(name),
        bundleHash: `hash-${slug}`,
        status: "live",
        authorType: "operator",
      })
      .returning();
    if (!v) throw new Error("no version");
    return { id: a.id, version: v.id };
  }

  async function addRun(
    tenantId: string,
    a: { id: string; version: string },
    mode: "live" | "test" = "live",
  ) {
    // One minute apart, so newest first is an order the test can name.
    minute += 1;
    const [r] = await owner
      .insert(run)
      .values({
        tenantId,
        agentId: a.id,
        agentVersionId: a.version,
        workflowSlug: "fix-record",
        mode,
        status: "succeeded",
        trigger: { type: "manual" },
        startedAt: new Date(Date.UTC(2026, 10, 1, 9, minute)),
        createdAt: new Date(Date.UTC(2026, 10, 1, 9, minute)),
      })
      .returning();
    if (!r) throw new Error("no run");
    return r.id;
  }

  async function addStep(tenantId: string, runId: string, summary: string) {
    steps += 1;
    const [s] = await owner
      .insert(stepRun)
      .values({
        tenantId,
        runId,
        nodeId: `step-${steps}`,
        nodeType: "tool",
        status: "succeeded",
        summary,
        tokensIn: 900,
        tokensOut: 300,
      })
      .returning();
    if (!s) throw new Error("no step");
    return s.id;
  }

  async function keep(
    tenantId: string,
    runId: string,
    row: Partial<typeof runSubject.$inferInsert> & {
      kind: "vendor" | "transaction";
      clientVisible: boolean;
    },
  ) {
    await owner.insert(runSubject).values({ tenantId, runId, role: "read", ...row });
  }

  beforeAll(async () => {
    const A = H.A.tenantId;
    const B = H.B.tenantId;
    const a = await addAgent(A, "bill-clerk", "Bill clerk");
    const other = await addAgent(A, "po-clerk", "PO clerk");
    const b = await addAgent(B, "bill-clerk", "Bill clerk");
    ids.agentA = a.id;
    ids.otherA = other.id;
    const [acme] = await owner
      .insert(vendor)
      .values({
        tenantId: A,
        name: "Acme Supply",
        normalizedName: "acme supply",
        externalRefs: { qbo: "56" },
      })
      .returning();
    const [acmeB] = await owner
      .insert(vendor)
      .values({ tenantId: B, name: "Acme Bricks", normalizedName: "acme bricks" })
      .returning();
    if (!acme || !acmeB) throw new Error("no vendors");
    ids.acme = acme.id;
    ids.acmeB = acmeB.id;
    const [bill] = await owner
      .insert(transaction)
      .values({
        tenantId: A,
        connector: "qbo",
        externalId: "4471",
        kind: "bill",
        vendorId: acme.id,
        total: "120.0000",
        currency: "USD",
        status: "processed",
      })
      .returning();
    if (!bill) throw new Error("no bill");
    ids.bill = bill.id;

    runs.r1 = await addRun(A, a);
    const read = await addStep(A, runs.r1, "Read the invoice from Acme Supply");
    const wrote = await addStep(A, runs.r1, "Entered bill 4471 in QuickBooks");
    await keep(A, runs.r1, {
      kind: "vendor",
      recordId: acme.id,
      label: "Acme Supply",
      stepRunId: read,
      clientVisible: true,
    });
    // The same step keeps it twice: one line.
    await keep(A, runs.r1, {
      kind: "vendor",
      recordId: acme.id,
      label: "Acme Supply",
      stepRunId: read,
      clientVisible: true,
    });
    // The change is kept by QuickBooks' id for the bill, not ours.
    await keep(A, runs.r1, {
      kind: "transaction",
      role: "changed",
      connector: "qbo",
      externalId: "4471",
      label: "Acme Supply",
      number: "4471",
      stepRunId: wrote,
      clientVisible: true,
    });
    runs.r2 = await addRun(A, a);
    const hidden = await addStep(A, runs.r2, "Checked the vendor's secret price list");
    await keep(A, runs.r2, {
      kind: "vendor",
      recordId: acme.id,
      label: "Acme Supply",
      stepRunId: hidden,
      clientVisible: false,
    });
    runs.r3 = await addRun(A, a, "test");
    await keep(A, runs.r3, {
      kind: "vendor",
      recordId: acme.id,
      label: "Acme Supply",
      clientVisible: false,
    });
    runs.r4 = await addRun(A, other);
    // A vendor 4471 in QuickBooks is not the bill 4471; vendor 56 by its id there is Acme.
    await keep(A, runs.r4, {
      kind: "vendor",
      role: "decided",
      connector: "qbo",
      externalId: "56",
      label: "Acme Supply",
      stepRunId: await addStep(A, runs.r4, "Matched the vendor"),
      clientVisible: true,
    });
    await keep(A, runs.r4, {
      kind: "vendor",
      role: "changed",
      connector: "qbo",
      externalId: "4471",
      clientVisible: true,
    });
    runs.rB = await addRun(B, b);
    await keep(B, runs.rB, {
      kind: "vendor",
      recordId: acmeB.id,
      label: "Acme Bricks",
      clientVisible: true,
    });
  });

  const runIds = (body: unknown) => (j(body).runs as { id: string }[]).map((r) => r.id);
  const get = async (who: string, path: string) => {
    const res = await H.call(who, "GET", path);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  };

  it("lists the back office every run about a record, newest first, test runs too", async () => {
    const body = j(
      await get(OPERATOR, `/api/ops/clients/${H.A.tenantId}/records/${ids.acme}/runs`),
    );
    expect(runIds(body)).toEqual([runs.r4, runs.r3, runs.r2, runs.r1]);
    const byId = Object.fromEntries(body.runs.map((r: { id: string }) => [r.id, r]));
    expect(byId[runs.r1]).toMatchObject({
      service: { id: ids.agentA, name: "Bill clerk" },
      status: "succeeded",
      mode: "live",
      roles: [{ role: "read", connector: null, summary: "Read the invoice from Acme Supply" }],
    });
    expect(byId[runs.r2].roles).toEqual([
      { role: "read", connector: null, summary: "Checked the vendor's secret price list" },
    ]);
    expect(byId[runs.r3]).toMatchObject({ mode: "test", roles: [{ role: "read", summary: null }] });
    // Found by QuickBooks' id for the vendor; its change to bill 4471 is not about the vendor.
    expect(byId[runs.r4].roles).toEqual([
      { role: "decided", connector: null, summary: "Matched the vendor" },
    ]);
  });

  it("finds a change to a record by the client's tool and its id there", async () => {
    const body = j(
      await get(OPERATOR, `/api/ops/clients/${H.A.tenantId}/records/${ids.bill}/runs`),
    );
    expect(runIds(body)).toEqual([runs.r1]);
    expect(body.runs[0].roles).toEqual([
      { role: "changed", connector: "qbo", summary: "Entered bill 4471 in QuickBooks" },
    ]);
    const portal = j(await get(admin("a"), `/api/records/${ids.bill}/runs`));
    expect(runIds(portal)).toEqual([runs.r1]);
  });

  it("lists the portal only what its timeline shows, of its live runs, one client's", async () => {
    for (const who of [admin("a"), user("a")]) {
      const body = j(await get(who, `/api/records/${ids.acme}/runs`));
      // r2 kept the vendor only on a hidden step; r3 is a test run.
      expect(runIds(body)).toEqual([runs.r4, runs.r1]);
      expect(body.runs[1]).toMatchObject({
        service: { id: ids.agentA, name: "Bill clerk" },
        waitingOnYou: false,
        roles: [{ role: "read", connector: null, summary: "Read the invoice from Acme Supply" }],
      });
      // No cost, bundle, instructions, step data or other client (invariant 11).
      expect(forbiddenKeys(body, PORTAL_EXTRA)).toEqual([]);
      expect(JSON.stringify(body)).not.toContain("secret price list");
      expect(JSON.stringify(body)).not.toContain(runs.r2);
    }
    // Another client's record finds nothing here, and this client's nothing there.
    expect(runIds(await get(admin("a"), `/api/records/${ids.acmeB}/runs`))).toEqual([]);
    expect(runIds(await get(admin("b"), `/api/records/${ids.acme}/runs`))).toEqual([]);
    expect(runIds(await get(admin("b"), `/api/records/${ids.acmeB}/runs`))).toEqual([runs.rB]);
    // The back office reads one served client at a time.
    const wrong = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.B.tenantId}/records/${ids.acme}/runs`,
    );
    expect(runIds(wrong.json)).toEqual([]);
  });

  it("lists a person limited to some agents only their agents' runs", async () => {
    const [person] = await owner
      .select()
      .from(appUser)
      .where(eq(appUser.email, user("a")));
    const limit = async (agentIds: string[] | null) =>
      owner
        .update(membership)
        .set({ agentIds })
        .where(
          and(eq(membership.tenantId, H.A.tenantId), eq(membership.userId, person?.id as string)),
        );
    await limit([ids.agentA]);
    try {
      expect(runIds(await get(user("a"), `/api/records/${ids.acme}/runs`))).toEqual([runs.r1]);
      // The record's own page stays closed to them.
      expect((await H.call(user("a"), "GET", `/api/records/${ids.acme}`)).status).toBe(403);
    } finally {
      await limit(null);
    }
  });

  it("refuses the back office's route to a client, and the portal's to the operator", async () => {
    const res = await H.call(
      admin("a"),
      "GET",
      `/api/ops/clients/${H.A.tenantId}/records/${ids.acme}/runs`,
    );
    expect(res.status).toBe(403);
    expect((await H.call(OPERATOR, "GET", `/api/records/${ids.acme}/runs`)).status).not.toBe(200);
  });
});
