// builder-plan.md B1: try a build's draft on real examples in the POC test. The operator uploads a
// document to the Sandbox (the back office's Sandbox upload, kept quiet), picks one of the
// Sandbox's records (docs/open.md G3), or gives an input; it is
// saved as a try (a shared test case, `try:<build id>`, not required) and run alone through the
// test bench's own run route (a partial suite run: a test, never a write). The result is what the
// agent would do. Right: the try is kept as a required case whose expected answer is that result.
// Wrong: the operator says why in the conversation and the Builder proposes the fix. The gate is
// unchanged: every required case passes on the latest version, so kept examples are what it counts.

import { documentForTool, latestVersion } from "@countersign/agents";
import {
  type AnyAgentBundle,
  allTriggers,
  type BuildDetail,
  type Fixture,
  isExtractable,
  isPlainObject,
  type RouteSpec,
  routes,
  type SkillDefinition,
  TestCaseFields,
  type TestTargetKind,
  type TryBody,
  type TryRecordKind,
  testCaseProblems,
} from "@countersign/core";
import {
  document,
  receivable,
  skillVersion,
  type Tx,
  testCase,
  transaction,
  vendor,
} from "@countersign/db";
import { getDocument } from "@countersign/documents";
import { and, eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { keptAnswer } from "../build/kept";
import {
  addEvent,
  type BuildRow,
  buildDetail,
  latestSkillVersion,
  readBuild,
} from "../build/store";
import { tryStartedAt, tryViews } from "../build/tries";
import {
  type AppEnv,
  HttpError,
  invokeRoute,
  type LongHandlerCtx,
  mountLong,
  notFound,
  type Scoped,
  type Services,
} from "../http";
import { keptRef, tryRef } from "../testbench/partial";
import { sandboxClient } from "./testbench";

const now = () => new Date();
/** The longest name a try's case takes (the test bench allows 200). */
const NAME_MAX = 200;

interface Target {
  kind: TestTargetKind;
  id: string;
  versionId: string;
}

/** What a try runs on, for the workflow it goes to: its trigger's event, or a start by hand. */
type TryOn = "document" | "input" | TryRecordKind;

/** The event each kind of example arrives as (builder-plan.md B1; docs/open.md G3). */
const TRY_EVENT: Record<Exclude<TryOn, "input">, string> = {
  document: "document.received",
  transaction: "transaction.created",
  receivable: "receivable.created",
};

/** The document tool a skill's try on a document answers from the case's fixtures. */
const DOC_READ_TOOL = "docs.get";

function refuseClosed(row: BuildRow): void {
  if (row.status !== "open") {
    throw new HttpError(409, "build_closed", `this build is ${row.status}`);
  }
}

function refuseNotPoc(row: BuildRow): void {
  if (row.phase !== "poc") {
    throw new HttpError(409, "not_poc", "examples are tried in the POC test");
  }
}

/** What the build's tests run on: its skill's or template's latest version (suite mode only). */
async function suiteTarget(scoped: Scoped, services: Services, row: BuildRow): Promise<Target> {
  const detail = await buildDetail({ tx: scoped.tx, services, now }, row);
  if (row.kind === "skill") {
    const skillId = detail.draft?.skillId;
    const versionId = skillId ? await latestSkillVersion(scoped.tx, skillId) : null;
    if (!skillId || !versionId) throw new HttpError(409, "no_draft", "the skill isn't saved yet");
    return { kind: "skill", id: skillId, versionId };
  }
  const versionId = detail.draft?.versionId;
  if (!detail.draft?.agentId || !versionId) {
    throw new HttpError(409, "no_draft", "there is no draft yet");
  }
  if (detail.poc?.mode !== "suite") {
    throw new HttpError(409, "test_runs", "a client agent is tested with test runs on its page");
  }
  return { kind: "template", id: detail.draft.agentId, versionId };
}

type Flow = AnyAgentBundle["workflows"][number];

/**
 * The template's workflow a try runs: the one named, else the first that starts on the example's
 * event (a document, a record) or by hand (an input), else the first that's on.
 */
// DECISION (builder-plan.md B1): a document goes to the workflow that starts on
// `document.received`, with the payload that event would carry; an input to the workflow started by
// hand. Without one, the first workflow that's on gets it: the operator can name another.
// DECISION (docs/open.md G3): a Sandbox record goes the same way, to the workflow that starts on
// its `*.created` event (a purchase or bill: `transaction.created`; an invoice to a customer:
// `receivable.created`), then to one started by hand, then to the first that's on.
export function tryWorkflow(
  bundle: Pick<AnyAgentBundle, "workflows">,
  as: TryOn,
  slug?: string,
): string {
  const flows = bundle.workflows.filter((w) => w.enabled !== false);
  if (slug) {
    const named = bundle.workflows.find((w) => w.slug === slug);
    if (!named) throw new HttpError(422, "invalid_request", `the draft has no workflow "${slug}"`);
    return named.slug;
  }
  const startsOn = (w: Flow, on: TryOn) =>
    allTriggers(w.workflow).some((t) =>
      on === "input"
        ? t.on.type === "manual"
        : t.on.type === "event" && t.on.event === TRY_EVENT[on],
    );
  const byHand = as === "transaction" || as === "receivable";
  const flow =
    flows.find((w) => startsOn(w, as)) ??
    (byHand ? flows.find((w) => startsOn(w, "input")) : undefined) ??
    flows[0];
  if (!flow) throw new HttpError(422, "invalid_request", "the draft has no workflow to try");
  return flow.slug;
}

/**
 * A Sandbox record as a try: its name and the payload its `*.created` event carries (the fields
 * the sync's events carry: `qbo/store.ts`, `qbo/receivables.ts`).
 */
async function recordTry(
  tx: Tx,
  sandbox: string,
  record: NonNullable<TryBody["record"]>,
): Promise<{ name: string; payload: Record<string, unknown> }> {
  if (record.kind === "transaction") {
    const [t] = await tx
      .select({ row: transaction, vendorName: vendor.name })
      .from(transaction)
      .leftJoin(
        vendor,
        and(eq(vendor.id, transaction.vendorId), eq(vendor.tenantId, transaction.tenantId)),
      )
      .where(and(eq(transaction.id, record.id), eq(transaction.tenantId, sandbox)));
    if (!t) throw notFound("record in the Sandbox");
    const r = t.row;
    const from = t.vendorName ? ` from ${t.vendorName}` : "";
    return {
      name: `Try: ${r.kind.replace(/_/g, " ")}${from}, ${r.total} ${r.currency}`,
      payload: {
        transactionId: r.id,
        source: r.connector,
        vendorId: r.vendorId,
        total: { amount: r.total, currency: r.currency },
        txnDate: r.txnDate,
      },
    };
  }
  const [r] = await tx
    .select()
    .from(receivable)
    .where(and(eq(receivable.id, record.id), eq(receivable.tenantId, sandbox)));
  if (!r) throw notFound("record in the Sandbox");
  return {
    name: `Try: invoice${r.docNumber ? ` ${r.docNumber}` : ""} to ${r.customerName}`,
    payload: {
      receivableId: r.id,
      source: r.connector,
      organizationId: r.organizationId,
      total: { amount: r.total, currency: r.currency },
      balance: { amount: r.balance, currency: r.currency },
      dueDate: r.dueDate,
      status: r.status,
    },
  };
}

/** Whether a skill's input takes a document by its id (a `documentId` property). */
function takesDocument(def: Pick<SkillDefinition, "input">): boolean {
  const props = isPlainObject(def.input) ? def.input.properties : undefined;
  return isPlainObject(props) && Object.hasOwn(props, "documentId");
}

/**
 * A skill tried on a Sandbox document: its input names the document, and the document as it is
 * now (its details and its reading, without the link to the file) answers the skill's document
 * read from the case's fixtures. It runs on the test bench as any skill case does: nothing is
 * written.
 */
// DECISION (docs/open.md G3): skill cases run on fixtures only, so the document reaches the skill
// as a fixture made from it now: `docs.get` with its id answers the document and its latest
// reading. A kept try keeps that fixture, so it runs the same way every time after. The 5-minute
// link to the file is left out (it would expire in the case). A read that makes a new reading
// (`docs.read`, `docs.extract`) records something, which the bench refuses as it refuses every
// write. A document not read yet is refused (409 `not_read`) rather than tried without its reading.
async function skillDocumentTry(
  scoped: Scoped,
  target: Target,
  documentId: string,
): Promise<{ name: string; input: unknown; fixtures: Fixture[] }> {
  const { tx } = scoped;
  const [v] = await tx
    .select({ definition: skillVersion.definition })
    .from(skillVersion)
    .where(eq(skillVersion.id, target.versionId));
  if (!v || !takesDocument(v.definition as SkillDefinition)) {
    throw new HttpError(
      422,
      "invalid_request",
      "this skill's input takes no document (no documentId): give it an input",
    );
  }
  const sandbox = await sandboxClient(scoped);
  const view = await getDocument(tx, sandbox, documentId);
  if (!view) throw notFound("document in the Sandbox");
  const d = view.document;
  if (!view.extraction && isExtractable(d.mimeType)) {
    if (d.status === "failed") {
      throw new HttpError(422, "not_read", "the document couldn't be read: try another one");
    }
    throw new HttpError(
      409,
      "not_read",
      "the document is still being read: try it again in a moment",
    );
  }
  const doc = await documentForTool(view, null);
  return {
    name: `Try: ${d.filename}`.slice(0, NAME_MAX),
    input: { documentId: d.id },
    fixtures: [
      {
        tool: DOC_READ_TOOL,
        input: { documentId: d.id },
        output: { ...doc, sources: [d.id, ...(doc.extraction ? [doc.extraction.id] : [])] },
      },
    ],
  };
}

/** The try's name, input (a skill's, or a template's `{workflow, payload}`) and fixtures. */
async function tryCase(
  scoped: Scoped,
  target: Target,
  body: TryBody,
): Promise<{ name: string; input: unknown; fixtures?: Fixture[] }> {
  const { tx } = scoped;
  if (target.kind === "skill") {
    if (body.documentId) return skillDocumentTry(scoped, target, body.documentId);
    if (body.record) {
      // DECISION (docs/open.md G3): a skill is tried on its input or a document; a record's id
      // goes in the input as JSON.
      throw new HttpError(
        422,
        "invalid_request",
        "a skill is tried on an input or a document: give the record's id in its input",
      );
    }
    return { name: "Try: your input", input: body.input ?? null };
  }
  const v = await latestVersion(tx, target.id);
  const bundle = (v?.bundle ?? { workflows: [] }) as Pick<AnyAgentBundle, "workflows">;
  if (body.record) {
    // The record is the Sandbox's: where a shared template case runs (routes/testbench.ts).
    const made = await recordTry(tx, await sandboxClient(scoped), body.record);
    return {
      name: made.name.slice(0, NAME_MAX),
      input: {
        workflow: tryWorkflow(bundle, body.record.kind, body.workflow),
        payload: made.payload,
      },
    };
  }
  if (body.documentId) {
    // The document is the Sandbox's: where a shared template case runs (routes/testbench.ts).
    const sandbox = await sandboxClient(scoped);
    const [doc] = await tx
      .select()
      .from(document)
      .where(and(eq(document.id, body.documentId), eq(document.tenantId, sandbox)));
    if (!doc) throw notFound("document in the Sandbox");
    return {
      name: `Try: ${doc.filename}`.slice(0, NAME_MAX),
      input: {
        workflow: tryWorkflow(bundle, "document", body.workflow),
        payload: {
          documentId: doc.id,
          source: doc.source,
          filename: doc.filename,
          mimeType: doc.mimeType,
          sha256: doc.sha256,
        },
      },
    };
  }
  await sandboxClient(scoped);
  const input = body.input;
  // `{workflow, payload}` as the test bench takes it, or the trigger's payload alone.
  if (
    isPlainObject(input) &&
    typeof input.workflow === "string" &&
    isPlainObject(input.payload) &&
    Object.keys(input).length === 2
  ) {
    return {
      name: "Try: your input",
      input: { workflow: tryWorkflow(bundle, "input", input.workflow), payload: input.payload },
    };
  }
  if (!isPlainObject(input)) {
    throw new HttpError(
      422,
      "invalid_request",
      "a template's input is its trigger's payload: an object",
    );
  }
  return {
    name: "Try: your input",
    input: { workflow: tryWorkflow(bundle, "input", body.workflow), payload: input },
  };
}

/** A try of this build not kept or discarded yet. */
async function pendingTry(tx: Tx, target: Target, buildId: string, caseId: string) {
  const [c] = await tx
    .select()
    .from(testCase)
    .where(
      and(
        eq(testCase.id, caseId),
        eq(testCase.targetKind, target.kind),
        eq(testCase.targetId, target.id),
        eq(testCase.sourceRef, tryRef(buildId)),
        isNull(testCase.tenantId),
        isNull(testCase.archivedAt),
      ),
    );
  if (!c) throw notFound("try");
  return c;
}

export function buildTryRoutes(app: Hono<AppEnv>): void {
  const detailOf = (ctx: Pick<LongHandlerCtx<RouteSpec>, "inTx" | "services">, id: string) =>
    ctx.inTx(
      async (scoped): Promise<BuildDetail> =>
        buildDetail({ tx: scoped.tx, services: ctx.services, now }, await readBuild(scoped.tx, id)),
    );

  mountLong(app, routes.opsBuildTry, async (ctx) => {
    const { body, session } = ctx;
    const id = ctx.params.id;
    const started = await ctx.inTx(async (scoped) => {
      const row = await readBuild(scoped.tx, id, true);
      refuseClosed(row);
      refuseNotPoc(row);
      const target = await suiteTarget(scoped, ctx.services, row);
      if (body.caseId) {
        const c = await pendingTry(scoped.tx, target, row.id, body.caseId);
        return { target, caseId: c.id };
      }
      const made = await tryCase(scoped, target, body);
      // DECISION (builder-plan.md B1): a try is a shared case (tenant_id null): the Sandbox holds
      // synthetic data, a shared template case runs there, and the build's own test runs are of
      // the shared cases, so a kept try is one the gate counts.
      const [c] = await scoped.tx
        .insert(testCase)
        .values({
          tenantId: null,
          targetKind: target.kind,
          targetId: target.id,
          name: made.name,
          input: made.input,
          fixtures: made.fixtures ?? [],
          // Nothing expected yet: any output passes, and a template's try records every step's.
          expected: {},
          matcher: { kind: "subset", tolerances: {} },
          required: false,
          source: "manual",
          sourceRef: tryRef(row.id),
          createdBy: session.user.id,
        })
        .returning({ id: testCase.id });
      if (!c) throw new Error("try insert returned nothing");
      await addEvent(scoped.tx, row, {
        kind: "record",
        payload: { tried: { caseId: c.id, name: made.name } },
        userId: session.user.id,
      });
      return { target, caseId: c.id };
    });
    // The test bench's run of this one case, as the operator (its scope, checks and audit row).
    await invokeRoute(
      app,
      ctx.c,
      session,
      routes.opsRunTests,
      {
        body: {
          targetKind: started.target.kind,
          targetId: started.target.id,
          versionId: started.target.versionId,
          caseIds: [started.caseId],
        },
      },
      "build",
    );
    return detailOf(ctx, id);
  });

  mountLong(app, routes.opsBuildTryDecide, async (ctx) => {
    const { params, body, session } = ctx;
    await ctx.inTx(async (scoped) => {
      const row = await readBuild(scoped.tx, params.id, true);
      refuseClosed(row);
      refuseNotPoc(row);
      const target = await suiteTarget(scoped, ctx.services, row);
      const c = await pendingTry(scoped.tx, target, row.id, params.caseId);
      if (body.decide === "discard") {
        await scoped.tx
          .update(testCase)
          .set({ archivedAt: now() })
          .where(and(eq(testCase.id, c.id), isNull(testCase.tenantId)));
        await addEvent(scoped.tx, row, {
          kind: "record",
          payload: { discarded: { caseId: c.id, name: c.name } },
          userId: session.user.id,
        });
        return;
      }
      const [t] = await tryViews(scoped.tx, target, row.id, target.versionId, c.id);
      if (t?.status !== "done") {
        throw new HttpError(409, "not_tried", "keep a try once it has run without an error");
      }
      // DECISION (builder-plan.md B1): the result is kept as it is, less what its own run made
      // (build/kept.ts), compared as a subset (more fields are fine); a field that should be
      // looser is set in the test bench.
      const startedAt = await tryStartedAt(scoped.tx, target, c.id);
      const expected = startedAt ? keptAnswer(t.output, startedAt) : t.output;
      const problems = [
        ...(expected === null ? ["nothing in the result stays the same from run to run"] : []),
        ...testCaseProblems(target.kind, {
          input: c.input,
          expected,
          matcher: { kind: "subset", tolerances: {} },
        }),
        ...(TestCaseFields.shape.expected.safeParse(expected).success
          ? []
          : ["the result is too large to keep as a test case"]),
      ];
      if (problems.length > 0) {
        throw new HttpError(422, "invalid_test_case", problems.join("; "), problems);
      }
      await scoped.tx
        .update(testCase)
        .set({
          name: (c.name.replace(/^Try: /, "") || c.name).slice(0, NAME_MAX),
          expected,
          required: true,
          sourceRef: keptRef(row.id),
        })
        .where(and(eq(testCase.id, c.id), isNull(testCase.tenantId)));
      await addEvent(scoped.tx, row, {
        kind: "record",
        payload: { kept: { caseId: c.id, name: c.name } },
        userId: session.user.id,
      });
    });
    return detailOf(ctx, params.id);
  });
}
