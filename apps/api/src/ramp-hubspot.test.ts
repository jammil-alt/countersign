// v0.12 W3-B: Ramp and HubSpot through the API, against fakes (docs/plan.md §1.52): each signs in
// through the generic OAuth routes with tokens encrypted and never shown to the operator; Ramp's
// poll stores new transactions once and announces them only after the first read; a HubSpot note
// in a workflow waits for approval and is added once, however often the run is retried.

import {
  createHubspotConnector,
  createRampConnector,
  generateEncryptionKey,
  HUBSPOT_TOOLS,
  RAMP_TRANSACTION_CREATED,
} from "@countersign/connectors";
import { FAKE_HUBSPOT, FAKE_RAMP, fakeHubspot, fakeRamp } from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import { agent, connection, event, externalAction, rawRecord } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
} from "./api.test-helper";
import { RAMP_POLL_MINUTE, rampPollTick } from "./ramp/poll";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const ramp = fakeRamp();
const hubspot = fakeHubspot({ now: new Date() });

const h = await createApiHarness({
  connectors: () => [
    createRampConnector({
      clientId: FAKE_RAMP.clientId,
      clientSecret: FAKE_RAMP.clientSecret,
      fetch: ramp.fetch,
    }),
    createHubspotConnector({
      clientId: FAKE_HUBSPOT.clientId,
      clientSecret: FAKE_HUBSPOT.clientSecret,
      fetch: hubspot.fetch,
    }),
  ],
  env: { ENCRYPTION_KEY, OAUTH_STATE_SECRET: "state-secret-".repeat(4), APP_ORIGIN: ORIGIN },
});
afterAll(() => h?.close());

