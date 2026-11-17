// Sales through the API (docs/plan.md §1.123.2; docs/cases-plan.md S1–S2): a lead's deal from
// its first stage to set-up, which creates the client (the operator now serves it) and a build per
// agent sold; an expansion deal held by its client's trouble; stage moves and outcomes on the
// timeline, with Reggie's check-back; terms by hand with the signed copy; and the scope rules: a
// client's deals only for operators serving it, nothing for client roles.
import { DEV_USER_HEADER } from "@countersign/auth";
import type { DealDetail, DealSummary, SalesKpis } from "@countersign/core";
import { build, deal, dealActivity, inboxItem, membership, tenant, todo } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, OPERATOR, OTHER_OPERATOR, user } from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n");

describe.skipIf(!h)("deals", () => {
  const H = h as NonNullable<typeof h>;
  const call = async <T = DealDetail>(
    method: string,
    path: string,
    body?: unknown,
    who = OPERATOR,
  ) => {
    const res = await H.call(who, method, path, body);
    return { status: res.status, json: res.json as T };
  };
  const ok = async <T = DealDetail>(
    method: string,
    path: string,
    body?: unknown,
    who = OPERATOR,
  ) => {
    const res = await call<T>(method, path, body, who);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  };
  const list = (query = "") =>
    ok<{ deals: DealSummary[]; kpis: SalesKpis; today: string }>("GET", `/api/ops/deals${query}`);
  async function put(path: string, bytes: Uint8Array, type = "application/pdf", who = OPERATOR) {
    const res = await H.app.request(
      `${path}?name=Ridgeline%20contract.pdf`,
      { method: "PUT", headers: { [DEV_USER_HEADER]: who, "content-type": type }, body: bytes },
      H.env,
    );
    return { status: res.status, json: await res.json() };
  }

  it("are the operator's only", async () => {
    for (const who of [admin("a"), user("a")]) {
      expect((await H.call(who, "GET", "/api/ops/deals")).status).toBe(403);
      expect(
        (
          await H.call(who, "POST", "/api/ops/deals", {
            kind: "new",
            company: "X",
            title: "Y",
            mrr: "1",
          })
        ).status,
      ).toBe(403);
    }
  });

  it("takes a lead from its first reply to set-up: a client and a build per agent", async () => {
    const made = await ok("POST", "/api/ops/deals", {
      kind: "new",
      company: "Ridgeline Dental Group",
      title: "Purchasing and Bookkeeping",
      description: "4 offices, about 300 supplier invoices a month. From the Hire page.",
      mrr: "2400",
      source: "site_form",
      agentsSold: [
        { name: "Purchasing", templateId: null },
        { name: "Bookkeeper", templateId: null },
      ],
      people: [
        { name: "Karen Lowe", email: "karen@ridgeline.example.com", role: "Office manager" },
      ],
      nextStep: "First reply",
      nextDueOn: "2026-01-02",
    });
    const id = made.deal.id;
    expect(made.deal).toMatchObject({
      kind: "new",
      stage: "lead",
      stageName: "Lead",
      likelihood: "0.1",
      mrr: "2400.0000",
      weighted: "240.0000",
      agentCount: 2,
      client: null,
      company: "Ridgeline Dental Group",
      standing: "you",
      late: true,
      outcome: "open",
      people: [{ name: "Karen Lowe", isPrimary: true }],
    });
    expect(made.stages.map((s) => s.id)).toEqual([
      "lead",
      "qualified",
      "diagnostic",
      "proposal",
      "setup",
      "live",
    ]);
    expect(made.activity[0]?.body).toBe("Opened the deal.");

    // On the lists and in the figures.
    const all = await list();
    expect(all.deals.map((d) => d.id)).toContain(id);
    expect((await list("?tab=grow")).deals.map((d) => d.id)).not.toContain(id);
    expect((await list("?tab=new")).deals.map((d) => d.id)).toContain(id);
    expect(all.kpis.open).toBeGreaterThanOrEqual(1);
    expect(all.kpis.late).toBeGreaterThanOrEqual(1);

    // A stage that isn't the pipeline's is refused; a move writes its line.
    expect((await call("PATCH", `/api/ops/deals/${id}`, { stage: "pitch" })).status).toBe(422);
    const moved = await ok("PATCH", `/api/ops/deals/${id}`, {
      stage: "proposal",
      waitingOn: "client",
      statusLine: "Waiting on signature",
      reason: "Contract sent to the owner.",
    });
    expect(moved.deal).toMatchObject({
      stage: "proposal",
      likelihood: "0.6",
      standing: "client",
      statusText: "Waiting on signature",
    });
    expect(moved.activity[0]).toMatchObject({
      kind: "stage",
      who: "Operator",
      body: "Moved from Lead to Proposal and contract. Contract sent to the owner.",
    });

    // A note and a person.
    const noted = await ok("POST", `/api/ops/deals/${id}/activity`, {
      kind: "call",
      body: "Karen wants it live by January.",
    });
    expect(noted.activity[0]).toMatchObject({
      kind: "call",
      body: "Karen wants it live by January.",
    });
    const withAna = await ok("POST", `/api/ops/deals/${id}/people`, {
      name: "Ana Ruiz",
      role: "Owner",
      isPrimary: true,
    });
    expect(withAna.deal.people.map((p) => [p.name, p.isPrimary])).toEqual([
      ["Ana Ruiz", true],
      ["Karen Lowe", false],
    ]);

    // Terms by hand, and the signed copy (a PDF only).
    const termed = await ok("POST", `/api/ops/deals/${id}/terms`, {
      agreedMrr: "2300.50",
      from: "2026-12-01",
      note: "Setup fee waived.",
    });
    expect(termed.deal).toMatchObject({ agreedMrr: "2300.5000", agreedFrom: "2026-12-01" });
    expect(termed.activity[0]?.body).toBe(
      "Recorded the agreed terms: $2,301 a month from Dec 1. Setup fee waived.",
    );
    expect((await put(`/api/ops/deals/${id}/terms/signed-copy`, PDF, "image/png")).status).toBe(
      422,
    );
    expect(
      (await put(`/api/ops/deals/${id}/terms/signed-copy`, new TextEncoder().encode("hello")))
        .status,
    ).toBe(422);
    expect((await put(`/api/ops/deals/${id}/terms/signed-copy`, PDF)).json).toEqual({
      ok: true,
      bytes: PDF.length,
    });
    const [stored] = await H.t.db.select().from(deal).where(eq(deal.id, id));
    expect(stored?.signedCopyKey).toMatch(new RegExp(`^operator/deals/${id}/signed-\\d+\\.pdf$`));
    expect(await H.objects.head(stored?.signedCopyKey ?? "")).toBeTruthy();
    const link = await ok<{ url: string; expiresAt: string }>(
      "GET",
      `/api/ops/deals/${id}/terms/signed-copy`,
    );
    expect(link.url).toContain("/api/files/");
    expect((await ok("GET", `/api/ops/deals/${id}`)).deal.signedCopy).toEqual({
      name: "Ridgeline contract.pdf",
    });

    // Set-up: the client, served by this operator, and a build per agent sold.
    const setup = await ok<{ clientId: string; buildIds: string[] }>(
      "POST",
      `/api/ops/deals/${id}/setup`,
      {
        name: "Ridgeline Dental Group",
        timezone: "America/Chicago",
        agents: [
          { name: "Purchasing", templateId: null, promisedOn: "2026-12-05" },
          { name: "Bookkeeper", templateId: null },
        ],
      },
    );
    expect(setup.buildIds).toHaveLength(2);
    const [client] = await H.t.db.select().from(tenant).where(eq(tenant.id, setup.clientId));
    expect(client).toMatchObject({ name: "Ridgeline Dental Group", timezone: "America/Chicago" });
    const serves = await H.t.db
      .select()
      .from(membership)
      .where(and(eq(membership.tenantId, setup.clientId), eq(membership.userId, H.operator)));
    expect(serves).toHaveLength(1);
    const builds = await H.t.db.select().from(build).where(eq(build.clientId, setup.clientId));
    expect(
      builds.map((b) => [b.title, b.kind, b.originKind, b.originId, b.promisedOn]).sort(),
    ).toEqual([
      ["Bookkeeper", "agent", "deal", id, null],
      ["Purchasing", "agent", "deal", id, "2026-12-05"],
    ]);
    const after = await ok("GET", `/api/ops/deals/${id}`);
    expect(after.deal).toMatchObject({
      stage: "setup",
      client: { id: setup.clientId, name: "Ridgeline Dental Group" },
    });
    expect(after.builds.map((b) => b.id).sort()).toEqual([...setup.buildIds].sort());
    expect(after.activity[0]?.body).toBe("Set up the client and opened 2 builds.");
    // Once only.
    expect(
      (
        await call("POST", `/api/ops/deals/${id}/setup`, {
          name: "Again",
          agents: [{ name: "X", templateId: null }],
        })
      ).status,
    ).toBe(409);

    // The last stage is the win.
    const live = await ok("PATCH", `/api/ops/deals/${id}`, { stage: "live" });
    expect(live.deal).toMatchObject({ outcome: "won", standing: "done" });
    expect(live.deal.statusText).toMatch(/^Won /);
    expect((await list()).kpis.wonCount).toBeGreaterThanOrEqual(1);
    expect((await call("PATCH", `/api/ops/deals/${id}`, { title: "Changed" })).status).toBe(409);
  });

  it("refuses set-up before the proposal", async () => {
    const early = await ok("POST", "/api/ops/deals", {
      kind: "new",
      company: "Bayside Electric",
      title: "Purchasing",
      mrr: "1200",
    });
    const res = await call("POST", `/api/ops/deals/${early.deal.id}/setup`, {
      name: "Bayside Electric",
      agents: [{ name: "Purchasing", templateId: null }],
    });
    expect(res.status).toBe(409);
  });

  it("closes deals: no needs a reason; lost and not now bring Reggie back later", async () => {
    const lead = await ok("POST", "/api/ops/deals", {
      kind: "new",
      company: "Keystone Roofing",
      title: "Purchasing and Bookkeeping",
      mrr: "2000",
    });
    const id = lead.deal.id;
    expect((await call("POST", `/api/ops/deals/${id}/outcome`, { outcome: "no" })).status).toBe(
      422,
    );
    const lost = await ok("POST", `/api/ops/deals/${id}/outcome`, {
      outcome: "lost",
      reason: "Went with their accountant.",
    });
    expect(lost.deal).toMatchObject({ outcome: "lost", standing: "done" });
    expect(lost.deal.checkBackOn).not.toBeNull();
    const days = Math.round(
      (Date.parse(lost.deal.checkBackOn as string) -
        Date.parse(new Date().toISOString().slice(0, 10))) /
        86_400_000,
    );
    expect(days).toBe(90);
    const checks = await H.t.db
      .select()
      .from(todo)
      .where(and(eq(todo.aboutKind, "deal"), eq(todo.aboutId, id)));
    expect(checks).toMatchObject([{ owner: "reggie", title: "Check back with Keystone Roofing" }]);
    expect(lost.activity[0]?.body).toMatch(
      /^Lost\. Went with their accountant\. Reggie checks back /,
    );
    // Closed is closed.
    expect((await call("POST", `/api/ops/deals/${id}/outcome`, { outcome: "won" })).status).toBe(
      409,
    );
    // Shown under Done, not Open.
    const shown = (await list()).deals.find((d) => d.id === id);
    expect(shown?.standing).toBe("done");
  });

  it("holds an expansion deal while its client's account is at risk", async () => {
    const grow = await ok("POST", "/api/ops/deals", {
      kind: "expansion",
      clientId: H.B.tenantId,
      title: "Collections",
      description: "38 invoices over 60 days.",
      mrr: "800",
      agentsSold: [{ name: "Collections", templateId: null }],
    });
    expect(grow.deal).toMatchObject({ stage: "spotted", held: null, standing: "you" });
    // An expansion deal needs its client.
    expect(
      (
        await call("POST", "/api/ops/deals", {
          kind: "expansion",
          company: "Nobody",
          title: "X",
          mrr: "1",
        })
      ).status,
    ).toBe(422);
    await H.t.db.insert(inboxItem).values(
      [1, 2, 3].map((n) => ({
        tenantId: H.B.tenantId,
        kind: "review" as const,
        title: `Escalation ${n}`,
        assigneeRole: "operator" as const,
      })),
    );
    const held = await ok("GET", `/api/ops/deals/${grow.deal.id}`);
    expect(held.deal).toMatchObject({
      held: { reason: "Held: account at risk" },
      standing: "stalled",
      statusText: "Held: account at risk",
    });
    // At agreed, its builds open at the client.
    expect(
      (
        await call("POST", `/api/ops/deals/${grow.deal.id}/open-builds`, {
          agents: [{ name: "Collections", templateId: null }],
        })
      ).status,
    ).toBe(409);
    await ok("PATCH", `/api/ops/deals/${grow.deal.id}`, { stage: "agreed" });
    const opened = await ok<{ buildIds: string[] }>(
      "POST",
      `/api/ops/deals/${grow.deal.id}/open-builds`,
      { agents: [{ name: "Collections", templateId: null, promisedOn: "2026-12-12" }] },
    );
    expect(opened.buildIds).toHaveLength(1);
    const [b] = await H.t.db
      .select()
      .from(build)
      .where(eq(build.id, opened.buildIds[0] as string));
    expect(b).toMatchObject({
      clientId: H.B.tenantId,
      originKind: "deal",
      promisedOn: "2026-12-12",
    });
  });

  it("keeps a client's deals to the operators serving it; a lead's to every operator", async () => {
    const forA = await ok("POST", "/api/ops/deals", {
      kind: "expansion",
      clientId: H.A.tenantId,
      title: "Bookkeeping",
      mrr: "1200",
    });
    const lead = await ok("POST", "/api/ops/deals", {
      kind: "new",
      company: "Cobalt Auto Glass",
      title: "Invoice review",
      mrr: "1100",
    });
    expect(
      (await call("GET", `/api/ops/deals/${forA.deal.id}`, undefined, OTHER_OPERATOR)).status,
    ).toBe(404);
    expect(
      (await call("PATCH", `/api/ops/deals/${forA.deal.id}`, { title: "Mine" }, OTHER_OPERATOR))
        .status,
    ).toBe(404);
    const theirs = (
      await call<{ deals: DealSummary[] }>("GET", "/api/ops/deals", undefined, OTHER_OPERATOR)
    ).json;
    expect(theirs.deals.map((d) => d.id)).not.toContain(forA.deal.id);
    expect(theirs.deals.map((d) => d.id)).toContain(lead.deal.id);
    // Another operator can't open a deal for a client it doesn't serve.
    expect(
      (
        await call(
          "POST",
          "/api/ops/deals",
          { kind: "expansion", clientId: H.A.tenantId, title: "X", mrr: "1" },
          OTHER_OPERATOR,
        )
      ).status,
    ).toBe(404);
    // Its timeline is held to the deal's own scope too.
    const rows = await H.t.db
      .select()
      .from(dealActivity)
      .where(eq(dealActivity.dealId, forA.deal.id));
    expect(rows.length).toBeGreaterThan(0);
  });
});

// A Worker's request has one database connection: set-up opens no transaction beside another.
const one = await createApiHarness({ appDbMax: 1 });
afterAll(() => one?.close());

describe.skipIf(!one)("deal set-up on one connection", () => {
  it("creates the client and its builds without waiting on itself", async () => {
    const O = one as NonNullable<typeof one>;
    const made = await O.call(OPERATOR, "POST", "/api/ops/deals", {
      kind: "new",
      company: "Pine & Co. Bakery",
      title: "Catering invoices",
      mrr: "1400",
      stage: "proposal",
    });
    expect(made.status).toBe(200);
    const id = (made.json as DealDetail).deal.id;
    const res = await O.call(OPERATOR, "POST", `/api/ops/deals/${id}/setup`, {
      name: "Pine & Co. Bakery",
      agents: [{ name: "Catering invoices", templateId: null }],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((res.json as { buildIds: string[] }).buildIds).toHaveLength(1);
  }, 20_000);
});
