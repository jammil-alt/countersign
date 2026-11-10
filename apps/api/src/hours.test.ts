// R4 business hours (docs/plan.md §1.86; ARCHITECTURE §10.14 "Business hours") through the API, over
// a throwaway database: the client's week (default Mon to Fri 8 to 6 in the client's zone; the
// client admin sets it, its closed dates are the client's existing holidays), each person's own
// hours and away dates (self, or the client admin for anyone on the People list), the operator's
// read, and the executor's `hoursFor` port read from what is stored.

import { processes } from "@countersign/core";
import { contact, membership, tenant, withTenant } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, user } from "./api.test-helper";
import { clientBusinessHours, hoursIn } from "./hours/hours";

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;

const NINE_TO_FIVE = [{ from: "09:00", to: "17:00" }];

describe("clientBusinessHours (no database)", () => {
  it("defaults to Mon to Fri 8 to 6 in the client's zone, with its holidays closed", () => {
    const r = clientBusinessHours({
      timezone: "America/Chicago",
      settings: { holidays: ["2026-12-24"] },
    });
    expect(r.isDefault).toBe(true);
    expect(r.hours).toEqual({
      ...processes.defaultBusinessHours("America/Chicago"),
      closed: ["2026-12-24"],
    });
  });

  it("reads a stored week, and falls back to the default for one that doesn't parse", () => {
    const set = clientBusinessHours({
      timezone: "UTC",
      settings: { businessHours: { week: { sat: NINE_TO_FIVE }, usHolidays: false } },
    });
    expect(set).toEqual({
      hours: { tz: "UTC", week: { sat: NINE_TO_FIVE }, usHolidays: false, closed: [] },
      isDefault: false,
    });
    const broken = clientBusinessHours({
      timezone: "Nowhere/Atlantis",
      settings: { businessHours: { week: { sat: [{ from: "18:00", to: "08:00" }] } } },
    });
    expect(broken.isDefault).toBe(true);
    expect(broken.hours.tz).toBe("UTC");
  });
});

