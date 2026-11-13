// The phone app against a real database as cs_worker (docs/plan.md §1.97): a person's phones
// (register, rename, remove, never another person's or client's), their push settings beside their
// email and texts, and a Desk item signed on a phone: the signature is checked against the item as
// the portal shows it, refused when anything differs, and written to the audit log.

import { deviceSignedText, itemFingerprintText, MOBILE_SESSION_HEADER } from "@countersign/core";
import { auditEvent, inboxItem, personDevice } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, user } from "./api.test-helper";
import type { AppEnv } from "./http";
import { sha256Hex } from "./mobile/devices";
import { mobileSession } from "./routes/mobile";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const b64url = (bytes: ArrayBuffer) => Buffer.from(new Uint8Array(bytes)).toString("base64url");

async function phoneKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    publicKey: { kty: "EC", crv: "P-256", x: jwk.x as string, y: jwk.y as string },
    sign: async (text: string) =>
      b64url(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          new TextEncoder().encode(text),
        ),
      ),
  };
}

const TOKEN = (n: number) => `ExponentPushToken[phone${n}]`;

const h = await createApiHarness();
const H = h as ApiHarness;
afterAll(() => h?.close());

describe.skipIf(!h)("a person's phones", () => {
  it("registers, lists, renames and removes a phone, only ever the person's own", async () => {
    const key = await phoneKey();
    const r = await H.call(admin("a"), "POST", "/api/me/devices", {
      name: "Maria's iPhone",
      platform: "ios",
      pushToken: TOKEN(1),
      publicKey: key.publicKey,
    });
    expect(r.status).toBe(200);
    const device = j(r.json).device;
    expect(device).toMatchObject({ name: "Maria's iPhone", push: true, signing: true });
    // Never the token or the key.
    expect(JSON.stringify(r.json)).not.toContain("phone1");
    expect(JSON.stringify(r.json)).not.toContain(key.publicKey.x);

    const mine = await H.call(admin("a"), "GET", "/api/me/devices");
    expect(j(mine.json).devices.map((d: { id: string }) => d.id)).toEqual([device.id]);
    // Another person in the client, and another client, see none of it.
    expect(j((await H.call(user("a"), "GET", "/api/me/devices")).json).devices).toEqual([]);
    expect(j((await H.call(admin("b"), "GET", "/api/me/devices")).json).devices).toEqual([]);
    expect(
      (await H.call(user("a"), "PATCH", `/api/me/devices/${device.id}`, { name: "Mine" })).status,
    ).toBe(404);
    expect((await H.call(admin("b"), "DELETE", `/api/me/devices/${device.id}`)).status).toBe(404);

    const renamed = await H.call(admin("a"), "PATCH", `/api/me/devices/${device.id}`, {
      name: "iPhone",
    });
    expect(j(renamed.json).device.name).toBe("iPhone");

    // A reinstall (the same token) replaces the old entry.
    const again = await H.call(admin("a"), "POST", "/api/me/devices", {
      name: "iPhone",
      platform: "ios",
      pushToken: TOKEN(1),
      publicKey: (await phoneKey()).publicKey,
    });
    const devices = j((await H.call(admin("a"), "GET", "/api/me/devices")).json).devices;
    expect(devices.map((d: { id: string }) => d.id)).toEqual([j(again.json).device.id]);

    expect(
      (await H.call(admin("a"), "DELETE", `/api/me/devices/${j(again.json).device.id}`)).status,
    ).toBe(200);
    expect(j((await H.call(admin("a"), "GET", "/api/me/devices")).json).devices).toEqual([]);
    const [row] = await H.t.db
      .select()
      .from(personDevice)
      .where(eq(personDevice.id, j(again.json).device.id));
    expect(row).toMatchObject({ pushToken: null, publicKey: null });
    expect(row?.revokedAt).not.toBeNull();
  });

  it("refuses what isn't a push token or a public key", async () => {
    const bad = await H.call(admin("a"), "POST", "/api/me/devices", {
      name: "Phone",
      platform: "ios",
      pushToken: "fcm:abc",
      publicKey: null,
    });
    expect(bad.status).toBe(400);
    const withPrivate = await H.call(admin("a"), "POST", "/api/me/devices", {
      name: "Phone",
      platform: "android",
      pushToken: null,
      publicKey: {
        kty: "EC",
        crv: "P-256",
        x: "A".repeat(43),
        y: "B".repeat(43),
        d: "C".repeat(43),
      },
    });
    expect(withPrivate.status).toBe(400);
  });

  it("keeps phone notifications beside email and texts, each person their own", async () => {
    expect(j((await H.call(user("a"), "GET", "/api/settings/my-push")).json)).toEqual({
      on: true,
      every: "now",
      showClient: false,
      devices: 0,
    });
    const set = await H.call(user("a"), "PUT", "/api/settings/my-push", {
      on: true,
      every: "hour",
      showClient: true,
    });
    expect(j(set.json)).toMatchObject({ every: "hour", showClient: true });
    await H.call(user("a"), "PUT", "/api/settings/my-notifications", { email: false, sms: false });
    expect(j((await H.call(user("a"), "GET", "/api/settings/my-push")).json)).toMatchObject({
      every: "hour",
      showClient: true,
    });
    expect(j((await H.call(user("a"), "GET", "/api/settings/my-notifications")).json).email).toBe(
      false,
    );
    // Someone else's are untouched.
    expect(j((await H.call(admin("a"), "GET", "/api/settings/my-push")).json).every).toBe("now");
  });
});

