// The back office's Setup tab through the API (docs/setup-plan.md §8; docs/plan.md §1.199, SU6):
// each agent being set up by chapter with who it waits on, what holds Start trial, the people
// waiting, the client's change asks (not ours), the runbook; Nudge, an email from the lead at most
// once a day per person; Do it on a call, the lead's answers sourced `call`, checked by field kind,
// which count once the client says yes (owner, §1.199 q4). Only an operator who serves the client
// reaches any of it (invariants 1 and 11).
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { FAKE_RESEND_MAIN, fakeResend } from "@countersign/connectors/testing";
import { buildGuide, type Guide, type PortalIntakeView } from "@countersign/core";
import {
  appUser,
  intake,
  intakeAnswer,
  intakePerson,
  notification,
  withOperator,
  withTenant,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  user,
} from "./api.test-helper";
import { guideSources } from "./onboarding/guide-sources";
import { createIssue } from "./work/issues";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const resend = fakeResend();
const h = await createApiHarness({
  fetch: resend.fetch,
  env: { RESEND_API_KEY: FAKE_RESEND_MAIN.apiKey, RESEND_FALLBACK_DOMAIN: "mail.example.test" },
});
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const SEATS = [{ role: "bill-approver", kind: "signs", label: "Approves bills", required: true }];

function bundle(name: string): unknown {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name, role: "Bills", mission: "Enter bills." },
      kind: "functional",
      model: { id: "test-model", maxTokens: 1024 },
      instructions: "Be brief.",
      skills: [],
      extraTools: [TESTKIT_UPDATE_TOOL],
      permissions: { mode: "suggest_only" },
    },
    people: SEATS,
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 4,
          triggers: [{ id: "t", on: { type: "manual", input: {} } }],
          steps: [
            {
              id: "update",
              kind: "write",
              name: "Update the record",
              tool: TESTKIT_UPDATE_TOOL,
              input: { id: "r1", amount: "12.00" },
              checks: { approval: { approvers: [{ who: "seat:bill-approver" }] } },
            },
          ],
        },
      },
    ],
  };
}

