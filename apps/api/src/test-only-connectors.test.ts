// Test-only connectors (the testkit, `testOnly` in its manifest) never show to a real client: not in
// the connectors a new or existing client is offered, the portal's lists, the approver rules'
// options or the builder's palette. They show in the Sandbox, for a template's test copy, and
// wherever they are already in use (a connection, a rule, a version that names one of its tools).

import { AgentBundle } from "@countersign/core";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

/** A bundle that names no testkit tool: one notify step. */
function plainBundle() {
  const b = testBundle("Notes clerk");
  const wf = b.workflows[0];
  if (!wf) throw new Error("no workflow");
  return AgentBundle.parse({
    ...b,
    definition: { ...b.definition, extraTools: [] },
    workflows: [
      {
        ...wf,
        workflow: {
          ...wf.workflow,
          steps: wf.workflow.steps.filter((s) => s.kind === "notify"),
        },
      },
    ],
  });
}

const ids = (list: { id: string }[]) => list.map((c) => c.id);

describe.skipIf(!h)("test-only connectors", () => {
  const H = h as ApiHarness;
  let fresh = "";

  it("are never offered to a new client, and its lists leave them out", async () => {
    const created = await H.call(OPERATOR, "POST", "/api/ops/clients", {
      name: "Cabinet shop",
      timezone: "America/Chicago",
      connectorsOffered: [],
      approvals: "operator",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    fresh = j(created.json).client.id;

    // The catalog marks it, so the new-client form can leave it out.
    const catalog = await H.call(OPERATOR, "GET", "/api/ops/connectors");
    expect(catalog.status).toBe(200);
    expect(
      j(catalog.json).connectors.find((c: { id: string }) => c.id === "testkit").testOnly,
    ).toBe(true);

    const conns = await H.call(OPERATOR, "GET", `/api/ops/clients/${fresh}/connections`);
    expect(conns.status, JSON.stringify(conns.json)).toBe(200);
    expect(ids(j(conns.json).connectors)).not.toContain("testkit");

    const rules = await H.call(OPERATOR, "GET", `/api/ops/clients/${fresh}/approver-rules`);
    expect(rules.status, JSON.stringify(rules.json)).toBe(200);
    expect(ids(j(rules.json).connectors)).not.toContain("testkit");
  });

  it("still show where the client already has a connection to them", async () => {
    // The shared clients have a testkit connection (the harness makes one).
    const conns = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/connections`);
    expect(ids(j(conns.json).connectors)).toContain("testkit");
    const rules = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/approver-rules`);
    expect(ids(j(rules.json).connectors)).toContain("testkit");
    const portal = await H.call(admin("a"), "GET", "/api/connections");
    expect(j(portal.json).connections.map((c: { connector: string }) => c.connector)).toContain(
      "testkit",
    );
  });

  it("are left out of the portal's connector list", async () => {
    const res = await H.call(admin("a"), "GET", "/api/connectors");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(ids(j(res.json).connectors)).not.toContain("testkit");
  });

  it("are left out of the builder's palette unless the agent already uses them", async () => {
    const plain = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "notes-clerk",
      bundle: plainBundle(),
    });
    expect(plain.status, JSON.stringify(plain.json)).toBe(200);
    const catalog = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/agents/${j(plain.json).agent.id}/builder-catalog`,
    );
    expect(catalog.status, JSON.stringify(catalog.json)).toBe(200);
    expect(ids(j(catalog.json).connectors)).not.toContain("testkit");
    expect(ids(j(catalog.json).tools).filter((id: string) => id.startsWith("testkit."))).toEqual(
      [],
    );

    // A version that names a testkit tool keeps it, so the builder can still type its step.
    const using = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-clerk-x",
      bundle: testBundle(),
    });
    expect(using.status, JSON.stringify(using.json)).toBe(200);
    const kept = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/agents/${j(using.json).agent.id}/builder-catalog`,
    );
    expect(ids(j(kept.json).connectors)).toContain("testkit");
    expect(ids(j(kept.json).tools)).toContain("testkit.record.update");
  });
});
