// Forms (docs/plan.md §1.115): the public page's routes. A contact opens a form with its signed
// link, no sign-in: it reads the form and the saved answers, saves a draft, adds files one at a
// time and sends the answers once. Everything is scoped to the one request the link names, in its
// own client (invariant 1). What the person writes is kept as data, never read as instructions
// (invariant 9), and the page shows nothing about the client beyond its name.

import { ContentStore, documentMimeType } from "@countersign/connectors";
import {
  acceptsFile,
  answerProblems,
  cleanAnswers,
  type FormDefinition,
  type FormFile,
  FormFile as FormFileSchema,
  isPlainObject,
  type Locale,
  matchLocale,
  routes,
} from "@countersign/core";
import { contact, formRequest, type Tx, tenant, withTenant } from "@countersign/db";
import { DocumentError, storeDocument } from "@countersign/documents";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { requestOrigin } from "../audit";
import { verifyFormLink } from "../forms/link";
import { type FormRequestRow, wakeForm } from "../forms/service";
import { type AppEnv, HttpError, mountPublic, type Services, waitUntil } from "../http";

const tokenOf = (c: { req: { param(name: string): string | undefined } }) =>
  c.req.param("token") ?? "";

// DECISION: at most this many files through one link, whatever the form allows, so a link can't be
// used to fill a client's storage.
const MAX_FILES_PER_REQUEST = 30;

const gone = () => new HttpError(404, "not_found", "This link has expired or doesn't exist.");
const closed = () => new HttpError(409, "closed", "This form no longer takes answers.");

/** The request a link names, in its own client; 404 for anything forged, expired or missing. */
async function requestFor(
  services: Services,
  token: string,
): Promise<{ tenantId: string; id: string }> {
  const link = await verifyFormLink(services.env, token);
  if (!link) throw gone();
  return { tenantId: link.t, id: link.r };
}

async function loadRow(tx: Tx, ref: { tenantId: string; id: string }): Promise<FormRequestRow> {
  const [row] = await tx
    .select()
    .from(formRequest)
    .where(and(eq(formRequest.id, ref.id), eq(formRequest.tenantId, ref.tenantId)))
    .for("update");
  if (!row) throw gone();
  return row;
}

/** Whether the request still takes answers now: sent (or sending) and before its due date. */
function isOpen(row: FormRequestRow, now: Date): boolean {
  return (row.status === "open" || row.status === "sending") && row.dueAt.getTime() > now.getTime();
}

const logEntry = (kind: string, c: Parameters<typeof requestOrigin>[0], extra = {}) =>
  sql`${formRequest.log} || ${JSON.stringify([
    { at: new Date().toISOString(), kind, ...requestOrigin(c), ...extra },
  ])}::jsonb`;

/**
 * The answers' files must be ones uploaded through this link: an id the person typed in would
 * otherwise attach another of the client's documents to the answers.
 */
function foreignFiles(form: FormDefinition, answers: Record<string, unknown>, own: string[]) {
  const mine = new Set(own);
  for (const q of form.questions) {
    if (q.type !== "files") continue;
    const files = z.array(FormFileSchema).safeParse(answers[q.id]);
    if (files.success && files.data.some((f) => !mine.has(f.documentId))) return q.id;
  }
  return null;
}

function checked(row: FormRequestRow, answers: Record<string, unknown>, final: boolean) {
  const form = row.definition as unknown as FormDefinition;
  const problems = answerProblems(form, answers, { final });
  const foreign = foreignFiles(form, answers, row.documents ?? []);
  if (foreign) problems.push({ question: foreign, message: "add files with the button" });
  if (problems.length > 0) {
    throw new HttpError(422, "invalid_answers", "Some answers need a look.", { problems });
  }
  return cleanAnswers(form, answers);
}

