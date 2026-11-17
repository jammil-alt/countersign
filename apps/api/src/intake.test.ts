// Getting started through the API (docs/plan.md §1.126.2; docs/cases-plan.md §4.5): a client's
// people read only the cards they were asked (all of them for the admin), answer them, confirm or
// change "We think" lines, mark not sure, say Start with this or Not now, ask a colleague (the
// admin invites a new address, with our own email, never WorkOS's) and raise a different process
// as an ask to the lead. Another client's intake is not found; the portal never sees a fact's id
// or a question's origin; pasted card numbers are redacted; the back office reads the progress.
// The guide's sources come from core, the packs' manifests and a template's build.

import {
  agentSectionKey,
  buildGuide,
  type Guide,
  type OpsIntakeView,
  type PortalIntakeView,
} from "@countersign/core";
import {
  agent,
  appUser,
  build,
  clientAsk,
  connection,
  intake,
  intakeAnswer,
  intakeEvent,
  intakePerson,
  membership,
  withOperator,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, OPERATOR, OTHER_OPERATOR, user } from "./api.test-helper";
import { guideSources } from "./onboarding/guide-sources";

// The colleague's email is stream EMAIL's (queued in the outbox); here, what it's called with.
const sendOnboardingEmail = vi.hoisted(() =>
  vi.fn(async () => ({ notificationId: null, status: "queued" as const })),
);
vi.mock("./onboarding/emails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboarding/emails")>()),
  sendOnboardingEmail,
}));

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

// Our email can go from here (Resend set up), so the sign-in provider sends nothing of its own.
const h = await createApiHarness({
  env: { RESEND_API_KEY: "re_test", RESEND_FALLBACK_DOMAIN: "mezonas.test" },
});
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

