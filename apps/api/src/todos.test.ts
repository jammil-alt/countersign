// Your call through the API (docs/plan.md §1.124.3; docs/cases-plan.md T1): one list of what needs
// a person with a due date (to-dos, escalations, runs to check, Reggie's cards), Reggie's and the
// clients' lists, Later, Take it, Do it through the item's own route, what Reggie did today and its
// flag, and the client page's work and activity read across the tables that keep it. Operator
// only, and only for the clients an operator serves (invariant 1); client roles never reach it.

import type {
  ClientActivity,
  ClientWork,
  DoneToday,
  IssueDetail,
  TodoActResult,
  TodoList,
  TodoView,
} from "@countersign/core";
import { inboxItem, playLog, todo, withOperator } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, OPERATOR, OTHER_OPERATOR, user } from "./api.test-helper";
import { addTodo } from "./work/todos-store";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("Your call", () => {
  const H = h as NonNullable<typeof h>;
  const ok = async <T>(method: string, path: string, body?: unknown, who = OPERATOR) => {
    const res = await H.call(who, method, path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json as T;
  };
  const list = (q = "", who = OPERATOR) =>
    ok<TodoList>("GET", `/api/ops/todos${q}`, undefined, who);
  /** A to-do as Reggie's plays make them (B2): with a read, a draft and a primary action. */
  const seed = (values: Parameters<typeof addTodo>[1], tenants = [H.A.tenantId, H.B.tenantId]) =>
    withOperator(H.db, tenants, (tx) => addTodo(tx, values));

  it("is the operator's only", async () => {
    for (const who of [admin("a"), user("a")]) {
      for (const [method, path] of [
        ["GET", "/api/ops/todos"],
        ["GET", "/api/ops/todos/done-today"],
        ["GET", `/api/ops/clients/${H.A.tenantId}/activity`],
        ["GET", `/api/ops/clients/${H.A.tenantId}/work`],
      ] as const) {
        expect((await H.call(who, method, path)).status).toBe(403);
      }
      expect(
        (await H.call(who, "POST", "/api/ops/todos", { title: "x", owner: "operator" })).status,
      ).toBe(403);
    }
  });

  let mine: TodoView;
  it("adds a to-do, lists it with its due date, and keeps it to the clients served", async () => {
    mine = await ok<TodoView>("POST", "/api/ops/todos", {
      title: "Call Dana about the Ferguson prices",
      owner: "operator",
      clientId: H.A.tenantId,
      dueAt: "2026-11-18T17:00:00.000Z",
      why: "A promised date. Moving work around a promised date is yours.",
    });
    expect(mine).toMatchObject({
      source: "todo",
      owner: "operator",
      client: { id: H.A.tenantId },
      dueAt: "2026-11-18T17:00:00.000Z",
      why: { head: "A promised date", detail: "Moving work around a promised date is yours." },
      editable: true,
      kind: "other",
      tag: "To-do",
    });
    const yours = await list();
    expect(yours.items.map((i) => i.id)).toContain(mine.id);
    expect(yours.counts.yours).toBeGreaterThanOrEqual(1);
    // C's operator serves only C: it neither sees A's to-do nor can add one for A.
    expect((await list("", OTHER_OPERATOR)).items.map((i) => i.id)).not.toContain(mine.id);
    expect(
      (
        await H.call(OTHER_OPERATOR, "POST", "/api/ops/todos", {
          title: "x",
          owner: "operator",
          clientId: H.A.tenantId,
        })
      ).status,
    ).toBe(404);
    expect((await H.call(OTHER_OPERATOR, "POST", `/api/ops/todos/${mine.id}/done`)).status).toBe(
      404,
    );
    // A client's database session reads no to-do at all (operator-only RLS).
    const { withTenant } = await import("@countersign/db");
    const seen = await withTenant(H.db, H.A.tenantId, (tx) => tx.select().from(todo));
    expect(seen).toEqual([]);
  });

  it("names a to-do to an operator, and Mine filters to it", async () => {
    const named = await ok<TodoView>("POST", "/api/ops/todos", {
      title: "Mine only",
      owner: "operator",
      ownerUserId: H.operator,
    });
    expect(named.ownerUser?.id).toBe(H.operator);
    const other = await withOperator(H.db, [H.A.tenantId], (tx) =>
      addTodo(tx, { title: "Someone else's", owner: "operator", ownerUserId: H.otherOperator }),
    );
    const all = (await list()).items.map((i) => i.id);
    expect(all).toEqual(expect.arrayContaining([named.id, other.id]));
    const only = (await list("?mine=true")).items.map((i) => i.id);
    expect(only).toContain(named.id);
    expect(only).not.toContain(other.id);
    // Only our own to-dos are named to a person, and only to an operator.
    expect(
      (
        await H.call(OPERATOR, "POST", "/api/ops/todos", {
          title: "x",
          owner: "client",
          ownerUserId: H.operator,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await H.call(OPERATOR, "POST", "/api/ops/todos", {
          title: "x",
          owner: "operator",
          ownerUserId: H.A.admin,
        })
      ).status,
    ).toBe(422);
  });

  it("Later hides a to-do until the next weekday; done closes it", async () => {
    const snoozed = await ok<TodoView>("POST", `/api/ops/todos/${mine.id}/snooze`, {});
    expect(snoozed.state).toBe("snoozed");
    const at = new Date(snoozed.snoozedUntil as string);
    expect(at.getUTCHours()).toBe(9);
    expect([0, 6]).not.toContain(at.getUTCDay());
    expect((await list()).items.map((i) => i.id)).not.toContain(mine.id);
    const past = await H.call(OPERATOR, "POST", `/api/ops/todos/${mine.id}/snooze`, {
      until: "2020-01-01T00:00:00.000Z",
    });
    expect(past.status).toBe(422);
    const done = await ok<TodoView>("POST", `/api/ops/todos/${mine.id}/done`);
    expect(done.state).toBe("done");
    expect(
      (await H.call(OPERATOR, "PATCH", `/api/ops/todos/${mine.id}`, { title: "y" })).status,
    ).toBe(409);
  });

  // S4.3 (QA2 HM2): a to-do put off with Later couldn't be found again until it came back.
  it("lists what Later put off under Snoozed, and Bring back puts it on Yours at once", async () => {
    const later = await ok<TodoView>("POST", "/api/ops/todos", {
      title: "Call Dana back",
      owner: "operator",
      clientId: H.A.tenantId,
    });
    const other = await seed(
      { title: "C's to-do", owner: "operator", clientId: H.C.tenantId, source: "operator" },
      [H.C.tenantId],
    );
    await withOperator(H.db, [H.C.tenantId], (tx) =>
      tx
        .update(todo)
        .set({ state: "snoozed", snoozedUntil: new Date(Date.now() + 86_400_000) })
        .where(eq(todo.id, other.id)),
    );
    await ok<TodoView>("POST", `/api/ops/todos/${later.id}/snooze`, {});
    const snoozed = await ok<{ items: TodoView[] }>("GET", "/api/ops/todos/snoozed");
    expect(snoozed.items.map((i) => i.id)).toContain(later.id);
    // Only the clients served.
    expect(snoozed.items.map((i) => i.id)).not.toContain(other.id);
    expect(snoozed.items.find((i) => i.id === later.id)?.snoozedUntil).not.toBeNull();
    for (const who of [admin("a"), user("a")]) {
      expect((await H.call(who, "GET", "/api/ops/todos/snoozed")).status).toBe(403);
      expect((await H.call(who, "POST", `/api/ops/todos/${later.id}/wake`)).status).toBe(403);
    }

    const back = await ok<TodoView>("POST", `/api/ops/todos/${later.id}/wake`);
    expect(back).toMatchObject({ state: "open", snoozedUntil: null });
    expect((await list()).items.map((i) => i.id)).toContain(later.id);
    const after = await ok<{ items: TodoView[] }>("GET", "/api/ops/todos/snoozed");
    expect(after.items.map((i) => i.id)).not.toContain(later.id);
    // A closed one doesn't come back.
    await ok<TodoView>("POST", `/api/ops/todos/${later.id}/done`);
    expect((await H.call(OPERATOR, "POST", `/api/ops/todos/${later.id}/wake`)).status).toBe(409);
  });

  it("lists Reggie's and the clients', and Take it makes Reggie's yours", async () => {
    const r = await seed({
      title: "Chase Alder's requirements",
      owner: "reggie",
      clientId: H.A.tenantId,
      dueAt: new Date(Date.now() + 86_400_000),
      source: "reggie",
    });
    const c = await seed({
      title: "Connect Home Depot Pro",
      owner: "client",
      clientId: H.A.tenantId,
      dueAt: new Date(Date.now() - 2 * 86_400_000),
      source: "system",
    });
    // An open item on the client's Desk waits on them too, read from the inbox, not copied.
    const [desk] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: H.A.tenantId,
        kind: "request",
        title: "Sign 3 purchase orders",
        assigneeRole: "client_admin",
      })
      .returning();
    const reggie = await list("?owner=reggie");
    expect(reggie.items.map((i) => i.id)).toContain(r.id);
    const theirs = await list("?owner=client");
    expect(theirs.items.map((i) => i.id)).toEqual(expect.arrayContaining([c.id, desk?.id]));
    const deskLine = theirs.items.find((i) => i.id === desk?.id);
    expect(deskLine).toMatchObject({ source: "desk", editable: false, owner: "client" });
    expect(theirs.counts.lateClient).toBeGreaterThanOrEqual(1);
    // Only Reggie's are taken.
    expect((await H.call(OPERATOR, "POST", `/api/ops/todos/${c.id}/take`)).status).toBe(409);
    const taken = await ok<TodoView>("POST", `/api/ops/todos/${r.id}/take`);
    expect(taken).toMatchObject({ owner: "operator", ownerUser: { id: H.operator } });
    expect((await list("?owner=reggie")).items.map((i) => i.id)).not.toContain(r.id);
  });

  it("brings escalations to Yours, read from the inbox and done on their own screen", async () => {
    const [esc] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: H.A.tenantId,
        kind: "review",
        title: "An invoice we couldn't read",
        assigneeRole: "operator",
      })
      .returning();
    const yours = await list("?kind=other");
    const line = yours.items.find((i) => i.id === esc?.id);
    expect(line).toMatchObject({
      source: "escalation",
      editable: false,
      primary: { kind: "open" },
      client: { id: H.A.tenantId },
    });
    // The kind chips: escalations are under "Questions and runs", not Issues.
    expect((await list("?kind=issues")).items.map((i) => i.id)).not.toContain(esc?.id);
    // Not C's operator's.
    expect((await list("", OTHER_OPERATOR)).items.map((i) => i.id)).not.toContain(esc?.id);
  });

  it("Do it sends the edited reply through the issue's own route, then closes the to-do", async () => {
    const made = await ok<IssueDetail>("POST", "/api/ops/issues", {
      clientId: H.A.tenantId,
      title: "Ferguson bills held",
      text: "Pia keeps flagging the Ferguson bills.",
      urgency: "high",
    });
    const issueId = made.issue.id;
    const t = await seed({
      title: "Approve the fix for Hartley's Ferguson bills",
      owner: "operator",
      clientId: H.A.tenantId,
      about: { kind: "issue", id: issueId },
      source: "play",
      read: "The contract prices on file are from August.",
      sure: "Sure: the 11 bills all differ by about 4%.",
      plan: [
        { text: "Update Ferguson's contract prices", who: "operator", mode: "approve" },
        { text: "Re-check the 11 held bills", who: "reggie", mode: "auto" },
      ],
      draft: { to: "client", channel: "portal_email", text: "Hi Dana, the bills are right." },
      primaryAction: { label: "Approve and send", kind: "send_reply", ref: { issueId } },
    });
    const view = (await list("?kind=issues")).items.find((i) => i.id === t.id);
    expect(view).toMatchObject({
      tag: "Issue · high",
      kind: "issues",
      read: "The contract prices on file are from August.",
      plan: ["Update Ferguson's contract prices", "Re-check the 11 held bills"],
      primary: { label: "Approve and send", kind: "send_reply" },
      about: { kind: "issue", id: issueId, href: `/ops/issues/${issueId}` },
    });
    expect(view?.draft?.to).toMatch(/^To /);
    // The issue page's side panel lists it.
    expect((await list(`?about=issue:${issueId}`)).items.map((i) => i.id)).toContain(t.id);

    const acted = await ok<TodoActResult>("POST", `/api/ops/todos/${t.id}/act`, {
      draftText: "Hi Dana, the bills are right. We're updating Ferguson's prices today.",
    });
    expect(acted.todo.state).toBe("done");
    expect(acted.href).toBe(`/ops/issues/${issueId}`);
    const after = await ok<IssueDetail>("GET", `/api/ops/issues/${issueId}`);
    const sent = after.messages.find((m) => m.text.includes("updating Ferguson's prices"));
    expect(sent?.audience).toBe("client");
    expect(after.issue.firstReplyAt).not.toBeNull();
    // A closed to-do isn't done twice.
    expect((await H.call(OPERATOR, "POST", `/api/ops/todos/${t.id}/act`, {})).status).toBe(409);
  });

  it("Approve plan makes a to-do per step: Reggie's own steps its, the rest yours", async () => {
    const t = await seed({
      title: "Review the safety hold",
      owner: "operator",
      clientId: H.A.tenantId,
      plan: [
        { text: "Roll back to v6", who: "operator", mode: "approve" },
        { text: "Tell Mike the trial restarts Thursday", who: "reggie", mode: "auto" },
        { text: "Void the 14 duplicates", who: "client", mode: "approve" },
      ],
      primaryAction: { label: "Approve plan", kind: "approve_plan", ref: {} },
    });
    const acted = await ok<TodoActResult>("POST", `/api/ops/todos/${t.id}/act`, {});
    expect(acted.done).toBe("3 to-dos made from the plan.");
    const rows = await withOperator(H.db, [H.A.tenantId], (tx) =>
      tx.select().from(todo).where(eq(todo.clientId, H.A.tenantId)),
    );
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    expect(byTitle.get("Roll back to v6")?.owner).toBe("operator");
    expect(byTitle.get("Tell Mike the trial restarts Thursday")?.owner).toBe("reggie");
    expect(byTitle.get("Void the 14 duplicates")?.owner).toBe("client");
  });

  it("Decide on Reggie's urgency to-do sets the chosen urgency through the issue's route", async () => {
    const made = await ok<IssueDetail>("POST", "/api/ops/issues", {
      clientId: H.A.tenantId,
      title: "Report runs late",
      text: "The Monday report came at noon.",
      urgency: "high",
    });
    const issueId = made.issue.id;
    const t = await seed({
      title: "Confirm the urgency of Client A: normal",
      owner: "operator",
      clientId: H.A.tenantId,
      about: { kind: "issue", id: issueId },
      source: "play",
      playKey: "set_urgency",
      options: [
        { label: "Make it normal", value: "normal" },
        { label: "Keep it high", value: "high" },
      ],
      primaryAction: { label: "Decide", kind: "decide", ref: { issueId } },
    });
    const view = (await list(`?about=issue:${issueId}`)).items.find((i) => i.id === t.id);
    expect(view?.options).toEqual(["Make it normal", "Keep it high"]);
    const acted = await ok<TodoActResult>("POST", `/api/ops/todos/${t.id}/act`, { option: 0 });
    expect(acted.todo.state).toBe("done");
    const after = await ok<IssueDetail>("GET", `/api/ops/issues/${issueId}`);
    expect(after.issue.urgency).toBe("normal");
    // An option that isn't there is refused.
    const again = await seed({
      title: "Confirm again",
      owner: "operator",
      clientId: H.A.tenantId,
      about: { kind: "issue", id: issueId },
      options: [{ label: "Make it low", value: "low" }],
      primaryAction: { label: "Decide", kind: "decide", ref: { issueId } },
    });
    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/todos/${again.id}/act`, { option: 3 })).status,
    ).toBe(422);
  });

  it("leads every to-do about a record to the page where it is done", async () => {
    // QA (2026-11-22): "Record Susana Test's agreed price" opened a sheet with Later and Done
    // only; the terms form is on the deal's page.
    const dealId = "00000000-0000-4000-8000-0000000d0e01";
    const price = await seed({
      title: "Record Susana Test's agreed price",
      owner: "operator",
      clientId: H.A.tenantId,
      about: { kind: "deal", id: dealId },
      source: "system",
    });
    // An ask has no page of its own: its client's page is where it is answered.
    const askId = "00000000-0000-4000-8000-0000000a5c01";
    const ask = await seed({
      title: "Answer Hartley's question about the bill run",
      owner: "operator",
      clientId: H.A.tenantId,
      about: { kind: "client_ask", id: askId },
      source: "play",
    });
    const items = (await list()).items;
    expect(items.find((i) => i.id === price.id)?.about).toEqual({
      kind: "deal",
      id: dealId,
      href: `/ops/deals/${dealId}`,
    });
    expect(items.find((i) => i.id === ask.id)?.about).toEqual({
      kind: "client_ask",
      id: askId,
      href: `/ops/clients/${H.A.tenantId}`,
    });
  });

  it("Do it sends a deal email through the deal's route, and a refusal leaves the to-do open", async () => {
    const t = await seed({
      title: "First reply to Ridgeline",
      owner: "operator",
      draft: { to: "Karen Lowe", channel: "email", text: "Hi Karen" },
      primaryAction: {
        label: "Send",
        kind: "send_reply",
        ref: { dealId: "0190a7c0-0000-7000-8000-000000000001" },
      },
    });
    const res = await H.call(OPERATOR, "POST", `/api/ops/todos/${t.id}/act`, {});
    // No such deal (and no mailer in the harness): the route refuses and nothing is done.
    expect([404, 503]).toContain(res.status);
    const [row] = await withOperator(H.db, [H.A.tenantId], (tx) =>
      tx.select().from(todo).where(eq(todo.id, t.id)),
    );
    expect(row?.state).toBe("open");
  });

  it("shows what Reggie did today by flow, and a flag goes on the play's record", async () => {
    const [sent] = await H.t.db
      .insert(playLog)
      .values([
        {
          clientId: H.A.tenantId,
          flow: "issues",
          stage: "reported",
          play: "tell_client",
          level: "send",
          outcome: "sent",
          summary: "Told Hartley we have issue #1042.",
        },
        {
          clientId: null,
          flow: "new",
          stage: "lead",
          play: "research",
          level: "send",
          outcome: "done",
          internal: true,
          summary: "Researched Bayside Electric.",
        },
        {
          clientId: H.C.tenantId,
          flow: "questions",
          stage: "asked",
          play: "answer",
          level: "send",
          outcome: "sent",
          summary: "Answered C.",
        },
      ])
      .returning();
    const today = await ok<DoneToday>("GET", "/api/ops/todos/done-today");
    expect(today.groups.map((g) => g.name)).toEqual(["Issues", "New accounts"]);
    expect(today.groups[0]?.rows[0]).toMatchObject({ sent: true, flagged: false });
    expect(today.groups[1]?.rows[0]).toMatchObject({ sent: false });
    expect((await list()).counts.doneToday).toBe(2);
    await ok("POST", `/api/ops/play-log/${sent?.id}/flag`, { note: "Too early" });
    const again = await ok<DoneToday>("GET", "/api/ops/todos/done-today");
    expect(again.groups[0]?.rows[0]?.flagged).toBe(true);
    // C's operator can't flag A's.
    expect(
      (await H.call(OTHER_OPERATOR, "POST", `/api/ops/play-log/${sent?.id}/flag`, {})).status,
    ).toBe(404);
  });

  it("reads a client's activity across its tables, newest first, notes marked as ours", async () => {
    const made = await ok<IssueDetail>("POST", "/api/ops/issues", {
      clientId: H.A.tenantId,
      title: "Monday bills",
      text: "Bills scanned on Monday land in next week's table.",
    });
    await ok("POST", `/api/ops/issues/${made.issue.id}/messages`, {
      text: "Checked: it's the cut-off at 7:00.",
      audience: "operator",
    });
    await ok("POST", `/api/ops/issues/${made.issue.id}/messages`, {
      text: "We're on it.",
      audience: "client",
    });
    const all = await ok<ClientActivity>("GET", `/api/ops/clients/${H.A.tenantId}/activity`);
    const ats = all.items.map((i) => i.at);
    expect([...ats].sort().reverse()).toEqual(ats);
    const note = all.items.find((i) => i.text.includes("cut-off at 7:00"));
    expect(note).toMatchObject({ kind: "note", channel: "Internal note", filter: "messages" });
    expect(all.items.find((i) => i.text === "We're on it.")?.kind).toBe("out");
    expect(all.items.some((i) => i.filter === "decisions")).toBe(true);
    const msgs = await ok<ClientActivity>(
      "GET",
      `/api/ops/clients/${H.A.tenantId}/activity?filter=messages`,
    );
    expect(msgs.items.every((i) => i.filter === "messages")).toBe(true);
    // Nothing of A's for C's operator.
    expect(
      (await H.call(OTHER_OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/activity`)).status,
    ).toBe(404);
  });

  it("gives the client page its figures, its open work and its to-dos", async () => {
    const work = await ok<ClientWork>("GET", `/api/ops/clients/${H.A.tenantId}/work`);
    expect(work.kpis.map((k) => k.label)).toEqual([
      "A month",
      "Open issues",
      "Builds",
      "Sales open",
      "Questions",
    ]);
    expect(work.build.some((c) => c.kind === "issue" && c.href.startsWith("/ops/issues/"))).toBe(
      true,
    );
    expect(work.todos.length).toBeGreaterThan(0);
    expect(work.todos.every((t) => !t.client || t.client.id === H.A.tenantId)).toBe(true);
    expect(
      (await H.call(OTHER_OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/work`)).status,
    ).toBe(404);
  });
});
