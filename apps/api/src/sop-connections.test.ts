// Sentry MEZONAS-API-F: signing in to a tool again changed an agent's SOP without a revision at the
// time, so the hourly check recorded it ("sop revisions made by the hourly check"). A sign-in, a
// disconnect and a sign-in again each record the revision when they happen, by the person who did
// it; the hourly check then finds nothing to record.

import { createQboConnector, generateEncryptionKey } from "@countersign/connectors";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "@countersign/connectors/testing";
import { agent, sopRevision } from "@countersign/db";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";
import { MemoryQboSyncInstances } from "./qbo/instances";
import { SOP_CHECK_MINUTE, sopCheckTick } from "./sop/revisions";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const qbo = fakeQbo({ codes: ["code-1", "code-2", "code-3"] });

const h = await createApiHarness({
  connectors: () => [
    createQboConnector({
      ...FAKE_QBO_CLIENT,
      environment: "sandbox",
      fetch: qbo.fetch,
      sleep: async () => {},
    }),
  ],
  env: {
    ENCRYPTION_KEY: generateEncryptionKey(),
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: "https://staging.mezonas.test",
  },
  qboSync: new MemoryQboSyncInstances(),
  appDbMax: 1,
});
afterAll(() => h?.close());

describe.skipIf(!h)("an SOP's revisions when its connection changes", () => {
  const H = h as ApiHarness;
  let agentId = "";
  let connectionId = "";

  async function signIn(code: string) {
    const start = await H.call(admin("a"), "POST", "/api/connections/qbo/authorize");
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const state = new URL(j(start.json).redirectUrl).searchParams.get("state") ?? "";
    const done = await H.call(admin("a"), "POST", "/api/connections/qbo/callback", {
      params: { code, state, realmId: FAKE_QBO_REALM },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    await H.settle();
    return j(done.json).connection.connection.id as string;
  }

  const revisions = () =>
    H.t.db
      .select()
      .from(sopRevision)
      .where(eq(sopRevision.agentId, agentId))
      .orderBy(desc(sopRevision.major), desc(sopRevision.minor));

  const hourlyCheck = () => {
    const at = new Date();
    at.setUTCMinutes(SOP_CHECK_MINUTE);
    return sopCheckTick(H.db, H.platform, at);
  };

  beforeAll(async () => {
    const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/connectors`, {
      offered: ["testkit", "qbo"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    connectionId = await signIn("code-1");

    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "sop-conn",
      bundle: testBundle("Bills in"),
    });
    expect(tpl.status, JSON.stringify(tpl.json)).toBe(200);
    const tid = j(tpl.json).agent.id as string;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${tid}/versions/${j(tpl.json).version.id}/publish`,
    );
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tid}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Bills in",
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    agentId = j(fork.json).agent.id;
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", stage: "live", bindings: { qbo: connectionId } })
      .where(eq(agent.id, agentId));
    // The first revision, with QuickBooks connected.
    const read = await H.call(admin("a"), "GET", `/api/services/${agentId}/sop`);
    expect(read.status, JSON.stringify(read.json)).toBe(200);
    expect(await revisions()).toHaveLength(1);
  });

  it("records a disconnect at the time, and the hourly check finds nothing", async () => {
    const off = await H.call(admin("a"), "DELETE", `/api/connections/${connectionId}`);
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    const rows = await revisions();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ source: "connection", changedBySide: "client" });
    await hourlyCheck();
    expect(await revisions()).toHaveLength(2);
  });

  it("records signing in again at the time, by the person, and the hourly check finds nothing", async () => {
    expect(await signIn("code-2")).toBe(connectionId);
    const rows = await revisions();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ source: "connection", changedBySide: "client" });
    expect(rows[0]?.changedByUserId).toBeTruthy();
    await hourlyCheck();
    expect(await revisions()).toHaveLength(3);
    const same = await H.t.db
      .select()
      .from(sopRevision)
      .where(and(eq(sopRevision.agentId, agentId), eq(sopRevision.source, "check")));
    expect(same).toEqual([]);
  });

  it("makes no revision for a pause or a resume, now or at the hourly check", async () => {
    const before = (await revisions()).length;
    const pause = await H.call(admin("a"), "POST", `/api/services/${agentId}/pause`, {
      reason: "Month end",
    });
    expect(pause.status, JSON.stringify(pause.json)).toBe(200);
    await hourlyCheck();
    const resume = await H.call(admin("a"), "POST", `/api/services/${agentId}/resume`, {});
    expect(resume.status, JSON.stringify(resume.json)).toBe(200);
    await hourlyCheck();
    expect(await revisions()).toHaveLength(before);
  });
});
