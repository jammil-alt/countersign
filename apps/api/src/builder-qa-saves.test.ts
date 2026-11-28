// Saving a draft from two places: two Builder conversations on the same agent (an older one still
// open, or the build's own draft edit), and two editor tabs. A save made from an older version
// never quietly drops the change saved in between (docs/plan.md §1.153: "so another change is
// never lost"). From the Builder QA (BUILDER_QA.md, PR #441): STATE-7. Scripted model answers only.
import type { AgentBundle } from "@countersign/core";
import { agentVersion } from "@countersign/db";
import { FakeModel, type LlmRequest } from "@countersign/llm";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR, testBundle } from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const holder = { model: new FakeModel() };
const h = await createApiHarness({
  llm: { create: (req) => holder.model.create(req) },
});
afterAll(() => h?.close());

type Json = Record<string, unknown>;
type Draft = {
  definition: Json;
  workflows: { workflow: { steps: Json[] } }[];
};

/** The aliased draft the model was shown. */
function shown(req: LlmRequest): Draft {
  const content = req.messages[0]?.content as string;
  const start = content.indexOf("<current_bundle>") + "<current_bundle>".length;
  return JSON.parse(content.slice(start, content.indexOf("</current_bundle>"))) as Draft;
}

/** A model turn that edits the draft it was shown. */
function edits(text: string, fn: (b: Draft) => void) {
  return (req: LlmRequest) => {
    const b = structuredClone(shown(req));
    fn(b);
    // The draft is a v3 test bundle read as v4 processes: the turn answers v4.
    return { toolUse: { name: "submit_turn", input: { text, bundle: b } } };
  };
}

describe.skipIf(!h)("saving a draft from two places", () => {
  const H = h as NonNullable<typeof h>;
  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await H.call(OPERATOR, method, path, body);
    if (res.status !== 200)
      throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.json)}`);
    return res.json as Json;
  };

  beforeEach(() => {
    holder.model = new FakeModel();
  });

  async function newAgent(slug: string): Promise<{ agentId: string; v1: string }> {
    const created = await ok("POST", `/api/ops/clients/${H.B.tenantId}/agents`, {
      slug,
      bundle: testBundle("Clerk"),
    });
    return {
      agentId: (created.agent as Json).id as string,
      v1: (created.version as Json).id as string,
    };
  }

  async function latestOf(agentId: string) {
    const [v] = await H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.agentId, agentId))
      .orderBy(desc(agentVersion.version))
      .limit(1);
    return v as NonNullable<typeof v>;
  }

  // STATE-7a
  it("doesn't let an older Builder conversation's save drop the change another one saved", async () => {
    const { agentId } = await newAgent("two-conversations");
    // Two conversations on the same draft: one opened earlier and left open, one newer (as the
    // build's draft edit opens one from the latest version).
    const older = await ok("POST", "/api/ops/builder/sessions", { kind: "agent", agentId });
    const newer = await ok("POST", "/api/ops/builder/sessions", { kind: "agent", agentId });
    const olderId = (older.session as Json).id as string;
    const newerId = (newer.session as Json).id as string;

    // The newer one renames the write step and saves it.
    holder.model.push(
      edits("Renamed it.", (b) => {
        (b.workflows[0]?.workflow.steps[0] as Json).name = "Correct the record";
      }),
    );
    await ok("POST", `/api/ops/builder/sessions/${newerId}/turns`, {
      text: "Call the first step 'Correct the record'.",
    });
    await ok("POST", `/api/ops/builder/sessions/${newerId}/save`, {});
    const renamed = await latestOf(agentId);
    expect(JSON.stringify(renamed.bundle)).toContain("Correct the record");

    // The older one changes the instructions and saves.
    holder.model.push(
      edits("Updated the instructions.", (b) => {
        b.definition.instructions = "Change records only when the client asks in writing.";
      }),
    );
    await ok("POST", `/api/ops/builder/sessions/${olderId}/turns`, {
      text: "Only change records when asked in writing.",
    });
    const res = await H.call(OPERATOR, "POST", `/api/ops/builder/sessions/${olderId}/save`, {});
    const latest = await latestOf(agentId);
    const text = JSON.stringify(latest.bundle);
    // Refused as out of date, or saved with both changes: never the rename silently gone.
    expect(
      {
        status: res.status,
        latestHasRename: text.includes("Correct the record"),
        latestParentIsRenamed: latest.parentVersionId === renamed.id,
      },
      "the older conversation's save",
    ).toSatisfy(
      (r: { status: number; latestHasRename: boolean }) => r.status === 409 || r.latestHasRename,
    );
  });

  // STATE-7b
  it("doesn't let a version saved from an older parent (a second editor tab) drop the newer one", async () => {
    const { agentId, v1 } = await newAgent("two-tabs");
    const base = (await latestOf(agentId)).bundle as AgentBundle;
    // Tab A: the instructions.
    const a = structuredClone(base) as unknown as Draft;
    a.definition.instructions = "Tab A's instructions.";
    await ok("POST", `/api/ops/agents/${agentId}/versions`, {
      bundle: a,
      parentVersionId: v1,
      changeNote: "Tab A",
    });
    // Tab B, opened on the same v1: the mission.
    const b = structuredClone(base) as unknown as Draft & {
      definition: { identity: { mission: string } };
    };
    b.definition.identity.mission = "Tab B's mission.";
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/versions`, {
      bundle: b,
      parentVersionId: v1,
      changeNote: "Tab B",
    });
    const latest = await latestOf(agentId);
    const text = JSON.stringify(latest.bundle);
    expect(
      { status: res.status, latestHasTabA: text.includes("Tab A's instructions.") },
      "tab B's save from v1 after tab A saved v2",
    ).toSatisfy(
      (r: { status: number; latestHasTabA: boolean }) => r.status === 409 || r.latestHasTabA,
    );
  });
});
