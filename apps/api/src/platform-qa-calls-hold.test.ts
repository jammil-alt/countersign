// PLATFORM_QA CONS-3 (consistency): the gate is copied for calls ringing in (apps/api/src/calls/answer.ts
// planInbound calls core decideToolCall itself). The runtime's gate (packages/agents
// runtime/call-tool.ts) adds the agent's safety hold as an approval ceiling on every external
// write (docs/plan.md §1.124.1); the copy for a ringing call doesn't read the hold.
import {
  CALL_ANSWER_TOOL,
  createTwilioConnector,
  ELEVENLABS_API,
  type FetchLike,
  formEncode,
  generateEncryptionKey,
  MESSAGES_SEARCH_TOOL,
} from "@countersign/connectors";
import {
  FAKE_ELEVENLABS,
  FAKE_TWILIO_MAIN,
  fakeElevenLabs,
  fakeTwilio,
} from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import { agent, connection } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";
import { quietNever } from "./quiet-hours.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const twilio = fakeTwilio();
const el = fakeElevenLabs();
const fetch: FetchLike = (url, init) =>
  url.startsWith(ELEVENLABS_API) ? el.fetch(url, init) : twilio.fetch(url, init);
const CALLER = "+15555550111";

const h = await createApiHarness({
  connectors: () => [createTwilioConnector({ fetch: (url, init) => twilio.fetch(url, init) })],
  env: {
    ENCRYPTION_KEY,
    APP_ORIGIN: ORIGIN,
    TWILIO_ACCOUNT_SID: FAKE_TWILIO_MAIN.accountSid,
    TWILIO_AUTH_TOKEN: FAKE_TWILIO_MAIN.authToken,
    ELEVENLABS_API_KEY: FAKE_ELEVENLABS.apiKey,
    ELEVENLABS_WEBHOOK_SECRET: FAKE_ELEVENLABS.webhookSecret,
  },
  fetch,
});
afterAll(() => h?.close());

const ANSWER = {
  schemaVersion: 3,
  trigger: { id: "trg", on: { type: "event", event: "call.received" } },
  steps: [
    {
      id: "answer",
      name: "Answer the call",
      kind: "action",
      tool: CALL_ANSWER_TOOL,
      input: {
        callSid: "{{trigger.callSid}}",
        purpose: "Answer questions about orders and opening hours",
        tools: [MESSAGES_SEARCH_TOOL],
      },
      approval: { required: "not_required" },
      client: { visible: true, label: "Answered a call" },
    },
  ],
};

function reception(): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Reception", role: "front desk", mission: "Help the shop's customers." },
      kind: "functional",
      model: { id: "test-model", maxTokens: 1024 },
      instructions: "Be brief and kind.",
      skills: [],
      extraTools: [CALL_ANSWER_TOOL, MESSAGES_SEARCH_TOOL],
      canCommand: [],
      permissions: { mode: "act" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [{ slug: "main", name: "Main", workflow: ANSWER }],
  } as AgentBundleInput);
}

describe.skipIf(!h)("CONS: the gate for a ringing call", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const msg = (path = "") => `/api/ops/clients/${A()}/messaging${path}`;
  const calls = (path = "") => `/api/ops/clients/${A()}/calls${path}`;
  let setup: ReturnType<typeof j> = null;
  let agentId = "";

  async function ringIn(from: string) {
    const c = await twilio.voiceIn({
      account: setup.twilio.subaccountSid,
      from,
      to: setup.twilio.numbers[0].phoneNumber,
      url: `${ORIGIN}/api/twilio/${A()}/voice`,
    });
    return H.call(null, "POST", `/api/twilio/${A()}/voice`, formEncode(c.params), {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": c.signature,
    });
  }

  beforeAll(async () => {
    expect((await H.call(OPERATOR, "PUT", msg(), { quietHours: quietNever() })).status).toBe(200);
    await H.call(OPERATOR, "POST", msg("/twilio"));
    const bought = await H.call(OPERATOR, "POST", msg("/numbers"), { phoneNumber: "+15125550101" });
    setup = j(bought.json).setup;
    const connectionId = setup.twilio.connectionId;
    const on = await H.call(OPERATOR, "PUT", calls(), { enabled: true, forwardTo: null });
    expect(on.status, JSON.stringify(on.json)).toBe(200);
    // The matrix lets the agent answer on its own; the step is not_required; the agent acts.
    await H.t.db
      .update(connection)
      .set({ permissions: { read: "auto", create: "auto", update: "approval", delete: "off" } })
      .where(eq(connection.id, connectionId));
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: "reception",
      bundle: reception(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    agentId = j(created.json).agent.id;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { twilio: connectionId },
    });
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", stage: "live" })
      .where(eq(agent.id, agentId));
    // Unheld, the agent answers (the precondition the hold should change).
    const preview = j((await H.call(OPERATOR, "GET", calls())).json).setup.inbound;
    expect(preview).toMatchObject({ decision: "agent", agentName: "Reception" });
  });

  it("(PLATFORM_QA CONS-3) an agent on a safety hold doesn't answer a ringing call on its own", async () => {
    // A critical issue holds the agent: every external write must wait for a person.
    await H.t.db
      .update(agent)
      .set({
        hold: {
          issueId: "issue-1",
          by: "operator",
          userId: null,
          at: new Date().toISOString(),
          reason: "Told a caller the wrong prices",
        },
      })
      .where(eq(agent.id, agentId));
    const voiceAgentsBefore = el.agents.size;
    const rang = await ringIn(CALLER);
    expect(rang.status).toBe(200);
    const preview = j((await H.call(OPERATOR, "GET", calls())).json).setup.inbound;
    expect({
      preview: preview.decision,
      handedToVoiceAgent: String(rang.json).includes("<Connect><Stream"),
      voiceAgentsMade: el.agents.size - voiceAgentsBefore,
    }).toEqual({ preview: "voicemail", handedToVoiceAgent: false, voiceAgentsMade: 0 });
  });
});
