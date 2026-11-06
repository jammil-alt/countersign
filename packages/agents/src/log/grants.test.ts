// Grants at the gate (docs/plan.md §1.26), against a real database as cs_worker: a grant narrows
// the binding (a read-only grant refuses a write the matrix lets run; tools outside the subset are
// refused like an unbound connector), a change applies at once, every change is logged, and a
// connector's `bindingKey` picks the binding from the input with no special case in the runtime.

import {
  ConnectorRegistry,
  createTestkitConnector,
  defineConnector,
  defineReadTool,
  TESTKIT_QUERY_TOOL,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import { REVOKED_GRANT } from "@countersign/core";
import { agent, agentChange, agentGrant, connection } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTemplate, fork, publish, updateOperational } from "../registry/agents";
import { grantOf, setGrant } from "../registry/grants";
import { ToolRegistry } from "../registry/tools";
import { callTool } from "../runtime/call-tool";
import type { StepContext } from "../runtime/context";
import { PLATFORM_TOOLS } from "../tools/platform";
import { type Client, createHarness, type Harness, makeBundle } from "./harness.test-helper";
import { createRun } from "./run-log";

const harness = await createHarness();
afterAll(() => harness?.close());

describe.skipIf(!harness)("grants at the gate", () => {
  const h = harness as Harness;
  let agentId = "";
  let versionId = "";

  beforeAll(async () => {
    const tv = await h.ops(async (tx) => {
      const { agent: tpl, version } = await createTemplate(tx, {
        slug: "granted",
        bundle: makeBundle(),
      });
      return publish(tx, { agentId: tpl.id, versionId: version.id, ctx: h.ctx });
    });
    const a = await h.ops(async (tx) => {
      const forked = await fork(tx, {
        tenantId: h.A.tenantId,
        slug: "granted",
        templateVersionId: tv.id,
      });
      await updateOperational(tx, {
        agentId: forked.agent.id,
        patch: { bindings: { testkit: h.A.connectionId } },
      });
      await publish(tx, { agentId: forked.agent.id, versionId: forked.version.id, ctx: h.ctx });
      await tx
        .update(agent)
        .set({ runStatus: "active", stage: "live" })
        .where(eq(agent.id, forked.agent.id));
      return forked;
    });
    agentId = a.agent.id;
    versionId = a.version.id;
  });

  async function step(c: Client, mode: "act" | "suggest_only" = "act"): Promise<StepContext> {
    const deps = h.deps();
    const pinned = await deps.ports.store.loadAgentVersion(c.tenantId, versionId);
    pinned.bundle.definition.permissions.mode = mode;
    const r = await h.client(c, (tx) =>
      createRun(tx, { tenantId: c.tenantId, agentId, workflowSlug: "check-record", mode: "live" }),
    );
    const stepRunId = await deps.ports.log.startStepRun(c.tenantId, {
      runId: r.id,
      nodeId: "s",
      nodeType: "action",
      skillRef: null,
      agentVersionId: versionId,
      input: {},
    });
    return {
      tenantId: c.tenantId,
      agent: pinned,
      runId: r.id,
      stepRunId,
      stepId: "s",
      mode: "live",
      approval: { required: "not_required", onReject: "stop" },
      externalIndex: { next: 0 },
    };
  }

  const grant = (limits: unknown, by: "operator" | "client" = "operator") =>
    h.client(h.A, (tx) =>
      setGrant(tx, {
        tenantId: h.A.tenantId,
        agentId,
        connectionId: h.A.connectionId,
        limits,
        actorId: h.operatorId,
        by,
      }),
    );
  const update = { toolId: TESTKIT_UPDATE_TOOL, input: { id: "r1", amount: "2.00" } };
  const query = { toolId: TESTKIT_QUERY_TOOL, input: {} };

  it("no grant row: the binding alone decides, as before", async () => {
    await h.setPermissions(h.A, { update: "auto" });
    expect(
      await h.client(h.A, (tx) =>
        grantOf(tx, { tenantId: h.A.tenantId, agentId, connectionId: h.A.connectionId }),
      ),
    ).toBeNull();
    expect((await callTool(h.deps(), await step(h.A), update)).status).toBe("done");
  });

  it("a read-only grant refuses a write even when the matrix lets it run; reads still run", async () => {
    await h.setPermissions(h.A, { update: "auto" });
    await grant({ verbs: { create: "off", update: "off", delete: "off" } });
    const writes = h.backend.writes.length;
    const out = await callTool(h.deps(), await step(h.A), update);
    expect(out).toMatchObject({ status: "refused" });
    expect(out.status === "refused" && out.reason).toContain("this agent's access");
    expect(h.backend.writes.length).toBe(writes);
    expect((await callTool(h.deps(), await step(h.A), query)).status).toBe("done");
  });

  it("a grant at approval makes an automatic step wait for a person", async () => {
    await grant({ verbs: { update: "approval" } });
    expect((await callTool(h.deps(), await step(h.A), update)).status).toBe("awaiting_approval");
  });

  it("a tool outside the grant's subset is refused like an unbound connector", async () => {
    await grant({ tools: [TESTKIT_QUERY_TOOL] });
    const out = await callTool(h.deps(), await step(h.A), update);
    expect(out.status).toBe("refused");
    expect((await callTool(h.deps(), await step(h.A), query)).status).toBe("done");
  });

  it("revoking applies at once, mid-run", async () => {
    await grant({});
    const s = await step(h.A);
    expect((await callTool(h.deps(), s, query)).status).toBe("done");
    await grant(REVOKED_GRANT, "client");
    expect((await callTool(h.deps(), s, query)).status).toBe("refused");
    await grant({});
  });

  it("logs each change with before and after, and writes nothing for no change", async () => {
    const count = async () =>
      (
        await h.client(h.A, (tx) =>
          tx.select().from(agentChange).where(eq(agentChange.agentId, agentId)),
        )
      ).filter((r) => (r.change as { kind?: string }).kind === "grant");
    const before = (await count()).length;
    await grant({ verbs: { create: "approval" } });
    await grant({ verbs: { create: "approval" } });
    const after = await count();
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)?.change).toMatchObject({
      kind: "grant",
      by: "operator",
      connectionId: h.A.connectionId,
      before: {},
      after: { verbs: { create: "approval" } },
    });
    await grant({});
  });

  it("refuses limits that don't parse, and grants across clients", async () => {
    await expect(grant({ verbs: { update: "sometimes" } })).rejects.toMatchObject({
      code: "invalid_grant",
    });
    await expect(
      h.client(h.A, (tx) =>
        setGrant(tx, {
          tenantId: h.A.tenantId,
          agentId,
          connectionId: h.B.connectionId,
          limits: {},
          actorId: null,
          by: "operator",
        }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    // B's session sees none of A's grants.
    const seen = await h.client(h.B, (tx) =>
      tx.select().from(agentGrant).where(eq(agentGrant.agentId, agentId)),
    );
    expect(seen).toEqual([]);
  });

  it("a connector's bindingKey picks the binding from the input", async () => {
    const page = defineReadTool({
      id: "sites.page.read",
      description: "Read a page",
      input: z.object({ site: z.string() }),
      output: z.object({ site: z.string(), connection: z.string() }),
      run: async (input, ctx) => ({ site: input.site, connection: ctx.connection.id }),
    });
    const sites = defineConnector({
      id: "sites",
      name: "Sites",
      description: "",
      icon: "sites",
      auth: "none",
      entities: [],
      tools: [page],
      bindingKey: (input) => `sites:${(input as { site?: string }).site ?? ""}`,
    });
    const [conn] = await h.t.db
      .insert(connection)
      .values({ tenantId: h.A.tenantId, connector: "sites", status: "connected" })
      .returning();
    if (!conn) throw new Error("no connection");
    const deps = {
      ...h.deps(),
      tools: new ToolRegistry({
        platform: PLATFORM_TOOLS,
        connectors: new ConnectorRegistry([createTestkitConnector(h.backend), sites]),
      }),
    };
    const s = await step(h.A);
    s.agent.bindings = { ...s.agent.bindings, "sites:acme": conn.id };
    const acme = await callTool(deps, s, { toolId: "sites.page.read", input: { site: "acme" } });
    expect(acme).toMatchObject({ status: "done", output: { site: "acme", connection: conn.id } });
    // Another site has no binding: refused, though the connector is bound for acme.
    const other = await callTool(deps, s, { toolId: "sites.page.read", input: { site: "other" } });
    expect(other.status).toBe("refused");
    // And the grant on that connection narrows it like any other.
    await h.client(h.A, (tx) =>
      setGrant(tx, {
        tenantId: h.A.tenantId,
        agentId,
        connectionId: conn.id,
        limits: REVOKED_GRANT,
        actorId: null,
        by: "client",
      }),
    );
    expect(
      (await callTool(deps, s, { toolId: "sites.page.read", input: { site: "acme" } })).status,
    ).toBe("refused");
    const rows = await h.client(h.A, (tx) =>
      tx
        .select()
        .from(agentGrant)
        .where(and(eq(agentGrant.agentId, agentId), eq(agentGrant.connectionId, conn.id))),
    );
    expect(rows.length).toBe(1);
  });
});
