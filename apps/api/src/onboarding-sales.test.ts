// Sales' part of onboarding v1 through the API (docs/plan.md §1.149; docs/cases-plan.md §3.1,
// §4.1–§4.3): the client file and its facts by hand (corrections replace, nothing is edited, an
// `ours` fact never leaves the back office), a deal pointing at its file, stages as a record (skip
// forward with who and why, to-dos for what a later stage wants), every account in Sales (a client
// made anywhere gets its deal at Set up the account, once), saved starts (seeded once), and Invite
// and Sign up now: the preview changes nothing, the send makes the client, invites its people,
// opens the intake with only `theirs` facts, the builds and the deal's to-dos, then the emails.
//
// The guide (stream INTAKE) and the emails (stream EMAIL) are the real ones: their own tests are
// intake.test.ts and welcome.test.ts.

import type {
  ClientFileDetail,
  ClientFileSummary,
  DealDetail,
  InvitePreview,
  InviteSent,
  SalesStartView,
} from "@countersign/core";
import { allRoutes, forbiddenPortalFields, routeFamily } from "@countersign/core";
import {
  appUser,
  build,
  deal,
  dealActivity,
  intake,
  intakeEvent,
  intakePerson,
  membership,
  notification,
  tenant,
  todo,
} from "@countersign/db";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

// ── The contract: files, facts and starts stay in the back office ───────────────────────────────

describe("the client file's contract", () => {
  it("is returned by no portal or public route", () => {
    for (const [name, r] of Object.entries(allRoutes)) {
      if (routeFamily(r) === "ops") continue;
      const json = JSON.stringify(
        z.toJSONSchema(r.response, { io: "output", unrepresentable: "any" }),
      );
      for (const field of ["sureness", "replacedById", "openDeals", "lastFactAt", "seedKey"]) {
        expect(json.includes(`"${field}"`), `${name} returns ${field}`).toBe(false);
      }
      expect(forbiddenPortalFields(r.response), name).toEqual([]);
    }
  });

  it("keeps every file, start, invite and sign-up route the operator's", () => {
    for (const name of [
      "opsClientFiles",
      "opsCreateClientFile",
      "opsClientFile",
      "opsUpdateClientFile",
      "opsAddClientFacts",
      "opsStarts",
      "opsCreateStart",
      "opsUpdateStart",
      "opsInvitePreview",
      "opsInviteSend",
      "opsSignUpPreview",
      "opsSignUp",
    ] as const) {
      expect(allRoutes[name].roles, name).toEqual(["operator"]);
      expect(routeFamily(allRoutes[name]), name).toBe("ops");
    }
  });
});

