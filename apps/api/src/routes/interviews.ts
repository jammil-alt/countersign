// The process interview (docs/plan.md §1.217, the owner's build plan 8). The public page's routes:
// a contact opens the interview with its signed link, no sign-in, answers one question at a time
// (or says they don't know, or that a number is an estimate), adds sample files and finishes. And
// the back office's: start one for one of a client's contacts (the link comes back to send), read
// it, close it, and draft the client's agent from a finished one with a reuse check over its map.
// Everything is scoped to the one interview the link names, in its own client (invariant 1). What
// the person writes is kept as data, never read as instructions (invariant 9); the page shows the
// client's name and the process, never an agent, a prompt or a cost (invariant 11).

import {
  FALLBACK_QUESTION,
  InterviewError,
  nextQuestion,
  searchCatalog,
  summarizeInterview,
  unjudged,
} from "@countersign/agents";
import { ContentStore, documentMimeType } from "@countersign/connectors";
import {
  answersGiven,
  areaSection,
  INTERVIEW_LINK_DAYS,
  INTERVIEW_MAX_ANSWERS,
  INTERVIEW_MAX_FILES,
  type InterviewOutputs,
  InterviewOutputs as InterviewOutputsSchema,
  type InterviewReuse,
  type InterviewTurn,
  interviewRoutes,
  interviewTopics,
  routes,
} from "@countersign/core";
import { contact, processInterview, type Tx, tenant, withTenant } from "@countersign/db";
import { DocumentError, MAX_DOCUMENT_BYTES, storeDocument } from "@countersign/documents";
import { createLlmClient, DEFAULT_MODELS, type LlmCallRecord } from "@countersign/llm";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { requestOrigin } from "../audit";
import { readableLimited } from "../body";
import { clientModels, clientsRefusingModel } from "../compliance/models";
import { reuseIndex } from "../dev-queue/catalog";
import {
  type AppEnv,
  ensureClient,
  HttpError,
  invokeRoute,
  mount,
  mountLong,
  mountPublic,
  type Services,
} from "../http";
import {
  addCost,
  filesOf,
  type InterviewRow,
  isOpen,
  logEntry,
  opsView,
  pageView,
  readInterview,
  summaries,
  turnsOf,
  verifyInterviewLink,
} from "../interview/service";
import { originOf } from "../notify/outbox";
import { packAreaSections } from "../onboarding/guide-sources";
import { draftNow, type LongCtx } from "./ops-builds";

const tokenOf = (c: { req: { param(name: string): string | undefined } }) =>
  c.req.param("token") ?? "";

const gone = () => new HttpError(404, "not_found", "This link has expired or doesn't exist.");
const closed = () => new HttpError(409, "closed", "This interview no longer takes answers.");

// DECISION: the interviewer's model, held to the client's HIPAA mode like every other call on a
// client's data (§1.35): a client in HIPAA mode whose model vendor isn't covered is refused at
// the start, before a link goes out, and any later call is refused before anything is sent.
const INTERVIEW_MODEL = DEFAULT_MODELS.reasoning;

/** The interview a link names, in its own client; 404 for anything forged, expired or missing. */
async function linked(services: Services, token: string) {
  const ref = await verifyInterviewLink(services.env, token);
  if (!ref) throw gone();
  return ref;
}

function modelsFor(services: Services, tenantId: string) {
  return createLlmClient({
    transport: clientModels(services, { clients: [tenantId], read: services.db }),
  });
}

/** The interview as the interviewer reads it: the client's name, the topics, the file names. */
async function interviewInput(tx: Tx, services: Services, row: InterviewRow) {
  const [client] = await tx
    .select({ name: tenant.name })
    .from(tenant)
    .where(eq(tenant.id, row.tenantId));
  const area = row.area as Parameters<typeof areaSection>[0] | null;
  const section = area ? areaSection(area, packAreaSections(services.platform)) : null;
  return {
    process: row.process,
    client: client?.name ?? "",
    topics: interviewTopics(section),
    turns: turnsOf(row),
    files: filesOf(row).map((f) => f.filename),
  };
}

