// Collect reports (owner, 2026-11-24): a report emailed to its step's address, the agent's own
// with `+<step id>`. A proven owner's attachments go to their open link on that step as an upload
// would; anyone else, a step that isn't a collect step, or no open link: nothing is taken.

import { ContentStore, MemoryObjectStore } from "@countersign/connectors";
import { agentStepAddress } from "@countersign/core";
import { agent, contact, formRequest, run, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";
import { collectChecks } from "./collect/checks";
import { linkOfStep } from "./collect/email";
import { receiveAgentEmail } from "./triggers/inbound-email";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;
const DOMAIN = "in.mezonas.test";

const h = await createApiHarness({ env: { EMAIL_FORWARDING_DOMAIN: DOMAIN } });
afterAll(() => h?.close());

function bundle(owner: string): unknown {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Rhea", role: "collects reports", mission: "reconcile two reports" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Only do what the workflow says.",
      skills: [],
      extraTools: [],
      canCommand: [],
      permissions: { mode: "suggest_only" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 4,
          triggers: [{ id: "t1", on: { type: "manual", input: { type: "object" } } }],
          steps: [
            {
              id: "C1",
              kind: "collect",
              name: "Collect the reports",
              items: [
                {
                  id: "bank",
                  name: "Bank statement",
                  owner,
                  formats: ["spreadsheet"],
                  due: "3 days",
                  followUp: { after: "1 day", every: "2 days" },
                },
              ],
              escalate: { to: "client_admin", after: "5 days", deadline: { after: "2 days" } },
            },
            {
              id: "n1",
              kind: "notify",
              name: "Tell the team",
              notify: { to: ["client_admin"], message: "{{steps.C1.output.summary}}" },
            },
          ],
        },
      },
    ],
  };
}

