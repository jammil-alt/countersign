// Scripted site tools through the API (docs/plan.md §1.86 "Scripts (wave 4)"), with a fake browser
// on a fake supplier portal and a fake code service: recording one action at a time while our code
// signs in from the vault (whoever records never sees the login), a client admin's draft that
// doesn't run until the operator publishes it, a published read script replayed by a run, a write
// script that waits for approval and goes through external_action once, a selector that isn't
// there asking the lead for help, a page the site doesn't allow refused, and another client never
// seeing the script.

import {
  BROWSER_SCRIPT_READ_TOOL,
  BROWSER_SCRIPT_SUBMIT_TOOL,
  ContentStore,
  createBrowserConnector,
  FakeBrowserDriver,
  FakeCodesService,
  FakeSupplierPortal,
  generateEncryptionKey,
} from "@countersign/connectors";
import { type BrowserSiteProfileInput, bundleHash } from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  externalAction,
  inboxItem,
  stepRun,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { inboxEventType } from "@countersign/workflows";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { codesClient } from "./codes/client";
import type { Bindings } from "./env";
import { credentialsFor, executeRun, type RunDeps } from "./runs/execute";
import type { RunParams } from "./runs/instances";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://portal.supplier.test";
const USERNAME = "agent@client-a.test";
const PASSWORD = "Pw-only-for-the-agent-7731";

const PROFILE: BrowserSiteProfileInput = {
  login: {
    url: `${ORIGIN}/login`,
    origins: [ORIGIN],
    usernameField: "#user",
    passwordField: "#pass",
    submitButton: "#go",
    secondFactor: {
      kind: "email",
      sender: "@supplier.test",
      pattern: "code is (\\d{6})",
      codeField: "#code",
      codeButton: "#verify",
    },
    signedIn: { selector: "#account" },
  },
  signOut: { url: `${ORIGIN}/logout` },
  allow: [`${ORIGIN}/home`, `${ORIGIN}/invoices*`, `${ORIGIN}/orders*`],
};

const codes = new FakeCodesService();
const portal = new FakeSupplierPortal({ username: USERNAME, password: PASSWORD, codeTo: null });
const driver = new FakeBrowserDriver(portal);

const h = await createApiHarness({
  connectors: () => [createBrowserConnector({ codePoll: { intervalMs: 0, attempts: 5 } })],
  env: { ENCRYPTION_KEY, CODES: codes } as Partial<Bindings>,
  browserOpener: () => driver.open(),
});
afterAll(() => h?.close());

const TIMEOUT = () =>
  Object.assign(new Error("Execution timed out after 1ms"), { name: "WorkflowTimeoutError" });