describe.skipIf(!h)("the Setup tab", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const ids: Record<string, string> = {};
  let agentId = "";
  let intakeId = "";
  let guide: Guide;
  const board = (who = OPERATOR, client = A()) =>
    H.call(who, "GET", `/api/ops/clients/${client}/setup`);

  beforeAll(async () => {
    for (const email of [admin("a"), user("a"), OPERATOR]) {
      const [u] = await H.t.db.select().from(appUser).where(eq(appUser.email, email));
      ids[email] = u?.id as string;
    }
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: "bills",
      bundle: bundle("Bill clerk"),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    agentId = j(created.json).agent.id;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);

    // An open intake with the general card, the client admin on it.
    const covers = { general: true, areas: [], templateIds: [] };
    const sources = await withOperator(H.db, [A()], (tx) =>
      guideSources(tx, { platform: H.platform }, covers),
    );
    guide = buildGuide({ covers, ...sources, facts: [] });
    const [row] = await H.t.db
      .insert(intake)
      .values({ tenantId: A(), covers, guide, leadUserId: ids[OPERATOR], createdBy: ids[OPERATOR] })
      .returning();
    intakeId = row?.id as string;
    await H.t.db.insert(intakePerson).values({
      tenantId: A(),
      intakeId,
      email: admin("a"),
      name: "Client A admin",
      sections: null,
      isAdmin: true,
    });

    // A "We do it differently", as the client files it, and a security check of ours.
    await withTenant(H.db, A(), async (tx) => {
      await createIssue(tx, {
        tenantId: A(),
        title: "Freight goes to overhead",
        description: "Freight should go to overhead, not the job.",
        agentId,
        source: "portal",
        raisedBy: ids[admin("a")] as string,
        actor: "client",
        userId: ids[admin("a")] as string,
      });
      await createIssue(tx, {
        tenantId: A(),
        title: "A security check is in review",
        agentId,
        source: "assurance",
        actor: "system",
        userId: null,
      });
    });
  });

  it("shows each agent by chapter, who it waits on, what holds its trial, the asks and the runbook", async () => {
    // The client admin was here.
    expect((await H.call(admin("a"), "GET", "/api/getting-started")).status).toBe(200);
    const res = await board();
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const b = j(res.json);
    expect(b.client).toEqual({ id: A(), name: "Client A" });
    expect(b.intakeId).toBe(intakeId);
    const [bills] = b.agents;
    expect(bills).toMatchObject({ agentId, name: "Bill clerk", version: 1 });
    expect(bills.cells.map((c: { chapter: string }) => c.chapter)).toEqual([
      "business",
      "tools",
      "people",
      "see",
      "live",
    ]);
    const cell = (k: string) => bills.cells.find((c: { chapter: string }) => c.chapter === k);
    expect(cell("people")).toMatchObject({
      waitingOn: "Client A admin",
      note: "Approves bills",
    });
    expect(["open", "not_started"]).toContain(cell("people").state);
    expect(cell("live")).toMatchObject({ waitingOn: "Client A admin", note: "Sign the scope" });
    expect(cell("business")).toMatchObject({ waitingOn: "Client A admin" });
    expect(bills.holds).toEqual(
      expect.arrayContaining([
        "Approves bills (Client A admin)",
        "Sign the scope (Client A admin)",
      ]),
    );

    const dana = b.waiting.find((w: { userId: string }) => w.userId === ids[admin("a")]);
    expect(dana.name).toBe("Client A admin");
    expect(dana.items).toEqual(
      expect.arrayContaining([
        "Approves bills",
        "Sign the scope",
        expect.stringContaining("intake"),
      ]),
    );
    expect(dana.lastSeenAt).toEqual(expect.any(String));

    // The client's ask, not ours.
    expect(b.asks).toHaveLength(1);
    expect(b.asks[0]).toMatchObject({
      agentId,
      agentName: "Bill clerk",
      number: expect.any(Number),
      byName: "Client A admin",
    });
    expect(b.asks[0].text).toContain("Freight should go to overhead");

    expect(b.runbook.map((s: { key: string }) => s.key)).toEqual([
      "invite",
      "kickoff",
      "trial",
      "checkin",
      "live",
    ]);
    expect(b.runbook.map((s: { state: string }) => s.state)).toEqual([
      "done",
      "now",
      "next",
      "next",
      "next",
    ]);
    expect(b.runbook[2].day).toBe(3);

    // Once the seat is filled and the scope signed, nothing holds it but what is left elsewhere.
    await H.call(admin("a"), "PUT", "/api/getting-started/people/bill-approver", {
      userIds: [ids[admin("a")]],
    });
    await H.call(admin("a"), "POST", `/api/getting-started/agents/${agentId}/scope/sign`);
    const after = j((await board()).json).agents[0];
    expect(after.holds.some((x: string) => x.startsWith("Approves bills"))).toBe(false);
    expect(after.holds.some((x: string) => x.startsWith("Sign the scope"))).toBe(false);
    expect(after.cells.find((c: { chapter: string }) => c.chapter === "live").state).toBe("done");
  });

  it("is only for an operator who serves the client", async () => {
    expect((await board(OTHER_OPERATOR)).status).toBe(404);
    expect((await board(admin("a"))).status).toBe(403);
    expect((await board(user("a"))).status).toBe(403);
    const nudged = await H.call(OTHER_OPERATOR, "POST", `/api/ops/clients/${A()}/setup/nudge`, {
      userId: ids[admin("a")],
    });
    expect(nudged.status).toBe(404);
    const call = await H.call(OTHER_OPERATOR, "POST", `/api/ops/intakes/${intakeId}/call-answers`, {
      answers: [{ fieldKey: "general.approver", value: "Dana" }],
    });
    expect(call.status).toBe(404);
    expect(
      (
        await H.call(admin("a"), "POST", `/api/ops/intakes/${intakeId}/call-answers`, {
          answers: [{ fieldKey: "general.approver", value: "Dana" }],
        })
      ).status,
    ).toBe(403);
  });

  it("nudges a person once a day, with an email from the lead listing what's left", async () => {
    const nudge = (userId: string) =>
      H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/setup/nudge`, { userId });
    const first = await nudge(ids[admin("a")] as string);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(j(first.json)).toEqual({ sent: true, reason: null });
    await H.settle();
    const sent = resend.emails.filter((e) => e.to.includes(admin("a")));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe("A few things left to set up Client A");
    expect(sent[0]?.from).toContain("Operator");
    expect(sent[0]?.text).toContain("intake");

    expect(j((await nudge(ids[admin("a")] as string)).json)).toEqual({
      sent: false,
      reason: "already_today",
    });
    // Nothing waits on the client user.
    expect(j((await nudge(ids[user("a")] as string)).json)).toEqual({
      sent: false,
      reason: "nothing_left",
    });
    // Someone not of this client.
    expect((await nudge(ids[OPERATOR] as string)).status).toBe(404);
    const rows = await withOperator(H.db, [A()], (tx) =>
      tx
        .select()
        .from(notification)
        .where(and(eq(notification.tenantId, A()), eq(notification.kind, "intake_reminder"))),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "sent", userId: ids[admin("a")] });
  });

  it("saves the lead's answers from a call as `call`, which count once the client says yes", async () => {
    const fields = guide.sections.flatMap((s) => s.fields).filter((f) => f.state !== "known");
    const text = fields.find((f) => f.kind === "text" || f.kind === "long_text");
    const typed = fields.find((f) => ["number", "money", "yes_no", "date"].includes(f.kind));
    expect(text).toBeDefined();
    const call = (answers: unknown) =>
      H.call(OPERATOR, "POST", `/api/ops/intakes/${intakeId}/call-answers`, { answers });
    const progress = async () =>
      j((await H.call(admin("a"), "GET", "/api/intake")).json).intake as PortalIntakeView;
    const answered = (v: PortalIntakeView) => v.progress.reduce((n, p) => n + p.answered, 0);
    const before = answered(await progress());

    const saved = await call([{ fieldKey: text?.key, value: "Luis signs anything over $5,000" }]);
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(j(saved.json)).toEqual({ saved: 1 });
    const [row] = await withOperator(H.db, [A()], (tx) =>
      tx
        .select()
        .from(intakeAnswer)
        .where(
          and(eq(intakeAnswer.intakeId, intakeId), eq(intakeAnswer.fieldKey, text?.key ?? "")),
        ),
    );
    expect(row).toMatchObject({ source: "call", state: "answered", userId: ids[OPERATOR] });

    // The portal shows it with its source, and it doesn't count yet.
    const view = await progress();
    expect(view.answers.find((a) => a.fieldKey === text?.key)).toMatchObject({ source: "call" });
    expect(answered(view)).toBe(before);
    // The client says yes: their own answer, and it counts.
    const yes = await H.call(admin("a"), "POST", `/api/intake/${intakeId}/answers`, {
      answers: [
        { fieldKey: text?.key, state: "answered", value: "Luis signs anything over $5,000" },
      ],
    });
    expect(yes.status, JSON.stringify(yes.json)).toBe(200);
    expect(answered(j(yes.json) as PortalIntakeView)).toBe(before + 1);

    // A question that isn't on the intake, and a value of the wrong kind, are refused.
    const unknown = await call([{ fieldKey: "general.nothing_here", value: "x" }]);
    expect(unknown.status).toBe(422);
    expect(j(unknown.json).error.code).toBe("unknown_field");
    // A text question answered with something that isn't text.
    const wrong = await call([{ fieldKey: (typed ?? text)?.key, value: { not: "text" } }]);
    expect(wrong.status).toBe(422);
    expect(j(wrong.json).error.code).toBe("invalid_answer");
  });
});
