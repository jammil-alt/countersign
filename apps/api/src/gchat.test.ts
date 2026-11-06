// v0.14 W4-E (docs/plan.md §1.60): Google Chat through the API against a fake Google (nothing
// live). The client admin connects Google Chat and gets a one-time code; Google Chat's events
// reach `/api/hooks/gchat` only with Chat's signed token; a code binds a space to its own client
// only, once, before it expires; a space bound to one client is refused to another; removing the
// app unbinds; the admin disconnects a space. An agent posts to a bound space only after a person
// approves, once, also when the run is replayed. No response carries a token, a key or a code hash.

import {
  CHAT_REPLIES,
  createGchatConnector,
  GCHAT_POST_TOOL,
  generateEncryptionKey,
  parseChatEvent,
} from "@countersign/connectors";
import { fakeGoogleChat } from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import { agent, connection, connectionChange, externalAction } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
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
import { handleChatEvent } from "./gchat/spaces";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const google = await fakeGoogleChat();
const SHOP = "spaces/AAAAshopfloor";
const OFFICE = "spaces/AAAAbackoffice";
const OTHER = "spaces/BBBBclientb";
for (const s of [SHOP, OFFICE, OTHER]) google.addAppTo(s);

const h = await createApiHarness({
  connectors: () => [
    createGchatConnector({
      serviceAccount: google.serviceAccount,
      projectNumber: google.projectNumber,
      fetch: google.fetch,
    }),
  ],
  env: { ENCRYPTION_KEY, APP_ORIGIN: "https://app.mezonas.test" },
});
afterAll(() => h?.close());

function event(type: string, space: string, text?: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    eventTime: new Date().toISOString(),
    space: { name: space, spaceType: "SPACE", displayName: `Room ${space.slice(-6)}` },
    user: { name: "users/1001", displayName: "Ana Ruiz", type: "HUMAN" },
    ...(text === undefined
      ? {}
      : { message: { text: `@Mezonas ${text}`, argumentText: ` ${text}` } }),
    ...extra,
  };
}

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
      extraTools: [GCHAT_POST_TOOL],
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
              tool: GCHAT_POST_TOOL,
              input: { space: SHOP, text: "Cherry veneer arrived. <users/all>" },
              client: { visible: true, label: "Post the update" },
            },
          ],
        },
      },
    ],
  } as AgentBundleInput);
}