const lowerFirst = (t: string) => (t ? t[0]?.toLowerCase() + t.slice(1) : t);

// DECISION: the first question is fixed words, so starting an interview calls no model and the
// person's first answer is about how the process begins.
export const firstQuestion = (process: string) => `What starts ${lowerFirst(process)} today?`;

/**
 * Finishes an interview: the map from what was said, held to the answers (core `groundOutputs`).
 * Claimed by its status in a short transaction, so a second Finish answers the first's result.
 */
async function finish(c: Context, services: Services, ref: { tenantId: string; id: string }) {
  const at = new Date();
  const claimed = await withTenantTx(services, ref.tenantId, async (tx) => {
    const row = await readInterview(tx, ref.tenantId, ref.id, true);
    if (row.status === "finished") return null;
    if (!isOpen(row, at)) throw closed();
    if (answersGiven(turnsOf(row)) === 0) {
      throw new HttpError(409, "nothing_yet", "Answer at least one question first.");
    }
    // The waiting question is taken off while the map is written: no answer comes in meanwhile.
    await tx
      .update(processInterview)
      .set({ question: null, log: logEntry("finishing", requestOrigin(c)) })
      .where(and(eq(processInterview.id, row.id), eq(processInterview.tenantId, row.tenantId)));
    return { row, input: await interviewInput(tx, services, row) };
  });
  if (!claimed) return;
  let outputs: InterviewOutputs;
  let calls: LlmCallRecord[];
  try {
    ({ outputs, calls } = await summarizeInterview(claimed.input, {
      llm: modelsFor(services, ref.tenantId),
      model: INTERVIEW_MODEL,
    }));
  } catch (error) {
    // The question is put back so the person can try again.
    await withTenantTx(services, ref.tenantId, (tx) =>
      tx
        .update(processInterview)
        .set({
          question: claimed.row.question,
          costUsd: addCost(claimed.row.costUsd, error instanceof InterviewError ? error.calls : []),
          log: logEntry("finish_failed", {}),
        })
        .where(
          and(
            eq(processInterview.id, ref.id),
            eq(processInterview.tenantId, ref.tenantId),
            eq(processInterview.status, "open"),
          ),
        ),
    );
    throw new HttpError(502, "try_again", "We couldn't finish just now. Try again.");
  }
  await withTenantTx(services, ref.tenantId, async (tx) => {
    const row = await readInterview(tx, ref.tenantId, ref.id, true);
    if (row.status !== "open") return;
    await tx
      .update(processInterview)
      .set({
        status: "finished",
        outputs,
        finishedAt: new Date(),
        question: null,
        costUsd: addCost(row.costUsd, calls),
        log: logEntry("finished", {}, { steps: outputs.map.steps.length }),
      })
      .where(and(eq(processInterview.id, row.id), eq(processInterview.tenantId, row.tenantId)));
  });
}

// The public routes open their own short transactions (no session scope), each setting exactly one
// client.
function withTenantTx<T>(services: Services, tenantId: string, work: (tx: Tx) => Promise<T>) {
  return withTenant(services.db, tenantId, work);
}

async function viewOf(services: Services, ref: { tenantId: string; id: string }) {
  return withTenantTx(services, ref.tenantId, async (tx) =>
    pageView(tx, await readInterview(tx, ref.tenantId, ref.id), new Date()),
  );
}

/** For each step of the map, the catalog's parts that may already do it (unjudged). */
// DECISION: the reuse check's find pass (§1.125's deterministic search) per step, top 3 each, with
// no judge: the operator reads them beside the draft, and a step the Builder can't draft becomes a
// gap whose Dev queue request runs the full check with its judge.
export function reuseOf(
  outputs: InterviewOutputs,
  index: Parameters<typeof searchCatalog>[0],
  now: Date,
): InterviewReuse {
  return {
    ranAt: now.toISOString(),
    steps: outputs.map.steps.map((s) => ({
      stepId: s.id,
      candidates: searchCatalog(index, {
        query: [s.name, s.detail, s.tool].filter(Boolean).join(" "),
      })
        .slice(0, 3)
        .map(unjudged),
    })),
  };
}

