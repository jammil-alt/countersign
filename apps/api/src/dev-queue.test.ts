// The Dev queue through the API (docs/plan.md §1.125), on local Postgres with RLS: a request filed
// from one build is the one a second build links to; it can't be accepted while its triage isn't
// done (an unjudged candidate, a reject that names nothing missing, an unapproved one-off, two
// parts); accepting tells every operator (email), Your call (a to-do) and each linked build; a
// claim is one session's; and a deploy whose catalog has the expected part ships it, checks the
// linked drafts again, closes a gap whose step validates and has the Builder propose the swap
// where it doesn't. Every move writes an event. Only operators reach it.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { FAKE_RESEND_MAIN, fakeResend } from "@countersign/connectors/testing";
import type { BuildDetail, CodeRequestDetail, FiledCodeRequest } from "@countersign/core";
import { build, buildMessage, codeRequest } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, OPERATOR, OTHER_OPERATOR } from "./api.test-helper";
import { resetShipCheck, shipPass } from "./dev-queue/ship";
import { mailerFromEnv } from "./notify/mailer";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const resend = fakeResend();
// No scripted answers: the reuse check's judge can't be reached, so candidates come back unjudged
// and the operator judges them, as the screen lets them.
const model = new FakeModel();
const env = {
  RESEND_API_KEY: FAKE_RESEND_MAIN.apiKey,
  RESEND_FALLBACK_DOMAIN: "mail.mezonas.test",
};
const h = await createApiHarness({ llm: model, env, fetch: resend.fetch });
afterAll(() => h?.close());

const SPEC = {
  summary: "Run date minus N days, months or years, and the start and end of a month.",
  inputs: ["a date", "an offset: a number of days, months or years"],
  outputs: ["a date"],
  rules: ["31 January plus one month is 28 February"],
  acceptance: ["Start of month of 17 November is 1 November"],
  parts: [TESTKIT_UPDATE_TOOL],
  packages: ["packages/connectors"],
};

