// Send it again (docs/plan.md §1.220, C7): an invite that didn't go out (skipped for a reason that
// can pass, given up on, or bounced) can be sent again by an operator who serves the client. It is
// queued under a key of its own, once per invite it replaces; the lead's "didn't go out" to-do is
// done; the back office's view names who is waiting for one. An invite that went, or a closed
// intake, is refused; a client's people can't reach the route.

import { intake, intakeEvent, intakePerson, notification, todo, withTenant } from "@countersign/db";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
} from "./api.test-helper";
import {
  leaveUnsentTodo,
  sendOnboardingEmail,
  unsentInvite,
  unsentTodoKey,
} from "./onboarding/emails";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness({
  env: {
    ENCRYPTION_KEY: "send-again-test-key-0123456789abcd",
    APP_ORIGIN: "https://app.mezonas.test",
    RESEND_API_KEY: "re_test",
    RESEND_FALLBACK_DOMAIN: "mezonas.test",
  },
});
afterAll(() => h?.close());

const GUIDE = {
  version: 1,
  sections: [],
  totals: { known: 0, toConfirm: 0, toAsk: 1, later: 0, tools: 0, minutes: 5 },
};

describe.skipIf(!h)("Send it again (§1.220)", () => {
  const H = h as ApiHarness;

  async function addIntake(status: "sent" | "cancelled" = "sent") {
    const [row] = await H.t.db
      .insert(intake)
      .values({
        tenantId: H.A.tenantId,
        covers: { general: true, areas: [], templateIds: [] },
        guide: GUIDE,
        leadUserId: H.operator,
        status,
      })
      .returning();
    return (row as typeof intake.$inferSelect).id;
  }

  async function addPerson(intakeId: string, email: string, name: string) {
    const [row] = await H.t.db
      .insert(intakePerson)
      .values({ tenantId: H.A.tenantId, intakeId, email, name })
      .returning();
    return (row as typeof intakePerson.$inferSelect).id;
  }

  /** Queues an invite with no Resend here: skipped `not_configured`, with the lead's to-do. */
  async function unsentInviteFor(intakeId: string, personId: string) {
    const { RESEND_API_KEY: _key, ...noResend } = H.env;
    const queued = await withTenant(H.db, H.A.tenantId, (tx) =>
      sendOnboardingEmail(
        { tx, env: noResend },
        { kind: "invite", tenantId: H.A.tenantId, intakeId, personId },
      ),
    );
    expect(queued.status).toBe("skipped");
    const id = queued.notificationId as string;
    await leaveUnsentTodo(H.db, {
      tenantId: H.A.tenantId,
      intakeId,
      personId,
      notificationId: id,
      kind: "intake_invite",
      reason: "not_configured",
    });
    return id;
  }

  const path = (intakeId: string, personId: string) =>
    `/api/ops/intakes/${intakeId}/people/${personId}/send-again`;

  let intakeId: string;
  let dana: string;
  let first: string;

  beforeAll(async () => {
    intakeId = await addIntake();
    dana = await addPerson(intakeId, "dana@a.example.com", "Dana Ruiz");
    first = await unsentInviteFor(intakeId, dana);
  });

  it("names who is waiting for one in the back office's view", async () => {
    const res = await H.call(OPERATOR, "GET", `/api/ops/intakes/${intakeId}`);
    expect(res.status).toBe(200);
    expect(j(res.json).unsentInvites).toEqual([dana]);
  });

  it("is the operator's: a client's admin and an operator not serving the client are refused", async () => {
    expect((await H.call(admin("a"), "POST", path(intakeId, dana))).status).toBe(403);
    expect((await H.call(OTHER_OPERATOR, "POST", path(intakeId, dana))).status).toBe(404);
  });

  it("sends it again once, keyed by the invite it replaces, and the lead's to-do is done", async () => {
    const res = await H.call(OPERATOR, "POST", path(intakeId, dana));
    expect(res.status).toBe(200);
    expect(j(res.json).status).toBe("queued");
    await H.settle();
    const rows = await H.t.db
      .select()
      .from(notification)
      .where(like(notification.dedupeKey, `intake_invite:${dana}%`));
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(
      [`intake_invite:${dana}`, `intake_invite:${dana}:again-${first}`].sort(),
    );
    const [td] = await H.t.db
      .select()
      .from(todo)
      .where(eq(todo.dedupeKey, unsentTodoKey(first)));
    expect(td?.state).toBe("done");
    // Their latest invite is the new one: nothing to send again until it fails too.
    const again = await H.call(OPERATOR, "POST", path(intakeId, dana));
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.json)).toContain("not_unsent");
    const view = await H.call(OPERATOR, "GET", `/api/ops/intakes/${intakeId}`);
    expect(j(view.json).unsentInvites).toEqual([]);
  });

  it("counts a sent invite that bounced, and not one that only went", async () => {
    const mark = await addPerson(intakeId, "mark@a.example.com", "Mark Lee");
    const [row] = await H.t.db
      .insert(notification)
      .values({
        tenantId: H.A.tenantId,
        userId: null,
        contactId: null,
        channel: "email",
        kind: "intake_invite",
        dedupeKey: `intake_invite:${mark}`,
        link: "https://app.mezonas.test/start",
        counts: {},
        status: "sent",
        providerId: "re_mark",
      })
      .returning({ id: notification.id });
    const id = row?.id as string;
    const check = () =>
      withTenant(H.db, H.A.tenantId, (tx) => unsentInvite(tx, H.A.tenantId, mark));
    expect(await check()).toBeNull();
    await H.t.db.insert(intakeEvent).values({
      tenantId: H.A.tenantId,
      intakeId,
      personId: mark,
      kind: "bounced",
      meta: { email: "invite", notificationId: id },
    });
    expect(await check()).toBe(id);
  });

  it("refuses a closed intake, and one that can't send from here", async () => {
    const closed = await addIntake();
    const ana = await addPerson(closed, "ana@a.example.com", "Ana");
    await unsentInviteFor(closed, ana);
    const key = H.env.RESEND_API_KEY;
    delete H.env.RESEND_API_KEY;
    try {
      const off = await H.call(OPERATOR, "POST", path(closed, ana));
      expect(off.status).toBe(409);
      expect(JSON.stringify(off.json)).toContain("cannot_send");
    } finally {
      if (key) H.env.RESEND_API_KEY = key;
    }
    await H.t.db
      .update(intake)
      .set({ status: "cancelled" })
      .where(and(eq(intake.id, closed), eq(intake.tenantId, H.A.tenantId)));
    const res = await H.call(OPERATOR, "POST", path(closed, ana));
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.json)).toContain("closed");
  });
});
