// The connector self-test (selftest/): against the fake QuickBooks and fake Resend and Twilio
// answers, the Sandbox client's connections each get every check; a provider's refusal is a failed
// check with the provider's words, and the platform health pass reports it; nothing is ever
// written to a tool or sent (no write handler runs, no POST reaches a provider); any client but the
// Sandbox is refused, and so is production, from the route and from the cron.

import {
  type Connector,
  createQboConnector,
  createResendConnector,
  createTwilioConnector,
  type FetchLike,
  generateEncryptionKey,
  QBO_TOOLS,
} from "@countersign/connectors";
import {
  FAKE_QBO_CLIENT,
  FAKE_QBO_REALM,
  fakeQbo,
  jsonResponse,
} from "@countersign/connectors/testing";
import { SELFTEST_CHANGE, type SelftestRun } from "@countersign/core";
import { auditEvent, connection, connectionChange, tenant, withTenant } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR, user } from "./api.test-helper";
import { healthFindings } from "./observability/health";
import { MemoryQboSyncInstances } from "./qbo/instances";
import { credentialsFor } from "./runs/execute";
import { CheckList, scrubError } from "./selftest/checks";
import { runSelftest, SELFTEST_AT, selftestDepsFrom, selftestTick } from "./selftest/runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const qbo = fakeQbo();
/** A query QuickBooks refuses, as it refused `EntityRef` on Purchase on staging (2026-11-27). */
let refuseQuery: string | null = null;
const qboFetch: typeof qbo.fetch = async (url, init) => {
  if (refuseQuery && url.includes("/query") && decodeURIComponent(url).includes(refuseQuery)) {
    return jsonResponse(
      400,
      {
        Fault: {
          Error: [
            { Message: "QueryValidationError: property 'Name' is not queryable", code: "4000" },
          ],
          type: "ValidationFault",
        },
      },
      { intuit_tid: "1-selftest-tid" },
    );
  }
  return qbo.fetch(url, init);
};

const SUBACCOUNT = `AC${"1".repeat(32)}`;
const NUMBER_SID = `PN${"2".repeat(32)}`;
const PHONE = "+15005550006";
const ORIGIN = "https://staging.mezonas.test";
let tenantA = "";
const webhooks = () => ({
  messages: `${ORIGIN}/api/twilio/${tenantA}/messages`,
  status: `${ORIGIN}/api/twilio/${tenantA}/status`,
});
/** Resend's and Twilio's answers; every request is kept. */
const provider: { method: string; url: string }[] = [];
let domainStatus = "verified";
const providerFetch: FetchLike = async (url, init = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  provider.push({ method, url });
  if (method !== "GET") return jsonResponse(500, { message: "the self-test never writes" });
  if (url === "https://api.resend.com/domains/dom_selftest") {
    return jsonResponse(200, {
      id: "dom_selftest",
      name: "mail.mezonas.test",
      status: domainStatus,
      records: [],
    });
  }
  const twilio = "https://api.twilio.com/2010-04-01/Accounts/";
  if (url === `${twilio}${SUBACCOUNT}.json`) {
    return jsonResponse(200, { sid: SUBACCOUNT, status: "active" });
  }
  if (url === `${twilio}${SUBACCOUNT}/IncomingPhoneNumbers/${NUMBER_SID}.json`) {
    return jsonResponse(200, {
      sid: NUMBER_SID,
      phone_number: PHONE,
      sms_url: webhooks().messages,
    });
  }
  if (url.startsWith(`${twilio}${SUBACCOUNT}/Messages.json`)) {
    return jsonResponse(200, { messages: [] });
  }
  return jsonResponse(404, { message: `no fake for ${url}` });
};

/** Every write handler's `run` counts here: the self-test must never reach one. */
let writesRun = 0;
function counted(c: Connector): Connector {
  for (const handler of Object.values(c.tools)) {
    if (handler.kind !== "write") continue;
    const run = handler.run.bind(handler);
    handler.run = async (...args: Parameters<typeof run>) => {
      writesRun += 1;
      return run(...args);
    };
  }
  return c;
}

const h = await createApiHarness({
  connectors: () => [
    counted(
      createQboConnector({
        ...FAKE_QBO_CLIENT,
        environment: "sandbox",
        webhookVerifier: "qbo-verifier",
        fetch: qboFetch,
        sleep: async () => {},
      }),
    ),
    counted(createResendConnector({ fetch: providerFetch, sleep: async () => {} })),
    counted(createTwilioConnector({ fetch: providerFetch })),
  ],
  env: {
    ENCRYPTION_KEY,
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: ORIGIN,
    QBO_WEBHOOK_VERIFIER: "qbo-verifier",
    QBO_ENV: "sandbox",
    RESEND_API_KEY: "re_selftest_platform_key",
  },
  fetch: providerFetch,
  qboSync: new MemoryQboSyncInstances(),
});
afterAll(() => h?.close());

