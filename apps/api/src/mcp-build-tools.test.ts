// Builds and step settings through the MCP server (docs/plan.md §1.34): a build drafted, talked
// through and changed with the Builder from Claude (its slow routes run through invokeRoute), and
// an agent's steps read, changed as a draft and published with the two-step confirm. Never from
// here: the client test, QA or going live, turning an approval off, or a first publish.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { agentVersion, appUser, auditEvent, skill, skillVersion } from "@countersign/db";
import { FakeModel, type LlmRequest } from "@countersign/llm";
import { and, eq, like } from "drizzle-orm";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  testBundle,
  v5Workflow,
} from "./api.test-helper";
import { memoryRateLimiter } from "./mcp/limits";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ISSUER = "https://auth.mezonas.test";
const ORIGIN = "https://staging.mezonas.test";
const RESOURCE = `${ORIGIN}/mcp`;
const PASSWORD = "mcp-test-cookie-password-0123456789abcdef";
const WORKOS_OPERATOR = "user_operator";

const signing = await generateKeyPair("RS256");
const keys = createLocalJWKSet({
  keys: [{ ...(await exportJWK(signing.publicKey)), kid: "k1", alg: "RS256" }],
});
const clock = new Date("2026-11-24T12:00:00Z");
const model = new FakeModel();

const h = await createApiHarness({
  llm: model,
  env: {
    ENVIRONMENT: "staging",
    WORKOS_CLIENT_ID: "client_test",
    WORKOS_API_KEY: "sk_test",
    WORKOS_COOKIE_PASSWORD: PASSWORD,
    APP_ORIGIN: ORIGIN,
    WORKOS_AUTHKIT_DOMAIN: ISSUER,
  },
  mcp: {
    authorizationServer: () => ({
      async discover() {
        return {
          metadata: {
            issuer: ISSUER,
            jwks_uri: `${ISSUER}/oauth2/jwks`,
            authorization_endpoint: `${ISSUER}/oauth2/authorize`,
            registration_endpoint: `${ISSUER}/oauth2/register`,
          },
          keys,
        };
      },
    }),
    audit: () => ({ async record() {} }),
    rateLimiter: () => memoryRateLimiter(10_000),
    now: () => clock,
  },
});
afterAll(() => h?.close());

// ── The Builder's scripted answers (as build-draft-now.test.ts) ────────────────────────────────

const DESCRIPTION =
  "When someone asks, fix the amount on the record in the testkit. The client approves each change.";

const _update = {
  id: "update",
  name: "Update the record",
  checks: { approval: { required: "required" } },
  kind: "do",
  doneBy: "rules",
  uses: { type: "action", action: TESTKIT_UPDATE_TOOL },
  input: { id: "r1", amount: "12.00" },
};

const draftAnswer = () => ({
  toolUse: {
    name: "submit_draft",
    input: {
      summary: "It fixes the record's amount and asks the client first.",
      gaps: [],
      startFromTemplate: null,
      decisions: [
        {
          id: "approve-each",
          what: "The client approves each change to a record.",
          why: "The description says so.",
          kind: "assumption",
          risk: "high",
          category: "writes",
          stepId: "update",
        },
      ],
      bundle: {
        schemaVersion: 1,
        definition: {
          schemaVersion: 2,
          identity: { name: "Record fixer", role: "Records", mission: "Keep records right" },
          kind: "functional",
          model: { id: "claude-sonnet-5-5" },
          instructions: "Fix records when asked.",
          skills: [],
          permissions: { mode: "suggest_only" },
        },
        workflows: [
          {
            slug: "main",
            name: "Fix a record",
            workflow: {
              schemaVersion: 5,
              triggers: [{ id: "t", on: { type: "manual", input: {} } }],
              outputs: [{ id: "out-done", name: "Done", kind: "nothing" }],
              steps: [
                {
                  id: "update",
                  name: "Update the record",
                  checks: { approval: { required: "required" } },
                  kind: "do",
                  doneBy: "rules",
                  uses: { type: "action", action: TESTKIT_UPDATE_TOOL },
                  input: { id: "r1", amount: "12.00" },
                },
                { id: "end", kind: "end", name: "Done", outputs: ["out-done"] },
              ],
            },
          },
        ],
      },
    },
  },
});

const editProposal = (amount: string) => ({
  toolUse: {
    name: "submit_build_turn",
    input: {
      chips: [],
      items: [],
      text: `I'd set the amount to ${amount} on the update step.`,
      proposal: {
        summary: `Set the amount on “Update the record” to ${amount}`,
        action: {
          do: "edit_draft",
          request: `On “Update the record”, set the amount to ${amount}.`,
        },
      },
    },
  },
});

