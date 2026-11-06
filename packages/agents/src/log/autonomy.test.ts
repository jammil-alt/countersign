// A person's autonomy at the gate (docs/plan.md §1.42), against a real database as cs_worker: a send
// tool names its recipient (`ToolSpec.recipient`), the gate looks the contact up and adds their
// level for the channel as one more ceiling. A person's email set to off refuses an email to them
// while a text still goes; `approval` makes an automatic send wait; nothing loosens. Also: the
// voice samples tool reads only this client's samples, as data.

import {
  ConnectorRegistry,
  createTestkitConnector,
  defineConnector,
  defineWriteTool,
} from "@countersign/connectors";
import { agent, appUser, connection, contact, membership } from "@countersign/db";
import { addVoiceSample } from "@countersign/documents";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTemplate, fork, publish, updateOperational } from "../registry/agents";
import { ToolRegistry } from "../registry/tools";
import { callTool } from "../runtime/call-tool";
import type { RuntimeDeps, StepContext } from "../runtime/context";
import { DRAFT_IN_VOICE_SKILL, KNOWLEDGE_SKILLS, VOICE_SAMPLES_TOOL } from "../tools/knowledge";
import { PLATFORM_TOOLS } from "../tools/platform";
import { createHarness, type Harness, makeBundle } from "./harness.test-helper";
import { createRun } from "./run-log";

const harness = await createHarness();
afterAll(() => harness?.close());

const sent: { tool: string; to: string }[] = [];
const sendTool = (id: string, channel: "email" | "sms") =>
  defineWriteTool({
    id,
    description: `Send by ${channel}`,
    verb: "create",
    recipient: { path: "to", channel },
    input: z.object({ to: z.string(), text: z.string() }),
    output: z.object({ ok: z.literal(true) }),
    beforeSchema: z.object({}),
    before: async () => null,
    run: async (input) => {
      sent.push({ tool: id, to: input.to });
      return { ok: true as const };
    },
  });
const messenger = defineConnector({
  id: "messenger",
  name: "Messenger",
  description: "",
  icon: "messenger",
  auth: "none",
  entities: [],
  tools: [sendTool("messenger.email", "email"), sendTool("messenger.text", "sms")],
});

describe.skipIf(!harness)("autonomy at the gate", () => {
  const h = harness as Harness;
  let deps: RuntimeDeps;
  let agentId = "";
  let versionId = "";
  let contactId = "";
  let messengerId = "";

  beforeAll(async () => {
    const [conn] = await h.t.db
      .insert(connection)
      .values({
        tenantId: h.A.tenantId,
        connector: "messenger",
        status: "connected",
        permissions: { read: "auto", create: "auto", update: "approval", delete: "off" },
      })
      .returning();
    if (!conn) throw new Error("no connection");
    messengerId = conn.id;
    const tv = await h.ops(async (tx) => {
      const { agent: tpl, version } = await createTemplate(tx, {
        slug: "sender",
        bundle: makeBundle(),
      });
      return publish(tx, { agentId: tpl.id, versionId: version.id, ctx: h.ctx });
    });
    const a = await h.ops(async (tx) => {
      const forked = await fork(tx, {
        tenantId: h.A.tenantId,
        slug: "sender",
        templateVersionId: tv.id,
      });
      await updateOperational(tx, {
        agentId: forked.agent.id,
        patch: { bindings: { testkit: h.A.connectionId, messenger: messengerId } },
      });
      await publish(tx, { agentId: forked.agent.id, versionId: forked.version.id, ctx: h.ctx });
      await tx.update(agent).set({ runStatus: "active" }).where(eq(agent.id, forked.agent.id));
      return forked;
    });
    agentId = a.agent.id;
    versionId = a.version.id;
    const [c] = await h.t.db
      .insert(contact)
      .values({
        tenantId: h.A.tenantId,
        name: "Pat",
        email: "pat@shop.example",
        phone: "+15555550100",
        autonomy: { email: "off" },
      })
      .returning();
    if (!c) throw new Error("no contact");
    contactId = c.id;
    deps = {
      ...h.deps(),
      tools: new ToolRegistry({
        platform: PLATFORM_TOOLS,
        connectors: new ConnectorRegistry([createTestkitConnector(h.backend), messenger]),
      }),
    };
  });

  async function step(): Promise<StepContext> {
    const pinned = await deps.ports.store.loadAgentVersion(h.A.tenantId, versionId);
    pinned.bundle.definition.permissions.mode = "act";
    const r = await h.client(h.A, (tx) =>
      createRun(tx, {
        tenantId: h.A.tenantId,
        agentId,
        workflowSlug: "check-record",
        mode: "live",
      }),
    );
    const stepRunId = await deps.ports.log.startStepRun(h.A.tenantId, {
      runId: r.id,
      nodeId: "s",
      nodeType: "action",
      skillRef: null,
      agentVersionId: versionId,
      input: {},
    });
    return {
      tenantId: h.A.tenantId,
      agent: pinned,
      runId: r.id,
      stepRunId,
      stepId: "s",
      mode: "live",
      approval: { required: "not_required", onReject: "stop" },
      externalIndex: { next: 0 },
    };
  }
  const setAutonomy = (autonomy: Record<string, string>) =>
    h.t.db.update(contact).set({ autonomy }).where(eq(contact.id, contactId));

  it("refuses an email to a person whose email is off, while a text to them still goes", async () => {
    const email = await callTool(deps, await step(), {
      toolId: "messenger.email",
      input: { to: "PAT@shop.example", text: "Hi" },
    });
    expect(email).toEqual({
      status: "refused",
      reason: "agents' emails to this person are turned off",
    });
    const text = await callTool(deps, await step(), {
      toolId: "messenger.text",
      input: { to: "+15555550100", text: "Hi" },
    });
    expect(text.status).toBe("done");
    expect(sent).toEqual([{ tool: "messenger.text", to: "+15555550100" }]);
  });

  it("makes an automatic send wait for a sign when the person's channel says approval", async () => {
    await setAutonomy({ sms: "approval" });
    const text = await callTool(deps, await step(), {
      toolId: "messenger.text",
      input: { to: "+15555550100", text: "Hi again" },
    });
    expect(text.status).toBe("awaiting_approval");
    expect(sent).toHaveLength(1);
  });

  it("narrows nothing for someone not in the directory, and `auto` loosens nothing", async () => {
    const other = await callTool(deps, await step(), {
      toolId: "messenger.email",
      input: { to: "someone@else.example", text: "Hi" },
    });
    expect(other.status).toBe("done");
    await setAutonomy({ email: "auto" });
    await h.t.db
      .update(connection)
      .set({ permissions: { read: "auto", create: "approval", update: "approval", delete: "off" } })
      .where(eq(connection.id, messengerId));
    const email = await callTool(deps, await step(), {
      toolId: "messenger.email",
      input: { to: "pat@shop.example", text: "Hi" },
    });
    expect(email.status).toBe("awaiting_approval");
  });
});