describe.skipIf(!h)("scripted site tools through the API", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const B = () => H.B.tenantId;
  const content = new ContentStore(H.objects);
  const logins: Record<string, string> = {};
  let agentId = "";

  const deps = (): RunDeps => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
    documents: { content },
    browser: { open: () => driver.open(), codes: codesClient(codes), content },
  });

  /** Sets up a supplier login for a client, through the portal, with the agent account's login. */
  async function setUpLogin(client: "a" | "b", tenantId: string) {
    const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${tenantId}/connectors`, {
      offered: ["testkit", "browser"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    const set = await H.call(admin(client), "POST", "/api/access/browser", { site: "supplier" });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    const connectionId = j(set.json).connectionId as string;
    const saved = await H.call(admin(client), "PUT", "/api/connections/browser/credentials", {
      values: { username: USERNAME, password: PASSWORD },
      connectionId,
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    // Every recorded action signs in (medium tier, no kept session): more than a day's default.
    await H.t.db
      .update(connection)
      .set({
        config: sql`${connection.config} || ${JSON.stringify({ caps: { signInsPerDay: 100, hours: null } })}::jsonb`,
      })
      .where(eq(connection.id, connectionId));
    return connectionId;
  }

  /** Records `actions` on a script, one request each, as `who` on `side`. */
  async function record(
    who: string,
    side: "ops" | "access",
    id: string,
    actions: Record<string, unknown>[],
  ) {
    const results = [];
    for (const action of actions) {
      const res = await H.call(who, "POST", `/api/${side}/browser-scripts/${id}/actions`, {
        action,
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      results.push(j(res.json));
    }
    return results;
  }

  /** A new version of the agent whose one workflow is this v4 process. */
  async function processVersion(steps: unknown[]): Promise<string> {
    const bundle = testBundle();
    bundle.definition.permissions.mode = "act";
    bundle.definition.extraTools = [BROWSER_SCRIPT_READ_TOOL, BROWSER_SCRIPT_SUBMIT_TOOL];
    const stored = {
      ...bundle,
      workflows: [
        {
          slug: "fix-record",
          name: "Order supplies",
          workflow: {
            schemaVersion: 4,
            triggers: [{ id: "trg-manual", on: { type: "manual", input: {} } }],
            steps,
          },
        },
      ],
    };
    const versions = await H.t.db
      .select({ version: agentVersion.version })
      .from(agentVersion)
      .where(eq(agentVersion.agentId, agentId));
    const [row] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: A(),
        agentId,
        version: Math.max(0, ...versions.map((v) => v.version)) + 1,
        // biome-ignore lint/suspicious/noExplicitAny: a v4 process is stored as written.
        bundle: stored as any,
        bundleHash: await bundleHash(stored),
        authorType: "operator",
      })
      .returning({ id: agentVersion.id });
    if (!row) throw new Error("no version");
    return row.id;
  }

  const params = (versionId: string): RunParams =>
    ({
      runId: crypto.randomUUID(),
      tenantId: A(),
      agentId,
      agentVersionId: versionId,
      workflowSlug: "fix-record",
      mode: "live",
      trigger: { type: "manual" },
      payload: {},
    }) as RunParams;

  const readStep = (script: string, inputs: Record<string, unknown>) => ({
    id: "stock",
    kind: "read",
    name: "Check the stock",
    tool: BROWSER_SCRIPT_READ_TOOL,
    input: { site: "supplier", script, inputs },
  });

  beforeAll(async () => {
    const made = await H.call(OPERATOR, "POST", "/api/ops/browser-sites", {
      slug: "supplier",
      name: "Supplier portal",
      tier: "low",
      notes: "Terms allow automated access (checked by J. M., 2026-11-05)",
      profile: PROFILE,
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    logins.a = await setUpLogin("a", A());
    const identity = [...codes.identities.values()].find((i) => i.tenantId === A());
    portal.options.codeTo = { codes, email: identity?.email ?? "" };
    logins.b = await setUpLogin("b", B());

    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "supplies-clerk",
      bundle: testBundle(),
    });
    const tid = j(tpl.json).agent.id;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${tid}/versions/${j(tpl.json).version.id}/publish`,
    );
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tid}/fork`, {
      clientId: A(),
      serviceName: "Supplies",
    });
    agentId = j(fork.json).agent.id;
    const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { "browser:supplier": logins.a },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", stage: "live", liveVersionId: j(fork.json).version.id })
      .where(eq(agent.id, agentId));
  });

  let stockId = "";
  let orderId = "";

  it("records through our API: our code signs in first, and whoever records never sees the login", async () => {
    const start = await H.call(OPERATOR, "POST", "/api/ops/browser-scripts", {
      connectionId: logins.a,
      slug: "check-stock",
      name: "Check stock",
    });
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    stockId = j(start.json).script.id;
    expect(j(start.json).script).toMatchObject({ state: "recording", createdSide: "operator" });

    const before = portal.signIns;
    const [opened, read] = await record(OPERATOR, "ops", stockId, [
      { op: "open", url: "/orders/lookup?sku=OAK-1" },
      { op: "read_field", selector: "#stock", as: "stock" },
    ]);
    expect(opened.step).toEqual({ id: "s1", op: "open", url: `${ORIGIN}/orders/lookup?sku=OAK-1` });
    expect(opened.page.url).toBe(`${ORIGIN}/orders/lookup?sku=OAK-1`);
    expect(opened.page.controls.map((c: { selector: string }) => c.selector)).toContain("#stock");
    expect(opened.page.screenshotUrl).toMatch(/\/api\/files\//);
    expect(read.value).toBe("42");
    expect(read.script.recording.outputs).toEqual([
      { name: "stock", label: "stock", type: "text" },
    ]);
    // Each action signed in once, by our code, with the vault's login; and signed out.
    expect(portal.signIns - before).toBe(2);
    expect(portal.sessions.size).toBe(0);
    // Nothing anyone recording reads carries the login.
    expect(JSON.stringify([opened, read])).not.toContain(PASSWORD);

    // The review: the address takes the SKU as an input, the stock is a number.
    const edit = await H.call(OPERATOR, "PUT", `/api/ops/browser-scripts/${stockId}`, {
      name: "Check stock",
      description: "How many of a SKU the supplier has",
      inputs: [{ name: "sku", label: "SKU", type: "text", example: "OAK-1" }],
      outputs: [{ name: "stock", label: "In stock", type: "integer" }],
      steps: [
        { id: "s1", op: "open", url: `${ORIGIN}/orders/lookup?sku={{sku}}` },
        { id: "s2", op: "read_field", selector: "#stock", output: "stock" },
      ],
    });
    expect(edit.status, JSON.stringify(edit.json)).toBe(200);
    expect(j(edit.json).script.problems).toEqual([]);
    // Evidence is kept for the steps kept.
    expect(Object.keys(j(edit.json).script.recording.evidence)).toEqual(["s1", "s2"]);
    const saved = await H.call(OPERATOR, "POST", `/api/ops/browser-scripts/${stockId}/versions`);
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(j(saved.json).script).toMatchObject({ state: "draft", versions: [{ version: 1 }] });
    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/browser-scripts/${stockId}/versions`)).status,
    ).toBe(409);
  });

  it("refuses a page the site doesn't allow, whether recorded or written in", async () => {
    const off = await H.call(OPERATOR, "POST", `/api/ops/browser-scripts/${stockId}/actions`, {
      action: { op: "open", url: "/account/settings" },
    });
    expect(off.status).toBe(422);
    expect(j(off.json).error.message).toMatch(/agents never open this page/);
    expect(driver.events.some((e) => e.op === "goto" && e.url.includes("/account"))).toBe(false);

    const sneaky = await H.call(OPERATOR, "POST", "/api/ops/browser-scripts", {
      connectionId: logins.a,
      slug: "sneaky",
      name: "Sneaky",
    });
    const id = j(sneaky.json).script.id;
    await H.call(OPERATOR, "PUT", `/api/ops/browser-scripts/${id}`, {
      name: "Sneaky",
      inputs: [],
      outputs: [{ name: "text", label: "Text", type: "text" }],
      steps: [
        { id: "s1", op: "open", url: "https://elsewhere.test/orders" },
        { id: "s2", op: "read_field", selector: "#x", output: "text" },
      ],
    });
    const saved = await H.call(OPERATOR, "POST", `/api/ops/browser-scripts/${id}/versions`);
    expect(saved.status).toBe(422);
    expect(j(saved.json).error.message).toMatch(/step s1 opens https:\/\/elsewhere\.test/);
  });

  it("a client admin's recording is a draft that doesn't run until we publish it", async () => {
    expect(
      (
        await H.call(user("a"), "POST", "/api/access/browser-scripts", {
          connectionId: logins.a,
          slug: "place-order",
          name: "Place an order",
        })
      ).status,
    ).toBe(403);
    const start = await H.call(admin("a"), "POST", "/api/access/browser-scripts", {
      connectionId: logins.a,
      slug: "place-order",
      name: "Place an order",
    });
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    orderId = j(start.json).script.id;
    const steps = await record(admin("a"), "access", orderId, [
      { op: "open", url: "/orders/new" },
      { op: "fill", selector: "#sku", value: "OAK-1", as: "sku" },
      { op: "fill", selector: "#qty", value: "2", as: "qty" },
      { op: "read_field", selector: "#price", as: "price" },
      { op: "click", selector: "#place", submits: true },
    ]);
    // The submit is recorded, never clicked: nothing was ordered.
    expect(steps.at(-1).step).toEqual({ id: "s5", op: "click", selector: "#place", submits: true });
    expect(portal.orders).toEqual([]);
    // Nothing is recorded after the submit.
    const after = await H.call(
      admin("a"),
      "POST",
      `/api/access/browser-scripts/${orderId}/actions`,
      {
        action: { op: "open", url: "/orders" },
      },
    );
    expect(after.status).toBe(409);

    const recording = steps.at(-1).script.recording;
    const edit = await H.call(admin("a"), "PUT", `/api/access/browser-scripts/${orderId}`, {
      name: "Place an order",
      inputs: [
        { name: "sku", label: "SKU", type: "text", example: "OAK-1" },
        { name: "qty", label: "Quantity", type: "integer", example: "2" },
      ],
      outputs: [{ name: "price", label: "Unit price", type: "decimal" }],
      steps: recording.steps,
    });
    expect(edit.status, JSON.stringify(edit.json)).toBe(200);
    const saved = await H.call(
      admin("a"),
      "POST",
      `/api/access/browser-scripts/${orderId}/versions`,
    );
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(j(saved.json).script).toMatchObject({
      state: "draft",
      createdSide: "client",
      versions: [{ version: 1, sideEffect: "external", recordedSide: "client" }],
      published: null,
    });
    const list = await H.call(admin("a"), "GET", "/api/access/browser-scripts");
    expect(j(list.json).scripts.find((s: { id: string }) => s.id === orderId)?.state).toBe("draft");
    // The client admin can't publish or test; only we can.
    expect(
      (await H.call(admin("a"), "POST", `/api/ops/browser-scripts/${orderId}/versions/1/publish`))
        .status,
    ).toBe(403);
    // Not a tool yet, and a run naming it is refused before a browser opens.
    const tools = await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/browser-scripts`);
    expect(j(tools.json).tools).toEqual([]);
    const opened = driver.opened;
    const version = await processVersion([readStep("check-stock", { sku: "OAK-1" })]);
    const result = await executeRun(
      deps(),
      params(version),
      cloudflareStepRunner(new FakeWorkflowStep()),
    );
    expect(result.status).toBe("failed");
    expect(driver.opened).toBe(opened);
  });

  it("tests a write as a dry run that never submits, then publishes it as a tool", async () => {
    const test = await H.call(OPERATOR, "POST", `/api/ops/browser-scripts/${orderId}/test`, {
      version: 1,
      inputs: { sku: "OAK-1", qty: 3 },
    });
    expect(test.status, JSON.stringify(test.json)).toBe(200);
    expect(j(test.json)).toMatchObject({
      outcome: "done",
      outputs: { price: "1212.50", submitted: true },
    });
    expect(j(test.json).steps.at(-1)).toMatchObject({ id: "s5", status: "skipped" });
    expect(portal.orders).toEqual([]);

    for (const id of [stockId, orderId]) {
      const pub = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/browser-scripts/${id}/versions/1/publish`,
      );
      expect(pub.status, JSON.stringify(pub.json)).toBe(200);
      expect(j(pub.json).script).toMatchObject({ state: "published", published: { version: 1 } });
    }
    const tools = await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/browser-scripts`);
    expect(
      j(tools.json).tools.map((t: { tool: string; script: string }) => [t.tool, t.script]),
    ).toEqual([
      [BROWSER_SCRIPT_READ_TOOL, "check-stock"],
      [BROWSER_SCRIPT_SUBMIT_TOOL, "place-order"],
    ]);
  });

  it("replays a published read script in a run, with typed outputs", async () => {
    const version = await processVersion([readStep("check-stock", { sku: "OAK-1" })]);
    const p = params(version);
    const result = await executeRun(deps(), p, cloudflareStepRunner(new FakeWorkflowStep()));
    expect(result).toEqual({ status: "succeeded" });
    const [row] = await H.t.db
      .select()
      .from(stepRun)
      .where(and(eq(stepRun.runId, p.runId), eq(stepRun.nodeId, "stock")));
    expect(row?.output).toMatchObject({ stock: 42 });
    expect(portal.sessions.size).toBe(0);
  });

  it("a write script waits for approval and goes through external_action once", async () => {
    const version = await processVersion([
      {
        id: "order",
        kind: "write",
        name: "Order the boards",
        tool: BROWSER_SCRIPT_SUBMIT_TOOL,
        input: { site: "supplier", script: "place-order", inputs: { sku: "OAK-1", qty: 2 } },
        checks: {
          approval: { approvers: [{ who: "client_admin", deadline: { after: "1 day" } }] },
        },
      },
    ]);
    const p = params(version);
    let asked = 0;
    const step = new FakeWorkflowStep(async (_name, type) => {
      const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
      const item = items.find((i) => inboxEventType(i.id) === type);
      if (!item) throw TIMEOUT();
      asked += 1;
      // Nothing is sent before a person signs.
      expect(portal.orders).toEqual([]);
      expect(item.kind).toBe("external_action");
      const res = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const sent = H.instances.events.find((e) => e.event.type === type);
      return sent?.event.payload;
    });
    const result = await executeRun(deps(), p, cloudflareStepRunner(step));
    expect(result, JSON.stringify(result)).toEqual({ status: "succeeded" });
    expect(asked).toBe(1);
    expect(portal.orders).toEqual([{ number: "ORD-1", sku: "OAK-1", qty: "2" }]);
    const actions = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, p.runId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      tool: BROWSER_SCRIPT_SUBMIT_TOOL,
      status: "done",
      result: { submitted: true, price: "1212.50" },
    });
  });

  it("asks the lead for help when an element isn't there, and runs again once it's fixed", async () => {
    // The supplier's page changed under a script: v2 reads a field that isn't there.
    await H.call(OPERATOR, "PUT", `/api/ops/browser-scripts/${stockId}`, {
      name: "Check stock",
      inputs: [{ name: "sku", label: "SKU", type: "text", example: "OAK-1" }],
      outputs: [{ name: "stock", label: "In stock", type: "integer" }],
      steps: [
        { id: "s1", op: "open", url: `${ORIGIN}/orders/lookup?sku={{sku}}` },
        { id: "s2", op: "read_field", selector: "#stock-level", output: "stock" },
      ],
    });
    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/browser-scripts/${stockId}/versions`)).status,
    ).toBe(200);
    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/browser-scripts/${stockId}/versions/2/publish`))
        .status,
    ).toBe(200);
    const version = await processVersion([readStep("check-stock", { sku: "OAK-1" })]);
    const p = params(version);
    const questions: string[] = [];
    const step = new FakeWorkflowStep(async (_name, type) => {
      const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
      const item = items.find((i) => inboxEventType(i.id) === type);
      if (!item) throw TIMEOUT();
      questions.push(item.title);
      // We put the working version back while the lead is asked.
      await H.call(OPERATOR, "POST", `/api/ops/browser-scripts/${stockId}/versions/1/publish`);
      // The lead is asked: an operator's item.
      expect(item.assigneeRole).toBe("operator");
      const res = await H.call(OPERATOR, "POST", `/api/ops/inbox/${item.id}/resolve`, {
        answer: "The page changed; we put the working script back",
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });
    const result = await executeRun(deps(), p, cloudflareStepRunner(step));
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatch(/couldn't find #stock-level/);
    expect(result, JSON.stringify(result)).toEqual({ status: "succeeded" });
    const [row] = await H.t.db
      .select()
      .from(stepRun)
      .where(and(eq(stepRun.runId, p.runId), eq(stepRun.nodeId, "stock")));
    expect(row?.output).toMatchObject({ stock: 42 });
  });

  it("another client never sees the script, nor can run it through its own login", async () => {
    const theirs = await H.call(admin("b"), "GET", "/api/access/browser-scripts");
    expect(theirs.status).toBe(200);
    expect(j(theirs.json).scripts).toEqual([]);
    expect(j(theirs.json).logins.map((l: { clientId: string }) => l.clientId)).toEqual([B()]);
    for (const [method, path, body] of [
      [
        "POST",
        `/api/access/browser-scripts/${stockId}/actions`,
        { action: { op: "open", url: "/home" } },
      ],
      [
        "PUT",
        `/api/access/browser-scripts/${stockId}`,
        { name: "x", inputs: [], outputs: [], steps: [] },
      ],
      ["POST", `/api/access/browser-scripts/${stockId}/versions`, undefined],
    ] as const) {
      expect((await H.call(admin("b"), method, path, body)).status, path).toBe(404);
    }
    // B's admin can't start a script on A's login either.
    expect(
      (
        await H.call(admin("b"), "POST", "/api/access/browser-scripts", {
          connectionId: logins.a,
          slug: "mine",
          name: "Mine",
        })
      ).status,
    ).toBe(404);
    // An operator who doesn't serve A sees none of it.
    const other = await H.call(OTHER_OPERATOR, "GET", "/api/ops/browser-scripts");
    expect(j(other.json).scripts).toEqual([]);
    expect(
      (await H.call(OTHER_OPERATOR, "GET", `/api/ops/clients/${A()}/browser-scripts`)).status,
    ).toBe(404);
    // A's published script isn't B's login's: the tool finds nothing there.
    const tools = await H.call(OPERATOR, "GET", `/api/ops/clients/${B()}/browser-scripts`);
    expect(j(tools.json).tools).toEqual([]);
  });
});
