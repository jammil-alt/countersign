// TOOL lens: lineage between templates and client agents through the real API (ops-lineage.ts,
// ops-agents.ts). A promotion is the operator's merge of one client's agent into the template;
// invariant 8 says templates always start with approval on, and invariant 11 says a client's own
// settings never travel to another client.

import { type AgentBundle, cloneJson, selectableBetween } from "@countersign/core";
import { connection } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR, testBundle } from "../api.test-helper";

for (const level of ["warn", "error"] as const) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

function edit(bundle: AgentBundle, fn: (b: AgentBundle) => void): AgentBundle {
  const out = cloneJson(bundle);
  fn(out);
  return out;
}

function stepOf(bundle: AgentBundle, id: string) {
  for (const w of bundle.workflows) {
    const s = w.workflow.steps.find((x) => x.id === id);
    if (s) return s as { approval?: { required?: string } };
  }
  throw new Error(`no step ${id}`);
}

describe.skipIf(!h)("TOOL: lineage keeps approval on and forks only what is published", () => {
  const H = h as ApiHarness;
  let templateId = "";
  let t1 = "";
  let clientAgentId = "";

  async function ok(method: string, path: string, body?: unknown) {
    const res = await H.call(OPERATOR, method, path, body);
    expect(res.status, `${method} ${path}: ${JSON.stringify(res.json)}`).toBe(200);
    return j(res.json);
  }

  beforeAll(async () => {
    const created = await ok("POST", "/api/ops/templates", {
      slug: "qa-tool-lineage",
      bundle: testBundle(),
    });
    templateId = created.agent.id;
    t1 = created.version.id;
    await ok("POST", `/api/ops/agents/${templateId}/versions/${t1}/publish`);
    const forked = await ok("POST", `/api/ops/templates/${templateId}/fork`, {
      clientId: H.A.tenantId,
    });
    clientAgentId = forked.agent.id;
    await ok("PATCH", `/api/ops/agents/${clientAgentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    await ok("POST", `/api/ops/agents/${clientAgentId}/versions/${forked.version.id}/publish`);
    // The operator loosens client A's own connection (updates run without approval for A).
    await H.t.db
      .update(connection)
      .set({ permissions: { read: "auto", create: "approval", update: "auto", delete: "off" } })
      .where(eq(connection.id, H.A.connectionId));
    // Client A's operator lets this one agent act on its own, for A only: mode act and the write
    // step without approval. A renames a step too, the change the operator means to promote.
    const loosened = edit(testBundle(), (b) => {
      b.definition.permissions.mode = "act";
      const update = stepOf(b, "update");
      update.approval = { required: "not_required" };
      b.definition.instructions = "Change records only when asked, A's way.";
    });
    const saved = await ok("POST", `/api/ops/agents/${clientAgentId}/versions`, {
      bundle: loosened,
      changeNote: "A acts on its own",
    });
    await ok("POST", `/api/ops/agents/${clientAgentId}/versions/${saved.version.id}/publish`);
  });

  it("TOOL-1: a promotion never carries a client's mode act or not_required approval into the template", async () => {
    const preview = await ok("GET", `/api/ops/agents/${clientAgentId}/promote-preview`);
    const offered = selectableBetween(preview.base.bundle, preview.theirs.bundle).map((g) => g.id);
    expect(offered.length).toBeGreaterThan(0);
    const { version } = await ok("POST", `/api/ops/agents/${clientAgentId}/promote`, {
      changes: offered,
      resolutions: [],
    });
    const read = await ok("GET", `/api/ops/agents/${templateId}/versions/${version.id}`);
    const bundle = read.version.bundle as AgentBundle;
    // The client's instruction change was promoted (the promotion did happen) ...
    expect(bundle.definition.instructions).toBe("Change records only when asked, A's way.");
    // ... but the template must start with approval on (invariant 8), as every pack template
    // (docs/plan.md §1 "What a copy carries": "approval stays on").
    expect.soft(bundle.definition.permissions.mode).toBe("suggest_only");
    expect.soft(stepOf(bundle, "update").approval?.required ?? "required").toBe("required");
  });

  it("TOOL-1: copying client A's agent into client B never carries A's mode act or not_required approval", async () => {
    const copied = await ok("POST", `/api/ops/clients/${H.B.tenantId}/agents`, {
      slug: "qa-tool-lineage-copy",
      copyFrom: clientAgentId,
    });
    const read = await ok(
      "GET",
      `/api/ops/agents/${copied.agent.id}/versions/${copied.version.id}`,
    );
    const bundle = read.version.bundle as AgentBundle;
    // Client B's connection was never loosened by anyone; its copy must start with approval on.
    expect.soft(bundle.definition.permissions.mode).toBe("suggest_only");
    expect.soft(stepOf(bundle, "update").approval?.required ?? "required").toBe("required");
  });

  it("TOOL-2: forking refuses a template version that was never published (a draft)", async () => {
    const draft = await ok("POST", `/api/ops/agents/${templateId}/versions`, {
      bundle: edit(testBundle(), (b) => {
        b.definition.instructions = "An unreviewed draft of the template.";
      }),
      changeNote: "work in progress",
    });
    expect(draft.version.status).toBe("draft");
    const res = await H.call(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
      clientId: H.B.tenantId,
      slug: "qa-tool-lineage-draft",
      versionId: draft.version.id,
    });
    // Expected: 409 (only a published template version goes to a client).
    expect(res.status, JSON.stringify(res.json)).toBe(409);
  });

  it("TOOL-2: forking template X refuses a version id that belongs to another template", async () => {
    const other = await ok("POST", "/api/ops/templates", {
      slug: "qa-tool-lineage-other",
      bundle: testBundle("Other clerk"),
    });
    await ok("POST", `/api/ops/agents/${other.agent.id}/versions/${other.version.id}/publish`);
    const res = await H.call(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
      clientId: H.B.tenantId,
      slug: "qa-tool-lineage-mismatch",
      versionId: other.version.id,
    });
    // Expected: refused (4xx). Today the route checks template X and forks template Y.
    expect(res.status, JSON.stringify(res.json)).toBeGreaterThanOrEqual(400);
  });
});