describe.skipIf(!h)("Sales' onboarding", () => {
  const H = h as NonNullable<typeof h>;
  const call = async <T>(method: string, path: string, body?: unknown, who = OPERATOR) => {
    const res = await H.call(who, method, path, body);
    return { status: res.status, json: res.json as T };
  };
  const ok = async <T>(method: string, path: string, body?: unknown, who = OPERATOR) => {
    const res = await call<T>(method, path, body, who);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  };
  const todosAbout = (dealId: string) =>
    H.t.db
      .select()
      .from(todo)
      .where(and(eq(todo.aboutKind, "deal"), eq(todo.aboutId, dealId)))
      .orderBy(asc(todo.title));
  const inDays = (n: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  let templateId = "";
  beforeAll(async () => {
    const created = await ok<{ agent: { id: string }; version: { id: string } }>(
      "POST",
      "/api/ops/templates",
      {
        slug: "vendor-contracts",
        bundle: testBundle("Vendor contracts"),
        name: "Vendor contracts",
      },
    );
    templateId = created.agent.id;
    await ok("POST", `/api/ops/agents/${templateId}/versions/${created.version.id}/publish`);
  });

  it("refuses client roles every file, start and invite route", async () => {
    for (const who of [admin("a"), user("a")]) {
      for (const [method, path, body] of [
        ["GET", "/api/ops/client-files", undefined],
        ["POST", "/api/ops/client-files", { name: "X" }],
        ["GET", "/api/ops/starts", undefined],
        [
          "POST",
          "/api/ops/starts",
          { name: "X", covers: { general: true, areas: [], templateIds: [] } },
        ],
      ] as const) {
        expect((await H.call(who, method, path, body)).status, `${who} ${path}`).toBe(403);
      }
    }
  });

  it("keeps a file's facts: added by hand, corrected by a new one, never edited", async () => {
    const made = await ok<ClientFileDetail>("POST", "/api/ops/client-files", {
      name: "Ridgeway Lumber",
      website: "ridgeway.example.com",
    });
    expect(made.file).toMatchObject({ status: "prospect", client: null, facts: 0 });
    const id = made.file.id;
    const added = await ok<ClientFileDetail>("POST", `/api/ops/client-files/${id}/facts`, {
      facts: [
        { section: "volumes", text: "About 340 bills a month", sourceKind: "call" },
        {
          section: "systems",
          text: "Bills come to ap@ridgeway.example.com",
          sourceKind: "call",
          audience: "theirs",
        },
      ],
    });
    // New facts start as our notes, heard, unless said otherwise; the operator is who added them.
    expect(added.facts.map((f) => [f.text, f.audience, f.sureness, f.by?.name])).toEqual([
      ["Bills come to ap@ridgeway.example.com", "theirs", "heard", "Operator"],
      ["About 340 bills a month", "ours", "heard", "Operator"],
    ]);
    const volume = added.facts.find((f) => f.section === "volumes")?.id as string;
    const corrected = await ok<ClientFileDetail>("POST", `/api/ops/client-files/${id}/facts`, {
      facts: [
        {
          section: "volumes",
          text: "About 400 bills a month",
          sourceKind: "email",
          sureness: "seen",
          replacesId: volume,
        },
      ],
    });
    expect(corrected.file.facts).toBe(2);
    expect(corrected.facts.map((f) => f.text)).not.toContain("About 340 bills a month");
    // Corrected once: a second correction of the same fact is refused.
    expect(
      (
        await call("POST", `/api/ops/client-files/${id}/facts`, {
          facts: [{ section: "volumes", text: "500", sourceKind: "note", replacesId: volume }],
        })
      ).status,
    ).toBe(409);
    // A fact of another file is not this file's to correct.
    const other = await ok<ClientFileDetail>("POST", "/api/ops/client-files", {
      name: "Elsewhere",
    });
    expect(
      (
        await call("POST", `/api/ops/client-files/${other.file.id}/facts`, {
          facts: [{ section: "volumes", text: "1", sourceKind: "note", replacesId: volume }],
        })
      ).status,
    ).toBe(404);
    const history = await ok<ClientFileDetail>("GET", `/api/ops/client-files/${id}?history=true`);
    expect(history.facts.find((f) => f.id === volume)?.replacedById).toBe(
      corrected.facts.find((f) => f.text === "About 400 bills a month")?.id,
    );
    // On the list, found by name; a prospect's file is every operator's.
    const listed = await ok<{ files: ClientFileSummary[] }>(
      "GET",
      "/api/ops/client-files?q=ridgeway",
    );
    expect(listed.files.map((f) => f.id)).toEqual([id]);
    expect(
      (await call("GET", `/api/ops/client-files/${id}`, undefined, OTHER_OPERATOR)).status,
    ).toBe(200);
    // Linked to a client: only the operators serving it read it.
    const linked = await ok<ClientFileDetail>("PATCH", `/api/ops/client-files/${id}`, {
      clientId: H.A.tenantId,
    });
    expect(linked.file).toMatchObject({ status: "client", client: { id: H.A.tenantId } });
    expect(
      (await call("GET", `/api/ops/client-files/${id}`, undefined, OTHER_OPERATOR)).status,
    ).toBe(404);
    // A client has one file; a client's file is never a prospect's again.
    expect(
      (await call("POST", "/api/ops/client-files", { name: "Again", clientId: H.A.tenantId }))
        .status,
    ).toBe(409);
    expect(
      (await call("PATCH", `/api/ops/client-files/${id}`, { status: "prospect" })).status,
    ).toBe(422);
  });

  it("points a deal at its company's file, and skips stages forward with who and why", async () => {
    const lead = await ok<DealDetail>("POST", "/api/ops/deals", {
      kind: "new",
      company: "Cedar Point Dental",
      title: "Purchasing",
      mrr: "1800",
    });
    expect(lead.deal.fileId).not.toBeNull();
    // The same company's next deal reuses its file.
    const again = await ok<DealDetail>("POST", "/api/ops/deals", {
      kind: "new",
      company: "cedar point dental ",
      title: "Bookkeeping",
      mrr: "900",
    });
    expect(again.deal.fileId).toBe(lead.deal.fileId);

    const id = lead.deal.id;
    const moved = await ok<DealDetail>("PATCH", `/api/ops/deals/${id}`, {
      stage: "setup",
      reason: "They want to start now",
    });
    expect(moved.deal.stage).toBe("setup");
    expect(moved.activity.slice(0, 4).map((a) => [a.kind, a.who, a.body])).toEqual([
      ["stage", "Operator", "Moved from Lead to Set up the account. They want to start now."],
      ["stage", "Operator", "Skipped Proposal and contract: They want to start now."],
      ["stage", "Operator", "Skipped Diagnostic: They want to start now."],
      ["stage", "Operator", "Skipped Qualified: They want to start now."],
    ]);
    // What Set up the account wants and wasn't given: a to-do each, due in a week, made once.
    const wants = await todosAbout(id);
    expect(wants.map((t) => [t.title, t.owner, t.state])).toEqual([
      ["Attach Cedar Point Dental's signed contract", "operator", "open"],
      ["Record Cedar Point Dental's agreed price", "operator", "open"],
    ]);
    expect(wants[0]?.dueAt?.toISOString().slice(0, 10)).toBe(inDays(7));
    await ok("PATCH", `/api/ops/deals/${id}`, { stage: "proposal" });
    await ok("PATCH", `/api/ops/deals/${id}`, { stage: "setup" });
    expect(await todosAbout(id)).toHaveLength(2);
    // Recording the price closes its to-do.
    await ok("POST", `/api/ops/deals/${id}/terms`, { agreedMrr: "1750", from: inDays(0) });
    const after = await todosAbout(id);
    expect(after.find((t) => t.title.startsWith("Record"))?.state).toBe("done");
    expect(after.find((t) => t.title.startsWith("Attach"))?.state).toBe("open");
  });

  it("logs every client made elsewhere in Sales, once", async () => {
    // New client, with no deal for the company: a New account deal at Set up the account.
    const made = await ok<{ client: { id: string }; sales: { dealId: string; fileId: string } }>(
      "POST",
      "/api/ops/clients",
      { name: "Harbor Supply" },
    );
    const opened = await ok<DealDetail>("GET", `/api/ops/deals/${made.sales.dealId}`);
    expect(opened.deal).toMatchObject({
      kind: "new",
      stage: "setup",
      client: { id: made.client.id, name: "Harbor Supply" },
      fileId: made.sales.fileId,
    });
    expect(opened.activity.map((a) => a.body)).toEqual([
      "Opened at Set up the account.",
      "Skipped Proposal and contract: signed up directly.",
      "Skipped Diagnostic: signed up directly.",
      "Skipped Qualified: signed up directly.",
      "Skipped Lead: signed up directly.",
    ]);
    expect((await todosAbout(made.sales.dealId)).map((t) => t.title)).toEqual([
      "Attach Harbor Supply's signed contract",
      "Record Harbor Supply's agreed price",
      "What are we starting with for Harbor Supply?",
    ]);
    const file = await ok<ClientFileDetail>("GET", `/api/ops/client-files/${made.sales.fileId}`);
    expect(file.file).toMatchObject({ status: "client", client: { id: made.client.id } });
    expect(file.deals.map((d) => d.id)).toEqual([made.sales.dealId]);

    // A company with an open deal, its name typed again: nothing is linked by name alone (review);
    // a deal of its own is opened and the operator gets a to-do to check.
    const lead = await ok<DealDetail>("POST", "/api/ops/deals", {
      kind: "new",
      company: "Juniper Foods",
      title: "Invoice review",
      mrr: "1200",
      stage: "qualified",
      agentsSold: [{ name: "Invoice review", templateId: null }],
    });
    const juniper = await ok<{ client: { id: string }; sales: { dealId: string; fileId: string } }>(
      "POST",
      "/api/ops/clients",
      { name: "juniper foods" },
    );
    expect(juniper.sales.dealId).not.toBe(lead.deal.id);
    expect(juniper.sales.fileId).not.toBe(lead.deal.fileId);
    const stayed = await ok<DealDetail>("GET", `/api/ops/deals/${lead.deal.id}`);
    expect(stayed.deal).toMatchObject({ stage: "qualified", client: null });
    const deals = await H.t.db.select().from(deal).where(eq(deal.clientId, juniper.client.id));
    expect(deals).toHaveLength(1);
    const [check] = await H.t.db
      .select({ title: todo.title, aboutKind: todo.aboutKind, aboutId: todo.aboutId })
      .from(todo)
      .where(eq(todo.dedupeKey, `client:${juniper.client.id}:same-name`));
    expect(check).toEqual({
      title: "Check whether juniper foods is the juniper foods already in Sales",
      aboutKind: "client",
      aboutId: juniper.client.id,
    });
    // Named, the deal moves there: Invite and Sign up now name what they found and say so.
    const lead2 = await ok<DealDetail>("POST", "/api/ops/deals", {
      kind: "new",
      company: "Birch Hardware",
      title: "Invoice review",
      mrr: "900",
      stage: "qualified",
    });
    const birch = await ok<{ client: { id: string }; sales: { dealId: string; fileId: string } }>(
      "POST",
      "/api/ops/clients",
      { name: "Birch Hardware", sales: { dealId: lead2.deal.id } },
    );
    expect(birch.sales).toEqual({ dealId: lead2.deal.id, fileId: lead2.deal.fileId });
  });

  it("seeds the starts once, and saves and archives the operator's own", async () => {
    const first = await ok<{ starts: SalesStartView[] }>("GET", "/api/ops/starts");
    const names = first.starts.filter((s) => s.seeded).map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "General only",
        "Purchasing",
        "Bookkeeping",
        "Marketing",
        "Vendor contracts",
        "Just the account",
      ]),
    );
    // Areas without a pack and the platform's own templates get none.
    expect(names).not.toContain("Sales");
    expect(names).not.toContain("Receivables");
    const again = await ok<{ starts: SalesStartView[] }>("GET", "/api/ops/starts");
    expect(again.starts).toHaveLength(first.starts.length);
    const account = first.starts.find((s) => s.name === "Just the account");
    expect(account?.covers).toEqual({ general: false, areas: [], templateIds: [] });
    const vendor = first.starts.find((s) => s.name === "Vendor contracts");
    expect(vendor?.covers).toEqual({ general: true, areas: [], templateIds: [templateId] });

    const mine = await ok<{ start: SalesStartView }>("POST", "/api/ops/starts", {
      name: "Purchasing starter",
      covers: { general: true, areas: ["purchasing"], templateIds: [templateId] },
      note: "A few questions about how bills reach you.",
    });
    expect(mine.start).toMatchObject({ seeded: false, archived: false, startMode: "point" });
    expect(
      (
        await call("POST", "/api/ops/starts", {
          name: "Nope",
          covers: { general: false, areas: [], templateIds: [crypto.randomUUID()] },
        })
      ).status,
    ).toBe(422);
    await ok("PATCH", `/api/ops/starts/${mine.start.id}`, { archived: true });
    const live = await ok<{ starts: SalesStartView[] }>("GET", "/api/ops/starts");
    expect(live.starts.map((s) => s.id)).not.toContain(mine.start.id);
    const all = await ok<{ starts: SalesStartView[] }>("GET", "/api/ops/starts?archived=true");
    expect(all.starts.find((s) => s.id === mine.start.id)?.archived).toBe(true);
  });

  it("signs up a company in one confirm: the client, its admin, the intake, a build, the deal", async () => {
    const starts = (await ok<{ starts: SalesStartView[] }>("GET", "/api/ops/starts")).starts;
    const vendor = starts.find((s) => s.name === "Vendor contracts") as SalesStartView;
    // What we know about Acme: one fact about their business, one note of ours.
    const file = await ok<ClientFileDetail>("POST", "/api/ops/client-files", {
      name: "Acme Supplies",
    });
    await ok("POST", `/api/ops/client-files/${file.file.id}/facts`, {
      facts: [
        { section: "notes", text: "Price sensitive; the CFO decides", sourceKind: "note" },
        {
          section: "people",
          text: "Dana runs accounts payable",
          sourceKind: "call",
          audience: "theirs",
        },
      ],
    });
    const body = {
      fileId: file.file.id,
      person: { name: "Dana Ruiz", email: "dana@acme-supplies.example.com" },
      startId: vendor.id,
      agreedMrr: "1500",
    };
    const preview = await ok<InvitePreview>("POST", "/api/ops/onboarding/sign-up/preview", body);
    expect(preview.problems).toEqual([]);
    expect(preview.confirm).toEqual([
      "Makes Acme Supplies a client in Mezonas, with you serving it.",
      "Invites Dana Ruiz as its admin.",
      "Adds Vendor contracts (on the bench, approvals on) and opens its build.",
      "Opens the intake (general, 1 agent).",
      "Opens a New account deal at Set up the account.",
      "Records the agreed price: $1,500 a month.",
      // No Resend in this harness: our email can't go, so the sign-in provider's does (review).
      "Emails Dana the sign-in invitation (our own email isn't set up here).",
      "Adds a to-do on Your call.",
    ]);
    expect(preview.todos).toEqual([
      { title: "Attach Acme Supplies's signed contract", dueOn: inDays(7) },
    ]);
    // Nothing of ours to preview; onboarding-flow.test.ts previews and sends one through Resend.
    expect(preview.emails).toEqual([]);
    expect(preview.welcome).toMatchObject({ client: "Acme Supplies", email: body.person.email });
    // Only `theirs` facts reach the guide; our note never does.
    expect(JSON.stringify(preview.intake?.guide)).toContain("Dana runs accounts payable");
    expect(JSON.stringify(preview)).not.toContain("Price sensitive");
    // The preview changed nothing.
    expect(await H.t.db.select().from(tenant).where(eq(tenant.name, "Acme Supplies"))).toEqual([]);

    const sent = await ok<InviteSent>("POST", "/api/ops/onboarding/sign-up", body);
    expect(sent).toMatchObject({ fileId: file.file.id, buildIds: [expect.any(String)] });
    expect(sent.agentIds).toHaveLength(1);
    // The operator serves the client; Dana is its admin.
    const members = await H.t.db
      .select({ role: membership.role })
      .from(membership)
      .where(eq(membership.tenantId, sent.clientId));
    expect(members.map((m) => m.role).sort()).toEqual(["client_admin", "operator"]);
    // The intake holds the guide with only their facts, and Dana's invite is queued.
    const [row] = await H.t.db
      .select()
      .from(intake)
      .where(eq(intake.id, sent.intakeId as string));
    expect(row).toMatchObject({
      tenantId: sent.clientId,
      dealId: sent.dealId,
      fileId: file.file.id,
      status: "sent",
      startMode: "point",
    });
    expect(JSON.stringify(row?.guide)).toContain("Dana runs accounts payable");
    expect(JSON.stringify(row?.guide)).not.toContain("Price sensitive");
    const people = await H.t.db
      .select()
      .from(intakePerson)
      .where(eq(intakePerson.intakeId, row?.id as string));
    expect(people).toMatchObject([{ email: body.person.email, isAdmin: true, sections: null }]);
    expect(people[0]?.userId).toBe(sent.people[0]?.userId);
    const queued = await H.t.db
      .select()
      .from(notification)
      .where(eq(notification.tenantId, sent.clientId));
    // No Resend in this harness: no email of ours is queued (the sign-in provider's invitation
    // went instead), so nobody is left waiting on one that can't go.
    expect(queued.filter((n) => n.kind === "intake_invite")).toEqual([]);
    expect(sent.emails).toEqual([]);
    const events = await H.t.db
      .select()
      .from(intakeEvent)
      .where(eq(intakeEvent.intakeId, row?.id as string));
    expect(events.map((e) => e.kind)).toEqual([]);
    // The build is the deal's, from the template, at the client.
    const [b] = await H.t.db
      .select()
      .from(build)
      .where(eq(build.id, sent.buildIds[0] as string));
    expect(b).toMatchObject({ clientId: sent.clientId, originKind: "deal", originId: sent.dealId });
    // The deal: at Set up the account, the stages before it skipped, the price recorded.
    const d = await ok<DealDetail>("GET", `/api/ops/deals/${sent.dealId}`);
    expect(d.deal).toMatchObject({
      stage: "setup",
      title: "Vendor contracts",
      agreedMrr: "1500.0000",
      fileId: file.file.id,
      agentsSold: [{ name: "Vendor contracts", templateId }],
    });
    const lines = d.activity.map((a) => a.body);
    expect(lines).toContain("Skipped Qualified: signed up directly.");
    expect(lines).toContain("Signed up Dana Ruiz; opened the intake (general, 1 agent).");
    expect(lines[0]).toBe("Opened 1 build at Requirements request.");
    expect((await todosAbout(sent.dealId as string)).map((t) => t.title)).toEqual([
      "Attach Acme Supplies's signed contract",
    ]);
    // The file is the client's now.
    const after = await ok<ClientFileDetail>("GET", `/api/ops/client-files/${file.file.id}`);
    expect(after.file.client?.id).toBe(sent.clientId);
    expect(after.intakes.map((i) => i.id)).toEqual([sent.intakeId]);
    // The same company twice: it is a client now, so the person is already in it.
    const twice = await ok<InvitePreview>("POST", "/api/ops/onboarding/sign-up/preview", body);
    expect(twice.account.clientId).toBe(sent.clientId);
  });

  it("refuses an operator's address and someone in another client", async () => {
    const draft = (email: string) => ({
      company: "Bayview Plumbing",
      people: [{ name: "Pat", email, isAdmin: true }],
      covers: { general: true, areas: [], templateIds: [] },
    });
    const op = await ok<InvitePreview>(
      "POST",
      "/api/ops/onboarding/invite/preview",
      draft(OTHER_OPERATOR),
    );
    expect(op.problems.map((p) => p.code)).toEqual(["is_operator"]);
    const other = await ok<InvitePreview>(
      "POST",
      "/api/ops/onboarding/invite/preview",
      draft(admin("b")),
    );
    expect(other.problems.map((p) => p.code)).toEqual(["other_client"]);
    const res = await call("POST", "/api/ops/onboarding/invite", draft(admin("b")));
    expect(res.status).toBe(422);
    expect(await H.t.db.select().from(tenant).where(eq(tenant.name, "Bayview Plumbing"))).toEqual(
      [],
    );
  });

  it("invites more people to an existing client and moves its expansion to Agreed", async () => {
    const grow = await ok<DealDetail>("POST", "/api/ops/deals", {
      kind: "expansion",
      clientId: H.A.tenantId,
      title: "Bookkeeping",
      mrr: "700",
      stage: "pitch",
    });
    const sent = await ok<InviteSent>("POST", "/api/ops/onboarding/invite", {
      clientId: H.A.tenantId,
      people: [
        { name: "Client A admin", email: admin("a") },
        { name: "Lee Park", email: "lee@a.example.com", sections: ["area:bookkeeping"] },
      ],
      covers: { general: false, areas: ["bookkeeping"], templateIds: [] },
      note: "A few questions about your books.",
    });
    expect(sent).toMatchObject({ clientId: H.A.tenantId, dealId: grow.deal.id, buildIds: [] });
    const lee = await H.t.db
      .select({ role: membership.role })
      .from(membership)
      .innerJoin(appUser, eq(appUser.id, membership.userId))
      .where(and(eq(membership.tenantId, H.A.tenantId), eq(appUser.email, "lee@a.example.com")));
    expect(lee).toEqual([{ role: "client_user" }]);
    const d = await ok<DealDetail>("GET", `/api/ops/deals/${grow.deal.id}`);
    expect(d.deal.stage).toBe("agreed");
    expect(d.activity.map((a) => a.body)).toContain(
      "Skipped Offered: invited to set up the account.",
    );
    expect((await todosAbout(grow.deal.id)).map((t) => t.title)).toEqual([
      "Record Client A's agreed price",
    ]);
    const persons = await H.t.db
      .select()
      .from(intakePerson)
      .where(eq(intakePerson.intakeId, sent.intakeId as string))
      .orderBy(asc(intakePerson.email));
    expect(persons.map((p) => [p.email, p.sections])).toEqual([
      [admin("a"), null],
      ["lee@a.example.com", ["area:bookkeeping"]],
    ]);
    // Another operator can't invite to a client it doesn't serve.
    expect(
      (
        await call(
          "POST",
          "/api/ops/onboarding/invite/preview",
          {
            clientId: H.A.tenantId,
            people: [{ name: "X", email: "x@a.example.com" }],
            covers: { general: true, areas: [], templateIds: [] },
          },
          OTHER_OPERATOR,
        )
      ).status,
    ).toBe(404);
  });

  it("makes just the account: no intake, and a to-do for what we're starting with", async () => {
    const starts = (await ok<{ starts: SalesStartView[] }>("GET", "/api/ops/starts")).starts;
    const account = starts.find((s) => s.name === "Just the account") as SalesStartView;
    const sent = await ok<InviteSent>("POST", "/api/ops/onboarding/sign-up", {
      company: "Northside Bakery",
      person: { name: "Sam Lee", email: "sam@northside.example.com" },
      startId: account.id,
    });
    expect(sent).toMatchObject({ intakeId: null, buildIds: [], emails: [] });
    expect((await todosAbout(sent.dealId as string)).map((t) => t.title)).toEqual([
      "Attach Northside Bakery's signed contract",
      "Record Northside Bakery's agreed price",
      "What are we starting with for Northside Bakery?",
    ]);
    const lines = await H.t.db
      .select({ body: dealActivity.body })
      .from(dealActivity)
      .where(eq(dealActivity.dealId, sent.dealId as string));
    expect(lines.map((l) => l.body)).toContain("Signed up Sam Lee.");
  });
});

// A Worker's request has one database connection: Sign up now opens no transaction beside another.
const one = await createApiHarness({ appDbMax: 1 });
afterAll(() => one?.close());

describe.skipIf(!one)("Sign up now on one connection", () => {
  it("makes the client, its intake and its deal without waiting on itself", async () => {
    const O = one as NonNullable<typeof one>;
    const starts = await O.call(OPERATOR, "GET", "/api/ops/starts");
    const general = (starts.json as { starts: SalesStartView[] }).starts.find(
      (s) => s.name === "General only",
    ) as SalesStartView;
    const res = await O.call(OPERATOR, "POST", "/api/ops/onboarding/sign-up", {
      company: "Pine Ridge Farms",
      person: { name: "Ola Berg", email: "ola@pineridge.example.com" },
      startId: general.id,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((res.json as InviteSent).intakeId).toEqual(expect.any(String));
  }, 20_000);
});
