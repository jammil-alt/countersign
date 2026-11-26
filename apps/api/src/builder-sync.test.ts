// A Builder conversation that carries on after the operator edits the draft outside the chat
// (feedback, 2026-11-26: "the Builder does not keep the history of the conversation"): the step
// builder saves the chart and syncs the same conversation to that version, so the next turn reads
// every earlier turn. Scripted model answers only.
import { agentVersion } from "@countersign/db";
import { FakeModel, type LlmRequest } from "@countersign/llm";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR, testBundle } from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const holder = { model: new FakeModel() };
const asked: LlmRequest[] = [];
const h = await createApiHarness({
  llm: {
    create: (req) => {
      asked.push(req);
      return holder.model.create(req);
    },
  },
});
afterAll(() => h?.close());

type Json = Record<string, unknown>;

/** A model turn that answers and leaves the draft it was shown as it is. */
function says(text: string) {
  return (req: LlmRequest) => {
    const content = req.messages[0]?.content as string;
    const start = content.indexOf("<current_bundle>") + "<current_bundle>".length;
    const bundle = JSON.parse(content.slice(start, content.indexOf("</current_bundle>")));
    return { toolUse: { name: "submit_turn", input: { text, bundle } } };
  };
}

describe.skipIf(!h)("syncing a Builder conversation to a saved version", () => {
  const H = h as NonNullable<typeof h>;
  const call = (method: string, path: string, body?: unknown) =>
    H.call(OPERATOR, method, path, body);
  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await call(method, path, body);
    if (res.status !== 200)
      throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.json)}`);
    return res.json as Json;
  };

  beforeEach(() => {
    holder.model = new FakeModel();
    asked.length = 0;
  });

  it("keeps the turns, takes the version as its draft, and the next turn reads them all", async () => {
    const created = await ok("POST", `/api/ops/clients/${H.B.tenantId}/agents`, {
      slug: "sync-clerk",
      bundle: testBundle("Clerk"),
    });
    const agentId = (created.agent as Json).id as string;
    const started = await ok("POST", "/api/ops/builder/sessions", { kind: "agent", agentId });
    const id = (started.session as Json).id as string;

    holder.model.push(says("It reads each invoice first."));
    await ok("POST", `/api/ops/builder/sessions/${id}/turns`, { text: "What does it do first?" });

    // The operator edits the draft outside the chat and saves it as v2.
    const [v1] = await H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.agentId, agentId))
      .orderBy(desc(agentVersion.version))
      .limit(1);
    const bundle = structuredClone(v1?.bundle) as { definition: Json };
    bundle.definition.instructions = "Only invoices from known vendors.";
    const saved = await ok("POST", `/api/ops/agents/${agentId}/versions`, {
      bundle,
      parentVersionId: v1?.id,
      changeNote: "Edited by hand",
    });
    const v2 = (saved.version as Json).id as string;

    const synced = await ok("POST", `/api/ops/builder/sessions/${id}/sync`, { fromVersionId: v2 });
    const turns = synced.turns as { role: string; text: string }[];
    expect(turns.map((t) => t.text)).toContain("What does it do first?");
    expect(turns.at(-1)?.text).toMatch(/^You changed the draft yourself \(saved as v2\)/);
    expect(JSON.stringify((synced.session as Json).bundle)).toContain(
      "Only invoices from known vendors.",
    );

    // The next turn's model call has the earlier turns as its history.
    holder.model.push(says("Noted."));
    await ok("POST", `/api/ops/builder/sessions/${id}/turns`, { text: "And then?" });
    expect(JSON.stringify(asked.at(-1)?.messages)).toContain("What does it do first?");

    // Past conversations: each one's first message, its length, and whether it is yours.
    const list = await ok("GET", `/api/ops/builder/sessions?agent=${agentId}`);
    const mine = (list.sessions as Json[]).find((x) => x.id === id) as Json;
    expect(mine).toMatchObject({ title: "What does it do first?", mine: true });
    expect(mine.turns).toBe(5);

    // Another agent's version can't be synced in.
    const other = await ok("POST", `/api/ops/clients/${H.B.tenantId}/agents`, {
      slug: "sync-other",
      bundle: testBundle("Other"),
    });
    const res = await call("POST", `/api/ops/builder/sessions/${id}/sync`, {
      fromVersionId: (other.version as Json).id,
    });
    expect(res.status).toBe(404);
  });
});