describe.skipIf(!h)("the connector self-test", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const ids = { qbo: "", resend: "", twilio: "" };
  const run = (who = OPERATOR, client = A()) =>
    H.call(who, "POST", `/api/ops/clients/${client}/selftest`);
  const checksOf = (out: SelftestRun, connector: string) =>
    out.connections.find((c) => c.connector === connector)?.checks ?? [];

  beforeAll(async () => {
    tenantA = A();
    // QuickBooks: the client admin signs in with the fake's sandbox company.
    const offered = await H.call(OPERATOR, "PUT", `/api/ops/clients/${A()}/connectors`, {
      offered: ["qbo"],
    });
    expect(offered.status, JSON.stringify(offered.json)).toBe(200);
    const q = await H.call(admin("a"), "POST", "/api/connections/qbo/authorize");
    const state = new URL(j(q.json).redirectUrl).searchParams.get("state") ?? "";
    const done = await H.call(admin("a"), "POST", "/api/connections/qbo/callback", {
      params: { code: "fixture-code", state, realmId: FAKE_QBO_REALM },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    ids.qbo = j(done.json).connection.connection.id;
    await H.settle();
    // Resend and Twilio, as the back office provisions them: config and a stored key.
    const [resend] = await H.t.db
      .insert(connection)
      .values({
        tenantId: A(),
        connector: "resend",
        status: "connected",
        config: {
          domain: "mail.mezonas.test",
          domainId: "dom_selftest",
          domainStatus: "verified",
          sendingDomain: "mail.mezonas.test",
        },
      })
      .returning();
    const [twilio] = await H.t.db
      .insert(connection)
      .values({
        tenantId: A(),
        connector: "twilio",
        status: "connected",
        config: {
          subaccountSid: SUBACCOUNT,
          numbers: [
            {
              sid: NUMBER_SID,
              phoneNumber: PHONE,
              friendlyName: null,
              capabilities: { sms: true, mms: false, voice: false },
              whatsapp: false,
              purchasedAt: "2026-11-01T00:00:00.000Z",
            },
          ],
          webhooks: webhooks(),
          provisionedAt: "2026-11-01T00:00:00.000Z",
        },
      })
      .returning();
    if (!resend || !twilio) throw new Error("connections not inserted");
    ids.resend = resend.id;
    ids.twilio = twilio.id;
    const creds = credentialsFor(H.db, { current: ENCRYPTION_KEY });
    const ref = (row: typeof resend) => ({
      id: row.id,
      tenantId: row.tenantId,
      connector: row.connector,
      status: row.status,
      externalAccountId: null,
      config: {},
      permissions: {},
    });
    await creds(ref(resend)).set({ apiKey: "re_selftest_sending_key" });
    await creds(ref(twilio)).set({ accountSid: SUBACCOUNT, authToken: "t".repeat(32) });
    // Client A is the Sandbox here; client B is a real client.
    await H.t.db
      .update(tenant)
      .set({ settings: sql`${tenant.settings} || '{"sandbox": true}'::jsonb` })
      .where(eq(tenant.id, A()));
  });

  it("runs every check on each of the Sandbox's live connections, through the tools' own code", async () => {
    const res = await run();
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const out = j(res.json) as SelftestRun;
    expect(out.connections.map((c) => c.connector)).toEqual(["qbo", "resend", "twilio"]);
    const failed = out.connections.flatMap((c) => c.checks.filter((k) => k.status === "fail"));
    expect(failed).toEqual([]);
    expect(out.failed).toBe(0);

    const qboIds = checksOf(out, "qbo").map((c) => c.id);
    for (const id of [
      QBO_TOOLS.accountQuery,
      `${QBO_TOOLS.accountQuery}:types`,
      QBO_TOOLS.classQuery,
      QBO_TOOLS.customerQuery,
      QBO_TOOLS.vendorQuery,
      `${QBO_TOOLS.vendorQuery}:name`,
      QBO_TOOLS.itemQuery,
      QBO_TOOLS.billQuery,
      `${QBO_TOOLS.billQuery}:lastDays`,
      `${QBO_TOOLS.billQuery}:vendorId`,
      `${QBO_TOOLS.billQuery}:vendorId+lastDays`,
      QBO_TOOLS.purchaseQuery,
      `${QBO_TOOLS.purchaseQuery}:lastDays`,
      `${QBO_TOOLS.purchaseQuery}:vendorId`,
      `${QBO_TOOLS.purchaseQuery}:vendorId+lastDays`,
      QBO_TOOLS.purchaseOrderQuery,
      `${QBO_TOOLS.purchaseOrderQuery}:vendorId`,
      `${QBO_TOOLS.purchaseOrderQuery}:status`,
      QBO_TOOLS.attachableList,
      `${QBO_TOOLS.invoiceQuery}:open`,
      QBO_TOOLS.paymentQuery,
      QBO_TOOLS.agingReport,
      "qbo.banking.find",
      "qbo.account.register",
      `${QBO_TOOLS.billUpdateMemo}:before`,
      `${QBO_TOOLS.purchaseUpdateMemo}:before`,
      `${QBO_TOOLS.itemUpdatePurchaseCost}:before`,
      `${QBO_TOOLS.invoiceAddNote}:before`,
      `${QBO_TOOLS.vendorCreate}:before`,
      `${QBO_TOOLS.billCreate}:before`,
      `${QBO_TOOLS.purchaseOrderCreate}:before`,
    ]) {
      expect(qboIds, id).toContain(id);
    }
    // Every QuickBooks write is covered: by its before read, or its input parsed with a sample.
    const qboConnector = H.platform.connectors.get("qbo");
    const writes = qboConnector?.manifest.tools.filter((t) => t.verb !== "read") ?? [];
    expect(writes.length).toBeGreaterThan(10);
    for (const w of writes) {
      expect(
        qboIds.some((id) => id === `${w.id}:before` || id === `${w.id}:input`),
        w.id,
      ).toBe(true);
    }
    const qbo = checksOf(out, "qbo");
    const sampled = qbo.filter((c) => c.id.endsWith(":input"));
    expect(sampled.filter((c) => c.status !== "pass")).toEqual([]);
    // The before reads run even while the connection's writes are off (a new connection's are).
    const befores = qbo.filter((c) => c.id.endsWith(":before"));
    expect(befores.length).toBe(7);
    expect(befores.filter((c) => c.status !== "pass")).toEqual([]);
    // The fake company has no bank account: its register is skipped, said so.
    expect(qbo.filter((c) => c.status === "skip").map((c) => [c.id, c.error])).toEqual([
      ["qbo.account.register", "no bank account"],
    ]);

    expect(checksOf(out, "resend").map((c) => [c.id, c.status])).toEqual([
      ["resend.config", "pass"],
      ["resend.key", "pass"],
      ["resend.domain", "pass"],
      ["core.emailSubjectFrom", "pass"],
      ["resend.send:input", "pass"],
    ]);
    expect(checksOf(out, "twilio").map((c) => [c.id, c.status])).toEqual([
      ["twilio.config", "pass"],
      ["twilio.account", "pass"],
      ["twilio.numbers", "pass"],
      ["messages.search", "pass"],
      ["sms.send:input", "pass"],
    ]);
    for (const c of out.connections.flatMap((x) => x.checks)) {
      expect(c.ms).toBeGreaterThanOrEqual(0);
    }
    // No secret in the answer.
    expect(JSON.stringify(out)).not.toMatch(/re_selftest|tttttttt|access_token|refresh/i);
  });

  it("never runs a write and never sends: no write handler, no POST to any provider", async () => {
    writesRun = 0;
    const before = { qbo: qbo.apiCalls("POST").length, provider: provider.length };
    const res = await run();
    expect(res.status).toBe(200);
    expect(writesRun).toBe(0);
    expect(qbo.apiCalls("POST").length).toBe(before.qbo);
    const sent = provider.slice(before.provider);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((r) => r.method !== "GET")).toEqual([]);
    expect(sent.some((r) => r.url.includes("/emails"))).toBe(false);
  });

  it("reports a provider's refusal as a failed check with its words, and the health pass finds it", async () => {
    refuseQuery = "from Class";
    domainStatus = "pending";
    try {
      const res = await run();
      expect(res.status).toBe(200);
      const out = j(res.json) as SelftestRun;
      const cls = checksOf(out, "qbo").find((c) => c.id === QBO_TOOLS.classQuery);
      expect(cls?.status).toBe("fail");
      expect(cls?.error).toContain("is not queryable");
      expect(cls?.error).toContain("1-selftest-tid");
      const domain = checksOf(out, "resend").find((c) => c.id === "resend.domain");
      expect(domain).toMatchObject({ status: "fail" });
      expect(domain?.error).toContain("pending");
      // The other checks still ran.
      expect(checksOf(out, "qbo").find((c) => c.id === QBO_TOOLS.itemQuery)?.status).toBe("pass");
      expect(out.failed).toBe(2);

      // Stored per connection, and read back as the latest.
      const last = j((await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/selftest`)).json);
      expect(last.failed).toBe(2);
      expect(last.connections.map((c: { connectionId: string }) => c.connectionId).sort()).toEqual(
        [ids.qbo, ids.resend, ids.twilio].sort(),
      );

      // The platform health pass (ops_health, and Sentry hourly): one finding per failed check.
      const now = new Date();
      const findings = await withTenant(H.db, A(), (tx) =>
        healthFindings(tx, [A()], {
          from: new Date(now.getTime() - 3_600_000),
          to: new Date(now.getTime() + 1000),
          now,
          states: false,
        }),
      );
      const mine = findings.filter((f) => f.kind === "selftest_failed");
      expect(mine.map((f) => f.key).sort()).toEqual([QBO_TOOLS.classQuery, "resend.domain"]);
      expect(mine.find((f) => f.key === QBO_TOOLS.classQuery)?.ids).toEqual([ids.qbo]);
    } finally {
      refuseQuery = null;
      domainStatus = "verified";
    }
  });

  it("is audited, operators only, and refuses any client but the Sandbox", async () => {
    const audited = await H.t.db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, A()), sql`${auditEvent.action} like '%selftest%'`));
    expect(audited.length).toBeGreaterThan(0);
    const b = await run(OPERATOR, H.B.tenantId);
    expect(b.status).toBe(403);
    expect(j(b.json).error.code).toBe("not_sandbox");
    // A client the operator doesn't serve is not found; client roles never reach /api/ops.
    expect((await run(OPERATOR, H.C.tenantId)).status).toBe(404);
    for (const who of [admin("a"), user("a")]) expect((await run(who)).status).toBe(403);
    const rowsB = await H.t.db
      .select()
      .from(connectionChange)
      .where(
        and(
          eq(connectionChange.tenantId, H.B.tenantId),
          sql`${connectionChange.change}->>'kind' = ${SELFTEST_CHANGE}`,
        ),
      );
    expect(rowsB).toEqual([]);
  });

  it("never runs in production, from the cron or when called", async () => {
    const base = selftestDepsFrom(H.env, { db: H.db, platform: H.platform, deps: {} });
    if (!base) throw new Error("no deps");
    for (const environment of ["production", undefined]) {
      const deps = { ...base, environment, fetch: providerFetch };
      await expect(runSelftest(deps, A(), { kind: "cron" })).rejects.toMatchObject({
        status: 403,
        code: "selftest_off",
      });
      const at = new Date(Date.UTC(2026, 10, 28, SELFTEST_AT.hour, SELFTEST_AT.minute));
      expect(await selftestTick(deps, at)).toBe(0);
    }
  });

  it("runs from the cron once a day, at its minute, for the Sandbox only", async () => {
    const base = selftestDepsFrom(H.env, { db: H.db, platform: H.platform, deps: {} });
    if (!base) throw new Error("no deps");
    const deps = { ...base, environment: "staging", fetch: providerFetch };
    const at = new Date(Date.UTC(2026, 10, 28, SELFTEST_AT.hour, SELFTEST_AT.minute));
    expect(await selftestTick(deps, new Date(at.getTime() + 60_000))).toBe(0);
    expect(await selftestTick(deps, at)).toBe(1);
    const [row] = await H.t.db
      .select()
      .from(connectionChange)
      .where(
        and(
          eq(connectionChange.tenantId, A()),
          eq(connectionChange.createdAt, at),
          eq(connectionChange.connectionId, ids.qbo),
        ),
      );
    expect(row?.actorId).toBeNull();
    expect(row?.change).toMatchObject({
      kind: SELFTEST_CHANGE,
      by: "cron",
      environment: "staging",
    });
  });
});

describe("the self-test's check list", () => {
  it("keeps a refusal's words without anything shaped like a secret", () => {
    const text = scrubError(
      new Error("Resend answered 401: Bearer abcdefghijklmnopqrstuvwxyz0123 is not valid"),
    );
    expect(text).toContain("Resend answered 401");
    expect(text).not.toContain("abcdefghijklmnop");
  });

  it("counts a check that hangs as failed and goes on", async () => {
    const list = new CheckList(20);
    await list.check("slow", "never answers", () => new Promise(() => {}));
    await list.check("fast", "answers", async () => undefined);
    expect(list.results.map((r) => [r.id, r.status])).toEqual([
      ["slow", "fail"],
      ["fast", "pass"],
    ]);
    expect(list.results[0]?.error).toContain("no answer");
  });
});