type Draft = { workflows: { workflow: { steps: Record<string, unknown>[] } }[] };
function setsAmount(amount: string) {
  return (req: LlmRequest) => {
    const content = req.messages[0]?.content as string;
    const start = content.indexOf("<current_bundle>") + "<current_bundle>".length;
    const d = JSON.parse(content.slice(start, content.indexOf("</current_bundle>"))) as Draft;
    const step = d.workflows[0]?.workflow.steps[0] as { input: { amount: string } } | undefined;
    if (step) step.input.amount = amount;
    return {
      toolUse: { name: "submit_turn", input: { text: `Set it to ${amount}.`, bundle: d } },
    };
  };
}

describe.skipIf(!h)("MCP builds and step settings", () => {
  const H = h as ApiHarness;
  let bearer = "";
  let nextId = 1;
  const asDev: ApiHarness["call"] = async (...args) => {
    const env = H.env as { ENVIRONMENT?: string };
    env.ENVIRONMENT = "development";
    try {
      return await H.call(...args);
    } finally {
      env.ENVIRONMENT = "staging";
    }
  };

  async function tool(name: string, args: Record<string, unknown> = {}) {
    const res = await H.app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      },
      H.env,
    );
    expect(res.status).toBe(200);
    const result = j(await res.json()).result as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = result.content.map((c) => c.text ?? "").join("\n");
    return {
      text,
      isError: result.isError === true,
      data: () => {
        const m = /<untrusted-data source="[^"]+">\n([\s\S]*)\n<\/untrusted-data>/.exec(text);
        if (!m?.[1]) throw new Error(`no data block in: ${text}`);
        return j(JSON.parse(m[1]));
      },
    };
  }
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await tool(name, args);
    expect(r.isError, r.text).toBe(false);
    return r;
  };
  const token = (text: string) => /confirm_token "([^"]+)"/.exec(text)?.[1] as string;

  let clientAgent = "";

  beforeAll(async () => {
    await H.t.db
      .update(appUser)
      .set({ workosUserId: WORKOS_OPERATOR })
      .where(eq(appUser.id, H.operator));
    const now = Math.floor(clock.getTime() / 1000);
    bearer = await new SignJWT({ sid: "session_x" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setSubject(WORKOS_OPERATOR)
      .setIssuedAt(now - 5)
      .setExpirationTime(now + 3600)
      .sign(signing.privateKey);

    // A client agent in client A: a template forked there, bound and published.
    await asDev(admin("a"), "POST", "/api/connections/testkit/authorize");
    const tpl = await asDev(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-clerk",
      bundle: testBundle(),
    });
    const tid = j(tpl.json).agent.id;
    await asDev(
      OPERATOR,
      "POST",
      `/api/ops/agents/${tid}/versions/${j(tpl.json).version.id}/publish`,
    );
    const fork = await asDev(OPERATOR, "POST", `/api/ops/templates/${tid}/fork`, {
      clientId: H.A.tenantId,
    });
    clientAgent = j(fork.json).agent.id;
    await asDev(OPERATOR, "PATCH", `/api/ops/agents/${clientAgent}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    const pub = await asDev(
      OPERATOR,
      "POST",
      `/api/ops/agents/${clientAgent}/versions/${j(fork.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
  });

  it("lists the build and agent tools, and none that reaches the client test, QA or go live", async () => {
    const res = await H.app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/list" }),
      },
      H.env,
    );
    const tools = j(await res.json()).result.tools as { name: string; inputSchema: unknown }[];
    const names = tools.map((t) => t.name);
    for (const n of [
      "builds_list",
      "build_get",
      "build_start",
      "build_say",
      "build_proposal",
      "build_draft_now",
      "build_tests",
      "build_try",
      "build_stop",
      "agents_list",
      "agent_steps",
      "agent_step_update",
      "agent_publish",
    ]) {
      expect(names).toContain(n);
    }
    expect(names.filter((n) => /client_test|qa|go_live|activate|release|rollback/.test(n))).toEqual(
      [],
    );
    const move = tools.find((t) => t.name === "build_move");
    expect(JSON.stringify(move?.inputSchema)).not.toContain("client_test");
    expect(await tool("build_move", { id: clientAgent, to: "client_test" })).toMatchObject({
      isError: true,
    });
  });

  it("builds an agent with the Builder: start, draft, a proposal agreed, its steps read", async () => {
    let r = await ok("build_start", { kind: "agent", title: "Record fixer" });
    const id = r.data().build.id as string;
    expect(r.data().build.phase).toBe("intake");
    expect((await ok("builds_list")).data().builds.map((b: { id: string }) => b.id)).toContain(id);

    // A slow route (the Builder drafting) through the MCP server, audited as the MCP's.
    model.push(draftAnswer());
    r = await ok("build_draft_now", { id, description: DESCRIPTION });
    let b = r.data();
    expect(b.build.phase).toBe("draft");
    expect(b.draft.problems).toEqual([]);
    expect(b.decisions).toMatchObject([{ id: "approve-each", risk: "high" }]);
    const audited = await H.t.db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(like(auditEvent.action, "mcp POST /api/ops/builds/:id/draft-now"));
    expect(audited.length).toBeGreaterThan(0);

    // The Builder proposes, the operator agrees, the draft changes.
    model.push(editProposal("20.00"));
    r = await ok("build_say", { id, text: "What would you fix?" });
    const proposed = r.data().messages.find((m: { proposal?: unknown }) => m.proposal);
    expect(proposed.proposal.state).toBe("proposed");
    model.push(setsAmount("20.00"));
    r = await ok("build_proposal", { id, message: proposed.id, decide: "agree" });
    b = r.data();
    expect(b.messages.find((m: { id: string }) => m.id === proposed.id).proposal.state).toBe(
      "agreed",
    );

    // The draft is an agent: its steps and their settings, checks included (a v5 Do, the step
    // model the Builder drafts in).
    r = await ok("agent_steps", { agent: b.draft.agentId });
    const steps = r.data();
    expect(steps.version.live).toBe(false);
    expect(steps.workflows[0].steps[0].settings).toMatchObject({
      name: "Update the record",
      kind: "do",
      input: { amount: "20.00" },
      checks: { approval: { required: "required" } },
    });

    // A decision looked at; an item added.
    r = await ok("build_decision", { id, decision: "approve-each", status: "confirmed" });
    expect(r.data().decisions[0].status).toBe("confirmed");
    r = await ok("build_item", { id, title: "Ask who signs over 5,000" });
    expect(r.data().openItems.map((i: { title: string }) => i.title)).toContain(
      "Ask who signs over 5,000",
    );

    // Never published: its first publish is the back office's.
    r = await tool("agent_publish", { agent: b.draft.agentId });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("back_office_only");

    // Stopping takes two calls.
    r = await ok("build_stop", { id, reason: "Testing the MCP" });
    expect(r.text).toContain("Preview, nothing changed yet");
    expect((await ok("build_get", { id })).data().build.status).toBe("open");
    r = await ok("build_stop", { id, reason: "Testing the MCP", confirm_token: token(r.text) });
    expect(r.data().build.status).toBe("stopped");
  });

  it("reads a client agent's steps, changes one as a draft, and publishes it with a confirm", async () => {
    let r = await ok("agents_list", { client: H.A.tenantId });
    expect(r.data().map((a: { id: string }) => a.id)).toContain(clientAgent);

    r = await ok("agent_steps", { agent: clientAgent, step: "update" });
    expect(r.data().steps[0].settings).toMatchObject({
      kind: "do",
      uses: { type: "action" },
      input: { id: "r1", amount: "12.00" },
      checks: { approval: { required: "required" } },
    });

    // The structure and turning approval off are the back office's.
    r = await tool("agent_step_update", {
      agent: clientAgent,
      step: "update",
      set: { kind: "person" },
    });
    expect(r.text).toContain("builder_only");
    r = await tool("agent_step_update", {
      agent: clientAgent,
      step: "update",
      set: { "checks.approval.required": "not_required" },
    });
    expect(r.text).toContain("back_office_only");

    // A setting changed: a draft; live keeps running.
    r = await ok("agent_step_update", {
      agent: clientAgent,
      step: "update",
      set: { "input.amount": "14.50", "checks.approval.approvers": [{ who: "client_admin" }] },
    });
    const saved = r.data();
    expect(saved.errors).toEqual([]);
    expect(saved.step.settings).toMatchObject({
      input: { amount: "14.50" },
      checks: { approval: { required: "required", approvers: [{ who: "client_admin" }] } },
    });
    const live = await asDev(OPERATOR, "GET", `/api/ops/agents/${clientAgent}`);
    expect(j(live.json).agent.liveVersionId).not.toBe(saved.version.id);

    // Publish: preview, then confirm with the token.
    r = await ok("agent_publish", { agent: clientAgent });
    expect(r.text).toContain("Preview, nothing changed yet");
    expect(r.data().to.id).toBe(saved.version.id);
    const t = token(r.text);
    r = await ok("agent_publish", { agent: clientAgent, confirm_token: t });
    expect(r.data().version.id).toBe(saved.version.id);
    const after = await asDev(OPERATOR, "GET", `/api/ops/agents/${clientAgent}`);
    expect(j(after.json).agent.liveVersionId).toBe(saved.version.id);
    expect((await tool("agent_publish", { agent: clientAgent, confirm_token: t })).isError).toBe(
      true,
    );
    expect(
      (
        await H.t.db
          .select({ id: auditEvent.id })
          .from(auditEvent)
          .where(
            and(
              eq(auditEvent.action, "mcp POST /api/ops/agents/:id/versions/:vid/publish"),
              eq(auditEvent.outcome, "ok"),
            ),
          )
      ).length,
    ).toBe(1);
  });

  // Staging, 2026-11-27: a step's AI text changed here was saved without being stored behind the
  // step, so the version still pinned the old text (or none). It is stored and pinned now, as the
  // workflow builder's save does.
  it("stores AI written in a step it changes, and pins that version in the draft", async () => {
    const workflow = v5Workflow([
      {
        id: "s_check",
        kind: "do",
        name: "Check the receipt",
        doneBy: "ai",
        input: {},
        ai: { text: "Say whether the receipt is complete." },
        output: [{ name: "complete", type: "yes_no", required: true }],
      },
    ]);
    const bundle = testBundle("MCP receipt checker");
    bundle.workflows = [
      {
        ...(bundle.workflows[0] as (typeof bundle.workflows)[number]),
        slug: "check",
        name: "Check",
        workflow,
      },
    ];
    const made = await asDev(OPERATOR, "POST", "/api/ops/templates", {
      slug: "mcp-receipt-checker",
      bundle,
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const id = j(made.json).agent.id as string;
    const pinsOf = async (versionId: string) => {
      const [row] = await H.t.db
        .select({ bundle: agentVersion.bundle })
        .from(agentVersion)
        .where(eq(agentVersion.id, versionId));
      if (!row) throw new Error(`no version ${versionId}`);
      return (row.bundle as { definition: { skills: { skill: string }[] } }).definition.skills
        .map((s) => s.skill)
        .filter((s) => s.startsWith("custom:step-"));
    };
    const textOf = async (pin: string) => {
      const [ref, version] = pin.replace("custom:", "").split("@") as [string, string];
      const [row] = await H.t.db
        .select({ definition: skillVersion.definition })
        .from(skillVersion)
        .innerJoin(skill, eq(skill.id, skillVersion.skillId))
        .where(and(eq(skill.slug, ref), eq(skillVersion.version, Number(version))));
      return JSON.stringify(row?.definition ?? null);
    };

    let r = await ok("agent_step_update", {
      agent: id,
      step: "s_check",
      set: { "ai.text": "Say whether the receipt has a date and a total." },
    });
    const first = await pinsOf(r.data().version.id);
    expect(first).toHaveLength(1);
    expect(await textOf(first[0] as string)).toContain("has a date and a total");

    r = await ok("agent_step_update", {
      agent: id,
      step: "s_check",
      set: { "ai.text": "Say whether the receipt has a merchant." },
    });
    const second = await pinsOf(r.data().version.id);
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
    expect(await textOf(second[0] as string)).toContain("has a merchant");
  });

  it("refuses a token for an older draft, and a draft from the back office that turns approval off", async () => {
    await ok("agent_step_update", {
      agent: clientAgent,
      step: "update",
      set: { "input.amount": "15.00" },
    });
    let r = await ok("agent_publish", { agent: clientAgent });
    const stale = token(r.text);
    await ok("agent_step_update", {
      agent: clientAgent,
      step: "update",
      set: { "input.amount": "16.00" },
    });
    r = await tool("agent_publish", { agent: clientAgent, confirm_token: stale });
    expect(r.text).toContain("confirm_mismatch");

    const bundle = testBundle();
    const step = bundle.workflows[0]?.workflow.steps[0] as unknown as {
      checks: { approval: { required: string } };
    };
    step.checks.approval.required = "not_required";
    const loose = await asDev(OPERATOR, "POST", `/api/ops/agents/${clientAgent}/versions`, {
      bundle,
    });
    expect(loose.status, JSON.stringify(loose.json)).toBe(200);
    r = await tool("agent_publish", { agent: clientAgent });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("back_office_only");
    expect(r.text).toContain('turns approval off on \\"Update the record\\"'.replace(/\\"/g, '"'));
  });
});
