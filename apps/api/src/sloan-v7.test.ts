// Overnight S2.4 (owner, D1): Sloan's v7 answers on Claude Sonnet 5.5, its $0.30 cap unchanged.
// It reaches a client's Sloan only through the reviewed update merge: installing v7 changes no
// client agent; the merge into a Sloan forked from v6 has no conflict and changes only the answer
// step's model, as the client's own draft.

import { agentVersion } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("Sloan's v7", () => {
  const H = h as ApiHarness;

  it("reaches a client's Sloan only by the reviewed update merge", async () => {
    const install = (version: number) =>
      H.call(OPERATOR, "POST", "/api/ops/platform-templates/supervisor/install", { version });
    expect((await install(6)).status).toBe(200);
    const fork = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/supervisor`, {});
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    const sloanId = j(fork.json).supervisor.id as string;
    const before = await H.t.db
      .select({ id: agentVersion.id })
      .from(agentVersion)
      .where(eq(agentVersion.agentId, sloanId));

    const v7 = await install(7);
    expect(v7.status, JSON.stringify(v7.json)).toBe(200);
    // The template's own version numbers run on from what it holds; the seed's v7 is its newest.
    expect(j(v7.json)).toMatchObject({ version: { status: "live" }, installed: true });
    // Installing changes no client agent.
    const still = await H.t.db
      .select({ id: agentVersion.id })
      .from(agentVersion)
      .where(eq(agentVersion.agentId, sloanId));
    expect(still).toEqual(before);

    const preview = await H.call(OPERATOR, "GET", `/api/ops/agents/${sloanId}/update-preview`);
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
    expect(j(preview.json).conflicts ?? []).toEqual([]);
    const merged = await H.call(OPERATOR, "POST", `/api/ops/agents/${sloanId}/update`, {
      resolutions: [],
      changeNote: "Sloan answers on Claude Sonnet 5.5",
    });
    expect(merged.status, JSON.stringify(merged.json)).toBe(200);
    const [draft] = await H.t.db
      .select({ bundle: agentVersion.bundle, status: agentVersion.status })
      .from(agentVersion)
      .where(eq(agentVersion.id, j(merged.json).version.id));
    expect(draft?.status).toBe("draft");
    const bundle = draft?.bundle as unknown as {
      definition: { budgets: unknown };
      workflows: { slug: string; workflow: { steps: { id: string; model?: unknown }[] } }[];
    };
    expect(bundle.definition.budgets).toEqual({ maxSteps: 8, maxCostUsd: "0.30" });
    const chat = bundle.workflows.find((w) => w.slug === "chat");
    expect(chat?.workflow.steps).toMatchObject([
      { id: "answer", model: { id: "claude-sonnet-5-5", maxTokens: 2048 } },
    ]);
  });
});
