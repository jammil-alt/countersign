// The process interview (docs/plan.md §1.217). Two sides. The public page a contact opens with a
// signed link, no sign-in: the questions so far and the one waiting, an answer (or "I don't
// know", or an estimate), a sample file, and Finish. It shows the client's name and the process,
// never an agent, a prompt or what it cost (invariant 11). The back office starts an interview
// for one of a client's contacts, reads it, closes it, and drafts a build from a finished one.
// These routes stay out of the web app's first load (all-routes.ts): their screens load lazily.

import { z } from "zod";
import { Locale } from "../i18n/locale";
import { isUuid } from "../ids";
import {
  INTERVIEW_ANSWER_MAX,
  InterviewFile,
  InterviewOutputs,
  InterviewReuse,
  InterviewStatus,
  InterviewTurn,
} from "../interview";
import { IntakeArea } from "../onboarding/starts";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const TokenParams = z.object({ token: z.string().min(10).max(2000) });
const ClientParams = z.object({ clientId: Id });
const InterviewParams = z.object({ clientId: Id, id: Id });

/** What the public page shows. */
export const InterviewPageView = z.object({
  client: z.string(),
  /** The person asked, as the client has them. */
  name: z.string(),
  process: z.string(),
  state: z.enum(["open", "finished", "closed"]),
  turns: z.array(InterviewTurn),
  /** The question waiting for an answer; null once the interviewer has what it needs. */
  question: z.string().nullable(),
  files: z.array(z.object({ filename: z.string() })),
  answered: z.number().int(),
  maxAnswers: z.number().int(),
  maxFiles: z.number().int(),
  language: Locale,
});
export type InterviewPageView = z.infer<typeof InterviewPageView>;

export const InterviewAnswer = z
  .strictObject({
    text: z.string().max(INTERVIEW_ANSWER_MAX).default(""),
    /** The person says the numbers are an estimate. */
    estimate: z.boolean().default(false),
    /** "I don't know". */
    skip: z.boolean().default(false),
  })
  .refine((a) => a.skip || a.text.trim().length > 0, {
    message: "write an answer, or say you don't know",
  });
export type InterviewAnswerInput = z.input<typeof InterviewAnswer>;

export const OpsInterviewSummary = z.object({
  id: z.string(),
  contact: z.object({ id: z.string(), name: z.string() }),
  process: z.string(),
  area: IntakeArea.nullable(),
  status: InterviewStatus,
  answered: z.number().int(),
  buildId: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type OpsInterviewSummary = z.infer<typeof OpsInterviewSummary>;

export const OpsInterviewView = OpsInterviewSummary.extend({
  /** The page's address while it takes answers; null once finished or closed. */
  link: z.string().nullable(),
  expiresAt: z.string(),
  turns: z.array(InterviewTurn),
  question: z.string().nullable(),
  files: z.array(InterviewFile),
  outputs: InterviewOutputs.nullable(),
  reuse: InterviewReuse.nullable(),
  /** What its model calls cost us (USD, 4 places). Back office only. */
  costUsd: z.string(),
});
export type OpsInterviewView = z.infer<typeof OpsInterviewView>;

export const NewInterview = z.strictObject({
  contactId: Id,
  process: z.string().trim().min(1).max(200),
  area: IntakeArea.nullable().default(null),
});
export type NewInterviewInput = z.input<typeof NewInterview>;

export const interviewRoutes = {
  interviewView: defineRoute({
    method: "GET",
    path: "/api/interviews/:token",
    auth: "public",
    roles: [],
    summary: "A process interview someone was asked to answer, as far as it has gone",
    params: TokenParams,
    response: InterviewPageView,
  }),
  interviewAnswer: defineRoute({
    method: "POST",
    path: "/api/interviews/:token/answers",
    auth: "public",
    roles: [],
    summary: "Answer the waiting question (or say you don't know); the next one comes back",
    params: TokenParams,
    body: InterviewAnswer,
    response: InterviewPageView,
  }),
  interviewFile: defineRoute({
    method: "POST",
    path: "/api/interviews/:token/files",
    auth: "public",
    roles: [],
    summary: "Add a sample file (multipart, field `file`)",
    params: TokenParams,
    response: z.object({ file: z.object({ filename: z.string() }) }),
  }),
  interviewFinish: defineRoute({
    method: "POST",
    path: "/api/interviews/:token/finish",
    auth: "public",
    roles: [],
    summary: "Finish the interview with what has been said",
    params: TokenParams,
    response: InterviewPageView,
  }),
  opsInterviews: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:clientId/interviews",
    auth: "session",
    roles: OPS,
    summary: "A client's process interviews, and the contacts one can be started with",
    params: ClientParams,
    response: z.object({
      interviews: z.array(OpsInterviewSummary),
      contacts: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  }),
  opsStartInterview: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:clientId/interviews",
    auth: "session",
    roles: OPS,
    summary: "Start a process interview with one of the client's contacts; its link comes back",
    params: ClientParams,
    body: NewInterview,
    response: OpsInterviewView,
  }),
  opsInterview: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:clientId/interviews/:id",
    auth: "session",
    roles: OPS,
    summary: "One process interview: the answers, the map, the open questions and the reuse check",
    params: InterviewParams,
    response: OpsInterviewView,
  }),
  opsCloseInterview: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:clientId/interviews/:id/close",
    auth: "session",
    roles: OPS,
    summary: "Close an interview: its link stops taking answers",
    params: InterviewParams,
    response: OpsInterviewView,
  }),
  opsDraftInterview: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:clientId/interviews/:id/draft",
    auth: "session",
    roles: OPS,
    summary: "Run the reuse check and draft the client's agent from a finished interview",
    params: InterviewParams,
    response: OpsInterviewView,
  }),
} as const;
