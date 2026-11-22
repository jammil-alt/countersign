// docs/plan.md §1.232: the Close pack end to end through the API, against the fakes (QuickBooks and
// a FakeModel for the write's verifier; nothing live). The operator switches the pack on for a
// client with configuration only (§1.230), forks Month-end close and runs it for October: the
// checklist is checked, the landlord's accrual proposed from its bills, written to QuickBooks as a
// journal entry only once the client's admin signs it, and the month signed off on the card after
// the admin waives what stays open. The portal's report carries no prompt, model or cost; another
// client sees nothing.

import { ContentStore, createQboConnector, generateEncryptionKey } from "@countersign/connectors";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "@countersign/connectors/testing";
import { agent, agentVersion, externalAction, stepRun, withTenant } from "@countersign/db";
import { FakeModel, type LlmRequest } from "@countersign/llm";
import { closeEntry, closePeriod } from "@countersign/pack-bookkeeping";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  allowForAgent,
  createApiHarness,
  FakeWorkflowStep,
  forbiddenKeys,
  OPERATOR,
} from "./api.test-helper";
import { MemoryQboSyncInstances } from "./qbo/instances";
import { runQboSync } from "./qbo/sync";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;
const j = (v: unknown) => v as J;

const ENCRYPTION_KEY = generateEncryptionKey();
const qbo = fakeQbo();

const h = await createApiHarness({
  connectors: () => [
    createQboConnector({
      ...FAKE_QBO_CLIENT,
      environment: "sandbox",
      webhookVerifier: "qbo-verifier",
      fetch: qbo.fetch,
      sleep: async () => {},
    }),
  ],
  env: {
    ENCRYPTION_KEY,
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: "https://app.mezonas.test",
    QBO_WEBHOOK_VERIFIER: "qbo-verifier",
  },
  qboSync: new MemoryQboSyncInstances(),
});
afterAll(() => h?.close());
afterEach(() => vi.useRealTimers());

