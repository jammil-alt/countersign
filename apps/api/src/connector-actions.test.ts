// Step model E (docs/step-model-plan.md §10c): a connector's actions are switched on or off on its
// page, an off action is left out of the catalog and refused where it would run, and an action can be
// requested from a connector, an agent or a client's own account (it becomes a Dev queue request).

import {
  ActionRequestAnswer,
  CatalogConnector,
  PortalActionRequestAnswer,
} from "@countersign/core";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR, user } from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

const find = (list: { id: string }[], id: string) => list.find((c) => c.id === id);

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
});
