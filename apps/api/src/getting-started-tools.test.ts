// Getting started's Your tools through the API (docs/setup-plan.md §5; docs/plan.md §1.199, SU3):
// each tool the agents being set up need (their checklists' connect items and their steps' tools),
// connected or not and to which account, what they read and change there in words, the account
// check (a different company asks again), the first look counted from synced QuickBooks records,
// and Ask someone else, which puts the card on that person's Desk. Only the client admin edits;
// no portal answer carries anything of ours (invariant 11); one client never sees another's
// (invariant 1).
import { createGmailConnector, createQboConnector } from "@countersign/connectors";
import { FAKE_GOOGLE, FAKE_QBO_CLIENT, fakeGoogle, fakeQbo } from "@countersign/connectors/testing";
import { forbiddenPortalFields, gettingStartedRoutes } from "@countersign/core";
import { connection, inboxItem, rawRecord } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  user,
} from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const qbo = fakeQbo();
const google = fakeGoogle();
const h = await createApiHarness({
  connectors: () => [
    createQboConnector({
      ...FAKE_QBO_CLIENT,
      environment: "sandbox",
      fetch: qbo.fetch,
      sleep: async () => {},
    }),
    createGmailConnector({ ...FAKE_GOOGLE, fetch: google.fetch }),
  ],
});
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

function bundle(name: string): unknown {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name, role: "Bills", mission: "Enter bills." },
      kind: "functional",
      model: { id: "test-model", maxTokens: 1024 },
      instructions: "Be brief.",
      skills: [],
      extraTools: [],
      permissions: { mode: "suggest_only" },
      setup: [
        {
          id: "connect-gmail",
          label: "Connect Gmail",
          kind: "connect",
          connector: "gmail",
          guards: "trial",
        },
      ],
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 4,
          triggers: [{ id: "t", on: { type: "manual", input: {} } }],
          steps: [
            { id: "vendors", kind: "read", name: "Find vendors", tool: "qbo.vendor.query" },
            { id: "bills", kind: "read", name: "Find bills", tool: "qbo.bill.query" },
            {
              id: "memo",
              kind: "write",
              name: "Add a memo",
              tool: "qbo.bill.update_memo",
              input: { id: "1", memo: "Checked" },
            },
          ],
        },
      },
    ],
  };
}

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

