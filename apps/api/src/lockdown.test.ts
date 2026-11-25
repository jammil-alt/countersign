// Lockdown, stream K2 (docs/plan.md §1.243, docs/lockdown-plan.md §2): through the real app, a
// locked client's requests are answered 423 `client_locked`; a provider's call for it is answered
// as usual and counted, never refused; forwarded email for it is dropped and counted, never
// bounced; other clients carry on.

import { agent, agentVersion, run } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
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
  const env = harness.env as { SECURITY_OFFICER_EMAILS?: string };
  afterEach(async () => {
    await harness.t.db.$client`update tenant set locked_at = null, lock = null`;
    await harness.t.db.$client`delete from platform_lock`;
    delete env.SECURITY_OFFICER_EMAILS;
  });

  it("answers the client's own requests 423, and the other clients' as before", async () => {
    await lockA();
    const res = await harness.call(admin("a"), "GET", "/api/inbox");
    expect(res.status).toBe(423);
    expect((res.json as J).error.code).toBe("client_locked");
    expect((await harness.call(admin("b"), "GET", "/api/inbox")).status).toBe(200);
    // Still audited (invariant 14): the refusal's row names the locked client.
    const [audited] = await harness.t.db.$client<{ n: number }[]>`
      select count(*)::int as n from audit_event
      where tenant_id = ${A.tenantId} and http_status = 423`;
    expect(audited?.n).toBeGreaterThan(0);
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

  describe("the lock and unlock routes", () => {
    const owner = harness.t.db;

    /** A live agent of A's with one run in progress. */
    async function runningRun(): Promise<string> {
      const [a] = await owner
        .insert(agent)
        .values({
          tenantId: A.tenantId,
          kind: "client",
          slug: `lockdown-${Date.now()}`,
          name: "Records clerk",
          serviceName: "Records clerk",
          runStatus: "active",
          stage: "live",
        })
        .returning();
      if (!a) throw new Error("no agent");
      const [v] = await owner
        .insert(agentVersion)
        .values({
          tenantId: A.tenantId,
          agentId: a.id,
          version: 1,
          bundle: testBundle(),
          bundleHash: `hash-${a.id}`,
          status: "live",
          authorType: "operator",
        })
        .returning();
      if (!v) throw new Error("no version");
      const [r] = await owner
        .insert(run)
        .values({
          tenantId: A.tenantId,
          agentId: a.id,
          agentVersionId: v.id,
          workflowSlug: "fix-record",
          mode: "live",
          status: "running",
          trigger: { type: "manual" },
          startedAt: new Date(),
        })
        .returning();
      if (!r) throw new Error("no run");
      // Its Workflow instance, as the engine would hold one for a run in progress.
      harness.instances.started.set(r.id, { runId: r.id } as never);
      return r.id;
    }

    const lockPath = `/api/ops/clients/${A.tenantId}/lock`;
    const unlockPath = `/api/ops/clients/${A.tenantId}/unlock`;
    const reason = "A token may have leaked";

    it("locks a client with its name typed, stops its runs, and lists it", async () => {
      const runId = await runningRun();
      expect(
        (await harness.call(OPERATOR, "POST", lockPath, { reason, confirmName: "Not it" })).status,
      ).toBe(422);
      const name = (
        await owner.$client<{ name: string }[]>`
        select name from tenant where id = ${A.tenantId}`
      )[0]?.name;
      const locked = await harness.call(OPERATOR, "POST", lockPath, { reason, confirmName: name });
      expect(locked.status).toBe(200);
      expect(locked.json).toMatchObject({ changed: true, runsStopped: 1 });
      const [r] = await owner.select().from(run).where(eq(run.id, runId));
      expect(r?.status).toBe("cancelled");
      expect(r?.error).toMatchObject({ code: "client_locked" });
      expect(harness.instances.terminated).toContain(runId);
      expect((await harness.call(admin("a"), "GET", "/api/inbox")).status).toBe(423);
      const state = (await harness.call(OPERATOR, "GET", "/api/ops/lockdown")).json as J;
      expect(state.clients).toEqual([
        expect.objectContaining({ clientId: A.tenantId, side: "operator", reason }),
      ]);
      expect(state.canUnlock).toBe(false);
      // Locking again changes nothing.
      expect(
        (await harness.call(OPERATOR, "POST", lockPath, { reason, confirmName: name })).json,
      ).toMatchObject({ changed: false, runsStopped: 0 });
    });

    it("lets only the security officer unlock, with a note in the client's history", async () => {
      await lockA();
      const note = { note: "False alarm: the token was ours" };
      expect((await harness.call(OPERATOR, "POST", unlockPath, note)).json).toMatchObject({
        error: { code: "no_security_officer" },
      });
      env.SECURITY_OFFICER_EMAILS = OTHER_OPERATOR;
      expect((await harness.call(OPERATOR, "POST", unlockPath, note)).json).toMatchObject({
        error: { code: "not_security_officer" },
      });
      env.SECURITY_OFFICER_EMAILS = ` ${OPERATOR.toUpperCase()} `;
      const done = await harness.call(OPERATOR, "POST", unlockPath, note);
      expect(done.status).toBe(200);
      expect(done.json).toEqual({ changed: true });
      expect((await harness.call(admin("a"), "GET", "/api/inbox")).status).toBe(200);
      const [last] = await owner.$client<{ reason: string; change: unknown }[]>`
        select reason, change from tenant_change where tenant_id = ${A.tenantId}
        order by created_at desc limit 1`;
      expect(last).toEqual({ reason: note.note, change: { lock: { from: "operator", to: null } } });
    });

    it("locks everything with the words typed, and only the security officer unlocks it", async () => {
      const lockAll = (confirm: string) =>
        harness.call(OPERATOR, "POST", "/api/ops/lockdown/lock", { reason, confirm });
      expect((await lockAll("lock it")).status).toBe(422);
      expect((await lockAll("Lock everything")).status).toBe(200);
      expect((await harness.call(admin("b"), "GET", "/api/inbox")).status).toBe(423);
      const state = (await harness.call(OPERATOR, "GET", "/api/ops/lockdown")).json as J;
      expect(state.everything).toMatchObject({ reason, by: { email: OPERATOR } });
      const unlock = () =>
        harness.call(OPERATOR, "POST", "/api/ops/lockdown/unlock", { note: "Key rotated" });
      expect((await unlock()).status).toBe(403);
      env.SECURITY_OFFICER_EMAILS = OPERATOR;
      expect((await unlock()).json).toEqual({ changed: true });
      expect((await harness.call(admin("b"), "GET", "/api/inbox")).status).toBe(200);
      const history = await owner.$client<{ change: unknown; reason: string }[]>`
        select change, reason from tenant_change where tenant_id = ${B.tenantId}
        order by created_at desc limit 2`;
      expect(history).toEqual([
        { change: { lockEverything: { from: true, to: false } }, reason: "Key rotated" },
        { change: { lockEverything: { from: false, to: true } }, reason },
      ]);
    });

    it("lets a client admin lock their own account, see it locked, and lift their own lock", async () => {
      const own = await harness.call(admin("a"), "POST", "/api/account/lock", {
        reason: "Lost a laptop",
      });
      expect(own.json).toMatchObject({ changed: true });
      expect((await harness.call(user("a"), "GET", "/api/inbox")).status).toBe(423);
      expect((await harness.call(user("a"), "GET", "/api/account/lock")).json).toMatchObject({
        locked: true,
        side: "client",
        reason: "Lost a laptop",
        canUnlock: false,
      });
      expect((await harness.call(admin("a"), "GET", "/api/account/lock")).json).toMatchObject({
        canUnlock: true,
      });
      const lifted = await harness.call(admin("a"), "POST", "/api/account/unlock", {
        note: "Found it",
      });
      expect(lifted.json).toEqual({ changed: true });
      expect((await harness.call(user("a"), "GET", "/api/inbox")).status).toBe(200);
    });

    it("lets only the security officer read a locked client, read only", async () => {
      const runId = await runningRun();
      await lockA();
      const runs = (query = "") => harness.call(OPERATOR, "GET", `/api/ops/runs${query}`);
      // The back office leaves the locked client out.
      expect(JSON.stringify((await runs()).json)).not.toContain(runId);
      const refused = await runs("?investigate=1");
      expect(refused.status).toBe(403);
      expect((refused.json as J).error.code).toBe("not_security_officer");
      env.SECURITY_OFFICER_EMAILS = OPERATOR;
      const seen = await runs("?investigate=1");
      expect(seen.status).toBe(200);
      expect(JSON.stringify(seen.json)).toContain(runId);
      // Audited, written apart from the read-only transaction.
      const [audited] = await owner.$client<{ n: number }[]>`
        select count(*)::int as n from audit_event
        where action like 'GET /api/ops/runs%' and outcome = 'ok' and http_status = 200
          and target::text like '%investigate%'`;
      expect(audited?.n).toBeGreaterThan(0);
    });

    it("never shows a client our reason, nor lets it lift our lock", async () => {
      await lockA();
      expect((await harness.call(admin("a"), "GET", "/api/account/lock")).json).toMatchObject({
        locked: true,
        side: "operator",
        reason: null,
        canUnlock: false,
      });
      const refused = await harness.call(admin("a"), "POST", "/api/account/unlock", {
        note: "Please",
      });
      expect(refused.status).toBe(403);
      expect((refused.json as J).error.code).toBe("locked_by_us");
    });
  });
});
