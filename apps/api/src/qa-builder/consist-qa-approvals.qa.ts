// Consistency QA (Agent Builder): the build's QA check "Approval on for every write" vs core's
// own list of loosenings (invariant 8). The validator, the guards and the executor count a
// conversation's messages sent without a person's yes as loosening (`conversationLoosenings`);
// the QA check (apps/api/src/build/store.ts `loosenedApprovals`) reads only `checks.approval`.
// Fails while they disagree (findings-consist.md, CONS-3). Local Postgres; no model.
import { type BuildDetail, processes } from "@countersign/core";
import { build } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "../api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

const talk = {
  id: "talk",
  kind: "conversation",
  name: "Ask the vendor for the missing W-9",
  with: "{{trigger.contactId}}",
  channel: "whatsapp",
  goal: "Get the vendor's W-9 form.",
  find: { received: "text" },
  // Every message goes without a person's yes: the first one and the later ones.
  messages: { first: "not_required", later: "within_goal" },
  deadline: { after: "3 days" },
};

const bundle = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Vendor onboarding", role: "onboards vendors", mission: "Vendors set up." },
    kind: "functional",
    model: { id: "claude-opus-5-5", maxTokens: 1024 },
    instructions: "Only do what the process says.",
    skills: [],
    extraTools: [],
    canCommand: [],
    permissions: { mode: "act" },
    budgets: { maxSteps: 4, maxCostUsd: "0.10" },
    memory: { enabled: false },
  },
  workflows: [
    {
      slug: "main",
      name: "Main",
      workflow: {
        schemaVersion: 4,
        triggers: [{ id: "trg", on: { type: "manual", input: { contactId: "string" } } }],
        steps: [talk],
      },
    },
  ],
};

describe.skipIf(!h)("CONS-3: QA's approvals check vs core's loosenings", () => {
  const H = h as NonNullable<typeof h>;

  it("a draft whose conversation messages go without a person's yes fails 'Approval on for every write'", async () => {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "vendor-onboarding",
      bundle,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const agentId = (created.json as { agent: { id: string } }).agent.id;

    const started = await H.call(OPERATOR, "POST", "/api/ops/builds", {
      kind: "agent",
      title: "Vendor onboarding",
      clientId: H.A.tenantId,
    });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    const buildId = (started.json as BuildDetail).build.id;
    // The build at QA with this draft (as a build that went through its phases would be).
    await H.t.db.update(build).set({ phase: "qa", agentId }).where(eq(build.id, buildId));

    const res = await H.call(OPERATOR, "GET", `/api/ops/builds/${buildId}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const detail = res.json as BuildDetail;

    // Core says the step loosens twice (invariant 8: each message is a write to a contact).
    const loose = processes.conversationLoosenings(
      talk as Parameters<typeof processes.conversationLoosenings>[0],
    );
    expect(loose).toHaveLength(2);

    const approvals = detail.qaChecks.find((c) => c.id === "approvals");
    expect(approvals, JSON.stringify(detail.qaChecks)).toBeDefined();
    expect(
      { state: approvals?.state, detail: approvals?.detail },
      "QA says every write asks a person first",
    ).toEqual({ state: "fail", detail: `${loose.length} approvals loosened.` });
  });
});
