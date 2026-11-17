// Onboarding v1's review fixes (docs/plan.md §1.149.6), each on the real code with a fake Resend:
// one intake per client (a later Invite adds its cards and tells the people already on it), the
// HIPAA refusal of onboarding's emails (invariant 14) and the to-do an email that didn't go
// leaves, a colleague asked twice is emailed twice, a typed company that is already a client is
// stopped, an agreed price on an existing client opens its Expansion deal, the price's to-do
// closes once recorded, and a template's mission never reaches the client's intake (invariant 11).

import type { DealDetail, InvitePreview, InviteSent, SalesStartView } from "@countersign/core";
import {
  agent,
  agentVersion,
  deal,
  intake,
  intakeEvent,
  intakePerson,
  notification,
  tenant,
  todo,
  withOperator,
} from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR } from "./api.test-helper";
import type { Bindings } from "./env";
import { notifyDepsFromEnv, sendNow } from "./notify/tick";
import { templateCards } from "./onboarding/guide-sources";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const ORIGIN = "https://app.mezonas.test";
const ENV = {
  ENCRYPTION_KEY: "onboarding-review-test-key-0123456789",
  APP_ORIGIN: ORIGIN,
  RESEND_API_KEY: "re_test",
  RESEND_FALLBACK_DOMAIN: "mezonas.test",
};

/** What went to Resend: one JSON body per email. */
const resend: Record<string, unknown>[] = [];
const fakeFetch = async (url: unknown, init?: { body?: unknown }) => {
  if (!String(url).includes("resend")) throw new Error(`no network in tests: ${String(url)}`);
  resend.push(JSON.parse(String(init?.body)));
  const body = JSON.stringify({ id: `re_${resend.length}` });
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as never;
};

const h = await createApiHarness({ env: ENV, fetch: fakeFetch as never });
afterAll(() => h?.close());

const mailsTo = (to: string) => resend.filter((m) => JSON.stringify(m.to).includes(to));

