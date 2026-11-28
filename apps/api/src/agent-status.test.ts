// QA (2026-11-22, agent status): a client's agents counted one way on every page (the clients
// list, the command center and the client page), and an agent's page names what it shows (its
// connectors by their manifests' names, its skills by theirs) without waiting on the catalogs.

import { createQboConnector } from "@countersign/connectors";
import { FAKE_QBO_CLIENT, fakeQbo } from "@countersign/connectors/testing";
import { clientAgentCounts } from "@countersign/core";
import { agent } from "@countersign/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";

const qbo = fakeQbo();
const h = await createApiHarness({
  connectors: () => [
    createQboConnector({
      ...FAKE_QBO_CLIENT,
      environment: "sandbox",
      fetch: qbo.fetch,
      sleep: async () => {},
    }),
  ],
});
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

describe.skipIf(!h)("agent status", () => {
  const H = h as ApiHarness;
  let clerk = "";

  beforeAll(async () => {
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/platform-templates/bill-clerk/install", {
      version: 1,
    });
    expect(tpl.status, JSON.stringify(tpl.json)).toBe(200);
    const templateId = j(tpl.json).template.id as string;
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "AP bill clerk",
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    clerk = j(fork.json).agent.id;
    // Beside it, as on the Demo client: one in trial, one live, a template's test copy and a
    // retired agent; only the first two (and the clerk) are the client's agents.
    const row = (slug: string, values: Partial<typeof agent.$inferInsert>) => ({
      tenantId: H.A.tenantId,
      kind: "client" as const,
      slug,
      name: slug,
      ...values,
    });
    await H.t.db
      .insert(agent)
      .values([
        row("in-trial", { runStatus: "active", stage: "trial" }),
        row("live-one", { runStatus: "active", stage: "live" }),
        row("old-one", { runStatus: "retired", stage: "live" }),
        row("bill-clerk-test", { runStatus: "active", testCopy: true, templateId }),
      ]);
  });

  it("counts the same agents on the clients list, the command center and the client page", async () => {
    const list = await H.call(OPERATOR, "GET", "/api/ops/clients");
    expect(list.status).toBe(200);
    const fromList = j(list.json).clients.find((c: { id: string }) => c.id === H.A.tenantId).agents;

    const cc = await H.call(OPERATOR, "GET", "/api/ops/command-center");
    expect(cc.status).toBe(200);
    const fromHome = j(cc.json).agents.filter(
      (a: { client: { id: string } }) => a.client.id === H.A.tenantId,
    ).length;

    const page = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}`);
    expect(page.status).toBe(200);
    const fromPage = clientAgentCounts(j(page.json).agents);

    // The forked clerk, the one in trial and the live one; never the test copy or the retired.
    expect(fromList).toBe(3);
    expect(fromHome).toBe(3);
    expect(fromPage.total).toBe(3);
    expect(fromPage.live).toBe(1);
  });

  it("brings the names its page shows: QuickBooks Online, never Qbo", async () => {
    const res = await H.call(OPERATOR, "GET", `/api/ops/agents/${clerk}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const names = j(res.json).names;
    expect(names.connectors.qbo).toBe("QuickBooks Online");
    // Every skill its version names has its skill's name.
    const skills = j(res.json).latest?.bundle.definition.skills ?? [];
    for (const s of skills as { skill: string }[]) {
      expect(typeof names.skills[s.skill], s.skill).toBe("string");
    }
    expect(Object.keys(names.skills).length).toBeGreaterThan(0);
  });
});