describe.skipIf(!h)("signing a Desk item on a phone", () => {
  async function setup(title: string) {
    const key = await phoneKey();
    const r = await H.call(admin("a"), "POST", "/api/me/devices", {
      name: "Phone",
      platform: "ios",
      pushToken: null,
      publicKey: key.publicKey,
    });
    const deviceId = j(r.json).device.id as string;
    const [row] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: H.A.tenantId,
        kind: "approval",
        assigneeRole: "client_admin",
        title,
        payload: {},
      })
      .returning();
    const itemId = row?.id as string;
    const items = j((await H.call(admin("a"), "GET", "/api/inbox")).json).items;
    const shown = items.find((i: { id: string }) => i.id === itemId);
    const fingerprint = await sha256Hex(itemFingerprintText(shown));
    const signed = async (
      decision: "approve" | "reject",
      over: { at?: string; fingerprint?: string; signAs?: "approve" | "reject" } = {},
    ) => {
      const at = over.at ?? new Date().toISOString();
      const fp = over.fingerprint ?? fingerprint;
      const signature = await key.sign(
        deviceSignedText({
          deviceId,
          itemId,
          decision: over.signAs ?? decision,
          fingerprint: fp,
          at,
        }),
      );
      return { decision, deviceSignature: { deviceId, at, fingerprint: fp, signature } };
    };
    return { deviceId, itemId, signed };
  }

  it("signs with the phone, and records which phone signed what", async () => {
    const { deviceId, itemId, signed } = await setup("Send PO 1042 to Hardwood Supply");
    const r = await H.call(
      admin("a"),
      "POST",
      `/api/inbox/${itemId}/resolve`,
      await signed("approve"),
    );
    expect(r.status).toBe(200);
    expect(j(r.json).item.status).toBe("resolved");
    const [audit] = await H.t.db
      .select()
      .from(auditEvent)
      .where(
        and(eq(auditEvent.tenantId, H.A.tenantId), eq(auditEvent.action, "inbox.device_signed")),
      );
    expect(audit?.target).toMatchObject({ item: itemId, device: deviceId, decision: "approve" });
  });

  it("refuses a signature of another decision, an old one, a changed item or a stranger's phone", async () => {
    const { itemId, signed } = await setup("Send PO 1043");
    const path = `/api/inbox/${itemId}/resolve`;
    // Signed as a no, sent as a yes.
    const swapped = await H.call(
      admin("a"),
      "POST",
      path,
      await signed("approve", { signAs: "reject" }),
    );
    expect([swapped.status, j(swapped.json).error.code]).toEqual([401, "signature_invalid"]);
    const old = await H.call(
      admin("a"),
      "POST",
      path,
      await signed("approve", { at: new Date(Date.now() - 10 * 60_000).toISOString() }),
    );
    expect([old.status, j(old.json).error.code]).toEqual([401, "signature_stale"]);
    const changed = await H.call(
      admin("a"),
      "POST",
      path,
      await signed("approve", { fingerprint: "0".repeat(64) }),
    );
    expect([changed.status, j(changed.json).error.code]).toEqual([409, "item_changed"]);
    // The item changed after the person looked: the old signature no longer fits.
    const body = await signed("approve");
    await H.t.db
      .update(inboxItem)
      .set({ title: "Send PO 1043 for more" })
      .where(eq(inboxItem.id, itemId));
    const late = await H.call(admin("a"), "POST", path, body);
    expect([late.status, j(late.json).error.code]).toEqual([409, "item_changed"]);
    // Another person's phone can't sign for them.
    const other = await H.call(user("a"), "POST", path, body);
    expect(other.status).not.toBe(200);
    // Nothing was resolved by any of it.
    const [row] = await H.t.db.select().from(inboxItem).where(eq(inboxItem.id, itemId));
    expect(row?.status).toBe("open");
  });
});

