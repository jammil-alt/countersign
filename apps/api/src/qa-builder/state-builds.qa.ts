// QA (state and persistence) on builds (docs/plan.md §1.108): double submits, moves racing each
// other, work in flight when the build is stopped, going back and forward again, and the build's
// draft discarded under it. Each test asserts what should happen, so it fails while the defect is
// there. Scripted model answers only (FakeModel), never a live model.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import type { BuildDetail } from "@countersign/core";
import { agent, build, buildEvent, buildMessage } from "@countersign/db";
import { FakeModel, type LlmRequest, type LlmTransport } from "@countersign/llm";
import { and, asc, eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "../api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

/**
 * A scripted model whose next call can be held until the test lets it answer, so a test can act
 * while the Builder is "thinking". A fresh script per test.
 */
class HeldModel implements LlmTransport {
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

const model = new HeldModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

const turnAnswer = (input: Record<string, unknown>) => ({
  toolUse: { name: "submit_build_turn", input: { chips: [], items: [], ...input } },
});
const reviewed = () => ({ toolUse: { name: "submit_review", input: { concerns: [] } } });

const BRIEF = {
  goal: { text: "Keep records right", state: "confirmed" },
  trigger: { text: "Someone asks", state: "confirmed" },
  dataIn: { text: "The record", state: "confirmed" },
  dataOut: { text: "The corrected record", state: "confirmed" },
};
const ROW = { id: "update", need: "Update the record", verdict: "native", how: "Testkit update" };

function draftAnswer(slug: string) {
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
  };
}

describe.skipIf(!h)("builds: state and persistence", () => {
  const H = h as NonNullable<typeof h>;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await H.call(OPERATOR, method, path, body);
    return { status: res.status, json: res.json as BuildDetail };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await call(method, path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  };

  beforeEach(() => {
    model.inner = new FakeModel();
  });

  /** A template build in the fit-gap, its gate to the draft passing. */
  async function inFitgap(title: string): Promise<string> {
    const b = await ok("POST", "/api/ops/builds", { kind: "agent", title });
    const id = b.build.id;
    model.inner.push(turnAnswer({ text: "Got it.", brief: BRIEF }));
    await ok("POST", `/api/ops/builds/${id}/turns`, { text: "An agent that fixes records." });
    model.inner.push(reviewed());
    model.inner.push(
      turnAnswer({ text: "We do it as is.", fitgap: { rows: [ROW], needsTrue: [] } }),
    );
    const f = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" });
    expect(f.build.phase).toBe("fitgap");
    expect(f.gate.reasons).toEqual([]);
    return id;
  }

  /** The same build moved on into its draft. */
  async function inDraft(title: string, slug: string): Promise<BuildDetail> {
    const id = await inFitgap(title);
    model.inner.push(draftAnswer(slug));
    const d = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    expect(d.build.phase).toBe("draft");
    expect(d.build.agentId).toBeTruthy();
    return d;
  }

  it("STATE-1: a double-submitted move into the draft makes one draft agent", async () => {
    const id = await inFitgap("Double move");
    model.inner.push(draftAnswer("double-move"), draftAnswer("double-move"));
    // The first press is drafting (its model call in flight) when the second one lands: the
    // second tab, or a double click on a slow model.
    const held = model.holdNext();
    const first = call("POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    await held.entered;
    const b = await call("POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    held.release();
    const a = await first;
    const drafted = await H.t.db
      .select({ id: agent.id, slug: agent.slug })
      .from(agent)
      .where(like(agent.slug, "double-move%"));
    const moves = await H.t.db
      .select({ from: buildEvent.fromPhase, to: buildEvent.toPhase })
      .from(buildEvent)
      .where(and(eq(buildEvent.buildId, id), eq(buildEvent.kind, "phase")))
      .orderBy(asc(buildEvent.createdAt));
    // One of the two presses moves the build; the other is refused (already in the draft).
    expect({
      statuses: [a.status, b.status].sort(),
      draftAgents: drafted.length,
      movesIntoDraft: moves.filter((m) => m.to === "draft"),
    }).toEqual({
      statuses: [200, 409],
      draftAgents: 1,
      movesIntoDraft: [{ from: "fitgap", to: "draft" }],
    });
  });

  it("STATE-2: a Builder turn that answers after the build was stopped changes nothing", async () => {
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

  it("STATE-2b: a move into the draft that finishes after the build was stopped leaves it stopped where it was", async () => {
    const id = await inFitgap("Stopped while drafting");
    const held = model.holdNext();
    model.inner.push(draftAnswer("stopped-while-drafting"));
    const pending = call("POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    await held.entered;
    const stopped = await call("POST", `/api/ops/builds/${id}/stop`, { reason: "Client left us" });
    expect(stopped.status).toBe(200);
    held.release();
    const moved = await pending;
    const [row] = await H.t.db.select().from(build).where(eq(build.id, id));
    expect(row?.status).toBe("stopped");
    // The move lost the race to the stop: refused, the stopped build still in its fit-gap.
    expect({ status: moved.status, phase: row?.phase, agentId: row?.agentId ?? null }).toEqual({
      status: 409,
      phase: "fitgap",
      agentId: null,
    });
  });

  it("STATE-3: agreeing the same proposal twice (two tabs, double click) starts one skill build", async () => {
    const id = await inFitgap("Double agree");
    model.inner.push(
      turnAnswer({
        text: "The volume tiers can be a skill over existing tools.",
        proposal: {
          summary: "Draft the volume tiers skill",
          action: {
            do: "draft_skill",
            title: "Volume tiers QA double agree",
            goal: "Work out the price tier for a quantity",
            dataIn: "A quantity",
            dataOut: "The tier",
          },
        },
      }),
    );
    const t = await ok("POST", `/api/ops/builds/${id}/turns`, {
      text: "Can the tiers be a skill?",
    });
    const msg = t.messages.at(-1);
    expect(msg?.proposal).toMatchObject({ state: "proposed", action: { do: "draft_skill" } });
    const path = `/api/ops/builds/${id}/messages/${msg?.id}/proposal`;
    const [a, b] = await Promise.all([
      call("POST", path, { decide: "agree" }),
      call("POST", path, { decide: "agree" }),
    ]);
    const skillBuilds = await H.t.db
      .select({ id: build.id })
      .from(build)
      .where(eq(build.title, "Volume tiers QA double agree"));
    expect({ statuses: [a.status, b.status].sort(), skillBuilds: skillBuilds.length }).toEqual({
      statuses: [200, 409],
      skillBuilds: 1,
    });
  });

  it("STATE-4: going back to the fit-gap, changing it and moving on again doesn't keep the old draft silently", async () => {
    const d = await inDraft("Back and forth", "back-and-forth");
    const id = d.build.id;
    await ok("POST", `/api/ops/builds/${id}/phase`, {
      to: "fitgap",
      reason: "The client wants a weekly summary too",
    });
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
    const f = await ok("POST", `/api/ops/builds/${id}/turns`, {
      text: "Also email the client a weekly summary.",
    });
    expect(f.build.fitgap.rows.map((r) => r.need)).toContain("Email a weekly summary");
    const sentBefore = model.inner.requests.length;
    // Whatever a fix asks the drafter for, it gets an answer.
    model.inner.push(draftAnswer("back-and-forth"), draftAnswer("back-and-forth"));
    const again = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    expect(again.build.phase).toBe("draft");
    // Either the draft is made again from the changed fit-gap, or the build says the draft
    // predates it (an item or the Builder's words naming the new need).
    const redrafted = model.inner.requests
      .slice(sentBefore)
      .some((r) => JSON.stringify(r.messages).includes("Email a weekly summary"));
    const lastWords = again.messages.at(-1)?.text ?? "";
    const flagged =
      again.items.some((i) => i.title.includes("weekly summary") && i.state === "open") ||
      lastWords.includes("weekly summary");
    expect(
      redrafted || flagged,
      `neither redrafted nor flagged stale; the Builder said: ${lastWords}`,
    ).toBe(true);
  });

  it("STATE-5: discarding the build's draft agent holds the build's draft gate", async () => {
    const d = await inDraft("Discarded under it", "discarded-under-it");
    const agentId = d.build.agentId as string;
    expect(d.gate.reasons).toEqual([]);
    const discarded = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/discard`, {});
    expect(discarded.status, JSON.stringify(discarded.json)).toBe(200);
    const after = await ok("GET", `/api/ops/builds/${d.build.id}`);
    // The build's draft is gone from the back office: it can't pass the draft gate to the POC.
    expect(
      after.gate.reasons.length,
      "draft gate reasons with the draft discarded",
    ).toBeGreaterThan(0);
  });

  it("STATE-6: a stopped build's open items don't change", async () => {
    const b = await ok("POST", "/api/ops/builds", { kind: "agent", title: "Stopped items" });
    const id = b.build.id;
    const added = await ok("POST", `/api/ops/builds/${id}/items`, {
      title: "Ask the client for the W-9",
    });
    const item = added.items[0];
    expect(item?.state).toBe("open");
    await ok("POST", `/api/ops/builds/${id}/stop`, { reason: "Client left us" });
    const changed = await call("PATCH", `/api/ops/builds/${id}/items/${item?.id}`, {
      state: "done",
    });
    expect(changed.status, "changing an item of a stopped build").toBe(409);
  });
});
