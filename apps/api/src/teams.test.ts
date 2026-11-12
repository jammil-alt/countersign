// §1.97: Microsoft Teams through the API against a fake Bot Framework (nothing live). The client
// admin connects Teams and gets a one-time code; activities reach `/api/hooks/teams` only with the
// Bot Connector's signed token over the exact body; a code binds a channel to its own client only,
// once; a channel bound to one client is refused to another; removing the bot unbinds; the admin
// disconnects a channel. An agent posts to a bound channel only after a person approves, once,
// also when the run is replayed. No response carries a token or a code hash.

import {
  createTeamsConnector,
  generateEncryptionKey,
  TEAMS_POST_TOOL,
  TEAMS_REPLIES,
} from "@countersign/connectors";
import { FAKE_TEAMS, fakeTeams } from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import { agent, connection, externalAction } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  forbiddenKeys,
  OPERATOR,
  user,
} from "./api.test-helper";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const teams = await fakeTeams();
const ORDERS = FAKE_TEAMS.channelId;
const OFFICE = "19:fakeChannelOffice00000000000000@thread.tacv2";
const OTHER_TEAM = "19:fakeTeamOther0000000000000000000@thread.tacv2";
const OTHER = "19:fakeChannelOther000000000000000@thread.tacv2";
teams.installIn(FAKE_TEAMS.teamId, [ORDERS, OFFICE], {
  team: FAKE_TEAMS.teamName,
  channels: { [ORDERS]: FAKE_TEAMS.channelName, [OFFICE]: "Office" },
});
teams.installIn(OTHER_TEAM, [OTHER], { team: "Client B", channels: { [OTHER]: "General" } });

const h = await createApiHarness({
  connectors: () => [
    createTeamsConnector({
      appId: teams.appId,
      appSecret: teams.appSecret,
      tenantId: teams.tenantId,
      fetch: teams.fetch,
    }),
  ],
  env: { ENCRYPTION_KEY, APP_ORIGIN: "https://app.mezonas.test" },
});
afterAll(() => h?.close());

function bundle(): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Shop updates", role: "keeps the shop posted", mission: "post updates" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Only do what the workflow says.",
      skills: [],
      extraTools: [TEAMS_POST_TOOL],
      canCommand: [],
      permissions: { mode: "suggest_only" },
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
          // No `approval` on the step: a post waits for a person by default.
          steps: [
            {
              id: "post",
              name: "Post",
              kind: "action",
              tool: TEAMS_POST_TOOL,
              input: { channel: ORDERS, text: "Cherry veneer arrived. <at>Everyone</at>" },
              client: { visible: true, label: "Post the update" },
            },
          ],
        },
      },
    ],
  } as AgentBundleInput);
}