function mime(input: {
  id: string;
  from: string;
  to: string;
  csv?: string;
  /** false: the sender's domain has no DMARC, so nothing proves the From address. */
  dmarc?: boolean;
}): Uint8Array {
  const boundary = "b-collect";
  const domain = input.from.split("@")[1];
  const lines = [
    `Authentication-Results: mx.cloudflare.net; dmarc=${input.dmarc === false ? "none" : "pass"} header.from=${domain}`,
    `From: ${input.from}`,
    `To: ${input.to}`,
    "Subject: November statement",
    `Message-ID: <${input.id}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Here it is.",
  ];
  if (input.csv) {
    lines.push(
      `--${boundary}`,
      'Content-Type: text/csv; name="bank.csv"',
      'Content-Disposition: attachment; filename="bank.csv"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(input.csv).toString("base64"),
    );
  }
  lines.push(`--${boundary}--`, "");
  return new TextEncoder().encode(lines.join("\r\n"));
}

describe("which links belong to a step", () => {
  it("reads the step from the link's node, inside a loop too, in any case", () => {
    expect(linkOfStep("C1:0:r2:ask", "c1")).toBe(true);
    expect(linkOfStep("loop:3:c1:1:r1:ask", "c1")).toBe(true);
    expect(linkOfStep("c10:0:r1:ask", "c1")).toBe(false);
    expect(linkOfStep("c1:0:r1:esc", "c1")).toBe(false);
  });
});

describe.skipIf(!h)("mail to a collect step's address", () => {
  const H = h as ApiHarness;
  const content = new ContentStore(new MemoryObjectStore());
  let agentAddr = "";
  let stepAddr = "";
  let agentId = "";
  let versionId = "";
  let contactId = "";

  beforeAll(async () => {
    for (const level of ["warn", "error", "log"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    const [c] = await H.t.db
      .insert(contact)
      .values({ tenantId: H.A.tenantId, name: "Pat at the bank", email: "pat@bank.example" })
      .returning();
    contactId = c?.id as string;
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "rhea",
      bundle: bundle(contactId),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    agentId = j(created.json).agent.id;
    versionId = j(created.json).version.id;
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${versionId}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));
    const list = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentId}/triggers`);
    agentAddr = j(list.json).address;
    expect(agentAddr).toContain(DOMAIN);
    stepAddr = agentStepAddress(agentAddr, "C1");
    expect(stepAddr).toMatch(/\+c1@/);
  });

  /** A run waiting on the bank statement, with its first link open. */
  async function openLink(): Promise<string> {
    const [r] = await H.t.db
      .insert(run)
      .values({
        tenantId: H.A.tenantId,
        agentId,
        agentVersionId: versionId,
        workflowSlug: "main",
        mode: "live",
        status: "waiting",
        trigger: { type: "manual" },
        startedAt: new Date(),
      })
      .returning();
    const [f] = await H.t.db
      .insert(formRequest)
      .values({
        tenantId: H.A.tenantId,
        agentId,
        agentVersionId: versionId,
        runId: r?.id as string,
        nodeId: "C1:0:r1:ask",
        contactId,
        purpose: "Please send us the Bank statement for November 2026.",
        definition: {
          title: "Bank statement, November 2026",
          questions: [
            {
              id: "report",
              type: "files",
              label: "Bank statement",
              required: true,
              accept: ["spreadsheet"],
              max: 5,
            },
          ],
        },
        ask: { required: [], maxExtra: 0, allowFiles: false },
        status: "open",
        dueAt: new Date(Date.now() + 2 * 86_400_000),
      })
      .returning();
    return f?.id as string;
  }

  const receive = (raw: Uint8Array, to = stepAddr, from = "pat@bank.example") =>
    receiveAgentEmail(
      { db: H.db, content, registry: H.platform.events },
      { from, to, raw, size: raw.length },
      { domain: DOMAIN },
    );

  const link = (id: string) =>
    withTenant(H.db, H.A.tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(formRequest)
        .where(and(eq(formRequest.id, id), eq(formRequest.tenantId, H.A.tenantId)));
      return row;
    });

  it("hands the owner's emailed report to their open link and wakes the run", async () => {
    const id = await openLink();
    const outcome = await receive(
      mime({
        id: "m1",
        from: "pat@bank.example",
        to: stepAddr,
        csv: "Date,Amount\n2026-11-02,10.00\n",
      }),
    );
    expect(outcome).toMatchObject({ status: "accepted", wake: { formRequestId: id } });
    // No run started: the agent has no message trigger, and mail to a step never starts one.
    expect(outcome?.status === "accepted" ? outcome.events.map((e) => e.type) : []).not.toContain(
      "inbound.message",
    );
    const row = await link(id);
    expect(row?.status).toBe("submitted");
    const answers = row?.answers as
      | { report: { documentId: string; filename: string }[] }
      | null
      | undefined;
    const answer = answers?.report ?? [];
    expect(answer).toEqual([{ documentId: expect.any(String), filename: "bank.csv" }]);
    expect(row?.documents).toEqual([answer[0]?.documentId]);
    expect(row?.log?.at(-1)).toMatchObject({ kind: "emailed", proven: true });
    // The same message again takes nothing.
    const again = await receive(
      mime({ id: "m1", from: "pat@bank.example", to: stepAddr, csv: "Date,Amount\n" }),
    );
    expect(again?.status).not.toBe("accepted");
  });

  it("takes the owner's report though nothing proves the sender, and marks it unproven", async () => {
    const id = await openLink();
    const outcome = await receive(
      mime({
        id: "m7",
        from: "pat@bank.example",
        to: stepAddr,
        csv: "Date,Amount\n2026-11-03,4.00\n",
        dmarc: false,
      }),
    );
    expect(outcome).toMatchObject({ status: "accepted", wake: { formRequestId: id } });
    const row = await link(id);
    expect(row?.status).toBe("submitted");
    expect(row?.log?.at(-1)).toMatchObject({ kind: "emailed", proven: false });
    // The check the step runs says how it came in.
    const docs = row?.documents ?? [];
    const check = await collectChecks({ db: H.db, content }).check({
      tenantId: H.A.tenantId,
      runId: row?.runId as string,
      nodeId: "C1:0:r1",
      item: {
        id: "bank",
        name: "Bank statement",
        owner: contactId,
        required: true,
        frequency: "once",
        formats: ["spreadsheet"],
        due: "3 days",
        hours: "business",
        followUp: { after: "1 day", every: "2 days", max: 2 },
      },
      period: null,
      documentIds: docs,
    });
    expect(check).toMatchObject({ ok: true, senderProven: false });
  });

  it("takes nothing from a stranger, without a file, or with no link open", async () => {
    const id = await openLink();
    const stranger = await receive(
      mime({ id: "m2", from: "eve@else.example", to: stepAddr, csv: "Date,Amount\n" }),
      stepAddr,
      "eve@else.example",
    );
    expect(stranger).toMatchObject({ status: "refused", reason: "sender_not_owner" });
    // Nor from a stranger whose domain has no DMARC.
    const unproven = await receive(
      mime({
        id: "m2b",
        from: "eve@else.example",
        to: stepAddr,
        csv: "Date,Amount\n",
        dmarc: false,
      }),
      stepAddr,
      "eve@else.example",
    );
    expect(unproven).toMatchObject({ status: "refused", reason: "sender_not_owner" });
    const empty = await receive(mime({ id: "m3", from: "pat@bank.example", to: stepAddr }));
    expect(empty).toMatchObject({ status: "refused", reason: "no_file" });
    expect((await link(id))?.status).toBe("open");
    // Answer the open link, then nothing is open for Pat.
    await receive(
      mime({
        id: "m4",
        from: "pat@bank.example",
        to: stepAddr,
        csv: "Date,Amount\n2026-11-02,1\n",
      }),
    );
    const late = await receive(
      mime({ id: "m5", from: "pat@bank.example", to: stepAddr, csv: "Date,Amount\n" }),
    );
    expect(late).toMatchObject({ status: "refused", reason: "no_open_report" });
  });

  it("tells the step its address, which owners are shown", async () => {
    const port = collectChecks({ db: H.db, domain: DOMAIN });
    expect(await port.address?.({ tenantId: H.A.tenantId, agentId, stepId: "C1" })).toBe(stepAddr);
    const none = collectChecks({ db: H.db });
    expect(await none.address?.({ tenantId: H.A.tenantId, agentId, stepId: "C1" })).toBeNull();
  });

  it("drops mail to a tag that isn't one of the agent's collect steps", async () => {
    const outcome = await receive(
      mime({
        id: "m6",
        from: "pat@bank.example",
        to: agentStepAddress(agentAddr, "n1"),
        csv: "A\n1\n",
      }),
      agentStepAddress(agentAddr, "n1"),
    );
    expect(outcome).toMatchObject({ status: "dropped", reason: "unknown_address" });
  });
});

