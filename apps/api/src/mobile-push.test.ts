// Phone notifications through the notification pass (docs/plan.md §1.99), against a real database
// and a fake of Expo's push service: a count and a fixed sentence to each of the person's phones,
// no record content, "right away" each pass with something new, quiet when nothing is, and a phone
// whose app is gone loses its token.

import type { FetchLike } from "@countersign/connectors";
import { inboxItem, notification, personDevice, tenant } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness } from "./api.test-helper";
import { EXPO_PUSH_URL } from "./notify/push";
import { notifyDepsFromEnv, notifyPass } from "./notify/tick";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

interface Sent {
  to: string;
  title: string;
  body: string;
  data: { path: string; kind: string };
  badge?: number;
}

const sent: Sent[] = [];
/** Tokens Expo reports as gone (the app was removed). */
const gone = new Set<string>();

const fetch: FetchLike = async (url, init) => {
  if (url !== EXPO_PUSH_URL) throw new Error(`unexpected call to ${url}`);
  const messages = JSON.parse(String(init?.body)) as Sent[];
  sent.push(...messages);
  const data = messages.map((m, i) =>
    gone.has(m.to)
      ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }
      : { status: "ok", id: `ticket-${sent.length}-${i}` },
  );
  const text = JSON.stringify({ data });
  return { status: 200, ok: true, headers: { get: () => null }, text: async () => text };
};

const h = await createApiHarness();
const H = h as ApiHarness;
afterAll(() => h?.close());

const SECRET_WORDS = "Hardwood Supply PO 1042 for $4,820.00";

describe.skipIf(!h)("phone notifications", () => {
  const T0 = new Date("2026-11-16T15:00:00Z");
  const pass = (when: Date) =>
    notifyPass(H.db, notifyDepsFromEnv(H.env, fetch), H.A.tenantId, when);
  const pushRows = () =>
    H.t.db
      .select()
      .from(notification)
      .where(and(eq(notification.tenantId, H.A.tenantId), eq(notification.channel, "push")));

  async function addItem(createdAt: Date) {
    await H.t.db.insert(inboxItem).values({
      tenantId: H.A.tenantId,
      kind: "approval",
      assigneeRole: "client_admin",
      title: `Send ${SECRET_WORDS}`,
      payload: {},
      createdAt,
    });
  }

  beforeEach(() => {
    sent.length = 0;
  });

  it("tells each of the person's phones a count, nothing else, and again with something new", async () => {
    for (const n of [1, 2]) {
      await H.call(admin("a"), "POST", "/api/me/devices", {
        name: `Phone ${n}`,
        platform: n === 1 ? "ios" : "android",
        pushToken: `ExponentPushToken[admin-a-${n}]`,
        publicKey: null,
      });
    }
    await addItem(new Date(T0.getTime() - 60_000));
    await pass(T0);
    expect(sent.map((m) => m.to).sort()).toEqual([
      "ExponentPushToken[admin-a-1]",
      "ExponentPushToken[admin-a-2]",
    ]);
    expect(sent[0]).toMatchObject({
      title: "Mezonas",
      data: { path: "/inbox", kind: "items_waiting" },
      badge: 1,
    });
    expect(sent[0]?.body).toMatch(/1/);
    expect(JSON.stringify(sent)).not.toMatch(/Hardwood|1042|4,820|https?:/);
    const rows = await pushRows();
    expect(rows.map((r) => r.status)).toEqual(["sent"]);

    // Nothing new: nothing sent.
    sent.length = 0;
    await pass(new Date(T0.getTime() + 5 * 60_000));
    expect(sent).toEqual([]);

    // Something new, five minutes on: "right away" sends at once (email waits for the hour).
    await addItem(new Date(T0.getTime() + 6 * 60_000));
    await pass(new Date(T0.getTime() + 10 * 60_000));
    expect(sent.length).toBe(2);
    expect(sent[0]?.badge).toBe(2);
  });

  it("names the business only when the person chose it, and waits an hour when they chose that", async () => {
    await H.call(admin("a"), "PUT", "/api/settings/my-push", {
      on: true,
      every: "hour",
      showClient: true,
    });
    await addItem(new Date(T0.getTime() + 11 * 60_000));
    await pass(new Date(T0.getTime() + 15 * 60_000));
    expect(sent).toEqual([]);
    await pass(new Date(T0.getTime() + 75 * 60_000));
    expect(sent.length).toBe(2);
    expect(sent[0]?.title).not.toBe("Mezonas");
    expect(sent[0]?.title.length).toBeGreaterThan(0);
    await H.call(admin("a"), "PUT", "/api/settings/my-push", {
      on: true,
      every: "now",
      showClient: false,
    });
  });

  it("forgets a phone whose app is gone, and sends nothing to someone who turned phones off", async () => {
    gone.add("ExponentPushToken[admin-a-2]");
    await addItem(new Date(T0.getTime() + 80 * 60_000));
    await pass(new Date(T0.getTime() + 85 * 60_000));
    const [phone2] = await H.t.db
      .select()
      .from(personDevice)
      .where(eq(personDevice.name, "Phone 2"));
    expect(phone2?.pushToken).toBeNull();
    const devices = j((await H.call(admin("a"), "GET", "/api/me/devices")).json).devices;
    expect(devices.map((d: { push: boolean }) => d.push).sort()).toEqual([false, true]);

    await H.call(admin("a"), "PUT", "/api/settings/my-push", {
      on: false,
      every: "now",
      showClient: false,
    });
    sent.length = 0;
    await addItem(new Date(T0.getTime() + 90 * 60_000));
    await pass(new Date(T0.getTime() + 95 * 60_000));
    expect(sent).toEqual([]);
  });
});

describe.skipIf(!h)("phone notifications in HIPAA mode", () => {
  it("sends Expo nothing until its BAA is recorded", async () => {
    const T = new Date("2026-11-17T15:00:00Z");
    await H.t.db
      .update(tenant)
      .set({ settings: sql`${tenant.settings} || '{"compliance":{"hipaa":true}}'::jsonb` })
      .where(eq(tenant.id, H.B.tenantId));
    await H.call(admin("b"), "POST", "/api/me/devices", {
      name: "Phone",
      platform: "ios",
      pushToken: "ExponentPushToken[admin-b-1]",
      publicKey: null,
    });
    await H.t.db.insert(inboxItem).values({
      tenantId: H.B.tenantId,
      kind: "approval",
      assigneeRole: "client_admin",
      title: "Approve",
      payload: {},
      createdAt: new Date(T.getTime() - 60_000),
    });
    sent.length = 0;
    await notifyPass(H.db, notifyDepsFromEnv(H.env, fetch), H.B.tenantId, T);
    expect(sent).toEqual([]);
    const rows = await H.t.db
      .select()
      .from(notification)
      .where(and(eq(notification.tenantId, H.B.tenantId), eq(notification.channel, "push")));
    expect(rows.map((r) => [r.status, r.reason])).toEqual([["skipped", "not_covered"]]);
  });
});
