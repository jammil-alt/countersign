// Onboarding v1 end to end (docs/plan.md §1.149; docs/cases-plan.md §7 O1–O3), every stream's
// real code with nothing stood in: an operator invites a new company from its client file (the
// guide built from core's general section and the Purchasing pack's own, filled from the file's
// `theirs` facts only), the branded invite goes through Resend from the lead at hello@ after the
// commit, its link opens the welcome page without a session, the invited admin signs in and goes
// on to Getting started, answers a card and asks a colleague (our email, not WorkOS's), and the
// back office reads the progress. Sign up now does the same in one confirm and lands the deal at
// Set up the account; lost after that, it leaves a to-do to retire the account.

import type {
  ClientFileDetail,
  DealDetail,
  InvitePreview,
  InviteSent,
  OpsIntakeView,
  PortalIntakeView,
  SalesStartView,
} from "@countersign/core";
import { intakeEvent, notification, todo } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const ORIGIN = "https://app.mezonas.test";

/** What went to Resend: one JSON body per email. */
const resend: Record<string, unknown>[] = [];

const h = await createApiHarness({
  env: {
    ENCRYPTION_KEY: "onboarding-flow-test-key-0123456789",
    APP_ORIGIN: ORIGIN,
    RESEND_API_KEY: "re_test",
    RESEND_FALLBACK_DOMAIN: "mezonas.test",
  },
  fetch: async (url, init) => {
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
  },
});
afterAll(() => h?.close());