describe.skipIf(!h)("Ramp and HubSpot through the API", () => {
  const H = h as ApiHarness;
  const credentials = () => credentialsFor(H.db, { current: ENCRYPTION_KEY });

  /** Offers the connector to client B and signs its admin in through the generic routes. */
  async function signIn(connector: "ramp" | "hubspot", code: string, origin: string) {
    const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.B.tenantId}/connectors`, {
      offered: ["testkit", "ramp", "hubspot"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    const start = await H.call(admin("b"), "POST", `/api/connections/${connector}/authorize`);
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const redirect = new URL(j(start.json).redirectUrl);
    expect(redirect.origin).toBe(origin);
    expect(redirect.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/connections/${connector}/callback`,
    );
    const state = redirect.searchParams.get("state") ?? "";
    // Another client's admin can't land this state in their client.
    const swapped = await H.call(admin("a"), "POST", `/api/connections/${connector}/callback`, {
      params: { code, state },
    });
    expect(swapped.status).toBe(404);
    const done = await H.call(admin("b"), "POST", `/api/connections/${connector}/callback`, {
      params: { code, state },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const id: string = j(done.json).connection.connection.id;
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, id));
    expect(row?.connectedBy).toBe(H.B.admin);
    expect(row?.permissions).toMatchObject({
      create: "approval",
      update: "approval",
      delete: "off",
    });
    const asOperator = JSON.stringify(
      (await H.call(OPERATOR, "GET", `/api/ops/clients/${H.B.tenantId}/connections`)).json,
    );
    return { id, row, asOperator };
  }

  describe("Ramp", () => {
    let connectionId = "";

    it("signs the client in; tokens are encrypted and never shown to the operator", async () => {
      const { id, row, asOperator } = await signIn("ramp", FAKE_RAMP.code, "https://app.ramp.com");
      connectionId = id;
      expect(row).toMatchObject({
        status: "connected",
        externalAccountId: FAKE_RAMP.businessId,
        config: { businessName: FAKE_RAMP.businessName },
      });
      const { accessTokens, refreshTokens } = ramp.issued();
      for (const secret of [...accessTokens, ...refreshTokens]) {
        expect(JSON.stringify(row?.credentialsEncrypted)).not.toContain(secret);
        expect(asOperator).not.toContain(secret);
      }
    });

    it("polls: the first read stores and announces nothing old, later reads announce each new one once", async () => {
      const base = new Date();
      base.setUTCMinutes(RAMP_POLL_MINUTE, 0, 0);
      const deps = { db: H.db, platform: H.platform, credentials: credentials() };
      // Not this connector's minute: nothing read.
      const off = new Date(base.getTime() + 60_000);
      expect(await rampPollTick(deps, off)).toMatchObject({ connections: 0, stored: 0 });

      const first = await rampPollTick(deps, base);
      expect(first).toMatchObject({ connections: 1, events: [] });
      const stored = () =>
        H.t.db
          .select()
          .from(rawRecord)
          .where(and(eq(rawRecord.connectionId, connectionId), eq(rawRecord.connector, "ramp")));
      const before = (await stored()).length;
      expect(before).toBe(first.stored);

      // A purchase made yesterday reaches Ramp after the last read: still announced.
      const late = ramp.addTransaction({
        id: "7a2d3e2f-9c4b-4d70-8b62-3a1d8e0f2b04",
        amount: 64,
        merchant_name: "Baltic Plywood Co",
        user_transaction_time: new Date(base.getTime() - 24 * 3600_000).toISOString(),
      });
      const next = new Date(base.getTime() + 15 * 60_000);
      const second = await rampPollTick(deps, next);
      expect(second).toMatchObject({ connections: 1, stored: 1 });
      expect(second.events).toHaveLength(1);
      expect(second.events[0]).toMatchObject({
        tenantId: H.B.tenantId,
        type: RAMP_TRANSACTION_CREATED,
        subjectType: "raw_record",
      });
      expect(second.events[0]?.payload).toMatchObject({
        connectionId,
        transaction: {
          id: late.id,
          amount: { amount: "64.0000", currency: "USD" },
          merchantName: "Baltic Plywood Co",
        },
      });
      expect(await stored()).toHaveLength(before + 1);

      // Read again: nothing new, nothing announced twice.
      const third = await rampPollTick(deps, new Date(next.getTime() + 15 * 60_000));
      expect(third).toMatchObject({ stored: 0, events: [] });
      const events = await H.t.db
        .select()
        .from(event)
        .where(eq(event.type, RAMP_TRANSACTION_CREATED));
      expect(events.map((e) => e.tenantId)).toEqual([H.B.tenantId]);
      const [row] = await H.t.db.select().from(connection).where(eq(connection.id, connectionId));
      expect(row?.syncCursor).toMatchObject({ ramp: true });
    });

    it("puts the connection in error when the sign-in is gone", async () => {
      ramp.expireAccessTokens();
      ramp.expireRefreshTokens();
      const at = new Date();
      at.setUTCMinutes(RAMP_POLL_MINUTE + 30, 0, 0);
      const r = await rampPollTick(
        { db: H.db, platform: H.platform, credentials: credentials() },
        at,
      );
      expect(r.events.map((e) => e.type)).toEqual(["connection.needs_attention"]);
      const [row] = await H.t.db.select().from(connection).where(eq(connection.id, connectionId));
      expect(row?.status).toBe("error");
    });
  });

  describe("HubSpot", () => {
    let connectionId = "";

    it("signs the client in; tokens are encrypted and never shown to the operator", async () => {
      const { id, row, asOperator } = await signIn(
        "hubspot",
        FAKE_HUBSPOT.code,
        "https://app.hubspot.com",
      );
      connectionId = id;
      expect(row).toMatchObject({
        status: "connected",
        externalAccountId: String(FAKE_HUBSPOT.hubId),
        config: { hubDomain: FAKE_HUBSPOT.hubDomain },
      });
      for (const secret of hubspot.issued().refreshTokens) {
        expect(JSON.stringify(row?.credentialsEncrypted)).not.toContain(secret);
        expect(asOperator).not.toContain(secret);
      }
    });

    it("reads a deal in a skill step, then adds a note once after the client approves", async () => {
      const bundle = AgentBundle.parse({
        schemaVersion: 1,
        definition: {
          schemaVersion: 2,
          identity: { name: "CRM clerk", role: "keeps deals current", mission: "notes on deals" },
          kind: "functional",
          model: { id: "claude-opus-5-5", maxTokens: 1024 },
          instructions: "Only do what the workflow says.",
          skills: [{ skill: HUBSPOT_TOOLS.get, settings: {} }],
          extraTools: [HUBSPOT_TOOLS.note],
          canCommand: [],
          // Even in act mode, a new step's write waits for approval.
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
              steps: [
                {
                  id: "read",
                  name: "Read the deal",
                  kind: "skill",
                  skill: HUBSPOT_TOOLS.get,
                  input: { objectType: "deals", id: FAKE_HUBSPOT.deal },
                  client: { visible: true, label: "Read the deal" },
                },
                {
                  id: "note",
                  name: "Note the quote",
                  kind: "action",
                  tool: HUBSPOT_TOOLS.note,
                  input: {
                    objectType: "deals",
                    recordId: "{{steps.read.output.record.id}}",
                    text: "Quote sent.",
                  },
                  client: { visible: true, label: "Noted the quote on the deal" },
                },
              ],
            },
          },
        ],
      } as AgentBundleInput);
      const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.B.tenantId}/agents`, {
        slug: "hubspot-clerk",
        bundle,
      });
      expect(created.status, JSON.stringify(created.json)).toBe(200);
      expect(j(created.json).errors ?? [], JSON.stringify(created.json)).toEqual([]);
      const id = j(created.json).agent.id;
      const op = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
        bindings: { hubspot: connectionId },
      });
      expect(op.status, JSON.stringify(op.json)).toBe(200);
      const pub = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${id}/versions/${j(created.json).version.id}/publish`,
      );
      expect(pub.status, JSON.stringify(pub.json)).toBe(200);
      await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, id));
      const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/run`, { workflow: "main" });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const params = H.instances.started.get(j(res.json).runId);
      if (!params) throw new Error("not started");
      let asked = 0;
      const approver = new FakeWorkflowStep(async (_name, type) => {
        asked += 1;
        const inbox = await H.call(admin("b"), "GET", "/api/inbox");
        const item = j(inbox.json).items.find(
          (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
        );
        if (!item) throw new Error(`no open item for ${type}`);
        const done = await H.call(admin("b"), "POST", `/api/inbox/${item.id}/resolve`, {
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
        credentials: credentials(),
      };
      expect(await executeRun(deps, params, cloudflareStepRunner(approver))).toEqual({
        status: "succeeded",
      });
      expect(asked).toBe(1);
      const notes = () => hubspot.objects.filter((o) => o.type === "notes");
      expect(notes()).toHaveLength(1);
      expect(notes()[0]?.associations).toEqual([
        { type: "deals", id: FAKE_HUBSPOT.deal, typeId: 214 },
      ]);
      const [action] = await H.t.db
        .select()
        .from(externalAction)
        .where(eq(externalAction.runId, params.runId));
      expect(action).toMatchObject({
        status: "done",
        tool: HUBSPOT_TOOLS.note,
        approvedBy: H.B.admin,
      });
      expect(action?.before).toEqual({
        record: { objectType: "deals", id: FAKE_HUBSPOT.deal, name: "Okafor kitchen cabinets" },
      });
      // The run is retried from the start: the note is not added again.
      await executeRun(deps, params, cloudflareStepRunner(approver));
      expect(notes()).toHaveLength(1);
    });
  });
});