describe.skipIf(!h)("Microsoft Teams through the API", () => {
  const H = h as ApiHarness;
  const seen: string[] = [];
  const call = async (...args: Parameters<ApiHarness["call"]>) => {
    const res = await H.call(...args);
    seen.push(JSON.stringify(res.json ?? null));
    expect(forbiddenKeys(res.json), `${args[1]} ${args[2]}`).toEqual([]);
    return res;
  };
  /** One activity to the messaging endpoint, signed by the fake Bot Connector over its body. */
  const post = async (opts: Parameters<typeof teams.activity>[0], token?: string | null) => {
    const a = await teams.activity(opts);
    return call(null, "POST", "/api/hooks/teams", new TextDecoder().decode(a.body), {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: token ?? a.headers.authorization }),
    });
  };
  const lastReply = () => teams.replies.at(-1)?.text;
  let connA = "";
  let connB = "";

  async function codeFor(email: string, conn: string): Promise<string> {
    const res = await call(email, "POST", `/api/connections/${conn}/teams/code`, {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return j(res.json).newCode;
  }
  const channelsOf = async (conn: string) => {
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, conn));
    return (j(row?.config).channels ?? []).map((c: { channelId: string }) => c.channelId);
  };

  beforeAll(async () => {
    for (const c of [H.A, H.B]) {
      const offer = await call(OPERATOR, "PUT", `/api/ops/clients/${c.tenantId}/connectors`, {
        offered: ["testkit", "teams"],
      });
      expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    }
    const a = await call(admin("a"), "POST", "/api/connections/teams/authorize");
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(j(a.json).redirectUrl).toBeNull();
    connA = j(a.json).connection.connection.id;
    const b = await call(admin("b"), "POST", "/api/connections/teams/authorize");
    connB = j(b.json).connection.connection.id;
    expect(j(b.json).connection.connection.status).toBe("connected");
  });

  it("refuses an activity without the Bot Connector's token, or with a token for another body", async () => {
    expect((await post({ text: "hello" }, null)).status).toBe(401);
    expect((await post({ text: "hello" }, "Bearer nope")).status).toBe(401);
    // A token signed for another service URL doesn't hold for this body.
    const other = await teams.signToken("https://smba.trafficmanager.net/emea/");
    expect((await post({ text: "hello" }, `Bearer ${other}`)).status).toBe(401);
    expect(teams.replies).toHaveLength(0);
  });

  it("answers a message without a code with a fixed line, and stores nothing", async () => {
    const res = await post({ text: "<at>Mezonas</at> what's the status of order 1042?" });
    expect(res.status).toBe(200);
    expect(lastReply()).toBe(TEAMS_REPLIES.onlyPosts);
    const chat = await post({
      text: "<at>Mezonas</at> MZ-7K2Q-9XHD-4RTM",
      conversationType: "groupChat",
    });
    expect(chat.status).toBe(200);
    expect(lastReply()).toBe(TEAMS_REPLIES.channelOnly);
    expect(await channelsOf(connA)).toEqual([]);
  });

  it("only the client admin gets a code; the code binds its own client's channel once", async () => {
    expect((await call(user("a"), "POST", `/api/connections/${connA}/teams/code`, {})).status).toBe(
      403,
    );
    expect(
      (await call(admin("b"), "POST", `/api/connections/${connA}/teams/code`, {})).status,
    ).toBe(404);
    const code = await codeFor(admin("a"), connA);
    expect(code).toMatch(/^MZ-/);
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, connA));
    expect(JSON.stringify(row)).not.toContain(code);

    expect(
      (
        await post({
          text: `<at>Mezonas</at> ${code.toLowerCase()}`,
          channelId: ORDERS,
          channelName: null,
        })
      ).status,
    ).toBe(200);
    expect(lastReply()).toBe(TEAMS_REPLIES.connected);
    expect(await channelsOf(connA)).toEqual([ORDERS]);
    const view = await call(admin("a"), "GET", `/api/connections/${connA}/teams`);
    expect(j(view.json)).toMatchObject({
      channels: [
        { channelId: ORDERS, label: `${FAKE_TEAMS.teamName} › ${FAKE_TEAMS.channelName}` },
      ],
      pendingCodeExpiresAt: null,
      newCode: null,
    });
    // Used once.
    await post({ text: `<at>Mezonas</at> ${code}`, channelId: OFFICE });
    expect(lastReply()).toBe(TEAMS_REPLIES.badCode);
    expect(await channelsOf(connA)).toEqual([ORDERS]);
  });

  it("a channel bound to one client is refused to another", async () => {
    const codeB = await codeFor(admin("b"), connB);
    await post({ text: `<at>Mezonas</at> ${codeB}`, channelId: ORDERS });
    expect(lastReply()).toBe(TEAMS_REPLIES.takenByAnother);
    await post({ text: `<at>Mezonas</at> ${codeB}`, teamId: OTHER_TEAM, channelId: OTHER });
    expect(lastReply()).toBe(TEAMS_REPLIES.connected);
    expect(await channelsOf(connB)).toEqual([OTHER]);
    expect(await channelsOf(connA)).toEqual([ORDERS]);
  });

  it("removing the bot from a team unbinds its channels; the admin disconnects a channel", async () => {
    const removed = await post({
      type: "conversationUpdate",
      teamId: OTHER_TEAM,
      channelId: OTHER,
      botRemoved: true,
    });
    expect(removed.status).toBe(200);
    expect(await channelsOf(connB)).toEqual([]);
    const code = await codeFor(admin("a"), connA);
    await post({ text: `<at>Mezonas</at> ${code}`, channelId: OFFICE });
    expect(await channelsOf(connA)).toEqual([ORDERS, OFFICE]);
    const off = await call(
      admin("a"),
      "DELETE",
      `/api/connections/${connA}/teams/channels/${encodeURIComponent(OFFICE)}`,
    );
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(j(off.json).channels.map((c: { channelId: string }) => c.channelId)).toEqual([ORDERS]);
    expect(
      (
        await call(
          admin("b"),
          "DELETE",
          `/api/connections/${connA}/teams/channels/${encodeURIComponent(ORDERS)}`,
        )
      ).status,
    ).toBe(404);
  });

  it("an agent posts to the bound channel only after approval, once", async () => {
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "shop-updates",
      bundle: bundle(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = j(created.json).agent.id;
    await call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { teams: connA },
    });
    const pub = await call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, id));
    const res = await call(OPERATOR, "POST", `/api/ops/agents/${id}/run`, { workflow: "main" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("no run started");
    const atWait: number[] = [];
    const step = new FakeWorkflowStep(async (_name, type) => {
      atWait.push(teams.posts.length);
      const inbox = await call(admin("a"), "GET", "/api/inbox");
      const item = j(inbox.json).items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      const done = await call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });
    const deps = {
      db: H.db,
      platform: H.platform,
      transport: new FakeModel(),
      instances: H.instances,
      credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
    };
    expect(await executeRun(deps, params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
    expect(atWait).toEqual([0]);
    expect(teams.posts).toHaveLength(1);
    expect(teams.posts[0]?.channelId).toBe(ORDERS);
    // The mention markup went out as plain text, never as a mention.
    expect(teams.posts[0]?.text).not.toContain("<at>");
    const [action] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, params.runId));
    expect(action).toMatchObject({ tool: TEAMS_POST_TOOL, status: "done", connectionId: connA });
    await executeRun(deps, params, cloudflareStepRunner(step));
    expect(teams.posts).toHaveLength(1);
  });

  it("never put a bot token in a response", () => {
    const all = seen.join("\n");
    for (const t of teams.issued) expect(all).not.toContain(t);
  });
});