describe.skipIf(!h)("onboarding v1, end to end", () => {
  const H = h as ApiHarness;

  const ok = async <R>(who: string | null, method: string, path: string, body?: unknown) => {
    const res = await H.call(who, method, path, body);
    expect(res.status, `${method} ${path}: ${JSON.stringify(res.json)}`).toBe(200);
    return res.json as R;
  };

  /** The welcome link in the email sent to `to`. */
  const linkTo = (to: string): string => {
    const mail = resend.find((m) => JSON.stringify(m.to).includes(to));
    expect(mail, `an email to ${to}`).toBeDefined();
    const match = new RegExp(`${ORIGIN}/start/([\\w-]+\\.[\\w-]+)`).exec(String(mail?.text));
    expect(match, "a welcome link").not.toBeNull();
    return match?.[1] as string;
  };

  it("invites from the file, emails the admin, and takes them through to Getting started", async () => {
    // What we know: one fact about their business, one note of ours.
    const file = await ok<ClientFileDetail>(OPERATOR, "POST", "/api/ops/client-files", {
      name: "Harbor Lumber",
    });
    await ok(OPERATOR, "POST", `/api/ops/client-files/${file.file.id}/facts`, {
      facts: [
        { section: "notes", text: "Watch the CFO; price sensitive", sourceKind: "note" },
        {
          section: "volumes",
          text: "About 340 bills a month",
          sourceKind: "call",
          audience: "theirs",
        },
      ],
    });
    const dana = "dana@harbor-lumber.example.com";
    const draft = {
      fileId: file.file.id,
      people: [{ name: "Dana Ruiz", email: dana, isAdmin: true }],
      covers: { general: true, areas: ["purchasing"], templateIds: [] },
      note: "Dana, good to talk today. Here are the few things we need to start.",
    };
    const preview = await ok<InvitePreview>(
      OPERATOR,
      "POST",
      "/api/ops/onboarding/invite/preview",
      draft,
    );
    expect(preview.problems).toEqual([]);
    // Core's general questions and the Purchasing pack's own, "who approves" asked once.
    const keys = preview.intake?.guide.sections.map((s) => s.key);
    expect(keys).toEqual(["general", "area:purchasing"]);
    const approver = preview.intake?.guide.sections
      .flatMap((s) => s.fields)
      .filter((f) => /approv/i.test(f.label));
    expect(approver?.length).toBe(1);
    // Only `theirs` facts reach the guide; our note never leaves the back office.
    expect(JSON.stringify(preview.intake)).toContain("About 340 bills a month");
    expect(JSON.stringify(preview)).not.toContain("price sensitive");
    expect(resend).toEqual([]);

    const sent = await ok<InviteSent>(OPERATOR, "POST", "/api/ops/onboarding/invite", draft);
    await H.settle();
    expect(sent.emails).toEqual([{ to: dana, status: "queued" }]);
    // One email, from the lead at hello@, sent after the commit.
    const mails = resend.filter((m) => JSON.stringify(m.to).includes(dana));
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      from: '"Operator at Mezonas" <hello@mezonas.test>',
      reply_to: OPERATOR,
    });
    expect(String(mails[0]?.text)).toContain("Dana, good to talk today.");
    expect(String(mails[0]?.text)).not.toContain("price sensitive");
    const [row] = await H.t.db
      .select()
      .from(notification)
      .where(and(eq(notification.tenantId, sent.clientId), eq(notification.kind, "intake_invite")));
    expect(row?.status).toBe("sent");
    // The intake logs it once.
    const sentEvents = await H.t.db
      .select()
      .from(intakeEvent)
      .where(and(eq(intakeEvent.intakeId, sent.intakeId as string), eq(intakeEvent.kind, "sent")));
    expect(sentEvents.map((e) => e.meta)).toMatchObject([{ email: "invite", status: "sent" }]);

    // The welcome page opens from the link, without a session.
    const token = linkTo(dana);
    const page = await ok<{ state: string; client: string; email: string }>(
      null,
      "GET",
      `/api/start/${token}`,
    );
    expect(page).toMatchObject({ state: "open", client: "Harbor Lumber", email: dana });
    // The invited address goes on to Getting started.
    expect(await ok(dana, "POST", `/api/start/${token}/signed-in`)).toEqual({
      state: "ok",
      next: "/start",
    });
    const current = await ok<{ intake: PortalIntakeView | null }>(dana, "GET", "/api/intake");
    const view = current.intake as PortalIntakeView;
    expect(view.intake.id).toBe(sent.intakeId);
    expect(view.sections.map((s) => s.key)).toEqual(["general", "area:purchasing"]);
    expect(JSON.stringify(view)).not.toContain("price sensitive");

    // Dana answers the first question on the general card.
    const first = view.sections[0]?.fields.find((f) => f.kind === "text" || f.kind === "long_text");
    expect(first).toBeDefined();
    const answered = await ok<PortalIntakeView>(
      dana,
      "POST",
      `/api/intake/${sent.intakeId}/answers`,
      { answers: [{ fieldKey: first?.key, state: "answered", value: "We sell lumber" }] },
    );
    expect(answered.answers.find((a) => a.fieldKey === first?.key)?.value).toBe("We sell lumber");

    // Ask someone else: a new colleague gets our email, not the sign-in provider's.
    const mark = "mark@harbor-lumber.example.com";
    await ok(dana, "POST", `/api/intake/${sent.intakeId}/ask`, {
      sectionKey: "area:purchasing",
      name: "Mark Lee",
      email: mark,
    });
    await H.settle();
    expect(resend.filter((m) => JSON.stringify(m.to).includes(mark))).toHaveLength(1);
    expect(await ok(mark, "POST", `/api/start/${linkTo(mark)}/signed-in`)).toEqual({
      state: "ok",
      next: "/start",
    });
    const marks = await ok<{ intake: PortalIntakeView | null }>(mark, "GET", "/api/intake");
    expect(marks.intake?.sections.map((s) => s.key)).toEqual(["area:purchasing"]);

    // The back office sees the progress and the log; the deal is at Set up the account.
    const ops = await ok<OpsIntakeView>(OPERATOR, "GET", `/api/ops/intakes/${sent.intakeId}`);
    expect(ops.progress.find((p) => p.sectionKey === "general")?.answered).toBeGreaterThan(0);
    expect(ops.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["sent", "opened", "signed_in", "colleague_invited"]),
    );
    const d = await ok<DealDetail>(OPERATOR, "GET", `/api/ops/deals/${sent.dealId}`);
    expect(d.deal).toMatchObject({ stage: "setup", fileId: file.file.id });
  });

  it("signs up in one confirm from a seeded start, landing the deal at Set up the account", async () => {
    const { starts } = await ok<{ starts: SalesStartView[] }>(OPERATOR, "GET", "/api/ops/starts");
    const purchasing = starts.find((s) => s.covers.areas.includes("purchasing"));
    expect(purchasing).toBeDefined();
    const pat = "pat@bayview.example.com";
    const sent = await ok<InviteSent>(OPERATOR, "POST", "/api/ops/onboarding/sign-up", {
      company: "Bayview Plumbing",
      person: { name: "Pat Kim", email: pat },
      startId: purchasing?.id,
    });
    await H.settle();
    expect(resend.filter((m) => JSON.stringify(m.to).includes(pat))).toHaveLength(1);
    const d = await ok<DealDetail>(OPERATOR, "GET", `/api/ops/deals/${sent.dealId}`);
    expect(d.deal.stage).toBe("setup");
    expect(d.activity.map((a) => a.body)).toContain("Skipped Qualified: signed up directly.");
    const page = await ok<{ state: string }>(null, "GET", `/api/start/${linkTo(pat)}`);
    expect(page.state).toBe("open");

    // Lost after we made the account: a to-do to retire it (q14).
    await ok(OPERATOR, "POST", `/api/ops/deals/${sent.dealId}/outcome`, { outcome: "lost" });
    const retire = await H.t.db
      .select()
      .from(todo)
      .where(
        and(eq(todo.clientId, sent.clientId), eq(todo.dedupeKey, `deal:${sent.dealId}:retire`)),
      );
    expect(retire).toMatchObject([
      { title: "Retire Bayview Plumbing's account", owner: "operator", state: "open" },
    ]);
  });
  it("sends our own welcome for Just the account: an intake that covers nothing, one email", async () => {
    const { starts } = await ok<{ starts: SalesStartView[] }>(OPERATOR, "GET", "/api/ops/starts");
    const account = starts.find((s) => s.name === "Just the account");
    expect(account).toBeDefined();
    const sam = "sam@northside.example.com";
    const draft = {
      company: "Northside Bakery",
      person: { name: "Sam Lee", email: sam },
      startId: account?.id,
    };
    const preview = await ok<{ confirm: string[]; emails: { subject: string; text: string }[] }>(
      OPERATOR,
      "POST",
      "/api/ops/onboarding/sign-up/preview",
      draft,
    );
    expect(preview.confirm).toContain("Emails Sam our welcome, with a link to sign in.");
    expect(preview.emails).toHaveLength(1);
    expect(preview.emails[0]?.text).toContain("What's in it: Your account.");

    const sent = await ok<InviteSent>(OPERATOR, "POST", "/api/ops/onboarding/sign-up", draft);
    expect(sent.intakeId).toEqual(expect.any(String));
    expect(sent.emails).toEqual([{ to: sam, status: "queued" }]);
    await H.settle();
    const mails = resend.filter((m) => JSON.stringify(m.to).includes(sam));
    expect(mails).toHaveLength(1);
    expect(String(mails[0]?.from)).toContain("at Mezonas");
    expect(String(mails[0]?.from)).toContain("<hello@mezonas.test>");
    expect(String(mails[0]?.text)).toContain("Your Mezonas account for Northside Bakery is ready.");
    const page = await ok<{ state: string; summary: unknown }>(
      null,
      "GET",
      `/api/start/${linkTo(sam)}`,
    );
    expect(page).toMatchObject({
      state: "open",
      summary: { general: false, areas: [], agents: 0, minutes: 0 },
    });
    // It is still Just the account: nothing to answer, and the to-do for what we start with.
    const view = await ok<OpsIntakeView>(OPERATOR, "GET", `/api/ops/intakes/${sent.intakeId}`);
    expect(view.intake.covers).toEqual({ general: false, areas: [], templateIds: [] });
    expect(view.guide.sections).toEqual([]);
  });
});
