// Lockdown, stream K2 (docs/plan.md §1.243, docs/lockdown-plan.md §2): through the real app, a
// locked client's requests are answered 423 `client_locked`; a provider's call for it is answered
// as usual and counted, never refused; forwarded email for it is dropped and counted, never
// bounced; other clients carry on.

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { admin, createApiHarness } from "./api.test-helper";
import { handleEmail } from "./email";
import { defaultDeps } from "./http";

// biome-ignore lint/suspicious/noExplicitAny: response JSON in assertions
type J = any;

const h = await createApiHarness();
afterAll(() => h?.close());

const DOMAIN = "in.mezonas.test";

describe.skipIf(!h)("a locked client, through the app", () => {
  const harness = h as NonNullable<typeof h>;
  (harness.env as { EMAIL_FORWARDING_DOMAIN?: string }).EMAIL_FORWARDING_DOMAIN = DOMAIN;
  const A = harness.A;
  const B = harness.B;

  const lockA = () => harness.t.db.$client`
    update tenant set locked_at = now(),
      lock = ${JSON.stringify({ side: "operator", by: A.admin, at: new Date().toISOString(), reason: "Test" })}::jsonb
    where id = ${A.tenantId}`;
  const inbound = async () => {
    const [row] = await harness.t.db.$client<{ inbound: Record<string, number> | null }[]>`
      select lock->'inbound' as inbound from tenant where id = ${A.tenantId}`;
    return row?.inbound ?? {};
  };
  afterEach(async () => {
    await harness.t.db.$client`update tenant set locked_at = null, lock = null`;
    await harness.t.db.$client`delete from platform_lock`;
  });

  it("answers the client's own requests 423, and the other clients' as before", async () => {
    await lockA();
    const res = await harness.call(admin("a"), "GET", "/api/inbox");
    expect(res.status).toBe(423);
    expect((res.json as J).error.code).toBe("client_locked");
    expect((await harness.call(admin("b"), "GET", "/api/inbox")).status).toBe(200);
  });

  it("answers everyone's 423 while everything is locked", async () => {
    await harness.t.db.$client`
      insert into platform_lock (locked_by, reason)
      select id, 'Leaked key' from app_user where email = ${admin("a")}`;
    expect((await harness.call(admin("b"), "GET", "/api/inbox")).status).toBe(423);
  });

  it("answers a provider's call for a locked client as usual, and counts it", async () => {
    const hook = "00000000-0000-4000-8000-00000000abcd";
    // Unlocked: an unknown hook is refused, as before.
    const before = await harness.call(null, "POST", `/api/hooks/${A.tenantId}/${hook}`, {});
    expect(before.status).toBe(401);
    await lockA();
    const locked = await harness.call(null, "POST", `/api/hooks/${A.tenantId}/${hook}`, {});
    expect(locked.status).toBe(200);
    expect(locked.json).toEqual({});
    await harness.call(null, "POST", `/api/hooks/${A.tenantId}/${hook}`, {});
    expect(await inbound()).toEqual({ webhook: 2 });
    // Another client's hook is untouched by A's lock.
    expect((await harness.call(null, "POST", `/api/hooks/${B.tenantId}/${hook}`, {})).status).toBe(
      401,
    );
  });

  it("drops forwarded email for a locked client, counts it, and never bounces it", async () => {
    const got = await harness.call(admin("a"), "GET", "/api/connections/upload/forwarding");
    const address = (got.json as J).forwarding.address as string;
    await lockA();
    const raw = new TextEncoder().encode(
      [
        "Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=billing@vendor.example",
        "From: billing@vendor.example",
        `To: ${address}`,
        "Subject: Invoice",
        "",
        "See attached.",
      ].join("\r\n"),
    );
    const deps = {
      ...defaultDeps,
      openDb: () => ({ db: harness.db, close: async () => {} }),
      instances: () => harness.instances,
      objects: () => harness.objects,
      extractionTransport: () => null,
    };
    const out = await handleEmail(
      {
        from: "billing@vendor.example",
        to: address,
        raw: new Response(raw).body as ReadableStream<Uint8Array>,
        rawSize: raw.length,
      },
      harness.env,
      () => {},
      deps,
    );
    expect(out).toBeNull();
    expect(await inbound()).toEqual({ email: 1 });
  });
});
