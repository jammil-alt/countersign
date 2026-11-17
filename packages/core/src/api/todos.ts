// Your call (docs/plan.md §1.123.3; docs/cases-plan.md T1): the to-do list across the back office,
// what Reggie did on its own today, and the client page's to-dos, work and activity. Operator only:
// `todo` and `play_log` are operator-only tables, and no portal route returns any of it
// (invariant 11).

import { z } from "zod";
import { isUuid } from "../ids";
import { ActivityFilter, CallKind, TodoAboutKind, TodoItemSource, TodoOwner } from "../work/call";
import { WorkUrgency } from "../work/pipelines";
import { Standing } from "../work/standing";
import { defineRoute } from "./contract";
import { HoldView, WorkKpi } from "./work";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;
const Named = z.object({ id: z.string(), name: z.string() });
const Instant = z.string().datetime({ offset: true });

export const TODO_TITLE_MAX = 300;
export const TODO_DETAIL_MAX = 4000;
export const TODO_WHY_MAX = 300;

/** What the primary button does. */
export const TodoActionKind = z.enum([
  "send_reply",
  "approve_plan",
  "decide",
  "open",
  "confirm_card",
  "send_requirements",
]);
export type TodoActionKind = z.infer<typeof TodoActionKind>;

/** One line of Your call: a to-do row, or an item read from its own table (`editable` false). */
export const TodoView = z.object({
  id: z.string(),
  source: TodoItemSource,
  owner: TodoOwner,
  /** The operator it is named to, when one is. */
  ownerUser: Named.nullable(),
  kind: CallKind.exclude(["all"]),
  /** "Issue · critical", "Agent build", "New account". */
  tag: z.string(),
  title: z.string(),
  detail: z.string(),
  client: Named.nullable(),
  /** What it is about, with the page that has it (null when there is none). */
  about: z.object({ kind: z.string(), id: z.string(), href: z.string().nullable() }).nullable(),
  dueAt: z.string().nullable(),
  state: z.enum(["open", "done", "snoozed", "dropped"]),
  snoozedUntil: z.string().nullable(),
  read: z.string().nullable(),
  plan: z.array(z.string()),
  why: z.object({ head: z.string(), detail: z.string() }).nullable(),
  sure: z.string().nullable(),
  draft: z.object({ to: z.string(), text: z.string(), channel: z.string() }).nullable(),
  form: z
    .object({
      title: z.string(),
      to: z.string(),
      due: z.string().nullable(),
      questions: z.array(z.string()),
      prefilled: z.number().int(),
    })
    .nullable(),
  options: z.array(z.string()).nullable(),
  primary: z.object({ label: z.string(), kind: TodoActionKind }).nullable(),
  alt: z.string().nullable(),
  /** About an open critical issue: the card is risk-styled. */
  critical: z.boolean(),
  urgency: WorkUrgency.nullable(),
  /** A to-do row; derived items link to their own screens instead. */
  editable: z.boolean(),
  createdAt: z.string(),
});
export type TodoView = z.infer<typeof TodoView>;

export const TodoCounts = z.object({
  yours: z.number().int(),
  reggie: z.number().int(),
  client: z.number().int(),
  doneToday: z.number().int(),
  dueToday: z.number().int(),
  criticalHeld: z.number().int(),
  lateClient: z.number().int(),
  /** Questions from client people this week, and the median minutes to the first answer. */
  questionsWeek: z.number().int(),
  medianAnswerMinutes: z.number().int().nullable(),
});
export type TodoCounts = z.infer<typeof TodoCounts>;

export const TodoList = z.object({
  items: z.array(TodoView),
  counts: TodoCounts,
  holds: z.array(HoldView),
  today: z.string(),
});
export type TodoList = z.infer<typeof TodoList>;

export const TodoAbout = z.object({ kind: TodoAboutKind, id: Id });

