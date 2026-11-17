// Forms (docs/plan.md §1.121): the public page a contact answers a "Request info" form on, opened
// by a signed link, with no sign-in. It reads the form and the person's saved answers, saves a
// draft, takes files one at a time and sends the answers once.

import { z } from "zod";
import { FormFile, Question } from "../forms";
import { Locale } from "../i18n/locale";
import { defineRoute } from "./contract";

const TokenParams = z.object({ token: z.string().min(10).max(2000) });

/** What the page shows. Never the run, the agent or anything about the client beyond its name. */
export const FormPageView = z.object({
  client: z.string(),
  /** The person asked, as the client has them. */
  name: z.string(),
  title: z.string(),
  intro: z.string().nullable(),
  /** Why we ask: the step's own words. */
  purpose: z.string(),
  questions: z.array(Question),
  /** The saved draft, or the answers sent. */
  answers: z.record(z.string(), z.unknown()),
  state: z.enum(["open", "submitted", "closed"]),
  dueAt: z.string(),
  submittedAt: z.string().nullable(),
  language: Locale,
});
export type FormPageView = z.infer<typeof FormPageView>;

const Answers = z.record(z.string(), z.unknown());

export const FormSave = z.strictObject({ answers: Answers });
export type FormSaveInput = z.input<typeof FormSave>;

export const FormProblemView = z.object({ question: z.string().optional(), message: z.string() });

export const formRoutes = {
  formView: defineRoute({
    method: "GET",
    path: "/api/forms/:token",
    auth: "public",
    roles: [],
    summary: "A form someone was asked to fill in, with their saved answers",
    params: TokenParams,
    response: FormPageView,
  }),
  formSave: defineRoute({
    method: "PUT",
    path: "/api/forms/:token/draft",
    auth: "public",
    roles: [],
    summary: "Save the answers so far, to finish later",
    params: TokenParams,
    body: FormSave,
    response: z.object({ savedAt: z.string() }),
  }),
  formSubmit: defineRoute({
    method: "POST",
    path: "/api/forms/:token",
    auth: "public",
    roles: [],
    summary: "Send the answers; they can't be changed after",
    params: TokenParams,
    body: FormSave,
    response: z.object({ state: z.literal("submitted"), submittedAt: z.string() }),
  }),
  formFile: defineRoute({
    method: "POST",
    path: "/api/forms/:token/files",
    auth: "public",
    roles: [],
    summary: "Add one file to a files question (multipart, field `file`; `?question=`)",
    params: TokenParams,
    query: z.object({ question: z.string().min(1).max(40) }),
    response: z.object({ file: FormFile }),
  }),
} as const;