describe.skipIf(!h)("Getting started: Your tools", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const ids: Record<string, string> = {};
  let agentId = "";
  let qboId = "";

  const tools = async (who: string) => {
    const res = await H.call(who, "GET", "/api/getting-started/tools");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return j(res.json);
  };
  const tool = (view: { tools: { connector: string }[] }, connector: string) =>
    j(view.tools.find((t) => t.connector === connector));

  it("declares no portal answer with forbidden fields", () => {
    for (const r of [
      gettingStartedRoutes.portalSetupTools,
      gettingStartedRoutes.portalSetupToolConfirm,
      gettingStartedRoutes.portalSetupToolAsk,
    ]) {
      expect(forbiddenPortalFields(r.response), r.path).toEqual([]);
    }
  });

  it("lists every tool the agents need, with what they do there in words", async () => {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: "bills",
      bundle: bundle("Bill clerk"),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    agentId = j(created.json).agent.id;
    const users = await H.call(admin("a"), "GET", "/api/users");
    for (const u of j(users.json).users) ids[u.email] = u.userId;

    const view = await tools(admin("a"));
    expect(view.canEdit).toBe(true);
    expect(view.tools.map((t: { connector: string }) => t.connector).sort()).toEqual([
      "gmail",
      "qbo",
    ]);
    const books = tool(view, "qbo");
    expect(books).toMatchObject({
      name: "QuickBooks Online",
      connected: false,
      connectionId: null,
      account: null,
      accountConfirmed: false,
      agents: [{ id: agentId, name: "Bill clerk" }],
      firstLook: null,
      askedOf: null,
    });
    expect(books.reads).toEqual(["Vendors", "Bills"]);
    expect(books.changes).toEqual(["Update bills (asks you first)"]);
    expect(books.never).toEqual([
      "Delete anything",
      "Pay or move money",
      "Change anything not listed here",
    ]);
    // Gmail comes from the checklist alone: nothing read or changed by a step.
    expect(tool(view, "gmail")).toMatchObject({ connected: false, reads: [], changes: [] });
    expect(tool(view, "gmail").never).toContain("Change anything");
    expect(forbiddenKeys(view)).toEqual([]);

    // A client user reads the same chapter, without editing.
    expect((await tools(user("a"))).canEdit).toBe(false);
    // Another client sees none of it.
    expect((await tools(admin("b"))).tools).toEqual([]);
  });

  it("shows the account and the first look, counted from the synced records", async () => {
    const [row] = await H.t.db
      .insert(connection)
      .values({
        tenantId: A(),
        connector: "qbo",
        status: "connected",
        externalAccountId: "9130350",
        config: { accountName: "Hartley Millwork LLC" },
        lastSyncAt: new Date(),
      })
      .returning();
    qboId = row?.id as string;
    const raw = (
      entityType: string,
      externalId: string,
      payload: Record<string, unknown>,
      version = "0",
    ) => ({
      tenantId: A(),
      connectionId: qboId,
      connector: "qbo",
      entityType,
      externalId,
      externalVersion: version,
      payload,
    });
    await H.t.db.insert(rawRecord).values([
      raw("Vendor", "1", { Id: "1", DisplayName: "Northside Lumber", Active: true }),
      raw("Vendor", "2", { Id: "2", DisplayName: "Metro Hardware", Active: true }),
      raw("Vendor", "3", { Id: "3", DisplayName: "Gone Supply", Active: true }),
      // The vendor's latest version is inactive: it no longer counts.
      raw("Vendor", "3", { Id: "3", DisplayName: "Gone Supply", Active: false }, "1"),
      ...[1, 2, 3, 4, 5, 6].map((n) =>
        raw("Bill", `b${n}`, {
          Id: `b${n}`,
          TxnDate: daysAgo(n * 5),
          VendorRef: {
            value: n <= 4 ? "1" : "2",
            name: n <= 4 ? "Northside Lumber" : "Metro Hardware",
          },
        }),
      ),
      // Older than three months: left out.
      raw("Bill", "old", {
        Id: "old",
        TxnDate: daysAgo(200),
        VendorRef: { value: "3", name: "Gone Supply" },
      }),
    ]);
    // Client B's records never count for A.
    await H.t.db.insert(rawRecord).values({
      tenantId: H.B.tenantId,
      connectionId: H.B.connectionId,
      connector: "testkit",
      entityType: "Bill",
      externalId: "x",
      externalVersion: "0",
      payload: { TxnDate: daysAgo(1), VendorRef: { name: "Elsewhere" } },
    });

    const books = tool(await tools(admin("a")), "qbo");
    expect(books).toMatchObject({
      connected: true,
      connectionId: qboId,
      account: "Hartley Millwork LLC",
      accountConfirmed: false,
    });
    expect(books.firstLook).toEqual([
      { key: "vendors", text: "2 active vendors.", confirmed: false },
      {
        key: "bills_month",
        text: "About 2 bills a month over the last three months.",
        confirmed: false,
      },
      {
        key: "top_vendors",
        text: "Most bills come from Northside Lumber and Metro Hardware.",
        confirmed: false,
      },
    ]);
    // Gmail isn't counted.
    expect(tool(await tools(admin("a")), "gmail").firstLook).toBeNull();
  });

  it("lets only the client admin say yes, and catches a different company", async () => {
    const confirm = (who: string, connector: string, body: unknown) =>
      H.call(who, "POST", `/api/getting-started/tools/${connector}/confirm`, body);
    expect((await confirm(user("a"), "qbo", { what: "account" })).status).toBe(403);
    expect((await confirm(admin("a"), "nothing", { what: "account" })).status).toBe(404);
    expect((await confirm(admin("a"), "gmail", { what: "account" })).status).toBe(409);
    expect((await confirm(admin("a"), "qbo", { what: "line", key: "made_up" })).status).toBe(404);

    const ok = await confirm(admin("a"), "qbo", { what: "account" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(tool(j(ok.json), "qbo").accountConfirmed).toBe(true);
    const line = await confirm(admin("a"), "qbo", { what: "line", key: "vendors" });
    expect(line.status, JSON.stringify(line.json)).toBe(200);
    const books = tool(j(line.json), "qbo");
    expect(books.accountConfirmed).toBe(true);
    expect(books.firstLook.map((l: { confirmed: boolean }) => l.confirmed)).toEqual([
      true,
      false,
      false,
    ]);

    // Signed in again to another company: the account asks again; the line stays said.
    await H.t.db
      .update(connection)
      .set({ config: { accountName: "Hartley Holdings Inc" } })
      .where(eq(connection.id, qboId));
    const again = tool(await tools(admin("a")), "qbo");
    expect(again).toMatchObject({ account: "Hartley Holdings Inc", accountConfirmed: false });
  });

  it("asks a colleague to connect a tool, on their Desk", async () => {
    const ask = (who: string, connector: string, userId: string) =>
      H.call(who, "POST", `/api/getting-started/tools/${connector}/ask`, { userId });
    expect((await ask(user("a"), "gmail", ids[admin("a")] as string)).status).toBe(403);
    // Not a member of this client: client B's admin, or someone who serves the client.
    const b = await H.call(admin("b"), "GET", "/api/users");
    const bAdmin = j(b.json).users.find((u: { email: string }) => u.email === admin("b")).userId;
    expect((await ask(admin("a"), "gmail", bAdmin)).status).toBe(404);
    expect((await ask(admin("a"), "gmail", ids[admin("a")] as string)).status).toBe(422);
    // A client user can't connect the company's books, only their own mailbox.
    const books = await ask(admin("a"), "qbo", ids[user("a")] as string);
    expect(books.status).toBe(409); // QuickBooks is connected already.

    const res = await ask(admin("a"), "gmail", ids[user("a")] as string);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(tool(j(res.json), "gmail").askedOf).toMatchObject({
      userId: ids[user("a")],
      me: false,
    });
    // On their Desk: one item, for them alone, closed with Done.
    const desk = await H.call(user("a"), "GET", "/api/inbox");
    const items = j(desk.json).items.filter((i: { title: string }) =>
      i.title.includes("asked you to connect Gmail"),
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("review");
    expect(forbiddenKeys(desk.json)).toEqual([]);
    // Asked again: the earlier item closes.
    await ask(admin("a"), "gmail", ids[user("a")] as string);
    const open = await H.t.db
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.tenantId, A()), eq(inboxItem.subjectType, "setup_tool_ask")));
    expect(open.filter((i) => i.status === "open")).toHaveLength(1);
    expect(open).toHaveLength(2);
  });

  it("refuses to ask a client user to connect a tool only an admin connects", async () => {
    await H.t.db.update(connection).set({ status: "disconnected" }).where(eq(connection.id, qboId));
    const res = await H.call(admin("a"), "POST", "/api/getting-started/tools/qbo/ask", {
      userId: ids[user("a")],
    });
    expect(res.status).toBe(422);
    expect(j(res.json).error.code).toBe("cannot_connect");
  });

  it("puts each tool not connected on the overview's line, with who it waits on", async () => {
    const res = await H.call(admin("a"), "GET", "/api/getting-started");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const line = j(res.json).agents.find((a: { agentId: string }) => a.agentId === agentId);
    const left = line.left.filter((l: { chapter: string }) => l.chapter === "tools");
    expect(left.map((l: { key: string }) => l.key).sort()).toEqual(["tool:gmail", "tool:qbo"]);
    expect(left.find((l: { key: string }) => l.key === "tool:gmail")).toMatchObject({
      label: "Connect Gmail",
      who: { userId: ids[user("a")], me: false },
    });
    expect(left.find((l: { key: string }) => l.key === "tool:qbo")).toMatchObject({
      label: "Connect QuickBooks Online",
      who: { userId: ids[admin("a")], me: true },
    });
    expect(forbiddenKeys(res.json)).toEqual([]);
    // The person asked reads it as theirs.
    const theirs = await H.call(user("a"), "GET", "/api/getting-started");
    const mine = j(theirs.json)
      .agents.find((a: { agentId: string }) => a.agentId === agentId)
      .left.find((l: { key: string }) => l.key === "tool:gmail");
    expect(mine.who.me).toBe(true);
  });
});
