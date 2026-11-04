// Languages through the API (docs/plan.md §1.18): the session's language (the user's choice, then
// the client's default, then the browser's, then English), who may set which, isolation between
// clients, and a run writing its timeline in the client's language.

import { stepRun, tenant } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("languages", () => {
  const H = h as ApiHarness;
  const session = async (who: string, acceptLanguage?: string) => {
    const res = await H.call(
      who,
      "GET",
      "/api/session",
      undefined,
      acceptLanguage ? { "accept-language": acceptLanguage } : {},
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return j(res.json).language;
  };

  it("follows the browser, then English, while nothing is chosen", async () => {
    expect(await session(user("a"), "de-CH,de;q=0.9,en;q=0.5")).toEqual({
      effective: "de",
      user: null,
      client: null,
    });
    expect(await session(user("a"), "ja-JP")).toMatchObject({ effective: "en" });
    expect(await session(user("a"))).toMatchObject({ effective: "en" });
  });

  it("the operator sets a client's default, which beats the browser", async () => {
    const res = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/language`, {
      language: "es",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json)).toEqual({ client: "es" });
    expect(await session(user("a"), "de")).toEqual({ effective: "es", user: null, client: "es" });
    // The other settings are kept.
    const [row] = await H.t.db.select().from(tenant).where(eq(tenant.id, H.A.tenantId));
    expect(row?.settings).toMatchObject({ connectors_offered: ["testkit"], language: "es" });
    // Client B is untouched.
    expect(await session(user("b"))).toEqual({ effective: "en", user: null, client: null });
    // The back office reads in English whatever the clients read.
    expect(await session(OPERATOR, "es")).toEqual({ effective: "en", user: null, client: null });
  });

  it("a user's own choice beats the client's, for that user only, and can be cleared", async () => {
    const set = await H.call(user("a"), "PUT", "/api/me/language", { language: "fr" });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(j(set.json)).toEqual({ user: "fr", client: "es" });
    expect(await session(user("a"), "de")).toEqual({ effective: "fr", user: "fr", client: "es" });
    expect(await session(admin("a"))).toMatchObject({ effective: "es", user: null });
    const cleared = await H.call(user("a"), "PUT", "/api/me/language", { language: null });
    expect(j(cleared.json)).toEqual({ user: null, client: "es" });
    expect(await session(user("a"))).toMatchObject({ effective: "es", user: null });
  });

  it("the client admin changes the client's default; a client user can't", async () => {
    const byUser = await H.call(user("a"), "PUT", "/api/client/language", { language: "it" });
    expect(byUser.status).toBe(403);
    const byAdmin = await H.call(admin("a"), "PUT", "/api/client/language", { language: "pt-BR" });
    expect(byAdmin.status, JSON.stringify(byAdmin.json)).toBe(200);
    expect(await session(user("a"))).toMatchObject({ effective: "pt-BR", client: "pt-BR" });
  });

  it("a new client can start in its language; unset follows the browser", async () => {
    const res = await H.call(OPERATOR, "POST", "/api/ops/clients", {
      name: "Taller Ruiz",
      language: "es",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const [row] = await H.t.db
      .select()
      .from(tenant)
      .where(eq(tenant.id, j(res.json).client.id));
    expect(row?.settings).toMatchObject({ connectors_offered: [], language: "es" });
    const plain = await H.call(OPERATOR, "POST", "/api/ops/clients", { name: "Plain shop" });
    const [p] = await H.t.db
      .select()
      .from(tenant)
      .where(eq(tenant.id, j(plain.json).client.id));
    expect(p?.settings).not.toHaveProperty("language");
    const bad = await H.call(OPERATOR, "POST", "/api/ops/clients", {
      name: "Klingon shop",
      language: "tlh",
    });
    expect(bad.status).toBe(400);
  });

  it("refuses languages we don't have, and clients the operator doesn't serve", async () => {
    expect(
      (await H.call(admin("a"), "PUT", "/api/client/language", { language: "es-MX" })).status,
    ).toBe(400);
    expect(
      (await H.call(user("a"), "PUT", "/api/me/language", { language: "klingon" })).status,
    ).toBe(400);
    const other = await H.call(
      "other-operator@example.com",
      "PUT",
      `/api/ops/clients/${H.A.tenantId}/language`,
      { language: "de" },
    );
    expect(other.status).toBe(404);
  });

  describe("a run", () => {
    let agentId = "";
    let versionId = "";

    beforeAll(async () => {
      const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
        slug: "records-clerk-languages",
        bundle: testBundle(),
      });
      const tid = j(tpl.json).agent.id;
      await H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${tid}/versions/${j(tpl.json).version.id}/publish`,
      );
      const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tid}/fork`, {
        clientId: H.A.tenantId,
        serviceName: "Registros",
      });
      agentId = j(fork.json).agent.id;
      versionId = j(fork.json).version.id;
      await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
        bindings: { testkit: H.A.connectionId },
      });
      const pub = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${agentId}/versions/${versionId}/publish`,
      );
      expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    });

    it("writes the timeline's own words in the client's language", async () => {
      await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/language`, {
        language: "de",
      });
      const res = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${agentId}/versions/${versionId}/test-run`,
        { workflow: "fix-record" },
      );
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const runId = j(res.json).runId;
      const params = H.instances.started.get(runId);
      if (!params) throw new Error("the test run was not started");
      // The test run's person step goes to the operator, who approves it.
      const step = new FakeWorkflowStep(async (_name, type) => {
        const items = await H.call(OPERATOR, "GET", "/api/ops/inbox?status=open");
        const item = j(items.json).items.find(
          (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
        );
        const done = await H.call(OPERATOR, "POST", `/api/ops/inbox/${item.id}/resolve`, {
          decision: "approve",
        });
        expect(done.status, JSON.stringify(done.json)).toBe(200);
        return H.instances.events.find((e) => e.event.type === type)?.event.payload;
      });
      const deps = { db: H.db, platform: H.platform, transport: new FakeModel() };
      expect(await executeRun(deps, params, cloudflareStepRunner(step))).toEqual({
        status: "succeeded",
      });
      const rows = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, runId));
      const confirm = rows.find((r) => r.nodeId === "confirm");
      // "Confirm" is the operator's label; "freigegeben" is the platform's word, in German.
      expect(confirm?.summary).toBe("Confirm: freigegeben");
    });
  });
});
