// Builds (docs/plan.md §1.108): what the Builder's answer (`submit_build_turn`,
// `submit_test_cases`) may change, and what the API takes from it (BUILDER_QA, PR #441: STATE-2,
// AI-2 to AI-8). Scripted model answers only (FakeModel), a fresh script per test; never a live
// model.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import type { BuildDetail } from "@countersign/core";
import { build, buildMessage, testCase } from "@countersign/db";
import { FakeModel, type FakeTurn, type LlmRequest, type LlmTransport } from "@countersign/llm";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

/**
 * A scripted model swapped for a fresh one per test, so one test's leftovers can't leak. Its next
 * call can be held until the test lets it answer, so a test can act while the Builder "thinks".
 */
class SwapModel implements LlmTransport {
  inner = new FakeModel();
  #hold: { entered: () => void; release: Promise<void> } | null = null;

  /** Holds the next call; `entered` resolves once it is waiting, `release()` lets it answer. */
  holdNext(): { entered: Promise<void>; release: () => void } {
    let release = () => {};
    let entered = () => {};
    const enteredP = new Promise<void>((r) => {
      entered = r;
    });
    const releaseP = new Promise<void>((r) => {
      release = r;
    });
    this.#hold = { entered, release: releaseP };
    return { entered: enteredP, release };
  }

  async create(request: LlmRequest) {
    const hold = this.#hold;
    if (hold) {
      this.#hold = null;
      hold.entered();
      await hold.release;
    }
    return this.inner.create(request);
  }
}

const model = new SwapModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

const turnAnswer = (input: Record<string, unknown>): FakeTurn => ({
  toolUse: { name: "submit_build_turn", input: { chips: [], items: [], ...input } },
});
const reviewed = (): FakeTurn => ({ toolUse: { name: "submit_review", input: { concerns: [] } } });

const BRIEF = {
  goal: { text: "Keep records right", state: "confirmed" },
  trigger: { text: "Someone asks", state: "confirmed" },
  dataIn: { text: "The record", state: "confirmed" },
  dataOut: { text: "The corrected record", state: "confirmed" },
};
const ROW = { id: "update", need: "Update the record", verdict: "native", how: "Testkit update" };
const ROW2 = { id: "notify", need: "Tell the owner", verdict: "native", how: "A notify step" };

