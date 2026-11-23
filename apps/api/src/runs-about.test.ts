// R2: runs found by what they were about (docs/reporting-plan.md §3 R2, docs/plan.md §1.193),
// against a real database as cs_worker. RunFilter's `about` (a record, or words in a kept label or
// number) and `text` over subjects on both runs lists; ⌘K's count of runs about a record; a
// plain-words question's `aboutText` looked up by code and shown as chips; Sloan's runs. The
// portal (and Sloan) match only the rows the client's timeline shows, of one client, and carry no
// cost or bundle (invariants 1 and 11).

import { dbAccountPort } from "@countersign/agents";
import { ACCOUNT_AGENT_SLUG } from "@countersign/core";
import { agent, agentVersion, appUser, membership, run, runSubject, vendor } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accountViews } from "./account/views";
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

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

/** Keys a portal answer here may never carry, beyond the contract's. */
const PORTAL_EXTRA = /^(template|templateId|templates|notes?|tenantId|client|clients|.*[cC]ost.*)$/;

describe.skipIf(!h)("runs found by what they were about", () => {
  const H = h as ApiHarness;
  const owner = H.t.db;
  const ids = {} as Record<
    "agentA" | "versionA" | "agentB" | "versionB" | "sloan" | "sloanV" | "acmeA" | "acmeB",
    string
  >;
  /** r1: the client's timeline shows it; r2: only a hidden step; r3: a test run; rB: client B. */
  const runs = {} as Record<"r1" | "r2" | "r3" | "rB", string>;

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
    o: { mode?: "live" | "test"; trigger?: Record<string, unknown> } = {},
  ) {
    const [r] = await owner
      .insert(run)
      .values({
        tenantId,
        agentId: a.id,
        agentVersionId: a.version,
        workflowSlug: "fix-record",
        mode: o.mode ?? "live",
        status: "succeeded",
        trigger: o.trigger ?? { type: "manual" },
        startedAt: new Date(),
      })
      .returning();
    if (!r) throw new Error("no run");
    return r.id;
  }

  async function keep(
    tenantId: string,
    runId: string,
    row: {
      kind: "vendor" | "document";
      recordId?: string;
      label?: string;
      number?: string;
      clientVisible: boolean;
    },
  ) {
    await owner.insert(runSubject).values({ tenantId, runId, role: "read", ...row });
  }

  beforeAll(async () => {
    const a = await addAgent(H.A.tenantId, "bill-clerk", "Bill clerk");
    const b = await addAgent(H.B.tenantId, "bill-clerk", "Bill clerk");
    const sloan = await addAgent(H.A.tenantId, ACCOUNT_AGENT_SLUG, "Sloan");
    Object.assign(ids, {
      agentA: a.id,
      versionA: a.version,
      agentB: b.id,
      versionB: b.version,
      sloan: sloan.id,
      sloanV: sloan.version,
    });
    const [acmeA] = await owner
      .insert(vendor)
      .values({ tenantId: H.A.tenantId, name: "Acme Supply", normalizedName: "acme supply" })
      .returning();
    const [acmeB] = await owner
      .insert(vendor)
      .values({ tenantId: H.B.tenantId, name: "Acme Bricks", normalizedName: "acme bricks" })
      .returning();
    if (!acmeA || !acmeB) throw new Error("no vendors");
    ids.acmeA = acmeA.id;
    ids.acmeB = acmeB.id;

    runs.r1 = await addRun(H.A.tenantId, a);
    runs.r2 = await addRun(H.A.tenantId, a);
    runs.r3 = await addRun(H.A.tenantId, a, { mode: "test" });
    runs.rB = await addRun(H.B.tenantId, b);
    const A = H.A.tenantId;
    await keep(A, runs.r1, {
      kind: "vendor",
      recordId: acmeA.id,
      label: "Acme Supply",
      clientVisible: true,
    });
    await keep(A, runs.r2, {
      kind: "vendor",
      recordId: acmeA.id,
      label: "Acme Supply",
      clientVisible: false,
    });
    await keep(A, runs.r2, {
      kind: "document",
      label: "Hidden Steel",
      number: "PO-1032",
      clientVisible: false,
    });
    await keep(A, runs.r3, {
      kind: "vendor",
      recordId: acmeA.id,
      label: "Acme Supply",
      clientVisible: false,
    });
    await keep(H.B.tenantId, runs.rB, {
      kind: "vendor",
      recordId: acmeB.id,
      label: "Acme Bricks",
      clientVisible: true,
    });
  });

  const runIds = (body: unknown) => (j(body).runs as { id: string }[]).map((r) => r.id).sort();
  const get = async (who: string, path: string) => {
    const res = await H.call(who, "GET", path);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  };

  it("finds the back office's runs about a record, its words and its number, every row", async () => {
    const byRecord = await get(OPERATOR, `/api/ops/runs?about=vendor:${ids.acmeA}`);
    expect(runIds(byRecord)).toEqual([runs.r1, runs.r2, runs.r3].sort());
    expect(j(byRecord).about).toEqual([
      { kind: "vendor", id: ids.acmeA, label: "Acme Supply", number: null },
    ]);
    // Words in a label or number, any-of, across the clients served.
    expect(runIds(await get(OPERATOR, "/api/ops/runs?about=hidden%20steel"))).toEqual([runs.r2]);
    expect(runIds(await get(OPERATOR, "/api/ops/runs?about=acme"))).toEqual(
      [runs.r1, runs.r2, runs.r3, runs.rB].sort(),
    );
    expect(runIds(await get(OPERATOR, `/api/ops/runs?about=acme&clients=${H.B.tenantId}`))).toEqual(
      [runs.rB],
    );
    expect(runIds(await get(OPERATOR, `/api/ops/runs?about=vendor:${ids.acmeB},PO-1032`))).toEqual(
      [runs.r2, runs.rB].sort(),
    );
    // `text` matches a kept label or number too.
    expect(runIds(await get(OPERATOR, "/api/ops/runs?text=PO-1032"))).toEqual([runs.r2]);
    expect(runIds(await get(OPERATOR, "/api/ops/runs?about=nothing%20like%20it"))).toEqual([]);
    // The CSV reads the same filter.
    const csv = await H.call(OPERATOR, "GET", "/api/ops/runs.csv?about=hidden%20steel");
    expect(csv.status).toBe(200);
  });

  it("finds the portal's runs only by what its timeline shows, its own client's only", async () => {
    for (const who of [admin("a"), user("a")]) {
      const body = await get(who, `/api/runs?about=vendor:${ids.acmeA}`);
      // r2 kept the vendor only on a hidden step; r3 is a test run.
      expect(runIds(body)).toEqual([runs.r1]);
      expect(j(body).about).toEqual([
        { kind: "vendor", id: ids.acmeA, label: "Acme Supply", number: null },
      ]);
      expect(forbiddenKeys(body, PORTAL_EXTRA)).toEqual([]);
    }
    expect(runIds(await get(admin("a"), "/api/runs?about=hidden%20steel"))).toEqual([]);
    expect(runIds(await get(admin("a"), "/api/runs?text=PO-1032"))).toEqual([]);
    expect(runIds(await get(admin("a"), "/api/runs?text=acme%20supply&perDay=1"))).toEqual([
      runs.r1,
    ]);
    // Another client's words and records find nothing here, and this client's nothing there.
    expect(runIds(await get(admin("a"), "/api/runs?about=acme%20bricks"))).toEqual([]);
    expect(runIds(await get(admin("a"), `/api/runs?about=vendor:${ids.acmeB}`))).toEqual([]);
    const b = await get(admin("b"), `/api/runs?about=vendor:${ids.acmeA},acme`);
    expect(runIds(b)).toEqual([runs.rB]);
    // A record no visible row names is named back by its kind alone, never another's label.
    expect(j(b).about).toEqual([{ kind: "vendor", id: ids.acmeA, label: null, number: null }]);
  });

  // Review of R2: a chip's name comes only from runs the portal's list could show.
  it("names a record in the portal only from its live runs, of the agents a person sees", async () => {
    const other = await addAgent(H.A.tenantId, "po-clerk", "PO clerk");
    const [steel] = await owner
      .insert(vendor)
      .values({ tenantId: H.A.tenantId, name: "Steel Co", normalizedName: "steel co" })
      .returning();
    if (!steel) throw new Error("no vendor");
    const test = await addRun(
      H.A.tenantId,
      { id: ids.agentA, version: ids.versionA },
      {
        mode: "test",
      },
    );
    await keep(H.A.tenantId, test, {
      kind: "vendor",
      recordId: steel.id,
      label: "Steel from a test run",
      clientVisible: true,
    });
    const theirs = await addRun(H.A.tenantId, other);
    await keep(H.A.tenantId, theirs, {
      kind: "vendor",
      recordId: steel.id,
      label: "Steel Co",
      clientVisible: true,
    });
    const path = `/api/runs?about=vendor:${steel.id.toUpperCase()}`;
    const named = (label: string | null) => [{ kind: "vendor", id: steel.id, label, number: null }];
    // Never the test run's name; the live run's, whatever case the link wrote the id in.
    expect(j(await get(admin("a"), path)).about).toEqual(named("Steel Co"));
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
      const limited = j(await get(user("a"), path));
      expect(limited.runs).toEqual([]);
      // Another agent's run lends it no name.
      expect(limited.about).toEqual(named(null));
    } finally {
      await limit(null);
    }
  });

  it("says in ⌘K how many runs were about a record, as each surface reads them", async () => {
    const portal = j(await get(admin("a"), "/api/search?q=acme"));
    expect(portal.records).toEqual([
      expect.objectContaining({ kind: "vendor", id: ids.acmeA, label: "Acme Supply", runs: 1 }),
    ]);
    expect(forbiddenKeys(portal, PORTAL_EXTRA)).toEqual([]);
    const ops = j(await get(OPERATOR, "/api/ops/search?q=acme"));
    const counts = Object.fromEntries(
      (ops.records as { id: string; runs: number }[]).map((r) => [r.id, r.runs]),
    );
    expect(counts).toEqual({ [ids.acmeA]: 3, [ids.acmeB]: 1 });
  });

  // Overnight S3.2 (W2, CL2): a run that wrote a bill for a vendor kept the vendor by QuickBooks'
  // id for it; the vendor's runs, the runs list's filter and ⌘K find it as the vendor's page does.
  it("finds runs about a record by its tool's id too, in its own client only", async () => {
    const [birch] = await owner
      .insert(vendor)
      .values({
        tenantId: H.A.tenantId,
        name: "Birch Lumber",
        normalizedName: "birch lumber",
        externalRefs: { qbo: "77" },
      })
      .returning();
    if (!birch) throw new Error("no vendor");
    const agentA = { id: ids.agentA, version: ids.versionA };
    const wrote = await addRun(H.A.tenantId, agentA);
    await owner.insert(runSubject).values({
      tenantId: H.A.tenantId,
      runId: wrote,
      kind: "vendor",
      role: "read",
      connector: "qbo",
      externalId: "77",
      label: "Birch Lumber",
      clientVisible: true,
    });
    // Client B's QuickBooks has a vendor 77 too: never client A's Birch Lumber.
    const other = await addRun(H.B.tenantId, { id: ids.agentB, version: ids.versionB });
    await owner.insert(runSubject).values({
      tenantId: H.B.tenantId,
      runId: other,
      kind: "vendor",
      role: "read",
      connector: "qbo",
      externalId: "77",
      label: "Birch Lumber",
      clientVisible: true,
    });
    expect(runIds(await get(OPERATOR, `/api/ops/runs?about=vendor:${birch.id}`))).toEqual([wrote]);
    expect(runIds(await get(admin("a"), `/api/runs?about=vendor:${birch.id}`))).toEqual([wrote]);
    const page = j(await get(admin("a"), `/api/records/${birch.id}/runs`));
    expect((page.runs as { id: string }[]).map((r) => r.id)).toEqual([wrote]);
    const portal = j(await get(admin("a"), "/api/search?q=birch"));
    expect(portal.records).toEqual([
      expect.objectContaining({ kind: "vendor", id: birch.id, runs: 1 }),
    ]);
    const ops = j(await get(OPERATOR, "/api/ops/search?q=birch"));
    expect(ops.records).toEqual([expect.objectContaining({ id: birch.id, runs: 1 })]);
  });

  it("looks a question's words up in the client's own records, and shows them as chips", async () => {
    model.push((request) => {
      // The model is never handed the client's vendors.
      expect(JSON.stringify(request.system)).not.toContain("Acme Supply");
      expect(JSON.stringify(request.tools)).not.toContain(ids.acmeA);
      return { toolUse: { name: "run_filter", input: { aboutText: "Acme" } } };
    });
    const res = await H.call(admin("a"), "POST", "/api/runs/ask", { text: "runs about Acme" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const body = j(res.json);
    expect(body).toMatchObject({
      understood: true,
      aboutText: "Acme",
      filter: { about: [{ kind: "vendor", id: ids.acmeA }] },
      chips: [{ key: "about", value: "Acme Supply", about: `vendor:${ids.acmeA}` }],
      query: { about: `vendor:${ids.acmeA}` },
    });
    expect(runIds(body)).toEqual([runs.r1]);
    expect(forbiddenKeys(body, PORTAL_EXTRA)).toEqual([]);

    // Words no record of theirs matches stay words, matched against what the timeline shows.
    model.push({ toolUse: { name: "run_filter", input: { aboutText: "Hidden Steel" } } });
    const words = j(
      (await H.call(admin("a"), "POST", "/api/runs/ask", { text: "the hidden steel runs" })).json,
    );
    expect(words).toMatchObject({
      understood: true,
      filter: { about: [{ text: "Hidden Steel" }] },
      chips: [{ key: "about", value: "Hidden Steel", about: "Hidden Steel" }],
    });
    expect(words.runs).toEqual([]);

    // The back office: each client's record its runs were about.
    model.push({ toolUse: { name: "run_filter", input: { aboutText: "Acme" } } });
    const ops = j(
      (await H.call(OPERATOR, "POST", "/api/ops/runs/ask", { text: "acme runs" })).json,
    );
    expect(ops.understood).toBe(true);
    expect(ops.filter.about).toEqual([
      { kind: "vendor", id: ids.acmeA },
      { kind: "vendor", id: ids.acmeB },
    ]);
    expect(ops.chips.map((c: { value: string }) => c.value)).toEqual([
      "Acme Supply",
      "Acme Bricks",
    ]);
    expect(runIds(ops)).toEqual([runs.r1, runs.r2, runs.r3, runs.rB].sort());
  });

  it("gives Sloan the same filter, reading only what the portal shows", async () => {
    const [person] = await owner
      .select()
      .from(appUser)
      .where(eq(appUser.email, admin("a")));
    const sloanRun = await addRun(
      H.A.tenantId,
      { id: ids.sloan, version: ids.sloanV },
      {
        trigger: {
          type: "event",
          eventType: "thread.message_posted",
          payload: {
            threadId: "0190f5e8-8a3c-7d6e-8f00-0000000000a1",
            subjectType: "account",
            subjectId: null,
            messageId: "0190f5e8-8a3c-7d6e-8f00-0000000000a2",
            senderType: "user",
            senderId: person?.id,
            audience: "client",
          },
        },
      },
    );
    const port = dbAccountPort(H.db, accountViews(H.platform));
    const call = {
      agentId: ids.sloan,
      agentVersionId: ids.sloanV,
      runId: sloanRun,
      stepId: "answer",
      mode: "live" as const,
    };
    const idsOf = (rows: unknown[]) => rows.map((r) => (r as { id: string }).id);
    expect(
      idsOf(
        await port.runs(H.A.tenantId, call, {
          about: [{ kind: "vendor", id: ids.acmeA }],
          limit: 20,
        }),
      ),
    ).toEqual([runs.r1]);
    expect(
      idsOf(await port.runs(H.A.tenantId, call, { about: [{ text: "Hidden Steel" }], limit: 20 })),
    ).toEqual([]);
    expect(idsOf(await port.runs(H.A.tenantId, call, { text: "PO-1032", limit: 20 }))).toEqual([]);
    expect(idsOf(await port.runs(H.A.tenantId, call, { text: "Acme", limit: 20 }))).toEqual([
      runs.r1,
    ]);
  });
});
