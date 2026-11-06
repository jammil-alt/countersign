// v0.14 W4-C (docs/plan.md §1.56): Slack through the API against a fake Slack (nothing live). The
// client admin installs the app through the generic OAuth routes (the state checked, a grant with
// more than we ask for refused and nothing kept), the bot token goes to the vault and never into a
// response; the admin picks channels from Slack's own list; an agent in act mode on an `auto`
// matrix still waits for a person before it posts (the step says nothing about approval); the
// approved post goes once to the picked channel, a channel not picked is refused, a lost answer is
// never posted again, and disconnect revokes the token at Slack.

import {
  createSlackConnector,
  executeWrite,
  generateEncryptionKey,
  memoryCredentials,
  noopLogger,
  SLACK_AUTHORIZE_URL,
  SLACK_POST_TOOL,
  UnconfirmedWriteError,
} from "@countersign/connectors";
import { FAKE_SLACK, fakeSlack } from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import { agent, connection, connectionChange, externalAction, rawRecord } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  user,
} from "./api.test-helper";
import { dbWriteAttempts, WRITE_ATTEMPT_ENTITY, WRITE_DONE_ENTITY } from "./attempts";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const slack = fakeSlack();

const h = await createApiHarness({
  connectors: () => [createSlackConnector({ ...FAKE_SLACK, fetch: slack.fetch })],
  env: { ENCRYPTION_KEY, OAUTH_STATE_SECRET: "state-secret-".repeat(4), APP_ORIGIN: ORIGIN },
});
afterAll(() => h?.close());

function bundle(name: string, input: Record<string, unknown>): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name, role: "tells the team", mission: "post what the workflow says" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Only do what the workflow says.",
      skills: [],
      extraTools: [SLACK_POST_TOOL],
      canCommand: [],
      // Act mode: the agent may write on its own where the step and matrix allow it.
      permissions: { mode: "act" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 3,
          trigger: { id: "trg-manual", on: { type: "manual", input: {} } },
          // No `approval` on the step: a write waits for a person by default.
          steps: [
            {
              id: "post",
              name: "Post",
              kind: "action",
              tool: SLACK_POST_TOOL,
              input,
              client: { visible: true, label: name },
            },
          ],
        },
      },
    ],
  } as AgentBundleInput);
}