describe.skipIf(!h)("Month-end close", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const ids = { qbo: "", agentId: "" };
  const cards: J[] = [];
  const signed: string[] = [];

  const inbox = async () => j((await H.call(admin("a"), "GET", "/api/inbox")).json).items as J[];

  /** The client's admin at each wait: signs each journal entry; on the close card, waives and signs off. */
  async function answer(_name: string, type: string): Promise<unknown> {
    const woke = () => H.instances.events.find((e) => e.event.type === type)?.event.payload;
    if (!type.startsWith("inbox-")) throw new Error(`unexpected wait ${type}`);
    const item = (await inbox()).find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
    if (!item) throw new Error(`no open item for ${type}`);
    if (item.payload?.review === "close.signoff") {
      const card = j((await H.call(admin("a"), "GET", `/api/inbox/${item.id}/pack-review`)).json);
      expect(forbiddenKeys(card)).toEqual([]);
      cards.push({ title: item.title, close: card.data.close });
      const early = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/pack-review`, {
        action: "sign_off",
        input: {},
      });
      expect(early.status).toBe(422);
      for (const line of card.data.close.items as J[]) {
        if (line.status !== "open") continue;
        const waived = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/pack-review`, {
          action: "waive",
          input: { itemId: line.id, note: "Our accountant reconciles these in QuickBooks" },
        });
        expect(waived.status, JSON.stringify(waived.json)).toBe(200);
      }
      const done = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/pack-review`, {
        action: "sign_off",
        input: { note: "October closed" },
      });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
    } else {
      signed.push(item.title);
    }
    const resolved = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
      decision: "approve",
    });
    expect(resolved.status, JSON.stringify(resolved.json)).toBe(200);
    return woke();
  }

  /** The write's verifier: works the journal entry's day and total out from the run's sources. */
  function verifier(r: LlmRequest) {
    const tools = (r.tools ?? []).map((t) => (t as { name: string }).name);
    if (!tools.includes("read_sources")) throw new Error(`unexpected call: ${tools}`);
    return {
      toolUse: {
        name: "finish",
        input: {
          derivable: true,
          input: { txnDate: "2026-10-31", expectedTotal: "1250.00" },
          note: "The landlord's bills for August and September were $1,250.00 each.",
          sources: [],
        },
      },
    };
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T14:00:00Z"));
    for (const [Id, Name, AccountType] of [
      ["35", "Checking", "Bank"],
      ["62", "Rent", "Expense"],
      ["2100", "Accrued Liabilities", "Other Current Liability"],
    ] as const) {
      qbo.put("Account", {
        Id,
        SyncToken: "0",
        Name,
        FullyQualifiedName: Name,
        AccountType,
        Active: true,
      });
    }
    qbo.put("Vendor", { Id: "900", SyncToken: "0", DisplayName: "Landlord LLC", Active: true });
    for (const [Id, TxnDate] of [
      ["b1", "2026-08-15"],
      ["b2", "2026-09-15"],
    ] as const) {
      qbo.put("Bill", {
        Id,
        SyncToken: "0",
        TxnDate,
        TotalAmt: 1250,
        Balance: 0,
        VendorRef: { value: "900", name: "Landlord LLC" },
        Line: [
          {
            Amount: 1250,
            DetailType: "AccountBasedExpenseLineDetail",
            AccountBasedExpenseLineDetail: { AccountRef: { value: "62", name: "Rent" } },
          },
        ],
      });
    }
    const offered = await H.call(OPERATOR, "PUT", `/api/ops/clients/${A()}/connectors`, {
      offered: ["qbo"],
    });
    expect(offered.status, JSON.stringify(offered.json)).toBe(200);
    const q = await H.call(admin("a"), "POST", "/api/connections/qbo/authorize");
    const qState = new URL(j(q.json).redirectUrl).searchParams.get("state") ?? "";
    const qDone = await H.call(admin("a"), "POST", "/api/connections/qbo/callback", {
      params: { code: "fixture-code", state: qState, realmId: FAKE_QBO_REALM },
    });
    expect(qDone.status, JSON.stringify(qDone.json)).toBe(200);
    ids.qbo = j(qDone.json).connection.connection.id;
    await H.settle();
    await H.t.db.execute(
      sql`update connection set sync_cursor = sync_cursor - 'running' - 'pending' where id = ${ids.qbo}`,
    );
    await runQboSync(
      {
        db: H.db,
        platform: H.platform,
        content: new ContentStore(H.objects),
        credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
      },
      { tenantId: A(), connectionId: ids.qbo, reason: "operator" },
      { do: <T>(_name: string, fn: () => Promise<T>) => fn() },
    );
    vi.useRealTimers();
  });

  it("switches the pack on with its settings and forks Month-end close", async () => {
    const installed = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${A()}/packs/close/install`,
      { config: { accrual_months: 2 } },
    );
    expect(installed.status, JSON.stringify(installed.json)).toBe(200);
    const [tpl] = await H.t.db
      .select()
      .from(agent)
      .where(and(eq(agent.kind, "template"), eq(agent.slug, "month-end-close")));
    const [v2] = await H.t.db
      .select({ id: agentVersion.id, bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(and(eq(agentVersion.agentId, tpl?.id as string), eq(agentVersion.version, 2)));
    // Invariant 8: the write starts with approval on; ARCHITECTURE §10.18: writes are verified.
    const bundle = j(v2?.bundle);
    expect(bundle.definition.oversight).toMatchObject({ review: "failures", verify: "writes" });
    expect(bundle.definition.permissions).toEqual({ mode: "suggest_only" });
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tpl?.id}/fork`, {
      clientId: A(),
      slug: "close-a",
      versionId: v2?.id,
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    ids.agentId = j(fork.json).agent.id;
    const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${ids.agentId}/operation`, {
      bindings: { qbo: ids.qbo },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    await allowForAgent(H, admin("a"), ids.qbo, ids.agentId);
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${ids.agentId}/versions/${j(fork.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, ids.agentId));
  });

  it("closes October: the accrual written once after a signature, the month signed off on the card", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T14:00:00Z"));
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${ids.agentId}/run`, {
      workflow: "monthly",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("not started");
    const result = await executeRun(
      {
        db: H.db,
        platform: H.platform,
        transport: new FakeModel(Array.from({ length: 2 }, () => verifier)),
        instances: H.instances,
        credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
      },
      params,
      cloudflareStepRunner(new FakeWorkflowStep(answer)),
    );
    const steps = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, params.runId));
    expect(result, JSON.stringify(steps.map((s) => [s.nodeId, s.status, s.output]))).toMatchObject({
      status: "succeeded",
    });
    // One signature for the one journal entry, then the close card.
    expect(signed).toHaveLength(1);
    expect(cards).toHaveLength(1);
    expect(cards[0].close.period).toMatchObject({
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
    });
    // QuickBooks has one journal entry, marked with the close entry's reference.
    const [entry] = await H.t.db.select().from(closeEntry).where(eq(closeEntry.tenantId, A()));
    expect(entry).toMatchObject({ kind: "accrual", status: "posted", amount: "1250.0000" });
    const journals = qbo.requests.filter(
      (r) => r.method === "POST" && /\/journalentry(\?|$)/.test(r.url),
    );
    expect(journals).toHaveLength(1);
    const written = qbo.get("JournalEntry", entry?.qboId ?? "");
    expect(written?.PrivateNote).toBe(
      `Accrued Landlord LLC, October 2026 [Mezonas ce-${entry?.id}]`,
    );
    // The write went through its external action, signed by a person.
    const [action] = await H.t.db
      .select()
      .from(externalAction)
      .where(and(eq(externalAction.tenantId, A()), eq(externalAction.tool, "qbo.journal.create")));
    expect(action).toMatchObject({ status: "done" });
    expect(action?.approvedBy).not.toBeNull();
    const [period] = await H.t.db.select().from(closePeriod).where(eq(closePeriod.tenantId, A()));
    expect(period).toMatchObject({ status: "signed_off", note: "October closed" });
    expect(period?.agentVersionId).not.toBeNull();
  });

  it("shows the client its close with no prompt, model or cost; another client sees none", async () => {
    const portal = await H.call(admin("a"), "GET", "/api/reports/close/close");
    expect(portal.status, JSON.stringify(portal.json)).toBe(200);
    expect(forbiddenKeys(portal.json, /cost|agentVersion/i)).toEqual([]);
    const report = j(portal.json).report;
    expect(report.periods.map((p: J) => [p.periodStart, p.status])).toEqual([
      ["2026-10-01", "signed_off"],
    ]);
    expect(report.close.entries.map((e: J) => [e.kind, e.status, e.amount])).toEqual([
      ["accrual", "posted", "1250.0000"],
    ]);
    const csv = await H.call(admin("a"), "GET", "/api/reports/close/close/csv");
    expect(csv.status).toBe(200);
    await withTenant(H.db, H.B.tenantId, async (tx) => {
      expect(await tx.select().from(closePeriod)).toEqual([]);
      expect(await tx.select().from(closeEntry)).toEqual([]);
    });
    const other = await H.call(admin("b"), "GET", "/api/reports/close/close");
    expect(other.status).not.toBe(200);
  });
});
