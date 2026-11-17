// Build (docs/plan.md §1.123.1; docs/cases-plan.md B2–B5): issues numbered per client with their
// conversation and history, kept to their client (invariant 1); the portal's Requests never carry
// a note, Reggie's read or anything internal (invariant 11); the safety hold on a critical issue,
// whose held items wait and which only an operator releases; requests, Sloan's pass_to_lead and
// portal Feedback folded in; asks grouped, decided and told; builds' promised date, origin and
// requirements request; the work order with a reason for each item.

import { FORBIDDEN_PORTAL_FIELD } from "@countersign/core";
import {
  agent,
  agentVersion,
  build,
  clientAsk,
  feedback,
  inboxItem,
  issue,
  notification,
  run,
  todo,
  withOperator,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { OPS_TOOLS } from "./mcp/ops-tools";
import { clientPeople, tenantRow } from "./notify/people";
import { REGGIE_TOOLS } from "./reggie/tools";
import { raiseLegacyRequest } from "./routes/requests";
import type { RunInstances } from "./runs/instances";
import { redeliverResolutions } from "./runs/resume";
import { adoptLegacyFor } from "./work/legacy";
import { issueUpdateCandidates } from "./work/notify-issue";

const h = await createApiHarness();
afterAll(() => h?.close());

type Json = Record<string, unknown>;
const j = (v: unknown) => v as Json;

describe.skipIf(!h)("Build", () => {
  const H = h as NonNullable<typeof h>;
  const call = H.call.bind(H);
  let clerk: string;
  let portalIssue: string;

  async function clientAgent(tenantId: string, slug: string) {
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${tenantId}/agents`, {
      slug,
      bundle: testBundle(),
    });
    expect(created.status).toBe(200);
    const id = (j(created.json).agent as Json).id as string;
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", serviceName: "Records" })
      .where(eq(agent.id, id));
    return id;
  }

  it("numbers issues per client, and keeps each client's to itself", async () => {
    clerk = await clientAgent(H.A.tenantId, "clerk-a");
    const one = await call(OPERATOR, "POST", "/api/ops/issues", {
      clientId: H.A.tenantId,
      title: "Bills land in next week's table",
      text: "Bills scanned after 7:00 on Monday.",
    });
    expect(one.status).toBe(200);
    expect((j(one.json).issue as Json).number).toBe(1);
    const b = await call(OPERATOR, "POST", "/api/ops/issues", {
      clientId: H.B.tenantId,
      title: "B's first",
    });
    expect((j(b.json).issue as Json).number).toBe(1);
    const two = await call(OPERATOR, "POST", "/api/ops/issues", {
      clientId: H.A.tenantId,
      title: "A's second",
    });
    expect((j(two.json).issue as Json).number).toBe(2);
    const id = (j(one.json).issue as Json).id as string;
    // Another client's people and an operator who doesn't serve A see nothing of it.
    expect((await call(admin("b"), "GET", `/api/issues/${id}`)).status).toBe(404);
    expect((await call(OTHER_OPERATOR, "GET", `/api/ops/issues/${id}`)).status).toBe(404);
    expect(
      (
        await call(OTHER_OPERATOR, "POST", "/api/ops/issues", {
          clientId: H.A.tenantId,
          title: "x",
        })
      ).status,
    ).toBe(404);
    // A client's database session reads no other client's issue (RLS).
    const seen = await withOperator(H.db, [H.B.tenantId], (tx) =>
      tx.select({ id: issue.id }).from(issue).where(eq(issue.id, id)),
    );
    expect(seen).toEqual([]);
    // Client roles never reach the back office's routes.
    for (const path of ["/api/ops/work", "/api/ops/holds", `/api/ops/issues/${id}`]) {
      expect((await call(admin("a"), "GET", path)).status).toBe(403);
    }
  });

  it("goes back and forth with the client; notes and Reggie's read stay in the back office", async () => {
    const raised = await call(admin("a"), "POST", "/api/requests", {
      subject: "Ferguson bills don't match",
      text: "Pia keeps flagging the Ferguson bills.",
      serviceId: clerk,
    });
    expect(raised.status).toBe(200);
    portalIssue = (j(raised.json).item as Json).id as string;
    const ops = await call(OPERATOR, "GET", `/api/ops/issues/${portalIssue}`);
    expect(j(ops.json).issue).toMatchObject({
      source: "portal",
      stage: "reported",
      agent: { id: clerk },
    });
    expect((j(ops.json).issue as Json).fixBy).toBeTruthy();
    // Waiting for Reggie's read (B2's pass).
    const [row] = await H.t.db.select().from(issue).where(eq(issue.id, portalIssue));
    expect(row?.needsReadAt).not.toBeNull();
    await H.t.db
      .update(issue)
      .set({
        reggieRead: {
          kind: "issue",
          urgency: "high",
          agentId: clerk,
          title: "Price change",
          read: "SECRET-READ Ferguson raised prices.",
          found: [],
          plan: [],
          draft: { text: "SECRET-DRAFT" },
          sure: "fairly",
          confident: true,
          at: new Date().toISOString(),
          sourceMessageId: null,
        },
      })
      .where(eq(issue.id, portalIssue));

    const note = await call(OPERATOR, "POST", `/api/ops/issues/${portalIssue}/messages`, {
      text: "SECRET-NOTE contract prices are from August",
      audience: "operator",
    });
    expect(note.status).toBe(200);
    const reply = await call(OPERATOR, "POST", `/api/ops/issues/${portalIssue}/messages`, {
      text: "Thanks. We've got it: it's request #1.",
      audience: "client",
    });
    expect(reply.status).toBe(200);
    expect((j(reply.json).issue as Json).firstReplyAt).toBeTruthy();
    expect((j(reply.json).events as Json[]).map((e) => e.kind)).toEqual([
      "created",
      "note",
      "reply",
    ]);

    const portal = await call(admin("a"), "GET", `/api/issues/${portalIssue}`);
    expect(portal.status).toBe(200);
    const text = JSON.stringify(portal.json);
    for (const secret of [
      "SECRET-NOTE",
      "SECRET-READ",
      "SECRET-DRAFT",
      "reggieRead",
      "audience",
      "urgency",
      "waitingOn",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(forbiddenKeys(portal.json)).toEqual([]);
    expect(FORBIDDEN_PORTAL_FIELD.test("bundle")).toBe(true);
    const messages = j(portal.json).messages as Json[];
    expect(messages.map((m) => [m.from, m.text])).toEqual([
      ["you", "Pia keeps flagging the Ferguson bills."],
      ["lead", "Thanks. We've got it: it's request #1."],
    ]);
    // Never an operator's name but the lead's (none set: "Your Mezonas lead").
    expect(messages[1]?.name).toBe("Your Mezonas lead");
    expect(j(portal.json).request).toMatchObject({ kind: "problem", state: "on_it", number: 3 });

    // The client user sees only what they raised; the admin sees everything.
    expect((await call(user("a"), "GET", `/api/issues/${portalIssue}`)).status).toBe(404);
    const asAdmin = j((await call(admin("a"), "GET", "/api/issues")).json).items as Json[];
    expect(asAdmin.map((i) => i.id)).toContain(portalIssue);

    // A notice for the reply goes to the person who raised it.
    const candidates = await withOperator(H.t.db, [H.A.tenantId], async (tx) => {
      const t = await tenantRow(tx, H.A.tenantId);
      if (!t) throw new Error("no tenant");
      return issueUpdateCandidates(tx, t, await clientPeople(tx, t), new Date());
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(
      candidates.every((c) => c.kind === "issue_update" && c.path === `/requests/${portalIssue}`),
    ).toBe(true);
    expect(candidates.every((c) => c.dedupeKey.startsWith("issue:"))).toBe(true);
    void notification;
  });

  it("asks the client to confirm the fix, and takes it back when it's still happening", async () => {
    const verify = await call(OPERATOR, "PATCH", `/api/ops/issues/${portalIssue}`, {
      stage: "verify",
    });
    expect(j(verify.json).issue).toMatchObject({
      stage: "verify",
      waitingOn: "client",
      standing: "client",
    });
    const back = await call(admin("a"), "POST", `/api/issues/${portalIssue}/reopen`);
    expect(j(back.json).request).toMatchObject({ state: "on_it" });
    await call(OPERATOR, "PATCH", `/api/ops/issues/${portalIssue}`, { stage: "verify" });
    const confirmed = await call(admin("a"), "POST", `/api/issues/${portalIssue}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(j(confirmed.json).request).toMatchObject({ state: "closed", canConfirm: false });
    expect((await call(admin("a"), "POST", `/api/issues/${portalIssue}/confirm`)).status).toBe(409);
  });

  it("holds the agent on a critical issue: its items wait, and only an operator releases it", async () => {
    const critical = await call(OPERATOR, "POST", "/api/ops/issues", {
      clientId: H.A.tenantId,
      title: "Posted 14 card charges twice",
      urgency: "critical",
      agentId: clerk,
    });
    expect(critical.status).toBe(200);
    const issueId = (j(critical.json).issue as Json).id as string;
    expect(j(critical.json).hold).toMatchObject({ agent: { id: clerk }, issueId, by: "operator" });
    const [a] = await H.t.db.select({ hold: agent.hold }).from(agent).where(eq(agent.id, clerk));
    expect(a?.hold).toMatchObject({ issueId });
    // The operator is asked to tell the client, with the plain notice drafted.
    const todos = await H.t.db
      .select()
      .from(todo)
      .where(and(eq(todo.aboutKind, "issue"), eq(todo.aboutId, issueId)));
    expect(todos.map((t) => t.title)).toEqual(["Tell Client A about the safety hold"]);
    expect(JSON.stringify(todos[0]?.draft)).toContain(
      "We paused Records while we fix a problem we found",
    );
    const holds = j((await call(OPERATOR, "GET", "/api/ops/holds")).json).holds as Json[];
    expect(holds.map((x) => (x.agent as Json).id)).toEqual([clerk]);

    // A held agent's Desk items wait: approving answers 409; dropping one is allowed.
    const [item] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: H.A.tenantId,
        kind: "approval",
        agentId: clerk,
        assigneeRole: "client_admin",
        title: "Send it?",
      })
      .returning();
    const [other] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: H.A.tenantId,
        kind: "approval",
        agentId: clerk,
        assigneeRole: "client_admin",
        title: "And this?",
      })
      .returning();
    const approve = await call(admin("a"), "POST", `/api/inbox/${item?.id}/resolve`, {
      decision: "approve",
    });
    expect(approve.status).toBe(409);
    expect((j(approve.json).error as Json).code).toBe("agent_held");
    const drop = await call(admin("a"), "POST", `/api/inbox/${other?.id}/resolve`, {
      decision: "reject",
    });
    expect(drop.status).toBe(200);

    // Releasing is a person's, in the back office only: never the client's, Reggie's or the MCP's.
    const path = `/api/ops/agents/${clerk}/release`;
    expect((await call(admin("a"), "POST", path, { reason: "fixed" })).status).toBe(403);
    expect((await call(OTHER_OPERATOR, "POST", path, { reason: "fixed" })).status).toBe(404);
    // Reggie may read holds and propose placing one (§1.123.4); nothing of its or the MCP's releases.
    for (const tool of [...REGGIE_TOOLS, ...OPS_TOOLS]) {
      expect(tool.name).not.toMatch(/release|unhold|rollback/);
    }
    const released = await call(OPERATOR, "POST", path, { reason: "Rolled back to v6" });
    expect(released.status).toBe(200);
    const [after] = await H.t.db
      .select({ hold: agent.hold })
      .from(agent)
      .where(eq(agent.id, clerk));
    expect(after?.hold).toBeNull();
    const again = await call(admin("a"), "POST", `/api/inbox/${item?.id}/resolve`, {
      decision: "approve",
    });
    expect(again.status).toBe(200);
    const events = (
      j((await call(OPERATOR, "GET", `/api/ops/issues/${issueId}`)).json).events as Json[]
    ).map((e) => e.kind);
    expect(events).toEqual(["created", "hold", "release"]);
  });

  it("delivers an approval held longer than a day once the hold is released", async () => {
    const held = await clientAgent(H.A.tenantId, "clerk-redeliver");
    const [v] = await H.t.db
      .select({ id: agentVersion.id })
      .from(agentVersion)
      .where(eq(agentVersion.agentId, held));
    const [r] = await H.t.db
      .insert(run)
      .values({
        tenantId: H.A.tenantId,
        agentId: held,
        agentVersionId: v?.id as string,
        workflowSlug: "main",
        mode: "live",
        status: "waiting",
      })
      .returning();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const [item] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: H.A.tenantId,
        kind: "approval",
        agentId: held,
        runId: r?.id,
        assigneeRole: "client_admin",
        title: "Post it?",
        status: "resolved",
        resolution: { approved: true },
        resolvedAt: twoDaysAgo,
        deliverAfter: new Date(twoDaysAgo.getTime() + 60_000),
      })
      .returning();
    const made = await call(OPERATOR, "POST", "/api/ops/issues", {
      clientId: H.A.tenantId,
      title: "Posting to the wrong period",
      urgency: "critical",
      agentId: held,
    });
    expect(made.status).toBe(200);
    const sent: string[] = [];
    const instances = {
      sendEvent: async (runId: string) => {
        sent.push(runId);
      },
    } as unknown as RunInstances;
    await redeliverResolutions({ db: H.db, instances }, H.A.tenantId, new Date());
    expect(sent).not.toContain(r?.id);
    const released = await call(OPERATOR, "POST", `/api/ops/agents/${held}/release`, {
      reason: "Fixed",
    });
    expect(released.status).toBe(200);
    await redeliverResolutions({ db: H.db, instances }, H.A.tenantId, new Date());
    expect(sent).toContain(r?.id);
    void item;
  });

  it("holds on a change to critical, and not on high", async () => {
    const made = await call(OPERATOR, "POST", "/api/ops/issues", {
      clientId: H.A.tenantId,
      title: "Odd totals",
      agentId: clerk,
    });
    const id = (j(made.json).issue as Json).id as string;
    const high = await call(OPERATOR, "PATCH", `/api/ops/issues/${id}`, {
      urgency: "high",
      reason: "11 bills held",
    });
    expect(j(high.json).hold).toBeNull();
    expect(
      (await call(OPERATOR, "PATCH", `/api/ops/issues/${id}`, { urgency: "critical" })).status,
    ).toBe(422);
    const crit = await call(OPERATOR, "PATCH", `/api/ops/issues/${id}`, {
      urgency: "critical",
      reason: "money moved",
    });
    expect(j(crit.json).hold).toMatchObject({ issueId: id });
    await call(OPERATOR, "POST", `/api/ops/agents/${clerk}/release`, { reason: "done" });
  });

  it("lists the work in order with a reason for each, critical first", async () => {
    const work = await call(OPERATOR, "GET", "/api/ops/work");
    expect(work.status).toBe(200);
    const items = j(work.json).items as Json[];
    const open = items.filter((i) => i.rank !== null);
    expect(open.map((i) => i.rank)).toEqual(open.map((_, n) => n + 1));
    expect(open.every((i) => typeof i.why === "string" && (i.why as string).length > 0)).toBe(true);
    expect(open[0]).toMatchObject({
      kind: "issue",
      urgency: "critical",
      why: "Critical: ahead of everything.",
    });
    expect((j(work.json).kpis as Json[]).map((k) => k.label)).toEqual([
      "Critical, held",
      "Open issues",
      "Builds in progress",
      "Promised dates at risk",
      "Enhancement asks",
      "Late",
    ]);
    // The operator moves one: it goes where they put it.
    const last = open.at(-1) as Json;
    await call(OPERATOR, "POST", "/api/ops/work/move", {
      kind: last.kind,
      id: last.id,
      position: 1,
    });
    const moved = j((await call(OPERATOR, "GET", "/api/ops/work")).json).items as Json[];
    expect(moved[0]).toMatchObject({ id: last.id, manual: true, why: "Moved by you." });
    // The other operator's list has none of A's.
    const theirs = j((await call(OTHER_OPERATOR, "GET", "/api/ops/work")).json).items as Json[];
    expect(theirs.every((i) => (i.client as Json | null)?.id !== H.A.tenantId)).toBe(true);
  });

  it("folds in portal Feedback and requests raised before, once", async () => {
    const on = await call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/feedback`, {
      enabled: true,
    });
    expect(on.status).toBe(200);
    const sent = await call(admin("a"), "POST", "/api/feedback", {
      comment: "The Desk says undefined",
      path: "/inbox",
      viewport: { width: 1200, height: 800 },
      target: "the error page",
      pin: null,
    });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    const fid = j(sent.json).id as string;
    const made = await H.t.db.select().from(issue).where(eq(issue.feedbackId, fid));
    expect(made.map((i) => [i.source, i.title])).toEqual([["feedback", "The Desk says undefined"]]);
    // Before Build: a change request and an open Feedback item with no issue.
    const adminId = (
      await H.t.db.query.appUser.findFirst({ where: (u, { eq: e }) => e(u.email, admin("a")) })
    )?.id as string;
    const legacy = await withOperator(H.t.db, [H.A.tenantId], (tx) =>
      raiseLegacyRequest(tx, H.A.tenantId, { text: "Add Acme as a vendor", raisedBy: adminId }),
    );
    const [old] = await H.t.db
      .insert(feedback)
      .values({
        tenantId: H.A.tenantId,
        surface: "portal",
        userId: adminId,
        comment: "Old feedback",
        path: "/",
        viewport: { width: 1, height: 1 },
      })
      .returning();
    const first = await withOperator(H.t.db, [H.A.tenantId], (tx) =>
      adoptLegacyFor(tx, H.A.tenantId),
    );
    expect(first).toBeGreaterThanOrEqual(2);
    const second = await withOperator(H.t.db, [H.A.tenantId], (tx) =>
      adoptLegacyFor(tx, H.A.tenantId),
    );
    expect(second).toBe(0);
    const adopted = await H.t.db.select().from(issue).where(eq(issue.legacyItemId, legacy.id));
    expect(adopted.map((i) => i.source)).toEqual(["legacy_request"]);
    expect(
      await H.t.db
        .select()
        .from(issue)
        .where(eq(issue.feedbackId, old?.id as string)),
    ).toHaveLength(1);
    // The old row is left as it was.
    const [still] = await H.t.db.select().from(inboxItem).where(eq(inboxItem.id, legacy.id));
    expect(still?.status).toBe("open");
  });

  it("adopts a resolved change request without telling the client again", async () => {
    const bAdmin = (
      await H.t.db.query.appUser.findFirst({ where: (u, { eq: e }) => e(u.email, admin("b")) })
    )?.id as string;
    const legacy = await withOperator(H.t.db, [H.B.tenantId], (tx) =>
      raiseLegacyRequest(tx, H.B.tenantId, { text: "Rename the vendor", raisedBy: bAdmin }),
    );
    const resolvedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await H.t.db
      .update(inboxItem)
      .set({
        status: "resolved",
        resolution: { note: "Renamed it for you." },
        resolvedBy: H.operator,
        resolvedAt,
      })
      .where(eq(inboxItem.id, legacy.id));
    await withOperator(H.t.db, [H.B.tenantId], (tx) => adoptLegacyFor(tx, H.B.tenantId));
    const [adopted] = await H.t.db.select().from(issue).where(eq(issue.legacyItemId, legacy.id));
    expect(adopted?.stage).toBe("closed");
    const candidates = await withOperator(H.t.db, [H.B.tenantId], async (tx) => {
      const t = await tenantRow(tx, H.B.tenantId);
      if (!t) throw new Error("no tenant");
      return issueUpdateCandidates(tx, t, await clientPeople(tx, t), new Date());
    });
    expect(candidates.filter((c) => c.path === `/requests/${adopted?.id}`)).toEqual([]);
  });

  it("tells the clients who asked when an enhancement is decided no, and closes their asks", async () => {
    const idea = await call(admin("a"), "POST", "/api/requests", {
      text: "A dark mode for the Desk printout",
      kind: "idea",
    });
    expect(idea.status).toBe(200);
    const askId = (j(idea.json).item as Json).id as string;
    const grouped = await call(OPERATOR, "POST", `/api/ops/asks/${askId}/group`, {
      newEnhancement: { title: "Dark printouts" },
    });
    const enh = j(grouped.json).enhancement as Json;
    const decided = await call(OPERATOR, "POST", `/api/ops/enhancements/${enh.id}/decide`, {
      decision: "no",
      note: "Not something we'll build.",
    });
    expect(decided.status, JSON.stringify(decided.json)).toBe(200);
    const [ask] = await H.t.db.select().from(clientAsk).where(eq(clientAsk.id, askId));
    expect(ask?.status).toBe("closed");
    expect(ask?.closedAt).not.toBeNull();
    const portal = await call(admin("a"), "GET", `/api/issues/${askId}`);
    expect(j(portal.json).request).toMatchObject({ kind: "idea", state: "closed" });
    expect((j(portal.json).messages as Json[]).map((m) => m.text)).toContain(
      "Not something we'll build.",
    );
  });

  it("makes an idea an ask, groups it, decides it and tells the client when it ships", async () => {
    const idea = await call(admin("a"), "POST", "/api/requests", {
      text: "POs as PDF and CSV, please",
      kind: "idea",
    });
    expect(idea.status).toBe(200);
    const askId = (j(idea.json).item as Json).id as string;
    const [ask] = await H.t.db.select().from(clientAsk).where(eq(clientAsk.id, askId));
    expect(ask?.source).toBe("portal");
    const grouped = await call(OPERATOR, "POST", `/api/ops/asks/${askId}/group`, {
      newEnhancement: { title: "POs as PDF and CSV" },
    });
    expect(grouped.status).toBe(200);
    const enh = j(grouped.json).enhancement as Json;
    expect(enh).toMatchObject({ stage: "grouped", asks: 1 });
    expect(
      (await call(OPERATOR, "POST", `/api/ops/enhancements/${enh.id}/decide`, { decision: "no" }))
        .status,
    ).toBe(422);
    const decided = await call(OPERATOR, "POST", `/api/ops/enhancements/${enh.id}/decide`, {
      decision: "do",
      note: "A template change",
    });
    expect(j(decided.json).enhancement).toMatchObject({ decision: "do", stage: "decided" });
    // Another operator's view of it carries none of A's asks.
    const theirs = await call(OTHER_OPERATOR, "GET", `/api/ops/enhancements/${enh.id}`);
    expect(j(theirs.json).asks).toEqual([]);
    const told = await call(OPERATOR, "POST", `/api/ops/enhancements/${enh.id}/told`, {
      note: "POs now come as PDF and CSV.",
    });
    expect(j(told.json).enhancement).toMatchObject({ stage: "shipped" });
    const portal = await call(admin("a"), "GET", `/api/issues/${askId}`);
    expect(j(portal.json).request).toMatchObject({ kind: "idea", state: "fixed" });
    expect((j(portal.json).messages as Json[]).map((m) => m.text)).toContain(
      "POs now come as PDF and CSV.",
    );
    expect(JSON.stringify(portal.json)).not.toContain(enh.id as string);

    // "It isn't a fault": an issue becomes an ask and closes, with the plain words.
    const made = await call(OPERATOR, "POST", "/api/ops/issues", {
      clientId: H.A.tenantId,
      title: "Dark mode please",
    });
    const id = (j(made.json).issue as Json).id as string;
    const converted = await call(OPERATOR, "POST", `/api/ops/issues/${id}/convert`, { to: "ask" });
    expect(converted.status).toBe(200);
    const after = j((await call(OPERATOR, "GET", `/api/ops/issues/${id}`)).json).issue as Json;
    expect(after).toMatchObject({
      stage: "closed",
      causeKind: "not_a_bug",
      askId: j(converted.json).askId,
    });
  });

  it("gives a build its promised date and origin, and sends its requirements to the client's Desk", async () => {
    const started = await call(OPERATOR, "POST", "/api/ops/builds", {
      kind: "agent",
      title: "Purchasing agent",
      clientId: H.A.tenantId,
      promisedOn: "2026-12-05",
      origin: { kind: "issue", id: portalIssue },
    });
    expect(started.status).toBe(200);
    const b = j(started.json).build as Json;
    expect(b).toMatchObject({
      path: "new",
      promisedOn: "2026-12-05",
      origin: { kind: "issue", id: portalIssue },
      pipelineStage: "building",
    });
    // A template build needs its template, and one that is published.
    expect(
      (
        await call(OPERATOR, "POST", "/api/ops/builds", {
          kind: "agent",
          title: "x",
          clientId: H.A.tenantId,
          path: "template",
        })
      ).status,
    ).toBe(400);
    // The Builder board keeps new agents; Build lists it with its date.
    const board = j((await call(OPERATOR, "GET", "/api/ops/builds")).json).builds as Json[];
    expect(board.map((x) => x.id)).toContain(b.id);
    const moved = await call(OPERATOR, "PATCH", `/api/ops/builds/${b.id}`, {
      promisedOn: "2026-12-12",
    });
    expect((j(moved.json).build as Json).promisedOn).toBe("2026-12-12");

    const adminId = (
      await H.t.db.query.appUser.findFirst({ where: (u, { eq: e }) => e(u.email, admin("a")) })
    )?.id as string;
    const sent = await call(OPERATOR, "POST", `/api/ops/builds/${b.id}/requirements`, {
      dueOn: "2026-11-30",
      toUserId: adminId,
      fields: [
        {
          key: "approver",
          label: "Who approves orders over $2,000?",
          kind: "text",
          required: true,
        },
        {
          key: "tolerance",
          label: "Price tolerance before a bill is held",
          kind: "text",
          required: true,
        },
      ],
    });
    expect(sent.status).toBe(200);
    const itemId = j(sent.json).itemId as string;
    const form = await call(admin("a"), "GET", `/api/requirements/${itemId}`);
    expect(j(form.json)).toMatchObject({ total: 2, answered: 0, submitted: false });
    // A client user can read it; only the admin answers.
    expect(
      (await call(user("a"), "PUT", `/api/requirements/${itemId}`, { answers: { approver: "x" } }))
        .status,
    ).toBe(403);
    const draft = await call(admin("a"), "PUT", `/api/requirements/${itemId}`, {
      answers: { approver: "Dr. Shah", junk: "dropped" },
    });
    expect(j(draft.json)).toMatchObject({ answered: 1, answers: { approver: "Dr. Shah" } });
    const list = j((await call(OPERATOR, "GET", "/api/ops/work?tab=builds")).json).items as Json[];
    expect(list.find((x) => x.id === b.id)).toMatchObject({
      stage: "requirements",
      due: "2026-12-12",
    });
    // Answered through its form, never through the Desk's generic resolve.
    expect(
      (await call(admin("a"), "POST", `/api/inbox/${itemId}/resolve`, { decision: "approve" }))
        .status,
    ).toBe(409);
    const done = await call(admin("a"), "POST", `/api/requirements/${itemId}/submit`, {
      answers: { approver: "Dr. Shah", tolerance: "2%" },
    });
    expect(j(done.json)).toMatchObject({ submitted: true, answered: 2 });
    const [row] = await H.t.db
      .select()
      .from(build)
      .where(eq(build.id, b.id as string));
    expect(row?.requirements).toMatchObject({ inboxItemId: itemId, dueOn: "2026-11-30" });
  });
});