export const NewTodo = z.strictObject({
  title: z.string().trim().min(1).max(TODO_TITLE_MAX),
  owner: TodoOwner,
  ownerUserId: Id.nullable().optional(),
  clientId: Id.nullable().optional(),
  dueAt: Instant.nullable().optional(),
  about: TodoAbout.nullable().optional(),
  detail: z.string().trim().max(TODO_DETAIL_MAX).optional(),
  why: z.string().trim().max(TODO_WHY_MAX).nullable().optional(),
});
export type NewTodo = z.infer<typeof NewTodo>;

export const UpdateTodo = z.strictObject({
  title: z.string().trim().min(1).max(TODO_TITLE_MAX).optional(),
  owner: TodoOwner.optional(),
  ownerUserId: Id.nullable().optional(),
  dueAt: Instant.nullable().optional(),
  detail: z.string().trim().max(TODO_DETAIL_MAX).optional(),
  why: z.string().trim().max(TODO_WHY_MAX).nullable().optional(),
  /** The draft's words, edited before it goes. */
  draftText: z.string().trim().min(1).max(4000).optional(),
  /** Drop it: nothing to do after all. */
  dropped: z.literal(true).optional(),
});
export type UpdateTodo = z.infer<typeof UpdateTodo>;

export const TodoActBody = z.strictObject({
  /** The option chosen, for a "decide" to-do (its index in `options`). */
  option: z.number().int().min(0).max(20).optional(),
  /** The draft as the operator left it. */
  draftText: z.string().trim().min(1).max(4000).optional(),
});
export type TodoActBody = z.infer<typeof TodoActBody>;

export const TodoActResult = z.object({
  todo: TodoView,
  /** What the action did, in a few words ("Sent to Dana Hart", "3 to-dos made"). */
  done: z.string(),
  /** Where to go next, when the action opens something. */
  href: z.string().nullable(),
});
export type TodoActResult = z.infer<typeof TodoActResult>;

export const DoneTodayRow = z.object({
  id: z.string(),
  at: z.string(),
  summary: z.string(),
  /** Went to a client or a lead; else ours only. */
  sent: z.boolean(),
  edited: z.boolean(),
  client: Named.nullable(),
  href: z.string().nullable(),
  flagged: z.boolean(),
});
export type DoneTodayRow = z.infer<typeof DoneTodayRow>;

export const DoneToday = z.object({
  groups: z.array(z.object({ flow: z.string(), name: z.string(), rows: z.array(DoneTodayRow) })),
  count: z.number().int(),
});
export type DoneToday = z.infer<typeof DoneToday>;

/** One line of a client's activity, read across the tables that hold it (never copied). */
export const ActivityItem = z.object({
  id: z.string(),
  kind: z.enum(["in", "out", "note", "sys", "run", "q"]),
  filter: ActivityFilter.exclude(["all"]),
  at: z.string(),
  who: z.string().nullable(),
  /** The agent's work stays ink (Reggie, an agent). */
  agent: z.boolean(),
  channel: z.string().nullable(),
  text: z.string(),
  /** A question's answer line ("Answered by Sloan in 3 min"). */
  answer: z.string().nullable(),
  link: z.object({ href: z.string(), label: z.string() }).nullable(),
});
export type ActivityItem = z.infer<typeof ActivityItem>;

export const ClientActivity = z.object({
  items: z.array(ActivityItem),
  /** Pass as `before` for the next page; null at the end. */
  next: z.string().nullable(),
});
export type ClientActivity = z.infer<typeof ClientActivity>;

/** A line in the client page's Sales and Build buckets. */
export const WorkCard = z.object({
  kind: z.enum(["issue", "build", "enhancement", "deal"]),
  id: z.string(),
  title: z.string(),
  href: z.string(),
  urgency: WorkUrgency.nullable(),
  standing: Standing,
  statusText: z.string(),
});
export type WorkCard = z.infer<typeof WorkCard>;

export const ClientWork = z.object({
  kpis: z.array(WorkKpi),
  sales: z.array(WorkCard),
  build: z.array(WorkCard),
  todos: z.array(TodoView),
});
export type ClientWork = z.infer<typeof ClientWork>;

