// The code service inside workerd: the real `Codes` entry point, the real Durable Objects with
// SQLite storage, the Twilio webhook route and the email handler. Twilio's REST API is a fake on
// the global fetch (the Worker runs in the tests' isolate).

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleEmail } from "./index";
import { decodeBase32, encodeBase32, totp } from "./totp";
import { twilioSignature } from "./twilio";

const codes = exports.Codes;
const TENANT = "0190f0c2-7f00-7000-8000-000000000001";
const OTHER = "0190f0c2-7f00-7000-8000-000000000002";
const ORIGIN = "http://localhost:8788";
const PASS = (domain: string) =>
  `mx.cloudflare.net; dkim=pass header.d=${domain}; spf=pass smtp.mailfrom=bounce@${domain}; dmarc=pass (p=reject) header.from=${domain}`;

/** Everything the Worker logged in this test. */
let logged: string[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function newIdentity(tenantId = TENANT, label = "Acme supplier portal") {
  const made = await codes.createIdentity({ tenantId, label });
  if (!made.ok) throw new Error(made.error.message);
  return made.value;
}

function email(input: { to: string; from: string; subject: string; text: string; auth?: string }) {
  const domain = input.from.slice(input.from.indexOf("@") + 1);
  const raw = [
    `Authentication-Results: ${input.auth ?? PASS(domain)}`,
    `From: Sender <${input.from}>`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.text,
    "",
  ].join("\r\n");
  const bytes = new TextEncoder().encode(raw);
  return {
    to: input.to,
    rawSize: bytes.length,
    raw: new Response(bytes).body as ReadableStream<Uint8Array>,
  };
}

const stub = (identityId: string) => env.IDENTITY.get(env.IDENTITY.idFromName(identityId));

/** Every value in every table of an identity's storage, as one string. */
async function rawStorage(identityId: string): Promise<string> {
  return runInDurableObject(stub(identityId), (_instance, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>(
        "select name from sqlite_master where type = 'table' and name not like '_cf_%'",
      )
      .toArray();
    return tables
      .map((t) => JSON.stringify(state.storage.sql.exec(`select * from "${t.name}"`).toArray()))
      .join("\n");
  });
}

async function openEmailWait(identityId: string, ttlSeconds = 300) {
  const opened = await codes.openWait({
    tenantId: TENANT,
    identityId,
    siteKey: "acme",
    channel: "email",
    sender: "@acme.example",
    pattern: "code is (\\d{6})",
    ttlSeconds,
  });
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

describe("identities", () => {
  it("creates an identity with an agent address and lists nothing secret", async () => {
    const id = await newIdentity();
    expect(id.email).toBe(`agent-${id.id}@agents.localhost`);
    expect(id.phone).toBeNull();
    const read = await codes.identity({ tenantId: TENANT, identityId: id.id });
    expect(read).toEqual({ ok: true, value: id });
  });

  it("refuses every call for another client's identity", async () => {
    const id = await newIdentity();
    const calls = [
      codes.identity({ tenantId: OTHER, identityId: id.id }),
      codes.openWait({ tenantId: OTHER, identityId: id.id, siteKey: "acme", channel: "totp" }),
      codes.claim({ tenantId: OTHER, identityId: id.id, waitId: crypto.randomUUID() }),
      codes.setAuthenticator({
        tenantId: OTHER,
        identityId: id.id,
        siteKey: "acme",
        otpauthUri: "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      }),
      codes.addPhone({ tenantId: OTHER, identityId: id.id }),
      codes.deleteIdentity({ tenantId: OTHER, identityId: id.id }),
    ];
    for (const r of await Promise.all(calls)) {
      expect(r).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    // The other client's alerts never include it.
    const alerts = await codes.alerts({ tenantId: OTHER, since: "2000-01-01T00:00:00Z" });
    expect(alerts).toEqual({ ok: true, value: { alerts: [] } });
    // Still there for its own client.
    expect((await codes.identity({ tenantId: TENANT, identityId: id.id })).ok).toBe(true);
  });

  it("refuses malformed input", async () => {
    const r = await codes.openWait({
      tenantId: TENANT,
      identityId: "abcdefgh2345",
      siteKey: "acme",
      channel: "email",
      sender: "@acme.example",
      pattern: "(\\d{6})",
      ttlSeconds: 900,
    });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("deletes an identity, its storage and its number", async () => {
    const id = await newIdentity();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/Local.json")) {
        return Response.json({ available_phone_numbers: [{ phone_number: "+14155550111" }] });
      }
      if (init?.method === "POST")
        return Response.json({ sid: "PN9", phone_number: "+14155550111" });
      return new Response(null, { status: 204 });
    });
    expect((await codes.addPhone({ tenantId: TENANT, identityId: id.id })).ok).toBe(true);
    const gone = await codes.deleteIdentity({ tenantId: TENANT, identityId: id.id });
    expect(gone).toEqual({ ok: true, value: { deleted: true, phoneReleased: true } });
    expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
    expect(String(fetch.mock.calls.at(-1)?.[0])).toContain("/IncomingPhoneNumbers/PN9.json");
    expect(await codes.identity({ tenantId: TENANT, identityId: id.id })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("emailed codes", () => {
  it("hands a matching code to the wait once, then answers expired", async () => {
    const id = await newIdentity();
    const wait = await openEmailWait(id.id);
    const pending = await codes.claim({ tenantId: TENANT, identityId: id.id, waitId: wait.waitId });
    expect(pending).toMatchObject({ ok: true, value: { status: "pending" } });

    const outcome = await handleEmail(
      email({
        to: id.email,
        from: "no-reply@acme.example",
        subject: "Sign in",
        text: "Your code is 482913. Do not share it.",
      }),
      env,
    );
    expect(outcome).toBe("matched");
    // Held sealed: the code is not in storage as text.
    expect(await rawStorage(id.id)).not.toContain("482913");

    const first = await codes.claim({ tenantId: TENANT, identityId: id.id, waitId: wait.waitId });
    expect(first).toEqual({ ok: true, value: { status: "code", code: "482913" } });
    const second = await codes.claim({ tenantId: TENANT, identityId: id.id, waitId: wait.waitId });
    expect(second).toEqual({ ok: true, value: { status: "expired" } });
    // Logs carry metadata only.
    expect(logged.some((l) => l.includes("message.matched"))).toBe(true);
    expect(logged.join("\n")).not.toContain("482913");
    // The message was deleted when claimed.
    const left = await runInDurableObject(stub(id.id), (_i, state) =>
      state.storage.sql.exec("select count(*) as n from message").one(),
    );
    expect(left.n).toBe(0);
  });

  it("takes the same mail handed on by apps/api (receiveEmail), and nothing too large", async () => {
    const id = await newIdentity();
    const wait = await openEmailWait(id.id);
    const m = email({
      to: id.email,
      from: "no-reply@acme.example",
      subject: "Sign in",
      text: "Your code is 731905.",
    });
    const raw = new Uint8Array(await new Response(m.raw).arrayBuffer());
    expect(await codes.receiveEmail({ to: id.email, raw })).toEqual({ outcome: "matched" });
    const r = await codes.claim({ tenantId: TENANT, identityId: id.id, waitId: wait.waitId });
    expect(r).toEqual({ ok: true, value: { status: "code", code: "731905" } });
    // An address that names no identity, and mail over the limit, are dropped.
    expect(await codes.receiveEmail({ to: "agent-zzzzzzzzzzzz@nowhere.example", raw })).toEqual({
      outcome: "unknown_address",
    });
    expect(
      await codes.receiveEmail({ to: id.email, raw: new Uint8Array(25 * 1024 * 1024 + 1) }),
    ).toEqual({ outcome: "too_large" });
  });

  it("answers expired after the wait's time, and alerts on a code that comes late", async () => {
    const id = await newIdentity();
    const wait = await openEmailWait(id.id, 30);
    await runInDurableObject(stub(id.id), (_i, state) => {
      state.storage.sql.exec("update wait set expires_at = ?", Date.now() - 1000);
    });
    const late = await handleEmail(
      email({
        to: id.email,
        from: "no-reply@acme.example",
        subject: "Sign in",
        text: "Your code is 111222.",
      }),
      env,
    );
    expect(late).toBe("alert");
    const r = await codes.claim({ tenantId: TENANT, identityId: id.id, waitId: wait.waitId });
    expect(r).toEqual({ ok: true, value: { status: "expired" } });
  });

  it("matches neither another sender nor a message the pattern doesn't fit", async () => {
    const id = await newIdentity();
    const wait = await openEmailWait(id.id);
    const otherSender = await handleEmail(
      email({
        to: id.email,
        from: "no-reply@evil.example",
        subject: "Sign in",
        text: "Your code is 999000.",
      }),
      env,
    );
    const otherShape = await handleEmail(
      email({
        to: id.email,
        from: "no-reply@acme.example",
        subject: "Sign in",
        text: "Use 999000 to sign in.",
      }),
      env,
    );
    expect([otherSender, otherShape]).toEqual(["alert", "alert"]);
    const r = await codes.claim({ tenantId: TENANT, identityId: id.id, waitId: wait.waitId });
    expect(r).toMatchObject({ ok: true, value: { status: "pending" } });
  });

  it("ignores email that fails DMARC, even from the expected sender", async () => {
    const id = await newIdentity();
    const wait = await openEmailWait(id.id);
    const outcome = await handleEmail(
      email({
        to: id.email,
        from: "no-reply@acme.example",
        subject: "Sign in",
        text: "Your code is 123123.",
        auth: PASS("acme.example").replace("dmarc=pass", "dmarc=fail"),
      }),
      env,
    );
    expect(outcome).toBe("unauthenticated");
    const r = await codes.claim({ tenantId: TENANT, identityId: id.id, waitId: wait.waitId });
    expect(r).toMatchObject({ ok: true, value: { status: "pending" } });
    expect(await rawStorage(id.id)).not.toContain("123123");
  });

  it("raises alerts with metadata only for unsolicited codes and resets, never handing them out", async () => {
    const id = await newIdentity(TENANT, "Alerts test");
    const since = new Date(Date.now() - 1000).toISOString();
    expect(
      await handleEmail(
        email({
          to: id.email,
          from: "no-reply@acme.example",
          subject: "Your code",
          text: "Your code is 555666.",
        }),
        env,
      ),
    ).toBe("alert");
    expect(
      await handleEmail(
        email({
          to: id.email,
          from: "accounts@acme.example",
          subject: "Reset your password",
          text: "Someone asked to reset your password.",
        }),
        env,
      ),
    ).toBe("alert");
    const listed = await codes.alerts({ tenantId: TENANT, since });
    if (!listed.ok) throw new Error(listed.error.message);
    const mine = listed.value.alerts.filter((a) => a.identityId === id.id);
    expect(mine.map((a) => a.kind)).toEqual(["unsolicited_code", "reset_attempt"]);
    expect(mine[0]).toMatchObject({
      tenantId: TENANT,
      identityLabel: "Alerts test",
      channel: "email",
      sender: "no-reply@acme.example",
    });
    expect(JSON.stringify(listed)).not.toContain("555666");
    expect(await rawStorage(id.id)).not.toContain("555666");
    expect(logged.join("\n")).not.toContain("555666");
    expect(logged.join("\n")).not.toContain("Reset your password");
    // A wait opened afterwards does not get the earlier code.
    const wait = await openEmailWait(id.id);
    const r = await codes.claim({ tenantId: TENANT, identityId: id.id, waitId: wait.waitId });
    expect(r).toMatchObject({ ok: true, value: { status: "pending" } });
  });

  it("deletes a held code after ten minutes", async () => {
    const id = await newIdentity();
    await openEmailWait(id.id);
    await handleEmail(
      email({
        to: id.email,
        from: "no-reply@acme.example",
        subject: "Sign in",
        text: "Your code is 777888.",
      }),
      env,
    );
    await runInDurableObject(stub(id.id), (_i, state) => {
      state.storage.sql.exec("update message set expires_at = ?", Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(stub(id.id))).toBe(true);
    const left = await runInDurableObject(stub(id.id), (_i, state) =>
      state.storage.sql.exec("select count(*) as n from message").one(),
    );
    expect(left.n).toBe(0);
  });
});

describe("email codes off (EMAIL_CODES, the default in wrangler.jsonc)", () => {
  /** Runs `fn` with this identity's object reading EMAIL_CODES=off, then puts it back. */
  async function withEmailCodesOff<T>(identityId: string, fn: () => Promise<T>): Promise<T> {
    const swap = (value: string) =>
      runInDurableObject(stub(identityId), (instance) => {
        const o = instance as unknown as { env: Record<string, unknown> };
        o.env = { ...o.env, EMAIL_CODES: value };
      });
    await swap("off");
    try {
      return await fn();
    } finally {
      await swap("on");
    }
  }

  it("refuses to open an email wait, and still opens text and authenticator waits", async () => {
    const id = await newIdentity();
    await codes.setAuthenticator({
      tenantId: TENANT,
      identityId: id.id,
      siteKey: "acme",
      otpauthUri: "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    });
    await withEmailCodesOff(id.id, async () => {
      const r = await codes.openWait({
        tenantId: TENANT,
        identityId: id.id,
        siteKey: "acme",
        channel: "email",
        sender: "@acme.example",
        pattern: "code is (\\d{6})",
      });
      expect(r).toEqual({
        ok: false,
        error: { code: "not_configured", message: "email codes are off until verified" },
      });
      const totpWait = await codes.openWait({
        tenantId: TENANT,
        identityId: id.id,
        siteKey: "acme",
        channel: "totp",
      });
      expect(totpWait.ok).toBe(true);
    });
  });

  it("never fills a wait from email, but still raises an alert", async () => {
    const id = await newIdentity();
    // Opened while on; the email arrives while off.
    const wait = await openEmailWait(id.id);
    const since = new Date(Date.now() - 1000).toISOString();
    const outcome = await withEmailCodesOff(id.id, () =>
      handleEmail(
        email({
          to: id.email,
          from: "no-reply@acme.example",
          subject: "Sign in",
          text: "Your code is 314159.",
        }),
        env,
      ),
    );
    expect(outcome).toBe("alert");
    const r = await codes.claim({ tenantId: TENANT, identityId: id.id, waitId: wait.waitId });
    expect(r).toMatchObject({ ok: true, value: { status: "pending" } });
    const listed = await codes.alerts({ tenantId: TENANT, since });
    expect(
      listed.ok && listed.value.alerts.filter((a) => a.identityId === id.id).map((a) => a.kind),
    ).toEqual(["unsolicited_code"]);
    expect(await rawStorage(id.id)).not.toContain("314159");
  });

  it("fills the same wait once switched on", async () => {
    const id = await newIdentity();
    const wait = await openEmailWait(id.id);
    const outcome = await handleEmail(
      email({
        to: id.email,
        from: "no-reply@acme.example",
        subject: "Sign in",
        text: "Your code is 271828.",
      }),
      env,
    );
    expect(outcome).toBe("matched");
    const r = await codes.claim({ tenantId: TENANT, identityId: id.id, waitId: wait.waitId });
    expect(r).toEqual({ ok: true, value: { status: "code", code: "271828" } });
  });
});

describe("daily cap", () => {
  it("refuses code requests past the cap (3 in these tests)", async () => {
    const id = await newIdentity();
    for (let i = 0; i < 3; i++) await openEmailWait(id.id);
    const fourth = await codes.openWait({
      tenantId: TENANT,
      identityId: id.id,
      siteKey: "acme",
      channel: "email",
      sender: "@acme.example",
      pattern: "(\\d{6})",
    });
    expect(fourth).toMatchObject({ ok: false, error: { code: "daily_cap" } });
  });
});

describe("texted codes", () => {
  async function withPhone() {
    const id = await newIdentity();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/Local.json")) {
        expect(url.searchParams.get("AreaCode")).toBe("415");
        return Response.json({ available_phone_numbers: [{ phone_number: "+14155550123" }] });
      }
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("SmsUrl")).toBe(`${ORIGIN}/twilio/sms/${id.id}`);
      return Response.json({ sid: "PN1", phone_number: "+14155550123" }, { status: 201 });
    });
    const added = await codes.addPhone({ tenantId: TENANT, identityId: id.id, areaCode: "415" });
    if (!added.ok) throw new Error(added.error.message);
    expect(added.value.phone).toBe("+14155550123");
    vi.mocked(globalThis.fetch).mockRestore();
    return added.value;
  }

  async function text(identityId: string, params: Record<string, string>, signature?: string) {
    const url = `${ORIGIN}/twilio/sms/${identityId}`;
    const sig = signature ?? (await twilioSignature("test-auth-token", url, params));
    return exports.default.fetch(
      new Request(url, {
        method: "POST",
        headers: { "x-twilio-signature": sig },
        body: new URLSearchParams(params),
      }),
    );
  }

  it("buys a number, takes a signed text for the open wait and hands the code once", async () => {
    const id = await withPhone();
    const opened = await codes.openWait({
      tenantId: TENANT,
      identityId: id.id,
      siteKey: "acme",
      channel: "sms",
      sender: "+15550001111",
      pattern: "(\\d{6}) is your",
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const params = {
      AccountSid: "AC00000000000000000000000000000000",
      From: "+15550001111",
      To: "+14155550123",
      Body: "246810 is your Acme code",
    };
    const res = await text(id.id, params);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const claim = { tenantId: TENANT, identityId: id.id, waitId: opened.value.waitId };
    expect(await codes.claim(claim)).toEqual({
      ok: true,
      value: { status: "code", code: "246810" },
    });
    expect(await codes.claim(claim)).toEqual({ ok: true, value: { status: "expired" } });
  });

  it("refuses a text with a bad signature", async () => {
    const id = await withPhone();
    const opened = await codes.openWait({
      tenantId: TENANT,
      identityId: id.id,
      siteKey: "acme",
      channel: "sms",
      sender: "+15550001111",
      pattern: "(\\d{6})",
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const params = {
      AccountSid: "AC00000000000000000000000000000000",
      From: "+15550001111",
      To: "+14155550123",
      Body: "135791 is your Acme code",
    };
    const res = await text(id.id, params, "AAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    expect(res.status).toBe(403);
    const r = await codes.claim({
      tenantId: TENANT,
      identityId: id.id,
      waitId: opened.value.waitId,
    });
    expect(r).toMatchObject({ ok: true, value: { status: "pending" } });
  });

  it("refuses a second number for the same identity", async () => {
    const id = await withPhone();
    const again = await codes.addPhone({ tenantId: TENANT, identityId: id.id });
    expect(again).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("authenticator codes", () => {
  it("stores the secret sealed and gives the current TOTP code once", async () => {
    const id = await newIdentity();
    const secretB32 = encodeBase32(new TextEncoder().encode("12345678901234567890"));
    const set = await codes.setAuthenticator({
      tenantId: TENANT,
      identityId: id.id,
      siteKey: "acme",
      otpauthUri: `otpauth://totp/Acme:agent?secret=${secretB32}&issuer=Acme`,
    });
    expect(set).toMatchObject({ ok: true, value: { siteKey: "acme", digits: 6, period: 30 } });
    expect(JSON.stringify(set)).not.toContain(secretB32);

    const raw = await rawStorage(id.id);
    expect(raw).not.toContain(secretB32);
    expect(raw).not.toContain(secretB32.toLowerCase());
    expect(raw).not.toContain("12345678901234567890");

    const view = await codes.identity({ tenantId: TENANT, identityId: id.id });
    expect(JSON.stringify(view)).not.toContain(secretB32);

    const opened = await codes.openWait({
      tenantId: TENANT,
      identityId: id.id,
      siteKey: "acme",
      channel: "totp",
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const claim = { tenantId: TENANT, identityId: id.id, waitId: opened.value.waitId };
    const got = await codes.claim(claim);
    const secret = decodeBase32(secretB32) as Uint8Array;
    const now = await totp({ secret, algorithm: "SHA1", digits: 6, period: 30 }, new Date());
    const before = await totp(
      { secret, algorithm: "SHA1", digits: 6, period: 30 },
      new Date(Date.now() - 30_000),
    );
    expect(got.ok && got.value.status === "code" && [now, before].includes(got.value.code)).toBe(
      true,
    );
    expect(await codes.claim(claim)).toEqual({ ok: true, value: { status: "expired" } });
  });

  it("refuses an authenticator wait for a site with no secret", async () => {
    const id = await newIdentity();
    const r = await codes.openWait({
      tenantId: TENANT,
      identityId: id.id,
      siteKey: "nowhere",
      channel: "totp",
    });
    expect(r).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("public routes", () => {
  it("answers health and nothing else", async () => {
    expect((await exports.default.fetch("http://x/health")).status).toBe(200);
    expect((await exports.default.fetch("http://x/createIdentity")).status).toBe(404);
  });
});