export function interviewRoutesFor(app: Hono<AppEnv>): void {
  // DECISION: the page's routes are public and write no audit row: the person acting is the
  // contact, not a signed-in user. What they did is kept on the interview's own log, with time,
  // address and browser, as a form request keeps its own (§1.121).
  mountPublic(app, interviewRoutes.interviewView, async ({ c, services }) => {
    const ref = await linked(services, tokenOf(c));
    const view = await withTenantTx(services, ref.tenantId, async (tx) => {
      const row = await readInterview(tx, ref.tenantId, ref.id, true);
      const now = new Date();
      if (isOpen(row, now) && !(row.log ?? []).some((e) => e.kind === "opened")) {
        await tx
          .update(processInterview)
          .set({ log: logEntry("opened", requestOrigin(c)) })
          .where(and(eq(processInterview.id, row.id), eq(processInterview.tenantId, row.tenantId)));
      }
      return pageView(tx, row, now);
    });
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
    return view;
  });

  mountPublic(app, interviewRoutes.interviewAnswer, async ({ c, body, services }) => {
    const ref = await linked(services, tokenOf(c));
    // 1. The answer is kept and the waiting question taken off, in one short transaction: a second
    //    answer sent at once finds no question and is refused.
    const claimed = await withTenantTx(services, ref.tenantId, async (tx) => {
      const row = await readInterview(tx, ref.tenantId, ref.id, true);
      if (!isOpen(row, new Date())) throw closed();
      if (!row.question) {
        throw new HttpError(409, "no_question", "There is no question waiting. Finish instead.");
      }
      const turns = turnsOf(row);
      const answer: InterviewTurn = {
        role: "contact",
        text: body.skip ? "" : body.text.trim(),
        at: new Date().toISOString(),
        estimate: !body.skip && body.estimate,
        skipped: body.skip,
      };
      const next = [...turns, answer];
      await tx
        .update(processInterview)
        .set({
          turns: next,
          question: null,
          log: logEntry("answered", requestOrigin(c), { skipped: body.skip }),
        })
        .where(and(eq(processInterview.id, row.id), eq(processInterview.tenantId, row.tenantId)));
      return {
        row: { ...row, turns: next },
        input: await interviewInput(tx, services, { ...row, turns: next }),
      };
    });
    // 2. The next question, outside any transaction. A failure asks a plain follow-up instead, so
    //    the person is never left without a way on.
    let question: string | null;
    let calls: readonly LlmCallRecord[] = [];
    try {
      ({ question, calls } = await nextQuestion(claimed.input, {
        llm: modelsFor(services, ref.tenantId),
        model: INTERVIEW_MODEL,
      }));
    } catch (error) {
      if (!(error instanceof InterviewError)) throw error;
      calls = error.calls;
      question =
        answersGiven(claimed.input.turns) >= INTERVIEW_MAX_ANSWERS ? null : FALLBACK_QUESTION;
    }
    // 3. The question is asked: kept as a turn and as the one waiting.
    await withTenantTx(services, ref.tenantId, async (tx) => {
      const row = await readInterview(tx, ref.tenantId, ref.id, true);
      if (row.status !== "open") return;
      const turns = turnsOf(row);
      await tx
        .update(processInterview)
        .set({
          turns: question
            ? [...turns, { role: "agent", text: question, at: new Date().toISOString() }]
            : turns,
          question,
          costUsd: addCost(row.costUsd, calls),
        })
        .where(and(eq(processInterview.id, row.id), eq(processInterview.tenantId, row.tenantId)));
    });
    return viewOf(services, ref);
  });

  mountPublic(app, interviewRoutes.interviewFinish, async ({ c, services }) => {
    const ref = await linked(services, tokenOf(c));
    await finish(c, services, ref);
    return viewOf(services, ref);
  });

  mountPublic(app, interviewRoutes.interviewFile, async ({ c, services }) => {
    const ref = await linked(services, tokenOf(c));
    // The file's own limit, and room for the multipart framing around it (as a form's file).
    const tooLarge = () => new HttpError(413, "too_large", "That file is too large.");
    const limited = readableLimited(c.req.raw, MAX_DOCUMENT_BYTES + 64 * 1024);
    if (!limited) throw tooLarge();
    let form: FormData;
    try {
      form = await new Response(limited.body, {
        headers: { "content-type": c.req.header("content-type") ?? "" },
      }).formData();
    } catch {
      if (limited.over()) throw tooLarge();
      throw new HttpError(400, "invalid_request", "send the file as multipart/form-data");
    }
    const file = form.get("file");
    if (!file || typeof file === "string") {
      throw new HttpError(400, "invalid_request", "no file in `file`");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const content = new ContentStore(services.deps.objects(services.env));
    const filename = await withTenantTx(services, ref.tenantId, async (tx) => {
      const row = await readInterview(tx, ref.tenantId, ref.id, true);
      if (!isOpen(row, new Date())) throw closed();
      if (filesOf(row).length >= INTERVIEW_MAX_FILES) {
        throw new HttpError(422, "too_many_files", "This interview has all the files it can take.");
      }
      try {
        // DECISION: a sample file goes in as the client's document through the documents
        // capability's intake (`storeDocument`), as a form's files do: source `request`, a
        // document a person sent because we asked. PDFs, images and table files (.csv, .xlsx).
        const stored = await storeDocument(tx, content, {
          tenantId: row.tenantId,
          source: "request",
          connectionId: null,
          bytes,
          filename: file.name,
          mimeType: documentMimeType(file.type, file.name),
          meta: { interviewId: row.id },
        });
        const entry = {
          documentId: stored.document.id,
          filename: stored.document.filename,
          at: new Date().toISOString(),
        };
        await tx
          .update(processInterview)
          .set({
            documents: sql`${processInterview.documents} || ${JSON.stringify([entry])}::jsonb`,
            log: logEntry("file", requestOrigin(c), { documentId: entry.documentId }),
          })
          .where(and(eq(processInterview.id, row.id), eq(processInterview.tenantId, row.tenantId)));
        return entry.filename;
      } catch (error) {
        if (error instanceof DocumentError) {
          throw new HttpError(
            error.code === "too_large" ? 413 : error.code === "unsupported_type" ? 415 : 422,
            error.code,
            error.code === "unsupported_type"
              ? "Add a PDF, an image or a spreadsheet."
              : error.message,
          );
        }
        throw error;
      }
    });
    return { file: { filename } };
  });

  // ── The back office ────────────────────────────────────────────────────────────────────────────

  const links = (services: Services) => ({ env: services.env, origin: originOf(services.env) });

  mount(app, interviewRoutes.opsInterviews, async (ctx) => {
    ensureClient(ctx, ctx.params.clientId);
    const rows = await ctx.tx
      .select()
      .from(processInterview)
      .where(eq(processInterview.tenantId, ctx.params.clientId))
      .orderBy(desc(processInterview.createdAt))
      .limit(100);
    const people = await ctx.tx
      .select({ id: contact.id, name: contact.name })
      .from(contact)
      .where(eq(contact.tenantId, ctx.params.clientId))
      .orderBy(asc(contact.name))
      .limit(500);
    return { interviews: await summaries(ctx.tx, rows), contacts: people };
  });

  mount(app, interviewRoutes.opsStartInterview, async (ctx) => {
    const clientId = ctx.params.clientId;
    ensureClient(ctx, clientId);
    const [who] = await ctx.tx
      .select({ id: contact.id })
      .from(contact)
      .where(and(eq(contact.id, ctx.body.contactId), eq(contact.tenantId, clientId)));
    if (!who) throw new HttpError(404, "not_found", "no such contact");
    const refusing = await clientsRefusingModel(
      ctx.services,
      { clients: [clientId], read: ctx.tx },
      INTERVIEW_MODEL,
    );
    if (refusing.size > 0) {
      throw new HttpError(
        409,
        "hipaa",
        "This client's HIPAA mode doesn't allow the interviewer's model.",
      );
    }
    const question = firstQuestion(ctx.body.process);
    const [row] = await ctx.tx
      .insert(processInterview)
      .values({
        tenantId: clientId,
        contactId: who.id,
        process: ctx.body.process,
        area: ctx.body.area,
        expiresAt: new Date(Date.now() + INTERVIEW_LINK_DAYS * 86_400_000),
        turns: [{ role: "agent", text: question, at: new Date().toISOString() }],
        question,
        createdBy: ctx.session.user.id,
        log: [{ at: new Date().toISOString(), kind: "created", userId: ctx.session.user.id }],
      })
      .returning();
    if (!row) throw new Error("interview insert returned nothing");
    return opsView(ctx.tx, row, links(ctx.services), new Date());
  });

  mount(app, interviewRoutes.opsInterview, async (ctx) => {
    ensureClient(ctx, ctx.params.clientId);
    const row = await readInterview(ctx.tx, ctx.params.clientId, ctx.params.id);
    return opsView(ctx.tx, row, links(ctx.services), new Date());
  });

  mount(app, interviewRoutes.opsCloseInterview, async (ctx) => {
    ensureClient(ctx, ctx.params.clientId);
    const row = await readInterview(ctx.tx, ctx.params.clientId, ctx.params.id, true);
    if (row.status !== "open") throw new HttpError(409, "not_open", "this interview is not open");
    const [updated] = await ctx.tx
      .update(processInterview)
      .set({
        status: "closed",
        question: null,
        log: logEntry("closed", {}, { userId: ctx.session.user.id }),
      })
      .where(and(eq(processInterview.id, row.id), eq(processInterview.tenantId, row.tenantId)))
      .returning();
    return opsView(ctx.tx, updated ?? row, links(ctx.services), new Date());
  });

  mountLong(app, interviewRoutes.opsDraftInterview, async (ctx) => {
    const clientId = ctx.params.clientId;
    ensureClient(ctx, clientId);
    // 1. A finished interview with no build yet; its reuse check, saved.
    const prep = await ctx.inTx(async (scoped) => {
      const row = await readInterview(scoped.tx, clientId, ctx.params.id, true);
      if (row.status !== "finished") {
        throw new HttpError(409, "not_finished", "the interview isn't finished yet");
      }
      if (row.buildId) throw new HttpError(409, "has_build", "this interview already has a build");
      const outputs = InterviewOutputsSchema.parse(row.outputs);
      if (outputs.map.steps.length === 0) {
        throw new HttpError(422, "nothing_to_draft", "the map has no steps to draft from");
      }
      const { index } = await reuseIndex(scoped, ctx.services);
      const reuse = reuseOf(outputs, index, new Date());
      await scoped.tx
        .update(processInterview)
        .set({ reuse })
        .where(and(eq(processInterview.id, row.id), eq(processInterview.tenantId, clientId)));
      return { row, outputs };
    });
    // 2. The client's agent build, started as the lab's Describe starts one (§1.170), and kept on
    //    the interview before anything slow runs, so a second press finds it.
    const started = await invokeRoute(
      app,
      ctx.c,
      ctx.session,
      routes.opsStartBuild,
      { body: { kind: "agent", title: prep.row.process.slice(0, 200), clientId } },
      "build",
    );
    const buildId = started.build.id;
    await ctx.inTx(async (scoped) => {
      await scoped.tx
        .update(processInterview)
        .set({
          buildId,
          log: logEntry("drafted", {}, { buildId, userId: ctx.session.user.id }),
        })
        .where(and(eq(processInterview.id, prep.row.id), eq(processInterview.tenantId, clientId)));
    });
    // 3. Drafted at once from the map's words (§1.165): approval on for every write, a person
    //    where the catalog has no part. A draft that fails leaves the build in its intake, with the
    //    words in its conversation, to draft again from its page.
    const long: LongCtx = {
      c: ctx.c,
      app,
      session: ctx.session,
      services: ctx.services,
      inTx: ctx.inTx,
    };
    await draftNow(long, buildId, prep.outputs.description);
    return ctx.inTx(async (scoped) =>
      opsView(
        scoped.tx,
        await readInterview(scoped.tx, clientId, ctx.params.id),
        links(ctx.services),
        new Date(),
      ),
    );
  });
}
