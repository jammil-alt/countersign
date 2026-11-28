// Step model E (docs/step-model-plan.md §10c): a connector's actions are switched on or off on its
// page, an off action is left out of the catalog and refused where it would run, and an action can be
// requested from a connector, an agent or a client's own account (it becomes a Dev queue request).

import {
  ActionRequestAnswer,
  CatalogConnector,
  PortalActionRequestAnswer,
} from "@countersign/core";
import { agent } from "@countersign/db";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const find = (list: any[], id: string) => list.find((c) => c.id === id);

describe.skipIf(!h)("a connector's actions", () => {
  const H = h as ApiHarness;

  it("lists each action with its kind and whether it is on, built-in Web too", async () => {
    const res = await H.call(OPERATOR, "GET", "/api/ops/connectors");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const list = j(res.json).connectors;
    for (const c of list) expect(CatalogConnector.safeParse(c).success, c.id).toBe(true);
    const testkit = find(list, "testkit");
    expect(testkit.actions.length).toBe(testkit.tools.length);
    expect(testkit.actions.every((a: { on: boolean }) => a.on)).toBe(true);
    const kinds = new Set(testkit.actions.map((a: { kind: string }) => a.kind));
    expect([...kinds].every((k) => ["get", "change", "save", "send"].includes(k as string))).toBe(
      true,
    );
    const web = find(list, "web");
    expect(web).toMatchObject({ builtIn: true, auth: "none", available: true });
    expect(web.actions.map((a: { id: string; label: string }) => [a.id, a.label])).toEqual([
      ["web.search", "Search the web"],
      ["web.fetch", "Read a web page"],
    ]);
  });

  it("switches an action off and back on, refusing ids the connector doesn't have", async () => {
    const before = j((await H.call(OPERATOR, "GET", "/api/ops/connectors")).json).connectors;
    const write = find(before, "testkit").actions.find(
      (a: { kind: string }) => a.kind === "change",
    );
    expect(write).toBeTruthy();

    // Only the operator's.
    expect(
      (await H.call(admin("a"), "PUT", "/api/ops/connectors/testkit", { actions: {} })).status,
    ).toBe(403);
    expect(
      (
        await H.call(user("a"), "PUT", "/api/ops/connectors/testkit", {
          actions: { [write.id]: false },
        })
      ).status,
    ).toBe(403);

    const unknown = await H.call(OPERATOR, "PUT", "/api/ops/connectors/testkit", {
      actions: { "testkit.nothing.here": true },
    });
    expect(unknown.status).toBe(422);
    expect(j(unknown.json).error.code).toBe("unknown_action");

    const off = await H.call(OPERATOR, "PUT", "/api/ops/connectors/testkit", {
      actions: { [write.id]: false },
    });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    const offActions = j(off.json).connector.actions;
    expect(find(offActions, write.id).on).toBe(false);
    // The others kept their state: the first switch writes every action's choice.
    expect(offActions.filter((a: { on: boolean }) => a.on).length).toBe(offActions.length - 1);

    const on = await H.call(OPERATOR, "PUT", "/api/ops/connectors/testkit", {
      actions: { [write.id]: true },
    });
    expect(find(j(on.json).connector.actions, write.id).on).toBe(true);
  });

  it("switches Web's actions, which have no matrix or default access to set", async () => {
    const off = await H.call(OPERATOR, "PUT", "/api/ops/connectors/web", {
      actions: { "web.fetch": false },
    });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    const actions = j(off.json).connector.actions;
    expect(find(actions, "web.fetch").on).toBe(false);
    expect(find(actions, "web.search").on).toBe(true);
    const access = await H.call(OPERATOR, "PUT", "/api/ops/connectors/web", {
      defaultPermissions: { read: "auto", create: "off", update: "off", delete: "off" },
    });
    expect(access.status).toBe(422);
    await H.call(OPERATOR, "PUT", "/api/ops/connectors/web", { actions: { "web.fetch": true } });
  });
});