describe.skipIf(!h)("Google Chat through the API", () => {
  const H = h as ApiHarness;
  const seen: string[] = [];
  const call = async (...args: Parameters<ApiHarness["call"]>) => {
    const res = await H.call(...args);
    seen.push(JSON.stringify(res.json ?? null));
    expect(forbiddenKeys(res.json), `${args[1]} ${args[2]}`).toEqual([]);
    return res;
  };
  const chat = async (body: unknown, token?: string | null) =>
    call(null, "POST", "/api/hooks/gchat", body, {
      ...(token === null ? {} : { authorization: `Bearer ${token ?? (await google.signEvent())}` }),
    });
  let connA = "";
  let connB = "";

  async function codeFor(email: string, conn: string): Promise<string> {
    const res = await call(email, "POST", `/api/connections/${conn}/gchat/code`, {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return j(res.json).newCode;
  }
  const spacesOf = async (conn: string) => {
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, conn));
    return (j(row?.config).spaces ?? []).map((s: { name: string }) => s.name);
  };

  beforeAll(async () => {
    for (const c of [H.A, H.B]) {
      const offer = await call(OPERATOR, "PUT", `/api/ops/clients/${c.tenantId}/connectors`, {
        offered: ["testkit", "gchat"],
      });
      expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    }
    const a = await call(admin("a"), "POST", "/api/connections/gchat/authorize");
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(j(a.json).redirectUrl).toBeNull();
    connA = j(a.json).connection.connection.id;
    const b = await call(admin("b"), "POST", "/api/connections/gchat/authorize");
    connB = j(b.json).connection.connection.id;
    expect(j(b.json).connection.connection.status).toBe("connected");
  });

  it("refuses an event without Chat's own token, before reading it", async () => {
    expect((await chat(event("MESSAGE", SHOP, "hello"), null)).status).toBe(401);
    expect(
      (await chat(event("MESSAGE", SHOP, "hello"), await google.signEvent({ aud: "42" }))).status,
    ).toBe(401);
    expect(
      (await chat(event("MESSAGE", SHOP, "hello"), await google.signEvent({ signer: "stranger" })))
        .status,
    ).toBe(401);
    expect(
      (await chat(event("MESSAGE", SHOP, "hello"), await google.signEvent({ expiresInS: -300 })))
        .status,
    ).toBe(401);
    // A verified but unreadable body is a 400; a body over 64 KB a 413.
    expect((await chat("not json")).status).toBe(400);
    expect((await chat({ type: "MESSAGE", padding: "x".repeat(70_000) })).status).toBe(413);
  });

  it("answers with fixed lines and stores nothing of a message", async () => {
    const before = await H.t.db.select().from(connectionChange);
    const added = await chat(event("ADDED_TO_SPACE", SHOP));
    expect(added.status).toBe(200);
    expect(j(added.json)).toEqual({ text: CHAT_REPLIES.welcome });
    const msg = await chat(event("MESSAGE", SHOP, "what's the status of order 1042?"));
    expect(j(msg.json)).toEqual({ text: CHAT_REPLIES.onlyPosts });
    const dm = await chat({
      ...event("MESSAGE", "spaces/DDDDdm", "MZ-7K2Q-9XHD-4RTM"),
      space: { name: "spaces/DDDDdm", spaceType: "DIRECT_MESSAGE" },
    });
    expect(j(dm.json)).toEqual({ text: CHAT_REPLIES.dmRefused });
    expect(await H.t.db.select().from(connectionChange)).toHaveLength(before.length);
  });

  it("only the client admin gets a code; the code binds its own client's space once", async () => {
    expect((await call(user("a"), "POST", `/api/connections/${connA}/gchat/code`, {})).status).toBe(
      403,
    );
    expect(
      (await call(admin("b"), "POST", `/api/connections/${connA}/gchat/code`, {})).status,
    ).toBe(404);
    const code = await codeFor(admin("a"), connA);
    expect(code).toMatch(/^MZ-/);
    const view = await call(admin("a"), "GET", `/api/connections/${connA}/gchat`);
    expect(j(view.json)).toMatchObject({ spaces: [], newCode: null });
    expect(j(view.json).pendingCodeExpiresAt).toEqual(expect.any(String));
    // The code is stored only as a hash, inside the encrypted credentials.
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, connA));
    expect(JSON.stringify(row)).not.toContain(code);
    expect(JSON.stringify(row?.config)).not.toContain("pendingCode");

    const bound = await chat(event("MESSAGE", SHOP, code.toLowerCase()));
    expect(j(bound.json)).toEqual({ text: CHAT_REPLIES.connected });
    expect(await spacesOf(connA)).toEqual([SHOP]);
    expect(await spacesOf(connB)).toEqual([]);
    const after = await call(admin("a"), "GET", `/api/connections/${connA}/gchat`);
    expect(j(after.json)).toMatchObject({
      spaces: [{ name: SHOP, displayName: "Room pfloor", kind: "space", boundBy: "Ana Ruiz" }],
      pendingCodeExpiresAt: null,
    });
    // Used once: the same code in another space does nothing.
    const again = await chat(event("MESSAGE", OFFICE, code));
    expect(j(again.json)).toEqual({ text: CHAT_REPLIES.badCode });
    expect(await spacesOf(connA)).toEqual([SHOP]);
    const [made] = await H.t.db
      .select()
      .from(connectionChange)
      .where(and(eq(connectionChange.connectionId, connA)));
    expect(JSON.stringify(made?.change)).not.toContain(code);
  });

  it("a space bound to one client is refused to another; each code binds only its client", async () => {
    const codeB = await codeFor(admin("b"), connB);
    const taken = await chat(event("MESSAGE", SHOP, codeB));
    expect(j(taken.json)).toEqual({ text: CHAT_REPLIES.takenByAnother });
    expect(await spacesOf(connA)).toEqual([SHOP]);
    expect(await spacesOf(connB)).toEqual([]);
    // B's code, still unused, binds B's own space, and never A's connection.
    const ok = await chat(event("MESSAGE", OTHER, codeB));
    expect(j(ok.json)).toEqual({ text: CHAT_REPLIES.connected });
    expect(await spacesOf(connB)).toEqual([OTHER]);
    expect(await spacesOf(connA)).toEqual([SHOP]);
    // A's own code in A's bound space: already connected, and the code is spent.
    const codeA = await codeFor(admin("a"), connA);
    expect(j((await chat(event("MESSAGE", SHOP, codeA))).json)).toEqual({
      text: CHAT_REPLIES.alreadyConnected,
    });
    expect(j((await chat(event("MESSAGE", OFFICE, codeA))).json)).toEqual({
      text: CHAT_REPLIES.badCode,
    });
  });

  it("a code stops working when it expires", async () => {
    const code = await codeFor(admin("a"), connA);
    const parsed = parseChatEvent(event("MESSAGE", OFFICE, code));
    if (!parsed) throw new Error("no event");
    const late = new Date(Date.now() + 16 * 60_000);
    expect(await handleChatEvent(H.db, H.env, parsed, late)).toEqual({
      text: CHAT_REPLIES.badCode,
    });
    expect(await spacesOf(connA)).toEqual([SHOP]);
    // Still inside its 15 minutes it works.
    expect(await handleChatEvent(H.db, H.env, parsed, new Date())).toEqual({
      text: CHAT_REPLIES.connected,
    });
    expect(await spacesOf(connA)).toEqual([SHOP, OFFICE]);
  });

  it("limits codes to five an hour", async () => {
    // B made one above; four more, then refused.
    for (let i = 0; i < 4; i++) await codeFor(admin("b"), connB);
    const sixth = await call(admin("b"), "POST", `/api/connections/${connB}/gchat/code`, {});
    expect(sixth.status).toBe(429);
  });

  it("removing the app from a space unbinds it; the admin disconnects a space", async () => {
    const removed = await chat(event("REMOVED_FROM_SPACE", OTHER));
    expect(removed.status).toBe(200);
    expect(j(removed.json)).toEqual({});
    expect(await spacesOf(connB)).toEqual([]);
    const off = await call(
      admin("a"),
      "DELETE",
      `/api/connections/${connA}/gchat/spaces/AAAAbackoffice`,
    );
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(j(off.json).spaces.map((s: { name: string }) => s.name)).toEqual([SHOP]);
    expect(
      (await call(admin("b"), "DELETE", `/api/connections/${connA}/gchat/spaces/AAAAshopfloor`))
        .status,
    ).toBe(404);
    expect(
      (await call(admin("a"), "DELETE", `/api/connections/${connA}/gchat/spaces/x..y`)).status,
    ).toBe(400);
  });

  it("an agent posts to the bound space only after approval, once", async () => {
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "shop-updates",
      bundle: bundle(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = j(created.json).agent.id;
    await call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { gchat: connA },
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
      atWait.push(google.messages.length);
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
    expect(google.messages.map((m) => [m.space, m.text])).toEqual([
      [SHOP, "Cherry veneer arrived."],
    ]);
    const [action] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, params.runId));
    expect(action).toMatchObject({ tool: GCHAT_POST_TOOL, status: "done", connectionId: connA });
    expect(action?.before).toMatchObject({ space: { name: SHOP }, text: "Cherry veneer arrived." });
    // Replayed (a retried Workflow): nothing is posted twice.
    await executeRun(deps, params, cloudflareStepRunner(step));
    expect(google.messages).toHaveLength(1);
  });

  it("disconnecting Google Chat drops its spaces", async () => {
    const off = await call(admin("b"), "DELETE", `/api/connections/${connB}`);
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(await spacesOf(connB)).toEqual([]);
  });

  it("no response carried a token, the key or a code's hash", () => {
    const all = seen.join("\n");
    const sa = JSON.parse(google.serviceAccount) as { private_key: string };
    expect(all).not.toContain(sa.private_key.slice(60, 120));
    for (const t of google.issued) expect(all).not.toContain(t);
    expect(all).not.toMatch(/"pendingCode"|"hash"/);
  });
});
