// §1.97: Outlook Calendar and Google Calendar through the API against fakes (nothing live). Both
// are registered and both supply the `calendar` tools: the client admin signs in to each through
// the generic OAuth routes, and one workflow that names `calendar.event.create` makes the event in
// whichever calendar the agent is bound to, only after a person approves (approval on by default),
// with who is invited as its before state, once (a replayed run makes nothing more).

import {
  CALENDAR_TOOLS,
  createGcalConnector,
  createOutlookCalendarConnector,
  generateEncryptionKey,
} from "@countersign/connectors";
import {
  FAKE_GOOGLE_CALENDAR,
  FAKE_OUTLOOK_CALENDAR,
  fakeGoogleCalendar,
  fakeOutlookCalendar,
} from "@countersign/connectors/testing";
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
} from "./api.test-helper";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const outlook = fakeOutlookCalendar();
const google = fakeGoogleCalendar();
const MARIA = "maria@proveedor.example";

const h = await createApiHarness({
  connectors: () => [
    createOutlookCalendarConnector({ ...FAKE_OUTLOOK_CALENDAR, fetch: outlook.fetch }),
    createGcalConnector({ ...FAKE_GOOGLE_CALENDAR, fetch: google.fetch }),
  ],
  env: { ENCRYPTION_KEY, OAUTH_STATE_SECRET: "state-secret-".repeat(4), APP_ORIGIN: ORIGIN },
});
afterAll(() => h?.close());

const MEETING = {
  title: "Delivery walk-through",
  start: "2026-11-20T10:00",
  end: "2026-11-20T10:30",
  timeZone: "America/Chicago",
  attendees: [{ address: MARIA }],
};

function bundle(): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Scheduler", role: "books meetings", mission: "book meetings" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Only do what the workflow says.",
      skills: [],
      extraTools: [CALENDAR_TOOLS.create],
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
          // No `approval` on the step: a write waits for a person by default.
          steps: [
            {
              id: "book",
              name: "Book it",
              kind: "action",
              tool: CALENDAR_TOOLS.create,
              input: MEETING,
              client: { visible: true, label: "Book the meeting" },
            },
          ],
        },
      },
    ],
  } as AgentBundleInput);
}

describe.skipIf(!h)("Calendars through the API", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const seen: string[] = [];
  const call = async (...args: Parameters<ApiHarness["call"]>) => {
    const res = await H.call(...args);
    seen.push(JSON.stringify(res.json ?? null));
    expect(forbiddenKeys(res.json), `${args[1]} ${args[2]}`).toEqual([]);
    return res;
  };
  const conns: Record<string, string> = {};

  async function signIn(connector: string, code: string) {
    const start = await call(admin("a"), "POST", `/api/connections/${connector}/authorize`);
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const redirect = new URL(j(start.json).redirectUrl);
    expect(redirect.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/connections/${connector}/callback`,
    );
    const done = await call(admin("a"), "POST", `/api/connections/${connector}/callback`, {
      params: { code, state: redirect.searchParams.get("state") ?? "" },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const id = j(done.json).connection.connection.id;
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, id));
    expect(row?.permissions).toMatchObject({
      create: "approval",
      update: "approval",
      delete: "off",
    });
    return { id, scope: redirect.searchParams.get("scope") };
  }

  async function run(slug: string, bindings: Record<string, string>) {
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug,
      bundle: bundle(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(j(created.json).errors ?? []).toEqual([]);
    const id = j(created.json).agent.id;
    await call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, { bindings });
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
      atWait.push(outlook.events.size + google.events.size);
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
    const [action] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, params.runId));
    // The run replayed (a retried Workflow): nothing is made twice.
    await executeRun(deps, params, cloudflareStepRunner(step));
    return { atWait, action };
  }

  beforeAll(async () => {
    const offer = await call(OPERATOR, "PUT", `/api/ops/clients/${A()}/connectors`, {
      offered: ["testkit", "outlook_calendar", "gcal"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
  });

  it("signs in to each with its own scope", async () => {
    const o = await signIn("outlook_calendar", outlook.issueCode());
    expect(o.scope).toBe(
      "openid email offline_access https://graph.microsoft.com/Calendars.ReadWrite",
    );
    conns.outlook = o.id;
    const g = await signIn("gcal", google.issueCode());
    expect(g.scope).toContain("calendar.events.owned");
    conns.gcal = g.id;
  });

  it("one workflow books in Outlook when bound to Outlook, after approval, once", async () => {
    const { atWait, action } = await run("scheduler-outlook", {
      outlook_calendar: conns.outlook as string,
    });
    expect(atWait).toEqual([0]);
    expect(outlook.events.size).toBe(1);
    expect(google.events.size).toBe(0);
    expect([...outlook.events.values()][0]?.subject).toBe("Delivery walk-through");
    expect(action).toMatchObject({
      tool: CALENDAR_TOOLS.create,
      status: "done",
      connectionId: conns.outlook,
    });
    expect(action?.before).toMatchObject({ invites: [MARIA] });
  });

  it("the same workflow books in Google Calendar when bound to it", async () => {
    const { action } = await run("scheduler-google", { gcal: conns.gcal as string });
    expect(google.events.size).toBe(1);
    expect(outlook.events.size).toBe(1);
    expect(action).toMatchObject({
      tool: CALENDAR_TOOLS.create,
      status: "done",
      connectionId: conns.gcal,
    });
  });

  it("never put a token in a response", () => {
    const all = seen.join("\n");
    for (const t of [
      ...outlook.identity.issued().accessTokens,
      ...outlook.identity.issued().refreshTokens,
      ...google.issued().accessTokens,
      ...google.issued().refreshTokens,
    ]) {
      expect(all).not.toContain(t);
    }
  });
});