describe.skipIf(!h)("Getting started", () => {
  const H = h as NonNullable<typeof h>;
  const T = crypto.randomUUID();
  let guide: Guide;
  let intakeId: string;
  let operatorId: string;
  const userId: Record<string, string> = {};

  const ok = async <R>(who: string, method: string, path: string, body?: unknown) => {
    const res = await H.call(who, method, path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json as R;
  };

  beforeAll(async () => {
    for (const email of [admin("a"), user("a"), OPERATOR]) {
      const [u] = await H.t.db.select().from(appUser).where(eq(appUser.email, email));
      userId[email] = u?.id as string;
    }
    operatorId = userId[OPERATOR] as string;
    // A template the client is to have, with a client intake form on its build (§1.108).
    await H.t.db.insert(agent).values({
      id: T,
      tenantId: null,
      kind: "template",
      slug: "contracts-check",
      name: "Contracts check",
    });
    await H.t.db.insert(build).values({
      kind: "agent",
      title: "Contracts check",
      agentId: T,
      fitgap: {
        setup: [
          { id: "tol", label: "How far off can a price be?", kind: "answer", hint: "" },
          { id: "files", label: "Your vendor contracts", kind: "file", hint: "" },
        ],
      },
    });
    const covers = { general: true, areas: ["purchasing" as const], templateIds: [T] };
    const sources = await withOperator(H.db, [H.A.tenantId], (tx) =>
      guideSources(tx, { platform: H.platform }, covers),
    );
    guide = buildGuide({
      covers,
      ...sources,
      // The testkit tool, as a template needing it would ask it.
      agents: sources.agents.map((s) => ({
        ...s,
        fields: [
          {
            key: "tool.testkit",
            shareKey: "tool.testkit",
            label: "Connect the test kit",
            kind: "tool",
            connector: "testkit",
            hint: "",
            requiredToStart: true,
          },
          ...s.fields,
        ],
      })),
      facts: [
        {
          id: "0192f0aa-0000-7000-8000-0000000000f1",
          section: "processes",
          text: "ap@acme.com",
          sureness: "heard",
          fieldKey: "purchasing.bills_to",
        },
        {
          id: "0192f0aa-0000-7000-8000-0000000000f2",
          section: "systems",
          text: "They use QuickBooks Online",
          sureness: "seen",
        },
      ],
    });
    const [row] = await H.t.db
      .insert(intake)
      .values({
        tenantId: H.A.tenantId,
        covers,
        guide,
        leadUserId: operatorId,
        leadNote: "Jammil suggested we start with how you handle bills.",
        createdBy: operatorId,
      })
      .returning();
    intakeId = row?.id as string;
    await H.t.db.insert(intakePerson).values([
      {
        tenantId: H.A.tenantId,
        intakeId,
        email: admin("a"),
        name: "Dana Admin",
        sections: null,
        isAdmin: true,
      },
      {
        tenantId: H.A.tenantId,
        intakeId,
        email: user("a"),
        name: "Mark User",
        sections: ["area:purchasing"],
      },
    ]);
  });

  it("reads the guide's sources: core's general, the pack's own area, generic ones, a template's form", async () => {
    expect(guide.sections.map((s) => s.key)).toEqual([
      "general",
      "area:purchasing",
      agentSectionKey(T),
    ]);
    const purchasing = guide.sections[1];
    expect(purchasing?.fields.some((f) => f.key === "purchasing.bills_to")).toBe(true);
    // "Who approves" is the general card's, shared into Purchasing.
    expect(guide.sections[0]?.fields.find((f) => f.key === "general.approver")?.alsoIn).toEqual([
      "area:purchasing",
    ]);
    const agentCard = guide.sections[2];
    expect(agentCard?.fields.map((f) => f.key)).toEqual([
      "tool.testkit",
      "agent.contracts-check.tol",
      "agent.contracts-check.files",
    ]);
    const generic = await withOperator(H.db, [H.A.tenantId], (tx) =>
      guideSources(
        tx,
        { platform: H.platform },
        { general: false, areas: ["sales"], templateIds: [] },
      ),
    );
    expect(generic.general).toBeNull();
    expect(generic.areas[0]?.fields.map((f) => f.key)).toContain("area.sales.today");
  });

  it("shows the client admin every card, with the lead's note and nothing of ours", async () => {
    const { intake: view } = await ok<{ intake: PortalIntakeView }>(
      admin("a"),
      "GET",
      "/api/intake",
    );
    expect(view.intake.leadNote).toContain("bills");
    expect(view.intake.lead?.name).toBe("Operator");
    expect(view.sections.map((s) => s.key)).toHaveLength(3);
    expect(view.you).toMatchObject({ isAdmin: true, sections: null });
    const json = JSON.stringify(view);
    expect(json).not.toContain("factIds");
    expect(json).not.toContain("origin");
    expect(json).not.toContain("0192f0aa-0000-7000-8000-0000000000f1");
    const line = view.sections[0]?.fields.find(
      (f) => f.weThink?.text === "They use QuickBooks Online",
    );
    expect(line?.state).toBe("to_confirm");
  });

  it("shows a client user only the cards they were asked", async () => {
    const { intake: view } = await ok<{ intake: PortalIntakeView }>(
      user("a"),
      "GET",
      "/api/intake",
    );
    expect(view.sections.map((s) => s.key)).toEqual(["area:purchasing"]);
    // "Who approves" is asked on the general card, which isn't theirs: it is on their card.
    expect(view.sections[0]?.fields.find((f) => f.key === "general.approver")?.sectionKey).toBe(
      "general",
    );
    expect(view.sections[0]?.fields.some((f) => f.key === "general.what")).toBe(false);
    expect(view.progress.map((p) => p.sectionKey)).toEqual(["area:purchasing"]);
  });

  it("is not found from another client, and none there", async () => {
    expect(j((await H.call(admin("b"), "GET", "/api/intake")).json).intake).toBeNull();
    expect((await H.call(admin("b"), "GET", `/api/intake/${intakeId}`)).status).toBe(404);
    const answer = await H.call(admin("b"), "POST", `/api/intake/${intakeId}/answers`, {
      answers: [{ fieldKey: "purchasing.bills", state: "answered", value: 1 }],
    });
    expect(answer.status).toBe(404);
    for (const path of ["confirm", "ask", "different-process"]) {
      const res = await H.call(admin("b"), "POST", `/api/intake/${intakeId}/${path}`, {
        ...(path === "different-process"
          ? { text: "x" }
          : path === "ask"
            ? { sectionKey: "general", userId: userId[user("a")] }
            : { sectionKey: "general" }),
      });
      expect(res.status, path).toBe(404);
    }
    // The back office: an operator who doesn't serve client A doesn't find it either.
    expect((await H.call(OTHER_OPERATOR, "GET", `/api/ops/intakes/${intakeId}`)).status).toBe(404);
  });

  it("takes answers to the person's cards, checked by kind, card numbers redacted", async () => {
    const view = await ok<PortalIntakeView>(user("a"), "POST", `/api/intake/${intakeId}/answers`, {
      answers: [
        { fieldKey: "purchasing.bills", state: "answered", value: 340 },
        // Shared into their card: theirs to answer too.
        { fieldKey: "general.approver", state: "answered", value: "Dana, the owner" },
        {
          fieldKey: "purchasing.wrong",
          state: "answered",
          value: "Someone typed 4111 1111 1111 1111 into an email once",
        },
        { fieldKey: "purchasing.vendors", state: "not_sure" },
      ],
    });
    const byKey = new Map(view.answers.map((a) => [a.fieldKey, a]));
    expect(byKey.get("purchasing.bills")).toMatchObject({
      value: 340,
      state: "answered",
      source: "form",
    });
    expect(byKey.get("purchasing.wrong")?.value).toBe(
      "Someone typed [card ending 1111] into an email once",
    );
    expect(byKey.get("purchasing.vendors")).toMatchObject({ state: "not_sure", value: null });
    expect(view.progress[0]).toMatchObject({ answered: 3, notSure: 1 });
    // The first answer opens the intake.
    const [row] = await H.t.db.select().from(intake).where(eq(intake.id, intakeId));
    expect(row?.status).toBe("open");

    // Not their card; a value of the wrong kind; a choice that isn't one.
    for (const [answer, code] of [
      [{ fieldKey: "general.what", state: "answered", value: "Lumber" }, "unknown_field"],
      [{ fieldKey: "purchasing.bills", state: "answered", value: "many" }, "invalid_answer"],
      [{ fieldKey: "purchasing.bills", state: "answered" }, "invalid_request"],
    ] as const) {
      const res = await H.call(user("a"), "POST", `/api/intake/${intakeId}/answers`, {
        answers: [answer],
      });
      expect(res.status, JSON.stringify(res.json)).toBe(code === "invalid_request" ? 400 : 422);
      if (code !== "invalid_request") expect(j(res.json).error.code).toBe(code);
    }
  });

  it('confirms or changes "We think" lines, and records Start with this', async () => {
    const view = await ok<PortalIntakeView>(admin("a"), "POST", `/api/intake/${intakeId}/confirm`, {
      sectionKey: "area:purchasing",
      fields: [{ fieldKey: "purchasing.bills_to" }],
      decision: "start",
    });
    expect(view.answers.find((a) => a.fieldKey === "purchasing.bills_to")).toMatchObject({
      state: "confirmed",
      value: "ap@acme.com",
    });
    expect(view.progress.find((p) => p.sectionKey === "area:purchasing")?.decision).toBe("start");
    const line = view.sections[0]?.fields.find(
      (f) => f.weThink?.text === "They use QuickBooks Online",
    );
    const changed = await ok<PortalIntakeView>(
      admin("a"),
      "POST",
      `/api/intake/${intakeId}/confirm`,
      { sectionKey: "general", fields: [{ fieldKey: line?.key, value: "QuickBooks and Excel" }] },
    );
    expect(changed.answers.find((a) => a.fieldKey === line?.key)).toMatchObject({
      state: "corrected",
      value: "QuickBooks and Excel",
    });
    // A question with nothing we think can't be said yes to.
    const res = await H.call(admin("a"), "POST", `/api/intake/${intakeId}/confirm`, {
      sectionKey: "general",
      fields: [{ fieldKey: "general.what" }],
    });
    expect(j(res.json).error.code).toBe("nothing_to_confirm");
  });

  it("counts a tool as answered once the client has connected it", async () => {
    const before = await ok<{ intake: PortalIntakeView }>(admin("a"), "GET", "/api/intake");
    expect(before.intake.answers.some((a) => a.fieldKey === "tool.testkit")).toBe(false);
    await H.t.db
      .update(connection)
      .set({ status: "connected" })
      .where(eq(connection.id, H.A.connectionId));
    const after = await ok<{ intake: PortalIntakeView }>(admin("a"), "GET", "/api/intake");
    expect(after.intake.answers.find((a) => a.fieldKey === "tool.testkit")).toMatchObject({
      source: "tool",
      state: "answered",
      value: { connectionId: H.A.connectionId },
    });
    await H.t.db
      .update(connection)
      .set({ status: "pending" })
      .where(eq(connection.id, H.A.connectionId));
  });

  it("asks a colleague: a member for a card, a new address by the admin only, our email not WorkOS's", async () => {
    sendOnboardingEmail.mockClear();
    // The client user asks the admin… no: a member already in the client, for one question.
    const member = await ok<{
      person: { id: string; sections: string[] | null };
      emailed: boolean;
    }>(admin("a"), "POST", `/api/intake/${intakeId}/ask`, {
      fieldKey: "general.what",
      userId: userId[user("a")],
      note: "You know this best",
    });
    expect(member.emailed).toBe(true);
    expect(member.person.sections).toEqual(["area:purchasing", "general"]);
    expect(sendOnboardingEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "colleague",
        tenantId: H.A.tenantId,
        intakeId,
        personId: member.person.id,
        about: ["What does your business do, and where?"],
      }),
    );
    // Who has the question shows on the card's progress.
    const view = await ok<PortalIntakeView>(admin("a"), "GET", `/api/intake/${intakeId}`);
    expect(view.people.find((p) => p.id === member.person.id)?.name).toBe("Mark User");

    // A client user can't invite someone new.
    const refused = await H.call(user("a"), "POST", `/api/intake/${intakeId}/ask`, {
      sectionKey: "area:purchasing",
      name: "Lee New",
      email: "lee@a.example.com",
    });
    expect(refused.status).toBe(403);

    // The admin can: a member of the client, a person with that card, one email (ours).
    const fresh = await ok<{ person: { id: string; sections: string[] | null } }>(
      admin("a"),
      "POST",
      `/api/intake/${intakeId}/ask`,
      { sectionKey: agentSectionKey(T), name: "Lee New", email: "Lee@A.example.com" },
    );
    expect(fresh.person.sections).toEqual([agentSectionKey(T)]);
    const [lee] = await H.t.db.select().from(appUser).where(eq(appUser.email, "lee@a.example.com"));
    const [m] = await H.t.db
      .select()
      .from(membership)
      .where(and(eq(membership.userId, lee?.id as string), eq(membership.tenantId, H.A.tenantId)));
    expect(m?.role).toBe("client_user");
    const asked = await H.t.db
      .select()
      .from(intakeEvent)
      .where(and(eq(intakeEvent.intakeId, intakeId), eq(intakeEvent.kind, "asked")));
    expect(asked).toHaveLength(2);
    expect(asked[0]?.meta).toMatchObject({ fieldKey: "general.what", note: "You know this best" });

    // Never another client's person, nor an operator.
    for (const id of [userId[OPERATOR]]) {
      const res = await H.call(admin("a"), "POST", `/api/intake/${intakeId}/ask`, {
        sectionKey: "general",
        userId: id,
      });
      expect(res.status).toBe(404);
    }
  });

  it("sends a different process to the lead as an ask, in the client's words", async () => {
    await ok(admin("a"), "POST", `/api/intake/${intakeId}/different-process`, {
      sectionKey: "area:purchasing",
      text: "We'd rather have bills go to Dana first, then to the owner.",
    });
    const asks = await H.t.db.select().from(clientAsk).where(eq(clientAsk.tenantId, H.A.tenantId));
    const ask = asks.find((a) => a.title.startsWith("A different process"));
    expect(ask?.text).toContain("Dana first");
    expect(ask?.source).toBe("portal");
    const [ev] = await H.t.db
      .select()
      .from(intakeEvent)
      .where(and(eq(intakeEvent.intakeId, intakeId), eq(intakeEvent.kind, "different_process")));
    expect(ev?.meta).toMatchObject({ askId: ask?.id, sectionKey: "area:purchasing" });
  });

  it("gives the back office the guide, the answers with their sources, progress and the log", async () => {
    const list = await ok<{ intakes: { id: string; answered: number; total: number }[] }>(
      OPERATOR,
      "GET",
      `/api/ops/intakes?client=${H.A.tenantId}`,
    );
    const mine = list.intakes.find((i) => i.id === intakeId);
    expect(mine?.answered).toBeGreaterThan(0);
    expect(mine?.total).toBeGreaterThan(mine?.answered ?? 0);
    const view = await ok<OpsIntakeView>(OPERATOR, "GET", `/api/ops/intakes/${intakeId}`);
    expect(view.intake.lead?.id).toBe(operatorId);
    expect(view.answers.find((a) => a.fieldKey === "purchasing.bills")?.by?.name).toBe(
      "Client A user",
    );
    const agentCard = view.progress.find((p) => p.sectionKey === agentSectionKey(T));
    expect(agentCard?.missing.map((m) => m.fieldKey)).toContain("agent.contracts-check.tol");
    expect(agentCard?.missing.find((m) => m.fieldKey === "tool.testkit")?.who).toBe("Lee New");
    expect(view.events[0]?.kind).toBe("different_process");
    // Clients never reach it.
    expect((await H.call(admin("a"), "GET", "/api/ops/intakes")).status).toBe(403);
    const answers = await H.t.db
      .select()
      .from(intakeAnswer)
      .where(eq(intakeAnswer.intakeId, intakeId));
    expect(answers.length).toBeGreaterThan(4);
  });

  it("leaves out an intake whose Send at hasn't come, and refuses answers once closed", async () => {
    const [later] = await H.t.db
      .insert(intake)
      .values({
        tenantId: H.B.tenantId,
        covers: { general: true, areas: [], templateIds: [] },
        guide,
        sendAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    expect(j((await H.call(admin("b"), "GET", "/api/intake")).json).intake).toBeNull();
    await H.t.db
      .update(intake)
      .set({ sendAt: null, status: "done" })
      .where(eq(intake.id, later?.id as string));
    const res = await H.call(admin("b"), "POST", `/api/intake/${later?.id}/answers`, {
      answers: [{ fieldKey: "general.what", state: "answered", value: "x" }],
    });
    expect(res.status).toBe(409);
  });
});