function draftAnswer(slug: string): FakeTurn {
  return {
    toolUse: {
      name: "submit_draft",
      input: {
        summary: "It updates the record and asks the client first.",
        gaps: [],
        slug,
        startFromTemplate: null,
        bundle: {
          schemaVersion: 1,
          definition: {
            schemaVersion: 2,
            identity: { name: "Record review", role: "Records", mission: "Keep records right" },
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
  };
}

describe.skipIf(!h)("builds: what the Builder's answers may change", () => {
  const H = h as NonNullable<typeof h>;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await H.call(OPERATOR, method, path, body);
    return { status: res.status, json: res.json as BuildDetail & { created?: number } };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await call(method, path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  };

  beforeEach(() => {
    model.inner = new FakeModel();
  });

  async function inIntake(title: string, clientId?: string): Promise<string> {
    const b = await ok("POST", "/api/ops/builds", {
      kind: "agent",
      title,
      ...(clientId ? { clientId } : {}),
    });
    return b.build.id;
  }

  /** A build in the fit-gap with the given rows written by the Builder. */
  async function inFitgap(
    title: string,
    opts: { clientId?: string; rows?: unknown[]; needsTrue?: unknown[] } = {},
  ): Promise<string> {
    const id = await inIntake(title, opts.clientId);
    model.inner.push(turnAnswer({ text: "Got it.", brief: BRIEF }));
    await ok("POST", `/api/ops/builds/${id}/turns`, { text: "An agent that fixes records." });
    model.inner.push(reviewed());
    model.inner.push(
      turnAnswer({
        text: "We do it as is.",
        fitgap: { rows: opts.rows ?? [ROW], needsTrue: opts.needsTrue ?? [] },
      }),
    );
    const f = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" });
    expect(f.build.phase).toBe("fitgap");
    return id;
  }

  async function inDraft(title: string, slug: string): Promise<BuildDetail> {
    const id = await inFitgap(title);
    model.inner.push(draftAnswer(slug));
    const d = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    expect(d.build.phase).toBe("draft");
    expect(d.gate.reasons).toEqual([]);
    return d;
  }

  async function inPoc(title: string, slug: string): Promise<BuildDetail> {
    const d = await inDraft(title, slug);
    model.inner.push(
      turnAnswer({
        text: "Three records will do.",
        testPlan: {
          datasets: [
            {
              id: "records",
              name: "Records",
              count: 3,
              covers: "a wrong amount",
              source: "generate",
            },
          ],
        },
      }),
    );
    const p = await ok("POST", `/api/ops/builds/${d.build.id}/phase`, { to: "poc" });
    expect(p.build.phase).toBe("poc");
    return p;
  }

  // BUILDER_QA STATE-2 (the turn half).
  it("a Builder turn that answers after the build was stopped changes nothing", async () => {
    const id = await inFitgap("Stopped while thinking");
    const before = (await ok("GET", `/api/ops/builds/${id}`)).build.fitgap;
    const held = model.holdNext();
    model.inner.push(
      turnAnswer({
        text: "Added the weekly summary.",
        fitgap: {
          rows: [
            ROW,
            { id: "summary", need: "Email a weekly summary", verdict: "native", how: "Email" },
          ],
          needsTrue: [],
        },
      }),
    );
    const pending = call("POST", `/api/ops/builds/${id}/turns`, {
      text: "Also email a weekly summary.",
    });
    await held.entered;
    const stopped = await call("POST", `/api/ops/builds/${id}/stop`, { reason: "Client left us" });
    expect(stopped.status).toBe(200);
    held.release();
    await pending;
    const [row] = await H.t.db.select().from(build).where(eq(build.id, id));
    const said = await H.t.db
      .select({ role: buildMessage.role, text: buildMessage.text })
      .from(buildMessage)
      .where(eq(buildMessage.buildId, id))
      .orderBy(asc(buildMessage.createdAt), asc(buildMessage.id));
    expect(row?.status).toBe("stopped");
    // A stopped build refuses every change (I11): its record is as it was when it stopped.
    expect(row?.fitgap, "fit-gap of a stopped build").toEqual(before);
    expect(said.at(-1)?.text).not.toBe("Added the weekly summary.");
  });

  // ── I3: the model changes only its phase's record, never what the operator confirmed ──────

  // BUILDER_QA AI-2.
  it("a Builder turn doesn't overwrite a brief field the operator wrote and confirmed", async () => {
    const id = await inIntake("Operator's brief");
    const mine = { text: "Fix only invoices under $500 for vendor Acme", state: "confirmed" };
    await ok("PATCH", `/api/ops/builds/${id}`, { brief: { ...BRIEF, goal: mine } });
    // The operator answers a question about the trigger; the model rewrites the goal as well.
    model.inner.push(
      turnAnswer({
        text: "Thanks. What starts it?",
        brief: {
          trigger: { text: "Each morning", state: "confirmed" },
          goal: { text: "Fix every invoice for every vendor", state: "assumed" },
        },
      }),
    );
    const b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "It runs each morning." });
    expect(b.build.brief.trigger?.text).toBe("Each morning");
    expect(b.build.brief.goal, "the operator's confirmed goal").toEqual(mine);
  });

  // BUILDER_QA AI-3a.
  it("the Builder's fit-gap rewrite can't take a row out of scope (dropped is the operator's)", async () => {
    const id = await inFitgap("Builder drops a row", { rows: [ROW, ROW2] });
    model.inner.push(
      turnAnswer({
        text: "I took the notify row out.",
        fitgap: { rows: [ROW, { ...ROW2, dropped: true }], needsTrue: [] },
      }),
    );
    const b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Check the rows again." });
    const notify = b.build.fitgap.rows.find((r) => r.id === "notify");
    expect(notify?.dropped, "row dropped by the model, not the operator").toBe(false);
  });

  // BUILDER_QA AI-3b.
  it("a fit-gap answer without needsTrue keeps the operator's 'what needs to be true'", async () => {
    const id = await inFitgap("Needs true wiped", {
      clientId: H.A.tenantId,
      rows: [ROW, { ...ROW2, verdict: "build", how: "A new digest step" }],
      needsTrue: [{ id: "conn", text: "The client connects the testkit" }],
    });
    let b = await ok("GET", `/api/ops/builds/${id}`);
    expect(b.build.fitgap.needsTrue.map((n) => n.id)).toEqual(["conn"]);
    // The operator adds one of their own and marks the connection done.
    await ok("PATCH", `/api/ops/builds/${id}`, {
      fitgap: {
        ...b.build.fitgap,
        needsTrue: [
          { id: "conn", text: "The client connects the testkit", done: true },
          { id: "owner", text: "The owner answers within a day", done: false },
        ],
      },
    });
    // The operator challenges a verdict (less work); the Builder's answer sends the rows only
    // (needsTrue left out, so it defaults to []).
    model.inner.push(
      turnAnswer({
        text: "Tell the owner is native: the notify step does it.",
        fitgap: { rows: [ROW, ROW2] },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/verdicts`, {
      rowId: "notify",
      to: "native",
      reason: "The notify step already tells the owner, nothing to build.",
    });
    expect(b.build.fitgap.rows.find((r) => r.id === "notify")?.verdict).toBe("native");
    expect(b.build.fitgap.needsTrue.map((n) => [n.id, n.done])).toEqual([
      ["conn", true],
      ["owner", false],
    ]);
  });

  // ── I4: ids and proposals the model names must exist in the build ──────────────────────────

  // BUILDER_QA AI-4a.
  it("a proposal to approve a code request this build doesn't wait on is dropped", async () => {
    const id = await inFitgap("Approve a stranger's request");
    model.inner.push(
      turnAnswer({
        text: "I'd approve the request now.",
        proposal: {
          summary: "Approve DQ-001: add date offsets",
          action: {
            do: "approve_code_request",
            requestId: "0190a0b0-0000-7000-8000-000000000999",
            ref: "DQ-001",
          },
        },
      }),
    );
    const b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "What's next?" });
    expect(b.messages.at(-1)?.proposal ?? null, "proposal naming no request of this build").toBe(
      null,
    );
  });

  // BUILDER_QA AI-4b.
  it("a proposal to link a code request that doesn't exist is dropped", async () => {
    const id = await inFitgap("Link a made-up request");
    model.inner.push(
      turnAnswer({
        text: "There's one open for this already: I'd link it.",
        proposal: {
          summary: "Link this step to DQ-777",
          action: {
            do: "link_code_request",
            requestId: "0190a0b0-0000-7000-8000-000000000777",
            ref: "DQ-777",
          },
        },
      }),
    );
    const b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Is there a request?" });
    expect(b.messages.at(-1)?.proposal ?? null, "proposal naming a request that isn't there").toBe(
      null,
    );
  });

  // BUILDER_QA AI-4c.
  it("an edit_draft proposal naming a step the draft doesn't have is dropped", async () => {
    const d = await inDraft("Edit a made-up step", "edit-made-up-step");
    model.inner.push(
      turnAnswer({
        text: "I'd take the amount from the invoice total.",
        proposal: {
          summary: "Take the amount from the invoice total",
          action: {
            do: "edit_draft",
            request: "On “Pay the bill”, take the amount from the invoice total",
            stepId: "pay-the-bill",
          },
        },
      }),
    );
    const b = await ok("POST", `/api/ops/builds/${d.build.id}/turns`, {
      text: "Fix the amount.",
    });
    expect(b.messages.at(-1)?.proposal ?? null, "proposal on a step that isn't in the draft").toBe(
      null,
    );
  });

  // BUILDER_QA AI-5.
  it("a high-risk decision past the decisions cap isn't dropped while the turn says it was made", async () => {
    const id = await inFitgap("Sixty decisions");
    const many = (from: number) =>
      Array.from({ length: 30 }, (_, i) => ({
        id: `d${from + i}`,
        what: `Starting value number ${from + i} stays as it is`,
        kind: "assumption",
      }));
    model.inner.push(turnAnswer({ text: "Thirty decisions.", decisions: many(0) }));
    await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Go on." });
    model.inner.push(turnAnswer({ text: "Thirty more.", decisions: many(30) }));
    let b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Go on." });
    expect(b.build.fitgap.decisions).toHaveLength(60);
    const risky = {
      id: "auto-pay",
      what: "Bills under $1,000 are paid without a person looking",
      kind: "assumption",
      risk: "high",
      category: "money",
    };
    model.inner.push(turnAnswer({ text: "One more decision.", decisions: [risky] }));
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "What about small bills?" });
    const stored = b.build.fitgap.decisions.some((d) => d.id === "auto-pay");
    const claimed = (b.messages.at(-1)?.changes ?? []).some((c) => c.includes(risky.what));
    // Either it is on the record (and holds the client test until looked at), or the turn
    // doesn't tell the operator it was recorded.
    expect(
      { stored, claimed },
      "a high-risk decision the turn lists as a change but the build doesn't keep",
    ).not.toEqual({ stored: false, claimed: true });
  });

  // BUILDER_QA AI-6.
  it("generated test cases naming a step or workflow the draft doesn't have aren't saved", async () => {
    const p = await inPoc("Cases on made-up steps", "cases-made-up-steps");
    model.inner.push({
      toolUse: {
        name: "submit_test_cases",
        input: {
          cases: [
            {
              name: "Wrong amount",
              dataset: "records",
              input: { workflow: "no-such-workflow", payload: { id: "r1" } },
              expected: { "pay-the-bill": { amount: "12.00" } },
            },
          ],
        },
      },
    });
    const b = await ok("POST", `/api/ops/builds/${p.build.id}/cases`);
    const saved = await H.t.db
      .select({ name: testCase.name, input: testCase.input, expected: testCase.expected })
      .from(testCase)
      .where(eq(testCase.targetId, p.build.agentId as string));
    expect(
      { created: b.created, saved: saved.length },
      "a case that can never pass (no such workflow, no such step) kept as a test case",
    ).toEqual({ created: 0, saved: 0 });
  });

  // ── Refusals ───────────────────────────────────────────────────────────────────────────────

  // BUILDER_QA AI-7.
  it("a refused turn says the model declined, not that its answer's form couldn't be saved", async () => {
    const id = await inIntake("Refused turn");
    model.inner.push({ refusal: true });
    const b = await ok("POST", `/api/ops/builds/${id}/turns`, {
      text: "An agent that fixes records.",
    });
    const [last] = await H.t.db
      .select({ text: buildMessage.text, meta: buildMessage.meta })
      .from(buildMessage)
      .where(and(eq(buildMessage.buildId, id), eq(buildMessage.role, "builder")))
      .orderBy(asc(buildMessage.createdAt));
    expect(b.messages.at(-1)?.failed).toBe(true);
    expect((last?.meta as { failed?: string } | null)?.failed, "failure code").toBe("refusal");
    expect(last?.text).not.toMatch(/form I couldn't save/);
  });

  // ── `answered` closes questions only on the operator's words ─────────────────────────────

  // BUILDER_QA AI-8.
  it("a turn the Builder opens (no operator words) can't close open questions as answered", async () => {
    const id = await inIntake("Answered with no words");
    // Intake leaves "How many" open: confirming the brief makes it an open question.
    model.inner.push(
      turnAnswer({
        text: "Got it.",
        brief: { ...BRIEF, volume: { text: "", state: "open" } },
      }),
    );
    await ok("POST", `/api/ops/builds/${id}/turns`, { text: "An agent that fixes records." });
    model.inner.push(reviewed());
    // The Builder opens the fit-gap (no operator words) and lists every open question it sees
    // as answered.
    model.inner.push((req: LlmRequest): FakeTurn => {
      const sent = JSON.stringify(req.messages);
      const keys = [...new Set(sent.match(/item:[0-9a-f-]{36}/g) ?? [])];
      return turnAnswer({
        text: "We do it as is.",
        fitgap: { rows: [ROW], needsTrue: [] },
        answered: keys,
      });
    });
    const b = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" });
    expect(b.build.phase).toBe("fitgap");
    const question = b.items.find((i) => i.kind === "question");
    expect(question, "the open brief field's question").toBeTruthy();
    expect(question?.state, "closed as answered though the operator said nothing").toBe("open");
  });
});
