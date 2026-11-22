// The process interview (docs/plan.md §1.217), through the API: an operator starts one for a client's
// contact and gets the link; the contact opens it with no sign-in, adds a sample file, answers one
// question at a time (an estimate, an "I don't know") and finishes; the back office reads the
// current-state map and the open questions, then drafts the client's agent with a reuse check.
// The interview's model answers are the hand-written fixtures packages/agents' interviewer test
// writes (fixtures/llm, replayed); the Builder's draft is scripted, as in build-draft-now.test.ts.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import type { BuildDetail, InterviewPageView, OpsInterviewView } from "@countersign/core";
import { contact, document, processInterview } from "@countersign/db";
import { FakeModel, type LlmTransport, withRecording } from "@countersign/llm";
import { fileFixtureStore } from "@countersign/llm/node";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR, OTHER_OPERATOR } from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

// The interviewer's calls are replayed; everything else (the Builder) answers from the script.
const builder = new FakeModel();
const replayed = withRecording(null, { mode: "replay", store: fileFixtureStore() });
const INTERVIEW_TOOLS = new Set(["ask_next", "submit_process_map"]);
const transport: LlmTransport = {
  create: (request) =>
    INTERVIEW_TOOLS.has(request.tools?.[0]?.name ?? "")
      ? replayed.create(request)
      : builder.create(request),
};
const h = await createApiHarness({ llm: transport });
afterAll(() => h?.close());

/** The answers the fixtures were written for (packages/agents/src/interview/interviewer.test.ts). */
const ANSWERS = [
  {
    text: "At the start of each month I download last month's bank statement from Chase as a CSV.",
  },
  {
    text: "I do, Dana in accounts. I open QuickBooks and match each deposit to an open invoice by amount and customer.",
  },
  { text: "Maybe 150 deposits, give or take.", estimate: true },
  { text: "I put it on a list in a spreadsheet and email the customer to ask what it was for." },
  { skip: true },
];