describe.skipIf(!h)(
  "the report trigger: the first report starts the run, the others go to it",
  () => {
    const H = h as ApiHarness;
    const content = new ContentStore(new MemoryObjectStore());
    let stepAddr = "";
    let agentId = "";
    let pat = "";
    let quinn = "";

    function reportsBundle(owner: string): unknown {
      const b = bundle(owner) as {
        definition: Record<string, unknown>;
        workflows: { workflow: { triggers: unknown[]; steps: { items?: unknown[] }[] } }[];
        people?: unknown;
      };
      const wf = b.workflows[0]?.workflow;
      if (!wf) throw new Error("no workflow");
      wf.triggers = [{ id: "t1", on: { type: "report", step: "C1" } }];
      const first = wf.steps[0] as { items: Record<string, unknown>[] };
      first.items.push({
        id: "card",
        name: "Card statement",
        owner: "seat:card-owner",
        formats: ["spreadsheet"],
        due: "1 day",
        followUp: { after: "1 day", every: "2 days" },
      });
      return {
        ...b,
        people: [{ role: "card-owner", description: "Sends the card statement", kind: "reached" }],
      };
    }

    beforeAll(async () => {
      const made = await H.t.db
        .insert(contact)
        .values([
          { tenantId: H.A.tenantId, name: "Pat", email: "pat@bank2.example" },
          { tenantId: H.A.tenantId, name: "Quinn", email: "quinn@card.example" },
        ])
        .returning();
      pat = made[0]?.id as string;
      quinn = made[1]?.id as string;
      const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
        slug: "rory",
        bundle: reportsBundle(pat),
      });
      expect(created.status, JSON.stringify(created.json)).toBe(200);
      agentId = j(created.json).agent.id;
      const pub = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${agentId}/versions/${j(created.json).version.id}/publish`,
      );
      expect(pub.status, JSON.stringify(pub.json)).toBe(200);
      await H.t.db
        .update(agent)
        .set({
          runStatus: "active",
          people: { "card-owner": { contactIds: [quinn], conditions: {} } },
        })
        .where(eq(agent.id, agentId));
      const list = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentId}/triggers`);
      stepAddr = agentStepAddress(j(list.json).address, "C1");
    });

    const receive = (raw: Uint8Array, from: string) =>
      receiveAgentEmail(
        { db: H.db, content, registry: H.platform.events },
        { from, to: stepAddr, raw, size: raw.length },
        { domain: DOMAIN },
      );

    it("starts a run on the first report and sends the second to it", async () => {
      const first = await receive(
        mime({
          id: "r1",
          from: "pat@bank2.example",
          to: stepAddr,
          csv: "Date,Amount\n2026-11-02,1\n",
        }),
        "pat@bank2.example",
      );
      expect(first).toMatchObject({
        status: "accepted",
        start: {
          agentId,
          workflowSlug: "main",
          mode: "live",
          trigger: { type: "report", triggerId: "t1", step: "C1", item: "bank" },
          payload: { report: { step: "C1", item: "bank", contactId: pat, proven: true } },
        },
      });
      const runId = first?.status === "accepted" ? first.start?.runId : undefined;
      const [row] = await H.t.db
        .select()
        .from(run)
        .where(eq(run.id, runId as string));
      expect(row).toMatchObject({ agentId, workflowSlug: "main" });

      // The card statement, from the person bound to its seat, goes to that run: no second run.
      const second = await receive(
        mime({
          id: "r2",
          from: "quinn@card.example",
          to: stepAddr,
          csv: "Date,Amount\n2026-11-03,2\n",
        }),
        "quinn@card.example",
      );
      expect(second).toMatchObject({
        status: "accepted",
        listen: { runId, eventType: "report-c1-card", documents: [expect.any(String)] },
      });
      expect(second).not.toHaveProperty("start");

      // Someone who owns no report: nothing.
      const stranger = await receive(
        mime({ id: "r3", from: "eve@else.example", to: stepAddr, csv: "A\n1\n" }),
        "eve@else.example",
      );
      expect(stranger).toMatchObject({ status: "refused" });

      // Once that run is over, the next report starts a new one.
      await H.t.db
        .update(run)
        .set({ status: "succeeded" })
        .where(eq(run.id, runId as string));
      const next = await receive(
        mime({
          id: "r4",
          from: "pat@bank2.example",
          to: stepAddr,
          csv: "Date,Amount\n2026-12-02,1\n",
        }),
        "pat@bank2.example",
      );
      expect(next?.status === "accepted" ? next.start?.runId : null).toBeTruthy();
      expect(next?.status === "accepted" ? next.start?.runId : null).not.toBe(runId);
    });
  },
);