export const todoRoutes = {
  opsTodos: defineRoute({
    method: "GET",
    path: "/api/ops/todos",
    auth: "session",
    roles: OPS,
    summary:
      "Your call: the open to-dos (yours, Reggie's or the clients'), with what needs a person read from its own screens, and the counts",
    query: z.object({
      owner: TodoOwner.default("operator"),
      client: Id.optional(),
      kind: CallKind.default("all"),
      /** Only the to-dos named to you (or to nobody). */
      mine: z.enum(["true", "false"]).default("false"),
      /** The to-dos about one item (`issue:<id>`), for its page's side panel. */
      about: z
        .string()
        .regex(/^[a-z_]+:[0-9a-f-]{36}$/)
        .optional(),
    }),
    response: TodoList,
  }),
  opsCreateTodo: defineRoute({
    method: "POST",
    path: "/api/ops/todos",
    auth: "session",
    roles: OPS,
    summary: "Add a to-do: yours, Reggie's or the client's",
    body: NewTodo,
    response: TodoView,
  }),
  opsUpdateTodo: defineRoute({
    method: "PATCH",
    path: "/api/ops/todos/:id",
    auth: "session",
    roles: OPS,
    summary: "Change a to-do: its words, who has it, when it's due, its draft; or drop it",
    params: IdParams,
    body: UpdateTodo,
    response: TodoView,
  }),
  opsTodoDone: defineRoute({
    method: "POST",
    path: "/api/ops/todos/:id/done",
    auth: "session",
    roles: OPS,
    summary: "Mark a to-do done",
    params: IdParams,
    response: TodoView,
  }),
  opsTodoSnooze: defineRoute({
    method: "POST",
    path: "/api/ops/todos/:id/snooze",
    auth: "session",
    roles: OPS,
    summary: "Later: hide a to-do until a time (the next weekday at 9:00 by default)",
    params: IdParams,
    body: z.strictObject({ until: Instant.optional() }),
    response: TodoView,
  }),
  opsTodoTake: defineRoute({
    method: "POST",
    path: "/api/ops/todos/:id/take",
    auth: "session",
    roles: OPS,
    summary: "Take one of Reggie's to-dos: it becomes yours, named to you",
    params: IdParams,
    response: TodoView,
  }),
  opsTodoAct: defineRoute({
    method: "POST",
    path: "/api/ops/todos/:id/act",
    auth: "session",
    roles: OPS,
    summary:
      "Do it: run the to-do's primary action as you (send the draft, approve the plan, decide, send the requirements, confirm Reggie's card), then mark it done",
    params: IdParams,
    body: TodoActBody,
    response: TodoActResult,
  }),
  opsTodosDoneToday: defineRoute({
    method: "GET",
    path: "/api/ops/todos/done-today",
    auth: "session",
    roles: OPS,
    summary: "What Reggie did on its own today, by flow, to spot-check",
    response: DoneToday,
  }),
  opsFlagPlay: defineRoute({
    method: "POST",
    path: "/api/ops/play-log/:id/flag",
    auth: "session",
    roles: OPS,
    summary: "Flag something Reggie did: it goes on its play's record",
    params: IdParams,
    body: z.strictObject({ note: z.string().trim().max(300).optional() }),
    response: z.object({ ok: z.literal(true) }),
  }),
  opsClientActivity: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/activity",
    auth: "session",
    roles: OPS,
    summary:
      "A client's activity, newest first: messages, questions, runs, decisions and changes, read where each is kept",
    params: IdParams,
    query: z.object({
      filter: ActivityFilter.default("all"),
      before: Instant.optional(),
    }),
    response: ClientActivity,
  }),
  opsClientWork: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/work",
    auth: "session",
    roles: OPS,
    summary: "A client's figures, its open Sales and Build work, and its to-dos",
    params: IdParams,
    response: ClientWork,
  }),
} as const;
