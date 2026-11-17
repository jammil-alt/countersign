// Deciding a card from the phone app (audit 5.2): a phone's session approves, rejects or answers
// a card only with a signature from one of the person's own phones in this client, still set up.
// Without one, with a wrong one or with one from a removed phone, the decision is refused with
// 403 `signature_required` and nothing changes; the routes the app has no signature for (a batch,
// an edit, taking a change back, a suggestion, a drafted change, a pack's review) refuse a phone's
// session outright. A browser's session decides as before.

import { sealSession } from "@countersign/auth";
import { memoryCodeVerifier } from "@countersign/connectors";
import { deviceSignedText, itemFingerprintText, MOBILE_SESSION_HEADER } from "@countersign/core";
import { appUser, auditEvent, inboxItem, personDevice } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness } from "./api.test-helper";
import { sha256Hex } from "./mobile/devices";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const PASSWORD = "q".repeat(64);
const ORIGIN = "https://staging.mezonas.test";

const h = await createApiHarness({
  env: {
    ENVIRONMENT: "staging",
    AUTH_PROVIDER: "workos",
    WORKOS_CLIENT_ID: "client_test",
    WORKOS_API_KEY: "sk_test",
    WORKOS_COOKIE_PASSWORD: PASSWORD,
    APP_ORIGIN: ORIGIN,
    TWILIO_VERIFY_SERVICE_SID: "VA00000000000000000000000000000003",
    ENCRYPTION_KEY: "mobile-sign-required-test-key-0123456789",
    MOBILE_SIGNIN: "on",
  },
  workos: {
    authorizationUrl: ({ state }) => `https://workos.test/authorize?state=${state}`,
    authenticateWithCode: async () => {
      throw new Error("no sign-in in this test");
    },
    refresh: async () => {
      throw new Error("no refresh in this test");
    },
    logoutUrl: () => "https://workos.test/logout",
    revokeSession: async () => undefined,
    organizationName: async () => null,
    sendInvitation: async () => ({ id: "inv_1", acceptUrl: null }),
    revokeInvitation: async () => "revoked" as const,
  },
  codeVerifier: memoryCodeVerifier("135790"),
});
afterAll(() => h?.close());

const b64url = (bytes: ArrayBuffer) => Buffer.from(new Uint8Array(bytes)).toString("base64url");

async function phoneKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    publicKey: {
      kty: "EC" as const,
      crv: "P-256" as const,
      x: jwk.x as string,
      y: jwk.y as string,
    },
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