describe.skipIf(!h)("a phone's signature covers the amounts", () => {
  it("refuses it once the change's payload differs from what the person saw", async () => {
    const key = await phoneKey();
    const r = await H.call(admin("a"), "POST", "/api/me/devices", {
      name: "Phone",
      platform: "android",
      pushToken: null,
      publicKey: key.publicKey,
    });
    const deviceId = j(r.json).device.id as string;
    const [row] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: H.A.tenantId,
        kind: "approval",
        assigneeRole: "client_admin",
        title: "Send PO 1044",
        payload: { input: { total: "4820.00" } },
      })
      .returning();
    const itemId = row?.id as string;
    const shown = j((await H.call(admin("a"), "GET", "/api/inbox")).json).items.find(
      (i: { id: string }) => i.id === itemId,
    );
    const fingerprint = await sha256Hex(itemFingerprintText(shown));
    const at = new Date().toISOString();
    const signature = await key.sign(
      deviceSignedText({ deviceId, itemId, decision: "approve", fingerprint, at }),
    );
    await H.t.db
      .update(inboxItem)
      .set({ payload: { input: { total: "9820.00" } } })
      .where(eq(inboxItem.id, itemId));
    const out = await H.call(admin("a"), "POST", `/api/inbox/${itemId}/resolve`, {
      decision: "approve",
      deviceSignature: { deviceId, at, fingerprint, signature },
    });
    expect([out.status, j(out.json).error.code]).toEqual([409, "item_changed"]);
  });
});

describe("the app's session header", () => {
  const app = new Hono<AppEnv>();
  app.use("*", mobileSession);
  app.get("/api/echo", (c) => {
    c.header("Set-Cookie", "__Host-cs_session=v1.new.seal; Path=/; Max-Age=60; HttpOnly; Secure", {
      append: true,
    });
    c.header("Set-Cookie", "other=1; Path=/", { append: true });
    return c.json({ cookie: c.req.header("cookie") ?? null });
  });
  app.get("/api/out", (c) => {
    c.header("Set-Cookie", "__Host-cs_session=; Path=/; Max-Age=0; HttpOnly; Secure", {
      append: true,
    });
    return c.json({});
  });

  it("reads the header as the session cookie and hands the new session back in the header", async () => {
    const r = await app.request("/api/echo", {
      headers: { [MOBILE_SESSION_HEADER]: "v1.old.seal" },
    });
    expect(await r.json()).toEqual({ cookie: "__Host-cs_session=v1.old.seal" });
    expect(r.headers.get(MOBILE_SESSION_HEADER)).toBe("v1.new.seal");
    expect(r.headers.get("set-cookie")).toBeNull();
  });

  it("says signed out with an empty header", async () => {
    const r = await app.request("/api/out", {
      headers: { [MOBILE_SESSION_HEADER]: "v1.old.seal" },
    });
    expect(r.headers.get(MOBILE_SESSION_HEADER)).toBe("");
  });

  it("leaves a browser's request alone", async () => {
    const r = await app.request("/api/echo", { headers: { cookie: "a=1" } });
    expect(await r.json()).toEqual({ cookie: "a=1" });
    expect(r.headers.get(MOBILE_SESSION_HEADER)).toBeNull();
    expect(r.headers.get("set-cookie")).toContain("__Host-cs_session=v1.new.seal");
  });
});