describe.skipIf(!h)("business hours and person hours", () => {
  const H = h as NonNullable<typeof h>;
  const call = H.call.bind(H);
  let danaId = "";
  let otherContactId = "";

  beforeAll(async () => {
    await H.t.db
      .update(tenant)
      .set({ timezone: "America/New_York" })
      .where(eq(tenant.id, H.A.tenantId));
    const [dana] = await H.t.db
      .insert(contact)
      .values({ tenantId: H.A.tenantId, name: "Dana Ruiz", email: "dana@a.example.com" })
      .returning();
    const [other] = await H.t.db
      .insert(contact)
      .values({ tenantId: H.B.tenantId, name: "Sam Other", email: "sam@b.example.com" })
      .returning();
    danaId = dana?.id ?? "";
    otherContactId = other?.id ?? "";
  });

  describe("the client's business hours", () => {
    it("reads the default week in the client's zone for every client person", async () => {
      for (const who of [admin("a"), user("a")]) {
        const res = await call(who, "GET", "/api/settings/business-hours");
        expect(res.status).toBe(200);
        expect(res.json).toEqual({
          hours: processes.defaultBusinessHours("America/New_York"),
          isDefault: true,
        });
      }
    });

    it("the client admin sets the week and closed dates; the holidays list is the same list", async () => {
      const res = await call(admin("a"), "PUT", "/api/settings/business-hours", {
        week: { mon: NINE_TO_FIVE, tue: NINE_TO_FIVE, sat: [{ from: "10:00", to: "12:00" }] },
        usHolidays: false,
        closed: ["2026-12-26", "2026-12-24", "2026-12-24"],
      });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({
        hours: {
          tz: "America/New_York",
          week: { mon: NINE_TO_FIVE, tue: NINE_TO_FIVE, sat: [{ from: "10:00", to: "12:00" }] },
          usHolidays: false,
          closed: ["2026-12-24", "2026-12-26"],
        },
        isDefault: false,
      });
      const [t] = await H.t.db.select().from(tenant).where(eq(tenant.id, H.A.tenantId));
      const settings = t?.settings as Record<string, unknown>;
      // Schedules that skip holidays read the same dates; other settings are kept.
      expect(settings.holidays).toEqual(["2026-12-24", "2026-12-26"]);
      expect(settings.connectors_offered).toEqual(["testkit"]);
      // Client B is untouched.
      const b = await call(admin("b"), "GET", "/api/settings/business-hours");
      expect((b.json as J).isDefault).toBe(true);
    });

    it("refuses a client user, a stretch that ends before it starts, and a zone in the body", async () => {
      const body = { week: { mon: NINE_TO_FIVE }, usHolidays: true, closed: [] };
      expect((await call(user("a"), "PUT", "/api/settings/business-hours", body)).status).toBe(403);
      const backwards = await call(admin("a"), "PUT", "/api/settings/business-hours", {
        ...body,
        week: { mon: [{ from: "17:00", to: "09:00" }] },
      });
      expect(backwards.status).toBe(400);
      const zoned = await call(admin("a"), "PUT", "/api/settings/business-hours", {
        ...body,
        tz: "Europe/Paris",
      });
      expect(zoned.status).toBe(400);
    });
  });

  describe("a person's own hours", () => {
    it("starts with the business's hours, then sets and clears their own", async () => {
      const first = await call(user("a"), "GET", "/api/settings/my-hours");
      expect(first.status).toBe(200);
      expect((first.json as J).person).toMatchObject({ kind: "user", hours: null });

      const set = await call(user("a"), "PUT", "/api/settings/my-hours", {
        hours: {
          hours: { tz: "America/Denver", week: { mon: NINE_TO_FIVE } },
          away: [
            { from: "2026-12-28", to: "2026-12-31" },
            { from: "2026-11-26", to: "2026-11-27" },
          ],
        },
      });
      expect(set.status).toBe(200);
      expect((set.json as J).person.hours).toEqual({
        hours: { tz: "America/Denver", week: { mon: NINE_TO_FIVE }, usHolidays: true, closed: [] },
        away: [
          { from: "2026-11-26", to: "2026-11-27" },
          { from: "2026-12-28", to: "2026-12-31" },
        ],
      });

      const cleared = await call(user("a"), "PUT", "/api/settings/my-hours", { hours: null });
      expect((cleared.json as J).person.hours).toBeNull();
    });

    it("refuses an away range that ends before it starts, and an unknown zone", async () => {
      const backwards = await call(user("a"), "PUT", "/api/settings/my-hours", {
        hours: { away: [{ from: "2026-12-31", to: "2026-12-01" }] },
      });
      expect(backwards.status).toBe(422);
      expect((backwards.json as J).error.code).toBe("invalid_hours");
      const zone = await call(user("a"), "PUT", "/api/settings/my-hours", {
        hours: { hours: { tz: "Mars/Olympus", week: {} }, away: [] },
      });
      expect(zone.status).toBe(422);
    });
  });

  describe("the People list", () => {
    it("is the client admin's: users and contacts with their hours", async () => {
      expect((await call(user("a"), "GET", "/api/settings/people-hours")).status).toBe(403);
      const res = await call(admin("a"), "GET", "/api/settings/people-hours");
      expect(res.status).toBe(200);
      const people = (res.json as J).people as J[];
      expect(people.filter((p) => p.kind === "user")).toHaveLength(2);
      expect(people.find((p) => p.id === danaId)).toMatchObject({ kind: "contact", hours: null });
      // Operators are never on a client's People list.
      expect(people.some((p) => p.name === "Operator")).toBe(false);
      expect((res.json as J).business.hours.tz).toBe("America/New_York");
    });

    it("the client admin sets a team member's and a contact's, never another client's", async () => {
      const me = await call(user("a"), "GET", "/api/settings/my-hours");
      const userId = (me.json as J).person.id;
      const away = { away: [{ from: "2026-12-01", to: "2026-12-05" }] };
      const u = await call(admin("a"), "PUT", `/api/settings/people-hours/users/${userId}`, {
        hours: away,
      });
      expect(u.status).toBe(200);
      expect((u.json as J).person.hours).toEqual(away);
      const c = await call(admin("a"), "PUT", `/api/settings/people-hours/contacts/${danaId}`, {
        hours: away,
      });
      expect(c.status).toBe(200);
      expect((c.json as J).person).toMatchObject({
        kind: "contact",
        name: "Dana Ruiz",
        hours: away,
      });

      const otherContact = await call(
        admin("a"),
        "PUT",
        `/api/settings/people-hours/contacts/${otherContactId}`,
        { hours: away },
      );
      expect(otherContact.status).toBe(404);
      const operatorRow = await call(
        admin("a"),
        "PUT",
        `/api/settings/people-hours/users/${H.operator}`,
        { hours: away },
      );
      expect(operatorRow.status).toBe(404);
      expect(
        (
          await call(user("a"), "PUT", `/api/settings/people-hours/contacts/${danaId}`, {
            hours: away,
          })
        ).status,
      ).toBe(403);
    });

    it("the operator reads a client they serve, not one they don't", async () => {
      const res = await call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/hours`);
      expect(res.status).toBe(200);
      expect((res.json as J).business.isDefault).toBe(false);
      const other = await call(OPERATOR, "GET", `/api/ops/clients/${H.C.tenantId}/hours`);
      expect(other.status).toBe(404);
    });
  });

  describe("hoursFor (the executor's port)", () => {
    it("reads the client's hours, a person's own, a role's people and the lead's", async () => {
      const A = H.A.tenantId;
      await H.t.db
        .update(membership)
        .set({
          hours: {
            hours: { tz: "UTC", week: { sun: NINE_TO_FIVE }, usHolidays: false, closed: [] },
            away: [],
          },
        })
        .where(and(eq(membership.tenantId, A), eq(membership.userId, H.operator)));
      await H.t.db
        .update(tenant)
        .set({
          settings: sql`${tenant.settings} || jsonb_build_object('lead', jsonb_build_object('userId', ${H.operator}::text))`,
        })
        .where(eq(tenant.id, A));
      const [adminRow] = await H.t.db
        .select({ userId: membership.userId })
        .from(membership)
        .where(and(eq(membership.tenantId, A), eq(membership.role, "client_admin")));

      const read = (who: string) => withTenant(H.db, A, (tx) => hoursIn(tx, A, who));
      const client = (await read("nobody")).client;
      expect(client.tz).toBe("America/New_York");
      expect(client.closed).toEqual(["2026-12-24", "2026-12-26"]);

      expect(await read(danaId)).toEqual({
        client,
        person: { away: [{ from: "2026-12-01", to: "2026-12-05" }] },
      });
      const lead = await read("lead");
      expect(lead.person?.hours?.week).toEqual({ sun: NINE_TO_FIVE });

      const admins = await read("client_admin");
      expect(admins.person).toBeUndefined();
      expect(admins.people).toEqual([{ businessHours: client, away: [] }]);
      // The client user's own away dates ride with their schedule.
      const users = await read("client_user");
      expect(users.people?.[0]?.away).toEqual([{ from: "2026-12-01", to: "2026-12-05" }]);
      // A person with no hours of their own: the client's.
      expect(await read(adminRow?.userId ?? "")).toEqual({ client });
      // Another client's contact is nobody here.
      expect(await read(otherContactId)).toEqual({ client });
    });
  });
});
