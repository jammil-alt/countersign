// Turn on in one button (docs/builder-plan.md §12.4, docs/plan.md §1.170), through the app: a
// template turned on for a client becomes that client's live copy in its trial, bound to the
// client's connection; a client's agent goes live in its trial; a version never tried at the
// client holds it with 409; the preview changes nothing; what the client owes holds nothing.
import { templateTestCopy } from "@countersign/agents";
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import {
  type AgentBundle,
  type AgentBundleInput,
  AgentBundle as AgentBundleSchema,
  type BuildDetail,
  type TurnOnAnswer,
} from "@countersign/core";
import { agent, agentChange, agentVersion, auditEvent, build, run } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { count, desc, eq, like } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR, testBundle, user } from "./api.test-helper";
import { stepModelAnswer } from "./builder-v5.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type Json = any;

/** testBundle with a role that must be bound before it runs: the client says who. */
function withSigner(name: string): AgentBundle {
  const b = testBundle(name) as AgentBundleInput;
  return AgentBundleSchema.parse({
    ...b,
    people: [{ role: "approver", description: "Signs the changes", required: true }],
  });
}

describe.skipIf(!h)("turn on", () => {
  const H = h as NonNullable<typeof h>;
  const A = () => H.A;

  async function call(method: string, path: string, body?: unknown) {
    const res = await H.call(OPERATOR, method, path, body);
    return { status: res.status, json: res.json as Json };
  }
  async function ok(method: string, path: string, body?: unknown): Promise<Json> {
    const res = await call(method, path, body);
    expect(res.status, `${method} ${path}: ${JSON.stringify(res.json)}`).toBe(200);
    return res.json;
  }
  const agentRow = async (id: string) =>
    (await H.t.db.select().from(agent).where(eq(agent.id, id)))[0] as typeof agent.$inferSelect;

  /** A finished test run of the version, at the client: what "tried" reads. */
  async function tried(tenantId: string, agentId: string, versionId: string) {
    await H.t.db.insert(run).values({
      tenantId,
      agentId,
      agentVersionId: versionId,
      workflowSlug: "fix-record",
      mode: "test",
      status: "succeeded",
    });
  }

  /** A client agent of client A, saved and not published. */
  async function clientAgent(slug: string, bundle: AgentBundle = testBundle()) {
    const made = await ok("POST", `/api/ops/clients/${A().tenantId}/agents`, { slug, bundle });
    return { id: made.agent.id as string, versionId: made.version.id as string };
  }

  /** A template, its draft saved and not published. */
  async function template(slug: string, bundle: AgentBundle = testBundle()) {
    const made = await ok("POST", "/api/ops/templates", { slug, bundle });
    return { id: made.agent.id as string, versionId: made.version.id as string };
  }

  it("turns a template on for a client: a live copy there, bound, in its trial", async () => {
    const t = await template("turn-on-template");
    // Tried at client A as its test copy (a template never runs for a client).
    const copy = await templateTestCopy(H.t.db as never, {
      tenantId: A().tenantId,
      templateVersionId: t.versionId,
    });
    await tried(A().tenantId, copy.agent.id, copy.version.id);

    const preview = (await ok(
      "GET",
      `/api/ops/agents/${t.id}/turn-on?client=${A().tenantId}`,
    )) as TurnOnAnswer;
    expect(preview).toMatchObject({
      agentId: null,
      clientId: A().tenantId,
      clientName: "Client A",
      versionId: t.versionId,
      started: false,
      stage: "bench",
    });
    expect(preview.items.filter((i) => i.holds)).toEqual([]);
    expect(preview.items.find((i) => i.kind === "tried")).toMatchObject({ done: true });

    const on = (await ok("POST", `/api/ops/agents/${t.id}/turn-on`, {
      clientId: A().tenantId,
    })) as TurnOnAnswer;
    expect(on).toMatchObject({ started: true, stage: "trial", clientId: A().tenantId });
    expect(on.refused).toBeUndefined();
    const made = await agentRow(on.agentId as string);
    expect(made).toMatchObject({
      kind: "client",
      tenantId: A().tenantId,
      templateId: t.id,
      testCopy: false,
      stage: "trial",
      runStatus: "active",
      liveVersionId: on.versionId,
      bindings: { testkit: A().connectionId },
    });
    // The template's version is published, and the copy's is based on it.
    expect((await agentRow(t.id)).liveVersionId).toBe(t.versionId);
    const [v] = await H.t.db.select().from(agentVersion).where(eq(agentVersion.id, on.versionId));
    expect(v?.basedOnTemplateVersionId).toBe(t.versionId);
    // Approval stays on: the copy's write step still asks (invariant 8).
    expect(JSON.stringify(v?.bundle)).toContain('"required":"required"');

    // Pressed again, the same copy stays in its trial: no second fork.
    const again = (await ok("POST", `/api/ops/agents/${t.id}/turn-on`, {
      clientId: A().tenantId,
    })) as TurnOnAnswer;
    expect(again.agentId).toBe(on.agentId);
    expect(again.started).toBe(true);
    const [{ n } = { n: 0 }] = await H.t.db
      .select({ n: count() })
      .from(agent)
      .where(like(agent.slug, "turn-on-template%"));
    // The template, its test copy and one client copy.
    expect(n).toBe(3);

    // Audited as the route.
    const audited = await H.t.db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(eq(auditEvent.action, "POST /api/ops/agents/:id/turn-on"));
    expect(audited.length).toBeGreaterThan(0);
  });

  it("turns a client's agent on: published, bound and in its trial", async () => {
    const a = await clientAgent("turn-on-client");
    await tried(A().tenantId, a.id, a.versionId);
    const on = (await ok("POST", `/api/ops/agents/${a.id}/turn-on`, {})) as TurnOnAnswer;
    expect(on).toMatchObject({
      agentId: a.id,
      versionId: a.versionId,
      started: true,
      stage: "trial",
    });
    expect(await agentRow(a.id)).toMatchObject({
      liveVersionId: a.versionId,
      stage: "trial",
      runStatus: "active",
      bindings: { testkit: A().connectionId },
    });
    expect(on.items.find((i) => i.key === "connect:testkit")).toMatchObject({
      owner: "client",
      holds: false,
      done: true,
    });
  });

  it("holds with 409 when the version was never tried, and changes nothing", async () => {
    const a = await clientAgent("turn-on-untried");
    const res = await call("POST", `/api/ops/agents/${a.id}/turn-on`, {});
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("turn_on_held");
    const held = res.json.error.details as TurnOnAnswer;
    expect(held.started).toBe(false);
    expect(held.items.find((i) => i.kind === "tried")).toMatchObject({
      key: "tried",
      owner: "operator",
      holds: true,
      title: "Not tried yet",
    });
    expect(await agentRow(a.id)).toMatchObject({ liveVersionId: null, bindings: {} });

    // A template needs its client, and a client's agent runs at its own client only.
    const t = await template("turn-on-no-client");
    const none = await call("GET", `/api/ops/agents/${t.id}/turn-on`);
    expect(none.status).toBe(422);
    expect(none.json.error.code).toBe("client_required");
    const other = await call("POST", `/api/ops/agents/${a.id}/turn-on`, {
      clientId: H.B.tenantId,
    });
    expect(other.status).toBe(422);
    // Only the operator reaches it.
    const portal = await H.call(user("a"), "GET", `/api/ops/agents/${a.id}/turn-on`);
    expect(portal.status).toBe(403);
  });

  it("previews without changing anything", async () => {
    const t = await template("turn-on-preview");
    const counts = async () => ({
      agents: (await H.t.db.select({ n: count() }).from(agent))[0]?.n,
      versions: (await H.t.db.select({ n: count() }).from(agentVersion))[0]?.n,
      changes: (await H.t.db.select({ n: count() }).from(agentChange))[0]?.n,
      live: (await agentRow(t.id)).liveVersionId,
    });
    const before = await counts();
    const preview = (await ok(
      "GET",
      `/api/ops/agents/${t.id}/turn-on?client=${H.B.tenantId}`,
    )) as TurnOnAnswer;
    expect(await counts()).toEqual(before);
    expect(preview).toMatchObject({ agentId: null, clientId: H.B.tenantId, started: false });
    // Never tried at B: it holds; the connection B has is shown as done.
    expect(preview.items.filter((i) => i.holds).map((i) => i.kind)).toEqual(["tried"]);
    expect(preview.items.find((i) => i.kind === "connect")).toMatchObject({ done: true });
  });

  it("lists what the client owes without holding the button", async () => {
    const a = await clientAgent("turn-on-signer", withSigner("Signed clerk"));
    await tried(A().tenantId, a.id, a.versionId);
    const preview = (await ok("GET", `/api/ops/agents/${a.id}/turn-on`)) as TurnOnAnswer;
    const who = preview.items.find((i) => i.kind === "who");
    expect(who).toMatchObject({
      key: "who:approver",
      owner: "client",
      holds: false,
      waits: true,
      detail: "Signs the changes",
    });
    expect(preview.items.filter((i) => i.holds)).toEqual([]);

    // Pressed, everything else is done; the trial waits on who signs, and says so.
    const on = (await ok("POST", `/api/ops/agents/${a.id}/turn-on`, {})) as TurnOnAnswer;
    expect(on.started).toBe(false);
    expect(on.stage).toBe("bench");
    expect(on.refused?.join(" ")).toContain("approver");
    expect(await agentRow(a.id)).toMatchObject({
      liveVersionId: a.versionId,
      bindings: { testkit: A().connectionId },
    });
  });

  it("moves the agent's open build to its client test, as the client-test move does", async () => {
    const started = await ok("POST", "/api/ops/builds", {
      kind: "agent",
      title: "Turned on from a build",
      clientId: A().tenantId,
    });
    const id = started.build.id as string;
    model.push(
      stepModelAnswer({
        toolUse: {
          name: "submit_draft",
          input: {
            summary: "It fixes the record's amount and asks the client first.",
            gaps: [],
            startFromTemplate: null,
            bundle: {
              schemaVersion: 1,
              definition: {
                schemaVersion: 2,
                identity: { name: "Build clerk", role: "Records", mission: "Keep records right" },
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
                    schemaVersion: 4,
                    triggers: [{ id: "t", on: { type: "manual", input: {} } }],
                    steps: [
                      {
                        id: "update",
                        kind: "write",
                        name: "Update the record",
                        tool: TESTKIT_UPDATE_TOOL,
                        input: { id: "r1", amount: "12.00" },
                        checks: { approval: { required: "required" } },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      }),
    );
    const drafted = (await ok("POST", `/api/ops/builds/${id}/draft-now`, {
      description: "Fix the amount on the record when asked. The client approves each change.",
    })) as BuildDetail;
    const agentId = drafted.build.agentId as string;
    const [latest] = await H.t.db
      .select({ id: agentVersion.id })
      .from(agentVersion)
      .where(eq(agentVersion.agentId, agentId))
      .orderBy(desc(agentVersion.version))
      .limit(1);
    await tried(A().tenantId, agentId, latest?.id as string);

    const on = (await ok("POST", `/api/ops/agents/${agentId}/turn-on`, {})) as TurnOnAnswer;
    expect(on.started).toBe(true);
    const [b] = await H.t.db.select().from(build).where(eq(build.id, id));
    expect(b).toMatchObject({
      phase: "client_test",
      testClientId: A().tenantId,
      testAgentId: agentId,
    });
    const detail = (await ok("GET", `/api/ops/builds/${id}`)) as BuildDetail;
    expect(detail.messages.at(-1)?.text).toContain("in its trial");
  });
});