describe.skipIf(!h)("Slack through the API", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  /** Every response read, to look for a token in any of them. */
  const seen: string[] = [];
  const call = async (...args: Parameters<ApiHarness["call"]>) => {
    const res = await H.call(...args);
    seen.push(JSON.stringify(res.json ?? null));
    return res;
  };
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
  });
  let slackConn = "";

  /** Approves the item the run waits on as client A's admin; `before` runs first. */
  function approver(before: () => void) {
    return new FakeWorkflowStep(async (_name, type) => {
      before();
      const res = await call(admin("a"), "GET", "/api/inbox");
      const item = j(res.json).items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      const done = await call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });
  }

  async function startRun(agentName: string, input: Record<string, unknown>) {
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: agentName.toLowerCase().replace(/[^a-z]+/g, "-"),
      bundle: bundle(agentName, input),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(j(created.json).errors ?? []).toEqual([]);
    const id = j(created.json).agent.id;
    const op = await call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { slack: slackConn },
    });
    expect(op.status, JSON.stringify(op.json)).toBe(200);
    const pub = await call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    // Live, so the agent's own mode (act) is its effective mode.
    await H.t.db.update(agent).set({ runStatus: "active", stage: "live" }).where(eq(agent.id, id));
    const res = await call(OPERATOR, "POST", `/api/ops/agents/${id}/run`, { workflow: "main" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("no run started");
    return params;
  }

  const actionsOf = (runId: string) =>
    H.t.db.select().from(externalAction).where(eq(externalAction.runId, runId));

  async function authorize(who = admin("a")) {
    const start = await call(who, "POST", "/api/connections/slack/authorize");
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const redirect = new URL(j(start.json).redirectUrl);
    return { redirect, state: redirect.searchParams.get("state") ?? "" };
  }

  beforeAll(async () => {
    const offer = await call(OPERATOR, "PUT", `/api/ops/clients/${A()}/connectors`, {
      offered: ["testkit", "slack"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
  });

  it("is offered as Slack, ready to connect, with nothing to pick before it is", async () => {
    const res = await call(admin("a"), "GET", "/api/connections");
    const card = j(res.json).connections.find(
      (c: { connector: string }) => c.connector === "slack",
    );
    expect(card).toMatchObject({ name: "Slack", available: true, connection: null });
    const picker = await call(admin("a"), "GET", "/api/connections/slack/channels");
    expect(picker.status).toBe(409);
    expect(j(picker.json).error.code).toBe("not_connected");
  });

  it("checks the state, and refuses a grant with more than we ask for, keeping nothing", async () => {
    const { redirect, state } = await authorize();
    expect(`${redirect.origin}${redirect.pathname}`).toBe(SLACK_AUTHORIZE_URL);
    expect(redirect.searchParams.get("scope")).toBe("chat:write,channels:read");
    expect(redirect.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/connections/slack/callback`);

    const tampered = await call(admin("a"), "POST", "/api/connections/slack/callback", {
      params: { code: slack.issueCode(), state: `${state.slice(0, -2)}xx` },
    });
    expect(tampered.status).toBe(400);
    const none = await call(admin("a"), "POST", "/api/connections/slack/callback", {
      params: { code: slack.issueCode() },
    });
    expect(none.status).toBe(400);
    // A client user can't install it, with the admin's state or their own.
    const asUser = await call(user("a"), "POST", "/api/connections/slack/callback", {
      params: { code: slack.issueCode(), state },
    });
    expect(asUser.status).toBe(403);

    const more = await call(admin("a"), "POST", "/api/connections/slack/callback", {
      params: {
        code: slack.issueCode({ scopes: ["chat:write", "channels:read", "channels:history"] }),
        state,
      },
    });
    expect(more.status).toBe(422);
    expect(j(more.json).error.code).toBe("sign_in_refused");
    const rows = await H.t.db
      .select()
      .from(connection)
      .where(and(eq(connection.tenantId, A()), eq(connection.connector, "slack")));
    expect(rows).toEqual([]);
    // What Slack gave for the refused grant was revoked there.
    expect(slack.revoked()).toHaveLength(1);
  });

  it("installs the bot: the token in the vault, the workspace on the card", async () => {
    const { state } = await authorize();
    const done = await call(admin("a"), "POST", "/api/connections/slack/callback", {
      params: { code: slack.issueCode(), state },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const conn = j(done.json).connection.connection;
    expect(conn).toMatchObject({
      status: "connected",
      externalAccountId: "T0ACMEMILL",
      accountName: "Acme Millwork",
    });
    slackConn = conn.id;
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, slackConn));
    expect(row?.config).toEqual({
      teamId: "T0ACMEMILL",
      teamName: "Acme Millwork",
      accountName: "Acme Millwork",
      botUserId: "U0MEZONAS1",
      appId: "A0MEZONAS1",
      scopes: ["chat:write", "channels:read"],
    });
    expect(row?.permissions).toMatchObject({ create: "approval", delete: "off" });
    const token = slack.issued().botTokens.at(-1) as string;
    expect(JSON.stringify(row?.config)).not.toContain(token);
    expect(JSON.stringify(row?.credentialsEncrypted)).not.toContain(token);
  });

  it("lets only the client admin pick channels, from Slack's own list", async () => {
    expect((await call(user("a"), "GET", "/api/connections/slack/channels")).status).toBe(403);
    expect(
      (await call(user("a"), "PUT", "/api/connections/slack/channels", { channels: [] })).status,
    ).toBe(403);
    // Another client has no Slack: nothing of client A's is reachable from there.
    expect((await call(admin("b"), "GET", "/api/connections/slack/channels")).status).toBe(409);

    const list = await call(admin("a"), "GET", "/api/connections/slack/channels");
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(j(list.json)).toEqual({
      connectionId: slackConn,
      workspace: "Acme Millwork",
      channels: [
        { id: "C0ACCTS001", name: "accounts", isMember: true, picked: false },
        { id: "C0GENERAL1", name: "general", isMember: false, picked: false },
        { id: "C0ORDERS01", name: "orders", isMember: true, picked: false },
      ],
      picked: [],
    });

    // A private or made-up channel is not the workspace's public list: refused.
    for (const id of ["G0PRIVATE1", "C0NOTREAL1"]) {
      const bad = await call(admin("a"), "PUT", "/api/connections/slack/channels", {
        channels: [id],
      });
      expect(bad.status).toBe(422);
      expect(j(bad.json).error.code).toBe("unknown_channel");
    }
    const picked = await call(admin("a"), "PUT", "/api/connections/slack/channels", {
      channels: ["C0ORDERS01"],
    });
    expect(picked.status, JSON.stringify(picked.json)).toBe(200);
    expect(j(picked.json).picked).toEqual([{ id: "C0ORDERS01", name: "orders" }]);
    const changes = await H.t.db
      .select()
      .from(connectionChange)
      .where(eq(connectionChange.connectionId, slackConn));
    expect(changes.map((c) => c.change)).toContainEqual({
      kind: "slack_channels",
      by: "client",
      before: [],
      after: ["C0ORDERS01"],
    });
  });

  it("waits for a person even in act mode on an auto matrix, then posts once", async () => {
    // The operator loosens the matrix to `auto` for create; the step still says nothing.
    const loosen = await call(OPERATOR, "PATCH", `/api/ops/connections/${slackConn}`, {
      permissions: { create: "auto" },
    });
    expect(loosen.status, JSON.stringify(loosen.json)).toBe(200);
    const params = await startRun("Orders desk", {
      channel: "#orders",
      text: "<!channel> Order 1042 from Hardwood Supply arrives Friday.",
    });
    const atWait: number[] = [];
    const step = approver(() => atWait.push(slack.posted.length));
    expect(await executeRun(deps(), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
    // Nothing was posted before the approval.
    expect(atWait).toEqual([0]);
    expect(slack.posted).toHaveLength(1);
    expect(slack.posted[0]).toMatchObject({ team: "T0ACMEMILL", channel: "C0ORDERS01" });
    expect(slack.posted[0]?.body.text).toBe(
      "&lt;!channel&gt; Order 1042 from Hardwood Supply arrives Friday.",
    );
    const [action] = await actionsOf(params.runId);
    expect(action).toMatchObject({
      tool: SLACK_POST_TOOL,
      status: "done",
      connectionId: slackConn,
      approvedBy: H.A.admin,
    });
    expect(action?.before).toEqual({
      workspace: "Acme Millwork",
      channel: { id: "C0ORDERS01", name: "orders" },
      text: "<!channel> Order 1042 from Hardwood Supply arrives Friday.",
    });
    expect(action?.result).toMatchObject({ channel: "C0ORDERS01", ts: slack.posted[0]?.ts });
    // The attempt was recorded before Slack was called, and the post once after.
    const records = await H.t.db
      .select()
      .from(rawRecord)
      .where(eq(rawRecord.connectionId, slackConn));
    expect(records.map((r) => r.entityType).sort()).toEqual([
      WRITE_ATTEMPT_ENTITY,
      WRITE_DONE_ENTITY,
    ]);
    const token = slack.issued().botTokens.at(-1) as string;
    expect(JSON.stringify(records)).not.toContain(token);

    // The run replayed (a retried Workflow): nothing is posted twice.
    await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(slack.posted).toHaveLength(1);
  });

  it("refuses a channel the client didn't pick, and asks no one to approve it", async () => {
    const params = await startRun("Accounts desk", { channel: "#accounts", text: "Hello" });
    const asked: string[] = [];
    const step = new FakeWorkflowStep(async (_name, type) => {
      asked.push(type);
      throw new Error("nothing should wait for a person");
    });
    const out = await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(out.status).not.toBe("succeeded");
    expect(asked).toEqual([]);
    expect(slack.posted).toHaveLength(1);
    const actions = await actionsOf(params.runId);
    expect(actions.every((a) => a.status !== "done")).toBe(true);
  });

  it("never posts again after a lost answer", async () => {
    const before = slack.posted.length;
    slack.loseNextAnswer();
    const params = await startRun("Night desk", { channel: "orders", text: "Truck is late." });
    await executeRun(deps(), params, cloudflareStepRunner(approver(() => {})));
    // Slack posted it, and we never heard back.
    expect(slack.posted).toHaveLength(before + 1);
    const [action] = await actionsOf(params.runId);
    expect(action?.status).toBe("failed");
    const key = action?.idempotencyKey as string;

    // The same action run again with its key (a crash left it executing): never posted again.
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, slackConn));
    if (!row) throw new Error("no connection");
    const ref = {
      id: row.id,
      tenantId: row.tenantId,
      connector: row.connector,
      status: row.status,
      externalAccountId: row.externalAccountId,
      config: row.config as Record<string, never>,
      permissions: row.permissions,
    };
    const connector = H.platform.connectors.get("slack");
    if (!connector) throw new Error("no slack connector");
    const again = executeWrite(connector, SLACK_POST_TOOL, action?.input, {
      tenantId: A(),
      connection: ref,
      credentials: memoryCredentials({
        accessToken: slack.issued().botTokens.at(-1) as string,
        tokenType: "bot",
        scope: "chat:write,channels:read",
        teamId: "T0ACMEMILL",
        botUserId: "U0MEZONAS1",
        appId: "A0MEZONAS1",
      }),
      logger: noopLogger,
      now: () => new Date(),
      services: { attempts: dbWriteAttempts(H.db, ref) },
      idempotencyKey: key,
    });
    await expect(again).rejects.toBeInstanceOf(UnconfirmedWriteError);
    expect(slack.posted).toHaveLength(before + 1);
  });

  it("revokes the token at Slack on disconnect", async () => {
    const token = slack.issued().botTokens.at(-1) as string;
    const res = await call(admin("a"), "DELETE", `/api/connections/${slackConn}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json).connection.connection.status).toBe("disconnected");
    expect(slack.revoked()).toContain(token);
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, slackConn));
    expect(row?.credentialsEncrypted).toBeNull();
    const picker = await call(admin("a"), "GET", "/api/connections/slack/channels");
    expect(picker.status).toBe(409);
  });

  it("never put a token in a response", () => {
    const all = seen.join("\n");
    for (const t of [...slack.issued().botTokens, ...slack.issued().userTokens]) {
      expect(all).not.toContain(t);
    }
    expect(all).not.toContain("xoxb-");
  });
});