describe.skipIf(!h)("the Dev queue", () => {
  const H = h as NonNullable<typeof h>;
  const call = async <T>(method: string, path: string, body?: unknown, who = OPERATOR) => {
    const res = await H.call(who, method, path, body);
    return { status: res.status, json: res.json as T };
  };
  const ok = async <T>(method: string, path: string, body?: unknown, who = OPERATOR) => {
    const res = await call<T>(method, path, body, who);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  };
  let first = "";
  let second = "";
  let withDraft = "";
  let request: CodeRequestDetail;

  it("is the operator's only", async () => {
    expect((await call("GET", "/api/ops/code-requests", undefined, admin("a"))).status).toBe(403);
  });

  it("files one request per capability: a second build links to the first one's", async () => {
    first = (
      await ok<BuildDetail>("POST", "/api/ops/builds", { kind: "agent", title: "Monthly report" })
    ).build.id;
    second = (
      await ok<BuildDetail>("POST", "/api/ops/builds", { kind: "agent", title: "AR aging" })
    ).build.id;
    const filed = await ok<FiledCodeRequest>("POST", "/api/ops/code-requests", {
      title: "Add date offsets to Reshape data",
      kind: "extend_existing",
      spec: SPEC,
      decision: "extend",
      decisionReason: "Reshape data's one-value operations are where a date offset belongs.",
      otherUses: ["Weekly AR aging summary"],
      openQuestions: [
        { question: "Which week starts Monday?", answer: null, mode: "investigate_during_build" },
      ],
      link: { buildId: first, workflowId: "monthly", stepId: "offset" },
      createdBy: "builder",
    });
    expect(filed.duplicate).toBeNull();
    request = filed.request as CodeRequestDetail;
    expect(request).toMatchObject({ status: "triage", createdBy: "builder", decision: "extend" });
    expect(request.ref).toMatch(/^DQ-\d{3}$/);
    expect(request.links).toHaveLength(1);
    // The build's gap item waits on it, owned by engineering.
    const b = await ok<BuildDetail>("GET", `/api/ops/builds/${first}`);
    const gap = b.items.find((i) => i.ref.codeRequestId === request.id);
    expect(gap).toMatchObject({
      kind: "gap",
      owner: "engineering",
      state: "waiting",
      stepId: "offset",
    });

    // The same capability from the second build comes back as the first one's request.
    const again = await ok<FiledCodeRequest>("POST", "/api/ops/code-requests", {
      title: "add date offsets to reshape data",
      kind: "extend_existing",
      spec: SPEC,
      link: { buildId: second, stepId: "offset" },
    });
    expect(again.request).toBeNull();
    expect(again.duplicate?.id).toBe(request.id);
    request = await ok<CodeRequestDetail>("POST", `/api/ops/code-requests/${request.ref}/links`, {
      buildId: second,
      stepId: "offset",
      merge: true,
    });
    expect(request.links).toHaveLength(2);
    expect(request.builds.map((x) => x.id).sort()).toEqual([first, second].sort());
    const { requests } = await ok<{ requests: { id: string }[]; openCount: number }>(
      "GET",
      "/api/ops/code-requests",
    );
    expect(requests.filter((r) => r.id === request.id)).toHaveLength(1);
  });

  it("won't accept until the triage is done, and says why", async () => {
    const refused = async () => {
      const res = await call<{ error: { message: string } }>(
        "POST",
        `/api/ops/code-requests/${request.id}/accept`,
      );
      expect(res.status).toBe(409);
      return res.json.error.message;
    };
    // The judge couldn't run: unjudged candidates.
    expect(request.moves.accept.allowed).toBe(false);
    expect(await refused()).toMatch(/judged|verdict/);
    const candidates = request.reuseCheck?.candidates ?? [];
    const verdicts = (missing: string) =>
      candidates.map((c) => ({
        partId: c.partId,
        verdict: "reject",
        reason: "It doesn't move a date by an amount.",
        missing,
      }));
    expect(candidates.length).toBeGreaterThan(0);
    request = await ok("PATCH", `/api/ops/code-requests/${request.id}`, {
      verdicts: verdicts("Not it."),
    });
    expect(await refused()).toMatch(/doesn't say what it lacks/);
    request = await ok("PATCH", `/api/ops/code-requests/${request.id}`, {
      verdicts: verdicts("No offset by months or years, and no start or end of month."),
    });
    // Two parts: split it first.
    request = await ok("PATCH", `/api/ops/code-requests/${request.id}`, {
      spec: { ...SPEC, parts: [TESTKIT_UPDATE_TOOL, "data.group_list#sort"] },
    });
    expect(await refused()).toMatch(/Split it/);
    // A one-off needs approval.
    request = await ok("PATCH", `/api/ops/code-requests/${request.id}`, {
      spec: SPEC,
      decision: "one_off",
    });
    expect(await refused()).toMatch(/approval/);
    expect(request.moves.approve_one_off.allowed).toBe(true);
    request = await ok("PATCH", `/api/ops/code-requests/${request.id}`, { decision: "extend" });
    expect(request.moves.accept).toEqual({ allowed: true, reason: "" });
  });

  it("tells every operator, Your call and each linked build when it's accepted", async () => {
    const before = resend.emails.length;
    request = await ok("POST", `/api/ops/code-requests/${request.ref}/accept`);
    expect(request.status).toBe("accepted");
    const mails = resend.emails.slice(before);
    expect(mails.map((m) => m.to[0]).sort()).toEqual(
      ["operator@example.com", "other-operator@example.com"].sort(),
    );
    expect(mails[0]?.subject).toBe(`${request.ref} approved: Add date offsets to Reshape data`);
    const { notices } = await ok<{ notices: { title: string; href: string }[] }>(
      "GET",
      "/api/ops/dev-queue/notices",
    );
    expect(notices[0]?.title).toBe(
      `${request.ref} approved: Add date offsets to Reshape data. Building it next.`,
    );
    expect(notices[0]?.href).toContain("tab=dev-queue");
    for (const id of [first, second]) {
      const b = await ok<BuildDetail>("GET", `/api/ops/builds/${id}`);
      expect(b.messages.some((m) => m.text.startsWith(`${request.ref} approved`))).toBe(true);
    }
    expect(request.events.some((e) => e.kind === "notified")).toBe(true);
  });

  it("lets one session claim it, and only that one attach the PR", async () => {
    request = await ok("POST", `/api/ops/code-requests/${request.id}/claim`);
    expect(request.status).toBe("in_progress");
    const theirs = await call<{ error: { message: string } }>(
      "POST",
      `/api/ops/code-requests/${request.id}/claim`,
      undefined,
      OTHER_OPERATOR,
    );
    expect(theirs.status).toBe(409);
    expect(theirs.json.error.message).toMatch(/Someone has it/);
    const pr = {
      prUrl: "https://github.com/acme/app/pull/12",
      expectedPartId: TESTKIT_UPDATE_TOOL,
    };
    expect(
      (await call("POST", `/api/ops/code-requests/${request.id}/pr`, pr, OTHER_OPERATOR)).status,
    ).toBe(409);
    request = await ok("POST", `/api/ops/code-requests/${request.id}/pr`, pr);
    expect(request.inReview).toBe(true);
  });

  it("ships when the deploy's catalog has the part: closes what validates, proposes the swap where not", async () => {
    // A third build has a draft whose step "offset" is still a missing step.
    const created = await ok<{ agent: { id: string } }>("POST", "/api/ops/templates", {
      slug: "monthly-report",
      bundle: {
        schemaVersion: 1,
        definition: {
          schemaVersion: 2,
          identity: { name: "Monthly report", role: "Reports", mission: "Report the month" },
          kind: "functional",
          model: { id: "claude-sonnet-5-5" },
          instructions: "Report the month.",
          skills: [],
          permissions: { mode: "suggest_only" },
        },
        workflows: [
          {
            slug: "monthly",
            name: "Monthly report",
            workflow: {
              schemaVersion: 4,
              triggers: [{ id: "t", on: { type: "manual", input: {} } }],
              steps: [
                {
                  id: "offset",
                  name: "Offset the run date",
                  kind: "missing",
                  need: "Run date minus one month",
                },
              ],
            },
          },
        ],
      },
    });
    withDraft = (
      await ok<BuildDetail>("POST", "/api/ops/builds", { kind: "agent", title: "Board pack" })
    ).build.id;
    await H.t.db
      .update(build)
      .set({ agentId: created.agent.id, phase: "draft" })
      .where(eq(build.id, withDraft));
    request = await ok("POST", `/api/ops/code-requests/${request.id}/links`, {
      buildId: withDraft,
      workflowId: "monthly",
      stepId: "offset",
    });

    // The Builder's Steps tab marks the step as requiring code, with the request's status.
    const steps = await ok<{
      steps: { stepId: string; request: { ref: string; status: string; inReview: boolean } }[];
    }>("GET", `/api/ops/agents/${created.agent.id}/code-requests`);
    expect(steps.steps).toEqual([
      expect.objectContaining({
        stepId: "offset",
        request: expect.objectContaining({
          ref: request.ref,
          status: "in_progress",
          inReview: true,
        }),
      }),
    ]);
    const detail = await ok<BuildDetail>("GET", `/api/ops/builds/${withDraft}`);
    expect(detail.codeRequests?.[0]?.request.ref).toBe(request.ref);

    const before = resend.emails.length;
    resetShipCheck();
    const shipped = await shipPass(
      {
        db: H.db,
        platform: H.platform,
        notify: {
          mailer: mailerFromEnv(H.env, resend.fetch),
          origin: "https://staging.mezonas.test",
        },
        environment: "staging",
      },
      new Date(),
    );
    expect(shipped).toEqual([request.id]);
    request = await ok("GET", `/api/ops/code-requests/${request.ref}`);
    expect(request).toMatchObject({ status: "shipped", shippedPartId: TESTKIT_UPDATE_TOOL });
    expect(request.shippedStagingAt).not.toBeNull();
    expect(request.shippedProductionAt).toBeNull();
    expect(resend.emails.slice(before)[0]?.subject).toMatch(/is on staging/);

    // No draft in the first build: nothing holds the step, so its gap item is closed.
    const a = await ok<BuildDetail>("GET", `/api/ops/builds/${first}`);
    expect(a.items.find((i) => i.ref.codeRequestId === request.id)?.state).toBe("done");
    // The draft's step is still missing there: the Builder proposes putting the part in.
    const msgs = await H.t.db
      .select()
      .from(buildMessage)
      .where(eq(buildMessage.buildId, withDraft));
    const swap = msgs.find((m) => (m.meta as { proposal?: unknown }).proposal);
    expect(swap?.text).toMatch(
      new RegExp(`${request.ref} is in: .*I'd put it in the step “Offset the run date”`),
    );
    const meta = (swap?.meta ?? {}) as { proposal?: { action: { do: string; stepId: string } } };
    expect(meta.proposal?.action).toMatchObject({
      do: "edit_draft",
      stepId: "offset",
    });
    const c = await ok<BuildDetail>("GET", `/api/ops/builds/${withDraft}`);
    expect(c.items.find((i) => i.ref.codeRequestId === request.id)?.state).toBe("waiting");

    // Every move wrote an event.
    const kinds = new Set(request.events.map((e) => e.kind));
    for (const k of ["status", "reuse_check", "merge", "claim", "pr", "shipped", "notified"]) {
      expect(kinds.has(k as never), k).toBe(true);
    }
    // Shipped once: the pass again changes nothing.
    resetShipCheck();
    expect(
      await shipPass(
        {
          db: H.db,
          platform: H.platform,
          notify: { mailer: mailerFromEnv(H.env, resend.fetch), origin: "https://x" },
          environment: "staging",
        },
        new Date(),
      ),
    ).toEqual([]);
  });

  it("closes only with a reason, and a merge only into another request", async () => {
    const filed = await ok<FiledCodeRequest>("POST", "/api/ops/code-requests", {
      title: "Add division to Reshape data",
      kind: "extend_existing",
      spec: SPEC,
    });
    const id = (filed.request as CodeRequestDetail).id;
    expect(
      (await call("POST", `/api/ops/code-requests/${id}/close`, { reason: "merged" })).status,
    ).toBe(409);
    const closed = await ok<CodeRequestDetail>("POST", `/api/ops/code-requests/${id}/close`, {
      reason: "merged",
      mergedInto: request.ref,
    });
    expect(closed).toMatchObject({
      status: "closed",
      closeReason: "merged",
      mergedInto: { ref: request.ref },
    });
    const [row] = await H.t.db.select().from(codeRequest).where(eq(codeRequest.id, id));
    expect(row?.closedAt).not.toBeNull();
  });
});