const draftAnswer = {
  toolUse: {
    name: "submit_draft",
    input: {
      summary: "It matches the month's deposits to open invoices and asks before changing any.",
      gaps: ["No part reads a Chase statement yet, so a person downloads it for now."],
      startFromTemplate: null,
      bundle: {
        schemaVersion: 1,
        definition: {
          schemaVersion: 2,
          identity: {
            name: "Invoice reconciliation",
            role: "Receivables",
            mission: "Match deposits to invoices",
          },
          kind: "functional",
          model: { id: "claude-sonnet-5-5" },
          instructions: "Match each deposit to an open invoice.",
          skills: [],
          permissions: { mode: "suggest_only" },
        },
        workflows: [
          {
            slug: "main",
            name: "Reconcile the month",
            workflow: {
              schemaVersion: 4,
              triggers: [{ id: "t", on: { type: "manual", input: {} } }],
              steps: [
                {
                  id: "update",
                  kind: "write",
                  name: "Mark the invoice paid",
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

describe.skipIf(!h)("the process interview", () => {
  const H = h as NonNullable<typeof h>;
  const base = `/api/ops/clients/${H?.A.tenantId}/interviews`;
  let interviewId = "";
  let page = "";

  const ok = async <T>(email: string | null, method: string, path: string, body?: unknown) => {
    const res = await H.call(email, method, path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json as T;
  };
  const errorOf = (json: unknown) => (json as { error: { code: string } }).error.code;

  it("starts with a link for one of the client's contacts, and asks the first question", async () => {
    const [dana] = await H.t.db
      .insert(contact)
      .values({ tenantId: H.A.tenantId, name: "Dana Reyes", email: "dana@client-a.test" })
      .returning();
    const list = await ok<{ contacts: { id: string; name: string }[] }>(OPERATOR, "GET", base);
    expect(list.contacts.map((c) => c.name)).toContain("Dana Reyes");

    const started = await ok<OpsInterviewView>(OPERATOR, "POST", base, {
      contactId: dana?.id,
      process: "Invoice reconciliation",
    });
    interviewId = started.id;
    expect(started).toMatchObject({
      status: "open",
      contact: { name: "Dana Reyes" },
      question: "What starts invoice reconciliation today?",
      costUsd: "0.0000",
    });
    const m = /(\/i\/[A-Za-z0-9_\-.]+)$/.exec(started.link ?? "");
    if (!m?.[1]) throw new Error(`no link in ${started.link}`);
    page = m[1].replace("/i/", "/api/interviews/");

    // Another client's contact, and a client the operator doesn't serve, are not found.
    const [other] = await H.t.db
      .insert(contact)
      .values({ tenantId: H.B.tenantId, name: "Someone at B", email: "someone@client-b.test" })
      .returning();
    const wrong = await H.call(OPERATOR, "POST", base, { contactId: other?.id, process: "X" });
    expect(wrong.status).toBe(404);
    const notServed = await H.call(OTHER_OPERATOR, "GET", `${base}/${interviewId}`);
    expect(notServed.status).toBe(404);
  });

  it("opens with no sign-in and shows the client's name and the one question waiting", async () => {
    const view = await ok<InterviewPageView>(null, "GET", page);
    expect(view).toMatchObject({
      client: "Client A",
      name: "Dana Reyes",
      process: "Invoice reconciliation",
      state: "open",
      question: "What starts invoice reconciliation today?",
      answered: 0,
    });
    // Nothing of ours: no agent, prompt or cost.
    expect(JSON.stringify(view)).not.toMatch(/cost|prompt|instructions|bundle/i);
    // A forged or altered link opens nothing.
    expect((await H.call(null, "GET", `${page}x`)).status).toBe(404);
    expect((await H.call(null, "GET", "/api/interviews/not-a-real-token")).status).toBe(404);
  });

  it("takes a sample file as one of the client's documents", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File(
        [new TextEncoder().encode("date,amount\n2026-10-02,1200.00\n")],
        "chase-october.csv",
        {
          type: "text/csv",
        },
      ),
    );
    const res = await H.app.request(`${page}/files`, { method: "POST", body: form }, H.env);
    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = await H.t.db
      .select({ documents: processInterview.documents })
      .from(processInterview)
      .where(eq(processInterview.id, interviewId));
    const documentId = (row?.documents[0] as { documentId: string } | undefined)?.documentId ?? "";
    const [doc] = await H.t.db
      .select({ tenantId: document.tenantId, source: document.source })
      .from(document)
      .where(eq(document.id, documentId));
    expect(doc).toEqual({ tenantId: H.A.tenantId, source: "request" });
  });

  it("asks one question at a time, takes an estimate and an I don't know, and stops", async () => {
    const asked: (string | null)[] = [];
    for (const a of ANSWERS) {
      const view = await ok<InterviewPageView>(null, "POST", `${page}/answers`, a);
      asked.push(view.question);
    }
    expect(asked).toEqual([
      "Who matches the deposits on that statement to your invoices, and where?",
      "About how many deposits are there in a month?",
      "What happens when a deposit doesn't match an open invoice?",
      // The interviewer asked two at once; the page shows the first.
      "Who approves writing off a small difference?",
      null,
    ]);
    // Nothing waits, so another answer is refused.
    const more = await H.call(null, "POST", `${page}/answers`, { text: "One more thing." });
    expect(more.status).toBe(409);
    expect(errorOf(more.json)).toBe("no_question");
  });

  it("finishes with the current-state map and the open questions, held to the answers", async () => {
    const done = await ok<InterviewPageView>(null, "POST", `${page}/finish`);
    expect(done).toMatchObject({ state: "finished", question: null, answered: 5 });
    expect((await H.call(null, "POST", `${page}/answers`, { text: "Late." })).status).toBe(409);

    const view = await ok<OpsInterviewView>(OPERATOR, "GET", `${base}/${interviewId}`);
    expect(view.status).toBe("finished");
    expect(view.link).toBeNull();
    expect(view.files.map((f) => f.filename)).toEqual(["chase-october.csv"]);
    expect(view.outputs?.map.steps.map((s) => s.id)).toEqual(["download", "match", "unmatched"]);
    expect(view.outputs?.map.steps[1]).toMatchObject({ estimate: true, tool: "QuickBooks" });
    expect(view.outputs?.ungrounded).toBe(1);
    expect(view.outputs?.openQuestions).toHaveLength(4);
    expect(view.outputs?.description).toContain("1. Download last month's bank statement");
    // Six replayed calls, priced, on the back office's view only.
    expect(Number(view.costUsd)).toBeGreaterThan(0);
  });

  it("drafts the client's agent from the map, with a reuse check over its steps", async () => {
    builder.push(draftAnswer);
    const drafted = await ok<OpsInterviewView>(OPERATOR, "POST", `${base}/${interviewId}/draft`);
    expect(drafted.buildId).toBeTruthy();
    expect(drafted.reuse?.steps.map((s) => s.stepId)).toEqual(["download", "match", "unmatched"]);

    const b = await ok<BuildDetail>(OPERATOR, "GET", `/api/ops/builds/${drafted.buildId}`);
    expect(b.build).toMatchObject({
      phase: "draft",
      client: { id: H.A.tenantId, name: "Client A" },
      title: "Invoice reconciliation",
    });
    // The map's words are the operator's message the draft was made from.
    expect(b.messages[0]?.text).toBe(drafted.outputs?.description);
    expect(JSON.stringify(builder.requests.at(-1)?.messages)).toContain(
      "Match each deposit to an open invoice",
    );
    // A person covers what the catalog can't, and every write keeps approval on (invariant 8).
    expect(b.items.map((i) => i.kind)).toEqual(["gap"]);
    expect(b.draft?.problems).toEqual([]);

    const again = await H.call(OPERATOR, "POST", `${base}/${interviewId}/draft`);
    expect(again.status).toBe(409);
    expect(errorOf(again.json)).toBe("has_build");
  });

  it("closes an open interview, and its link stops taking answers", async () => {
    const [dana] = await H.t.db
      .select({ id: contact.id })
      .from(contact)
      .where(and(eq(contact.tenantId, H.A.tenantId), eq(contact.name, "Dana Reyes")));
    const started = await ok<OpsInterviewView>(OPERATOR, "POST", base, {
      contactId: dana?.id,
      process: "Bank feeds",
      area: "receivables",
    });
    const path = (started.link ?? "").replace(/^.*\/i\//, "/api/interviews/");
    const closed = await ok<OpsInterviewView>(OPERATOR, "POST", `${base}/${started.id}/close`);
    expect(closed).toMatchObject({ status: "closed", link: null, question: null });
    const view = await ok<InterviewPageView>(null, "GET", path);
    expect(view).toMatchObject({ state: "closed", turns: [], question: null });
    const late = await H.call(null, "POST", `${path}/answers`, { text: "Hello" });
    expect(late.status).toBe(409);
    // Finishing with nothing said is refused too.
    const draft = await H.call(OPERATOR, "POST", `${base}/${started.id}/draft`);
    expect(errorOf(draft.json)).toBe("not_finished");
  });
});
