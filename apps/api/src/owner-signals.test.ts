// v0.19 O8 (ARCHITECTURE §10.15 "Changes the owner drafts"): a step the owner had to correct three
// times in two weeks becomes one suggestion for the operator, in the owner's name, with the
// decisions it rests on; the next day it isn't made again. Nothing changes the process.

import { agent, agentVersion, inboxItem, oversightDecision, run, stepRun } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness } from "./api.test-helper";
import { ownerSignals, ownerSuggestions } from "./owners/signals";
import { createIssue } from "./work/issues";

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("owners' suggestions", () => {
  const H = h as ApiHarness;
  let agentId = "";
  let versionId = "";

  beforeAll(async () => {
    const [a] = await H.t.db
      .insert(agent)
      .values({
        tenantId: H.A.tenantId,
        kind: "client",
        slug: "bills-in",
        name: "Bills in",
        stage: "live",
        area: "purchasing",
      })
      .returning({ id: agent.id });
    agentId = a?.id ?? "";
    const [v] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: H.A.tenantId,
        agentId,
        version: 1,
        bundle: { schemaVersion: 1, definition: {}, workflows: [] } as never,
        bundleHash: "h-bills-in",
        status: "live",
        authorType: "operator",
      })
      .returning({ id: agentVersion.id });
    versionId = v?.id ?? "";
    await H.t.db.update(agent).set({ liveVersionId: versionId }).where(eq(agent.id, agentId));
    // Three live runs, each with the owner correcting the vendor lookup once.
    for (let i = 0; i < 3; i++) {
      const [r] = await H.t.db
        .insert(run)
        .values({
          tenantId: H.A.tenantId,
          agentId,
          agentVersionId: versionId,
          workflowSlug: "bills",
        })
        .returning({ id: run.id });
      const [s] = await H.t.db
        .insert(stepRun)
        .values({
          tenantId: H.A.tenantId,
          runId: r?.id as string,
          nodeId: "lookup",
          nodeType: "skill",
        })
        .returning({ id: stepRun.id });
      await H.t.db.insert(oversightDecision).values({
        tenantId: H.A.tenantId,
        runId: r?.id as string,
        stepRunId: s?.id as string,
        nodeId: "lookup",
        seq: 1,
        cause: "failed",
        action: "retry_with",
        inputBefore: { vendor: "Ferguson " },
        inputAfter: { vendor: "Ferguson" },
        note: "Trailing space in the vendor name",
        model: "claude-sonnet-5-5",
        costUsd: "0.0010",
        agentVersionId: versionId,
      });
    }
  });

  it("turns three corrections of one step into one suggestion, in the owner's name, once", async () => {
    const at = new Date();
    const signals = await ownerSignals(H.db, H.A.tenantId, at);
    expect(signals).toEqual([
      expect.objectContaining({ kind: "corrected", agentId, stepId: "lookup", count: 3 }),
    ]);
    // The owner exists once the area is in use (Home or a run makes it); the platform's list does.
    const listed = await H.call(
      "operator@example.com",
      "GET",
      `/api/ops/clients/${H.A.tenantId}/owners`,
    );
    expect(listed.status).toBe(200);
    const catalog = H.platform.catalog;
    expect(await ownerSuggestions({ db: H.db, catalog }, H.A.tenantId, at)).toBe(1);
    const items = await H.t.db
      .select()
      .from(inboxItem)
      .where(
        and(eq(inboxItem.tenantId, H.A.tenantId), eq(inboxItem.subjectType, "owner_suggestion")),
      );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "review", assigneeRole: "operator", agentId });
    expect(items[0]?.title).toMatch(
      /^\p{L}+ suggests a change to Bills in: I corrected the input of "lookup" 3 times/u,
    );
    const payload = items[0]?.payload as { sources: string[] } | undefined;
    expect(payload?.sources).toHaveLength(3);
    // The next day: the same suggestion isn't made again.
    const tomorrow = new Date(at.getTime() + 86_400_000);
    expect(await ownerSuggestions({ db: H.db, catalog }, H.A.tenantId, tomorrow)).toBe(0);
  });

  // G12: a request past the bounds and "This is wrong because…" name what they are about on their
  // created event; the owner's suggestion carries that change. A value past the bounds is passed
  // on in the never class (an owner never drafts one that loosens); nothing is drafted.
  it("turns a client's requests into suggestions that carry the change they are about", async () => {
    const at = new Date(Date.now() + 2 * 86_400_000);
    const open = (input: { title: string; description: string; about: Record<string, unknown> }) =>
      H.t.db.transaction((tx) =>
        createIssue(tx as never, {
          tenantId: H.A.tenantId,
          agentId,
          source: "portal",
          actor: "client",
          userId: null,
          now: new Date(at.getTime() - 86_400_000),
          ...input,
        }),
      );
    const setting = await open({
      title: 'Change "Price tolerance (%)" to 8',
      description: "Ada asks to change it.",
      about: {
        kind: "adjustable",
        agentId,
        versionId,
        settingId: "tolerance",
        asked: "8",
        current: "5",
      },
    });
    const line = await open({
      title: "Wrong in the manual: Bills over $500 wait",
      description:
        'On Bills in\'s manual (Decisions): "Bills over $500 wait"\n\nThis is wrong because: it is $1,000',
      about: {
        kind: "manual_line",
        agentId,
        versionId,
        section: "decision",
        lineId: "d1",
        decisionId: null,
        line: "Bills over $500 wait",
      },
    });
    const catalog = H.platform.catalog;
    expect(await ownerSuggestions({ db: H.db, catalog }, H.A.tenantId, at)).toBe(2);
    const items = await H.t.db
      .select()
      .from(inboxItem)
      .where(
        and(eq(inboxItem.tenantId, H.A.tenantId), eq(inboxItem.subjectType, "owner_suggestion")),
      );
    const of = (issueId: string) =>
      items.find((i) => (i.payload as { request?: { id: string } }).request?.id === issueId);
    expect(of(setting.id)?.title).toContain(
      `passes on request #${setting.number} for Bills in: "tolerance" from 5 to 8, past its limits`,
    );
    expect(of(setting.id)?.payload).toMatchObject({
      class: "never",
      change: { kind: "setting", versionId, settingId: "tolerance", from: "5", to: "8" },
      sources: [setting.id],
    });
    expect(of(line.id)?.title).toContain(
      `suggests a change to Bills in: request #${line.number} says "Bills over $500 wait" is wrong`,
    );
    expect(of(line.id)?.payload).toMatchObject({
      class: "process",
      change: {
        kind: "manual_line",
        section: "decision",
        line: "Bills over $500 wait",
        because: "it is $1,000",
        decision: null,
      },
      sources: [line.id],
    });
    // Made once: the next day, nothing new.
    const next = new Date(at.getTime() + 86_400_000);
    expect(await ownerSuggestions({ db: H.db, catalog }, H.A.tenantId, next)).toBe(0);
  });
});
