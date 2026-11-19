// QA (flow and usability lens, 2026-11-19): the build page lets "Agree the direction and draft
// it" be pressed again while the first move still runs (FLOW-2). What the API does with the two.
// Asserts the expected behaviour; fails while the defect is there.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import type { BuildDetail } from "@countersign/core";
import { agent } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { like } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "../api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

const turnAnswer = (input: Record<string, unknown>) => ({
  toolUse: { name: "submit_build_turn", input: { chips: [], items: [], ...input } },
});
const reviewed = () => ({ toolUse: { name: "submit_review", input: { concerns: [] } } });
const draftAnswer = () => ({
  toolUse: {
    name: "submit_draft",
    input: {
      summary: "It updates the record and asks the client first.",
      gaps: [],
      slug: "qa-double-move",
      startFromTemplate: null,
      bundle: {
        schemaVersion: 1,
        definition: {
          schemaVersion: 2,
          identity: { name: "QA double move", role: "Records", mission: "Keep records right" },
          kind: "functional",
          model: { id: "claude-sonnet-5-5" },
          instructions: "Update records when asked.",
          skills: [],
          permissions: { mode: "suggest_only" },
        },
        workflows: [
          {
            slug: "main",
            name: "Review a record",
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
});

describe.skipIf(!h)("QA flow: a move pressed twice", () => {
  const H = h as NonNullable<typeof h>;
  const call = (method: string, path: string, body?: unknown) =>
    H.call(OPERATOR, method, path, body).then((r) => ({
      status: r.status,
      json: r.json as BuildDetail,
    }));

  it("FLOW-2b makes one draft agent when the fit-gap is agreed twice at once", async () => {
    let b = (await call("POST", "/api/ops/builds", { kind: "agent", title: "QA double move" }))
      .json;
    const id = b.build.id;
    model.push(
      turnAnswer({
        text: "Got it.",
        brief: {
          goal: { text: "Keep records right", state: "confirmed" },
          trigger: { text: "Someone asks", state: "confirmed" },
          dataIn: { text: "The record", state: "confirmed" },
          dataOut: { text: "The corrected record", state: "confirmed" },
        },
      }),
    );
    await call("POST", `/api/ops/builds/${id}/turns`, { text: "Fix records." });
    model.push(reviewed());
    model.push(
      turnAnswer({
        text: "One we do as is.",
        fitgap: {
          rows: [{ id: "update", need: "Update the record", verdict: "native", how: "x" }],
        },
      }),
    );
    b = (await call("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" })).json;
    expect(b.build.phase).toBe("fitgap");
    const phaseEventsBefore = b.events.filter((e) => e.kind === "phase").length;

    // The operator presses Agree, sends a message while it runs, and presses Agree again.
    model.push(draftAnswer(), draftAnswer());
    const [first, second] = await Promise.all([
      call("POST", `/api/ops/builds/${id}/phase`, { to: "draft" }),
      call("POST", `/api/ops/builds/${id}/phase`, { to: "draft" }),
    ]);
    const made = await H.t.db
      .select({ id: agent.id, slug: agent.slug })
      .from(agent)
      .where(like(agent.slug, "qa-double-move%"));
    const after = (await call("GET", `/api/ops/builds/${id}`)).json;
    const phaseEvents = after.events.filter((e) => e.kind === "phase").length - phaseEventsBefore;
    // Expected: one move goes through and the other is refused; one draft agent, one phase event for the move.
    expect({
      statuses: [first.status, second.status].sort(),
      agents: made.length,
      phaseEvents,
    }).toEqual({ statuses: [200, 409], agents: 1, phaseEvents: 1 });
  });
});