describe.skipIf(!h)("deciding a card from a phone's session", () => {
  const H = h as ApiHarness;

  /** A session for the client admin of client A: the phone app's (`ph`) or a browser's. */
  async function session(phone: boolean): Promise<string> {
    const uid = H.A.admin;
    const [u] = await H.t.db.select().from(appUser).where(eq(appUser.id, uid));
    const now = Math.floor(Date.now() / 1000);
    return sealSession(
      {
        v: 1,
        uid,
        wuid: `wu_${uid}`,
        email: u?.email ?? "",
        worg: null,
        sid: `sess_${uid}`,
        rt: `rt_${uid}`,
        iat: now - 60,
        rat: now + 240,
        exp: now + 3600,
        lat: now,
        mf: "done",
        ...(phone ? { ph: true as const } : {}),
      },
      PASSWORD,
    );
  }

  async function request(
    as: { phone: string } | { browser: string },
    method: string,
    path: string,
    body?: unknown,
  ) {
    const headers: Record<string, string> =
      "phone" in as
        ? { [MOBILE_SESSION_HEADER]: as.phone }
        : { cookie: `__Host-cs_session=${as.browser}`, origin: ORIGIN };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await H.app.request(
      path,
      { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
      H.env,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never,
    );
    const text = await res.text();
    return { status: res.status, json: j(text ? JSON.parse(text) : null) };
  }

  /** One of the admin's phones with a signing key. */
  async function device() {
    const key = await phoneKey();
    const [row] = await H.t.db
      .insert(personDevice)
      .values({
        tenantId: H.A.tenantId,
        userId: H.A.admin,
        name: "Phone",
        platform: "ios",
        pushToken: null,
        publicKey: key.publicKey,
      })
      .returning();
    return { id: row?.id as string, key };
  }

  /** An approval waiting on the client admin, with its fingerprint as the portal shows it. */
  async function card(title: string, as: { phone: string } | { browser: string }) {
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
    const id = row?.id as string;
    const listed = await request(as, "GET", "/api/inbox");
    expect(listed.status, JSON.stringify(listed.json)).toBe(200);
    const shown = listed.json.items.find((i: { id: string }) => i.id === id);
    return { id, fingerprint: await sha256Hex(itemFingerprintText(shown)) };
  }

  async function signature(
    signer: { id: string; key: Awaited<ReturnType<typeof phoneKey>> },
    item: { id: string; fingerprint: string },
    decision: "approve" | "reject",
  ) {
    const at = new Date().toISOString();
    const text = deviceSignedText({
      deviceId: signer.id,
      itemId: item.id,
      decision,
      fingerprint: item.fingerprint,
      at,
    });
    return {
      deviceId: signer.id,
      at,
      fingerprint: item.fingerprint,
      signature: await signer.key.sign(text),
    };
  }

  async function unchanged(id: string) {
    const [row] = await H.t.db.select().from(inboxItem).where(eq(inboxItem.id, id));
    expect(row).toMatchObject({ status: "open", resolution: null, resolvedBy: null });
    const signed = await H.t.db
      .select()
      .from(auditEvent)
      .where(
        and(eq(auditEvent.tenantId, H.A.tenantId), eq(auditEvent.action, "inbox.device_signed")),
      );
    expect(signed.filter((a) => j(a.target).item === id)).toEqual([]);
  }

  it("refuses a phone's decision without a signature, and nothing changes", async () => {
    const phone = { phone: await session(true) };
    const item = await card("Send PO 2001", phone);
    for (const body of [
      { decision: "approve", fingerprint: item.fingerprint },
      { decision: "reject", fingerprint: item.fingerprint },
      { decision: "approve", answer: "yes", fingerprint: item.fingerprint },
    ]) {
      const r = await request(phone, "POST", `/api/inbox/${item.id}/resolve`, body);
      expect([r.status, r.json?.error?.code], JSON.stringify(body)).toEqual([
        403,
        "signature_required",
      ]);
    }
    await unchanged(item.id);
  });

  it("refuses a phone's decision with a wrong signature", async () => {
    const phone = { phone: await session(true) };
    const mine = await device();
    const item = await card("Send PO 2002", phone);
    // Signed as a no, sent as a yes.
    const swapped = await request(phone, "POST", `/api/inbox/${item.id}/resolve`, {
      decision: "approve",
      fingerprint: item.fingerprint,
      deviceSignature: await signature(mine, item, "reject"),
    });
    expect([swapped.status, swapped.json?.error?.code]).toEqual([403, "signature_required"]);
    // Signed by a key that isn't this phone's.
    const other = await phoneKey();
    const stranger = await request(phone, "POST", `/api/inbox/${item.id}/resolve`, {
      decision: "approve",
      fingerprint: item.fingerprint,
      deviceSignature: await signature({ id: mine.id, key: other }, item, "approve"),
    });
    expect([stranger.status, stranger.json?.error?.code]).toEqual([403, "signature_required"]);
    await unchanged(item.id);
  });

  it("refuses a signature from a removed phone", async () => {
    const phone = { phone: await session(true) };
    const removed = await device();
    const item = await card("Send PO 2003", phone);
    const deviceSignature = await signature(removed, item, "approve");
    // Removed as the device routes remove it: its key is cleared and the row stays.
    await H.t.db
      .update(personDevice)
      .set({ revokedAt: new Date(), pushToken: null, publicKey: null })
      .where(eq(personDevice.id, removed.id));
    const r = await request(phone, "POST", `/api/inbox/${item.id}/resolve`, {
      decision: "approve",
      fingerprint: item.fingerprint,
      deviceSignature,
    });
    expect([r.status, r.json?.error?.code]).toEqual([403, "signature_required"]);
    await unchanged(item.id);
  });

  it("takes a phone's decision with a valid signature", async () => {
    const phone = { phone: await session(true) };
    const mine = await device();
    const item = await card("Send PO 2004", phone);
    const r = await request(phone, "POST", `/api/inbox/${item.id}/resolve`, {
      decision: "approve",
      fingerprint: item.fingerprint,
      deviceSignature: await signature(mine, item, "approve"),
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.item.status).toBe("resolved");
  });

  it("takes a browser's decision without a signature, as before", async () => {
    const browser = { browser: await session(false) };
    const item = await card("Send PO 2005", browser);
    const r = await request(browser, "POST", `/api/inbox/${item.id}/resolve`, {
      decision: "approve",
      fingerprint: item.fingerprint,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.item.status).toBe("resolved");
  });

  it("refuses a phone's session on the decisions it has no signature for", async () => {
    const phone = { phone: await session(true) };
    const item = await card("Send PO 2006", phone);
    const id = item.id;
    const calls: [string, string, unknown][] = [
      [
        "POST",
        "/api/inbox/batch/resolve",
        { batchKey: "b", approve: [id], fingerprints: { [id]: item.fingerprint } },
      ],
      ["PUT", `/api/inbox/${id}/edit`, { input: {} }],
      ["POST", `/api/inbox/${id}/undo-change`, undefined],
      ["POST", `/api/directory/suggestions/${id}`, { decision: "approve" }],
      ["POST", `/api/account-changes/${id}/resolve`, { decision: "approve" }],
      ["POST", `/api/inbox/${id}/pack-review`, { action: "approve", input: {} }],
    ];
    for (const [method, path, body] of calls) {
      const r = await request(phone, method, path, body);
      expect([r.status, r.json?.error?.code], path).toEqual([403, "signature_required"]);
    }
    await unchanged(id);
  });
});