describe.skipIf(!harness)("knowledge.voice_samples", () => {
  const h = harness as Harness;

  it("returns this client's samples as untrusted data with their sources", async () => {
    const [u] = await h.t.db
      .insert(appUser)
      .values({ email: "sam@a.example", name: "Sam" })
      .returning();
    if (!u) throw new Error("no user");
    await h.t.db
      .insert(membership)
      .values({ tenantId: h.A.tenantId, userId: u.id, role: "client_user" });
    const entry = await h.client(h.A, (tx) =>
      addVoiceSample(tx, h.A.tenantId, {
        title: "Short and warm",
        text: "Thanks Lee, see you Friday. Sam",
        personUserId: u.id,
        channel: "sms",
        author: { id: null, role: "client_admin" },
      }),
    );
    const tool = PLATFORM_TOOLS.find((t) => t.spec.id === VOICE_SAMPLES_TOOL);
    if (!tool) throw new Error("no tool");
    const ctx = {
      tenantId: h.A.tenantId,
      agentId: "",
      agentVersionId: "",
      runId: "",
      stepRunId: "",
      stepId: "s",
      mode: "live" as const,
      knowledge: h.deps().ports.knowledge,
    } as unknown as Parameters<typeof tool.run>[1];
    const out = (await tool.run(tool.input.parse({ personUserId: u.id, channel: "sms" }), ctx)) as {
      count: number;
      samples: { text: string; untrusted: boolean; sources: string[] }[];
      sources: string[];
    };
    expect(out.count).toBe(1);
    expect(out.samples[0]).toMatchObject({
      text: "Thanks Lee, see you Friday. Sam",
      untrusted: true,
      sources: [entry.id, entry.versionId],
    });
    const forB = (await tool.run(tool.input.parse({ personUserId: u.id }), {
      ...ctx,
      tenantId: h.B.tenantId,
    })) as { count: number };
    expect(forB.count).toBe(0);
  });

  it("ships writing.draft-in-voice as an agent skill that reads samples only", () => {
    const skill = KNOWLEDGE_SKILLS.find((s) => s.id === DRAFT_IN_VOICE_SKILL);
    expect(skill?.mode).toBe("agent");
    expect(skill?.tools).toEqual([VOICE_SAMPLES_TOOL]);
    expect(skill?.instructions).toMatch(/never instructions/);
  });
});