export function formRoutes(app: Hono<AppEnv>): void {
  // DECISION: the page's routes are public and write no audit row: the person acting is the
  // contact, not a signed-in user. What they did is kept on the request's own log, with time,
  // address and browser (as the texting sign-up page keeps its evidence on the contact's log).
  mountPublic(app, routes.formView, async ({ c, services }) => {
    const ref = await requestFor(services, tokenOf(c));
    const view = await withTenant(services.db, ref.tenantId, async (tx) => {
      const row = await loadRow(tx, ref);
      const now = new Date();
      if (!row.openedAt && isOpen(row, now)) {
        await tx
          .update(formRequest)
          .set({ openedAt: now, log: logEntry("opened", c) })
          .where(and(eq(formRequest.id, row.id), eq(formRequest.tenantId, row.tenantId)));
      }
      const [client] = await tx
        .select({ name: tenant.name })
        .from(tenant)
        .where(eq(tenant.id, row.tenantId));
      const [who] = await tx
        .select({ name: contact.name })
        .from(contact)
        .where(and(eq(contact.id, row.contactId), eq(contact.tenantId, row.tenantId)));
      const form = row.definition as unknown as FormDefinition;
      const state = row.status === "submitted" ? "submitted" : isOpen(row, now) ? "open" : "closed";
      const answers =
        state === "submitted" && isPlainObject(row.answers)
          ? row.answers
          : state === "open" && isPlainObject(row.draft)
            ? row.draft
            : {};
      return {
        client: client?.name ?? "",
        name: who?.name ?? "",
        title: form.title,
        intro: form.intro ?? null,
        purpose: row.purpose,
        questions: state === "closed" ? [] : form.questions,
        answers,
        state: state as "open" | "submitted" | "closed",
        dueAt: row.dueAt.toISOString(),
        submittedAt: row.submittedAt?.toISOString() ?? null,
        language: (matchLocale(row.language) ?? "en") as Locale,
      };
    });
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
    return view;
  });

  mountPublic(app, routes.formSave, async ({ c, body, services }) => {
    const ref = await requestFor(services, tokenOf(c));
    const at = new Date();
    await withTenant(services.db, ref.tenantId, async (tx) => {
      const row = await loadRow(tx, ref);
      if (!isOpen(row, at)) throw closed();
      const draft = checked(row, body.answers, false);
      await tx
        .update(formRequest)
        .set({ draft, log: logEntry("saved", c) })
        .where(and(eq(formRequest.id, row.id), eq(formRequest.tenantId, row.tenantId)));
    });
    return { savedAt: at.toISOString() };
  });

  mountPublic(app, routes.formSubmit, async ({ c, body, services }) => {
    const ref = await requestFor(services, tokenOf(c));
    const at = new Date();
    const row = await withTenant(services.db, ref.tenantId, async (tx) => {
      const current = await loadRow(tx, ref);
      if (current.status === "submitted") throw closed();
      if (!isOpen(current, at)) throw closed();
      const answers = checked(current, body.answers, true);
      const [updated] = await tx
        .update(formRequest)
        .set({
          status: "submitted",
          answers,
          draft: answers,
          submittedAt: at,
          log: logEntry("submitted", c),
        })
        .where(and(eq(formRequest.id, current.id), eq(formRequest.tenantId, current.tenantId)))
        .returning();
      return updated ?? current;
    });
    // The run waiting on it goes on; if this misses, the cron re-sends until the run takes it.
    waitUntil(c, wakeForm({ instances: services.instances }, row));
    return { state: "submitted" as const, submittedAt: at.toISOString() };
  });

  mountPublic(app, routes.formFile, async ({ c, query, services }) => {
    const ref = await requestFor(services, tokenOf(c));
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new HttpError(400, "invalid_request", "send the file as multipart/form-data");
    }
    const file = form.get("file");
    if (!file || typeof file === "string") {
      throw new HttpError(400, "invalid_request", "no file in `file`");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const content = new ContentStore(services.deps.objects(services.env));
    const saved: FormFile = await withTenant(services.db, ref.tenantId, async (tx) => {
      const row = await loadRow(tx, ref);
      if (!isOpen(row, new Date())) throw closed();
      const definition = row.definition as unknown as FormDefinition;
      const question = definition.questions.find((q) => q.id === query.question);
      if (question?.type !== "files") {
        throw new HttpError(422, "invalid_request", "that question doesn't take files");
      }
      if ((row.documents ?? []).length >= MAX_FILES_PER_REQUEST) {
        throw new HttpError(422, "too_many_files", "This form has all the files it can take.");
      }
      const mimeType = documentMimeType(file.type, file.name);
      if (!acceptsFile(question, mimeType)) {
        throw new HttpError(415, "unsupported_type", "Add a PDF or an image.");
      }
      try {
        // DECISION: source `request`: a document a person sent because we asked for it.
        const stored = await storeDocument(tx, content, {
          tenantId: row.tenantId,
          source: "request",
          connectionId: null,
          bytes,
          filename: file.name,
          mimeType,
          meta: { formRequestId: row.id, question: question.id },
        });
        const documentId = stored.document.id;
        await tx
          .update(formRequest)
          .set({
            documents: sql`${formRequest.documents} || ${JSON.stringify([documentId])}::jsonb`,
            log: logEntry("file", c, { question: question.id, documentId }),
          })
          .where(and(eq(formRequest.id, row.id), eq(formRequest.tenantId, row.tenantId)));
        return { documentId, filename: stored.document.filename };
      } catch (error) {
        if (error instanceof DocumentError) {
          throw new HttpError(error.code === "too_large" ? 413 : 422, error.code, error.message);
        }
        throw error;
      }
    });
    return { file: saved };
  });
}