describe.skipIf(!h)("onboarding v1's review fixes", () => {
  const H = h as ApiHarness;

  const ok = async <R>(who: string | null, method: string, path: string, body?: unknown) => {
    const res = await H.call(who, method, path, body);
    expect(res.status, `${method} ${path}: ${JSON.stringify(res.json)}`).toBe(200);
    return res.json as R;
  };
  const clientName = async (id: string) =>
    (await H.t.db.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, id)))[0]?.name;

  it("adds a later Invite's cards to the open intake and tells the people on it", async () => {
    const A = H.A.tenantId;
    const name = await clientName(A);
    const first = await ok<InviteSent>(OPERATOR, "POST", "/api/ops/onboarding/invite", {
      clientId: A,
      people: [{ name: "A admin", email: admin("a"), isAdmin: true }],
      covers: { general: true, areas: [], templateIds: [] },
      note: "",
    });
    await H.settle();
    expect(mailsTo(admin("a"))).toHaveLength(1);

    const later = {
      clientId: A,
      people: [{ name: "Rae North", email: "rae@a.example.com", isAdmin: false }],
      covers: { general: false, areas: ["purchasing"], templateIds: [] },
      note: "Two more things on purchasing.",
    };
    const preview = await ok<InvitePreview>(
      OPERATOR,
      "POST",
      "/api/ops/onboarding/invite/preview",
      later,
    );
    expect(preview.problems).toEqual([]);
    expect(preview.confirm).toContain(`Adds Purchasing to ${name}'s open intake.`);
    expect(preview.confirm).toContain("Emails A a few more questions.");
    expect(preview.emails.map((e) => [e.to, e.kind])).toEqual([
      ["rae@a.example.com", "invite"],
      [admin("a"), "more_questions"],
    ]);

    const second = await ok<InviteSent>(OPERATOR, "POST", "/api/ops/onboarding/invite", later);
    await H.settle();
    // One intake: the same one, now covering both.
    expect(second.intakeId).toBe(first.intakeId);
    const open = await H.t.db
      .select()
      .from(intake)
      .where(and(eq(intake.tenantId, A), eq(intake.status, "sent")));
    expect(open.map((i) => i.id)).toContain(first.intakeId);
    const [row] = await H.t.db
      .select()
      .from(intake)
      .where(eq(intake.id, first.intakeId as string));
    expect(row?.covers).toMatchObject({ general: true, areas: ["purchasing"] });
    const people = await H.t.db
      .select({ email: intakePerson.email })
      .from(intakePerson)
      .where(eq(intakePerson.intakeId, first.intakeId as string));
    expect(people.map((p) => p.email).sort()).toEqual([admin("a"), "rae@a.example.com"]);
    // The admin hears of the new card; Rae gets the invite.
    const told = mailsTo(admin("a"));
    expect(told).toHaveLength(2);
    expect(String(told[1]?.text)).toContain("Two more things on purchasing.");
    expect(mailsTo("rae@a.example.com")).toHaveLength(1);
    // Getting started shows both cards on the one intake.
    const current = await ok<{ intake: { intake: { id: string }; sections: { key: string }[] } }>(
      admin("a"),
      "GET",
      "/api/intake",
    );
    expect(current.intake.intake.id).toBe(first.intakeId);
    expect(current.intake.sections.map((s) => s.key)).toEqual(["general", "area:purchasing"]);

    // A colleague asked twice is emailed twice; each ask is its own email.
    const rae = "rae@a.example.com";
    const before = mailsTo(rae).length;
    for (const sectionKey of ["general", "area:purchasing"]) {
      const asked = await ok<{ emailed: boolean }>(
        admin("a"),
        "POST",
        `/api/intake/${first.intakeId}/ask`,
        { sectionKey, name: "Rae North", email: rae },
      );
      expect(asked.emailed).toBe(true);
      await H.settle();
    }
    expect(mailsTo(rae)).toHaveLength(before + 2);
  });

  it("refuses onboarding's emails to a client in HIPAA mode, and leaves a to-do for one queued", async () => {
    const B = H.B.tenantId;
    // Sent later, before HIPAA mode is turned on: queued, waiting for its time.
    const at = new Date(Date.now() + 2 * 86_400_000);
    const sent = await ok<InviteSent>(OPERATOR, "POST", "/api/ops/onboarding/invite", {
      clientId: B,
      people: [{ name: "B admin", email: admin("b"), isAdmin: true }],
      covers: { general: true, areas: [], templateIds: [] },
      note: "",
      sendAt: at.toISOString(),
    });
    expect(sent.emails).toEqual([{ to: admin("b"), status: "scheduled" }]);
    await H.t.db
      .update(tenant)
      .set({ settings: sql`${tenant.settings} || '{"compliance":{"hipaa":true}}'::jsonb` })
      .where(eq(tenant.id, B));

    // Invite says so before anything is made.
    const preview = await ok<InvitePreview>(
      OPERATOR,
      "POST",
      "/api/ops/onboarding/invite/preview",
      {
        clientId: B,
        people: [{ name: "Lou Park", email: "lou@b.example.com", isAdmin: false }],
        covers: { general: false, areas: ["purchasing"], templateIds: [] },
        note: "",
      },
    );
    expect(preview.problems.map((p) => p.code)).toEqual(["hipaa"]);
    expect(preview.problems[0]?.message).toContain("Resend");
    // So does Ask someone else.
    const ask = await H.call(admin("b"), "POST", `/api/intake/${sent.intakeId}/ask`, {
      sectionKey: "general",
      name: "Lou Park",
      email: "lou@b.example.com",
    });
    expect(ask.status).toBe(409);
    expect((ask.json as { error: { code: string } }).error.code).toBe("hipaa");

    // The queued invite, once due, is skipped `hipaa`: nothing goes to Resend, the lead gets a to-do.
    const was = mailsTo(admin("b")).length;
    await sendNow(
      H.db,
      notifyDepsFromEnv({ ...H.env, ...ENV } as Bindings, fakeFetch as never),
      B,
      new Date(at.getTime() + 60_000),
    );
    expect(mailsTo(admin("b"))).toHaveLength(was);
    const [row] = await H.t.db
      .select()
      .from(notification)
      .where(and(eq(notification.tenantId, B), eq(notification.kind, "intake_invite")));
    expect(row).toMatchObject({ status: "skipped", reason: "hipaa" });
    const logged = await H.t.db
      .select({ meta: intakeEvent.meta })
      .from(intakeEvent)
      .where(and(eq(intakeEvent.intakeId, sent.intakeId as string), eq(intakeEvent.kind, "sent")));
    expect(logged.map((e) => e.meta)).toMatchObject([{ status: "skipped", reason: "hipaa" }]);
    const todos = await H.t.db
      .select()
      .from(todo)
      .where(eq(todo.dedupeKey, `intake-unsent:${row?.id}`));
    expect(todos).toMatchObject([
      {
        title: `The invite to B admin at ${await clientName(B)} didn't go out`,
        owner: "operator",
        clientId: B,
        state: "open",
      },
    ]);
  });

  it("stops a typed company that is already a client, so a retry never makes a second", async () => {
    const { starts } = await ok<{ starts: SalesStartView[] }>(OPERATOR, "GET", "/api/ops/starts");
    const general = starts.find((s) => s.name === "General only") as SalesStartView;
    const body = {
      company: "Cedar Mills",
      person: { name: "Ana Ruiz", email: "ana@cedar-mills.example.com" },
      startId: general.id,
    };
    await ok<InviteSent>(OPERATOR, "POST", "/api/ops/onboarding/sign-up", body);
    const again = {
      ...body,
      company: " cedar mills ",
      person: { ...body.person, email: "x@cedar-mills.example.com" },
    };
    const preview = await ok<InvitePreview>(
      OPERATOR,
      "POST",
      "/api/ops/onboarding/sign-up/preview",
      again,
    );
    expect(preview.problems).toMatchObject([{ code: "client_exists" }]);
    const res = await H.call(OPERATOR, "POST", "/api/ops/onboarding/sign-up", again);
    expect(res.status).toBe(422);
    const named = await H.t.db
      .select()
      .from(tenant)
      .where(sql`lower(btrim(${tenant.name})) = 'cedar mills'`);
    expect(named).toHaveLength(1);
  });

  it("opens an existing client's Expansion deal at Agreed for a price with Just the account", async () => {
    // Client A: served here, its open deal an Expansion deal (the Invites above opened it).
    const C = H.A.tenantId;
    const { starts } = await ok<{ starts: SalesStartView[] }>(OPERATOR, "GET", "/api/ops/starts");
    const account = starts.find(
      (s) => !s.covers.general && s.covers.areas.length === 0 && s.covers.templateIds.length === 0,
    ) as SalesStartView;
    const sent = await ok<InviteSent>(OPERATOR, "POST", "/api/ops/onboarding/sign-up", {
      clientId: C,
      person: { name: "Kit Moss", email: "kit@a.example.com" },
      startId: account.id,
      agreedMrr: "500",
    });
    expect(sent.intakeId).toBeNull();
    expect(sent.dealId).not.toBeNull();
    const [d] = await H.t.db
      .select()
      .from(deal)
      .where(eq(deal.id, sent.dealId as string));
    expect(d).toMatchObject({ kind: "expansion", stage: "agreed", clientId: C });
    expect(Number(d?.agreedMrr)).toBe(500);
  });

  it("closes the price's to-do once Invite records the price, and promises no to-do it has", async () => {
    const made = await ok<{ client: { id: string }; sales: { dealId: string } }>(
      OPERATOR,
      "POST",
      "/api/ops/clients",
      { name: "Elm Supply" },
    );
    const openTitles = async () =>
      (
        await H.t.db
          .select({ title: todo.title })
          .from(todo)
          .where(and(eq(todo.aboutId, made.sales.dealId), eq(todo.state, "open")))
      ).map((t) => t.title);
    expect(await openTitles()).toContain("Record Elm Supply's agreed price");
    const draft = {
      clientId: made.client.id,
      people: [{ name: "Joe Elm", email: "joe@elm-supply.example.com", isAdmin: true }],
      covers: { general: true, areas: [], templateIds: [] },
      note: "",
      agreedMrr: "2400",
    };
    const preview = await ok<InvitePreview>(
      OPERATOR,
      "POST",
      "/api/ops/onboarding/invite/preview",
      draft,
    );
    // The signed copy's to-do is there already: not promised again.
    expect(preview.todos).toEqual([]);
    expect(preview.confirm.some((l) => l.includes("to-do"))).toBe(false);
    const sent = await ok<InviteSent>(OPERATOR, "POST", "/api/ops/onboarding/invite", draft);
    expect(sent.dealId).toBe(made.sales.dealId);
    expect(await openTitles()).not.toContain("Record Elm Supply's agreed price");
    const detail = await ok<DealDetail>(OPERATOR, "GET", `/api/ops/deals/${made.sales.dealId}`);
    expect(Number(detail.deal.agreedMrr)).toBe(2400);
  });

  it("describes a template's card in its client-facing words, never its mission", async () => {
    const [t] = await H.t.db
      .insert(agent)
      .values({
        tenantId: null,
        kind: "template",
        slug: "review-mission-check",
        name: "Mission check",
        serviceDescription: "Checks each bill against the contract.",
      })
      .returning();
    const [v] = await H.t.db
      .insert(agentVersion)
      .values({
        agentId: t?.id as string,
        version: 1,
        bundle: {
          definition: { identity: { mission: "Never mention the rebate tier to the client." } },
        } as never,
        bundleHash: "review-mission-check",
        status: "live",
        authorType: "operator",
      })
      .returning();
    await H.t.db
      .update(agent)
      .set({ liveVersionId: v?.id as string })
      .where(eq(agent.id, t?.id as string));
    const cards = await withOperator(H.db, [H.A.tenantId], (tx) =>
      templateCards(tx, H.platform, [t?.id as string]),
    );
    expect(cards.map((c) => c.description)).toEqual(["Checks each bill against the contract."]);
    expect(JSON.stringify(cards)).not.toContain("rebate tier");
  });
});