describe.skipIf(!h)("Request an action", () => {
  const H = h as ApiHarness;

  it("from a connector's page becomes a Dev queue request, and an open one isn't asked twice", async () => {
    const what =
      "Attach a PDF to a bill in the accounting system, with the vendor's invoice number.";
    const first = await H.call(OPERATOR, "POST", "/api/ops/action-requests", {
      what,
      connector: "testkit",
    });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const answer = ActionRequestAnswer.parse(first.json);
    expect(answer.ref ?? answer.duplicate?.ref).toMatch(/^DQ-\d+$/);

    const queue = await H.call(OPERATOR, "GET", "/api/ops/code-requests?status=all");
    const row = j(queue.json).requests.find(
      (r: { ref: string }) => r.ref === (answer.ref ?? answer.duplicate?.ref),
    );
    expect(row.title).toContain("Action asked for: Attach a PDF to a bill");
    expect(row.kind).toBe("new_tool");

    const again = await H.call(OPERATOR, "POST", "/api/ops/action-requests", {
      what,
      connector: "testkit",
    });
    expect(ActionRequestAnswer.parse(again.json)).toMatchObject({ ref: null });
    expect(j(again.json).duplicate.ref).toBe(row.ref);
  });

  it("is refused for a short ask and for anyone who isn't the operator on the back office's route", async () => {
    expect(
      (await H.call(OPERATOR, "POST", "/api/ops/action-requests", { what: "more" })).status,
    ).toBe(400);
    expect(
      (
        await H.call(admin("a"), "POST", "/api/ops/action-requests", {
          what: "Do something with the accounting tool.",
        })
      ).status,
    ).toBe(403);
  });

  it("from a client's account is answered with 'received' only, and reaches the queue with their words", async () => {
    const what = "Send each approved bill to our controller as a Slack message with the amount.";
    const res = await H.call(admin("a"), "POST", "/api/action-requests", { what });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    // A client is told we have it: no number, no queue, no connector.
    expect(PortalActionRequestAnswer.parse(res.json)).toEqual({ received: true });
    expect(JSON.stringify(res.json)).not.toMatch(/DQ-|connector|queue/i);

    const queue = await H.call(OPERATOR, "GET", "/api/ops/code-requests?status=all");
    const row = j(queue.json).requests.find((r: { title: string }) =>
      r.title.includes("Send each approved bill to our controller"),
    );
    expect(row).toBeTruthy();
    const detail = await H.call(OPERATOR, "GET", `/api/ops/code-requests/${row.id}`);
    expect(j(detail.json).spec.summary).toContain("asked from the client's account");
  });

  it("is a client's to ask, not the back office's other routes, and nobody signed out", async () => {
    const out = await H.call(null, "POST", "/api/action-requests", {
      what: "Do something new with the accounting tool.",
    });
    expect(out.status).toBe(401);
  });

  it("from an agent's page finds the client's agent within the operator's own clients, and says whose it is", async () => {
    const [a] = await H.t.db
      .insert(agent)
      .values({ tenantId: H.A.tenantId, kind: "client", slug: "asks-a", name: "Asking agent" })
      .returning({ id: agent.id });
    const [b] = await H.t.db
      .insert(agent)
      .values({ tenantId: H.B.tenantId, kind: "client", slug: "asks-b", name: "Other's agent" })
      .returning({ id: agent.id });
    const what = "Read a customer's balance from the accounting system before it writes.";
    const ok = await H.call(OPERATOR, "POST", "/api/ops/action-requests", {
      what,
      agentId: a?.id,
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const ref = j(ok.json).ref ?? j(ok.json).duplicate?.ref;
    const detail = await H.call(OPERATOR, "GET", `/api/ops/code-requests/${ref}`);
    // The agent and the client it belongs to are named: the lookup saw them.
    expect(j(detail.json).spec.summary).toContain("Asking agent");
    expect(j(detail.json).spec.summary).toContain("for Client A");

    // An agent of a client this operator doesn't serve is not found, and nothing is filed.
    const before = j((await H.call(OPERATOR, "GET", "/api/ops/code-requests?status=all")).json)
      .requests.length;
    const other = await H.call(OTHER_OPERATOR, "POST", "/api/ops/action-requests", {
      what: "Do something with another client's agent.",
      agentId: b?.id,
    });
    expect(other.status).toBe(404);
    const after = j((await H.call(OPERATOR, "GET", "/api/ops/code-requests?status=all")).json)
      .requests.length;
    expect(after).toBe(before);
  });

  it("is refused for a client the operator doesn't serve", async () => {
    const res = await H.call(OTHER_OPERATOR, "POST", "/api/ops/action-requests", {
      what: "Do something for a client I do not serve.",
      clientId: H.B.tenantId,
    });
    expect(res.status).toBe(404);
  });

  // Staging, 2026-11-28: the step builder flagged every match step "Nothing can be matched to …"
  // because its catalog had no match profiles.
  it("sends the builder what a match step can match to", async () => {
    const made = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "match-clerk",
      bundle: testBundle("Match clerk"),
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const id = j(made.json).agent.id;
    const res = await H.call(OPERATOR, "GET", `/api/ops/agents/${id}/builder-catalog`);
    expect(res.status).toBe(200);
    const ids = (j(res.json).profiles as { id: string }[]).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["vendors", "vendor-items"]));
  });

  it("leaves a switched-off action out of the builder's pickers, unless the agent already uses it", async () => {
    const made = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "pickers-clerk",
      bundle: testBundle("Pickers clerk"),
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const id = j(made.json).agent.id;
    const names = async () =>
      j((await H.call(OPERATOR, "GET", `/api/ops/agents/${id}/builder-catalog`)).json).tools.map(
        (t: { id: string }) => t.id,
      );
    expect(await names()).toContain("web.search");
    await H.call(OPERATOR, "PUT", "/api/ops/connectors/web", { actions: { "web.search": false } });
    expect(await names()).not.toContain("web.search");
    expect(await names()).toContain("web.fetch");
    await H.call(OPERATOR, "PUT", "/api/ops/connectors/web", { actions: { "web.search": true } });
    expect(await names()).toContain("web.search");
  });
});
